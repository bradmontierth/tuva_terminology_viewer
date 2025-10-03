#!/usr/bin/env node

/*
 * Builds a crosswalk of file identity across S3 versioned folders by
 * comparing ETags (and sizes) without downloading file contents.
 *
 * Output structure (simplified):
 * {
 *   _meta: { generatedAt, baseUrl, folders, versionsPerFolder },
 *   versioned_terminology: {
 *     versions: ["0.14.5", ...],
 *     groups: {
 *       "provider.csv": {
 *         history: [ { version, signature, segments: [ { file, etag, size } ] } ],
 *         runs: [ { start, end, signature, versions: [ ... ] } ]
 *       }
 *     }
 *   },
 *   versioned_provider_data: { ... },
 *   versioned_value_sets: { ... }
 * }
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { createHash } = require('crypto');

const scriptDir = __dirname;
const projectRoot = path.resolve(scriptDir, '..');
const outputPath = process.env.TUVA_IDENTITY_OUTPUT
  ? path.resolve(process.env.TUVA_IDENTITY_OUTPUT)
  : path.join(projectRoot, 'public', 'data', 'file-identity-crosswalk.json');
const fallbackOutputPath = path.join(projectRoot, 'src', 'generated', 'fileIdentityCrosswalk.json');

const baseUrl = (process.env.TUVA_DATA_BASE_URL || 'https://tuva-public-resources.s3.amazonaws.com').replace(/\/$/, '');
const foldersEnv = (process.env.TUVA_FOLDERS || '').trim();
const folders = foldersEnv
  ? foldersEnv.split(',').map((s) => s.trim()).filter(Boolean)
  : ['versioned_terminology', 'versioned_provider_data', 'versioned_value_sets'];
const skipFetch = process.env.TUVA_IDENTITY_SKIP_FETCH === '1';
const disable = process.env.TUVA_IDENTITY_DISABLE === '1';
const verbose = process.env.TUVA_IDENTITY_VERBOSE === '1';

function log(msg) { if (verbose) console.log(`[identity] ${msg}`); }
function warn(msg) { console.warn(`[identity] ${msg}`); }

if (disable) {
  console.log('[identity] Skipping identity crosswalk generation (disabled via env).');
  // Ensure fallback exists so imports succeed
  try {
    fs.mkdirSync(path.dirname(fallbackOutputPath), { recursive: true });
    fs.writeFileSync(fallbackOutputPath, `${JSON.stringify({ _meta: { disabled: true } })}\n`);
  } catch (e) {
    // ignore
  }
  process.exit(0);
}

function httpGetAny(url) {
  return new Promise((resolve, reject) => {
    let client = https;
    try {
      const parsed = new URL(url);
      client = parsed.protocol === 'http:' ? http : https;
    } catch (_) {
      // keep https default
    }
    const req = client.get(url, { headers: { Accept: 'application/xml,text/xml;q=0.9' } }, (res) => {
      const { statusCode } = res;
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`HTTP ${statusCode} for ${url}\n${body.slice(0, 500)}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', reject);
  });
}

// Minimal XML helpers for S3 ListObjectsV2 output.
function tagRe(tag) {
  // Matches <CommonPrefixes> or <s3:CommonPrefixes> and closing tag
  return new RegExp(`<(?:[^:>]+:)?${tag}>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, 'g');
}

function extractAll(xml, tag) {
  const results = [];
  const re = tagRe(tag);
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1]);
  }
  return results;
}

function extractText(xml, tag) {
  const re = tagRe(tag);
  const m = re.exec(xml);
  return m ? m[1] : null;
}

function parseCommonPrefixes(xml, folder) {
  const blocks = extractAll(xml, 'CommonPrefixes');
  const versions = [];
  for (const block of blocks) {
    const prefix = extractText(block, 'Prefix');
    if (!prefix) continue;
    const clean = decodeURIComponent(prefix).replace(/\/+$/, '');
    const rel = clean.replace(`${folder}/`, '');
    if (rel && rel !== folder) {
      versions.push(rel);
    }
  }
  return versions;
}

function parseContents(xml, prefixBase, opts = {}) {
  const contents = extractAll(xml, 'Contents');
  const items = [];
  for (const c of contents) {
    let key = extractText(c, 'Key') || '';
    if (!key || key.endsWith('/')) continue;
    if (opts.excluded && opts.excluded.some((p) => key.startsWith(p))) continue;
    let relative = key;
    if (prefixBase && key.startsWith(prefixBase)) {
      relative = key.slice(prefixBase.length);
    }
    const etag = (extractText(c, 'ETag') || '').replace(/^\"|\"$/g, '');
    const sizeRaw = extractText(c, 'Size') || '';
    const size = Number.parseInt(sizeRaw, 10);
    const lastModified = extractText(c, 'LastModified') || null;
    items.push({ key, relative, etag, size: Number.isFinite(size) ? size : null, lastModified });
  }
  const truncated = (extractText(xml, 'IsTruncated') || '').trim() === 'true';
  const nextToken = extractText(xml, 'NextContinuationToken');
  return { items, truncated, nextToken };
}

function detectS3Error(xml) {
  const code = extractText(xml, 'Code');
  const msg = extractText(xml, 'Message');
  // Only treat as error if there is an <Error> envelope
  if (/<(?:[^:>]+:)?Error>/.test(xml) && (code || msg)) {
    return { code, message: msg };
  }
  return null;
}

function normalizeBaseCsvName(fileName = '') {
  const normalized = String(fileName || '').trim();
  if (!normalized) return '';
  const match = normalized.match(/^(.*?\.csv)(?:_[0-9]+(?:_[0-9]+)*)?\.csv\.gz$/i);
  if (match) return match[1];
  if (/\.csv\.gz$/i.test(normalized)) return normalized.replace(/\.csv\.gz$/i, '.csv');
  return normalized;
}

function versionComparePrepare(value = '') {
  return value.replace(/_/g, '.');
}

function compareVersions(a = '', b = '') {
  const isLatest = (v) => String(v || '').toLowerCase() === 'latest';
  if (isLatest(a) && isLatest(b)) return 0;
  if (isLatest(a)) return 1;
  if (isLatest(b)) return -1;
  const aParts = versionComparePrepare(a).split(/[^0-9A-Za-z]+/).filter(Boolean);
  const bParts = versionComparePrepare(b).split(/[^0-9A-Za-z]+/).filter(Boolean);
  const maxLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLen; i += 1) {
    const as = aParts[i] || '0';
    const bs = bParts[i] || '0';
    const an = Number(as);
    const bn = Number(bs);
    const aIsNum = Number.isFinite(an);
    const bIsNum = Number.isFinite(bn);
    if (aIsNum && bIsNum) {
      if (an !== bn) return an > bn ? 1 : -1;
      // continue when equal
    } else {
      if (as !== bs) return as > bs ? 1 : -1;
    }
  }
  return 0;
}

async function listVersions(folder) {
  const versions = [];
  let continuation = null;
  do {
    const params = new URLSearchParams({ 'list-type': '2', prefix: `${folder}/`, delimiter: '/' });
    if (continuation) params.append('continuation-token', continuation);
    const url = `${baseUrl}/?${params.toString()}`;
    const xml = await httpGetAny(url);
    const err = detectS3Error(xml);
    if (err) {
      throw new Error(`${err.code || 'Error'}: ${err.message || 'S3 error'}`);
    }
    const page = parseCommonPrefixes(xml, folder);
    versions.push(...page);
    const { truncated, nextToken } = parseContents(xml, null); // will pick IsTruncated and NextContinuationToken
    continuation = truncated ? nextToken : null;
  } while (continuation);
  // Dedupe and sort descending (newest first) with 'latest' at end
  const unique = Array.from(new Set(versions)).filter(Boolean);
  const withoutLatest = unique.filter((v) => String(v).toLowerCase() !== 'latest');
  withoutLatest.sort((a, b) => compareVersions(versionComparePrepare(b), versionComparePrepare(a)));
  const hasLatest = unique.some((v) => String(v).toLowerCase() === 'latest');
  return hasLatest ? [...withoutLatest, 'latest'] : withoutLatest;
}

async function listFilesWithMeta(folder, version, options = {}) {
  const prefixBase = `${folder}/${version}/`;
  const items = [];
  let continuation = null;
  do {
    const params = new URLSearchParams({ 'list-type': '2', prefix: prefixBase });
    if (continuation) params.append('continuation-token', continuation);
    const url = `${baseUrl}/?${params.toString()}`;
    const xml = await httpGetAny(url);
    const err = detectS3Error(xml);
    if (err) {
      throw new Error(`${err.code || 'Error'}: ${err.message || 'S3 error'}`);
    }
    const page = parseContents(xml, prefixBase, options);
    items.push(...page.items);
    continuation = page.truncated ? page.nextToken : null;
  } while (continuation);
  // filter compressed marker files
  const filtered = items.filter((it) => !/\/_compressed/i.test(it.key));
  return filtered;
}

function computeGroupSignature(segments) {
  const sorted = [...segments].sort((a, b) => a.relative.localeCompare(b.relative, undefined, { numeric: true }));
  const sigSource = sorted.map((s) => `${s.relative}:${s.etag}:${s.size ?? ''}`).join('\n');
  return createHash('sha256').update(sigSource).digest('hex');
}

function buildRuns(entries, keyFields) {
  const runs = [];
  let current = null;
  for (const entry of entries) {
    const key = keyFields.map((k) => String(entry[k] ?? '')).join('|');
    if (!current || current.key !== key) {
      if (current) {
        // Persist the completed run including its explicit versions list
        runs.push({
          start: current.versions[0],
          end: current.versions[current.versions.length - 1],
          ...current.payload,
          versions: current.versions,
        });
      }
      current = { key, versions: [entry.version], payload: { signature: entry.signature } };
    } else {
      current.versions.push(entry.version);
    }
  }
  if (current) {
    runs.push({ start: current.versions[0], end: current.versions[current.versions.length - 1], ...current.payload, versions: current.versions });
  }
  return runs;
}

async function main() {
  if (skipFetch) {
    console.log('[identity] Skipping fetch (TUVA_IDENTITY_SKIP_FETCH=1).');
    // Ensure fallback stub exists to satisfy imports
    fs.mkdirSync(path.dirname(fallbackOutputPath), { recursive: true });
    fs.writeFileSync(fallbackOutputPath, `${JSON.stringify({ _meta: { skipped: true } })}\n`);
    return;
  }

  const result = { _meta: { generatedAt: new Date().toISOString(), baseUrl, folders: [], versionsPerFolder: {} } };

  for (const folder of folders) {
    log(`Listing versions for ${folder}`);
    let versions = [];
    try {
      versions = await listVersions(folder);
    } catch (e) {
      warn(`Unable to list versions for ${folder}: ${e.message}`);
      continue;
    }
    if (!versions.length) {
      warn(`No versions for ${folder}`);
      continue;
    }

    result._meta.folders.push(folder);
    result._meta.versionsPerFolder[folder] = versions;

    const folderOut = { versions, groups: {} };

    // Per-version listing and grouping
    for (const version of versions) {
      if (String(version).toLowerCase() === 'latest') {
        // Skip materializing latest; it's a dynamic alias that duplicates latest content
        continue;
      }
      log(`Listing files for ${folder}/${version}`);
      let files = [];
      try {
        const excluded = [];
        const page = await listFilesWithMeta(folder, version, { excluded });
        files = page;
      } catch (e) {
        warn(`Unable to list files for ${folder}/${version}: ${e.message}`);
        continue;
      }

      // Group by base CSV name
      const groupMap = new Map();
      for (const item of files) {
        const base = normalizeBaseCsvName(path.basename(item.relative)).toLowerCase();
        if (!base) continue;
        if (!groupMap.has(base)) groupMap.set(base, []);
        groupMap.get(base).push(item);
      }

      for (const [baseName, segments] of groupMap.entries()) {
        const signature = computeGroupSignature(segments);
        if (!folderOut.groups[baseName]) {
          folderOut.groups[baseName] = { history: [], runs: [] };
        }
        folderOut.groups[baseName].history.push({ version, signature, segments: segments.map((s) => ({ file: s.relative, etag: s.etag, size: s.size })) });
      }
    }

    // Sort group histories by version descending (newest first), then build runs
    Object.entries(folderOut.groups).forEach(([baseName, data]) => {
      const ordered = [...data.history].sort((a, b) => compareVersions(versionComparePrepare(b.version), versionComparePrepare(a.version)));
      data.history = ordered;
      data.runs = buildRuns(ordered, ['signature']);
    });

    result[folder] = folderOut;
  }

  // Write outputs
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[identity] Wrote ${outputPath}`);

  try {
    fs.mkdirSync(path.dirname(fallbackOutputPath), { recursive: true });
    fs.writeFileSync(fallbackOutputPath, `${JSON.stringify(result)}\n`);
    console.log(`[identity] Wrote ${fallbackOutputPath}`);
  } catch (e) {
    warn(`Unable to write fallback identity file: ${e.message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
