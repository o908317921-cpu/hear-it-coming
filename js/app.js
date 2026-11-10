// 主程式：開鏡頭 → 每一幀交給偵測器 → 警報規則 → 語音／警示音／震動 → 畫框與面板。
// 全部在手機瀏覽器裡執行，不需要電腦、不需要 Python，影像也不會離開手機。
import { C, loadSettings } from "./config.js";
import { riskColor, focalPx } from "./analysis.js";
import { AlertEngine, frameSummary, sceneSummary } from "./alerts.js";
import { AudioOutput } from "./audio.js";
import { DepthWorker } from "./depth.js";
import { drawOverlay } from "./overlay.js";
import { qrSvg } from "./qr.js";
// detector.js 與 yolo.js 會從 CDN 載入 ONNX Runtime，放到按下開始才載入：
// 寫在最上面的話，沒有網路時整個程式都載不起來，大按鈕按了沒反應，也沒有語音能說明原因
let HazardDetector = null, YoloSegmenter = null;

const $ = id => document.getElementById(id);
const video = $("video"), octx = $("overlay").getContext("2d");
const grab = document.createElement("canvas");
const gctx = grab.getContext("2d", { willReadFrequently: true });
const audio = new AudioOutput();
let yolo = null, depth = null, detector = null, engine = null;
let stream = null, running = false, wasHidden = false, loopTimer = null;
let runId = 0, inFlight = Promise.resolve(), starting = false;  // 每次開始／停止換編號，舊流程自動結束
let lastTracks = [], lastHazards = [], hasFrame = false, stopArmed = 0, stopTimer = null;
// 框要跟得上即時影像：辨識一幀要 0.1～0.3 秒，畫面卻是即時的。最新的辨識結果存在這裡，
// 每次螢幕更新時，依物體自己的速度＋手機轉動的速度，把框移到「現在」應該在的位置再畫
let overlayState = null, overlayRaf = 0, gyroLive = null, gyroLiveAt = -Infinity;
// 分成短句：可以在句子之間示範提示音，警報也能隨時打斷；很長的一句在部分瀏覽器會念到一半停掉
const GUIDE_STEPS = [
  "操作說明。請把手機直立固定在胸前，鏡頭朝向前方，螢幕保持開著。",
  "聽到「危險」，代表約 3 秒內可能撞上。聽到「停」，代表快撞上了，請立刻停下。",
  "這是警示音，越急代表越近，長音最近。戴耳機時，聲音從物體那一側傳來。",
  () => { audio.demoAlarm(); return 1800; },
  "這是系統正常的提示音，大約每 10 秒一聲。",
  () => { audio.statusTone(); return 700; },
  "這是暫時沒有偵測的提示音，聽到它代表目前沒有保護。",
  () => { audio.lostTone(); return 900; },
  "按畫面下方的「目前狀況」，可以聽前方有什麼。",
  "這個系統看不到地面的坑洞與高低差，請繼續使用導盲杖。",
];
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// ---------- 使用者偏好：語速與提示方式，存在手機裡 ----------
const RATES = [["慢", 0.9], ["正常", C.SPEECH_RATE], ["快", 1.4], ["很快", 1.8]];   // 習慣螢幕閱讀器的人常用很快的語速
const MODES = { voice: "語音＋嗶聲", beep: "只有嗶聲" };   // 只有嗶聲：可分離演算法與語音提示的影響（報告研究限制二）
const prefs = { rate: 1, mode: "voice" };
try { Object.assign(prefs, JSON.parse(localStorage.getItem("blindnav-prefs") || "{}")); } catch (e) { /* 無痕模式 */ }
if (!RATES[prefs.rate]) prefs.rate = 1;
if (!MODES[prefs.mode]) prefs.mode = "voice";
function savePrefs() {
  try { localStorage.setItem("blindnav-prefs", JSON.stringify(prefs)); } catch (e) { /* 無痕模式 */ }
  audio.rate = RATES[prefs.rate][1];
  $("rateBtn").textContent = "語速：" + RATES[prefs.rate][0];
  $("modeBtn").textContent = "提示：" + MODES[prefs.mode];
}
let fpsCount = 0, fpsT = performance.now(), fps = 0;
const shownWarnings = new Set();

// ---------- 陀螺儀：鏡頭轉動造成的畫面位移，從物體速度中扣掉 ----------
// 換算成畫面座標的「偏航、俯仰」角速度（rad/s），正值代表背景往右／往下移
let gyroSum = [0, 0], gyroCount = 0, lastFastTurn = -Infinity;
let tiltRatio = 0, tiltSince = null, lastTiltVoice = -Infinity, tiltGap = 20000, uprightSince = null, tiltTold = false;
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (a && a.z != null) {
    const n = Math.hypot(a.x, a.y, a.z);
    if (n > 5) tiltRatio = 0.9 * tiltRatio + 0.1 * a.z / n;
  }
  const r = e.rotationRate;
  if (!r || r.beta == null || r.gamma == null) return;
  const raw = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
  const angle = ((raw % 360) + 360) % 360;
  if (Math.hypot(r.beta, r.gamma) > C.OVERLAY_HIDE_TURN_DEG_S) {
    lastFastTurn = performance.now();
    $("overlay").style.visibility = "hidden";
  }
  const b = r.beta * Math.PI / 180, g = r.gamma * Math.PI / 180;
  const [yaw, pitch] = angle === 90 ? [b, -g] : angle === 270 ? [-b, g] : angle === 180 ? [-g, -b] : [g, b];
  gyroSum[0] += yaw; gyroSum[1] += pitch; gyroCount++;
  // 即時角速度（輕微平滑）：畫框時用，不能等到下一次辨識才知道手機轉了
  gyroLive = gyroLive && performance.now() - gyroLiveAt < 200 ? [0.5 * gyroLive[0] + 0.5 * yaw, 0.5 * gyroLive[1] + 0.5 * pitch] : [yaw, pitch];
  gyroLiveAt = performance.now();
}
async function enableGyro() {
  try {
    // iPhone 必須在使用者點擊時取得權限
    if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === "function") {
      if (await DeviceMotionEvent.requestPermission() !== "granted") return;
    }
    window.addEventListener("devicemotion", onMotion);
  } catch (e) { /* 沒有陀螺儀時改用背景位移比對 */ }
}
// 看不到畫面的人不知道鏡頭對著哪裡：要說清楚往哪邊調，調好也要告訴他；一直沒調整就愈說愈少
setInterval(() => {
  if (!running || !everAlive) { tiltSince = null; return; }
  const now = performance.now();
  if (Math.abs(tiltRatio) < 0.6) {
    tiltSince = null;
    if (uprightSince == null) uprightSince = now;
    if (tiltTold && now - uprightSince >= 1000) { tiltTold = false; audio.say("方向好了", 0); }
    if (now - uprightSince >= 30000) tiltGap = 20000;
    return;
  }
  uprightSince = null;
  if (tiltSince == null) tiltSince = now;
  if (now - tiltSince >= 3000 && now - lastTiltVoice >= tiltGap) {
    lastTiltVoice = now; tiltTold = true; tiltGap = Math.min(tiltGap * 3, 300000);
    // 螢幕朝上時鏡頭朝地；iPhone 回報的 z 正負號跟 Android 相反
    const cameraDown = isIOS ? tiltRatio < 0 : tiltRatio > 0;
    audio.say(cameraDown ? "鏡頭朝向地面，請把手機立起來" : "鏡頭朝向天空，請把手機往下壓", 0);
  }
}, 500);
function takeGyro() {
  if (!gyroCount) return null;
  const v = [gyroSum[0] / gyroCount, gyroSum[1] / gyroCount];
  gyroSum = [0, 0]; gyroCount = 0;
  return v.every(x => Number.isFinite(x) && Math.abs(x) < 50) ? v : null;
}

// ---------- 鏡頭監看：來電或其他 App 搶走鏡頭時，畫面會停住但不會有任何錯誤 ----------
let lastVideoTime = -1, lastVideoChange = 0, cameraRestarting = false, videoFrozen = false;
const CAMERA_OPTIONS = { video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false };
setInterval(async () => {
  const now = performance.now();
  if (!running || document.hidden) { lastVideoChange = now; return; }
  const track = stream && stream.getVideoTracks()[0];
  const trackOk = track && track.readyState === "live" && !track.muted;   // 被搶走時軌道會結束或靜音
  if (trackOk && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    lastVideoChange = now;
    if (videoFrozen) {
      videoFrozen = false;
      lastResultAt = now;
      // 中斷期間物體都動過了，幀率統計也不算數
      inFlight.catch(() => {}).then(() => { if (running) { detector.reset(); engine = new AlertEngine(); } });
    }
    return;
  }
  if (now - lastVideoChange < 2500) return;
  videoFrozen = true;      // 要不要說、怎麼說，統一由下面的 protectionState 決定
  audio.beep = null;
  hasFrame = false;
  if (cameraRestarting) return;
  cameraRestarting = true;
  try {
    const fresh = await navigator.mediaDevices.getUserMedia(CAMERA_OPTIONS);
    if (running) {
      if (stream) stream.getTracks().forEach(t => t.stop());
      stream = fresh;
      video.srcObject = fresh;
      await video.play();
    } else {
      fresh.getTracks().forEach(t => t.stop());
    }
  } catch (e) { /* 下一輪再試 */ }
  cameraRestarting = false;
}, 1000);

// ---------- 狀態列與面板 ----------
function setConn(state, text) {
  const c = $("conn");
  c.className = "pill " + state;
  c.lastElementChild.textContent = text;
}
function setBanner(kind, text) {
  const b = $("banner");
  b.className = kind;
  if (b.textContent !== text) b.textContent = text;
}
function setBar(id, ratio, color) {
  const f = $(id).firstElementChild;
  f.style.width = (Math.max(0, Math.min(1, ratio)) * 100) + "%";
  f.style.backgroundColor = color;
}
function setValue(id, text, color) { const e = $(id); e.textContent = text; e.style.color = color || ""; }
function setupTicks() {
  const put = (id, ratios) => {
    const bar = $(id);
    bar.querySelectorAll(".tick").forEach(t => t.remove());
    for (const r of ratios) {
      const t = document.createElement("i");
      t.className = "tick";
      t.style.left = (r * 100) + "%";
      bar.appendChild(t);
    }
  };
  put("speedBar", [C.GROWTH_WALK_MAX_PCT_S / C.GROWTH_GAUGE_MAX_PCT_S, C.GROWTH_RUN_MIN_PCT_S / C.GROWTH_GAUGE_MAX_PCT_S]);
  put("probBar", [C.PROBABILITY_ORANGE_PCT / 100, C.PROBABILITY_RED_PCT / 100]);
  put("distBar", [C.PROXIMITY_ORANGE_RATIO / C.PROXIMITY_FULL_RATIO, C.PROXIMITY_RED_RATIO / C.PROXIMITY_FULL_RATIO]);
}
const levelOfSpeed = { slow: "GREEN", medium: "ORANGE", fast: "RED" };

function updatePanel(summary, update, staticHazards) {
  const sp = summary.fastest;
  if (sp) {
    const c = C.LEVEL_COLORS[levelOfSpeed[sp.level]];
    setBar("speedBar", sp.pct / C.GROWTH_GAUGE_MAX_PCT_S, c);
    setValue("speedValue", sp.text, sp.level !== "slow" ? c : "");
    $("speedDetail").textContent = `${sp.label}｜速度指數 ${Math.round(sp.pct)}`;
  } else {
    setBar("speedBar", 0, C.LEVEL_COLORS.GREEN); setValue("speedValue", "--"); $("speedDetail").textContent = "尚無偵測物體";
  }
  const r = summary.highest;
  if (r) {
    const c = riskColor(r.probability);
    setBar("probBar", r.probability / 100, c);
    setValue("probValue", Math.round(r.probability) + "%", r.probability >= C.PROBABILITY_ORANGE_PCT ? c : "");
    $("probDetail").textContent = [r.label, r.reason, r.ttc != null ? `TTC ${r.ttc.toFixed(1)} 秒` : ""].filter(Boolean).join("｜");
  } else {
    setBar("probBar", 0, C.LEVEL_COLORS.GREEN); setValue("probValue", "--"); $("probDetail").textContent = "尚無碰撞風險";
  }
  const p = summary.person;
  if (p) {
    const c = C.LEVEL_COLORS[p.level];
    setBar("distBar", p.occupancy / C.PROXIMITY_FULL_RATIO, c);
    setValue("distValue", C.PROXIMITY_TEXT[p.level], c);
    $("distDetail").textContent = [C.DIRECTION_TEXT[p.direction] + "行人", `佔畫面 ${Math.round(p.occupancy * 100)}%`,
      Number.isFinite(p.distanceM) ? `約 ${p.distanceM.toFixed(1)} 公尺` : ""].filter(Boolean).join("｜");
  } else {
    setBar("distBar", 0, C.LEVEL_COLORS.GREEN); setValue("distValue", "--"); $("distDetail").textContent = "尚未偵測到行人";
  }
  const staticText = update.alarmOn.static && (staticHazards[0] ? staticHazards[0].label : "前方障礙");
  const texts = [update.alarmOn.ttc && "即將撞上", staticText, update.alarmOn.proximity && "物體過近", update.alarmOn.speed && "速度過快"].filter(Boolean);
  if (texts.length) setBanner("red", "⚠ " + texts.join("、"));
  else if (update.cameraBlocked) setBanner("warn", C.CAMERA_BLOCKED_TEXT);
  else if (update.lowLight) setBanner("warn", C.LOW_LIGHT_TEXT);
  else if (update.lowFps) setBanner("warn", C.LOW_FPS_TEXT);
  else setBanner("", "目前沒有警報");
}

function depthStatus() {
  if (!depth) return "深度：關閉";
  if (depth.error) return "深度：停用";
  if (!depth.ready) return `深度：載入中 ${Number.isFinite(depth.progress) ? Math.round(depth.progress * 100) + "%" : ""}`;
  return `深度 ${Math.round(depth.lastMs)} ms`;
}

let depthSlowWarned = false, depthReadyTold = true;
function showWarnings() {
  if (depth && depth.ready && !depthReadyTold) {
    depthReadyTold = true;
    audio.say("頭上障礙的偵測已經開始", 0);
  }
  // 深度模型卡住時不會有任何錯誤，結果只是一直沒回來
  if (depth && !depthSlowWarned && depth.busy && performance.now() - depth.busySince > 3 * C.DEPTH_MAX_AGE_SEC * 1000) {
    depthSlowWarned = true;
    $("notice").textContent = "深度模型沒有回應，頭部高度障礙可能偵測不到。";
    audio.say("這支手機算得比較慢，頭上的障礙可能偵測不到", 0);
  }
  // 連續好幾次超過期限：結果用不到，等於沒有頭上障礙偵測，要讓使用者知道
  if (depth && !depthSlowWarned && depth.slowRuns >= 3) {
    depthSlowWarned = true;
    $("notice").textContent = "這支手機算深度太慢，頭部高度障礙可能偵測不到。";
    audio.say("這支手機算得比較慢，頭上的障礙可能偵測不到", 0);
  }
  if (depth && depth.error && !shownWarnings.has(depth.error)) {
    shownWarnings.add(depth.error);
    console.warn(depth.error);
    $("notice").textContent = depth.error;
    audio.say(C.STATIC_UNAVAILABLE_TEXT, 1, true);
  }
}

// ---------- 保護狀態：使用者現在到底有沒有被保護，只由這裡決定要說什麼 ----------
const NO_RESULT_MS = 2500;        // 這麼久沒有新結果：算「暫時沒有偵測」，先響提示音
const LOST_VOICE_AFTER_MS = 3000; // 持續這麼久才開口，短暫卡頓不打擾使用者
const LOST_TONE_MS = 3000;        // 沒有偵測時，每隔這麼久響一次提示音
const LOST_TEXT = {
  camera: "鏡頭中斷，目前沒有偵測，正在重新開啟",
  stalled: "辨識暫時卡住，目前沒有偵測",
};
const LOW_MEMORY_DAYS = 7;        // 手機可能只是剛好開太多 App：省記憶體模式過幾天後再試一般模式
let lastReport = 0;
let everAlive = false, resumePending = false, cameraBlocked = false, frontCamera = false, gpuFallbackTried = false, engineBroken = false;
let lastResultAt = 0, lastStartVoice = 0;
let lostSince = null, toldLost = false, lastLostVoice = -Infinity, lostVoiceGap = 30000, lastLostTone = -Infinity;
function protectionState() {
  if (!running || document.hidden) return "paused";
  if (videoFrozen) return "camera";
  if (!everAlive) return "starting";
  return performance.now() - lastResultAt <= NO_RESULT_MS ? "ok" : "stalled";
}
setInterval(() => {
  const state = protectionState(), now = performance.now();
  audio.paused = state !== "ok" || cameraBlocked;     // 系統真的在看的時候，才響「系統正常」的提示音
  if (state === "paused") { lostSince = null; return; }
  if (state === "ok") {
    if (lostSince != null) {
      lostSince = null;
      setConn("ok", "偵測中");
      if (toldLost) { toldLost = false; audio.say(C.RESUME_TEXT, 3, true); }   // 有說斷才說恢復，一閃而過的卡頓完全不出聲
    }
    if (now - lastLostVoice >= 120000) lostVoiceGap = 30000;
    return;
  }
  if (state === "starting") {
    if (now - lastStartVoice < 12000) return;
    lastStartVoice = now;
    audio.say("還在載入，請稍候", 0, true);
    return;
  }
  if (lostSince == null) {
    lostSince = now;
    audio.beep = null;
    setConn("bad", state === "camera" ? "鏡頭中斷" : "辨識卡住");
  }
  setBanner("lost", LOST_TEXT[state]);   // 「沒有保護」要和光線不足等一般提醒（warn）分得出來
  if (now - lastLostTone >= LOST_TONE_MS) {
    lastLostTone = now;
    if (audio.enabled) audio.lostTone();
    if (navigator.vibrate) navigator.vibrate([120, 100, 120]);
  }
  // 持續才開口；之後愈說愈少，提示音會一直響，不必靠語音一直講
  if (now - lostSince >= LOST_VOICE_AFTER_MS && now - lastLostVoice >= lostVoiceGap) {
    lastLostVoice = now; toldLost = true; lostVoiceGap = Math.min(lostVoiceGap * 2, 120000);
    audio.say(LOST_TEXT[state], 3, true);
  }
}, 250);

// ---------- 分析迴圈：處理完一幀才拿下一幀，手機較慢時自動降幀，不會越積越延遲 ----------
class AnalysisStuck extends Error {
  constructor() { super("辨識沒有回應"); }
}

// 只算畫面看得到的時間：切換 App、講電話時瀏覽器本來就會暫停運算，不能當成卡住
function withWatchdog(promise) {
  return new Promise((resolve, reject) => {
    let visibleMs = 0;
    const tick = setInterval(() => {
      if (!document.hidden) visibleMs += 1000;
      if (visibleMs >= C.ANALYSIS_TIMEOUT_MS) { clearInterval(tick); reject(new AnalysisStuck()); }
    }, 1000);
    promise.then(v => { clearInterval(tick); resolve(v); }, e => { clearInterval(tick); reject(e); });
  });
}

async function loop(id) {
  if (!running || id !== runId) return;
  const started = performance.now();
  try {
    if (video.readyState >= 2 && video.videoWidth && !document.hidden && !videoFrozen) {
      inFlight = processFrame(started / 1000, id);
      await withWatchdog(inFlight);
    }
  } catch (e) {
    const wasGpu = yolo?.backend === "webgpu";
    if (e instanceof AnalysisStuck) {
      // 卡住的模型不能再用，也不能讓下一次開始一直等它（就算已經按了停止也要清掉）
      inFlight = Promise.resolve();
      yolo = null;
      detector = null;
    }
    if (id !== runId) return;   // 已經按了停止，這一幀的錯誤不用管
    console.error(e);
    // 顯示晶片出問題（手機記憶體不夠、驅動程式錯誤）不要直接放棄：改用 CPU 繼續，慢一點也比沒有保護好
    if (wasGpu && !gpuFallbackTried && YoloSegmenter) {
      gpuFallbackTried = true;
      audio.say("顯示晶片出了問題，改用比較慢的方式繼續偵測", 3, true);
      try {
        yolo = await YoloSegmenter.loadWasm();
        detector = new HazardDetector(yolo, depth);
        detector.reset();
        engine = new AlertEngine();
        $("notice").textContent = "顯示晶片出了問題，已改用 CPU 繼續偵測，警報可能較晚。";
        if (running && id === runId) loopTimer = setTimeout(() => loop(id), 0);
        return;
      } catch (e2) {
        console.error(e2);
      }
    }
    const message = "分析時發生錯誤，偵測已停止：" + (e.message || e);
    stopAll();
    $("startError").textContent = message + "。按開始可以再試一次。";
    audio.say("辨識發生問題，偵測已停止，目前沒有偵測。按開始可以再試一次。", 4, true);
    return;
  }
  if (!running || id !== runId) return;
  const elapsed = performance.now() - started;
  loopTimer = setTimeout(() => loop(id), Math.max(0, 1000 / C.MAX_FPS - elapsed));
}

// 把最新的辨識結果推算到現在再畫：位移 =（物體自己的速度 + 手機轉動造成的畫面移動）× 經過的時間。
// 手機轉動優先用陀螺儀的即時讀數（每秒幾十次），沒有陀螺儀時用上一幀背景比對的結果
function shiftBox([x1, y1, x2, y2], dx, dy) { return [x1 + dx, y1 + dy, x2 + dx, y2 + dy]; }
let lastOverlayDraw = 0;
function renderOverlay(t) {
  overlayRaf = 0;
  const s = overlayState;
  if (!s || !running) return;
  overlayRaf = requestAnimationFrame(renderOverlay);
  if (t - lastOverlayDraw < C.OVERLAY_MIN_FRAME_MS) return;   // 慢手機不要每次螢幕更新都畫：運算要留給辨識
  lastOverlayDraw = t;
  const dt = Math.min(C.OVERLAY_MAX_EXTRAPOLATE_SEC, Math.max(0, (performance.now() - s.capturedAt) / 1000));
  let [cvx, cvy] = s.cameraV;
  if (gyroLive && performance.now() - gyroLiveAt < 200) {
    const f = focalPx(s.w, s.h) * C.GYRO_GAIN;
    [cvx, cvy] = [f * gyroLive[0], f * gyroLive[1]];
  }
  const tracks = s.tracks.map(tr => {
    const dx = ((tr.vx || 0) + cvx) * dt, dy = ((tr.vy || 0) + cvy) * dt;
    return {
      ...tr, box: shiftBox(tr.box, dx, dy),
      mask: tr.mask && !tr.mask.boxOnly ? { ...tr.mask, x: tr.mask.x + dx, y: tr.mask.y + dy } : tr.mask,
      predictedPoint: tr.predictedPoint ? [tr.predictedPoint[0] + dx, tr.predictedPoint[1] + dy] : tr.predictedPoint,
    };
  });
  // 靜態障礙不會自己動，只跟著手機轉動移動
  const staticHazards = s.staticHazards.map(hz => ({ ...hz, box: shiftBox(hz.box, cvx * dt, cvy * dt) }));
  drawOverlay(octx, s.w, s.h, tracks, { pathCenterX: s.pathCenterX, staticHazards });
}

async function processFrame(now, id) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const k = Math.min(1, C.MAX_FRAME_SIDE / Math.max(vw, vh));
  const w = Math.round(vw * k), h = Math.round(vh * k);
  if (grab.width !== w || grab.height !== h) {
    // 手機旋轉：畫面尺寸與所有物體的位置都變了，舊軌跡不能用，否則框大小一跳就被當成有東西衝過來
    if (grab.width > 1 && hasFrame) { detector.reset(); engine = new AlertEngine(); }
    grab.width = w; grab.height = h;
    $("stage").style.aspectRatio = `${vw} / ${vh}`;
  }
  const capturedAt = performance.now();     // 這一幀的拍攝時間：框要從這裡往後推算
  gctx.drawImage(video, 0, 0, w, h);
  const frame = { canvas: grab, imageData: gctx.getImageData(0, 0, w, h), width: w, height: h };

  const procStart = performance.now();
  const tracks = await detector.process(frame, now, takeGyro());
  const procMs = performance.now() - procStart;
  if (!running || id !== runId) return;   // 等待辨識時已經按了停止，或這一幀已被判定卡住
  const staticHazards = detector.staticHazards;
  lastTracks = tracks.filter(tr => !tr.isPredicted); lastHazards = staticHazards; hasFrame = true;
  lastResultAt = performance.now();
  // 真的算出第一幀才說準備好；真的又有結果才說恢復，不能說了卻其實還沒恢復
  if (!everAlive) {
    everAlive = true;
    try { localStorage.removeItem("blindnav-loading"); } catch (e) { /* 無痕模式 */ }
    setConn("ok", "偵測中");
    announceReady();
  }
  else if (resumePending) audio.say(C.RESUME_TEXT, 3, true);
  resumePending = false;
  const update = engine.update(tracks, now, audio.alarmSpeaking(),
    { brightness: detector.brightness, frameWidth: w, staticHazards });

  // 分析已暫停時不能繼續響舊的警示音（這一幀可能是暫停前就開始算的）
  audio.beep = (videoFrozen || document.hidden) ? null : update.beep;
  audio.beepPan = update.beepPan;
  cameraBlocked = update.cameraBlocked;
  // 「只有嗶聲」模式不念物體警報，光線不足等系統提醒（優先順序 0）照念；「停」攸關安全，一定要念
  // 「警報解除」也不念：這個模式根本沒念過警報
  for (const [text, pri] of update.speech) {
    if (prefs.mode === "voice" || (pri === 0 && text !== C.CLEAR_TEXT) || pri >= 4) audio.say(text, pri);
  }
  for (const [text, dir] of update.alerts) {
    console.info("[警報]", text, dir ? C.DIRECTION_TEXT[dir] : "");
    window.blindnavLog?.("alert", { text, dir, tracks: tracks.slice(0, 6).map(tr => [tr.rawLabel, tr.box, Number.isFinite(tr.ttcSec) ? +tr.ttcSec.toFixed(1) : null, tr.proximityLevel]) });
  }

  // 畫面用鏡頭的即時影像（順）；框由 renderOverlay 在每次螢幕更新時推算到現在的位置。手機轉得太快時仍先不畫
  overlayState = { w, h, tracks, staticHazards, capturedAt, pathCenterX: detector.cameraMotion.pathCenterX,
    cameraV: [detector.cameraMotion.vx, detector.cameraMotion.vy] };
  if (!overlayRaf) overlayRaf = requestAnimationFrame(renderOverlay);
  $("overlay").style.visibility = performance.now() - lastFastTurn < 300 ? "hidden" : "visible";
  updatePanel(frameSummary(tracks), update, staticHazards);
  showWarnings();

  // 診斷：每 3 秒回報一次目前看到什麼（數字與類別，沒有影像）
  if (performance.now() - lastReport > 3000) {
    lastReport = performance.now();
    window.blindnavLog?.("frame", { backend: yolo.backend, size: yolo.size, w, h, video: `${vw}x${vh}`, fps: +fps.toFixed(1), detectMs: Math.round(detector.lastDetectMs),
      depthMs: depth ? Math.round(depth.lastMs) : null, depthReady: depth?.ready ?? null, brightness: Math.round(detector.brightness),
      tracks: tracks.slice(0, 12).map(tr => ({ id: tr.trackId, c: tr.rawLabel, box: tr.box, occ: +tr.occupancyRatio.toFixed(3), d: Number.isFinite(tr.distanceM) ? +tr.distanceM.toFixed(1) : null,
        ttc: Number.isFinite(tr.ttcSec) ? +tr.ttcSec.toFixed(1) : null, zone: tr.inCollisionZone, course: tr.onCourse, level: tr.proximityLevel, pred: !!tr.isPredicted, risk: Math.round(tr.collisionProbability) })),
      hazards: staticHazards.map(h => h.label), said: update.speech.map(s => s[0]) });
  }
  fpsCount++;
  const t = performance.now();
  if (t - fpsT >= 1000) { fps = fpsCount * 1000 / (t - fpsT); fpsCount = 0; fpsT = t; }
  const motion = { gyro: "陀螺儀", flow: "背景比對", "gyro+flow": "陀螺儀＋背景比對" }[detector.cameraMotion.source];
  $("stats").textContent = `${fps.toFixed(1)} FPS · 每幀 ${procMs.toFixed(0)} ms · YOLO ${yolo.backend.toUpperCase()} `
    + `${detector.lastDetectMs.toFixed(0)} ms · ${depthStatus()}` + (motion ? ` · 晃動補償：${motion}` : "");
}

// ---------- 載入模型（第一次約 20～35 MB，之後從瀏覽器快取讀取）----------
let yoloLoading = null;
async function loadModels(id) {
  if (yolo) return;
  if (!yoloLoading) yoloLoading = loadYolo(id).finally(() => { yoloLoading = null; });
  await yoloLoading;
}
async function loadYolo(id) {
  const modules = await Promise.all([import("./detector.js"), import("./yolo.js")]);
  HazardDetector = modules[0].HazardDetector;
  YoloSegmenter = modules[1].YoloSegmenter;
  setConn("wait", "下載辨識模型…");
  setBanner("idle", "下載辨識模型…（第一次約 20～35 MB，建議連 Wi-Fi）");
  // 第一次下載可能要一兩分鐘，看不到進度條的人要用聽的才知道還在動
  let percent = null;
  const tick = setInterval(() => {
    if (id !== runId) return;     // 已經按了停止，不要再報進度
    audio.say(percent == null ? "還在下載，請稍候" : percent >= 100 ? "下載好了，正在準備" : `已下載百分之 ${percent}`, 0);
  }, 15000);
  try {
    yolo = await YoloSegmenter.load(p => {
      if (Number.isFinite(p)) {
        percent = Math.round(p * 100);
        // 下載完還要準備一段時間：停在 100% 看起來像當掉
        setBanner("idle", percent >= 100 ? "下載好了，正在準備辨識模型，請稍候…" : `下載辨識模型… ${percent}%`);
      }
    });
  } finally {
    clearInterval(tick);
  }
}

// ---------- 啟動／停止（iPhone 規定聲音必須在使用者點擊後才能播放）----------
let wakeLock = null;
async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
    // 省電模式等原因可能讓系統收回：螢幕一關偵測就停，要馬上要回來
    wakeLock?.addEventListener("release", () => { if (running && !document.hidden) requestWakeLock(); });
  } catch (e) { /* 不支援時略過 */ }
}

// iPhone 切換 App 或鎖定螢幕時鏡頭一定會停；回到頁面時重新取得常亮並用語音告知已恢復
document.addEventListener("visibilitychange", () => {
  if (!running && !starting) return;
  if (document.visibilityState === "hidden") {
    wasHidden = true;
    audio.beep = null;
    audio.stopSteps();
    audio.say("偵測已暫停，回到這個網頁才會繼續", 3, true);
    return;
  }
  requestWakeLock();
  video.play().catch(() => {});
  audio.ctx?.resume();
  if (wasHidden) {
    wasHidden = false;
    // 暫停期間物體都動過了，舊軌跡繼續用會算出錯誤的速度與 TTC
    hasFrame = false;
    lastResultAt = lastVideoChange = performance.now();
    resumePending = everAlive;
    inFlight.catch(() => {}).then(() => { if (running) { detector.reset(); engine = new AlertEngine(); } });
  }
});

function startErrorText(e) {
  if (e.message === "insecure") return "這個網址不能使用鏡頭，網址必須是 https 開頭。";
  if (e.name === "NotAllowedError") return "相機權限被拒絕。請到瀏覽器的網站設定開啟相機，再重新整理這個網頁。";
  if (e.name === "NotFoundError" || e.name === "OverconstrainedError") return "這支手機找不到可以使用的鏡頭。";
  if (e.name === "NotReadableError") return "鏡頭正被其他 App 使用。請關閉那個 App，再按一次開始。";
  if (e.name === "ModelLoadError") return navigator.onLine === false
    ? "手機沒有網路，第一次使用要下載辨識模型。連上網路後再按一次開始。"
    : "辨識模型載入失敗。請確認網路後，再按一次開始。";
  return "無法開啟鏡頭，請重新整理網頁再試一次。";
}
// 第一幀算出來才念：有些手機要等好幾秒，還沒開始看就說準備好，會讓人以為已經有保護
function announceReady() {
  const steps = ["準備好了，開始偵測。"];
  if (frontCamera) steps.push("目前用的是前鏡頭，請改用有後鏡頭的手機。");
  if (!navigator.wakeLock) steps.push("這支手機可能會自動鎖定螢幕，螢幕一關偵測就會停止，請把自動鎖定關閉。");
  // 新的 iPhone 也走這條路，速度不一定慢：只說真正的差別。真的太慢時，警報規則會另外說「偵測變慢」
  if (yolo.backend === "wasm" && !C.DEPTH_ON_WASM) steps.push("這支手機不會提醒頭上的障礙。");
  else if (depth && !depthReadyTold) steps.push("頭上障礙的偵測還在載入，行人和車輛已經可以偵測。");
  audio.speakSteps(steps);
  $("sceneBtn").focus();
}
$("startBtn").onclick = async () => {
  if (starting) return;
  // 辨識引擎初始化失敗後，同一個網頁裡不能再試：重新載入才有機會，事先說清楚，免得以為按了沒反應
  if (engineBroken) {
    audio.say("重新載入網頁，等一下請再按一次開始", 3, true);
    $("startError").textContent = "重新載入網頁，等一下請再按一次開始。";
    $("startBtn").disabled = true;
    setTimeout(() => location.reload(), 3500);
    return;
  }
  starting = true;
  window.blindnavStarted = true;      // 開始偵測後不要再自動重新整理（見 index.html）
  const id = ++runId;
  $("startError").textContent = "";
  $("startBtn").disabled = true;
  try {
    // 這三件事都要在點擊當下同步呼叫，iPhone 才允許語音、聲音與動作感測器
    let firstTime = true;
    try { firstTime = !localStorage.getItem("blindnav-started"); } catch (e) { /* 無痕模式 */ }
    // 權限視窗沒有聲音提示，事先說清楚會發生什麼
    audio.say(firstTime ? "正在啟動。手機會詢問相機權限，請按允許。" : "正在啟動，請稍候", 1);
    if (navigator.vibrate) navigator.vibrate(60);
    // 第一次下載可能要好幾分鐘：螢幕自動關掉的話下載會中斷，要從按下開始就保持常亮
    requestWakeLock();
    const gyroReady = enableGyro();
    const audioReady = audio.unlock();
    await audioReady;
    await gyroReady;
    await inFlight.catch(() => {});     // 上一輪還在跑的辨識要等它結束，模型不能同時跑兩次
    if (!navigator.mediaDevices) throw new Error("insecure");
    stream = await navigator.mediaDevices.getUserMedia(CAMERA_OPTIONS);
    video.srcObject = stream;
    // 省電模式等情況下 play() 可能一直不回應：等一下就繼續，鏡頭監看會處理真的沒畫面的情況
    await Promise.race([video.play().catch(e => { if (e.name !== "AbortError") throw e; }), new Promise(ok => setTimeout(ok, 5000))]);
    $("stage").style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    frontCamera = stream.getVideoTracks()[0]?.getSettings?.().facingMode === "user";
    try { localStorage.setItem("blindnav-started", "1"); } catch (e) { /* 無痕模式 */ }
    everAlive = false; resumePending = false; cameraBlocked = false;
    lostSince = null; toldLost = false; lostVoiceGap = 30000;
    lastResultAt = lastStartVoice = lastVideoChange = performance.now();
    $("intro").hidden = true;
    $("app").inert = false;
    $("stopBtn").focus();
    // 手機記憶體不夠時，系統會直接關掉分頁，程式完全沒有機會處理；重新開啟後只會發現上次沒做完。
    // 這時改用省記憶體的方式（CPU、小模型、不跑深度），不要讓使用者一直卡在同一個地方。
    let lowMemory = false;
    try {
      lowMemory = navigator.deviceMemory > 0 && navigator.deviceMemory <= C.LOW_MEMORY_GB
        || Date.now() - Number(localStorage.getItem("blindnav-low-memory") || 0) < LOW_MEMORY_DAYS * 86400000;
      if (localStorage.getItem("blindnav-loading") === "1") {
        lowMemory = true;
        localStorage.setItem("blindnav-low-memory", String(Date.now()));
        audio.say("上次載入時網頁被關掉了，這次改用比較省記憶體的方式", 1, true);
      }
      localStorage.setItem("blindnav-loading", "1");
    } catch (e) { /* 無痕模式 */ }
    if (lowMemory) C.USE_WEBGPU = false;
    try {
      await loadModels(id);
    } catch (e) {
      console.error(e);
      engineBroken = !yolo && !e.isDownload;
      const failed = new Error(e.message || String(e));
      failed.name = "ModelLoadError";
      throw failed;
    }
    if (id !== runId) return;           // 載入模型時已經按了停止
    // 只有 WASM 的手機每秒僅約 4 幀（報告實驗四），運算要留給碰撞偵測
    if (C.DEPTH_ENABLED && !depth && (yolo.backend !== "wasm" || C.DEPTH_ON_WASM)) { depth = new DepthWorker(); depth.start(); }
    if (yolo.backend === "wasm" && !C.DEPTH_ON_WASM) $("notice").textContent = "這支手機不偵測頭部高度障礙，只提醒行人、車輛與路上的障礙物。";
    detector = detector || new HazardDetector(yolo, depth);
    detector.reset();
    engine = new AlertEngine();
    lastTracks = []; lastHazards = []; hasFrame = false;
    running = true;
    audio.start();
    requestWakeLock();
    setConn("wait", "載入中…");
    lastResultAt = lastStartVoice = lastVideoChange = performance.now();
    // 深度模型第一次運算會佔住顯示晶片好幾秒，辨識也會跟著停：開始走之前先做完，最多等一下，網路慢時不能讓人一直等
    const waitUntil = performance.now() + C.DEPTH_WARMUP_WAIT_SEC * 1000;
    while (depth && !depth.ready && !depth.error && performance.now() < waitUntil && id === runId) {
      await new Promise(ok => setTimeout(ok, 200));
    }
    if (id !== runId) return;
    depthReadyTold = !depth || depth.ready || !!depth.error;
    lastResultAt = lastVideoChange = performance.now();
    loop(id);
  } catch (e) {
    console.error(e);
    const message = startErrorText(e);
    try { localStorage.removeItem("blindnav-loading"); } catch (e2) { /* 無痕模式 */ }
    stopAll();
    // 畫面多顯示技術細節（語音不念）：回報問題時看得到真正的原因
    $("startError").textContent = message + `（${e.name}: ${String(e.message || e).slice(0, 160)}）`;
    audio.say(message, 3, true);
  } finally {
    if (id === runId || !running) {
      starting = false;
      $("startBtn").disabled = false;
    }
  }
};

function stopAll() {
  running = false;
  try { localStorage.removeItem("blindnav-loading"); } catch (e) { /* 無痕模式 */ }
  runId++;
  clearTimeout(loopTimer);
  audio.stop();
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  overlayState = null; cancelAnimationFrame(overlayRaf); overlayRaf = 0;
  octx.clearRect(0, 0, octx.canvas.width, octx.canvas.height);   // 下次開始前不能留著舊畫面
  wakeLock?.release().catch(() => {});     // 停止後螢幕可以正常關閉，省電
  wakeLock = null;
  videoFrozen = audio.paused = false;
  everAlive = false; resumePending = false; cameraBlocked = false; lostSince = null; toldLost = false;
  lastTracks = []; lastHazards = []; hasFrame = false;
  $("app").inert = true;     // 開始畫面蓋住主畫面時，螢幕閱讀器不能摸到後面的按鈕
  setConn("wait", "已停止");
  $("intro").hidden = false;
}
function playVoiceGuide() {
  $("startError").textContent = "";
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
    $("startError").textContent = "此瀏覽器不支援語音播報，請改用支援語音的瀏覽器。";
    $("notice").textContent = "此瀏覽器不支援語音播報。";
    return;
  }
  $("notice").textContent = "";
  audio.unlock();              // 說明裡要示範提示音，開始偵測之前也要有聲音
  audio.setEnabled(true);
  $("voiceBtn").textContent = "🔊 聲音 開";
  $("voiceBtn").setAttribute("aria-pressed", "true");
  audio.hush();
  audio.speakSteps(GUIDE_STEPS);    // 優先順序最低：任何警報都可以打斷
}
$("helpBtn").onclick = playVoiceGuide;
$("helpNowBtn").onclick = playVoiceGuide;
// 停止要按兩次：走路時誤觸不會讓保護突然消失
$("stopBtn").onclick = () => {
  const now = performance.now();
  if (now - stopArmed > 3000) {
    stopArmed = now;
    $("stopBtn").textContent = "再按一次停止";
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => { $("stopBtn").textContent = "■ 停止"; }, 3000);
    audio.say("再按一次停止偵測", 3, true);
    return;
  }
  stopArmed = 0;
  clearTimeout(stopTimer);
  $("stopBtn").textContent = "■ 停止";
  stopAll();
  // 下載模型中也可以停止，開始鍵要馬上能再按（下載會在背景繼續）
  starting = false;
  $("startBtn").disabled = false;
  $("startBtn").focus();
  audio.say("偵測已停止。", 1, true);
  if (navigator.vibrate) navigator.vibrate([60, 80, 60]);
};
// 按了就是想聽，聲音關閉時也念；優先順序低，真的有危險時會被打斷。畫面任一處都可以按，不用找按鈕
$("sceneBtn").onclick = $("stage").onclick = $("banner").onclick = () => {
  // 按了就是現在想聽：打斷操作說明，不要排在長句後面；正在念警報時排在警報後面
  if (audio.speakingPri <= 0) { audio.stopSteps(); audio.hush(); }
  if (navigator.vibrate) navigator.vibrate(30);
  const state = protectionState();
  const scene = hasFrame ? (cameraBlocked ? C.CAMERA_BLOCKED_TEXT + "。" : "") + sceneSummary(lastTracks, lastHazards)
    + (depth && !depth.ready && !depth.error ? "頭上障礙還沒開始偵測。" : "") : "";
  audio.say(LOST_TEXT[state] || (state === "starting" ? "正在啟動，請稍候" : (scene || "正在分析，請稍候")), 0, true);
};
$("rateBtn").onclick = () => {
  prefs.rate = (prefs.rate + 1) % RATES.length;
  savePrefs();
  audio.stopSteps(); audio.hush();
  audio.say("語速" + RATES[prefs.rate][0], 1, true);
};
$("modeBtn").onclick = () => {
  prefs.mode = prefs.mode === "voice" ? "beep" : "voice";
  savePrefs();
  audio.stopSteps(); audio.hush();
  audio.say("提示方式：" + MODES[prefs.mode], 1, true);
};
// 看不到電量的人，手機沒電就是保護突然消失：電量低時提早說（不支援的瀏覽器略過）
navigator.getBattery?.().then(b => {
  const told = new Set();
  const check = () => {
    if (!running || b.charging) return;
    for (const level of [0.2, 0.1, 0.05]) {
      if (b.level <= level && !told.has(level)) {
        told.add(level);
        const left = Math.round(b.level * 100);
        audio.say(left <= 5 ? `手機電量剩百分之 ${left}，偵測可能很快就會停止` : `手機電量剩百分之 ${left}`, 1, true);
        break;
      }
    }
  };
  b.addEventListener("levelchange", check);
  setInterval(check, 60000);
}).catch(() => {});
// 使用者自己離開或重新整理不算當掉（當掉時不會有這個事件）
window.addEventListener("pagehide", () => { try { localStorage.removeItem("blindnav-loading"); } catch (e) { /* 無痕模式 */ } });
// 瀏覽器不能語音，或手機沒有中文語音（會聽不到或亂念）：改讓螢幕閱讀器念狀態列，也要說清楚怎麼解決
function checkChineseVoice() {
  const voices = window.speechSynthesis?.getVoices() || [];
  if (window.speechSynthesis && !voices.length) return;      // 語音清單還沒載入，等 voiceschanged
  if (voices.some(v => /^(zh|cmn|yue)/i.test(v.lang))) return;
  $("banner").setAttribute("aria-live", "assertive");
  const text = window.speechSynthesis
    ? "這支手機沒有中文語音，請到手機設定的文字轉語音安裝中文語音。警示音與震動仍然有效。"
    : "這個瀏覽器不支援語音播報，請改用 Chrome 或 Safari。警示音與震動仍然有效。";
  if (!$("startError").textContent) $("startError").textContent = text;
}
checkChineseVoice();
window.speechSynthesis?.addEventListener?.("voiceschanged", checkChineseVoice);
$("app").inert = true;
$("voiceBtn").onclick = () => {
  audio.setEnabled(!audio.enabled);
  $("voiceBtn").textContent = audio.enabled ? "🔊 聲音 開" : "🔇 聲音 關";
  $("voiceBtn").setAttribute("aria-pressed", String(audio.enabled));
  // 要說實話：iPhone 網頁不能震動
  audio.say(audio.enabled ? "聲音開啟"
    : (navigator.vibrate ? "聲音關閉，警報改用震動，只有「停」會念出來" : "聲音關閉，這支手機不能震動，只有「停」會念出來"), 1, true);
};

// ---------- 開啟網頁時：讀取 settings.json ----------
// 用電腦開啟時（有滑鼠的螢幕才顯示這一塊）畫出這個網址的 QR code，讓協助者用手機一掃就開。
// localhost 不畫：手機掃了會連到手機自己；這時請掃 serve.py 黑色視窗裡的 QR code。
function showQr() {
  const box = $("qrBox");
  if (!matchMedia("(hover:hover) and (pointer:fine)").matches) return;
  if (/^(localhost|127\.|\[::1\]$)/.test(location.hostname) || location.protocol !== "https:") return;
  try {
    const svg = qrSvg(location.href);
    if (!svg) return;              // 網址太長：只顯示文字
    box.prepend(svg);
    box.classList.add("has-code");
  } catch (e) {
    console.warn("QR code 產生失敗", e);
  }
}

(async () => {
  const warnings = await loadSettings();
  warnings.forEach(w => console.warn(w));
  RATES[1][1] = C.SPEECH_RATE;
  savePrefs();
  if (warnings.length) $("startError").textContent = warnings.join("\n");
  setupTicks();
  if (!window.isSecureContext) {
    $("startError").textContent = "這個網址不是 https，手機瀏覽器不會允許使用鏡頭。請改用 https 網址開啟（見 README）。";
  }
  $("pageUrl").textContent = location.href;
  showQr();
  // iPhone 與沒有 WebGPU 的手機不跑深度模型：開始畫面不能說會提醒頭上的障礙
  if (isIOS || !navigator.gpu) $("featureOverhead").hidden = true;
})();
