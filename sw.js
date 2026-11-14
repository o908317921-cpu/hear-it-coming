// 離線快取：戶外常沒有網路，網頁檔案與 ONNX Runtime 存在手機裡，斷網也能重新開啟。
// 模型檔由 js/ort.js 自己快取，這裡不重複存；自己的檔案優先用網路，改版後才拿得到新版。
const CACHE = "blindnav-shell-v12";
const ORT = "vendor/ort/";
// 第一次開啟時這些檔案在 service worker 接管前就下載過了，不會經過下面的快取，要在安裝時自己存一份
const PRECACHE = [
  "./", "index.html", "settings.json", "manifest.webmanifest", "icon.svg", "tests/bus.png",
  ...["alerts", "analysis", "app", "audio", "canvas", "config", "depth", "depth-worker", "detector", "motion", "ort", "overlay", "qr", "tracker", "yolo"]
    .map(name => `js/${name}.js`),
  // .wasm 跟模型一樣由 js/ort.js 下載與快取
  `${ORT}ort.webgpu.min.mjs`, `${ORT}ort-wasm-simd-threaded.jsep.mjs`, `${ORT}ort.wasm.min.mjs`, `${ORT}ort-wasm-simd-threaded.mjs`,
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 個別失敗（例如網路不穩）不影響安裝，用到時再存一次；舊版快取裡有的先拿來用，
    // 啟用時會刪掉舊快取，不能讓一次更新失敗就失去離線能力
    const results = await Promise.allSettled(PRECACHE.map(url => cache.add(url)));
    await Promise.allSettled(PRECACHE.map(async (url, i) => {
      if (results[i].status === "fulfilled") return;
      const older = await caches.match(url);
      if (older) await cache.put(url, older);
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("blindnav-shell-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// GitHub Pages 不能設定回應標頭：由這裡補上跨來源隔離，WASM 才能用多執行緒（沒有顯示晶片加速的手機快約 3 倍）
function isolated(response) {
  if (!response || response.status === 0 || response.type === "opaque") return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname.endsWith(".onnx") || url.pathname.endsWith(".wasm") || !url.protocol.startsWith("http")) return;
  const sameOrigin = url.origin === self.location.origin;
  event.respondWith((async () => {
    const respond = await (async () => {
    const cache = await caches.open(CACHE);
    if (!sameOrigin) {              // CDN 上的 ONNX Runtime 版本固定，快取優先
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    const network = fetch(request).then(async response => {
      if (response.status === 200 || response.type === "opaque") {
        // 空間不足存不進去，也不能讓已經成功的下載變成失敗
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    });
    const hit = await cache.match(request);
    if (!hit) return network;
    // 訊號很弱時連線不會馬上失敗：快取裡有就最多等 2.5 秒，網路回來的新版留到下一次
    network.catch(() => {});
    // 網站暫時回錯誤（404、503）時也用存好的版本，不能把錯誤頁給使用者
    return Promise.race([network.then(r => (r.ok ? r : hit), () => hit), new Promise(ok => setTimeout(() => ok(hit), 2500))]);
    })();
    return sameOrigin ? isolated(respond) : respond;
  })());
});
