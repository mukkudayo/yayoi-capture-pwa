// アプリシェルのみをキャッシュするシンプルなService Worker。
// /api/upload はキャッシュ対象外（常にネットワーク経由）。
const CACHE_NAME = "yayoi-capture-shell-v6";
const APP_SHELL = [
  "/",
  "/app.js",
  "/manifest.json",
  "/icon.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return; // API呼び出しはキャッシュしない

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
