/* Howler : Pulse service worker — PUSH ONLY.
   Deliberately caches NOTHING: the app always loads fresh from the network, so
   this never causes stale-deploy issues. It only turns push messages into
   notifications, renders any action buttons, and routes clicks. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Howler : Pulse';
  const options = {
    body: data.body || '',
    icon: data.icon || '/logo.png',
    badge: '/logo.png',
    image: data.image || undefined,                 // big hero (Android/desktop)
    tag: data.tag || undefined,
    renotify: !!data.tag,
    requireInteraction: !!data.requireInteraction,
    actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : undefined, // buttons (Android/desktop)
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

async function openApp(url) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of wins) {
    if ('focus' in c) { try { await c.navigate(url); } catch { /* cross-origin guard */ } return c.focus(); }
  }
  if (self.clients.openWindow) return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action || '';
  const url = (event.notification.data && event.notification.data.url) || '/';

  // Acknowledge a must-ack thread straight from the notification.
  if (action.startsWith('ack:')) {
    const id = action.slice(4);
    event.waitUntil((async () => {
      try {
        const r = await fetch(`/api/os/threads/${id}/ack`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (r.ok) {
          await self.registration.showNotification('Acknowledged ✓', { body: 'Thanks — Howler has been notified.', icon: '/logo.png', badge: '/logo.png' });
        } else { await openApp(url); }
      } catch { await openApp(url); }
    })());
    return;
  }

  // Approve a campaign straight from the notification (no app open needed).
  // The fetch carries the session cookie (same-origin). Falls back to opening
  // the app if the call fails.
  if (action.startsWith('approve:')) {
    const [, entityId, id] = action.split(':');
    event.waitUntil((async () => {
      try {
        const r = await fetch(`/api/actions/${entityId}/${id}/approve`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        await self.registration.showNotification(r.ok ? 'Campaign approved ✓' : 'Couldn’t approve', {
          body: r.ok ? 'It’s sending now.' : 'Open Pulse to approve it.', icon: '/logo.png', badge: '/logo.png',
        });
        if (!r.ok) await openApp(url);
      } catch {
        await self.registration.showNotification('Couldn’t approve', { body: 'Open Pulse to approve it.', icon: '/logo.png', badge: '/logo.png' });
        await openApp(url);
      }
    })());
    return;
  }

  // Default tap or "Review" button → open the app at the deep link.
  event.waitUntil(openApp(url));
});
