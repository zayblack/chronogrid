/* ChronoGrid service worker — offline app shell.
   Bump CACHE_NAME whenever a cached file changes so returning users get the update. */
const CACHE_NAME = "chronogrid-v4";

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./sync.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network first for every shell file so HTML/CSS/JS never load from different
  // versions after a deploy. Fall back to the cache when offline or on a bad
  // response; navigation always falls back to the cached HTML.
  const fromCache = () => request.mode === "navigate"
    ? caches.match("./index.html")
    : caches.match(request);

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (!response.ok) return fromCache();
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(fromCache)
  );
});
