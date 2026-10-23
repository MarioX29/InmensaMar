// Core 0.7A: Service Worker for future Web Push support.
// No fetch handler: sales, inventory and authentication are never cached here.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Web Push receiver: the remote sender and subscriptions are configured separately.
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = typeof payload.title === 'string' ? payload.title.slice(0, 90) : 'Inmensa Mar';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 200) : 'Tenés una actualización.';
  // Restrict navigation to the application origin.
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') && !payload.url.startsWith('//') ? payload.url : '/';
  event.waitUntil(self.registration.showNotification(title, {body, icon:'/icon-192.png', data:{url}}));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.url || '/';
  event.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(async (windows) => {
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(path);
  }));
});
