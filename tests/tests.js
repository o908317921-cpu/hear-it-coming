// 自動測試：由 Python 版 tests/ 改寫，確認 JavaScript 版的計算結果與原本一致。
// 開啟 tests/index.html 即可執行；加上 ?model=1 會再用真實模型跑公車照片的整合測試。
import { C, applyUserSettings, classLabel, targetClassIds, COCO_NAMES } from "../js/config.js";
import * as A from "../js/analysis.js";
import { AlertEngine, sceneSummary } from "../js/alerts.js";
import { HazardDetector } from "../js/detector.js";
import { CameraMotionEstimator } from "../js/motion.js";
import { ByteTracker } from "../js/tracker.js";
import { keepLargestComponent, maskElongation } from "../js/yolo.js";
import { downloadWithRetry } from "../js/ort.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function assert(cond, msg = "assert failed") { if (!cond) throw new Error(msg); }
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg || ""} 期望 ${JSON.stringify(b)}，實際 ${JSON.stringify(a)}`);
const close = (a, b, tol = 1e-9) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `期望約 ${b}，實際 ${a}`);

function track(o = {}) {
  return { trackId: 1, label: "行人", rawLabel: "person", box: [280, 100, 360, 400], state: "GREEN",
    occupancyRatio: 0.05, horizontalPosition: "center", speedPctS: 0, speedSource: "approach", speedLevel: "slow",
    ttcSec: Infinity, inCollisionZone: false, collisionProbability: 0, proximityLevel: "GREEN",
    distanceM: Infinity, ...o };
}
const texts = u => u.speech.map(s => s[0]);
const hazard = (distanceM = 1.4, kind = "overhead") => ({ kind, label: C.STATIC_TEXT[kind], box: [260, 40, 380, 160],
  distanceM, horizontalPosition: "center" });

// ---------- test_analysis.py ----------
test("距離分級與遲滯", () => {
  eq(A.classifyProximity(0.05), "GREEN");
  eq(A.classifyProximity(0.12), "ORANGE");
  eq(A.classifyProximity(0.30), "RED");
  const justBelow = C.PROXIMITY_RED_RATIO * 0.95;
  eq(A.classifyProximity(justBelow), "ORANGE");
  eq(A.classifyProximity(justBelow, "RED"), "RED");
});
test("距離門檻依物體大小放大", () => {
  eq(A.classifyProximity(0.30, null, C.PROXIMITY_CLASS_SCALE.person), "RED");
  eq(A.classifyProximity(0.30, null, C.PROXIMITY_CLASS_SCALE.car), "ORANGE");
  assert(Math.max(...A.proximityThresholds(10)) <= C.PROXIMITY_MAX_RATIO);
});
test("速度分級與遲滯", () => {
  eq(A.classifyGrowth(5), "slow");
  eq(A.classifyGrowth(30), "medium");
  eq(A.classifyGrowth(80), "fast");
  eq(A.classifyGrowth(C.GROWTH_RUN_MIN_PCT_S * 0.9, "fast"), "fast");
});
test("橫向速度只計算朝行走路徑移動的", () => {
  eq(A.lateralRate(-300, 600, 640, 100), 3);
  eq(A.lateralRate(300, 600, 640, 100), 0);
  eq(A.lateralRate(300, 320, 640, 100), 3);
});
test("橫向速度刻度對齊面積變化率門檻", () => {
  eq(A.lateralToSpeedPct(0), 0);
  eq(A.lateralToSpeedPct(C.LATERAL_MEDIUM_RATE), C.GROWTH_WALK_MAX_PCT_S);
  eq(A.lateralToSpeedPct(C.LATERAL_FAST_RATE), C.GROWTH_RUN_MIN_PCT_S);
  eq(A.lateralToSpeedPct(999), C.GROWTH_GAUGE_MAX_PCT_S);
});
test("碰撞風險跟著顏色", () => {
  eq(A.combinedRiskPct(0, 0, "GREEN", 0, "slow"), 0);
  assert(A.combinedRiskPct(0, 0.01, "ORANGE", 0, "slow") >= C.PROBABILITY_ORANGE_PCT);
  assert(A.combinedRiskPct(0, 0.01, "GREEN", 0, "fast") >= C.PROBABILITY_RED_PCT);
  eq(A.combinedRiskPct(0, 0.9, "RED", 0, "slow"), 100);
});
test("TTC 公式", () => {
  eq(A.computeTtc(200, 100), 2);
  eq(A.computeTtc(200, 0), Infinity);
});
test("線性回歸斜率", () => {
  close(A.linearSlope([0, 1, 2, 3], [1, 3, 5, 7]), 2);
  close(A.linearSlope([10, 10.5, 11], [0, 1, 2.2]), 2.2);
  eq(A.linearSlope([1, 1, 1], [1, 2, 3]), 0);
});

// ---------- test_alerts.py ----------
test("過近：念一次、持續時每 5 秒重複、一直有警示音", () => {
  const engine = new AlertEngine(0);
  const red = [track({ proximityLevel: "RED", occupancyRatio: 0.4, horizontalPosition: "left" })];
  const first = engine.update(red, 0, false);
  eq(texts(first), ["左前方，行人很近"]);
  assert(first.alarmOn.proximity && first.beep);
  const spoken = [];
  let t = 0;
  while (t < C.ALARM_VOICE_REPEAT_SEC + 0.05) {
    t = Math.round((t + 0.1) * 100) / 100;
    const u = engine.update(red, t, false);
    assert(u.alarmOn.proximity && u.beep);
    texts(u).forEach(x => spoken.push([t, x]));
  }
  eq(spoken, [[C.ALARM_VOICE_REPEAT_SEC, "左前方，行人很近"]]);
});
test("語音念完前警報不解除", () => {
  const engine = new AlertEngine(0);
  engine.update([track({ proximityLevel: "RED" })], 0, false);
  assert(engine.update([], 1, true).alarmOn.proximity);
  assert(engine.update([], 2, false).alarmOn.proximity);
  assert(!engine.update([], 2 + C.ALARM_RELEASE_HOLD_SEC + 0.1, false).alarmOn.proximity);
});
test("橫越用「橫越」的說法", () => {
  const engine = new AlertEngine(0);
  const u = engine.update([track({ label: "機車", rawLabel: "motorcycle", speedLevel: "fast", speedSource: "lateral",
    speedPctS: 90, horizontalPosition: "right" })], 0, false);
  eq(texts(u), ["右前方，機車橫越"]);
  assert(u.alarmOn.speed && u.beepPan >= -1 && u.beepPan <= 1);
});
test("警示音方向跟著物體", () => {
  const engine = new AlertEngine(0);
  const left = engine.update([track({ proximityLevel: "RED", box: [0, 100, 80, 400] })], 0, false, { frameWidth: 640 });
  const right = engine.update([track({ proximityLevel: "RED", box: [560, 100, 640, 400] })], 1, false, { frameWidth: 640 });
  assert(left.beepPan < -0.5 && right.beepPan > 0.5);
});
test("即將撞上：每次靠近只報一次、優先權最高", () => {
  const engine = new AlertEngine(0);
  const hit = [track({ ttcSec: 2.5, inCollisionZone: true })];
  eq(engine.update(hit, 0, false).speech, [["危險，正前方行人", C.SPEECH_PRIORITY.ttc]]);
  eq(engine.update(hit, 0.5, false).speech, []);
  engine.update([], 1, false);
  assert(engine.update(hit, 5, false).speech.length);
});
test("框重疊不會誤報危險", () => {
  const engine = new AlertEngine(0);
  const a = track({ trackId: 1, box: [100, 100, 300, 400] });
  const b = track({ trackId: 2, label: "汽車", rawLabel: "car", box: [150, 150, 400, 420] });
  for (let t = 0; t < 5; t++) eq(engine.update([a, b], t, false).speech, []);
});
test("光線不足提醒", () => {
  const engine = new AlertEngine(0);
  assert(!engine.update([], 0, false, { brightness: 30 }).lowLight);
  const u = engine.update([], C.LOW_LIGHT_HOLD_SEC + 0.1, false, { brightness: 30 });
  assert(u.lowLight);
  eq(texts(u), [C.LOW_LIGHT_TEXT]);
  eq(texts(engine.update([], C.LOW_LIGHT_HOLD_SEC + 1, false, { brightness: 30 })), []);
  assert(!engine.update([], 10, false, { brightness: 200 }).lowLight);
});

// ---------- test_improvements.py ----------
test("時間窗回歸：優先近 1 秒、至少 3 幀", () => {
  const range = n => [...Array(n).keys()];
  eq(A.regressionWindow(range(8).map(t => [t / 10, 0, 0, 0]), 0.7).length, 8);
  eq(A.regressionWindow(range(8).map(t => [t * 0.3, 0, 0, 0]), 2.1).length, 4);
  eq(A.regressionWindow(range(8).map(t => [t * 2, 0, 0, 0]), 14).length, C.TRAJECTORY_MIN_FRAMES);
});
test("比例法距離", () => {
  close(A.ratioDistanceM(C.PROXIMITY_ORANGE_RATIO), C.RATIO_REFERENCE_DISTANCE_M);
  close(A.ratioDistanceM(C.PROXIMITY_ORANGE_RATIO / 4), 2 * C.RATIO_REFERENCE_DISTANCE_M);
  close(A.ratioFromDistance(A.ratioDistanceM(0.07)), 0.07);
});
test("遮擋與截斷時降低比例法權重", () => {
  eq([...A.truncationSides([0, 100, 200, 480], 640, 480)].sort(), ["bottom", "left"]);
  assert(A.isOccluded("person", 0.2) && !A.isOccluded("person", 0.5));
  const [fused, occluded, sides] = A.distanceEstimates("person", [300, 100, 380, 380], 0.01, 0.2, 640, 480);
  assert(occluded && !sides.size);
  const pinhole = A.pinholeDistanceM("person", 280, 640);
  assert(Math.abs(fused - pinhole) < Math.abs(A.ratioDistanceM(0.01) - pinhole) / 3);
  assert(A.effectiveOccupancy(0.01, fused, occluded, sides) > 0.01);
});
test("融合距離略過無效值", () => {
  eq(A.fuseDistance([[2, 1], [Infinity, 1], [4, 0]]), 2);
  eq(A.fuseDistance([[Infinity, 1]]), Infinity);
});

function groundDisparity(w = 640, h = 480) {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) data.fill(Math.max(y - h / 2, 1) / (h / 2), y * w, (y + 1) * w);
  return { data, width: w, height: h };
}
function fillRect(d, x0, y0, x1, y1, v) { for (let y = y0; y < y1; y++) d.data.fill(v, y * d.width + x0, y * d.width + x1); }
test("空曠的路沒有障礙", () => eq(A.findDepthHazards(groundDisparity(), 320), []));
test("頭部高度的樹枝", () => {
  const d = groundDisparity();
  fillRect(d, 260, 60, 400, 160, 3);
  const hz = A.findDepthHazards(d, 320);
  eq(hz.map(h => h.kind), ["overhead"]);
  close(hz[0].distanceM, A.groundDistanceM(640, 480) / 3, 0.05);
  eq(A.findDepthHazards(d, 560), []);
});
test("從上到下的柱子是障礙物", () => {
  const d = groundDisparity();
  fillRect(d, 300, 0, 340, 440, 4);
  const hz = A.findDepthHazards(d, 320);
  eq(hz.map(h => h.kind), ["obstacle"]);
  eq(hz[0].box[1], 0);
});
test("已追蹤的物體不算障礙", () => {
  const d = groundDisparity();
  fillRect(d, 280, 60, 360, 440, 3);
  const ex = new Uint8Array(640 * 480);
  for (let y = 60; y < 440; y++) ex.fill(1, y * 640 + 280, y * 640 + 360);
  eq(A.findDepthHazards(d, 320, C.COLLISION_ZONE_RATIO, ex), []);
});
test("倒車雷達：越近越急、音高固定", () => {
  eq(A.beepLevel(3), "far"); eq(A.beepLevel(Infinity), "far");
  eq(A.beepLevel(1.5), "near");
  eq(A.beepLevel(0.6), "close"); eq(A.beepLevel(5, true), "close");
  const [far, near, cl] = ["far", "near", "close"].map(A.beepPattern);
  assert(far[0] === near[0] && near[0] === cl[0] && cl[0] === C.BEEP_FREQ_HZ);
  assert(far[2] > near[2] && near[2] > cl[2]);
});

// 隨機紋理（8×8 方塊放大後模糊），模擬 Python 測試的 textured_image
function texturedImage(seed = 1, w = 640, h = 480) {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cells = Array.from({ length: (h / 8) * (w / 8) }, () => rand() * 255);
  const img = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[y * w + x] = cells[(y >> 3) * (w / 8) + (x >> 3)];
  return img;
}
function crop(img, w, h, x0, x1) {
  const out = new Float32Array((x1 - x0) * h);
  for (let y = 0; y < h; y++) out.set(img.subarray(y * w + x0, y * w + x1), y * (x1 - x0));
  return out;
}
test("背景比對量得到鏡頭左右轉動", () => {
  const base = texturedImage();
  const est = new CameraMotionEstimator("flow");
  est.update(crop(base, 640, 480, 40, 600), 560, 480, 0);
  const m = est.update(crop(base, 640, 480, 30, 590), 560, 480, 0.1);   // 內容往右移 10 像素
  eq(m.source, "flow");
  assert(Math.abs(m.vx - 100) < 15, `vx=${m.vx}`);
  assert(Math.abs(m.vy) < 15, `vy=${m.vy}`);
});
test("背景比對：固定鏡頭量到 0", () => {
  const base = texturedImage(7);
  const est = new CameraMotionEstimator("flow");
  est.update(base, 640, 480, 0);
  const m = est.update(base, 640, 480, 0.1);
  eq(m.vx, 0); eq(m.vy, 0);
});
test("陀螺儀角速度換算成像素", () => {
  const est = new CameraMotionEstimator("gyro");
  const img = texturedImage();
  est.update(img, 640, 480, 0, { gyro: [0, 0] });
  const m = est.update(img, 640, 480, 0.1, { gyro: [0.2, 0] });
  eq(m.source, "gyro");
  close(m.vx, A.focalPx(640) * 0.2 * C.GYRO_GAIN);
});
test("行走路徑跟著平均朝向", () => {
  const est = new CameraMotionEstimator("gyro");
  const img = texturedImage();
  let t = 0, m;
  for (let i = 0; i < 10; i++) { est.update(img, 640, 480, t, { gyro: [0, 0] }); t += 0.1; }
  for (let i = 0; i < 3; i++) { m = est.update(img, 640, 480, t, { gyro: [0.5, 0] }); t += 0.1; }
  assert(m.pathCenterX > 320);
});
test("靜態障礙：簡短語音＋警示音，越近越急", () => {
  const engine = new AlertEngine(0);
  const u = engine.update([], 0, false, { staticHazards: [hazard()] });
  eq(u.speech, [["正前方，頭上有障礙", C.SPEECH_PRIORITY.static]]);
  assert(u.alarmOn.static);
  eq(u.beep, A.beepPattern("near"));
  eq(engine.update([], 0.1, false, { staticHazards: [hazard(0.6)] }).beep, A.beepPattern("close"));
  const quiet = engine.update([], 0.1 + C.ALARM_RELEASE_HOLD_SEC + 0.1, false);
  assert(!quiet.alarmOn.static && quiet.beep === null);
});
test("同時只有一種聲音、一句語音", () => {
  const engine = new AlertEngine(0);
  const nearPerson = track({ trackId: 1, proximityLevel: "RED", distanceM: 1.5, horizontalPosition: "left", box: [0, 100, 120, 400] });
  const fastBike = track({ trackId: 2, label: "機車", rawLabel: "motorcycle", speedLevel: "fast", speedPctS: 90,
    distanceM: 4, ttcSec: 2, horizontalPosition: "right", box: [520, 100, 640, 400] });
  let u = engine.update([nearPerson, fastBike], 0, false, { staticHazards: [hazard(0.8)] });
  assert(AlertEngine.KINDS.every(k => u.alarmOn[k]));
  eq(u.speech.length, 1);
  eq(u.beep, A.beepPattern("close"));
  assert(Math.abs(u.beepPan) < 0.5);
  u = engine.update([track({ trackId: 3, ttcSec: 1, inCollisionZone: true, distanceM: 5 })], 0.1, false);
  eq(u.speech, [["停，正前方行人", C.SPEECH_PRIORITY.urgent]]);
  eq(u.beep, A.beepPattern("close"));
});
test("幀率過低提醒", () => {
  const engine = new AlertEngine();
  let t = 0;
  const ups = [];
  while (t < C.LOW_FPS_HOLD_SEC + C.LOW_FPS_VOICE_AFTER_SEC + 1) { ups.push(engine.update([], t, false)); t += 0.5; }
  assert(ups[ups.length - 1].lowFps);
  eq(ups.flatMap(texts).filter(x => x === C.LOW_FPS_TEXT).length, 1);
  const ok = new AlertEngine();
  let u;
  t = 0;
  while (t < C.LOW_FPS_HOLD_SEC + 1) { u = ok.update([], t, false); t += 0.1; }
  assert(!u.lowFps);
});

// ---------- 新增：設定檔、追蹤器、遮罩 ----------
test("settings.json：打錯名稱或型別不符時略過", () => {
  const target = { A_B: 1.5, FLAG: true, MAP: { x: 1, y: 2 } };
  const warnings = applyUserSettings({ _note: "註解", A_B: 2, FLAG: "yes", MAP: { y: 5 }, TYPO: 1, lower: 3 }, target);
  eq(target, { A_B: 2, FLAG: true, MAP: { x: 1, y: 5 } });
  eq(warnings.length, 3);
});
test("追蹤器：漏抓兩次後 ID 不變", () => {
  const tr = new ByteTracker();
  const det = (x, score = 0.9) => ({ box: [x, 100, x + 80, 300], score, rawLabel: "person" });
  const ids = [];
  ids.push(tr.update([det(100), det(400)], 0).map(o => o.id));
  ids.push(tr.update([det(105), det(405)], 0.1).map(o => o.id));
  tr.update([], 0.2); tr.update([], 0.3);                         // 漏抓兩次
  ids.push(tr.update([det(120), det(420)], 0.4).map(o => o.id));
  eq(ids[0], [1, 2]); eq(ids[1], [1, 2]); eq(ids[2], [1, 2]);
});
test("追蹤器：低信心框延續既有物體、但不建立新物體", () => {
  const tr = new ByteTracker();
  tr.update([{ box: [100, 100, 180, 300], score: 0.9, rawLabel: "person" }], 0);
  const out = tr.update([{ box: [102, 100, 182, 300], score: 0.15, rawLabel: "person" },
                         { box: [400, 100, 480, 300], score: 0.15, rawLabel: "person" }], 0.1);
  eq(out.map(o => o.id), [1]);
});
test("追蹤器：信心高馬上算，信心普通要連續看到三次", () => {
  const tr = new ByteTracker();
  eq(tr.update([{ box: [100, 100, 180, 300], score: 0.9, rawLabel: "person" }], 0.1).length, 1);
  const slow = new ByteTracker(), det = x => [{ box: [100 + x, 100, 180 + x, 300], score: 0.5, rawLabel: "person" }];
  eq(slow.update(det(0), 0.1), []);
  eq(slow.update(det(2), 0.2), []);
  eq(slow.update(det(4), 0.3).length, 1);
});
test("遮罩：只留最大連通區域、長條形長寬比高", () => {
  const w = 10, h = 10, m = new Uint8Array(w * h);
  for (let y = 0; y < 8; y++) m[y * w + 1] = 1, m[y * w + 2] = 1;   // 2×8 長條
  m[9 * w + 9] = 1;                                                // 孤立雜點
  eq(keepLargestComponent(m, w, h), 16);
  eq(m[9 * w + 9], 0);
  assert(maskElongation({ data: m, gw: w, gh: h }) > 3);
});

// ---------- 真實模型整合測試（?model=1）----------
async function modelTests(log) {
  const { YoloSegmenter } = await import("../js/yolo.js");
  const { HazardDetector } = await import("../js/detector.js");
  const img = new Image();
  img.src = "bus.png";
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const frame = { canvas, imageData: ctx.getImageData(0, 0, canvas.width, canvas.height), width: canvas.width, height: canvas.height };
  C.USE_WEBGPU = false;
  const yolo = await YoloSegmenter.load();
  const t0 = performance.now();
  const raw = await yolo.detect(canvas, frame.width, frame.height);
  const ms = performance.now() - t0;
  const strong = raw.filter(d => d.score >= 0.4).map(d => ({ label: d.rawLabel, score: +d.score.toFixed(3), box: d.box,
    area: yolo.buildMask(d)?.area }));
  log(`YOLO（${yolo.backend}）${ms.toFixed(0)} ms：${JSON.stringify(strong)}`);
  const persons = strong.filter(d => d.label === "person").length, buses = strong.filter(d => d.label === "bus").length;
  assert(persons >= 3 && buses === 1, "公車照片應找到至少 3 個行人與 1 台公車");
  const bus = strong.find(d => d.label === "bus");
  if (yolo.proto) assert(Math.abs(bus.area - 92309) / 92309 < 0.15, `公車遮罩面積 ${bus.area} 與 Python 版 92309 差太多`);   // 輕量模型沒有輪廓

  // 漏抓兩幀後追蹤 ID 不變（對應 Python 的 test_track_ids_survive_missed_frames）
  const det = new HazardDetector(yolo, null);
  let r1 = [];
  for (let i = 0; i < 6; i++) r1 = await det.process(frame, i * 0.1);
  const ids1 = r1.map(t => t.trackId).sort((a, b) => a - b);
  const blank = document.createElement("canvas");
  blank.width = frame.width; blank.height = frame.height;
  const bctx = blank.getContext("2d", { willReadFrequently: true });
  bctx.fillStyle = "#777"; bctx.fillRect(0, 0, blank.width, blank.height);
  const blankFrame = { canvas: blank, imageData: bctx.getImageData(0, 0, blank.width, blank.height), width: blank.width, height: blank.height };
  await det.process(blankFrame, 0.6);
  let r2 = [];
  for (let i = 7; i < 10; i++) r2 = await det.process(frame, i * 0.1);
  const ids2 = r2.map(t => t.trackId).sort((a, b) => a - b);
  log(`追蹤 ID：${JSON.stringify(ids1)} → ${JSON.stringify(ids2)}；類別 ${r2.map(t => t.label).join("、")}`);
  assert(ids1.length >= 4, "應追蹤到至少 4 個物體");
  eq(ids2, ids1, "漏抓後 ID 應不變");
  const busTrack = r2.find(t => t.rawLabel === "bus");
  log(`公車：距離 ${busTrack.distanceM.toFixed(1)} m、${busTrack.proximityLevel}、風險 ${busTrack.collisionProbability}%`);
}

// ---------- 依作品說明書的核心主張（對應 tests/test_blind_user.py）----------
function headOn(distanceM, speed = 1.5, focal = 700, cameraM = 1.2, personM = 1.7) {
  const height = focal * personM / distanceM, below = focal * cameraM / distanceM;
  return { height, dhDt: height * speed / distanceM, footY: Math.min(240 + below, 480), vy: below * speed / distanceM };
}
const collide = o => A.predictCollision({ objectWidth: 80, frameWidth: 640, frameHeight: 480, vx: 0, vy: 0,
  pathRatio: C.COLLISION_ZONE_RATIO, ...o });
test("公式 3-6：正面走來的行人整個危險區間都判定會撞上", () => {
  for (const d of [4.5, 4, 3.5, 3, 2, 1.5]) {
    const w = headOn(d);
    const [ttc, , hit] = collide({ footX: 320, footY: w.footY, objectWidth: w.height * 0.35, vy: w.vy, height: w.height, dhDt: w.dhDt });
    assert(hit, `${d} 公尺、TTC ${ttc} 秒應判定會撞上`);
  }
});
test("側向通過與往上退去的物體不算會撞上", () => {
  assert(!collide({ footX: 600, footY: 420, vx: 60, vy: 30, height: 300, dhDt: 150 })[2]);
  assert(!collide({ footX: 320, footY: 60, objectWidth: 40, vy: -200, height: 100, dhDt: 50 })[2]);
});
test("等速趨近時 TTC 回歸沒有落後", () => {
  for (const [z0, v] of [[10, 1.5], [6, 0.7], [6, 3]]) {
    const ts = [...Array(10).keys()].map(i => i * 0.1), hs = ts.map(t => 1190 / (z0 - v * t));
    const truth = (z0 - v * 0.9) / v;
    close(1 / A.loomingRate(ts, hs), truth, 1e-6);
    assert(hs[9] / A.linearSlope(ts, hs) > truth);
  }
});
test("截斷補償：腳出畫面時改看框寬與頭頂", () => {
  const win = [...Array(8).keys()].map(i => { const z = 3 - 1.5 * i * 0.1; return [i * 0.1, 320, 480, 400, 150 / z, 200 / z, false]; });
  const truth = (3 - 1.5 * 0.7) / 1.5, ttc = sides => A.computeTtc(400, A.loomingDhDt(win, 400, new Set(sides)));
  assert(Math.abs(A.loomingDhDt(win, 400, new Set())) < 1e-6);
  close(ttc(["bottom"]), truth, 1e-6);
  close(ttc(["bottom", "left"]), truth, 1e-6);
  close(ttc(["bottom", "top"]), truth, 1e-6);
  const low = win.map(p => [...p.slice(0, 5), 10, false]);
  assert(Math.abs(A.loomingDhDt(low, 400, new Set(["bottom", "left"]))) < 1e-6);
});
test("鏡頭上仰時最下緣露出的一顆頭不算靠近，腳被切掉的高框要算", () => {
  const grow = [...Array(8).keys()].map(i => { const z = 3 - 1.5 * i * 0.1; return [i * 0.1, 320, 480, 240 / z, 100 / z, 200 / z, false]; });
  eq(A.loomingDhDt(grow, 60, new Set(["bottom"]), false, 480), 0);
  assert(A.loomingDhDt(grow, 300, new Set(["bottom"]), false, 480) > 0);
  // 腳被切掉時雙腿跑出畫面、框反而變窄：頭頂還在變大就是在靠近
  const narrowing = grow.map((p, i) => [p[0], p[1], p[2], 300, 200 - i * 5, p[5], false]);
  assert(A.loomingDhDt(narrowing, 300, new Set(["bottom"]), false, 480) > 0);
});
test("剛從側邊進來的物體不算 TTC，框底差幾像素也算截斷", () => {
  const win = [...Array(8).keys()].map(i => [i * 0.1, 320, 480, 100 + i * 20, 80, 60, true]);
  eq(A.loomingDhDt(win, 240, new Set(["left"])), 0);
  eq(A.loomingDhDt(win, 240, new Set(["right"])), 0);
  eq([...A.truncationSides([0, 100, 200, 472], 640, 480)].sort(), ["bottom", "left"]);
  const entering = [...Array(8).keys()].map(i => [i * 0.1, 320, 300, 100 + i * 40, (100 + i * 40) * 0.4, 60, i < 5]);
  assert(A.computeTtc(380, A.loomingDhDt(entering, 380, new Set())) < 3.5);
  eq(A.loomingDhDt(entering.map(p => [...p.slice(0, 6), true]), 380, new Set()), 0);
});
test("手機直拿與橫拿的焦距相同", () => {
  close(A.pinholeDistanceM("person", 238, 480, 640), A.pinholeDistanceM("person", 238, 640, 480));
  eq(A.focalPx(480, 640), C.CAMERA_FOCAL_LENGTH_PX);
  eq(A.focalPx(640, 480), C.CAMERA_FOCAL_LENGTH_PX);
});
test("遠處小目標的面積雜訊不算很快", () => {
  const engine = new AlertEngine(0);
  eq(engine.update([track({ speedLevel: "fast", speedPctS: 70, ttcSec: C.SPEED_ALERT_MAX_TTC_SEC + 1.5 })], 0, false).beep, null);
  eq(texts(engine.update([track({ speedLevel: "fast", speedPctS: 70, ttcSec: C.SPEED_ALERT_MAX_TTC_SEC - 1 })], 1, false)), ["正前方，行人很快"]);
});
test("預測軌跡：穿過路徑算、往外離開不算", () => {
  assert(A.trajectoryOnCourse(320, 60, 640, 0, Infinity));
  assert(!A.trajectoryOnCourse(40, 60, 640, 0, Infinity));
  assert(A.trajectoryOnCourse(600, 60, 640, -400, Infinity));
  assert(!A.trajectoryOnCourse(500, 60, 640, 200, Infinity));
  assert(A.combinedRiskPct(0, 0.3, "RED", 0, "slow", 1, false) < C.PROBABILITY_RED_PCT);
});
test("從旁邊經過的物體不發警報，擋在路上的才發", () => {
  const engine = new AlertEngine(0);
  const u = engine.update([track({ proximityLevel: "RED", occupancyRatio: 0.4, onCourse: false })], 0, false);
  eq(u.speech, []); eq(u.beep, null); assert(!u.alarmOn.proximity);
  assert(engine.update([track({ proximityLevel: "RED", occupancyRatio: 0.4, onCourse: true })], 1, false).alarmOn.proximity);
});
test("遠處橫越的車不吵人", () => {
  const engine = new AlertEngine(0);
  const bike = d => track({ label: "機車", rawLabel: "motorcycle", speedLevel: "fast", speedSource: "lateral", speedPctS: 90, distanceM: d });
  eq(engine.update([bike(C.SPEED_ALERT_MAX_M + 5)], 0, false).beep, null);
  eq(texts(engine.update([bike(C.SPEED_ALERT_MAX_M - 3)], 1, false)), ["正前方，機車橫越"]);
});
test("第二個危險物體不會被吃掉", () => {
  const engine = new AlertEngine(0);
  const person = track({ trackId: 1, ttcSec: 2.5, inCollisionZone: true });
  const bike = track({ trackId: 2, label: "機車", rawLabel: "motorcycle", ttcSec: 2.5, inCollisionZone: true, horizontalPosition: "left" });
  eq(texts(engine.update([person], 0, false)), ["危險，正前方行人"]);
  const spoken = [];
  for (let t = 1; t < 4; t += 0.1) spoken.push(...texts(engine.update([person, bike], t, false)));
  eq(spoken, ["危險，左前方機車"]);
});
test("暫停不算慢，真的慢才提醒", () => {
  const engine = new AlertEngine();
  for (let t = 0; t < 5; t += 0.1) engine.update([], t, false);
  assert(!engine.update([], 30, false).lowFps);
  const slow = new AlertEngine();
  let u;
  for (let i = 0; i < 4; i++) u = slow.update([], i * 4, false);
  assert(u.lowFps);
});
test("滿版的人不會被深度圖讀成很遠", () => {
  const [fused, , sides] = A.distanceEstimates("person", [200, 0, 440, 480], 0.45, 0.55, 640, 480, 3.8);
  assert(sides.has("bottom") && fused < 1.5);
  const [cut] = A.distanceEstimates("person", [280, 200, 360, 478], 0.01, 0.1, 640, 480);
  assert(cut <= A.groundDistanceM(640, 480));
});
test("橫跨畫面的大車仍算 TTC，剛從側邊進來的不算", () => {
  const win = [...Array(8).keys()].map(i => [i * 0.1, 320, 300, 1000 / (5 - 0.05 * i), 700, 100, true]);
  assert(A.loomingDhDt(win, 200, new Set(["left", "right"])) > 0);
  assert(A.loomingDhDt(win, 200, new Set(["left"]), true) > 0);
  eq(A.loomingDhDt(win, 200, new Set(["left"])), 0);
});
test("深度圖門檻用校準過的比值", () => {
  const w = 64, h = 48, data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.max(1, y - h / 2) / (h / 2);
  const top = Math.floor(h * (1 - C.GROUND_STRIP_RATIO));
  const ground = A.median(data.subarray(top * w));
  const paint = v => { for (let y = 6; y < 16; y++) for (let x = 26; x < 40; x++) data[y * w + x] = v; };
  paint(ground * (C.STATIC_NEAR_RATIO + 0.05));
  const found = A.findDepthHazards({ data, width: w, height: h }, 32);
  assert(found.length === 1 && found[0].kind === "overhead" && found[0].distanceM <= C.STATIC_ALERT_DISTANCE_M);
  paint(ground * (C.STATIC_NEAR_RATIO - 0.1));
  eq(A.findDepthHazards({ data, width: w, height: h }, 32), []);
});
test("最近的物體優先，不是佔畫面最大的", () => {
  const engine = new AlertEngine(0);
  const bus = track({ trackId: 1, label: "公車", rawLabel: "bus", proximityLevel: "RED", occupancyRatio: 0.3, distanceM: 6, horizontalPosition: "right", box: [500, 100, 640, 400] });
  const person = track({ trackId: 2, proximityLevel: "RED", occupancyRatio: 0.1, distanceM: 0.8, box: [280, 0, 360, 480] });
  const u = engine.update([bus, person], 0, false, { frameWidth: 640 });
  eq(texts(u), ["正前方，行人很近"]);
  eq(u.beep, A.beepPattern("close"));
  assert(Math.abs(u.beepPan) < 0.5);
});
test("危險升級成停", () => {
  const engine = new AlertEngine(0);
  const hit = ttcSec => [track({ ttcSec, inCollisionZone: true })];
  const far = engine.update(hit(2.8), 0, false);
  eq(texts(far), ["危險，正前方行人"]); eq(far.beep, A.beepPattern("near")); assert(far.alarmOn.ttc);
  eq(texts(engine.update(hit(2.2), 0.3, false)), []);
  const urgent = engine.update(hit(C.TTC_URGENT_SEC), 0.9, false);
  eq(urgent.speech, [["停，正前方行人", C.SPEECH_PRIORITY.urgent]]);
  eq(urgent.beep, A.beepPattern("close"));
});
test("判定閃爍不會一直喊危險", () => {
  const engine = new AlertEngine(0), hit = track({ ttcSec: 2.5, inCollisionZone: true }), spoken = [];
  for (let i = 0; i < 40; i++) spoken.push(...texts(engine.update(i % 2 === 0 ? [hit] : [], i * 0.25, false)));
  eq(spoken, ["危險，正前方行人"]);
});
test("不同警報不搶話、沒念到的不會被吃掉", () => {
  const engine = new AlertEngine(0);
  const p = track({ trackId: 1, ttcSec: 2.5, inCollisionZone: true, proximityLevel: "RED" });
  const q = track({ trackId: 2, proximityLevel: "RED", horizontalPosition: "left" });
  eq(texts(engine.update([p], 0, false)), ["危險，正前方行人"]);
  eq(texts(engine.update([p], 0.5, false)), []);
  eq(texts(engine.update([p, q], 0.6, false)), []);
  eq(texts(engine.update([p, q], C.ALARM_VOICE_GLOBAL_GAP_SEC + 0.1, false)), ["左前方，行人很近"]);
  const other = new AlertEngine(0);
  const near = track({ trackId: 1, proximityLevel: "RED" });
  const fast = track({ trackId: 2, label: "機車", rawLabel: "motorcycle", speedLevel: "fast", speedPctS: 90, ttcSec: 2 });
  eq(other.update([near, fast], 0, false, { staticHazards: [hazard()] }).speech.length, 1);
  assert(other.update([near, fast], C.ALARM_VOICE_MIN_GAP_SEC + 0.1, false, { staticHazards: [hazard()] }).speech.length);
});
test("真的警報過才念解除，只念一次，不搶話", () => {
  const engine = new AlertEngine(0);
  engine.update([track({ ttcSec: 2, inCollisionZone: true })], 0, false);
  eq(texts(engine.update([], 1, false)), []);
  eq(texts(engine.update([], C.ALARM_RELEASE_HOLD_SEC + 0.1, true)), []);
  // 最後一次「警報還在」是 t=1（語音念完前不算解除），要再等 CLEAR_AFTER_SEC，閃爍時才不會一直解除又警報
  eq(texts(engine.update([], 1 + C.CLEAR_AFTER_SEC - 0.1, false)), []);
  const t = 1 + C.CLEAR_AFTER_SEC + 0.1;
  eq(texts(engine.update([], t, false)), [C.CLEAR_TEXT]);
  eq(texts(engine.update([], t + 1, false)), []);
  eq(texts(new AlertEngine(0).update([], 100, false)), []);
});
test("目前狀況：最危險的先念、長度有限", () => {
  eq(sceneSummary([]), C.SCENE_EMPTY_TEXT);
  const far = track({ trackId: 1, label: "汽車", rawLabel: "car", distanceM: 8.2, collisionProbability: 5, horizontalPosition: "left" });
  const near = track({ trackId: 2, distanceM: 0.8, collisionProbability: 90, ttcSec: 1, inCollisionZone: true });
  eq(sceneSummary([far, near]), "偵測到 2 個物體。正前方行人，不到 1 公尺，可能撞上；左前方汽車，約 8 公尺。");
  const many = [0, 1, 2, 3, 4, 5].map(i => track({ trackId: i, distanceM: i + 1 }));
  const text = sceneSummary(many);
  assert(text.startsWith("偵測到 6 個物體。") && text.split("行人").length - 1 === C.SCENE_MAX_ITEMS);
  assert(text.endsWith(`另外還有 ${6 - C.SCENE_MAX_ITEMS} 個。`), text);
});

// ---------- test_humane_voice.py：不嘮叨、不命令、不把系統的問題推給使用者，真正危險時又一定要出聲 ----------
function runFrames(engine, makeItems, seconds, { fps = 10, start = 0, ...opts } = {}) {
  const log = [];
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    const t = start + i / fps, u = engine.update(makeItems(t), t, false, opts);
    log.push({ t, texts: texts(u), beep: u.beep });
  }
  return log;
}
const spokenAt = (log, needle) => log.filter(e => e.texts.some(x => x.includes(needle))).map(e => e.t);
const nearPerson = (distanceM = 0.9, trackId = 1, o = {}) => track({ trackId, proximityLevel: "RED", distanceM, ...o });
test("跟人說話、排隊：不會一直念，警示音 8 秒後停", () => {
  const log = runFrames(new AlertEngine(0), () => [nearPerson()], 120);
  const times = spokenAt(log, "很近");
  assert(times[0] < 0.2, "第一次要馬上說");
  assert(times.length <= 6, `兩分鐘念了 ${times.length} 次`);
  const gaps = times.slice(1).map((v, i) => v - times[i]);
  assert(gaps.every((g, i) => i === 0 || g >= gaps[i - 1] - 0.11), `間隔要愈來愈長：${gaps}`);
  assert(log[50].beep, "剛開始要有警示音");
  assert(log.slice(100).every(e => !e.beep), "持續 8 秒沒有更靠近就停");
});
test("又靠近了：警示音立刻恢復", () => {
  const engine = new AlertEngine(0);
  runFrames(engine, () => [nearPerson(1.5)], 20);
  assert(runFrames(engine, () => [nearPerson(1.0)], 3, { start: 20 })[0].beep);
});
test("新的人出現：警示音恢復，也會念出來", () => {
  const engine = new AlertEngine(0);
  runFrames(engine, () => [nearPerson()], 20);
  const log = runFrames(engine, () => [nearPerson(), nearPerson(1.2, 2)], 6, { start: 20 });
  assert(log[0].beep);
  assert(spokenAt(log, "很近").length, "新出現的人不能被沉默吃掉");
});
test("快撞上時，不會因為已經習慣而不出聲", () => {
  const engine = new AlertEngine(0);
  runFrames(engine, () => [nearPerson()], 20);
  const log = runFrames(engine, () => [nearPerson(0.9, 1, { ttcSec: 1, inCollisionZone: true })], 2, { start: 20 });
  assert(spokenAt(log, "停").length);
  assert(log.every(e => e.beep));
});
test("距離不明就不能判斷「沒有更靠近」，繼續警示", () => {
  const log = runFrames(new AlertEngine(0), () => [nearPerson(Infinity)], 30);
  assert(log.every(e => e.beep));
});
test("系統提醒只說明，不命令使用者", () => {
  const orders = /放慢|小心|留意|確認周遭|請回到畫面|請停下|找人協助/;
  for (const text of [C.LOW_FPS_TEXT, C.LOW_LIGHT_TEXT, C.CAMERA_BLOCKED_TEXT, C.RESUME_TEXT, C.CLEAR_TEXT,
                      C.SCENE_EMPTY_TEXT, C.STATIC_UNAVAILABLE_TEXT]) assert(!orders.test(text), text);
});
test("主程式沒有命令式的語音與橫幅", async () => {
  const page = await (await fetch("../js/app.js")).text();
  for (const line of page.split("\n")) {
    if (/say\(|setBanner|LOST_TEXT|speakSteps|steps\.push/.test(line)) {
      assert(!/小心|留意|確認周遭|請回到畫面|請停下|找人協助|放慢/.test(line), line);
    }
  }
});
test("夜間走路：十分鐘最多提三次光線不足", () => {
  const log = runFrames(new AlertEngine(0), () => [], 600, { brightness: 30 });
  assert(spokenAt(log, C.LOW_LIGHT_TEXT).length <= 3);
});
test("鏡頭被擋住：說清楚，愈說愈少，不混著說光線不足", () => {
  const log = runFrames(new AlertEngine(0), () => [], 600, { brightness: 3 });
  const times = spokenAt(log, C.CAMERA_BLOCKED_TEXT);
  assert(times.length && times[0] <= C.LOW_LIGHT_HOLD_SEC + 0.2 && times.length <= 6, String(times));
  eq(spokenAt(log, C.LOW_LIGHT_TEXT), []);
});
test("只有真的全黑才算被擋住", () => {
  const a = new AlertEngine(0);
  a.update([], 0, false, { brightness: 3 });
  assert(a.update([], C.LOW_LIGHT_HOLD_SEC + 0.1, false, { brightness: 3 }).cameraBlocked);
  const b = new AlertEngine(0);
  b.update([], 0, false, { brightness: 30 });
  assert(!b.update([], C.LOW_LIGHT_HOLD_SEC + 0.1, false, { brightness: 30 }).cameraBlocked);
});
test("判定閃爍時不會一直解除又警報", () => {
  const log = runFrames(new AlertEngine(0), t => (Math.floor(t / 3) % 2 === 0 ? [nearPerson()] : []), 60);
  assert(spokenAt(log, C.CLEAR_TEXT).length <= 11);
});
test("路上不合理的東西不偵測，擋路的東西一律說障礙物", () => {
  eq(COCO_NAMES.length, 80);
  const names = new Set(targetClassIds().values());
  for (const name of ["toilet", "bed", "couch", "airplane", "boat", "bird", "backpack", "cell phone", "clock", "sheep", "elephant", "tv", "train", "stop sign"]) assert(!names.has(name), name);
  for (const name of ["person", "bicycle", "car", "motorcycle", "bus", "truck", "dog", "chair", "bench", "fire hydrant"]) assert(names.has(name), name);
  for (const name of ["chair", "bench", "dining table", "potted plant"]) eq(classLabel(name), "障礙物");
  eq(classLabel("person"), "行人"); eq(classLabel("motorcycle"), "機車"); eq(classLabel("dog"), "狗");
  // 念出來的都是中文
  for (const name of names) assert(/[\u4e00-\u9fff]/.test(classLabel(name)), name);
});
test("偵測變慢：持續才說，五分鐘最多一次", () => {
  const engine = new AlertEngine(), spoken = [];
  for (let t = 0; t < 300; t += 1) spoken.push(...texts(engine.update([], t, false)));
  eq(spoken.filter(x => x === C.LOW_FPS_TEXT).length, 1);
  const quick = new AlertEngine();
  for (let t = 0; t < C.LOW_FPS_VOICE_AFTER_SEC; t += 1) eq(texts(quick.update([], t, false)), [], `第 ${t} 秒不該開口`);
});

// 假的 YOLO：行人依呼叫次數變大，用來驗證偵測器的時間序列（不需要真實模型）
class FakeYolo {
  constructor(heightOf) { this.heightOf = heightOf; this.calls = 0; this.backend = "fake"; }
  async detect() {
    const h = this.heightOf(this.calls++);
    return [{ box: [Math.round(320 - h * 0.2), Math.round(240 - h / 2), Math.round(320 + h * 0.2), Math.round(240 + h / 2)],
              score: 0.9, rawLabel: "person" }];
  }
  buildMask(det) {
    const [x1, y1, x2, y2] = det.box;
    return { data: new Uint8Array(1).fill(1), gw: 1, gh: 1, x: x1, y: y1, cell: 1, area: (x2 - x1) * (y2 - y1) * 0.6 };
  }
}
function fakeFrame(w = 64, h = 48, blank = false) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = blank ? 0 : (i * 7919) % 255; data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255; }
  return { canvas: null, imageData: { data }, width: w, height: h };
}
// 偵測器用 640×480 的座標算，假畫面也要同尺寸（亮度內容用小圖放大太慢，直接產生）
const scene = fakeFrame(640, 480), dark = fakeFrame(640, 480, true);
async function runDetector(frames, fps, heightOf) {
  const yolo = new FakeYolo(heightOf), det = new HazardDetector(yolo, null), results = [];
  for (let i = 0; i < frames; i++) results.push(await det.process(scene, (i + 1) / fps));
  return { yolo, results };
}
test("預測幀不算框高樣本：TTC 貼近真實值", async () => {
  const interval = C.DETECTION_INTERVAL;
  C.DETECTION_INTERVAL = 3;
  try { await predictedFramesAreNotSamples(); } finally { C.DETECTION_INTERVAL = interval; }
});
test("手機轉走了：暫留的物體不會發出新警報", () => {
  const engine = new AlertEngine(0);
  const ghost = track({ isPredicted: true, ttcSec: 1, inCollisionZone: true, proximityLevel: "RED", distanceM: 0.8 });
  const u = engine.update([ghost], 0, false);
  eq(u.speech, []);
  eq(u.beep, null);
});
async function predictedFramesAreNotSamples() {
  const { yolo, results } = await runDetector(60, 30, n => 1190 / (10 - 1.5 * n / 10));
  eq(yolo.calls, 21);
  for (const tracks of results.slice(-15)) {
    const tr = tracks[0], expected = 1190 / (tr.box[3] - tr.box[1]) / 1.5;
    assert(Math.abs(tr.ttcSec - expected) < 0.3, `TTC ${tr.ttcSec}，應約 ${expected}`);
  }
}
test("慢手機每次都偵測，全黑幀不送進模型", async () => {
  const { yolo } = await runDetector(20, 3, n => 150 + n * 5);
  assert(yolo.calls >= 19, `只偵測 ${yolo.calls} 次`);
  const fake = new FakeYolo(() => 200), det = new HazardDetector(fake, null);
  await det.process(scene, 0.1);
  const calls = fake.calls;
  const held = await det.process(dark, 0.2);
  assert(fake.calls === calls && held.length === 1 && held[0].isPredicted);
  eq(await det.process(dark, 0.1 + C.TRACK_LOST_HOLD_SEC + 0.1), []);
});
// 假的多人 YOLO：boxes(n) 回傳這一次的所有框
class FakeCrowd extends FakeYolo {
  constructor(boxes) { super(() => 0); this.boxes = boxes; }
  async detect() { return this.boxes(this.calls++).map(box => ({ box, score: 0.9, rawLabel: "person" })); }
}
const anyDanger = tracks => tracks.some(tr => Number.isFinite(tr.ttcSec) && tr.ttcSec <= C.TTC_DANGER_SEC && tr.inCollisionZone);
test("人多：追蹤換人造成框高跳變，不算靠近", async () => {
  // 同一個追蹤編號的框突然變兩倍大（換成比較近的人），之後大小不變
  const det = new HazardDetector(new FakeCrowd(n => [[280, 150, 360, n < 15 ? 330 : 480]]), null);
  for (let i = 0; i < 40; i++) {
    const tracks = await det.process(scene, (i + 1) / 10);
    assert(!anyDanger(tracks), `第 ${i} 幀誤判危險：TTC ${tracks[0]?.ttcSec}`);
  }
});
test("人多：後面的人被前面的人慢慢露出來，不算靠近", async () => {
  // 站在遠處的人（框上緣固定），被前面走過的人擋住；擋住的部分變少時框變大
  const det = new HazardDetector(new FakeCrowd(n => {
    const far = [300, 150, 360, Math.min(260 + n * 6, 330)];
    const front = [260, 180, 420, 470];
    return [far, front];
  }), null);
  for (let i = 0; i < 30; i++) {
    const tracks = await det.process(scene, (i + 1) / 10);
    const behind = tracks.find(tr => tr.box[3] < 400);
    if (behind) assert(!(Number.isFinite(behind.ttcSec) && behind.ttcSec <= C.TTC_DANGER_SEC), `被擋住的人誤判 TTC ${behind.ttcSec}`);
  }
});
test("人多：站在最前面、真的走過來的人照樣要報", async () => {
  // 後面有別人，但最前面的人正面走來：不能因為有重疊就不報
  const det = new HazardDetector(new FakeCrowd(n => {
    const h = 1190 / Math.max(0.8, 4 - 0.21 * n);
    return [[300, 120, 360, 300], [Math.round(320 - h * 0.2), Math.round(240 - h / 3), Math.round(320 + h * 0.2), Math.round(240 + h * 2 / 3)]];
  }), null);
  let hit = false;
  for (let i = 0; i < 38; i++) if (anyDanger(await det.process(scene, (i + 1) / 10))) hit = true;
  assert(hit, "真的走過來的人要判定會撞上");
});
test("誤判：天空裡的腳踏車、極小的框不算", async () => {
  const run = async (box, rawLabel, score = 0.9) => {
    const yolo = new FakeCrowd(() => []);
    yolo.detect = async () => [{ box, score, rawLabel }];
    const det = new HazardDetector(yolo, null);
    let tracks = [];
    for (let i = 0; i < 12; i++) tracks = await det.process(scene, (i + 1) / 10);
    return tracks.length;
  };
  eq(await run([200, 10, 300, 100], "bicycle"), 0, "底邊在天上的腳踏車");
  eq(await run([300, 300, 310, 310], "person"), 0, "只有 10 像素的人");
  eq(await run([200, 200, 300, 400], "bicycle"), 1, "地上的腳踏車");
});
test("誤判：低信心要連續看到才算，一閃而過不算", async () => {
  const stable = new FakeCrowd(() => []);
  stable.detect = async () => [{ box: [200, 200, 300, 400], score: 0.5, rawLabel: "person" }];
  const det = new HazardDetector(stable, null);
  const counts = [];
  for (let i = 0; i < 15; i++) counts.push((await det.process(scene, (i + 1) / 10)).length);
  eq(counts[0], 0, "第一次看到不算");
  eq(counts.at(-1), 1, "連續看到就算");
  const flicker = new FakeCrowd(() => []);
  flicker.detect = async function () { return this.calls++ % 2 === 0 ? [{ box: [200, 200, 300, 400], score: 0.5, rawLabel: "person" }] : []; };
  const det2 = new HazardDetector(flicker, null);
  for (let i = 0; i < 20; i++) eq((await det2.process(scene, (i + 1) / 10)).length, 0, "時有時無的雜訊不算");
  const low = new FakeCrowd(() => []);
  low.detect = async () => [{ box: [200, 200, 300, 400], score: 0.30, rawLabel: "bicycle" }];
  const det3 = new HazardDetector(low, null);
  let tracks = [];
  for (let i = 0; i < 15; i++) tracks = await det3.process(scene, (i + 1) / 10);
  eq(tracks.length, 0, "信心太低不算");
});
test("鏡頭被擋住：不送深度模型，也不會說頭上有障礙", async () => {
  let submitted = 0, result = null;
  const depth = { available: true, submit() { submitted++; return true; }, latest() { return result; } };
  const det = new HazardDetector(new FakeYolo(() => 200), depth);
  det.staticState.set("overhead", { hits: 3, confirmed: true, lastSeen: 0, hazard: hazard() });
  result = { ts: 0.1, disp: { data: new Float32Array(4).fill(9), width: 2, height: 2 } };
  await det.process(dark, 0.1);
  eq(submitted, 0);
  eq(det.staticHazards, [], "全黑畫面不能留著舊的障礙警報");
});
test("面積真的大幅變化時，幾幀後就接受，不會永遠凍結", async () => {
  const det = new HazardDetector(new FakeYolo(n => (n < 8 ? 100 : 300)), null);
  let tracks;
  for (let i = 0; i < 20; i++) tracks = await det.process(scene, (i + 1) / 10);
  assert(tracks[0].occupancyRatio > 0.05, `面積比例 ${tracks[0].occupancyRatio}`);
});
test("TTC 短暫中斷時「會撞上」也跟著暫留", async () => {
  const det = new HazardDetector(new FakeYolo(n => 1190 / (6 - 0.15 * Math.min(n, 13))), null);
  const states = [];
  for (let i = 0; i < 30; i++) {
    const [tr] = await det.process(scene, (i + 1) / 10);
    if (tr && Number.isFinite(tr.ttcSec) && tr.ttcSec < C.TTC_MAX_CLAMP_SEC) states.push(tr.inCollisionZone);
  }
  // 一開始要連續幾次都判定會撞上才算（ZONE_CONFIRM_HITS）；算數之後就不能再一閃一閃
  const from = states.indexOf(true);
  assert(from >= 0 && from <= C.ZONE_CONFIRM_HITS && states.slice(from).every(Boolean), JSON.stringify(states));
});
test("遠離的物體不在路徑上，靜止擋路的在", async () => {
  assert(!(await runDetector(45, 30, n => 300 - n * 4)).results.at(-1)[0].onCourse);
  assert((await runDetector(45, 30, () => 300)).results.at(-1)[0].onCourse);
  assert((await runDetector(45, 30, n => 420 - n * 0.67)).results.at(-1)[0].onCourse);  // 大框的小抖動不是遠離
});

test("人近到上下都超出畫面：TTC 繼續倒數，升得上「停」", async () => {
  // 框高固定後就量不到靠近速度了，但人還在走過來
  const clippedHeight = n => (n < 12 ? 1190 / (4 - 0.21 * n) : 2000);
  const yolo = new FakeYolo(clippedHeight);
  yolo.detect = async function () {
    const hh = clippedHeight(this.calls++), half = Math.min(hh / 2, 240), wide = Math.min(hh * 0.2, 150);
    return [{ box: [Math.round(320 - wide), Math.round(240 - half), Math.round(320 + wide), Math.round(240 + half)], score: 0.9, rawLabel: "person" }];
  };
  const det = new HazardDetector(yolo, null), ttcs = [];
  for (let i = 0; i < 30; i++) {
    const [tr] = await det.process(scene, (i + 1) / 10);
    if (tr) ttcs.push(tr.ttcSec);
  }
  const finite = ttcs.filter(Number.isFinite);
  assert(finite.length && finite.at(-1) <= C.TTC_URGENT_SEC, `最後的 TTC 應該倒數到「停」的範圍，實際 ${ttcs.slice(-6)}`);
  const late = ttcs.slice(-8).filter(Number.isFinite);
  assert(late.every((v, i) => i === 0 || v <= late[i - 1] + 1e-6), `要一路往下：${late}`);
});

// ---------- 腳底向量：斜向走來、交錯而來的行人 ----------
// 依針孔幾何把地面上的人（橫向 x、前方 z 公尺）畫成框；鏡頭高 1.2 m、人高 1.7 m、焦距 700
// tilt：手機沒拿水平時，整個畫面上下偏移幾像素（正值 = 鏡頭朝上，畫面內容往下移）
function personBox(x, z, tilt = 0) {
  const height = 700 * 1.7 / z, footX = 320 + 700 * x / z, footY = 240 + tilt + 700 * 1.2 / z;
  return [footX - height * 0.175, footY - height, footX + height * 0.175, footY].map(Math.round);
}
// path(t) 回傳 [x, z]；回傳每一幀的追蹤結果（每秒 10 幀）
async function walk(path, seconds, tilt = 0) {
  const yolo = new FakeCrowd(n => { const [x, z] = path(n / 10); return z > 0.4 ? [personBox(x, z, tilt)] : []; });
  const det = new HazardDetector(yolo, null), frames = [];
  for (let i = 0; i < seconds * 10; i++) frames.push(await det.process(scene, (i + 1) / 10));
  return frames;
}
test("腳底向量：落地點換算到地面、速度向量指向使用者就是會撞上", () => {
  const [x, z] = A.groundPoint(700 * 2 / 6, 700 * 1.2 / 6, 640, 480);
  close(x, 2); close(z, 6);
  eq(A.groundPoint(100, C.GROUND_MIN_BELOW_PX - 1, 640, 480), null, "太接近地平線不換算");
  const samples = (p0, v) => [...Array(6).keys()].map(i => [i * 0.1, p0[0] + v[0] * i * 0.1, p0[1] + v[1] * i * 0.1]);
  const toward = A.groundApproach(samples([2, 6], [-0.5, -1.5]));
  close(toward.ttc, 3.5, 1e-6); assert(toward.missM < 1e-6);
  const passing = A.groundApproach(samples([1, 6], [0, -2.5]));
  close(passing.missM, 1, 1e-6);
  eq(A.groundApproach(samples([2, 6], [0.5, 1])).ttc, Infinity, "遠離");
  eq(A.groundApproach(samples([0, 3], [0, 0])).ttc, Infinity, "沒在動");
  eq(A.groundApproach(samples([2, 6], [-0.5, -1.5]).slice(0, C.GROUND_MIN_SAMPLES - 1)), null, "樣本不夠");
});
test("腳底向量：斜向走來的人方位不變，畫面外推會漏掉，腳底向量抓得到", async () => {
  // 從右前方 2 m、前方 6 m 朝使用者直直走來，4 秒後撞上：在畫面上的左右位置完全不動
  const toward = t => [2 * (1 - t / 4), 6 * (1 - t / 4)];
  const enabled = C.GROUND_VECTOR_ENABLED;
  C.GROUND_VECTOR_ENABLED = false;
  let old;
  try { old = await walk(toward, 3.5); } finally { C.GROUND_VECTOR_ENABLED = enabled; }
  const oldFirst = old.findIndex(anyDanger);
  assert(oldFirst < 0 || 4 - oldFirst / 10 < 1.5, `（對照）只靠畫面外推時，要到剩不到 1.5 秒才發現，實際第 ${oldFirst} 幀`);
  const frames = await walk(toward, 3.5);
  const first = frames.findIndex(anyDanger);
  assert(first >= 0, "腳底向量要判定會撞上");
  const truth = 4 - first / 10, tr = frames[first][0];
  assert(truth >= 2.5, `要在 TTC 約 3 秒時就判定，實際離撞上剩 ${truth.toFixed(1)} 秒`);
  assert(Math.abs(tr.ttcSec - truth) < 0.4, `TTC ${tr.ttcSec}，應約 ${truth}`);
  eq(tr.ttcSource, "ground");
  // 走近到腳出了畫面之後繼續倒數，升得上「停」
  const urgent = frames.findIndex(f => f.some(t => t.inCollisionZone && t.ttcSec <= C.TTC_URGENT_SEC));
  assert(urgent > first, "腳出畫面後要繼續倒數到「停」");
  for (const f of frames.slice(first, urgent + 1)) assert(anyDanger(f), "中途不能解除");
});
test("腳底向量：錯身而過、遠處橫越、站在旁邊的人不算", async () => {
  const quiet = async (name, path, seconds) => {
    const frames = await walk(path, seconds), bad = frames.findIndex(anyDanger);
    assert(bad < 0, `${name}：第 ${bad} 幀誤判會撞上（TTC ${frames[bad]?.[0]?.ttcSec}）`);
  };
  await quiet("錯身", t => [1.1, 9 - 2.5 * t], 3);                  // 對向走來，橫向隔 1.1 公尺
  await quiet("遠處橫越", t => [2 - 1.4 * t, 6], 3);                // 在 6 公尺外從右走到左
  await quiet("站在旁邊", t => [1.2, 8 - 1.2 * t], 4);              // 使用者往前走，對方站著不動
  await quiet("斜向走遠", t => [0.5 + 0.5 * t, 4 + 0.8 * t], 3);
});
test("腳底向量：手機朝上或朝下拿幾度，結果一樣", async () => {
  // 60 像素約 5 度。整個身體都看得到時用框高當尺，不必假設地平線在畫面正中央
  const [x, z] = A.groundPointByHeight(700 * 2 / 6, 700 * 1.7 / 6, "person", 640, 480);
  close(x, 2); close(z, 6);
  eq(A.groundPointByHeight(100, 200, "chair", 640, 480), null, "不知道實際高度的類別不用這個算法");
  for (const tilt of [-60, 60]) {
    const frames = await walk(t => [2 * (1 - t / 4), 6 * (1 - t / 4)], 2, tilt), first = frames.findIndex(anyDanger);
    assert(first >= 0 && 4 - first / 10 >= 2.5, `偏移 ${tilt} 像素：要在約 3 秒前判定，實際第 ${first} 幀`);
    assert(Math.abs(frames[first][0].ttcSec - (4 - first / 10)) < 0.4, `偏移 ${tilt} 像素：TTC ${frames[first][0].ttcSec}`);
    const passing = await walk(t => [1.1, 9 - 2.5 * t], 2.4, tilt), bad = passing.findIndex(anyDanger);
    assert(bad < 0, `偏移 ${tilt} 像素：錯身而過第 ${bad} 幀誤判會撞上`);
  }
});
test("腳底向量：對方停下來或走開，倒數就停", async () => {
  // 斜向走來、腳出了畫面之後（約 3 公尺）掉頭走開
  const frames = await walk(t => (t < 2 ? [2 * (1 - t / 4), 6 * (1 - t / 4)] : [1 + 0.3 * (t - 2), 3 + 1.2 * (t - 2)]), 4);
  assert(frames.slice(0, 20).some(anyDanger), "走過來的時候要報");
  assert(!frames.slice(-8).some(anyDanger), "走開之後不能還在倒數");
});
test("腳底向量：斜向切進來、會在面前撞上的人要報", async () => {
  // 使用者往前走 1.2 m/s，對方從左邊橫著走過來，兩人 3.5 秒後走到同一點
  const frames = await walk(t => [-1.75 + 0.5 * t, 5.5 - 1.2 * t - 0.37 * t], 3);
  assert(frames.some(anyDanger), "要判定會撞上");
});

// ---------- 交錯（對向錯身而過）：不能太早喊、不能一直重複、聲音不能亂跳 ----------
// 把偵測結果接到警報規則，回傳念過的句子與每一幀的警示音（每秒 10 幀）
async function walkAndListen(path, seconds) {
  const frames = await walk(path, seconds), engine = new AlertEngine(0), said = [], beeps = [];
  frames.forEach((tracks, i) => {
    const u = engine.update(tracks, (i + 1) / 10, false);
    said.push(...texts(u)); beeps.push(u.beep);
  });
  return { said, beeps };
}
test("交錯：對向走來、橫向隔 0.7 公尺錯身而過，不喊危險也不說很快", async () => {
  // 兩個人對向走（相對 2.5 m/s），從 10 公尺外走到身邊。畫面外推在 8 公尺外會把他算成「會撞上」
  for (const side of [0.7, -0.7, 0.9]) {
    const { said, beeps } = await walkAndListen(t => [side, 10 - 2.5 * t], 3.8);
    eq(said, [], `橫向隔 ${side} 公尺`);
    assert(beeps.every(b => !b), `橫向隔 ${side} 公尺不該有警示音`);
  }
});
test("交錯：正面走來的人照樣在 3 秒前喊危險、再喊停", async () => {
  for (const side of [0, 0.2]) {
    const { said } = await walkAndListen(t => [side, 10 - 2.5 * t], 3.8);
    assert(said[0]?.startsWith("危險") && said.some(x => x.startsWith("停")), `橫向隔 ${side} 公尺：${JSON.stringify(said)}`);
  }
  const frames = await walk(t => [0, 10 - 2.5 * t], 3.8), first = frames.findIndex(anyDanger);
  assert(first >= 0 && 4 - (first + 1) / 10 >= 2.6, `第 ${first} 幀才判定，離撞上只剩 ${(4 - (first + 1) / 10).toFixed(1)} 秒`);
});
test("交錯：只有一幀判定會撞上（框抖了一下）不算", async () => {
  // 站在 4 公尺外不動的人，框高只在某一幀跳了一下
  const det = new HazardDetector(new FakeCrowd(n => [personBox(0.2, n === 12 ? 3.6 : 4)]), null);
  for (let i = 0; i < 25; i++) assert(!anyDanger(await det.process(scene, (i + 1) / 10)), `第 ${i} 幀誤判會撞上`);
});
test("交錯：一串人陸續走來，同一句話不會連續念，「停」不受限", () => {
  const engine = new AlertEngine(0), spoken = [];
  // 每 2.5 秒換一個新的人（新的追蹤編號），都在右前方、都判定會撞上
  for (let i = 0; i < 100; i++) {
    const t = i / 10, id = 1 + Math.floor(t / 2.5);
    texts(engine.update([track({ trackId: id, ttcSec: 2.6, inCollisionZone: true, horizontalPosition: "right" })], t, false))
      .forEach(x => spoken.push([t, x]));
  }
  assert(spoken.length >= 2, "隔得夠久還是要再提醒");
  for (let i = 1; i < spoken.length; i++) {
    assert(spoken[i][0] - spoken[i - 1][0] >= C.SAME_TEXT_GAP_SEC - 1e-9, `同一句只隔 ${spoken[i][0] - spoken[i - 1][0]} 秒：${JSON.stringify(spoken)}`);
  }
  const u = engine.update([track({ trackId: 99, ttcSec: 1, inCollisionZone: true, horizontalPosition: "right" })], 10.1, false);
  eq(texts(u), ["停，右前方行人"]);
  eq(texts(new AlertEngine(0).update([track({ trackId: 1, ttcSec: 1, inCollisionZone: true })], 0, false)), ["停，正前方行人"]);
});
test("交錯：判定在邊緣閃爍時，警示音節奏不會快慢快慢亂跳", () => {
  const engine = new AlertEngine(0), patterns = [];
  // 一個「很快」的人（慢節奏），會撞上的判定每隔一幀有、一幀沒有（快節奏）
  for (let i = 0; i < 30; i++) {
    const hit = i % 2 === 0;
    const u = engine.update([track({ speedLevel: "fast", speedPctS: 90, ttcSec: 2.5, inCollisionZone: hit, distanceM: 6 })], i / 10, false);
    patterns.push(JSON.stringify(u.beep));
  }
  eq(new Set(patterns).size, 1, "節奏應該維持在比較急的那一種");
  // 變急要馬上變；危險過了、穩定一小段時間後才變緩
  const calm = [];
  for (let i = 30; i < 50; i++) calm.push(engine.update([track({ speedLevel: "fast", speedPctS: 90, ttcSec: 2.5, distanceM: 6 })], i / 10, false).beep);
  eq(calm[0], A.beepPattern("near")); eq(calm.at(-1), A.beepPattern("far"));
  eq(engine.update([track({ ttcSec: 1, inCollisionZone: true })], 5.0, false).beep, A.beepPattern("close"));
});

test("危險消失：警示音馬上停、念到一半的警報切掉，漏抓一幀不算消失", () => {
  const engine = new AlertEngine(0), near = [nearPerson()];
  assert(engine.update(near, 0, false).beep);
  assert(engine.update([], 0.1, true).beep, "只漏抓一幀，警示音不能斷");
  assert(!engine.update([], 0.1, true).hush);
  assert(engine.update(near, 0.2, true).beep);
  const gone = engine.update([], 0.2 + C.BEEP_OFF_HOLD_SEC, true);
  eq(gone.beep, null); assert(gone.hush, "還在念的警報要切掉");
  assert(!engine.update([], 30, true).hush, "很久以後的語音不是警報（例如電量提醒），不能切");
});

// ---------- 模型下載：斷線、卡住、不完整都要拿到完整的檔案 ----------
const DATA = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
function fakeServer(script) {
  // script[i]：第 i 次要求的行為 {cut: 傳到第幾位元組就斷, stall: true, status, noRange: true}
  const real = globalThis.fetch, seen = [];
  globalThis.fetch = async (url, options = {}) => {
    const range = options.headers?.Range;
    const from = range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
    const step = script[seen.length] || {};
    seen.push(range || "");
    if (step.reject) throw new TypeError("network error");
    if (step.status) return new Response("", { status: step.status });
    const start = step.noRange ? 0 : from, end = step.cut ?? DATA.length, body = DATA.slice(start, Math.max(start, end));
    let sent = false;
    const stream = new ReadableStream({ pull(c) {
      if (!sent && body.length) { sent = true; c.enqueue(body); return; }   // 先把資料交出去，下一次才斷（立刻出錯的話資料會被丟掉）
      if (step.stall) {
        options.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        return new Promise(() => {});
      }
      if (step.cut != null) c.error(new TypeError("network error")); else c.close();
    } });
    const size = DATA.length - start;
    return new Response(stream, { status: range && !step.noRange ? 206 : 200, headers: { "content-length": String(size) } });
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}
const fastRetry = { stallMs: 80, retryMs: 1 };
async function downloadsCompletely(script, check = () => {}) {
  const srv = fakeServer(script);
  try {
    const bytes = await downloadWithRetry("x.onnx", () => {}, fastRetry);
    eq(bytes.length, DATA.length);
    assert(bytes.every((v, i) => v === DATA[i]), "內容要完全一樣");
    check(srv.seen);
  } finally { srv.restore(); }
}
test("下載：傳到一半斷線，接著傳不用重來", () => downloadsCompletely([{ cut: 400 }, {}], s => eq(s, ["", "bytes=400-"])));
test("下載：反覆斷線只要有進度就繼續", () => downloadsCompletely(
  [100, 200, 300, 400, 500, 600, 700, 800].map(cut => ({ cut })).concat([{}])));
test("下載：網路卡住不報錯時也會自己接著傳", () => downloadsCompletely([{ cut: 300, stall: true }, {}], s => eq(s[1], "bytes=300-")));
test("下載：伺服器不支援接續就從頭傳，內容不會重複", () => downloadsCompletely([{ cut: 500 }, { noRange: true }]));
test("下載：一時連不上會重試", () => downloadsCompletely([{ reject: true }, { status: 503 }, { reject: true }, {}]));
test("下載：一直連不上才放棄，檔案不存在馬上放棄", async () => {
  for (const [script, calls] of [[Array(9).fill({ reject: true }), 5], [[{ status: 404 }], 1]]) {
    const srv = fakeServer(script);
    let failed = false;
    try { await downloadWithRetry("x.onnx", () => {}, fastRetry); } catch (e) { failed = true; }
    srv.restore();
    assert(failed);
    eq(srv.seen.length, calls);
  }
});

export async function run(log, withModel) {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); log(`PASS ${name}`); } catch (e) { failed++; log(`FAIL ${name}：${e.message}`); }
  }
  if (withModel) {
    try { await modelTests(log); log("PASS 真實模型整合測試"); } catch (e) { failed++; log(`FAIL 真實模型整合測試：${e.message}`); }
  }
  log(`共 ${tests.length + (withModel ? 1 : 0)} 項，失敗 ${failed} 項`);
  return failed;
}
