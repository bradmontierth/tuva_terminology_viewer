const rawPublicUrl = process.env.PUBLIC_URL || '';
const publicUrl = rawPublicUrl.replace(/\/$/, '');

const ensureLeadingSlash = (value = '') => (value.startsWith('/') ? value : `/${value}`);

function resolvePublicPath() {
  const fallback = publicUrl;
  if (!fallback) {
    return '';
  }
  try {
    const base = typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost';
    const absolute = new URL(fallback, base);
    return absolute.pathname.replace(/\/$/, '');
  } catch (error) {
    if (fallback.startsWith('/')) {
      return fallback.replace(/\/$/, '');
    }
    return ensureLeadingSlash(fallback.replace(/\/$/, ''));
  }
}

const publicPath = resolvePublicPath();

function resolveWorkerUrl() {
  if (typeof window === 'undefined' || !window.location) {
    return `${publicPath || ''}/workers/searchWorker.js`;
  }
  const path = `${publicPath || ''}/workers/searchWorker.js`.replace(/\/+/, '/');
  return new URL(path, window.location.origin).toString();
}

function resolveAssetBase() {
  if (typeof window === 'undefined' || !window.location) {
    return `${publicPath || ''}/`;
  }
  return `${window.location.origin}${publicPath}`.replace(/\/$/, '') + '/';
}

const DEFAULT_ASSET_BASE = resolveAssetBase();

export default class SearchWorkerClient {
  constructor(options = {}) {
    const workerHref = resolveWorkerUrl();

    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log('[search-worker] worker url', workerHref);
      fetch(workerHref, { method: 'HEAD' })
        .then((response) => {
          // eslint-disable-next-line no-console
          console.log('[search-worker] worker HEAD', response.status, response.statusText, response.headers.get('content-type'));
        })
        .catch((error) => {
          // eslint-disable-next-line no-console
          console.error('[search-worker] worker HEAD failed', error);
        });
      fetch(workerHref)
        .then((response) => response.text().then((body) => ({ response, body })))
        .then(({ response, body }) => {
          // eslint-disable-next-line no-console
          console.log('[search-worker] worker GET', response.status, response.headers.get('content-type'), body.slice(0, 120));
        })
        .catch((error) => {
          // eslint-disable-next-line no-console
          console.error('[search-worker] worker GET failed', error);
        });
    }
    this.worker = new Worker(workerHref);
    this.pendingInit = null;
    this.requestSeq = 0;
    this.pendingRequests = new Map();
    this.listeners = new Set();
    this.assetBaseUrl = options.assetBaseUrl || DEFAULT_ASSET_BASE;
    this.datasetId = null;
    this.readyPromise = Promise.resolve();
    this.resolveReady = null;
    this.rejectReady = null;
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log('[search-worker] client asset base:', this.assetBaseUrl);
    }
    this.onCacheCleared = options.onCacheCleared || null;
    this.worker.addEventListener('error', (event) => {
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.error(
          '[search-worker] worker error',
          event?.message,
          event?.filename,
          event?.lineno,
          event?.colno,
          event?.error,
        );
      }
    });
    this.worker.addEventListener('messageerror', (event) => {
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.error('[search-worker] message error', event?.data || event);
      }
    });
    this.worker.addEventListener('message', (event) => {
      const { data } = event;
      if (!data || !data.type) {
        return;
      }
      switch (data.type) {
        case 'ready':
          if (this.pendingInit) {
            this.pendingInit.resolve(data.manifest);
            this.pendingInit = null;
          }
          if (this.resolveReady) {
            this.resolveReady();
            this.resolveReady = null;
            this.rejectReady = null;
          }
          break;
        case 'distinct': {
          const request = this.pendingRequests.get(data.requestId);
          if (request) {
            this.pendingRequests.delete(data.requestId);
            request.resolve(data);
          }
          break;
        }
        case 'results': {
          const request = this.pendingRequests.get(data.requestId);
          if (!request) {
            return;
          }
          if (request.onUpdate) {
            request.onUpdate(data);
          }
          if (!data.partial) {
            this.pendingRequests.delete(data.requestId);
            request.resolve(data);
          }
          break;
        }
        case 'error': {
          if (data.requestId) {
            const request = this.pendingRequests.get(data.requestId);
            if (request) {
              this.pendingRequests.delete(data.requestId);
              request.reject(new Error(data.error || 'Worker error'));
            }
          } else {
            if (this.pendingInit) {
              this.pendingInit.reject(new Error(data.error || 'Worker init failed'));
              this.pendingInit = null;
            }
            if (this.rejectReady) {
              this.rejectReady(new Error(data.error || 'Worker init failed'));
              this.resolveReady = null;
              this.rejectReady = null;
            }
          }
          break;
        }
        case 'cacheCleared':
          if (typeof this.onCacheCleared === 'function') {
            this.onCacheCleared();
          }
          break;
        case 'log':
          if (process.env.NODE_ENV !== 'production') {
            // eslint-disable-next-line no-console
            console[data.level === 'warn' ? 'warn' : 'log']('[search-worker]', data.message);
          }
          break;
        default:
          break;
      }
    });
  }

  init({ datasetId, manifestUrl, manifest, bytesBudget }) {
    if (this.pendingInit) {
      this.pendingInit.reject(new Error('Initialisation superseded by a new request'));
      this.pendingInit = null;
    }
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.datasetId = datasetId || null;
    return new Promise((resolve, reject) => {
      this.pendingInit = { resolve, reject };
      this.worker.postMessage({
        type: 'init',
        datasetId,
        manifestUrl,
        manifest,
        assetBaseUrl: this.assetBaseUrl,
        bytesBudget,
      });
    });
  }

  search(query, { onUpdate, limit, filters } = {}) {
    const requestId = ++this.requestSeq;
    const promise = new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject, onUpdate });
    });
    this.readyPromise
      .then(() => {
        if (!this.pendingRequests.has(requestId)) {
          return;
        }
        this.worker.postMessage({
          type: 'search',
          requestId,
          query,
          limit,
          filters,
          datasetId: this.datasetId,
        });
      })
      .catch((error) => {
        const request = this.pendingRequests.get(requestId);
        if (!request) {
          return;
        }
        this.pendingRequests.delete(requestId);
        request.reject(error);
      });
    return { requestId, promise };
  }

  distinct(column, { requestId: forcedId, limit = 25, query, filters } = {}) {
    const requestId = forcedId || ++this.requestSeq;
    const promise = new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject, onUpdate: null });
    });
    this.readyPromise
      .then(() => {
        if (!this.pendingRequests.has(requestId)) {
          return;
        }
        this.worker.postMessage({
          type: 'distinct',
          requestId,
          datasetId: this.datasetId,
          column,
          limit,
          query,
          filters,
        });
      })
      .catch((error) => {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          this.pendingRequests.delete(requestId);
          pending.reject(error);
        }
      });
    return { requestId, promise };
  }

  clearCache() {
    this.worker.postMessage({ type: 'clear-cache' });
  }

  terminate() {
    this.worker.terminate();
    this.pendingRequests.clear();
    this.pendingInit = null;
    this.readyPromise = Promise.resolve();
    this.resolveReady = null;
    this.rejectReady = null;
  }
}
