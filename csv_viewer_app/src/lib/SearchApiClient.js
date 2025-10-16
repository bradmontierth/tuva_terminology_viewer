const rawPublicUrl = process.env.PUBLIC_URL || '';

function resolveApiBase() {
  const env = (process.env.REACT_APP_SEARCH_API_BASE_URL || '').trim();
  if (env) return env.replace(/\/$/, '');
  // Default to same origin
  if (typeof window !== 'undefined' && window.location) {
    return window.location.origin;
  }
  return '';
}

function buildUrl(base, path, params) {
  const origin = base || (typeof window !== 'undefined' ? window.location.origin : '');
  const cleanedPath = (() => {
    const p = String(path || '');
    return p.startsWith('/') ? p : `/${p}`;
  })();
  const url = new URL(cleanedPath, origin);
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export default class SearchApiClient {
  constructor(options = {}) {
    this.apiBase = (options.apiBase || resolveApiBase()).replace(/\/$/, '');
    this.datasetId = null;
    this.requestSeq = 0;
  }

  init({ datasetId }) {
    this.datasetId = datasetId || null;
    return Promise.resolve({
      datasetId,
      narrowColumns: [],
      rowCount: null,
      shardCount: 1,
    });
  }

  async _fetchJson(path, params) {
    const url = buildUrl(this.apiBase, path, params);
    const res = await fetch(url, { credentials: 'omit' });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${text || res.statusText}`);
    }
    // Be defensive: some misconfigurations return HTML (index.html) with 200 OK
    if (!contentType.toLowerCase().includes('json')) {
      const text = await res.text().catch(() => '');
      if (/^\s*</.test(text || '')) {
        throw new Error(
          'Received non-JSON (likely HTML) from API. Check REACT_APP_SEARCH_API_BASE_URL or CloudFront routing for /search, /count, /distinct.'
        );
      }
      try {
        return JSON.parse(text);
      } catch (_) {
        throw new Error('API returned a non-JSON payload.');
      }
    }
    return res.json();
  }

  /**
   * Fetch all result items for the current dataset/query/filters by paging the API.
   * Respects the server page cap (500) and an optional totalLimit.
   * Returns { total, items } where items is a flat array of objects.
   */
  async exportAll(query, { filters, totalLimit, onProgress } = {}) {
    const dataset = this.datasetId;
    if (!dataset) {
      throw new Error('Dataset not initialised');
    }
    // Determine total via /count first
    const countUrl = buildUrl(this.apiBase, '/count', {
      dataset,
      query: query || '',
      filters: Array.isArray(filters) && filters.length ? JSON.stringify(filters) : undefined,
    });
    const countRes = await fetch(countUrl, { credentials: 'omit' });
    if (!countRes.ok) {
      const txt = await countRes.text().catch(() => '');
      throw new Error(`API ${countRes.status}: ${txt || countRes.statusText}`);
    }
    const countJson = await countRes.json();
    const total = typeof countJson.total === 'number' ? countJson.total : 0;
    const target = typeof totalLimit === 'number' && totalLimit > 0 ? Math.min(totalLimit, total) : total;
    const items = [];
    const PAGE = 500; // server-enforced upper bound
    let offset = 0;
    while (offset < target) {
      const limit = Math.min(PAGE, target - offset);
      const data = await this._fetchJson('/search', {
        dataset,
        query: query || '',
        limit,
        offset,
        filters: Array.isArray(filters) && filters.length ? JSON.stringify(filters) : undefined,
      });
      const pageItems = Array.isArray(data.items) ? data.items : [];
      if (pageItems.length === 0) break;
      items.push(...pageItems);
      offset += pageItems.length;
      if (typeof onProgress === 'function') {
        try { onProgress({ fetched: offset, total: target || total }); } catch (_) { /* noop */ }
      }
      // Safety: if server returns fewer than requested but not zero, still continue until we reach target
      if (pageItems.length < limit && offset >= total) break;
    }
    return { total, items };
  }

  search(query, { onUpdate, limit, offset = 0, filters } = {}) {
    const requestId = ++this.requestSeq;
    const params = {
      dataset: this.datasetId,
      query: query || '',
      limit: typeof limit === 'number' ? limit : 50,
      offset,
      filters: Array.isArray(filters) && filters.length ? JSON.stringify(filters) : undefined,
    };
    const promise = this._fetchJson('/search', params).then((data) => {
      const payload = {
        type: 'results',
        partial: false,
        requestId,
        datasetId: this.datasetId,
        total: typeof data.total === 'number' ? data.total : 0,
        items: Array.isArray(data.items) ? data.items : [],
        elapsedMs: typeof data.elapsedMs === 'number' ? data.elapsedMs : null,
        bytesFetched: undefined,
      };
      if (typeof onUpdate === 'function') {
        try { onUpdate(payload); } catch (_) { /* noop */ }
      }
      return payload;
    });
    return { requestId, promise };
  }

  distinct(column, { requestId: forcedId, limit = 25, query, filters } = {}) {
    const requestId = forcedId || ++this.requestSeq;
    const params = {
      dataset: this.datasetId,
      column,
      limit,
      query: query || '',
      filters: Array.isArray(filters) && filters.length ? JSON.stringify(filters) : undefined,
    };
    const promise = this._fetchJson('/distinct', params).then((data) => ({
      type: 'distinct',
      requestId,
      datasetId: this.datasetId,
      column,
      items: Array.isArray(data.items) ? data.items : [],
      elapsedMs: typeof data.elapsedMs === 'number' ? data.elapsedMs : null,
    }));
    return { requestId, promise };
  }

  count(query, { requestId: forcedId, filters } = {}) {
    const requestId = forcedId || ++this.requestSeq;
    const params = {
      dataset: this.datasetId,
      query: query || '',
      filters: Array.isArray(filters) && filters.length ? JSON.stringify(filters) : undefined,
    };
    const promise = this._fetchJson('/count', params).then((data) => ({
      type: 'count',
      requestId,
      datasetId: this.datasetId,
      total: typeof data.total === 'number' ? data.total : 0,
      elapsedMs: typeof data.elapsedMs === 'number' ? data.elapsedMs : null,
      bytesFetched: undefined,
    }));
    return { requestId, promise };
  }

  clearCache() {}
  terminate() {}
}
