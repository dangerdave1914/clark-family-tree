// Clark Family Tree — service worker.
// Lets phones install the tree as a home-screen app. It never stores family data:
// pages always come fresh from the network, and only a small "you're offline" page is kept.
const CACHE = 'clark-shell-v1';
const OFFLINE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clark Family Tree</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:19px/1.5 system-ui,sans-serif;background:#f3efe0;color:#2f362b;text-align:center;padding:24px"><div><img src="/icons/icon-192.png" width="96" height="96" style="border-radius:22px" alt=""><h1 style="font:500 30px Georgia,serif;margin:16px 0 6px">No connection</h1><p>The family tree needs the internet.<br>Check your signal and try again.</p><button onclick="location.reload()" style="font:600 19px system-ui;padding:14px 24px;border-radius:14px;border:0;background:#4f6b52;color:#fff">Try again</button></div>';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.add('/icons/icon-192.png'))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).catch(() => new Response(OFFLINE, { headers: { 'content-type': 'text/html; charset=utf-8' } })));
    return;
  }
  if (new URL(r.url).pathname === '/icons/icon-192.png') e.respondWith(caches.match(r).then(m => m || fetch(r)));
});
