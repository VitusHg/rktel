const CACHE_NAME = "rktel-cache-v3";
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
// Bei langsamer Verbindung nach dieser Zeit auf den Offline-Stand ausweichen
const NETWORK_TIMEOUT_MS = 4000;

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

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    fetch(request).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  // Nur eigene App-Dateien cachen. Anfragen an andere Server (z. B. den
  // Dienstplan-Worker) und Anfragen mit Zugangsdaten gehen immer direkt ans
  // Netz – private Kalenderdaten landen nie im Service-Worker-Cache.
  if (new URL(request.url).origin !== self.location.origin) return;
  if (request.headers.has("Authorization")) return;

  // Netz zuerst (damit nach einem Update alle Dateien zusammenpassen),
  // offline oder bei Zeitüberschreitung der zuletzt gespeicherte Stand.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
      if (response && response.ok) await cache.put(request, response.clone());
      return response;
    } catch (err) {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === "navigate") {
        const index = await cache.match("./index.html");
        if (index) return index;
      }
      throw err;
    }
  })());
});
