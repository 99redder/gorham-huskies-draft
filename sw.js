// sw.js — network-first for data/HTML (fresh rankings win), cache fallback for offline.
const CACHE = "huskies-draft-v11";
const ASSETS = [
  "./", "./index.html", "./css/styles.css",
  "./js/app.js", "./js/data.js", "./js/scoring.js", "./js/value.js",
  "./js/draft.js", "./js/intel.js", "./js/injuries.js", "./js/storage.js", "./js/simulator.js",
  "./data/intel-seed.json",
  "./data/league.json", "./data/players.json", "./data/rankings.json", "./data/intel-lexicon.json",
  "./manifest.json", "./icons/icon.svg"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Always fetch fresh from the network when online (cache: no-store bypasses the
// browser HTTP cache, so JS modules and JSON data are never stale on draft day),
// keep a copy in our own cache, and fall back to that copy only when offline.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // don't touch cross-origin
  e.respondWith(
    fetch(url.pathname + url.search, { cache: "no-store" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
  );
});
