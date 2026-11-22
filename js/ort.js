// ONNX Runtime Web：在瀏覽器裡執行 YOLO 與深度模型。
// 有 WebGPU（顯示晶片加速）就用 WebGPU，沒有就用 WASM（CPU）。主畫面與深度背景執行緒共用這個檔案。
// 執行環境放在自己的網站（onnxruntime-web 1.20.1），學校或公司網路擋外部網站時也能用。
// 有兩種：含 WebGPU 的（wasm 21 MB）與純 CPU 的（wasm 約一半大）。不能用 WebGPU 的手機用不到大的，一律用小的。
const onIOS = typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
// iPhone 也用 WebGPU（iOS 26 的 Safari 起有）：深度模型、斑馬線、地面高低差、頭上障礙都要靠它。
// 以前 iPhone 一律用小的，因為大的常常載不起來。現在改成：上次載入到一半分頁被系統關掉（記憶體不夠，見 app.js
// 的 blindnav-loading），或近 7 天（app.js 的 LOW_MEMORY_DAYS）進過省記憶體模式，才改用小的 CPU 版，不會一直當在同一個地方。
// 網址加 ?nogpu 可以手動改用 CPU 版。背景執行緒沒有 localStorage，只看得到網址。
function lowMemoryMode() {
  if (new URLSearchParams(globalThis.location?.search || "").has("nogpu")) return true;
  try {
    return localStorage.getItem("blindnav-loading") === "1"
      || Date.now() - Number(localStorage.getItem("blindnav-low-memory") || 0) < 7 * 86400000;
  } catch (e) {
    return false;
  }
}
const withGpu = !lowMemoryMode() && typeof navigator !== "undefined" && !!navigator.gpu;
const ort = await import(withGpu ? "../vendor/ort/ort.webgpu.min.mjs" : "../vendor/ort/ort.wasm.min.mjs");

export { ort };

const CACHE_NAME = "blindnav-models-v2";
// 威脅模型 R04／T06：模型與執行環境的 SHA-256。快取或下載到的內容跟這裡對不上（檔案壞掉、被換掉、
// 或網站換了新版模型但手機還留著舊的）就不用，重新下載；重新下載還是不對就報錯，不拿來跑。
// 換模型或升級 onnxruntime-web 時要一起更新這裡（tests/tests.js 會檢查）
export const INTEGRITY = {
  "yolo11n-det-320.onnx": "7f21f177c83dad202941286656455fc5f7f96a805ff1fb01435b8d0f93e1989e",
  "yolo11n-seg.onnx": "2fb697a799f197c85d0c810e7b9434d33389eda60a4cc3476b97253bd26797a0",
  "depth-anything-v2-small-q4f16.onnx": "eca72971aea64216d767c70c534160de53b5435b588d362bac6dbd5a73f9bf1e",
  "ort-wasm-simd-threaded.jsep.wasm": "185b0861a6cd6cbdfb057289338090436483cc59e10a7bc83bd167b15531a51b",
  "ort-wasm-simd-threaded.wasm": "207d02be4591c156b0a98f024f3d58005b5b04c92274d759fb390338c63559ea",
};
export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}
async function intact(url, bytes) {
  const want = INTEGRITY[new URL(url, globalThis.location?.href).pathname.split("/").pop()];
  // shortcut: 不是 https（crypto.subtle 不能用）時沒辦法驗證；手機要 https 才能開鏡頭，實際使用一定驗得到
  if (!want || !globalThis.crypto?.subtle) return true;
  return await sha256Hex(bytes) === want;
}

// 多執行緒可以快約 3 倍，但網頁要有跨來源隔離（serve.py 的標頭或 sw.js 補上）才能用。
// iPhone 用單執行緒：多執行緒的記憶體用量大，分頁被系統關掉比慢一點嚴重得多
export function configureThreads(maxThreads = 4) {
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  // 網址加 ?threads=2 可以試多執行緒（iPhone 預設單執行緒，實機確認沒問題才改預設）
  const forced = Number(new URLSearchParams(globalThis.location?.search || "").get("threads"));
  if (forced > 0 && globalThis.crossOriginIsolated) { ort.env.wasm.numThreads = Math.min(forced, 4); return forced; }
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated && !onIOS
    ? Math.max(1, Math.min(maxThreads, Math.ceil(cores / 2))) : 1;
  return ort.env.wasm.numThreads;
}

// 瀏覽器有 navigator.gpu 不代表真的能用（例如沒有可用的顯示晶片）
export async function webgpuUsable() {
  if (!withGpu) return false;
  try {
    return !!(navigator.gpu && await navigator.gpu.requestAdapter());
  } catch (e) {
    return false;
  }
}

// 下載模型並存進瀏覽器快取：第二次開啟不必重新下載，也不必等網路。
// onProgress(0~1) 回報下載進度；伺服器沒給檔案大小時回報 NaN。
export async function fetchModel(url, onProgress = () => {}) {
  let cache = null;
  try {
    caches.delete("blindnav-models-v1").catch(() => {});   // 舊版沒有驗證的快取
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) {
      const cached = new Uint8Array(await hit.arrayBuffer());
      if (await intact(url, cached)) {
        onProgress(1);
        return cached;
      }
      console.warn("快取的模型跟預期的雜湊不同，重新下載：", url);
      await cache.delete(url);
    }
  } catch (e) {
    cache = null;             // 無痕模式或非 https 網址時沒有快取，直接下載
  }
  const bytes = await downloadWithRetry(url, onProgress);
  if (!await intact(url, bytes)) {
    const error = new Error(`模型檔案內容不對（可能下載壞了或被換掉），不使用：${url}`);
    error.isDownload = true;  // 再下載一次可能就好了
    throw error;
  }
  try { await cache?.put(url, new Response(bytes)); } catch (e) { /* 空間不足時不快取 */ }
  onProgress(1);
  return bytes;
}

// 手機訊號不穩、Wi-Fi 切換時下載常常中斷：接著已經收到的部分繼續下載，不用每次從頭開始。
// 只要還有進度就一直試；連續 MAX_FAILURES 次都沒有新資料才放棄。
const MAX_FAILURES = 5;
const STALL_MS = 20000;   // Wi-Fi 斷掉時連線常常不會報錯，只是一直等：這麼久沒收到資料就當作斷線

export async function downloadWithRetry(url, onProgress = () => {}, { stallMs = STALL_MS, retryMs = 1500 } = {}) {
  let chunks = [], loaded = 0, total = 0, failures = 0, canResume = true, lastError = null;
  while (failures < MAX_FAILURES) {
    const before = loaded;
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), stallMs);
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), stallMs); };
    try {
      const resuming = loaded > 0 && canResume;
      if (loaded > 0 && !resuming) { chunks = []; loaded = 0; }
      const res = await fetch(url, { signal: controller.signal, ...(resuming ? { headers: { Range: `bytes=${loaded}-` } } : {}) });
      if (!res.ok) {
        const error = new Error(`下載模型失敗（HTTP ${res.status}）：${url}`);
        if (res.status === 404 || res.status === 403) failures = MAX_FAILURES;   // 檔案不存在，再試也沒用
        if (res.status === 416) { chunks = []; loaded = 0; }                     // 接續的位置不對，從頭來
        throw error;
      }
      if (resuming && res.status !== 206) { chunks = []; loaded = 0; }           // 伺服器不支援接續，從頭傳
      const encoded = res.headers.get("content-encoding");
      if (encoded) canResume = false;     // 壓縮傳輸時位元組位置對不起來
      else total = loaded + (Number(res.headers.get("content-length")) || 0);
      if (encoded) total = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        alive();
        chunks.push(value);
        loaded += value.length;
        onProgress(total ? Math.min(loaded / total, 1) : NaN);
      }
      if (total && loaded < total) throw new Error(`模型下載不完整（${loaded}／${total}）`);
      if (total && loaded > total) { chunks = []; loaded = 0; throw new Error("模型下載內容不正確"); }
      clearTimeout(timer);
      const bytes = new Uint8Array(loaded);
      let offset = 0;
      for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
      return bytes;
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      failures = loaded > before ? 0 : failures + 1;
      // 接續的要求本身失敗（有些網站不接受）：下一次改成從頭下載
      if (loaded === before && before > 0) canResume = false;
      console.warn(`模型下載中斷（已收到 ${loaded} 位元組，連續失敗 ${failures} 次）：`, e);
      // 剛才還有收到資料就馬上接著傳；完全連不上時才慢慢等
      if (failures < MAX_FAILURES) await new Promise(ok => setTimeout(ok, failures ? retryMs * failures : retryMs / 8));
    }
  }
  lastError.isDownload = true;   // 跟引擎初始化失敗不同：網路好了直接再試就可以
  throw lastError;
}

// 快取裡的模型壞掉時（極少見）要清掉，否則永遠載入失敗
export async function forgetModel(url) {
  try {
    return await (await caches.open(CACHE_NAME)).delete(url);
  } catch (e) {
    return false;
  }
}

// 執行環境（21 MB，比模型還大）預設由 ONNX Runtime 自己下載：不能接續，也不能重試，而且失敗一次就不能再初始化。
// 改成用上面可以接續的下載拿到完整檔案，再交給它；存在快取裡，斷網也能用。
const WASM_URL = new URL(`../vendor/ort/ort-wasm-simd-threaded${withGpu ? ".jsep" : ""}.wasm`, import.meta.url).href;
let runtimeReady = null;
export function prepareRuntime(onProgress = () => {}) {
  if (!runtimeReady) {
    runtimeReady = fetchModel(WASM_URL, onProgress).then(bytes => { ort.env.wasm.wasmBinary = bytes.buffer; });
    runtimeReady.catch(() => { runtimeReady = null; });   // 這次失敗，下次還可以再試
  }
  return runtimeReady;
}

// 建立推論工作階段；回傳 {session, backend}，backend 為 "webgpu" 或 "wasm"
export async function createSession(bytes, preferWebgpu = true) {
  await prepareRuntime();
  if (preferWebgpu && withGpu) {
    try {
      const session = await ort.InferenceSession.create(bytes, { executionProviders: ["webgpu"] });
      return { session, backend: "webgpu" };
    } catch (e) {
      console.warn("WebGPU 無法使用，改用 WASM：", e);
    }
  }
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
  return { session, backend: "wasm" };
}
