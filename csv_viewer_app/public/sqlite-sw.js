const CACHE_NAME = 'sqlite-pages-v1';

const shouldHandleRequest = (request) => {
  if (request.method !== 'GET') {
    return false;
  }
  const { pathname } = new URL(request.url);
  return pathname.endsWith('.sqlite') || pathname.endsWith('.wasm');
};

const cacheKeyForRequest = (request) => {
  const range = request.headers.get('range');
  if (!range) {
    return request.url;
  }
  return `${request.url}::${range}`;
};

const fetchAndCache = async (event) => {
  const { request } = event;
  const cacheKey = cacheKeyForRequest(request);
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(cacheKey);

  const networkPromise = fetch(request.clone())
    .then((response) => {
      if (response && response.ok && !request.headers.has('range') && response.status !== 206) {
        const responseClone = response.clone();
        event.waitUntil(cache.put(cacheKey, responseClone));
      }
      return response;
    })
    .catch((error) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      throw error;
    });

  return cachedResponse || networkPromise;
};

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear-cache') {
    event.waitUntil(caches.delete(CACHE_NAME));
  }
});

self.addEventListener('fetch', (event) => {
  if (!shouldHandleRequest(event.request)) {
    return;
  }
  event.respondWith(fetchAndCache(event));
});
