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
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${text || res.statusText}`);
    }
    return res.json();
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
