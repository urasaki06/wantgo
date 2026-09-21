// みちくさ Service Worker
// ・ホーム画面に置いたアプリとして動かすために必要
// ・電波が弱い場所でも、最後に開いた画面は表示できるようにする
// 画面（index.html）は「まずネット、だめなら保存分」。古い画面が残り続けないようにするため。
// /api/ は保存しない（ピンの同期や座標取得は常に最新が必要）。
const CACHE = "michikusa-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;       // Google などは素通し
  if (url.pathname.startsWith("/api/")) return;       // 同期・座標は常にネット

  if (req.mode === "navigate") {
    // 共有メニューからの ?text=... もここに来る。画面は同じ index.html。
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
