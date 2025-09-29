/* eslint-disable no-restricted-globals */
self.importScripts('../sqljs/sqljs-httpvfs.js');

const MAX_RESULTS = 50;
const FIRST_BATCH_SIZE = 20;
const DEFAULT_PAGE_SIZE = 4096;
const DEFAULT_BYTES_BUDGET = Number.POSITIVE_INFINITY; // unlimited unless caller provides a finite cap

const TOKEN_NORMALIZE_REGEX = /[^a-z0-9\-._\s]+/g;
const DIACRITIC_REGEX = /[\u0300-\u036f]/g;
const ROUTING_MIN_LENGTH = 2;
const ROUTING_MAX_LENGTH = 3;

function quoteIdentifier(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

postMessage({ type: 'log', level: 'log', message: 'search worker booted' });

let cachedCreateDbWorker = null;

const state = {
  datasetId: null,
  manifest: null,
  baseUrl: null,
  assetBaseUrl: null,
  bytesBudget: DEFAULT_BYTES_BUDGET,
  shards: new Map(),
  routingCache: new Map(),
};

function ensureCreateDbWorker() {
  if (cachedCreateDbWorker) {
    return cachedCreateDbWorker;
  }
  if (typeof self.createDbWorker !== 'function') {
    throw new Error('sql.js-httpvfs bundle did not expose createDbWorker');
  }
  cachedCreateDbWorker = self.createDbWorker;
  return cachedCreateDbWorker;
}

function normalizeString(value) {
  if (!value && value !== 0) {
    return '';
  }
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(DIACRITIC_REGEX, '')
    .replace(TOKEN_NORMALIZE_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeQuery(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return { normalized, tokens: [], ngrams: [] };
  }
  const tokens = normalized.split(' ').filter(Boolean);
  const ngrams = new Set();
  for (const token of tokens) {
    const compact = token.replace(/\s+/g, '');
    for (let length = ROUTING_MIN_LENGTH; length <= ROUTING_MAX_LENGTH; length += 1) {
      if (compact.length < length) {
        continue;
      }
      for (let index = 0; index <= compact.length - length; index += 1) {
        ngrams.add(compact.slice(index, index + length));
      }
    }
  }
  return { normalized, tokens, ngrams };
}

function rowsFromExec(results) {
  if (!results || !results.length) {
    return [];
  }
  const [first] = results;
  const { columns, values } = first;
  if (!columns || !values) {
    return [];
  }
  return values.map((row) => {
    const entry = {};
    for (let index = 0; index < columns.length; index += 1) {
      entry[columns[index]] = row[index];
    }
    return entry;
  });
}

function buildFtsMatch(tokens) {
  if (!tokens.length) {
    return null;
  }
  const ftsTokens = tokens.map((token) => `${token}*`);
  return ftsTokens.join(' ');
}

function buildLikeClause(columns, token) {
  const escaped = token.replace(/%/g, '\\%').replace(/_/g, '\\_');
  const likeExpression = `'%' || '${escaped}' || '%'`;
  return columns.map((column) => `${quoteIdentifier(column)} LIKE ${likeExpression}`).join(' OR ');
}

function resolveUrl(relativePath, base) {
  return new URL(relativePath, base).toString();
}

async function disposeShards() {
  const disposePromises = [];
  for (const context of state.shards.values()) {
    if (context.promise) {
      disposePromises.push(
        context.promise.then(async (resolved) => {
          try {
            if (resolved.db?.close) {
              resolved.db.close();
            }
          } catch (error) {
            // ignore disposal errors
          }
        }).catch(() => {})
      );
    }
  }
  state.shards.clear();
  state.routingCache.clear();
  if (disposePromises.length) {
    await Promise.allSettled(disposePromises);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

async function ensureRouting(shardIndex) {
  if (state.routingCache.has(shardIndex)) {
    return state.routingCache.get(shardIndex);
  }
  if (!state.manifest) {
    return null;
  }
  const resource = state.manifest.resources?.[shardIndex];
  if (!resource || !resource.routing) {
    state.routingCache.set(shardIndex, null);
    return null;
  }
  const routingUrl = resolveUrl(resource.routing, state.baseUrl);
  try {
    const payload = await fetchJson(routingUrl);
    const { ngrams } = payload || {};
    const set = new Set(Array.isArray(ngrams) ? ngrams : []);
    state.routingCache.set(shardIndex, set);
    return set;
  } catch (error) {
    postMessage({
      type: 'log',
      level: 'warn',
      message: `Failed to load routing header for shard ${shardIndex}: ${error.message}`,
    });
    state.routingCache.set(shardIndex, null);
    return null;
  }
}

async function selectCandidateShards(ngrams) {
  if (!state.manifest) {
    return [];
  }
  if (state.manifest.shardCount <= 1) {
    return [0];
  }
  if (!ngrams.size) {
    return state.manifest.resources.map((_, index) => index);
  }
  const matches = [];
  for (let index = 0; index < state.manifest.resources.length; index += 1) {
    const routingSet = await ensureRouting(index);
    if (!routingSet || !routingSet.size) {
      matches.push(index);
      continue;
    }
    const intersects = [...ngrams].some((gram) => routingSet.has(gram));
    if (intersects) {
      matches.push(index);
    }
  }
  return matches.length ? matches : state.manifest.resources.map((_, index) => index);
}

async function openShard(shardIndex) {
  if (!state.manifest) {
    throw new Error('Manifest not initialised');
  }
  const existing = state.shards.get(shardIndex);
  if (existing && existing.promise) {
    return existing.promise;
  }
  const resource = state.manifest.resources[shardIndex];
  const virtualFilename = resource.file;
  const pageSize = state.manifest.pageSizeBytes || DEFAULT_PAGE_SIZE;
  const fileUrl = resolveUrl(resource.url, state.baseUrl);
  const cacheBust = resource.sha256 || resource.file;





  postMessage({
    type: 'log',
    level: 'log',
    message: `opening shard ${shardIndex}: ${virtualFilename} from ${fileUrl}`,
  });

  const workerUrl = resolveUrl('../sqljs/sqlite.worker.js', state.assetBaseUrl);
  const wasmUrl = resolveUrl('../sqljs/sql-wasm.wasm', state.assetBaseUrl);

  const config = {
    virtualFilename,
    from: 'inline',
    config: {
      serverMode: 'full',
      url: fileUrl,
      requestChunkSize: pageSize,
      cacheBust,
    },
  };

  const createDbWorker = ensureCreateDbWorker();
  const promise = createDbWorker([config], workerUrl, wasmUrl, state.bytesBudget).then((worker) => ({
    db: worker.db,
    worker: worker.worker,
    config,
    url: fileUrl,
  }));
  state.shards.set(shardIndex, { promise, config });
  promise
    .then(() => {
      postMessage({
        type: 'log',
        level: 'log',
        message: `shard ${shardIndex} ready: ${virtualFilename}`,
      });
    })
    .catch((error) => {
      postMessage({
        type: 'log',
        level: 'warn',
        message: `Failed to open shard ${shardIndex}: ${error.message || error}`,
      });
    });
  return promise;
}

async function collectShardStats(shardContext) {
  if (!shardContext?.worker?.getStats) {
    return null;
  }
  try {
    return await shardContext.worker.getStats(shardContext.config?.virtualFilename);
  } catch (error) {
    postMessage({ type: 'log', level: 'warn', message: `getStats failed: ${error.message}` });
    return null;
  }
}

function formatRow(row, narrowColumns) {
  const item = { rowid: row.rowid };
  for (const column of narrowColumns) {
    item[column] = row[column] ?? null;
  }
  return item;
}

async function queryShard(shardIndex, normalizedQuery, limit) {
  const context = await openShard(shardIndex);
  const { db } = context;
  const manifest = state.manifest;
  const narrowColumns = manifest.narrowColumns || [];
  const matchExpression = buildFtsMatch(normalizedQuery.tokens);
  if (!matchExpression) {
    return { items: [], stats: null };
  }

  const startStats = await collectShardStats(context);
  const ftsSql = `SELECT rowid FROM t_fts WHERE t_fts MATCH '${matchExpression}' ORDER BY bm25(t_fts) LIMIT ${limit};`;
  let rows = rowsFromExec(await db.exec(ftsSql));

  if (!rows.length && normalizedQuery.tokens.length) {
    const likeClauses = normalizedQuery.tokens
      .filter((token) => token.length >= 2)
      .map((token) => buildLikeClause(narrowColumns, token));
    if (likeClauses.length) {
      const fallbackSql = `SELECT rowid FROM t_fts WHERE ${likeClauses.join(' AND ')} LIMIT ${limit};`;
      rows = rowsFromExec(await db.exec(fallbackSql));
    }
  }

  const rowIds = rows.map((row) => row.rowid).filter((value) => Number.isInteger(value));
  if (!rowIds.length) {
    const endStatsEmpty = await collectShardStats(context);
    return { items: [], stats: { start: startStats, end: endStatsEmpty } };
  }

  const uniqueRowIds = Array.from(new Set(rowIds));
  const orderMap = new Map(uniqueRowIds.map((value, index) => [value, index]));
  const rawSql = `SELECT rowid, ${narrowColumns.map((column) => quoteIdentifier(column)).join(', ')} FROM t_raw WHERE rowid IN (${uniqueRowIds.join(',')}) LIMIT ${limit};`;
  const rawRows = rowsFromExec(await db.exec(rawSql));
  rawRows.sort((a, b) => {
    const aIndex = orderMap.get(a.rowid) ?? 0;
    const bIndex = orderMap.get(b.rowid) ?? 0;
    return aIndex - bIndex;
  });

  const items = rawRows.map((row) => formatRow(row, narrowColumns));
  const endStats = await collectShardStats(context);
  postMessage({ type: 'log', level: 'log', message: `shard ${shardIndex} returned ${items.length} rows` });
  return {
    items,
    stats: { start: startStats, end: endStats },
  };
}

function accumulateBytes(stats) {
  if (!stats || !stats.start || !stats.end) {
    return 0;
  }
  const { start, end } = stats;
  if (!start || !end) {
    return 0;
  }
  if (typeof start.totalFetchedBytes !== 'number' || typeof end.totalFetchedBytes !== 'number') {
    return 0;
  }
  return Math.max(0, end.totalFetchedBytes - start.totalFetchedBytes);
}

async function handleSearchMessage(payload) {
  const { requestId, query, limit = MAX_RESULTS } = payload;
  if (!state.manifest) {
    postMessage({ type: 'error', error: 'Search worker is not initialised.', requestId });
    return;
  }
  postMessage({ type: 'log', level: 'log', message: `search request ${requestId}: ${query}` });
  const start = performance.now();

  const normalized = tokenizeQuery(query || '');
  if (!normalized.tokens.length) {
    postMessage({
      type: 'results',
      requestId,
      datasetId: state.datasetId,
      total: 0,
      items: [],
      partial: false,
      elapsedMs: performance.now() - start,
      bytesFetched: 0,
      shardsSearched: [],
    });
    return;
  }

  const shardCandidates = await selectCandidateShards(normalized.ngrams);
  postMessage({ type: 'log', level: 'log', message: `search request ${requestId} shard candidates: ${JSON.stringify(shardCandidates)}` });
  const collected = [];
  const shardStats = [];
  const firstBatch = [];
  const seenRowIds = new Set();

  for (const shardIndex of shardCandidates) {
    const { items, stats } = await queryShard(shardIndex, normalized, limit);
    shardStats.push(stats);
    for (const item of items) {
      if (seenRowIds.has(item.rowid)) {
        continue;
      }
      seenRowIds.add(item.rowid);
      collected.push(item);
      if (firstBatch.length < FIRST_BATCH_SIZE) {
        firstBatch.push(item);
      }
      if (collected.length >= limit) {
        break;
      }
    }
    if (collected.length >= limit) {
      break;
    }
  }

  const elapsed = performance.now() - start;
  const totalBytes = shardStats.reduce((sum, entry) => sum + accumulateBytes(entry), 0);

  if (firstBatch.length) {
    postMessage({
      type: 'results',
      partial: true,
      requestId,
      datasetId: state.datasetId,
      total: collected.length,
      items: firstBatch,
      elapsedMs: elapsed,
      bytesFetched: totalBytes,
      shardsSearched: shardCandidates,
    });
  }

  postMessage({
    type: 'results',
    partial: false,
    requestId,
    datasetId: state.datasetId,
    total: collected.length,
    items: collected,
    elapsedMs: elapsed,
    bytesFetched: totalBytes,
    shardsSearched: shardCandidates,
  });
}

async function handleInitMessage(payload) {
  const {
    datasetId,
    manifest,
    manifestUrl,
    assetBaseUrl,
    bytesBudget,
  } = payload;

  const manifestPayload = manifest || (manifestUrl ? await fetchJson(manifestUrl) : null);
  if (!manifestPayload) {
    throw new Error('Missing manifest data for worker initialisation');
  }

  await disposeShards();

  state.datasetId = datasetId;
  state.manifest = manifestPayload;
  const workerBase = new URL('./', self.location.href).toString();
  state.baseUrl = manifestUrl ? new URL('./', manifestUrl).toString() : (payload.baseUrl ? new URL('./', payload.baseUrl).toString() : workerBase);
  state.assetBaseUrl = assetBaseUrl ? new URL('./', assetBaseUrl).toString() : workerBase;
  state.bytesBudget = Number.isFinite(bytesBudget) ? bytesBudget : DEFAULT_BYTES_BUDGET;

  postMessage({
    type: 'ready',
    datasetId,
    manifest: {
      datasetId: manifestPayload.datasetId,
      label: manifestPayload.label,
      rowCount: manifestPayload.rowCount,
      shardCount: manifestPayload.shardCount,
      narrowColumns: manifestPayload.narrowColumns,
    },
  });
}

async function handleClearCache() {
  await disposeShards();
  postMessage({ type: 'cacheCleared' });
}

self.addEventListener('message', (event) => {
  const { data } = event;
  if (!data || !data.type) {
    return;
  }
  switch (data.type) {
    case 'init':
      handleInitMessage(data).catch((error) => {
        postMessage({ type: 'error', error: error.message || String(error) });
      });
      break;
    case 'search':
      handleSearchMessage(data).catch((error) => {
        postMessage({ type: 'error', error: error.message || String(error), requestId: data.requestId });
      });
      break;
    case 'clear-cache':
      handleClearCache().catch((error) => {
        postMessage({ type: 'error', error: error.message || String(error) });
      });
      break;
    default:
      postMessage({ type: 'log', level: 'warn', message: `Unknown message type: ${data.type}` });
      break;
  }
});
