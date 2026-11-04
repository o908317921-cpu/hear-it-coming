// YOLO11n-seg 實例分割（取代 Python 版的 Ultralytics）：前處理、推論、框解碼、NMS、遮罩。
//
// 模型輸出：
//   output0 [1, 116, N]：每個候選框 = 4 個座標（cx, cy, w, h）＋ 80 類分數 ＋ 32 個遮罩係數
//   output1 [1, 32, P, P]：遮罩「原型」；某個物體的遮罩 = 32 個係數 × 32 張原型，大於 0 的地方就是物體
import { C, targetClassIds } from "./config.js";
import { computeIou } from "./analysis.js";
import { makeCanvas } from "./canvas.js";
import { ort, fetchModel, forgetModel, createSession, configureThreads, prepareRuntime, webgpuUsable } from "./ort.js";

const NUM_CLASSES = 80;
const NUM_COEFFS = 32;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("顯示晶片沒有回應")), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

export class YoloSegmenter {
  // 有顯示晶片就用大模型；真的跑得動才算數（有些手機建立得起來，第一次推論才失敗）
  static async load(onProgress = () => {}) {
    // 進度合併成一個百分比：執行環境約佔三分之二，模型約佔三分之一
    await prepareRuntime(p => onProgress(p * 0.65));
    const modelProgress = p => onProgress(0.65 + 0.35 * p);
    if (C.USE_WEBGPU && await webgpuUsable()) {
      try {
        const bytes = await fetchModel(C.MODEL_URL, modelProgress);
        // 有些手機的顯示晶片驅動會卡住不回應，也不會報錯：不能讓使用者永遠等在「載入中」
        const yolo = await withTimeout((async () => {
          const { session, backend } = await createSession(bytes, true);
          if (backend !== "webgpu") return null;
          const segmenter = new YoloSegmenter(session, backend, C.INFERENCE_SIZE);
          await segmenter.warmup();
          await segmenter.selfTest();
          return segmenter;
        })(), C.WEBGPU_START_TIMEOUT_SEC * 1000);
        if (yolo) return yolo;
      } catch (e) {
        console.warn("WebGPU 無法使用，改用 WASM：", e);
      }
    }
    return YoloSegmenter.loadWasm(modelProgress);
  }

  static async loadWasm(onProgress) {
    configureThreads(C.WASM_MAX_THREADS);
    let result;
    try {
      result = await createSession(await fetchModel(C.MODEL_URL_WASM, onProgress), false);
    } catch (e) {
      // 快取裡的檔案壞掉：清掉重新下載一次（連不上網路時這裡會再失敗，由上層說明）
      if (!await forgetModel(C.MODEL_URL_WASM)) throw e;
      console.warn("模型載入失敗，重新下載：", e);
      result = await createSession(await fetchModel(C.MODEL_URL_WASM, onProgress), false);
    }
    const { session, backend } = result;
    const yolo = new YoloSegmenter(session, backend, C.INFERENCE_SIZE_WASM);
    await yolo.warmup();
    return yolo;
  }

  // 第一次推論要編譯、配置記憶體，特別久：先跑一次，「準備好了」才是真的準備好
  async warmup() {
    const s = this.size;
    await this.session.run({ [this.session.inputNames[0]]: new ort.Tensor("float32", new Float32Array(3 * s * s), [1, 3, s, s]) });
  }

  // 有些手機的顯示晶片算得出來但結果是錯的（滿畫面亂框）：用一張答案已知的照片檢查，不對就不要用
  async selfTest() {
    let found = null;
    try {
      const res = await fetch(new URL("../tests/bus.png", import.meta.url).href);
      if (!res.ok) return;
      const image = await createImageBitmap(await res.blob());
      const canvas = makeCanvas(image.width, image.height);
      canvas.getContext("2d").drawImage(image, 0, 0);
      found = await this.detect(canvas, image.width, image.height);
    } catch (e) {
      console.warn("顯示晶片自我檢查略過：", e);
      return;
    }
    const best = name => Math.max(0, ...found.filter(d => d.rawLabel === name).map(d => d.score));
    const strong = found.filter(d => d.score > 0.5).length;
    self.blindnavLog?.("selftest", { backend: this.backend, bus: +best("bus").toFixed(3), person: +best("person").toFixed(3), strong, total: found.length });
    if (best("bus") < 0.5 || best("person") < 0.5 || strong > 12) throw new Error(`顯示晶片辨識結果不正確（公車 ${best("bus").toFixed(2)}、行人 ${best("person").toFixed(2)}、${strong} 個物體）`);
  }

  constructor(session, backend, size = C.INFERENCE_SIZE) {
    this.session = session;
    this.backend = backend;
    this.size = size;
    this.targetIds = targetClassIds();
    this.canvas = makeCanvas(this.size, this.size);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  // 等比例縮放到 size×size，上下（或左右）補灰邊（與 Ultralytics 的 letterbox 相同）
  letterbox(source, w, h) {
    const s = this.size, r = Math.min(s / w, s / h);
    const nw = Math.round(w * r), nh = Math.round(h * r);
    const left = Math.round((s - nw) / 2 - 0.1), top = Math.round((s - nh) / 2 - 0.1);
    this.ctx.fillStyle = "rgb(114,114,114)";
    this.ctx.fillRect(0, 0, s, s);
    this.ctx.drawImage(source, left, top, nw, nh);
    return { r, left, top };
  }

  // source：畫面（canvas）；sharpen：整體畫面偏模糊時先銳化
  // 回傳候選物體清單；遮罩要等追蹤配對完、確定要用時才呼叫 buildMask 計算（節省運算）
  async detect(source, w, h, { sharpen = false } = {}) {
    const lb = this.letterbox(source, w, h);
    const s = this.size;
    const pixels = this.ctx.getImageData(0, 0, s, s).data;
    if (sharpen) unsharpMask(pixels, s, s, C.SHARPEN_SIGMA * lb.r, C.SHARPEN_AMOUNT);
    const input = new Float32Array(3 * s * s);
    for (let i = 0, n = s * s; i < n; i++) {
      input[i] = pixels[i * 4] / 255;
      input[n + i] = pixels[i * 4 + 1] / 255;
      input[2 * n + i] = pixels[i * 4 + 2] / 255;
    }
    const feeds = { [this.session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, s, s]) };
    const out = await this.session.run(feeds);
    const det = out[this.session.outputNames[0]];
    // 只偵測的輕量模型沒有第二個輸出（遮罩原型）
    const proto = this.session.outputNames.length > 1 ? out[this.session.outputNames[1]] : null;
    const dets = this.decode(det.data, det.dims[2], lb, w, h, !!proto);
    this.proto = proto ? { data: proto.data, size: proto.dims[2] } : null;
    this.lb = lb;
    return dets;
  }

  decode(data, n, lb, w, h, hasMasks = true) {
    const candidates = [];
    for (let i = 0; i < n; i++) {
      // 先取 80 類中分數最高的那一類（與 Ultralytics 相同），再看它是不是我們要的類別
      let best = 0, bestScore = -1;
      for (let c = 0; c < NUM_CLASSES; c++) {
        const v = data[(4 + c) * n + i];
        if (v > bestScore) { bestScore = v; best = c; }
      }
      if (bestScore < C.TRACK_LOW_CONF || !this.targetIds.has(best)) continue;
      const cx = data[i], cy = data[n + i], bw = data[2 * n + i], bh = data[3 * n + i];
      let coeffs = null;
      if (hasMasks) {
        coeffs = new Float32Array(NUM_COEFFS);
        for (let k = 0; k < NUM_COEFFS; k++) coeffs[k] = data[(4 + NUM_CLASSES + k) * n + i];
      }
      candidates.push({
        inputBox: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
        score: bestScore,
        rawLabel: this.targetIds.get(best),
        coeffs,
      });
    }
    // 依類別分開做 NMS：同類別重疊太多的框只留分數最高的
    candidates.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of candidates) {
      if (kept.some(k => k.rawLabel === c.rawLabel && computeIou(k.inputBox, c.inputBox) > C.NMS_IOU)) continue;
      kept.push(c);
      if (kept.length >= 300) break;
    }
    const clampX = v => Math.max(0, Math.min(w, v)), clampY = v => Math.max(0, Math.min(h, v));
    for (const k of kept) {
      const [x1, y1, x2, y2] = k.inputBox;
      k.box = [Math.trunc(clampX((x1 - lb.left) / lb.r)), Math.trunc(clampY((y1 - lb.top) / lb.r)),
               Math.trunc(clampX((x2 - lb.left) / lb.r)), Math.trunc(clampY((y2 - lb.top) / lb.r))];
    }
    return kept;
  }

  // 計算某個物體的遮罩（原型解析度，只算框內），只保留最大的連通區域。
  // 回傳 {data, gw, gh, x, y, cell, area}：x, y 為格子左上角的畫面座標、cell 為每格的畫面像素寬，
  // area 為換算成畫面像素的面積；遮罩太小（雜訊）回傳 null
  buildMask(det) {
    // 輕量模型沒有遮罩：面積用「框 × 這個類別輪廓平常佔框的比例」估計，距離分級的門檻才維持一致
    if (!this.proto) {
      const [x1, y1, x2, y2] = det.box;
      const width = Math.max(1, x2 - x1), height = Math.max(1, y2 - y1);
      return { data: new Uint8Array(1).fill(1), gw: 1, gh: 1, x: x1, y: y1, cell: 1, boxOnly: true,
               area: width * height * (C.BOX_AREA_FILL[det.rawLabel] ?? C.BOX_AREA_FILL_DEFAULT) };
    }
    const { data: proto, size: p } = this.proto;
    const stride = this.size / p, lb = this.lb;
    const [ix1, iy1, ix2, iy2] = det.inputBox;
    const gx0 = Math.max(0, Math.floor(ix1 / stride)), gy0 = Math.max(0, Math.floor(iy1 / stride));
    const gx1 = Math.min(p, Math.ceil(ix2 / stride)), gy1 = Math.min(p, Math.ceil(iy2 / stride));
    const gw = gx1 - gx0, gh = gy1 - gy0;
    if (gw <= 0 || gh <= 0) return null;
    const mask = new Uint8Array(gw * gh);
    const plane = p * p;
    for (let gy = 0; gy < gh; gy++) {
      const py = gy0 + gy, cy = (py + 0.5) * stride;
      if (cy < iy1 || cy > iy2) continue;
      for (let gx = 0; gx < gw; gx++) {
        const px = gx0 + gx, cx = (px + 0.5) * stride;
        if (cx < ix1 || cx > ix2) continue;
        let v = 0;
        const idx = py * p + px;
        for (let k = 0; k < NUM_COEFFS; k++) v += det.coeffs[k] * proto[k * plane + idx];
        if (v > 0) mask[gy * gw + gx] = 1;     // sigmoid(v) > 0.5
      }
    }
    const count = keepLargestComponent(mask, gw, gh);
    const cell = stride / lb.r;
    const area = count * cell * cell;
    if (area < C.MASK_MIN_CONTOUR_AREA) return null;
    return { data: mask, gw, gh, x: (gx0 * stride - lb.left) / lb.r, y: (gy0 * stride - lb.top) / lb.r,
             cell, area: Math.round(area) };
  }
}

// 只保留最大的連通區域（去掉零碎雜訊），回傳保留的格數
export function keepLargestComponent(mask, w, h) {
  const labels = new Int32Array(w * h);
  const stack = [];
  let bestLabel = 0, bestCount = 0, label = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    label++;
    let count = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length) {
      const i = stack.pop();
      count++;
      const x = i % w, y = (i - x) / w;
      const neighbors = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of neighbors) {
        if (j >= 0 && mask[j] && !labels[j]) { labels[j] = label; stack.push(j); }
      }
    }
    if (count > bestCount) { bestCount = count; bestLabel = label; }
  }
  for (let i = 0; i < mask.length; i++) mask[i] = labels[i] === bestLabel && bestLabel ? 1 : 0;
  return bestCount;
}

// 遮罩的長軸 / 短軸比例（以二階矩近似 Python 版的橢圓擬合）；動態模糊拖影會使此值明顯升高
export function maskElongation(m) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let y = 0; y < m.gh; y++) {
    for (let x = 0; x < m.gw; x++) {
      if (!m.data[y * m.gw + x]) continue;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
  }
  if (n < 5) return 1;
  const mx = sx / n, my = sy / n;
  const a = sxx / n - mx * mx + 1 / 12, b = sxy / n - mx * my, c = syy / n - my * my + 1 / 12;
  const root = Math.sqrt(((a - c) / 2) ** 2 + b * b);
  const major = (a + c) / 2 + root, minor = Math.max((a + c) / 2 - root, 1e-6);
  return Math.sqrt(major / minor);
}

// 輕量銳化（Unsharp Masking）：原圖 ×(1+amount) − 模糊圖 × amount，直接改寫 RGBA 像素
function unsharpMask(px, w, h, sigma, amount) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = [];
  let total = 0;
  for (let i = -radius; i <= radius; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); kernel.push(v); total += v; }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  const tmp = new Float32Array(w * h), blur = new Float32Array(w * h);
  for (let ch = 0; ch < 3; ch++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = Math.min(w - 1, Math.max(0, x + k));
          v += px[(y * w + xx) * 4 + ch] * kernel[k + radius];
        }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k));
          v += tmp[yy * w + x] * kernel[k + radius];
        }
        blur[y * w + x] = v;
      }
    }
    for (let i = 0, n = w * h; i < n; i++) {
      px[i * 4 + ch] = px[i * 4 + ch] * (1 + amount) - blur[i] * amount;   // Uint8ClampedArray 會自動截在 0~255
    }
  }
}
