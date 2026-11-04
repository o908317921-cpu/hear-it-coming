// 主畫面這一側的深度估計介面：每幾幀交一張影像給背景執行緒，沒算完就略過，永遠只拿最新結果。
import { C } from "./config.js";
import { makeCanvas } from "./canvas.js";

export class DepthWorker {
  constructor() {
    this.error = null;          // 模型無法載入時的原因；之後不再嘗試
    this.ready = false;
    this.busy = false;
    this.result = null;         // {ts, disp: {data, width, height}}
    this.lastMs = 0;
    this.progress = 0;
    this.backend = "";
    this.canvas = null;
    this.worker = null;
    this.inputSize = C.DEPTH_INPUT_SIZE;
    this.slowRuns = 0;          // 連續幾次算太久（結果會過期）
  }

  get available() {
    return this.error == null;
  }

  start() {
    if (this.worker) return;
    try {
      this.worker = new Worker(new URL("./depth-worker.js", import.meta.url), { type: "module" });
    } catch (e) {
      this.error = `深度模型無法使用，已停用頭部高度障礙偵測：${e.message || e}`;
      return;
    }
    this.worker.onmessage = ({ data: msg }) => {
      if (msg.type === "progress") this.progress = msg.p;
      else if (msg.type === "ready") { this.ready = true; this.backend = msg.backend; }
      else if (msg.type === "result") {
        this.busy = false;
        this.lastMs = msg.ms;
        this.slowRuns = msg.ms > C.DEPTH_MAX_AGE_SEC * 1000 ? this.slowRuns + 1 : 0;
        // 快來不及了就先縮小輸入，還沒真的過期就調整
        if (msg.ms > C.DEPTH_MAX_AGE_SEC * 600) this.inputSize = Math.min(this.inputSize, C.DEPTH_INPUT_SIZE_SLOW);
        this.result = { ts: msg.ts, disp: { data: msg.data, width: msg.width, height: msg.height } };
      } else if (msg.type === "error") {
        this.busy = false;
        this.error = `深度模型無法使用，已停用頭部高度障礙偵測：${msg.message}`;
        this.worker.terminate();
      }
    };
    this.worker.onerror = e => {
      this.error = `深度模型無法使用，已停用頭部高度障礙偵測：${e.message || "背景執行緒錯誤"}`;
    };
    // 把目前的設定（含 settings.json 覆寫的值）帶給背景執行緒
    this.worker.postMessage({ type: "init", settings: JSON.parse(JSON.stringify(C)) });
  }

  // source：畫面 canvas；ts：秒。忙碌中或還沒載入完成時略過，回傳 false
  submit(source, w, h, ts) {
    if (!this.available || !this.ready || this.busy) return false;
    // Depth Anything 的 patch 大小是 14，輸入邊長要是 14 的倍數
    const scale = this.inputSize / Math.min(w, h);
    const nh = Math.max(14, Math.round(h * scale / 14) * 14);
    const nw = Math.max(14, Math.round(w * scale / 14) * 14);
    if (!this.canvas || this.canvas.width !== nw || this.canvas.height !== nh) {
      this.canvas = makeCanvas(nw, nh);
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    this.ctx.drawImage(source, 0, 0, nw, nh);
    const pixels = this.ctx.getImageData(0, 0, nw, nh).data;
    this.busy = true;
    this.busySince = performance.now();
    this.worker.postMessage({ type: "run", ts, width: nw, height: nh, pixels }, [pixels.buffer]);
    return true;
  }

  latest(now, maxAge = C.DEPTH_MAX_AGE_SEC) {
    if (!this.result || now - this.result.ts > maxAge) return null;
    return this.result;
  }

  close() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.busy = false;
    this.result = null;
  }
}
