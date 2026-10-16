// =====================================================
// MenuPro – Service Worker
// - L'app (HTML/CSS/JS) parte anche senza rete
// - Librerie dei CDN e font icone salvati in cache
// - I DATI non passano di qui: li gestisce offline.js (IndexedDB)
// =====================================================
const SHELL_CACHE = 'menupro-shell-v1';
const RUNTIME_CACHE = 'menupro-runtime-v1';
const KEEP = [SHELL_CACHE, RUNTIME_CACHE];

const SHELL = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './config.js',
  './offline.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

const FA_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css';
const CDN_LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const MAX_RUNTIME_ENTRIES = 150;

// ---------- install ----------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map((u) =>
      shell.add(new Request(u, { cache: 'reload' })).catch((e) => console.warn('[sw] shell skip', u, e && e.message))
    ));

    const rt = await caches.open(RUNTIME_CACHE);
    await Promise.all(CDN_LIBS.map((u) =>
      fetch(u, { mode: 'cors' }).then((r) => r.ok && rt.put(u, r)).catch(() => {})
    ));
    await precacheFontAwesome(rt).catch(() => {});
    await self.skipWaiting();
  })());
});

// Font Awesome: oltre al CSS servono i file dei font (woff2), altrimenti offline
// le icone sparirebbero.
async function precacheFontAwesome(cache) {
  const res = await fetch(FA_CSS, { mode: 'cors' });
  if (!res.ok) return;
  await cache.put(FA_CSS, res.clone());
  const css = await res.text();
  const urls = new Set();
  for (const m of css.matchAll(/url\(([^)]+)\)/g)) {
    const u = m[1].replace(/['"]/g, '').trim();
    if (u.includes('.woff2')) urls.add(new URL(u, FA_CSS).href);
  }
  await Promise.all([...urls].map((u) =>
    fetch(u, { mode: 'cors' }).then((r) => r.ok && cache.put(u, r)).catch(() => {})
  ));
}

// ---------- activate ----------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('menupro-') && !KEEP.includes(n))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// ---------- helpers ----------
function fetchWithTimeout(input, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const req = typeof input === 'string' ? input : input;
  return fetch(req, { signal: ctrl.signal, credentials: 'same-origin' })
    .finally(() => clearTimeout(t));
}

async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > max) {
    await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
  }
}

// Navigazioni: rete con timeout, altrimenti la pagina in cache
async function handleNavigate(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    if (self.navigator && self.navigator.onLine === false) throw new Error('offline');
    const res = await fetchWithTimeout(request.url, 4000);
    if (res && res.ok && !res.redirected) cache.put('./index.html', res.clone());
    return res;
  } catch (_) {
    return (await cache.match('./index.html')) ||
           (await cache.match('./')) ||
           new Response('Sei offline e l\'app non è ancora stata salvata. Apri il sito una volta con la connessione attiva.',
             { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

// File dell'app: rete (così i deploy arrivano da soli), altrimenti cache
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    if (self.navigator && self.navigator.onLine === false) throw new Error('offline');
    const res = await fetchWithTimeout(request, 4000);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

// Librerie CDN e font: dalla cache, aggiornate in background
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(request);
  const update = fetch(request).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  if (hit) { update.catch(() => {}); return hit; }
  const res = await update;
  return res || Response.error();
}

// Immagini (anche di altri domini): dalla cache se presenti
async function cacheFirstImage(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(request, res.clone()).then(() => trimCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES));
    }
    return res;
  } catch (e) {
    return Response.error();
  }
}

// ---------- fetch ----------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Dati e API: mai in cache qui (li gestisce offline.js)
  if (url.hostname.endsWith('.supabase.co')) return;
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(req));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  if (req.destination === 'image') {
    event.respondWith(cacheFirstImage(req));
  }
});

// ---------- sync in background ----------
// Il database locale vive nella pagina: il SW sveglia la pagina aperta e le chiede di sincronizzare.
self.addEventListener('sync', (event) => {
  if (event.tag !== 'menupro-sync') return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!clients.length) throw new Error('nessuna pagina aperta: riprova più tardi');
    clients.forEach((c) => c.postMessage({ type: 'SYNC' }));
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
