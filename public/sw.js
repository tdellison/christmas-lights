// Makes the page installable as an app. Always goes to the network (the show
// is live, nothing is worth serving stale); the cached page is only a fallback
// so the app opens with a "reconnecting" screen if the server is down.
const CACHE = 'xmas-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/icons/icon-192.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).pathname.startsWith('/api/')) return;
  e.respondWith(fetch(r).then((res) => {
    if (res.ok && (r.mode === 'navigate')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)); }
    return res;
  }).catch(() => caches.match(r.mode === 'navigate' ? '/' : r)));
});
