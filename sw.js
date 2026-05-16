/**
 * MAK BOX POS — Service Worker v2.0
 * Strategies:
 *   - Static assets (fonts, SW itself)  → Cache First
 *   - Menu API                          → Stale-While-Revalidate (5 min TTL)
 *   - Order API (POST/PUT)              → Network Only (never cache mutations)
 *   - HTML shells                       → Cache First + background update
 *   - Socket.IO                         → Network Only (always)
 */

const CACHE_VERSION   = 'makbox-v2.0.0';
const STATIC_CACHE    = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE   = `${CACHE_VERSION}-dynamic`;
const MENU_CACHE      = `${CACHE_VERSION}-menu`;
const MENU_TTL_MS     = 5 * 60 * 1000; // 5 minutes

// Static assets to pre-cache on install
const PRECACHE_URLS = [
  '/customer/',
  '/staff/',
  '/kitchen/',
  '/manager/',
  '/pwa/offline.html',
  // Google Fonts (cached at runtime via dynamic cache)
];

// ─── INSTALL ─────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Installing', CACHE_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS).catch(err => {
        // Non-fatal: offline install is fine, pages will be cached on first visit
        console.warn('[SW] Pre-cache partial fail:', err.message);
      }))
      .then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE ────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating', CACHE_VERSION);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith('makbox-') && !key.startsWith(CACHE_VERSION))
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim())
  );
});

// ─── FETCH ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Never intercept Socket.IO WebSocket / polling
  if (url.pathname.startsWith('/socket.io')) {
    return; // fall through to network
  }

  // 2. Never cache POST/PUT/DELETE mutations
  if (request.method !== 'GET') {
    event.respondWith(networkOnly(request));
    return;
  }

  // 3. Menu API — Stale-While-Revalidate with TTL
  if (url.pathname === '/api/menu') {
    event.respondWith(menuStrategy(request));
    return;
  }

  // 4. Other API calls — Network First (fresh data), fallback to cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, DYNAMIC_CACHE, 4000));
    return;
  }

  // 5. Google Fonts / CDN assets — Cache First (long-lived)
  if (
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('cdn.socket.io')
  ) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // 6. App HTML shells and local assets — Cache First, update in background
  event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
});

// ─── STRATEGIES ──────────────────────────────────────────────────────────────

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(JSON.stringify({ error: 'No network connection' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return caches.match('/pwa/offline.html') || new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || await fetchPromise || caches.match('/pwa/offline.html');
}

async function networkFirst(request, cacheName, timeoutMs = 5000) {
  const cache = await caches.open(cacheName);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response(JSON.stringify({ error: 'Offline — cached data unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function menuStrategy(request) {
  const cache  = await caches.open(MENU_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    // Check TTL from custom header we inject on cache put
    const cachedAt = cached.headers.get('sw-cached-at');
    const age = cachedAt ? Date.now() - parseInt(cachedAt) : Infinity;

    if (age < MENU_TTL_MS) {
      // Fresh enough — return from cache and revalidate silently
      fetch(request).then(r => {
        if (r.ok) putWithTimestamp(cache, request, r);
      }).catch(() => {});
      return cached;
    }
  }

  // Stale or no cache — fetch fresh
  try {
    const response = await fetch(request);
    if (response.ok) await putWithTimestamp(cache, request, response.clone());
    return response;
  } catch {
    return cached || new Response('{}', { status: 503 });
  }
}

async function putWithTimestamp(cache, request, response) {
  // Inject timestamp header so we can check TTL
  const headers = new Headers(response.headers);
  headers.set('sw-cached-at', String(Date.now()));
  const body = await response.arrayBuffer();
  const modified = new Response(body, { status: response.status, statusText: response.statusText, headers });
  await cache.put(request, modified);
}

// ─── PUSH NOTIFICATIONS ──────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  const title   = data.title   || 'MAK BOX';
  const options = {
    body:    data.body    || 'Yeni bildirim',
    icon:    '/pwa/icons/icon-192.png',
    badge:   '/pwa/icons/icon-96.png',
    vibrate: [200, 100, 200],
    data:    { url: data.url || '/' },
    actions: data.actions || [],
    tag:     data.tag || 'makbox-notification',
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (const client of clientList) {
          if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
        }
        return clients.openWindow(targetUrl);
      })
  );
});

// ─── BACKGROUND SYNC (order retry) ───────────────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'retry-order') {
    event.waitUntil(retryPendingOrders());
  }
});

async function retryPendingOrders() {
  // Read pending orders from IndexedDB (set by customer tablet when offline)
  // Implementation: customer tablet stores failed orders in IDB under key 'pending-orders'
  try {
    const db = await openIDB();
    const tx = db.transaction('pending', 'readwrite');
    const store = tx.objectStore('pending');
    const orders = await idbGetAll(store);
    for (const order of orders) {
      try {
        const r = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(order.data),
        });
        if (r.ok) await idbDelete(store, order.id);
      } catch { /* leave for next sync */ }
    }
  } catch(e) {
    console.warn('[SW] Background sync failed:', e.message);
  }
}

function openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('makbox-offline', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('pending', { keyPath: 'id' });
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
function idbGetAll(store) { return new Promise((res, rej) => { const r = store.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function idbDelete(store, id) { return new Promise((res, rej) => { const r = store.delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
