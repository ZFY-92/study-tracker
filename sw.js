const APP_VERSION = '52';
const CACHE_NAME = `learning-progress-v${APP_VERSION}`;
const ASSETS = [
  './',
  './index.html',
  `./app.js?v=${APP_VERSION}`,
  `./sync.js?v=${APP_VERSION}`,
  `./supabase-config.js?v=${APP_VERSION}`,
  `./styles.css?v=${APP_VERSION}`,
  './manifest.json',
  './icons/icon.svg',
  `./sw.js?v=${APP_VERSION}`,
];

function isAppShell(url) {
  return (
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('/')
  );
}

function normalizeAppShellRequest(request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/app.js')) {
    return `./app.js?v=${APP_VERSION}`;
  }
  if (url.pathname.endsWith('/sync.js')) {
    return `./sync.js?v=${APP_VERSION}`;
  }
  if (url.pathname.endsWith('/supabase-config.js')) {
    return `./supabase-config.js?v=${APP_VERSION}`;
  }
  if (url.pathname.endsWith('/styles.css')) {
    return `./styles.css?v=${APP_VERSION}`;
  }
  if (url.pathname.endsWith('/sw.js')) {
    return `./sw.js?v=${APP_VERSION}`;
  }
  if (url.pathname.endsWith('/index.html') || url.pathname.endsWith('/')) {
    return './index.html';
  }
  return request.url;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (!url.origin.startsWith(self.location.origin)) return;

  if (isAppShell(url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            const cacheKey = normalizeAppShellRequest(event.request);
            caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, clone));
          }
          return response;
        })
        .catch(() => caches.match(normalizeAppShellRequest(event.request)).then((cached) => cached || caches.match(event.request)))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
    )
  );
});
