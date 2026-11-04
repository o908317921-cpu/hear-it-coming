// 背景執行緒：Depth Anything V2 Small 單眼深度估計（對應 blindnav/depth.py 的 DepthWorker）。
// 深度模型比 YOLO 慢很多，放在這裡跑才不會卡住畫面與偵測。
import { C } from "./config.js";

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
let session = null;
// ort.js 要先等執行環境載入（top-level await）。不能寫成最上面的 import：
// 那樣這個檔案要等載入完才會設定 onmessage，主畫面送來的「開始」訊息就被丟掉，模型永遠不會載入
const library = import("./ort.js");

self.onmessage = async ({ data: msg }) => {
  try {
    const { ort, fetchModel, forgetModel, createSession } = await library;
    if (msg.type === "init") {
      Object.assign(C, msg.settings);   // 主畫面讀到的 settings.json
      const bytes = await fetchModel(C.DEPTH_MODEL_URL, p => self.postMessage({ type: "progress", p }));
      let result;
      try {
        result = await createSession(bytes, C.USE_WEBGPU);
      } catch (e) {
        await forgetModel(C.DEPTH_MODEL_URL);   // 快取裡的檔案可能壞了，下次開始重新下載
        throw e;
      }
      session = result.session;
      if (result.backend === "wasm" && !C.DEPTH_ON_WASM) throw new Error("沒有顯示晶片加速");
      // 第一次推論要編譯著色器，可能要 10 秒；先跑完才算就緒，之後的時間才準
      const h = C.DEPTH_INPUT_SIZE, w = Math.round(h * 4 / 3 / 14) * 14;
      await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", new Float32Array(3 * w * h), [1, 3, h, w]) });
      self.postMessage({ type: "ready", backend: result.backend });
    } else if (msg.type === "run") {
      const { width: w, height: h, pixels, ts } = msg;
      const n = w * h, input = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) input[c * n + i] = (pixels[i * 4 + c] / 255 - MEAN[c]) / STD[c];
      }
      const started = performance.now();
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, h, w]) });
      const depth = out[session.outputNames[0]];
      const dims = depth.dims;
      const data = new Float32Array(depth.data);
      self.postMessage({ type: "result", ts, width: dims[dims.length - 1], height: dims[dims.length - 2], data,
                         ms: performance.now() - started }, [data.buffer]);
    }
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && e.message || e) });
  }
};
