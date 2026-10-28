const CACHE_NAME = "rktel-cache-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./dienstplan.js",
  "./vendor/ical.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  // Nur eigene App-Dateien cachen. Anfragen an andere Server (z. B. den
  // Dienstplan-Worker) und Anfragen mit Zugangsdaten gehen immer direkt ans
  // Netz – private Kalenderdaten landen nie im Service-Worker-Cache.
  if (new URL(request.url).origin !== self.location.origin) return;
  if (request.headers.has("Authorization")) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
