/* NCS Flow service worker: app-shell cache (fast start / offline shell) + push notifications.
 * It never touches Firebase traffic (database, auth, messaging), Apps Script, or any non-GET request,
 * so data reads/writes always go live to Firebase. No keys or secrets live here. */
const VERSION = 'ff-v1';
const SHELL = VERSION + '-shell';
const LIBS = VERSION + '-libs';
const SHELL_FILES = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
// Versioned CDN files only (the URL changes when the version changes, so cache-first is safe)
const LIB_HOSTS = /^https:\/\/(cdnjs\.cloudflare\.com\/ajax\/libs\/|www\.gstatic\.com\/firebasejs\/\d|fonts\.gstatic\.com\/|fonts\.googleapis\.com\/css)/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  const sameOrigin = url.startsWith(self.location.origin);
  // 1) The page itself: always try the network first (so a new deploy shows at once), fall back to the cached copy offline
  if (req.mode === 'navigate' && sameOrigin) {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put('./', copy)); }
      return res;
    }).catch(() => caches.match('./').then(r => r || caches.match(req))));
    return;
  }
  // 2) React / Babel / Firebase SDK / fonts: cache first (versioned URLs)
  if (LIB_HOSTS.test(url)) {
    e.respondWith(caches.open(LIBS).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  // 3) Our own icons / manifest: cache, refresh in the background
  if (sameOrigin && /\/(icons\/[\w-]+\.png|manifest\.webmanifest)$/.test(new URL(url).pathname)) {
    e.respondWith(caches.open(SHELL).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
  }
  // Everything else (Firebase, Apps Script, …) goes straight to the network.
});

// ── Push notifications (sent by the Apps Script through Firebase Cloud Messaging) ──
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { data: { body: e.data && e.data.text() } }; }
  const m = d.data || {}; const n = d.notification || {};
  const title = String(m.title || n.title || 'NCS Flow').slice(0, 120);
  const opts = {
    body: String(m.body || n.body || '').slice(0, 240),
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    tag: m.tag || undefined, renotify: !!m.tag,
    data: { url: m.url || './', taskId: m.taskId || '' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  const target = new URL(d.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
        if (d.taskId) c.postMessage({ type: 'ff-open-task', taskId: d.taskId });
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
