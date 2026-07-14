// sw.js — network-first for data/HTML (fresh rankings win), cache fallback for offline.
const CACHE = "huskies-draft-v3";
const ASSETS = [
  "./", "./index.html", "./css/styles.css",
  "./js/app.js", "./js/data.js", "./js/scoring.js", "./js/value.js",
  "./js/draft.js", "./js/intel.js", "./js/storage.js",
  "./data/league.json", "./data/players.json", "./data/intel-lexicon.json",
  "./manifest.json", "./icons/icon.svg"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
  );
});
