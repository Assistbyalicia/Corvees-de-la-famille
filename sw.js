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

// Notifications push : envoyées sans contenu (voir n8n), donc le titre/texte
// affiché est générique ici plutôt que de dépendre d'un payload chiffré.
self.addEventListener("push", event => {
  const title = "🏰 Carnet de quêtes";
  const options = {
    body: "Nouveauté dans l'appli — viens jeter un œil !",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png"
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientsArr => {
      const existing = clientsArr.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow("index.html");
    })
  );
});
