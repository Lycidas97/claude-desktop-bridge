const CACHE = "bridge-shell-v3";
const SHELL = ["/", "/manifest.webmanifest", "/bridge-mark.svg"];

self.addEventListener("install", (event) => {
  if (self.location.hostname === "localhost") {
    self.skipWaiting();
    return;
  }
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  if (self.location.hostname === "localhost") {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .then(() => self.registration.unregister()),
    );
    self.clients.claim();
    return;
  }
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (self.location.hostname === "localhost" || event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((response) => response ?? caches.match("/"))),
  );
});
