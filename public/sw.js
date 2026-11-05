/* Sahvaas service worker.
   - Push (Phase 3A): pushes carry no payload, so the lock screen never shows amounts or names.
   - Offline (Phase 7): a page load that fails offline gets /offline.html. Nothing else is cached:
     API calls, Supabase and other sites always go to the network (src/lib/sw-policy.ts is the same rule). */
const OFFLINE = '/offline.html';
const CACHE = 'sahvaas-offline-v1';

self.addEventListener('install', (event) => {
  // the offline page is a nice-to-have: failing to cache it must not stop the worker (push needs it)
  event.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('sahvaas-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE)) || Response.error()));
});

self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('Sahvaas', {
    body: 'You have a new message',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'sahvaas',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => 'focus' in c);
    if (open) return open.focus();
    return self.clients.openWindow('/login');
  })());
});
