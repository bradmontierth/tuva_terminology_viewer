#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Papa = require('papaparse');
const limits = require('../src/config/limits.json');

const DEFAULT_MIN_ROWS = limits && typeof limits.partialPreviewRowLimit === 'number'
  ? limits.partialPreviewRowLimit
  : 50000;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for',
  'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or',
  'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'will', 'with'
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith('--')) {
      args[name] = value;
      i += 1;
    } else {
      args[name] = true;
      i -= 1;
    }
  }
  return args;
}

function toBaseCsvName(fileName = '') {
  const normalized = fileName.trim();
  if (!normalized) {
    return '';
  }

  const multiPartMatch = normalized.match(/^(.*?\.csv)(?:_[0-9]+(?:_[0-9]+)*)?\.csv\.gz$/i);
  if (multiPartMatch) {
    return multiPartMatch[1];
  }

  if (/\.csv\.gz$/i.test(normalized)) {
    return normalized.replace(/\.csv\.gz$/i, '.csv');
  }

  if (/\.csv$/i.test(normalized)) {
    return normalized;
  }

  return `${normalized}.csv`;
}

async function walkDirectory(rootDir) {
  const result = [];
  async function walk(currentDir) {
    const entries = await fs.promises.readdir(path.join(rootDir, currentDir), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(relativePath);
        continue;
      }

      if (!/^.*\.csv(\.gz)?$/i.test(entry.name)) {
        continue;
      }

      result.push(relativePath);
    }
  }

  await walk('.');
  return result.map((relativePath) => relativePath.replace(/^\.\//, ''));
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

function extractTokensFromRow(cells) {
  const tokens = new Set();
  for (const rawValue of cells) {
    const value = normalizeCellValue(rawValue).trim();
    if (!value) {
      continue;
    }

    const lowered = value.toLowerCase();
    const matches = lowered.match(/[a-z0-9]+/g);
    if (!matches) {
      continue;
    }

    for (const token of matches) {
      if (!token) {
        continue;
      }

      if (STOP_WORDS.has(token)) {
        continue;
      }

      if (token.length === 1 && isNaN(Number(token))) {
        continue;
      }

      tokens.add(token);
    }
  }
  return tokens;
}

function createDictionary() {
  const values = [''];
  const indexByValue = new Map();
  indexByValue.set('', 0);

  function getId(rawValue) {
    const value = normalizeCellValue(rawValue);
    if (indexByValue.has(value)) {
      return indexByValue.get(value);
    }
    const id = values.length;
    values.push(value);
    indexByValue.set(value, id);
    return id;
  }

  return {
    getId,
    values,
  };
}

function intersectSortedArrays(arrA, arrB) {
  const result = [];
  let i = 0;
  let j = 0;
  while (i < arrA.length && j < arrB.length) {
    const valueA = arrA[i];
    const valueB = arrB[j];
    if (valueA === valueB) {
      result.push(valueA);
      i += 1;
      j += 1;
    } else if (valueA < valueB) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return result;
}

async function buildIndexForGroup(rootDir, outputDir, groupKey, fileList, options = {}) {
  const rowThreshold = typeof options.rowThreshold === 'number'
    ? options.rowThreshold
    : null;
  const dictionary = createDictionary();
  const rows = [];
  const rowFiles = [];
  const rowPositions = [];
  const tokenToRows = new Map();
  const filesMeta = [];
  let totalRowCount = 0;
  let maxColumns = 0;

  for (let fileIndex = 0; fileIndex < fileList.length; fileIndex += 1) {
    const relativePath = fileList[fileIndex];
    const absolutePath = path.join(rootDir, relativePath);
    const fileName = path.basename(relativePath);
    const fileBuffer = await fs.promises.readFile(absolutePath);

    let csvString;
    if (/\.gz$/i.test(fileName)) {
      csvString = zlib.gunzipSync(fileBuffer).toString('utf8');
    } else {
      csvString = fileBuffer.toString('utf8');
    }

    const parsed = Papa.parse(csvString, {
      header: false,
      skipEmptyLines: true,
    });

    if (parsed.errors && parsed.errors.length) {
      const sampleError = parsed.errors[0];
      console.warn(`Warning: encountered parse errors in ${relativePath}:`, sampleError);
    }

    const dataRows = Array.isArray(parsed.data) ? parsed.data : [];
    let rowWithinFile = 0;

    for (const row of dataRows) {
      const normalizedRow = Array.isArray(row) ? row : [row];
      const rowIndex = rows.length;
      const tokens = extractTokensFromRow(normalizedRow);
      const encodedRow = normalizedRow.map((cell) => dictionary.getId(cell));

      maxColumns = Math.max(maxColumns, encodedRow.length);

      rows.push(encodedRow);
      rowFiles.push(fileIndex);
      rowPositions.push(rowWithinFile);

      for (const token of tokens) {
        if (!tokenToRows.has(token)) {
          tokenToRows.set(token, []);
        }
        const postingList = tokenToRows.get(token);
        if (postingList.length === 0 || postingList[postingList.length - 1] !== rowIndex) {
          postingList.push(rowIndex);
        }
      }

      rowWithinFile += 1;
    }

    filesMeta.push({
      name: fileName,
      rowCount: rowWithinFile,
    });

    totalRowCount += rowWithinFile;
  }

  if (rowThreshold !== null && totalRowCount <= rowThreshold) {
    return {
      skipped: true,
      reason: 'row-count-below-threshold',
      totalRows: totalRowCount,
      filesProcessed: fileList.length,
      rowThreshold,
    };
  }

  const sortedTokens = Array.from(tokenToRows.keys()).sort((a, b) => a.localeCompare(b));
  const postings = sortedTokens.map((token) => tokenToRows.get(token));
  const tokenLookup = Object.fromEntries(sortedTokens.map((token, index) => [token, index]));

  const indexPayload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    dataset: groupKey.baseName,
    totalRows: totalRowCount,
    maxColumns,
    files: filesMeta,
    dictionary: dictionary.values,
    rows,
    rowFiles,
    rowPositions,
    tokens: sortedTokens,
    postings,
    tokenLookup,
  };

  const json = JSON.stringify(indexPayload);
  const compressed = zlib.gzipSync(Buffer.from(json), { level: 9 });

  const outputPath = path.join(outputDir, groupKey.relativeDir, `${groupKey.baseName}.index.json.gz`);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, compressed);

  return {
    outputPath,
    totalRows: totalRowCount,
    filesProcessed: fileList.length,
    tokens: sortedTokens.length,
    dictionarySize: dictionary.values.length,
  };
}

function groupFilesByDataset(relativePaths) {
  const groups = new Map();

  for (const relativePath of relativePaths) {
    const normalized = relativePath.replace(/\\/g, '/');
    const dirName = path.dirname(normalized);
    const baseName = toBaseCsvName(path.basename(normalized));
    const groupKey = `${dirName}::${baseName}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        relativeDir: dirName === '.' ? '' : dirName,
        baseName,
        files: [],
      });
    }

    groups.get(groupKey).files.push(normalized);
  }

  for (const group of groups.values()) {
    group.files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  return Array.from(groups.values());
}

async function main() {
  const args = parseArgs(process.argv);
  const inputDir = args.input || args.i;
  const outputDir = args.output || args.o;
  const datasetFilter = args.dataset || args.d;
  const minRowsArg = args['min-rows'] || args.minRows;

  const minRowThreshold = minRowsArg !== undefined
    ? Number(minRowsArg)
    : DEFAULT_MIN_ROWS;

  if (!Number.isFinite(minRowThreshold) || minRowThreshold < 0) {
    console.error('Invalid value provided for --min-rows. Expected a non-negative number.');
    process.exit(1);
  }

  if (!inputDir) {
    console.error('Missing required --input argument');
    process.exit(1);
  }

  if (!outputDir) {
    console.error('Missing required --output argument');
    process.exit(1);
  }

  const resolvedInput = path.resolve(process.cwd(), inputDir);
  const resolvedOutput = path.resolve(process.cwd(), outputDir);

  const files = await walkDirectory(resolvedInput);
  if (!files.length) {
    console.warn('No CSV files found under input directory.');
    return;
  }

  const groups = groupFilesByDataset(files);
  const selectedGroups = datasetFilter
    ? groups.filter((group) => group.baseName === datasetFilter)
    : groups;

  if (!selectedGroups.length) {
    console.warn('No matching CSV groups found for the provided criteria.');
    return;
  }

  console.log(`Found ${selectedGroups.length} dataset group(s) to process.`);
  console.log(`Row threshold for indexing: ${minRowThreshold.toLocaleString()} rows.`);

  for (const group of selectedGroups) {
    const displayName = group.relativeDir ? `${group.relativeDir}/${group.baseName}` : group.baseName;
    console.log(`\nGenerating index for ${displayName} (${group.files.length} file(s))...`);

    try {
      const stats = await buildIndexForGroup(
        resolvedInput,
        resolvedOutput,
        group,
        group.files,
        { rowThreshold: minRowThreshold },
      );

      if (stats && stats.skipped) {
        const rowCountText = typeof stats.totalRows === 'number'
          ? stats.totalRows.toLocaleString()
          : 'unknown';
        console.log(`  • Skipped (row count ${rowCountText} <= ${minRowThreshold.toLocaleString()})`);
        continue;
      }

      console.log(`  • Rows indexed: ${stats.totalRows}`);
      console.log(`  • Unique tokens: ${stats.tokens}`);
      console.log(`  • Dictionary entries: ${stats.dictionarySize}`);
      console.log(`  • Output: ${path.relative(process.cwd(), stats.outputPath)}`);
    } catch (error) {
      console.error(`Failed to build index for ${displayName}:`, error.message);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = {
  extractTokensFromRow,
  intersectSortedArrays,
};
