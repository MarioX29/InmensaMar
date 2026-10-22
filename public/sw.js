// Core 0.7A: Service Worker for future Web Push support.
// No fetch handler: sales, inventory and authentication are never cached here.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
