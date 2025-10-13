#!/usr/bin/env node

/**
 * Builds SQLite FTS databases for CSV datasets so that the frontend can stream
 * pages on demand over HTTP range requests. The script produces the following
 * artefacts per dataset:
 *  - `<dataset>/<dataset>.sqlite[.shardN]`
 *  - `<dataset>/manifest.json`
 *  - `<dataset>/preview.json`
 *  - optional routing headers when sharding is enabled.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const Papa = require('papaparse');
const Database = require('better-sqlite3');
const { createHash } = require('crypto');
const zlib = require('zlib');
const xxhashFactory = require('xxhash-wasm');

const DEFAULT_MAX_SHARD_BYTES = 120 * 1024 * 1024; // 120 MB
const DEFAULT_PREVIEW_LIMIT = 1000;
const ROUTING_MAX_NGRAMS = 6000;
const ROUTING_MIN_LENGTH = 2;
const ROUTING_MAX_LENGTH = 3;
const TOKEN_NORMALIZE_REGEX = /[^a-z0-9\-._\s]+/g;
const DIACRITIC_REGEX = /[\u0300-\u036f]/g;
const GENERATED_COLUMN_PREFIX = 'column_';

function quoteIdentifier(value) {
  const text = String(value ?? '').replace(/"/g, '""');
  return `"${text}"`;
}

function loadJsonFile(filePath) {
  const buffer = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(buffer);
}

function loadCrosswalk(crosswalkPath, repoRoot) {
  const resolved = crosswalkPath
    ? path.resolve(crosswalkPath)
    : path.join(repoRoot, 'public', 'data', 'header-crosswalk.json');
  try {
    return loadJsonFile(resolved);
  } catch (error) {
    console.warn(`Warning: unable to load header crosswalk from ${resolved}: ${error.message}`);
  }
  return null;
}

function loadIdentityCrosswalk(identityPath, repoRoot) {
  const resolved = identityPath
    ? path.resolve(identityPath)
    : path.join(repoRoot, 'public', 'data', 'file-identity-crosswalk.json');
  try {
    return loadJsonFile(resolved);
  } catch (error) {
    // Be quiet if default path is missing; warn only when explicitly provided
    if (identityPath) {
      console.warn(`Warning: unable to load identity crosswalk from ${resolved}: ${error.message}`);
    }
  }
  return null;
}

function toBaseCsvNameForInput(fileName, datasetId) {
  if (fileName) {
    let normalized = String(fileName).trim();
    // Normalize master compressed filenames to base dataset names
    normalized = normalized
      .replace(/_compressed\.csv\.gz$/i, '.csv.gz')
      .replace(/_compressed\.csv$/i, '.csv');
    const m = normalized.match(/^(.*?\.csv)(?:_[0-9]+(?:_[0-9]+)*)?\.csv\.gz$/i);
    if (m) return m[1].toLowerCase();
    if (/\.csv\.gz$/i.test(normalized)) {
      return normalized.replace(/\.csv\.gz$/i, '.csv').toLowerCase();
    }
    if (/\.csv$/i.test(normalized)) {
      return normalized.toLowerCase();
    }
  }
  return `${String(datasetId || '').toLowerCase()}.csv`;
}

function resolveSourceIdentity(identity, folder, version, datasetId, inputPath) {
  if (!identity || !folder || !version) {
    return null;
  }
  const folderEntry = identity[folder];
  if (!folderEntry || !folderEntry.groups) {
    return null;
  }
  const baseName = toBaseCsvNameForInput(path.basename(inputPath), datasetId);
  const group = folderEntry.groups[baseName];
  if (!group || !Array.isArray(group.history)) {
    return null;
  }
  const entry = group.history.find((h) => h && h.version === version);
  if (!entry || !entry.signature) {
    return null;
  }
  return {
    folder,
    version,
    baseCsv: baseName,
    signature: entry.signature,
    segments: Array.isArray(entry.segments) ? entry.segments : undefined,
    baseUrl: identity?._meta?.baseUrl || undefined,
  };
}

function resolveCrosswalkHeaders(crosswalk, datasetId, inputPath) {
  if (!crosswalk) {
    return null;
  }
  const datasetKey = `${datasetId}.csv`;
  const pathSegments = inputPath ? path.resolve(inputPath).split(path.sep) : [];
  const candidateRoots = new Set();
  Object.keys(crosswalk).forEach((key) => {
    if (key.startsWith('_')) {
      return;
    }
    if (pathSegments.includes(key)) {
      candidateRoots.add(key);
    }
  });

  const matches = [];
  Object.entries(crosswalk).forEach(([root, versions]) => {
    if (root.startsWith('_')) {
      return;
    }
    if (candidateRoots.size && !candidateRoots.has(root)) {
      return;
    }
    Object.entries(versions || {}).forEach(([version, datasets]) => {
      const details = datasets?.[datasetKey];
      if (details?.headers?.length) {
        matches.push({ root, version, headers: details.headers });
      }
    });
  });

  if (!matches.length) {
    return null;
  }

  const seen = new Set();
  const unique = [];
  matches.forEach((entry) => {
    const signature = JSON.stringify(entry.headers);
    if (!seen.has(signature)) {
      unique.push(entry);
      seen.add(signature);
    }
  });

  const preferred = unique[unique.length - 1];
  return preferred.headers;
}

function createInputStream(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved.endsWith('.gz')) {
    const source = fs.createReadStream(resolved);
    const gunzip = zlib.createGunzip();
    source.on('error', (error) => {
      gunzip.emit('error', error);
    });
    gunzip.setEncoding('utf8');
    return source.pipe(gunzip);
  }
  return fs.createReadStream(resolved, { encoding: 'utf8' });
}

function normalisedDatasetKeys(datasetId, fileName) {
  const values = new Set();
  const add = (value) => {
    if (value != null && value !== '') {
      values.add(String(value).toLowerCase());
    }
  };

  if (datasetId) {
    add(datasetId);
    add(`${datasetId}.csv`);
  }

  if (fileName) {
    add(fileName);
    if (fileName.endsWith('.gz')) {
      add(fileName.slice(0, -3));
    }
    const lower = fileName.toLowerCase();
    const csvIndex = lower.indexOf('.csv');
    if (csvIndex !== -1) {
      add(lower.slice(0, csvIndex));
      add(lower.slice(0, csvIndex + 4));
    }
  }

  return Array.from(values);
}

function usage(error) {
  if (error) {
    console.error(error);
  }
  console.log(`Usage: build-sqlite.js --input <file> --dataset <id> [options]

Required:
  --input <path>            CSV or Parquet file to ingest (CSV assumed for now)
  --dataset <id>            Dataset identifier (used for output folder naming)

Options:
  --output <dir>            Output directory (default: public/data/sqlite)
  --limits <path>           limits.json path (default: src/config/limits.json)
  --crosswalk <path>        header crosswalk JSON path (default: public/data/header-crosswalk.json)
  --identity-json <path>    identity crosswalk JSON path (default: public/data/file-identity-crosswalk.json)
  --source-folder <name>    source folder key (e.g., versioned_terminology)
  --source-version <ver>    source version (e.g., 0.15.2)
  --shard-count <n>         Explicit shard count override
  --max-shard-bytes <n>     Target max uncompressed bytes per shard (default 125829120)
  --shard-key <cols>        Comma separated column names used for shard hashing
  --preview-limit <n>       Number of rows in preview payload (default 1000)
  --skip-preview            Do not emit preview.json
  --label <text>            Human readable dataset label for manifest index
  --help                    Show this message
`);
}

function parseArgs(argv) {
  const options = {
    input: null,
    dataset: null,
    output: null,
    limitsPath: null,
    crosswalkPath: null,
    identityPath: null,
    sourceFolder: null,
    sourceVersion: null,
    shardCount: null,
    maxShardBytes: DEFAULT_MAX_SHARD_BYTES,
    shardKey: [],
    previewLimit: DEFAULT_PREVIEW_LIMIT,
    skipPreview: false,
    label: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--input':
        options.input = argv[++i];
        break;
      case '--dataset':
        options.dataset = argv[++i];
        break;
      case '--output':
        options.output = argv[++i];
        break;
      case '--limits':
        options.limitsPath = argv[++i];
        break;
      case '--crosswalk':
        options.crosswalkPath = argv[++i];
        break;
      case '--identity-json':
        options.identityPath = argv[++i];
        break;
      case '--source-folder':
        options.sourceFolder = argv[++i];
        break;
      case '--source-version':
        options.sourceVersion = argv[++i];
        break;
      case '--shard-count':
        options.shardCount = Number.parseInt(argv[++i], 10);
        if (!Number.isFinite(options.shardCount) || options.shardCount < 1) {
          throw new Error('--shard-count must be a positive integer');
        }
        break;
      case '--max-shard-bytes':
        options.maxShardBytes = Number.parseInt(argv[++i], 10);
        if (!Number.isFinite(options.maxShardBytes) || options.maxShardBytes < 4 * 1024 * 1024) {
          throw new Error('--max-shard-bytes must be >= 4MB');
        }
        break;
      case '--shard-key': {
        const raw = argv[++i];
        options.shardKey = raw.split(',').map((value) => value.trim()).filter(Boolean);
        break;
      }
      case '--preview-limit':
        options.previewLimit = Number.parseInt(argv[++i], 10);
        if (!Number.isFinite(options.previewLimit) || options.previewLimit < 0) {
          throw new Error('--preview-limit must be >= 0');
        }
        break;
      case '--skip-preview':
        options.skipPreview = true;
        break;
      case '--label':
        options.label = argv[++i];
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.input) {
    throw new Error('Missing required --input argument');
  }
  if (!options.dataset) {
    throw new Error('Missing required --dataset argument');
  }

  return options;
}

function loadLimits(limitsPath, repoRoot) {
  const resolved = limitsPath
    ? path.resolve(limitsPath)
    : path.join(repoRoot, 'src', 'config', 'limits.json');
  try {
    if (fs.existsSync(resolved)) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return require(resolved);
    }
    // If no explicit --limits was provided and the default file is missing,
    // treat as no limits without warning.
    if (limitsPath) {
      console.warn(`Warning: unable to load limits from ${resolved}: file not found`);
    }
  } catch (error) {
    // Only warn if the user explicitly provided a path; otherwise stay quiet.
    if (limitsPath) {
      console.warn(`Warning: unable to load limits from ${resolved}: ${error.message}`);
    }
  }
  return {};
}

function resolveValueColumnLimit(datasetId, inputFileName, limits) {
  const defaultLimit = Number.isFinite(limits?.indexValueColumnLimit)
    ? Math.max(1, Math.floor(limits.indexValueColumnLimit))
    : 8;
  const overrides = limits?.indexValueColumnLimitOverrides || {};
  const overridesLower = Object.entries(overrides).reduce((acc, [key, value]) => {
    acc[String(key).toLowerCase()] = value;
    return acc;
  }, {});
  const candidates = normalisedDatasetKeys(datasetId, inputFileName);
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(overridesLower, candidate)) {
      const override = overridesLower[candidate];
      if (Number.isFinite(override) && override >= 1) {
        return Math.floor(override);
      }
    }
  }
  return defaultLimit;
}

function isDatasetExcluded(datasetId, inputFileName, limits) {
  const exclusions = Array.isArray(limits?.indexDatasetExclusions) ? limits.indexDatasetExclusions : [];
  const exclusionSet = new Set(exclusions.map((entry) => String(entry || '').toLowerCase()));
  const candidates = normalisedDatasetKeys(datasetId, inputFileName);
  return candidates.some((candidate) => exclusionSet.has(candidate));
}

function normalizeTokenSource(value) {
  if (value == null) {
    return '';
  }
  const stringValue = String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(DIACRITIC_REGEX, '')
    .replace(TOKEN_NORMALIZE_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stringValue;
}

function collectNgramsFromTokens(tokens, set) {
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    const compact = token.replace(/\s+/g, '');
    for (let length = ROUTING_MIN_LENGTH; length <= ROUTING_MAX_LENGTH; length += 1) {
      if (compact.length < length) {
        continue;
      }
      for (let index = 0; index <= compact.length - length; index += 1) {
        const ngram = compact.slice(index, index + length);
        set.add(ngram);
        if (set.size >= ROUTING_MAX_NGRAMS) {
          return;
        }
      }
    }
  }
}

function tokenizeForRouting(row, columns) {
  const tokens = [];
  for (const column of columns) {
    const raw = row[column];
    const normalized = normalizeTokenSource(raw);
    if (normalized) {
      tokens.push(...normalized.split(' '));
    }
  }
  return tokens;
}

function sanitizeValue(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  return String(value);
}

async function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

function createSchema(db, narrowColumns, extraColumns) {
  const rawColumnsDDL = narrowColumns.map((column) => `${quoteIdentifier(column)} TEXT`).join(', ');
  db.exec(`CREATE TABLE t_raw (
    rowid INTEGER PRIMARY KEY,
    ${rawColumnsDDL}
  );`);

  if (extraColumns.length) {
    db.exec('CREATE TABLE t_extra (rowid INTEGER PRIMARY KEY, payload TEXT NOT NULL);');
  }

  const ftsColumnsDDL = narrowColumns.map((column) => quoteIdentifier(column)).join(', ');
  db.exec(`CREATE VIRTUAL TABLE t_fts USING fts5(
    ${ftsColumnsDDL},
    content='t_raw',
    content_rowid='rowid',
    tokenize="unicode61 tokenchars '-._'",
    prefix='2 3'
  );`);

  db.exec('CREATE INDEX idx_raw_rowid ON t_raw(rowid);');
  if (extraColumns.length) {
    db.exec('CREATE INDEX idx_extra_rowid ON t_extra(rowid);');
  }
}

function createShardContexts(params) {
  const {
    outputDir,
    shardCount,
    dataset,
    narrowColumns,
    extraColumns,
  } = params;

  const contexts = [];
  for (let shard = 0; shard < shardCount; shard += 1) {
    const suffix = shardCount === 1 ? '' : `.shard${String(shard).padStart(2, '0')}`;
    const fileName = `${dataset}${suffix}.sqlite`;
    const filePath = path.join(outputDir, fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    const db = new Database(filePath);
    db.pragma('page_size = 4096');
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.pragma('temp_store = MEMORY');
    db.exec('PRAGMA locking_mode = EXCLUSIVE;');
    createSchema(db, narrowColumns, extraColumns);
    db.exec('BEGIN IMMEDIATE TRANSACTION;');

    const insertPlaceholders = new Array(narrowColumns.length).fill('?').join(', ');
    const insertRawSql = `INSERT INTO t_raw(rowid, ${narrowColumns.map((c) => quoteIdentifier(c)).join(', ')}) VALUES (?, ${insertPlaceholders});`;
    const insertRawStmt = db.prepare(insertRawSql);

    let insertExtraStmt = null;
    if (extraColumns.length) {
      insertExtraStmt = db.prepare('INSERT INTO t_extra(rowid, payload) VALUES (?, ?);');
    }

    const insertFtsSql = `INSERT INTO t_fts(rowid, ${narrowColumns.map((c) => quoteIdentifier(c)).join(', ')}) VALUES (?, ${insertPlaceholders});`;
    const insertFtsStmt = db.prepare(insertFtsSql);

    contexts.push({
      shard,
      fileName,
      filePath,
      db,
      insertRawStmt,
      insertExtraStmt,
      insertFtsStmt,
      rowCount: 0,
      routingSet: new Set(),
      narrowColumns,
      extraColumns,
    });
  }
  return contexts;
}

function closeStatements(context) {
  if (context.insertRawStmt) {
    context.insertRawStmt = null;
  }
  if (context.insertExtraStmt) {
    context.insertExtraStmt = null;
  }
  if (context.insertFtsStmt) {
    context.insertFtsStmt = null;
  }
}

async function finalizeContext(context) {
  const { db } = context;
  try {
    db.exec('COMMIT;');
    db.exec('ANALYZE;');
    db.exec('PRAGMA optimize;');
    db.exec('VACUUM;');
  } finally {
    db.close();
  }
  const stats = await fsp.stat(context.filePath);
  const sha256 = await computeSha256(context.filePath);
  context.sizeBytes = stats.size;
  context.sha256 = sha256;
}

function writePreviewFile(datasetDir, datasetId, columns, rows) {
  const filePath = path.join(datasetDir, 'preview.json');
  const payload = {
    datasetId,
    generatedAt: new Date().toISOString(),
    columns,
    rows,
  };
  return fsp.writeFile(filePath, JSON.stringify(payload));
}

async function writeRoutingHeader(datasetDir, datasetId, context) {
  if (!context.routingSet.size) {
    return null;
  }
  const sorted = Array.from(context.routingSet).sort();
  const fileName = `${datasetId}.shard${String(context.shard).padStart(2, '0')}.routing.json`;
  const filePath = path.join(datasetDir, fileName);
  const payload = {
    datasetId,
    shard: context.shard,
    strategy: 'ngram',
    prefixLengths: [2, 3],
    ngrams: sorted.slice(0, ROUTING_MAX_NGRAMS),
  };
  await fsp.writeFile(filePath, JSON.stringify(payload));
  return fileName;
}

async function updateDatasetsIndex(indexPath, entry) {
  let current = [];
  try {
    const buffer = await fsp.readFile(indexPath, 'utf8');
    current = JSON.parse(buffer);
    if (!Array.isArray(current)) {
      current = [];
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const filtered = current.filter((item) => item.datasetId !== entry.datasetId);
  filtered.push(entry);
  filtered.sort((a, b) => a.datasetId.localeCompare(b.datasetId));
  await fsp.writeFile(indexPath, JSON.stringify(filtered, null, 2));
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const datasetId = args.dataset;
  const outputRoot = args.output ? path.resolve(args.output) : path.join(repoRoot, 'public', 'data', 'sqlite');
  const datasetDir = path.join(outputRoot, datasetId);
  await fsp.mkdir(datasetDir, { recursive: true });

  const limits = loadLimits(args.limitsPath, repoRoot);
  const inputFileName = path.basename(inputPath);
  if (isDatasetExcluded(datasetId, inputFileName, limits)) {
    console.error(`Dataset ${datasetId} excluded by limits configuration. Skipping.`);
    return;
  }

  const stats = await fsp.stat(inputPath);
  if (!stats.isFile()) {
    throw new Error(`Input path ${inputPath} is not a file`);
  }

  const valueColumnLimit = resolveValueColumnLimit(datasetId, inputFileName, limits);
  const label = args.label || datasetId;

  const shardCount = args.shardCount || Math.max(1, Math.ceil(stats.size / args.maxShardBytes));

  const hashRuntime = await xxhashFactory();

  const crosswalk = loadCrosswalk(args.crosswalkPath, repoRoot);
  const crosswalkHeaders = resolveCrosswalkHeaders(crosswalk, datasetId, inputPath);
  const useCrosswalkHeaders = Array.isArray(crosswalkHeaders) && crosswalkHeaders.length > 0;
  if (useCrosswalkHeaders) {
    console.log(`Using ${crosswalkHeaders.length} header(s) from crosswalk for ${datasetId}.`);
  } else {
    console.log(`No crosswalk headers found for ${datasetId}; using the first row of the file.`);
  }

  let columns = useCrosswalkHeaders ? [...crosswalkHeaders] : [];
  let narrowColumns = useCrosswalkHeaders
    ? columns.slice(0, Math.min(columns.length, valueColumnLimit))
    : [];
  let extraColumns = useCrosswalkHeaders ? columns.slice(narrowColumns.length) : [];
  let contexts = [];
  let rowId = 0;
  const previewRows = [];
  let maxColumns = columns.length;

  const shardKeyColumns = args.shardKey.length ? args.shardKey : null;

  const papaConfig = {
    header: !useCrosswalkHeaders,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
  };

  const inputStream = createInputStream(inputPath);
  const papaStream = Papa.parse(Papa.NODE_STREAM_INPUT, papaConfig);

  let resolveStream;
  let rejectStream;
  const completion = new Promise((resolve, reject) => {
    resolveStream = resolve;
    rejectStream = reject;
  });

  papaStream.on('error', (error) => {
    rejectStream(error);
  });

  papaStream.on('data', (row) => {
    let record = row;

    if (useCrosswalkHeaders) {
      const values = Array.isArray(row) ? row : Object.values(row);
      if (!contexts.length && values.length > columns.length) {
        for (let index = columns.length; index < values.length; index += 1) {
          columns.push(`${GENERATED_COLUMN_PREFIX}${index + 1}`);
        }
        narrowColumns = columns.slice(0, Math.min(columns.length, valueColumnLimit));
        extraColumns = columns.slice(narrowColumns.length);
      } else if (contexts.length && values.length > columns.length) {
        throw new Error(`Row ${rowId + 1} contains more columns than the schema allows for ${datasetId}.`);
      }
      record = {};
      for (let index = 0; index < columns.length; index += 1) {
        record[columns[index]] = values[index] ?? null;
      }
    } else if (!columns.length) {
      columns = Object.keys(row);
      narrowColumns = columns.slice(0, Math.min(columns.length, valueColumnLimit));
      extraColumns = columns.slice(narrowColumns.length);
    }

    if (!contexts.length) {
      contexts = createShardContexts({
        outputDir: datasetDir,
        shardCount,
        dataset: datasetId,
        narrowColumns,
        extraColumns,
      });
    }

    maxColumns = Math.max(maxColumns, columns.length);
    rowId += 1;

    const displayValues = narrowColumns.map((column) => {
      const value = sanitizeValue(record[column]);
      return value == null ? null : String(value);
    });

    const extraPayload = {};
    if (extraColumns.length) {
      for (const column of extraColumns) {
        const value = sanitizeValue(record[column]);
        if (value != null) {
          extraPayload[column] = value;
        }
      }
    }

    const normalizedKeySource = (shardKeyColumns && shardKeyColumns.length)
      ? shardKeyColumns.map((column) => normalizeTokenSource(record[column])).join('|')
      : normalizeTokenSource(displayValues.map((value) => (value == null ? '' : value)).join(' '));
    const shardIndex = contexts.length === 1
      ? 0
      : Number(hashRuntime.h32(normalizedKeySource) % contexts.length);
    const context = contexts[shardIndex];

    context.insertRawStmt.run(rowId, ...displayValues);
    const ftsValues = narrowColumns.map((column) => {
      const normalized = normalizeTokenSource(record[column]);
      return normalized || null;
    });
    context.insertFtsStmt.run(rowId, ...ftsValues);
    if (context.insertExtraStmt && Object.keys(extraPayload).length) {
      context.insertExtraStmt.run(rowId, JSON.stringify(extraPayload));
    }
    context.rowCount += 1;

    if (contexts.length > 1) {
      const tokens = tokenizeForRouting(record, narrowColumns);
      if (tokens.length && context.routingSet.size < ROUTING_MAX_NGRAMS) {
        collectNgramsFromTokens(tokens, context.routingSet);
      }
    }

    if (!args.skipPreview && previewRows.length < args.previewLimit) {
      const previewRow = columns.map((column) => {
        const value = sanitizeValue(record[column]);
        return value == null ? null : value;
      });
      previewRows.push(previewRow);
    }
  });

  papaStream.on('end', () => {
    resolveStream();
  });

  inputStream.pipe(papaStream);

  await completion;

  if (rowId === 0) {
    console.warn(`Input ${inputPath} yielded no rows. Nothing to build.`);
    return;
  }

  for (const context of contexts) {
    closeStatements(context);
    await finalizeContext(context);
  }

  if (!args.skipPreview && previewRows.length) {
    await writePreviewFile(datasetDir, datasetId, columns, previewRows);
  }

  const routingFiles = [];
  if (contexts.length > 1) {
    for (const context of contexts) {
      const routingFile = await writeRoutingHeader(datasetDir, datasetId, context);
      routingFiles.push(routingFile);
    }
  }

  const manifest = {
    datasetId,
    label,
    generatedAt: new Date().toISOString(),
    rowCount: rowId,
    maxColumns,
    narrowColumns,
    extraColumns,
    shardCount: contexts.length,
    pageSizeBytes: 4096,
    resources: contexts.map((context, index) => ({
      shard: index,
      file: context.fileName,
      size: context.sizeBytes,
      sha256: context.sha256,
      url: `./${context.fileName}`,
      routing: routingFiles[index] ? `./${routingFiles[index]}` : null,
      rowCount: context.rowCount,
    })),
    preview: (!args.skipPreview && previewRows.length)
      ? {
        url: './preview.json',
        rows: previewRows.length,
      }
      : null,
    fts: {
      tokenize: "unicode61 tokenchars '-._'",
      prefix: ['2', '3'],
    },
    options: {
      shardKeyColumns,
      maxShardBytes: args.maxShardBytes,
    },
  };

  // Optionally embed source identity (folder/version/signature) to align UI warnings
  const identity = loadIdentityCrosswalk(args.identityPath, repoRoot);
  const srcId = resolveSourceIdentity(identity, args.sourceFolder, args.sourceVersion, datasetId, inputPath);
  if (srcId) {
    manifest.sourceIdentity = srcId;
  } else if (args.sourceFolder || args.sourceVersion) {
    // Record minimal hint if provided but no signature found
    manifest.sourceIdentity = {
      folder: args.sourceFolder || undefined,
      version: args.sourceVersion || undefined,
      baseCsv: toBaseCsvNameForInput(path.basename(inputPath), datasetId),
    };
  }

  const manifestPath = path.join(datasetDir, 'manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const indexEntry = {
    datasetId,
    label,
    manifest: `./${datasetId}/manifest.json`,
    generatedAt: manifest.generatedAt,
    rowCount: rowId,
    shardCount: contexts.length,
  };
  const indexPath = path.join(outputRoot, 'datasets.json');
  await updateDatasetsIndex(indexPath, indexEntry);

  console.log(`Built SQLite FTS artefacts for ${datasetId}: ${contexts.length} shard(s)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
