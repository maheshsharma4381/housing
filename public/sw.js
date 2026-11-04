/* Sahvaas service worker (Phase 3A): pushes carry no payload, so the lock screen never shows amounts or names.
   The inbox in the app has the details. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('Sahvaas', {
    body: 'You have a new message',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'sahvaas',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => 'focus' in c);
    if (open) return open.focus();
    return self.clients.openWindow('/');
  })());
});
