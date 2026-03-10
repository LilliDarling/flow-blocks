const CACHE_NAME = 'flowblocks-v3';
const PRECACHE = [
  '/',
  '/css/base.css',
  '/css/layout.css',
  '/css/timeline.css',
  '/css/week.css',
  '/css/pomodoro.css',
  '/css/modal.css',
  '/css/tips.css',
  '/css/auth.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  // Don't skipWaiting automatically — let the app control when to activate
  // so the user sees the "Update available" toast first
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Listen for skip-waiting message from the app's update toast
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Always go to network for API calls and OAuth
  if (url.hostname.includes('supabase')) return;
  if (url.pathname.startsWith('/auth/')) return;
  if (url.hostname.includes('googleapis.com')) return;

  // Network-first for everything — fall back to cache when offline
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
