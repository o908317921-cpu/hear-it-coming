// 影片逐幀分析：把胸前手機錄的影片，用手機版同一套辨識（YOLO＋追蹤＋碰撞時間）與警報規則一幀一幀跑完，
// 匯出兩份 CSV：每幀每個物體（TTC、是否在路徑上、警示等級…）與每一句警報。
// 對應 Python 版的 tools/evaluate_video.py，供報告實驗一、二、三、六用目前的手機版重跑。
import { C } from "../js/config.js";
import { YoloSegmenter } from "../js/yolo.js";
import { DepthWorker } from "../js/depth.js";
import { HazardDetector } from "../js/detector.js";
import { AlertEngine, alertLevelOf } from "../js/alerts.js";
import { toCsv, parseOverrides, frameTimes, ttcError } from "./video-core.js";

const $ = id => document.getElementById(id);
const log = t => { $("log").textContent = t; };
let trackRows = [], alertRows = [], stopRequested = false, fileName = "video";

const video = document.createElement("video");
video.muted = true; video.playsInline = true;
const grab = document.createElement("canvas");
const gctx = grab.getContext("2d", { willReadFrequently: true });

// 換到影片的某個時間點，等畫面真的換好
function seek(t) {
  return new Promise((ok, fail) => {
    const done = () => { video.removeEventListener("seeked", done); clearTimeout(timer); ok(); };
    const timer = setTimeout(() => { video.removeEventListener("seeked", done); fail(new Error(`跳到 ${t.toFixed(2)} 秒逾時`)); }, 10000);
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

function download(name, text) {
  // 加 BOM：Excel 打開中文才不會亂碼
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function run() {
  const file = $("file").files[0];
  if (!file) return log("請先選影片檔。");
  let over;
  try { over = parseOverrides($("over").value, C); } catch (e) { return log(e.message); }
  const fps = Number($("fps").value);
  if (!(fps > 0 && fps <= 120)) return log("每秒幀數要在 1 到 120 之間。");
  // 要在載入模型之前改，MODEL_URL、INFERENCE_SIZE 才會生效；跑完要改回來，下一次分析才不會沿用上一次的設定
  const original = Object.fromEntries(Object.keys(over).map(k => [k, C[k]]));
  Object.assign(C, over);
  try { await analyze(file, fps, over); } finally { Object.assign(C, original); }
}

async function analyze(file, fps, over) {
  fileName = file.name.replace(/\.[^.]+$/, "");
  $("run").disabled = true; $("stop").disabled = false; $("dlTracks").disabled = $("dlAlerts").disabled = true;
  stopRequested = false; trackRows = []; alertRows = [];

  video.src = URL.createObjectURL(file);
  await new Promise((ok, fail) => { video.onloadedmetadata = ok; video.onerror = () => fail(new Error("瀏覽器無法讀這個影片格式，請轉成 mp4（H.264）。")); });
  // 瀏覽器錄的 webm 常常沒寫長度（Infinity）：跳到很後面讓瀏覽器自己算出來
  if (!Number.isFinite(video.duration)) {
    await new Promise(ok => { video.ondurationchange = () => { if (Number.isFinite(video.duration)) ok(); }; video.currentTime = 1e9; setTimeout(ok, 10000); });
    video.ondurationchange = null;
    if (!Number.isFinite(video.duration)) throw new Error("讀不出影片長度，請轉成 mp4（H.264）再試。");
  }
  const vw = video.videoWidth, vh = video.videoHeight, k = Math.min(1, C.MAX_FRAME_SIDE / Math.max(vw, vh));
  grab.width = Math.round(vw * k); grab.height = Math.round(vh * k);
  const view = $("view"); view.width = grab.width; view.height = grab.height;

  log("載入辨識模型…");
  const yolo = await YoloSegmenter.load();
  let depth = null;
  if ($("depth").checked) {
    depth = new DepthWorker(); depth.start();
    const t0 = performance.now();
    while (!depth.ready && !depth.error && performance.now() - t0 < 60000) await new Promise(r => setTimeout(r, 200));
    if (!depth.ready) { log("深度模型載入失敗，改成不跑深度：" + (depth.error || "逾時")); depth.close?.(); depth = null; }
  }
  const detector = new HazardDetector(yolo, depth);
  detector.tiltOk = true;                        // 影片沒有傾斜角度資料：當作手機拿直
  const engine = new AlertEngine();
  const times = frameTimes(video.duration, fps);
  let lastBeep = "";
  const started = performance.now();

  for (let i = 0; i < times.length && !stopRequested; i++) {
    const t = times[i];
    await seek(t);
    gctx.drawImage(video, 0, 0, grab.width, grab.height);
    const frame = { canvas: grab, imageData: gctx.getImageData(0, 0, grab.width, grab.height), width: grab.width, height: grab.height };
    const tracks = await detector.process(frame, t, null);
    // 深度模型在背景執行緒算：離線分析時等它算完，結果才不會受電腦快慢影響
    if (depth) { const w0 = performance.now(); while (depth.busy && performance.now() - w0 < 5000) await new Promise(r => setTimeout(r, 10)); }
    const update = engine.update(tracks, t, false, { brightness: detector.brightness, frameWidth: grab.width, staticHazards: detector.staticHazards });
    for (const tr of tracks) {
      trackRows.push({
        frame: i, t: +t.toFixed(3), id: tr.trackId, label: tr.rawLabel, predicted: tr.isPredicted ? 1 : 0,
        x1: Math.round(tr.box[0]), y1: Math.round(tr.box[1]), x2: Math.round(tr.box[2]), y2: Math.round(tr.box[3]),
        ttc: Number.isFinite(tr.ttcSec) ? +tr.ttcSec.toFixed(3) : "", ttc_source: tr.ttcSource ?? "",
        in_path: tr.inCollisionZone ? 1 : 0, level: alertLevelOf(tr), direction: tr.horizontalPosition ?? "",
        distance_m: Number.isFinite(tr.distanceM) ? +tr.distanceM.toFixed(2) : "", risk_pct: Math.round(tr.collisionProbability ?? 0),
      });
    }
    for (const [text, pri] of update.speech) alertRows.push({ frame: i, t: +t.toFixed(3), kind: "speech", priority: pri, text });
    for (const cue of detector.sceneSpeech) alertRows.push({ frame: i, t: +t.toFixed(3), kind: cue.kind, priority: C.SPEECH_PRIORITY.scene, text: cue.text });
    // 警示音只記「開始／改變／停止」：每幀都記的話一秒 30 列，看不出什麼時候變了
    const beep = update.beep ? JSON.stringify(update.beep) : "";
    if (beep !== lastBeep) alertRows.push({ frame: i, t: +t.toFixed(3), kind: beep ? "beep" : "beep-stop", priority: "", text: beep });
    lastBeep = beep;
    if (i % 5 === 0) {
      view.getContext("2d").drawImage(grab, 0, 0);
      const left = (performance.now() - started) / (i + 1) * (times.length - i - 1) / 1000;
      log(`第 ${i + 1}／${times.length} 幀（影片 ${t.toFixed(1)} 秒）｜辨識 ${yolo.backend}${depth ? "＋深度" : ""}｜約剩 ${Math.ceil(left)} 秒`);
    }
  }
  depth?.close?.();
  const speech = alertRows.filter(r => r.kind === "speech").length;
  const tc = Number($("tc").value), err = $("tc").value !== "" && tc > 0 ? ttcError(trackRows, tc) : null;
  log(`${stopRequested ? "已停止" : "完成"}：${times.length} 幀中處理了 ${new Set(trackRows.map(r => r.frame)).size} 幀有物體，${trackRows.length} 筆物體紀錄、${speech} 句警報。` +
      (Object.keys(over).length ? `\n設定覆寫：${JSON.stringify(over)}` : "") +
      (err ? (err.n ? `\n實驗一：物體 ${err.id} 在真實 TTC ≤ 3 秒的 ${err.n} 幀，TTC 平均絕對誤差 ${err.mae} 秒`
                    : `\n實驗一：物體 ${err.id} 沒有落在真實 TTC ≤ 3 秒的幀（確認碰撞時刻）`) : ""));
  $("run").disabled = false; $("stop").disabled = true; $("dlTracks").disabled = $("dlAlerts").disabled = false;
  URL.revokeObjectURL(video.src);
}

$("file").onchange = () => { $("run").disabled = !$("file").files.length; };
$("run").onclick = () => run().catch(e => { console.error(e); log("錯誤：" + (e.message || e)); $("run").disabled = false; $("stop").disabled = true; });
$("stop").onclick = () => { stopRequested = true; };
$("dlTracks").onclick = () => download(`${fileName}_每幀物體.csv`, toCsv(trackRows));
$("dlAlerts").onclick = () => download(`${fileName}_警報.csv`, toCsv(alertRows));
log("選一段影片後按「開始分析」。");
