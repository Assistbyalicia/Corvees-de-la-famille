// Service worker minimal : rend l'appli installable et lui permet de charger
// (au moins l'interface) hors-ligne. Ne touche PAS aux appels vers n8n/Notion
// (autre origine) : ceux-là restent gérés par la logique offline de shared.js.
//
// Stratégie "réseau d'abord" : tant qu'il y a du réseau, on sert toujours la
// version fraîche (jamais de version périmée qui traîne) ; le cache ne sert
// que de secours si le réseau est indisponible.
const CACHE_NAME = "carnet-de-quetes-v1";
const APP_SHELL = [
  "index.html",
  "kids.html",
  "adults.html",
  "shared.css",
  "shared.js",
  "manifest.json"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
