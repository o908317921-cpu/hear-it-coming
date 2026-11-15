// 影片逐幀分析：把胸前手機錄的影片，用手機版同一套辨識（YOLO＋追蹤＋碰撞時間）與警報規則一幀一幀跑完，
// 匯出 CSV：每幀每個物體（TTC、是否在路徑上、警示等級…）、每一句警報，以及多段影片＋標註時的結果摘要。
// 對應 Python 版的 tools/evaluate_video.py 與 compare_methods.py，供報告實驗一、二、三、六用目前的手機版重跑。
import { C } from "../js/config.js";
import { YoloSegmenter } from "../js/yolo.js";
import { DepthWorker } from "../js/depth.js";
import { HazardDetector } from "../js/detector.js";
import { AlertEngine, alertLevelOf } from "../js/alerts.js";
import { toCsv, parseOverrides, frameTimes, ttcError, parseLabels, clipAlert, evaluateClips } from "./video-core.js";

const $ = id => document.getElementById(id);
const log = t => { $("log").textContent = t; };
let trackRows = [], alertRows = [], summaryRows = [], stopRequested = false, baseName = "video";

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
  const files = [...$("file").files];
  if (!files.length) return log("請先選影片檔。");
  let over, labels = null;
  try { over = parseOverrides($("over").value, C); } catch (e) { return log(e.message); }
  if ($("labels").files[0]) {
    try { labels = parseLabels(await $("labels").files[0].text()); } catch (e) { return log("標註檔：" + e.message); }
  }
  const fps = Number($("fps").value);
  if (!(fps > 0 && fps <= 120)) return log("每秒幀數要在 1 到 120 之間。");
  // 要在載入模型之前改，MODEL_URL、INFERENCE_SIZE 才會生效；跑完要改回來，下一次分析才不會沿用上一次的設定。
  // 沒有顯示晶片時會改用 CPU 那組設定（*_WASM）：一起改，換模型才不會在 CPU 上默默沒效果
  const applied = { ...over };
  if ("MODEL_URL" in over && !("MODEL_URL_WASM" in over)) applied.MODEL_URL_WASM = over.MODEL_URL;
  if ("INFERENCE_SIZE" in over && !("INFERENCE_SIZE_WASM" in over)) applied.INFERENCE_SIZE_WASM = over.INFERENCE_SIZE;
  const original = Object.fromEntries(Object.keys(applied).map(k => [k, C[k]]));
  Object.assign(C, applied);
  $("run").disabled = true; $("stop").disabled = false;
  for (const id of ["dlTracks", "dlAlerts", "dlSummary"]) $(id).disabled = true;
  stopRequested = false; trackRows = []; alertRows = []; summaryRows = [];
  baseName = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, "") : `${files.length}段影片`;
  try { await analyzeAll(files, fps, over, labels); } finally {
    Object.assign(C, original);
    $("run").disabled = false; $("stop").disabled = true;
  }
}

async function analyzeAll(files, fps, over, labels) {
  log("載入辨識模型…");
  let yolo;
  try { yolo = await YoloSegmenter.load(); } catch (e) {
    throw new Error(`辨識模型載入失敗：${e.message || e}。輸入大小可能和模型不符（yolo11n-det-320 只能用 320；448 請配 yolo11n-seg.onnx）`);
  }
  // 顯示晶片載入失敗時會默默改用 CPU：實驗六一定要確認真的用了要比較的設定
  const engine = `辨識：${yolo.backend.toUpperCase()}、輸入 ${yolo.size} 像素、模型 ${(yolo.backend === "webgpu" ? C.MODEL_URL : C.MODEL_URL_WASM).split("/").pop()}`;
  if ("INFERENCE_SIZE" in over && yolo.size !== over.INFERENCE_SIZE) throw new Error(`輸入大小沒有生效（要 ${over.INFERENCE_SIZE}，實際 ${yolo.size}），不分析`);
  let depth = null;
  if ($("depth").checked) {
    depth = new DepthWorker(); depth.start();
    const t0 = performance.now();
    while (!depth.ready && !depth.error && performance.now() - t0 < 60000) await new Promise(r => setTimeout(r, 200));
    if (!depth.ready) { log("深度模型載入失敗，改成不跑深度：" + (depth.error || "逾時")); depth.close?.(); depth = null; }
  }
  const clips = [];
  try {
    for (const [n, file] of files.entries()) {
      if (stopRequested) break;
      const rows = await analyzeOne(file, fps, yolo, depth, `第 ${n + 1}／${files.length} 段`);
      clips.push({ file: file.name, ...clipAlert(rows.alerts) });
    }
  } finally { depth?.close?.(); }

  const lines = [`${stopRequested ? "已停止" : "完成"}：${clips.length} 段影片，${trackRows.length} 筆物體紀錄、${alertRows.filter(r => r.kind === "speech").length} 句警報。`];
  lines.push(engine + (depth ? "，含深度模型" : ""));
  if (Object.keys(over).length) lines.push(`設定覆寫：${JSON.stringify(over)}`);
  // 實驗一：只有一段影片時，填了真實碰撞時刻就算 TTC 誤差
  const tc = Number($("tc").value);
  if (files.length === 1 && $("tc").value !== "" && tc > 0) {
    const err = ttcError(trackRows, tc);
    if (err) lines.push(err.n ? `實驗一：物體 ${err.id} 在真實 TTC ≤ 3 秒的 ${err.n} 幀，TTC 平均絕對誤差 ${err.mae} 秒`
                              : `實驗一：物體 ${err.id} 沒有落在真實 TTC ≤ 3 秒的幀（確認碰撞時刻）`);
  }
  // 實驗二：有標註檔時算精確率、召回率、F1、提前時間、方向正確率
  if (labels) {
    const r = evaluateClips(clips, labels);
    summaryRows = r.rows;
    lines.push(`實驗二：正確警示 ${r.tp}、誤報 ${r.fp}、漏報 ${r.fn}、正確安靜 ${r.tn}｜精確率 ${r.precision ?? "—"}、召回率 ${r.recall ?? "—"}、F1 ${r.f1 ?? "—"}`
      + `｜方向正確率 ${r.dirAccuracy ?? "—"}｜平均提前 ${r.leadMean ?? "—"} 秒`);
    if (r.unlabeled.length) lines.push(`沒有標註、不計分：${r.unlabeled.join("、")}`);
  } else {
    summaryRows = clips.map(c => ({ 檔名: c.file, 系統警示: c.alerted ? 1 : 0, 第一句秒: c.firstT ?? "", 系統方向: c.dir ?? "", 碰撞警報句數: c.count }));
  }
  log(lines.join("\n"));
  for (const id of ["dlTracks", "dlAlerts", "dlSummary"]) $(id).disabled = false;
}

// 一段影片：逐幀跑偵測與警報規則；每段影片重新開始追蹤與警報狀態，彼此不影響
async function analyzeOne(file, fps, yolo, depth, label) {
  video.src = URL.createObjectURL(file);
  try {
    await new Promise((ok, fail) => { video.onloadedmetadata = ok; video.onerror = () => fail(new Error(`${file.name}：瀏覽器無法讀這個影片格式，請轉成 mp4（H.264）。`)); });
    // 瀏覽器錄的 webm 常常沒寫長度（Infinity）：跳到很後面讓瀏覽器自己算出來
    if (!Number.isFinite(video.duration)) {
      await new Promise(ok => { video.ondurationchange = () => { if (Number.isFinite(video.duration)) ok(); }; video.currentTime = 1e9; setTimeout(ok, 10000); });
      video.ondurationchange = null;
      if (!Number.isFinite(video.duration)) throw new Error(`${file.name}：讀不出影片長度，請轉成 mp4（H.264）再試。`);
    }
    const vw = video.videoWidth, vh = video.videoHeight, k = Math.min(1, C.MAX_FRAME_SIDE / Math.max(vw, vh));
    grab.width = Math.round(vw * k); grab.height = Math.round(vh * k);
    const view = $("view"); view.width = grab.width; view.height = grab.height;

    const detector = new HazardDetector(yolo, depth);
    detector.tiltOk = true;                        // 影片沒有傾斜角度資料：當作手機拿直
    const engine = new AlertEngine();
    const times = frameTimes(video.duration, fps);
    const mine = { alerts: [] };
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
      const at = { file: file.name, frame: i, t: +t.toFixed(3) };
      for (const tr of tracks) {
        trackRows.push({
          ...at, id: tr.trackId, label: tr.rawLabel, predicted: tr.isPredicted ? 1 : 0,
          x1: Math.round(tr.box[0]), y1: Math.round(tr.box[1]), x2: Math.round(tr.box[2]), y2: Math.round(tr.box[3]),
          ttc: Number.isFinite(tr.ttcSec) ? +tr.ttcSec.toFixed(3) : "", ttc_source: tr.ttcSource ?? "",
          in_path: tr.inCollisionZone ? 1 : 0, level: alertLevelOf(tr), direction: tr.horizontalPosition ?? "",
          distance_m: Number.isFinite(tr.distanceM) ? +tr.distanceM.toFixed(2) : "", risk_pct: Math.round(tr.collisionProbability ?? 0),
        });
      }
      const add = row => { alertRows.push(row); mine.alerts.push(row); };
      for (const [text, pri] of update.speech) add({ ...at, kind: "speech", priority: pri, text });
      for (const cue of detector.sceneSpeech) add({ ...at, kind: cue.kind, priority: C.SPEECH_PRIORITY.scene, text: cue.text });
      // 警示音只記「開始／改變／停止」：每幀都記的話一秒 30 列，看不出什麼時候變了
      const beep = update.beep ? JSON.stringify(update.beep) : "";
      if (beep !== lastBeep) add({ ...at, kind: beep ? "beep" : "beep-stop", priority: "", text: beep });
      lastBeep = beep;
      if (i % 5 === 0) {
        view.getContext("2d").drawImage(grab, 0, 0);
        const left = (performance.now() - started) / (i + 1) * (times.length - i - 1) / 1000;
        log(`${label}「${file.name}」第 ${i + 1}／${times.length} 幀（影片 ${t.toFixed(1)} 秒）｜辨識 ${yolo.backend}${depth ? "＋深度" : ""}｜這段約剩 ${Math.ceil(left)} 秒`);
      }
    }
    return mine;
  } finally {
    URL.revokeObjectURL(video.src);
  }
}

$("file").onchange = () => { $("run").disabled = !$("file").files.length; };
$("run").onclick = () => run().catch(e => { console.error(e); log("錯誤：" + (e.message || e)); });
$("stop").onclick = () => { stopRequested = true; };
$("dlTracks").onclick = () => download(`${baseName}_每幀物體.csv`, toCsv(trackRows));
$("dlAlerts").onclick = () => download(`${baseName}_警報.csv`, toCsv(alertRows));
$("dlSummary").onclick = () => download(`${baseName}_結果摘要.csv`, toCsv(summaryRows));
log("選影片後按「開始分析」。可以一次選多段；實驗二再選標註檔。");
