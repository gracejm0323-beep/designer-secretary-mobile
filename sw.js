const CACHE = "designer-secretary-mobile-v5";
const ASSETS = ["./", "./index.html", "./mobile.css", "./mobile.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener("fetch", event => {
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
