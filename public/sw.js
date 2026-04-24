// The CACHE_NAME below holds a build-time placeholder that the Vite plugin
// in `vite.config.ts` replaces with `wildbloom-<pkgVersion>-<buildTimestamp>`
// on every production build. Guarantees the `sw.js` bytes change on every
// deploy, which triggers the browser's SW update detection and rotates the
// cache so stale assets get evicted.
//
// In dev (vite dev server) the token may remain literal; SW registration
// silently fails in dev anyway, so there's no user impact.
const CACHE_NAME = '__SW_VERSION__';
const PRECACHE = [
  '/',
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

// --- Web Push ---

self.addEventListener('push', (e) => {
  if (!e.data) return;

  // Always show the notification — the `tag` field deduplicates naturally.
  // Skipping when focused violates `userVisibleOnly` and causes mobile browsers
  // to throttle or revoke the push subscription.
  let data;
  try { data = e.data.json(); } catch { data = { title: 'Wildbloom', body: e.data.text() }; }

  const options = {
    body: data.body || '',
    icon: data.icon || '/icons/icon.png',
    tag: data.tag || 'reminder',
    data: { url: data.url || '/', type: data.type || 'reminder', blockId: data.blockId || null },
  };

  // Add action buttons for block-complete notifications
  if (data.type === 'block-complete' && data.blockId) {
    options.actions = [
      { action: 'complete', title: 'Done!' },
      { action: 'skip', title: 'Not today' },
    ];
  }

  e.waitUntil(self.registration.showNotification(data.title || 'Wildbloom', options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  const type = e.notification.data?.type || 'reminder';
  const blockId = e.notification.data?.blockId || null;
  const action = e.action; // 'complete', 'skip', or '' (body click)

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Try to find an existing app window
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          // Quick-complete / skip from notification action button
          if (action === 'complete' && blockId) {
            client.postMessage({ type: 'QUICK_COMPLETE', blockId });
          } else if (action === 'skip' && blockId) {
            client.postMessage({ type: 'QUICK_SKIP', blockId });
          } else if (type === 'energy-checkin') {
            client.postMessage({ type: 'ENERGY_CHECKIN' });
          } else if (type === 'pomo-complete') {
            client.postMessage({ type: 'POMO_COMPLETE' });
          } else if (type === 'daily-review') {
            client.postMessage({ type: 'DAILY_REVIEW' });
          } else if (type === 'block-complete' && blockId) {
            // Body click on a block-complete notification
            client.postMessage({ type: 'QUICK_COMPLETE', blockId });
          } else if (type === 'block-start') {
            client.postMessage({ type: 'DAILY_REVIEW' });
          }
          return client.focus();
        }
      }

      // No window open — open app with action query param if applicable
      if (blockId && (action === 'complete' || type === 'block-complete')) {
        return clients.openWindow('/?action=complete-block&blockId=' + blockId);
      }
      if (blockId && action === 'skip') {
        return clients.openWindow('/?action=skip-block&blockId=' + blockId);
      }
      return clients.openWindow(url);
    })
  );
});

// --- Fetch ---

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
