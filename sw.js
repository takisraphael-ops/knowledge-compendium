const CACHE = "kc-app-v9";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./css/app.css",
  "./assets/fonts/inter-latin.woff2",
  "./assets/fonts/newsreader-latin.woff2",
  "./assets/fonts/jetbrains-mono-latin.woff2",
  "./js/main.js",
  "./js/model.js",
  "./js/search.js",
  "./js/notes.js",
  "./js/crypto.js",
  "./js/layout.js",
  "./js/route.js",
  "./js/cards.js",
  "./js/revise.js",
  "./js/schedule.js",
  "./js/progress.js",
  "./js/gist-sync.js",
  "./js/pbq.js",
  "./js/lenses.js",
  "./js/readiness.js",
  "./js/backlinks.js",
  "./js/glossary.js",
  "./js/abbr.js",
  "./data/index.json",
  "./data/redirects.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin === "https://api.github.com") return;
  if (req.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
