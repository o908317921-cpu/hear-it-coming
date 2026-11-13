// YOLO 分割 + ByteTrack 追蹤 + 每個物體的危險判斷，以及深度圖的靜態障礙偵測（對應 blindnav/detector.py）。
import { C, classLabel } from "./config.js";
import {
  classifyApproach, classifyGrowth, classifyProximity, collisionProbability, combinedRiskPct, computeIou,
  depthDistanceM, distanceEstimates, effectiveOccupancy, estimatePersonDistanceCm, findDepthHazards, median,
  groundApproach, groundPoint, groundPointByHeight, groundReferenceDistanceM, lateralRate, lateralToSpeedPct, linearSlope, loomingDhDt, predictCollision,
  regressionWindow, relativeVelocity, trajectoryOnCourse, truncationSides,
} from "./analysis.js";
import { maskElongation } from "./yolo.js";
import { ByteTracker } from "./tracker.js";
import { CameraMotionEstimator } from "./motion.js";

// ============================================================
// 影像小工具
// ============================================================
// RGBA → 灰階，同時回傳平均亮度與亮度標準差
export function toGray(rgba, w, h) {
  const gray = new Uint8Array(w * h);
  let sum = 0, squares = 0;
  for (let i = 0, n = w * h; i < n; i++) {
    const v = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
    gray[i] = v;
    sum += v;
    squares += v * v;
  }
  const brightness = sum / (w * h);
  return { gray, brightness, contrast: Math.sqrt(Math.max(0, squares / (w * h) - brightness * brightness)) };
}

// 拉普拉斯變異數（清晰度）：只算 box 範圍內，不被畫面其他清楚的區域稀釋；step 用來跳格加速
export function laplacianVariance(gray, w, h, box = [0, 0, w, h], step = 1) {
  const x1 = Math.max(1, box[0]), y1 = Math.max(1, box[1]);
  const x2 = Math.min(w - 1, box[2]), y2 = Math.min(h - 1, box[3]);
  if (x2 - x1 < 5 || y2 - y1 < 5) return 9999;
  let n = 0, sum = 0, sq = 0;
  for (let y = y1; y < y2; y += step) {
    for (let x = x1; x < x2; x += step) {
      const i = y * w + x;
      const v = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      n++; sum += v; sq += v * v;
    }
  }
  const mean = sum / n;
  return sq / n - mean * mean;
}

function horizontalPosition(box, frameWidth) {
  const ratio = (box[0] + box[2]) / 2 / frameWidth;
  if (ratio < 0.4) return "left";
  if (ratio > 0.6) return "right";
  return "center";
}

const shiftMask = (mask, dx, dy) => (mask ? { ...mask, x: mask.x + dx, y: mask.y + dy } : mask);

// 遮罩畫進深度圖大小的排除圖（1 = YOLO 已追蹤的物體，不算靜態障礙）
function paintMask(exclude, dw, dh, sx, sy, mask, box) {
  if (!mask) {
    for (let y = Math.max(0, Math.floor(box[1] * sy)); y < Math.min(dh, Math.ceil(box[3] * sy)); y++) {
      exclude.fill(1, y * dw + Math.max(0, Math.floor(box[0] * sx)), y * dw + Math.min(dw, Math.ceil(box[2] * sx)));
    }
    return;
  }
  const y0 = Math.max(0, Math.floor(mask.y * sy)), y1 = Math.min(dh, Math.ceil((mask.y + mask.gh * mask.cell) * sy));
  const x0 = Math.max(0, Math.floor(mask.x * sx)), x1 = Math.min(dw, Math.ceil((mask.x + mask.gw * mask.cell) * sx));
  for (let y = y0; y < y1; y++) {
    const gy = Math.floor(((y + 0.5) / sy - mask.y) / mask.cell);
    if (gy < 0 || gy >= mask.gh) continue;
    for (let x = x0; x < x1; x++) {
      const gx = Math.floor(((x + 0.5) / sx - mask.x) / mask.cell);
      if (gx >= 0 && gx < mask.gw && mask.data[gy * mask.gw + gx]) exclude[y * dw + x] = 1;
    }
  }
}

// 同一類別、重疊度過高的偵測只保留一個：優先保留 YOLO 真正看到的，其次保留面積大的
export function deduplicateDetections(dets, iouThreshold = C.DEDUP_IOU_THRESHOLD) {
  if (dets.length <= 1) return dets;
  const ordered = [...dets].sort((a, b) =>
    (Number(!b.predicted) - Number(!a.predicted)) || (b.realArea - a.realArea));
  const kept = [];
  for (const d of ordered) {
    if (!kept.some(k => k.label === d.label && computeIou(d.box, k.box) > iouThreshold)) kept.push(d);
  }
  return kept;
}

// ============================================================
// 核心偵測 / 追蹤 / 危險判斷
// ============================================================
// a 的框有多少比例被 b 蓋住
function overlapRatio(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
}

export class HazardDetector {
  // yolo：YoloSegmenter；depth：DepthWorker 或 null（關閉頭部高度障礙偵測）
  constructor(yolo, depth = null) {
    this.yolo = yolo;
    this.depth = depth;
    this.tracker = new ByteTracker();
    this.motionEstimator = new CameraMotionEstimator();
    this.reset();
  }

  reset() {
    this.trackedObjects = new Map();
    this.frameIndex = 0;
    this.lastDetectTs = null;
    this.tracker.reset();
    this.motionEstimator.reset();
    this.cameraMotion = { vx: 0, vy: 0, offsetX: 0, offsetY: 0, source: "none", pathCenterX: null };
    this.staticHazards = [];
    this.staticState = new Map();
    this.lastDepthTs = null;
    this.depthBoxes = new Map();      // 送去算深度的時間 → 當時物體的位置
    this.brightness = 255;
    this.lastDetectMs = 0;
  }

  // 用最近的追蹤速度推算物體目前位置：兩次 YOLO 之間，以及 YOLO 漏抓時暫留
  predictDetections(w, h, now, trackIds = null) {
    const predicted = [];
    for (const [trackId, track] of this.trackedObjects) {
      if (trackIds && !trackIds.has(trackId)) continue;
      // 物體自己的速度（已扣掉鏡頭轉動）＋鏡頭轉動造成的畫面位移 = 畫面上的位移
      const dt = Math.max(0, now - track.time);
      const dx = (track.vx + this.cameraMotion.vx) * dt;
      const dy = (track.vy + this.cameraMotion.vy) * dt;
      const [x1, y1, x2, y2] = track.box;
      const box = [
        Math.max(0, Math.min(w - 1, Math.trunc(x1 + dx))),
        Math.max(0, Math.min(h - 1, Math.trunc(y1 + dy))),
        Math.max(1, Math.min(w, Math.trunc(x2 + dx))),
        Math.max(1, Math.min(h, Math.trunc(y2 + dy))),
      ];
      if (box[2] <= box[0] || box[3] <= box[1]) continue;
      predicted.push({
        trackId, rawLabel: track.rawLabel, label: track.label, box, realArea: track.realArea,
        mask: shiftMask(track.mask, dx, dy), blurScore: track.blurScore, isBlurry: track.isBlurry,
        elongation: track.elongation, maskQuality: track.maskQuality, predicted: true,
      });
    }
    return predicted;
  }

  // 一次 YOLO + 追蹤；YOLO 這次沒回傳、但剛消失不久的物體用預測位置暫留
  async detect(frame, gray, now) {
    const { canvas, width: w, height: h } = frame;
    const started = performance.now();
    // 整體畫面偏模糊時先銳化再送進 YOLO（每隔一格取樣即可估計清晰度）
    const globalBlur = laplacianVariance(gray, w, h, [0, 0, w, h], 2);
    const raw = await this.yolo.detect(canvas, w, h, { sharpen: globalBlur < C.GLOBAL_BLUR_SHARPEN_THRESHOLD });
    this.lastDetectMs = performance.now() - started;
    const tracked = this.tracker.update(raw, now, this.cameraMotion);

    const detections = [];
    for (const { id: trackId, det } of tracked) {
      const rawLabel = det.rawLabel;
      // 新物體要達到該類別的信心門檻才開始追蹤；已在追蹤中的物體即使這一幀信心度較低也延續
      if (!this.trackedObjects.has(trackId) && det.score < (C.CLASS_CONF_THRESHOLDS[rawLabel] ?? C.TRACK_NEW_CONF)) continue;
      const [x1, y1, x2, y2] = det.box;
      const bw = Math.max(1, x2 - x1), bh = Math.max(1, y2 - y1), aspect = bw / bh;
      if (!this.trackedObjects.has(trackId)) {
        if (bh < C.MIN_BOX_HEIGHT_RATIO * h) continue;
        // 常識檢查：地面上的東西不會在天上（鏡頭大致水平時，它們的底邊都在地平線以下）
        if (y2 < C.GROUND_MIN_FOOT_RATIO * h) continue;
      }
      // 用長寬比排除明顯不合理的分類（例如細長人形被誤判成機車）
      if (rawLabel === "person" && aspect > 1.8) continue;
      if (rawLabel === "motorcycle" && (aspect < 0.45 || aspect > 3.2)) continue;
      if (rawLabel === "bicycle" && (aspect < 0.4 || aspect > 3.2)) continue;
      if (rawLabel === "bus" && aspect < 0.8) continue;
      if ((rawLabel === "car" || rawLabel === "truck") && aspect < 0.35) continue;

      const mask = this.yolo.buildMask(det);
      if (!mask) continue;
      const blurScore = laplacianVariance(gray, w, h, det.box);
      const maskQuality = mask.area / Math.max(1, bw * bh);
      if (rawLabel === "motorcycle" && maskQuality < 0.18) continue;
      if (rawLabel === "person" && aspect > 1.5 && maskQuality < 0.22) continue;
      detections.push({
        trackId, rawLabel, label: classLabel(rawLabel), box: det.box, realArea: mask.area, mask,
        blurScore, isBlurry: blurScore < C.BLUR_VAR_THRESHOLD, elongation: maskElongation(mask), maskQuality,
      });
    }

    const seen = new Set(detections.map(d => d.trackId));
    const held = new Set();
    for (const [trackId, track] of this.trackedObjects) {
      if (!seen.has(trackId) && now - track.lastSeen <= C.TRACK_LOST_HOLD_SEC) held.add(trackId);
    }
    return detections.concat(this.predictDetections(w, h, now, held));
  }

  // ------------------------------------------------------------
  // 靜態障礙：深度圖（樹枝、招牌、柱子）
  // ------------------------------------------------------------
  depthHazards(disp, detections, pathCenterX, w, h) {
    const { width: dw, height: dh } = disp;
    const sx = dw / w, sy = dh / h;
    const exclude = new Uint8Array(dw * dh);
    for (const d of detections) paintMask(exclude, dw, dh, sx, sy, d.mask, d.box);
    // 深度圖是幾百毫秒前的畫面算的，物體「當時」的位置也要挖掉
    for (const box of this.depthBoxes.get(this.lastDepthTs) || []) paintMask(exclude, dw, dh, sx, sy, null, box);
    for (const ts of [...this.depthBoxes.keys()]) if (this.lastDepthTs != null && ts < this.lastDepthTs) this.depthBoxes.delete(ts);
    return findDepthHazards(disp, pathCenterX * sx, C.COLLISION_ZONE_RATIO, exclude).map(item => {
      const box = [Math.round(item.box[0] / sx), Math.round(item.box[1] / sy),
                   Math.round(item.box[2] / sx), Math.round(item.box[3] / sy)];
      return { kind: item.kind, label: C.STATIC_TEXT[item.kind], box, distanceM: item.distanceM,
               horizontalPosition: horizontalPosition(box, w), source: "depth" };
    });
  }

  // 連續 STATIC_CONFIRM_COUNT 次都看到才警示；消失超過 STATIC_RELEASE_SEC 才解除
  confirmStatic(found, now) {
    const seen = new Map(found.map(hz => [hz.kind, hz]));
    for (const [kind, hazard] of seen) {
      const state = this.staticState.get(kind) || { hits: 0, confirmed: false };
      Object.assign(state, { hits: state.hits + 1, lastSeen: now, hazard });
      if (state.hits >= C.STATIC_CONFIRM_COUNT) state.confirmed = true;
      this.staticState.set(kind, state);
    }
    for (const [kind, state] of [...this.staticState]) {
      if (seen.has(kind)) continue;
      state.hits = 0;
      if (now - state.lastSeen > C.STATIC_RELEASE_SEC) this.staticState.delete(kind);
    }
  }

  updateStatic(detections, now, pathCenterX, disp, depthFresh, w, h) {
    if (disp && depthFresh) {
      this.confirmStatic(this.depthHazards(disp, detections, pathCenterX, w, h), now);
    } else if (this.staticState.size && !disp) {
      this.staticState.clear();   // 深度結果過期（例如模型停用）時不要一直警示舊障礙
    }
    this.staticHazards = [...this.staticState.values()].filter(s => s.confirmed).map(s => s.hazard);
  }

  // 處理一幀。frame：{canvas, imageData, width, height}；now：秒；
  // gyro：手機陀螺儀 [偏航, 俯仰] 角速度（rad/s），沒有時傳 null 改用背景位移比對。
  // 回傳追蹤結果；靜態障礙放在 this.staticHazards
  async process(frame, now, gyro = null) {
    this.frameIndex++;
    const { width: w, height: h } = frame;
    const totalPixels = w * h;
    const { gray, brightness, contrast } = toGray(frame.imageData.data, w, h);
    this.brightness = brightness;

    // 相機自體運動：背景要排除上一幀的物體，否則物體的運動會被當成鏡頭轉動
    const motion = this.motionEstimator.update(gray, w, h, now, {
      excludeBoxes: [...this.trackedObjects.values()].map(t => t.box), gyro, pathRatio: C.COLLISION_ZONE_RATIO,
    });
    this.cameraMotion = motion;
    const pathCenterX = motion.pathCenterX;

    // 深度圖在背景執行緒計算，這裡只拿最新、還沒過期的結果
    let disp = null, depthFresh = false;
    // 全黑或幾乎沒有內容的畫面（鏡頭被擋住）：深度模型一樣會算出東西，不能拿來說「頭上有障礙」
    const unseeing = brightness < C.CAMERA_BLOCKED_MEAN || contrast < C.BLANK_FRAME_STD;
    if (this.depth && this.depth.available && !unseeing) {
      if ((this.frameIndex % C.DEPTH_INTERVAL === 1 || C.DEPTH_INTERVAL <= 1) && now - (this.lastDepthSubmit ?? -Infinity) >= C.DEPTH_MIN_INTERVAL_SEC
          && this.depth.submit(frame.canvas, w, h, now) && (this.lastDepthSubmit = now)) {
        this.depthBoxes.set(now, [...this.trackedObjects.values()].map(t => t.box));
      }
      const latest = this.depth.latest(now);
      if (latest) {
        disp = latest.disp;
        depthFresh = latest.ts !== this.lastDepthTs;
        this.lastDepthTs = latest.ts;
      }
    }
    const groundM = groundReferenceDistanceM(w, h);

    const detectionFrame = this.frameIndex === 1 || this.frameIndex % C.DETECTION_INTERVAL === 0
      || this.lastDetectTs == null || now - this.lastDetectTs >= C.DETECTION_MAX_GAP_SEC;
    let current;
    if (contrast < C.BLANK_FRAME_STD) {
      // 這種幀沒有任何資訊（鏡頭被遮住、掉幀），不算漏抓，物體用預測位置暫留
      const held = new Set();
      for (const [trackId, track] of this.trackedObjects) {
        if (now - track.lastSeen <= C.TRACK_LOST_HOLD_SEC) held.add(trackId);
      }
      current = this.predictDetections(w, h, now, held);
    } else if (detectionFrame || !this.trackedObjects.size) {
      this.lastDetectTs = now;
      current = await this.detect(frame, gray, now);
    } else {
      current = this.predictDetections(w, h, now);     // 非偵測幀用追蹤預測，降低運算量
    }
    current = deduplicateDetections(current).filter(d => d.realArea / totalPixels >= C.RELEVANCE_MIN_OCCUPANCY_RATIO);

    // 地面基準：畫面最下方挖掉物體的部分；走到很近時腳會蓋住地面，不能拿物體當基準
    let groundDisp = null;
    if (disp) {
      const top = Math.floor(disp.height * (1 - C.GROUND_STRIP_RATIO));
      const sx = disp.width / w, sy = disp.height / h, pixels = [];
      for (let y = top; y < disp.height; y++) {
        for (let x = 0; x < disp.width; x++) {
          const inBox = current.some(d => x >= d.box[0] * sx && x < d.box[2] * sx && y >= d.box[1] * sy && y < d.box[3] * sy);
          if (!inBox) pixels.push(disp.data[y * disp.width + x]);
        }
      }
      if (pixels.length >= (disp.height - top) * disp.width * 0.25) groundDisp = median(pixels);
    }

    const updated = new Map();
    const results = [];
    for (const det of current) {
      const trackId = det.trackId;
      let prev = this.trackedObjects.get(trackId);
      const isPredicted = !!det.predicted;
      const maskReliable = det.maskQuality > C.MASK_QUALITY_MIN_RATIO;
      const motionBlurConfirmed = det.isBlurry && det.elongation > C.ELONGATION_THRESHOLD;
      const [x1, y1, x2, y2] = det.box;
      const footX = (x1 + x2) / 2, footY = y2;   // 落地點：物體與地面接觸的位置，用來算軌跡
      const height = Math.max(1, y2 - y1);
      let distanceSpeedCmS = 0, approachState = "stable";
      let smoothSpeed, growthRefArea, growthRefTime, debounceCnt, prevState, usedArea, displayMask;
      let stableArea, stableMask, trajHistory, lastSeen, maskRejects = 0;

      if (!prev) {
        smoothSpeed = 0;
        growthRefArea = det.realArea; growthRefTime = now;
        debounceCnt = 0; prevState = "GREEN";
        usedArea = stableArea = det.realArea;
        displayMask = stableMask = det.mask;
        trajHistory = [];
        lastSeen = now;
        prev = null;
      } else {
        // 遮罩穩定度守門：面積相對上一次「穩定值」暴增/暴縮，且沒有動態模糊佐證時，
        // 視為分割雜訊（例如頭髮邊界抖動），沿用上一次穩定的遮罩形狀與面積。
        const areaRatio = det.realArea / Math.max(1, prev.stableArea);
        const abruptJump = areaRatio > 1 + C.MASK_STABILITY_JUMP_RATIO || areaRatio < 1 - C.MASK_STABILITY_JUMP_RATIO;
        let trust = maskReliable && !(abruptJump && !motionBlurConfirmed);
        maskRejects = prev.maskRejects;
        if (!isPredicted) {
          if (!trust && maskRejects < C.MASK_MAX_REJECTS) maskRejects++;
          else { trust = true; maskRejects = 0; }
        }
        const observedArea = trust ? det.realArea : prev.stableArea;
        displayMask = trust ? det.mask : shiftMask(prev.stableMask, (x1 - prev.box[0]), (y1 - prev.box[1]));
        stableArea = observedArea; stableMask = displayMask;

        // 面積變化率（%/秒）只在兩次「真正 YOLO 偵測」之間計算，避免預測幀造成假尖峰
        growthRefArea = prev.growthRefArea; growthRefTime = prev.growthRefTime;
        const growthDt = now - growthRefTime;
        if (!isPredicted && growthDt > 0.02) {
          const rawGrowth = ((observedArea - growthRefArea) / Math.max(1, growthRefArea)) / growthDt;
          smoothSpeed = (1 - C.EMA_ALPHA) * prev.smoothSpeed + C.EMA_ALPHA * rawGrowth;
          growthRefArea = observedArea; growthRefTime = now;
        } else {
          smoothSpeed = prev.smoothSpeed;
        }
        debounceCnt = prev.debounceCnt;
        prevState = prev.state;
        usedArea = observedArea;
        lastSeen = isPredicted ? prev.lastSeen : now;
        trajHistory = prev.trajHistory;
      }

      // 軌跡回歸：落地點先扣掉鏡頭轉動的累積位移；時間窗取近 1 秒或近 8 次偵測（較短者），至少 3 次。
      // 預測幀的框高只是沿用舊值，當成樣本會把 dh/dt 拉低、TTC 高估，所以只記真正偵測到的框。
      // 人多時的兩種假靠近：被前面的人擋住（框忽大忽小）、追蹤把兩個人搞混（框高瞬間跳變）。都不是真的靠近
      const occludedByFront = current.some(other => other !== det && !other.predicted
        && other.box[3] > y2 + 4 && overlapRatio(det.box, other.box) > C.OCCLUDED_OVERLAP_RATIO);
      if (!isPredicted && !occludedByFront) {
        const last = trajHistory[trajHistory.length - 1];
        if (last && Math.abs(Math.log(height / Math.max(1, last[3]))) > C.SCALE_JUMP_BASE + C.SCALE_JUMP_PER_SEC * (now - last[0])) {
          trajHistory = [];
        }
        const sidesNow = truncationSides(det.box, w, h);
        trajHistory = trajHistory.concat([[now, footX - motion.offsetX, footY - motion.offsetY, height, x2 - x1,
                                           h / 2 + motion.offsetY - y1, sidesNow.has("left") || sidesNow.has("right"),
                                           sidesNow.has("bottom"), sidesNow.has("top")]])
          .slice(-C.TRAJECTORY_HISTORY_LEN);
      }
      const win = regressionWindow(trajHistory, now);
      let vx = 0, vy = 0, dhDt = 0;
      if (prev && win.length >= C.TRAJECTORY_MIN_FRAMES && !occludedByFront) {
        const ts = win.map(p => p[0]), hs = win.map(p => p[3]);
        vx = linearSlope(ts, win.map(p => p[1]));
        vy = linearSlope(ts, win.map(p => p[2]));
        const halfPath = w * C.COLLISION_ZONE_RATIO / 2;
        dhDt = loomingDhDt(win, height, truncationSides(det.box, w, h),
          x1 < pathCenterX + halfPath && x2 > pathCenterX - halfPath, h);
        const rawDistanceSpeed = -linearSlope(ts, hs.map(estimatePersonDistanceCm));
        distanceSpeedCmS = (1 - C.DISTANCE_SMOOTH_ALPHA) * prev.distanceSpeedCmS + C.DISTANCE_SMOOTH_ALPHA * rawDistanceSpeed;
        approachState = classifyApproach(distanceSpeedCmS);
      }

      // 碰撞時間預測（TTC）與軌跡外推：分辨「衝著使用者來」與「只是從旁邊經過」
      let [ttc, predictedPoint, inCollisionZone] = predictCollision({
        footX, footY, objectWidth: x2 - x1, frameWidth: w, frameHeight: h, vx, vy, height, dhDt,
        pathRatio: C.COLLISION_ZONE_RATIO, centerX: pathCenterX,
      });
      // 腳底向量：看得到腳的那幾次偵測，把落地點換算到地面，用地面上的相對速度向量找最接近的時刻。
      // 落地點存的是扣掉鏡頭轉動的值：加回現在的累積位移，就是它在「現在這個畫面」裡的位置
      let ground = null, groundHits = 0, ttcSource = "looming";
      if (C.GROUND_VECTOR_ENABLED && prev && !occludedByFront) {
        // 腳被畫面下緣切掉：框底不是落地點。側邊被切掉：框的中心不是人的中心，露出來的部分變多會被當成橫向移動
        const visible = win.filter(p => !p[7] && !p[6]);
        // 整個身體都看得到、又知道這類物體大概多高：用框高當尺，不必假設手機拿得水平。
        // 同一段軌跡只用一種算法，混著用時兩種算法的落差會被當成速度
        const byHeight = C.CLASS_REAL_HEIGHT_CM[det.rawLabel] != null && visible.every(p => !p[8]);
        const samples = [];
        for (const p of visible) {
          const xPx = p[1] + motion.offsetX - pathCenterX;
          const point = byHeight ? groundPointByHeight(xPx, p[3], det.rawLabel, w, h) : groundPoint(xPx, p[2] - h / 2, w, h);
          if (point && point[1] <= C.GROUND_MAX_RANGE_M) samples.push([p[0], point[0], point[1]]);
        }
        ground = groundApproach(samples, now);
        const courseHit = !!ground && ground.missM <= C.GROUND_HIT_RADIUS_M;
        groundHits = courseHit ? prev.groundHits + (isPredicted ? 0 : 1) : 0;
        // 框高那邊已經判定會撞上、而且更早到，就照原來的；否則以腳底向量為準
        if (courseHit && groundHits >= C.GROUND_CONFIRM_HITS && !(inCollisionZone && ttc <= ground.ttc)) {
          const reach = w * C.COLLISION_ZONE_RATIO / 2 + Math.max(1, (x2 - x1) / 2);
          ttc = ground.ttc;
          predictedPoint = [pathCenterX + ground.missX / C.GROUND_HIT_RADIUS_M * reach, h - 1];
          inCollisionZone = true;
          ttcSource = "ground";
        }
      }
      const prevTtc = prev ? prev.ttcSec : Infinity;
      const prevHold = prev ? prev.ttcHoldCount : 0;
      // 暫留時不是停在舊值：物體還在靠近，TTC 要跟著時間倒數，「危險」才升得上「停」
      const countdown = Number.isFinite(prevTtc) ? Math.max(0, prevTtc - (now - prev.ttcTime)) : Infinity;
      // 上下都超出畫面：框高已經不會再變大，量到的成長率只是雜訊，不能拿來把 TTC 往後推
      const sidesForTtc = truncationSides(det.box, w, h);
      const clipped = sidesForTtc.has("top") && sidesForTtc.has("bottom");
      const clippedHold = clipped && prev && now - prev.ttcMeasuredAt <= C.TTC_CLIPPED_HOLD_SEC;
      // 腳底向量判定會撞上之後，人走近到腳出了畫面就量不到落地點了，但他還在走過來：照最後的 TTC 繼續倒數。
      // 這時框高那邊算得出 TTC、卻因為畫面上的位置沒動而認為不會撞上，不能讓它把警報取消
      // 框明顯在變小就是對方停下來或走開了，不再倒數
      const shrinking = dhDt <= -Math.max(C.MIN_DH_DT_FOR_TTC, C.RECEDING_MIN_RATE * height);
      const groundHold = ttcSource !== "ground" && prev && prev.ttcSource === "ground" && sidesForTtc.has("bottom")
        && !shrinking && now - prev.ttcMeasuredAt <= C.TTC_CLIPPED_HOLD_SEC;
      const measured = Number.isFinite(ttc) && !(clippedHold && ttc > countdown) && !(groundHold && !inCollisionZone);
      let heldTtc, holdCount;
      if (measured) [heldTtc, holdCount] = [ttc, 0];
      else if (Number.isFinite(countdown) && (prevHold < C.TTC_HOLD_FRAMES || clippedHold || groundHold)) [heldTtc, holdCount] = [countdown, prevHold + 1];
      else [heldTtc, holdCount] = [Infinity, 0];
      const ttcMeasuredAt = measured ? now : (prev ? prev.ttcMeasuredAt : now);
      // dh/dt 短暫低於門檻時 TTC 暫留，「會不會撞上」也要跟著暫留，否則警報與警示音會一閃一閃
      if (!measured && Number.isFinite(heldTtc)) {
        inCollisionZone = prev.inCollisionZone;
        ttcSource = prev.ttcSource;
        if (groundHold) [ttc, predictedPoint] = [heldTtc, [pathCenterX, h - 1]];
      }
      const [relativeVx, relativeVy] = relativeVelocity(vx, vy);
      let probability = collisionProbability({
        ttc, predictedX: predictedPoint[0], objectWidth: x2 - x1, frameWidth: w,
        pathRatio: C.COLLISION_ZONE_RATIO, maxTtc: C.TTC_DANGER_SEC, centerX: pathCenterX,
      });

      const occupancyRatio = usedArea / totalPixels;
      const proximityScale = C.PROXIMITY_CLASS_SCALE[det.rawLabel] ?? 1;

      // 多線索距離：深度圖取物體框中央一半區域的逆深度中位數（避開邊緣混到背景）
      let depthM = Infinity, depthTime = prev ? prev.depthTime : -1e9;
      if (disp && groundDisp && depthFresh) {
        depthTime = now;
        const sx = disp.width / w, sy = disp.height / h;
        const qw = (x2 - x1) / 4, qh = (y2 - y1) / 4;
        const cx0 = Math.floor((x1 + qw) * sx), cx1 = Math.max(cx0 + 1, Math.ceil((x2 - qw) * sx));
        const cy0 = Math.floor((y1 + qh) * sy), cy1 = Math.max(cy0 + 1, Math.ceil((y2 - qh) * sy));
        const core = [];
        for (let y = cy0; y < Math.min(cy1, disp.height); y++) {
          for (let x = cx0; x < Math.min(cx1, disp.width); x++) core.push(disp.data[y * disp.width + x]);
        }
        if (core.length) depthM = depthDistanceM(median(core), groundDisp, groundM);
      } else if (prev && now - depthTime <= C.DEPTH_MAX_AGE_SEC) {
        depthM = prev.depthM;
      }
      const [fusedM, occluded, truncated] = distanceEstimates(det.rawLabel, det.box, occupancyRatio, det.maskQuality,
        w, h, depthM, proximityScale);
      const levelRatio = effectiveOccupancy(occupancyRatio, fusedM, occluded, truncated, proximityScale);
      const ttcWarningSec = C.TTC_DANGER_SEC * C.TTC_WARNING_MULTIPLIER;

      // TTC 狀態機：預測碰撞時間已降至危險門檻內、且會進入使用者行走路徑才算危險
      const formulaHit = Number.isFinite(ttc) && ttc <= C.TTC_DANGER_SEC && inCollisionZone;
      const warningRaw = (Number.isFinite(ttc) && ttc <= ttcWarningSec && inCollisionZone)
        || occupancyRatio > C.WARNING_OCCUPANCY_RATIO;
      debounceCnt = formulaHit ? C.DEBOUNCE_ON_THRESHOLD : Math.max(0, debounceCnt - 1);
      let state;
      if (formulaHit || debounceCnt >= C.DEBOUNCE_ON_THRESHOLD) state = "RED";
      else if (prevState === "RED" && debounceCnt > 0) state = "RED";
      else if (warningRaw) state = "YELLOW";
      else state = "GREEN";

      // 速度 = 「朝鏡頭靠近」與「橫向穿越行走路徑」兩者取大者
      const growthPctS = smoothSpeed * 100;
      const latRate = lateralRate(relativeVx, footX, w, height, C.COLLISION_ZONE_RATIO, pathCenterX);
      const lateralPct = lateralToSpeedPct(latRate);
      const speedPctS = Math.max(growthPctS, lateralPct);
      // 物體後退時 growth 是負值，不能因此把「沒在動」判成橫越
      const speedSource = lateralPct > Math.max(growthPctS, 0) ? "lateral" : "approach";

      // 距離分級：遮擋或截斷時改用融合距離反推的比例；框貼齊畫面下緣（腳已出畫面）至少偏近
      let proximityLevel = classifyProximity(levelRatio, prev ? prev.proximityLevel : null, proximityScale);
      if (C.TRUNCATED_BOTTOM_MIN_ORANGE && truncated.has("bottom") && proximityLevel === "GREEN"
          && height >= C.TRUNCATED_NEAR_MIN_HEIGHT * h) proximityLevel = "ORANGE";
      const speedLevel = classifyGrowth(speedPctS, prev ? prev.speedLevel : null);
      // 以預測軌跡為主：沿軌跡外推後不在行走路徑上、或正在遠離的物體，距離與速度風險打折
      const receding = dhDt <= -Math.max(C.MIN_DH_DT_FOR_TTC, C.RECEDING_MIN_RATE * height);
      const onCourse = !receding && (inCollisionZone || trajectoryOnCourse(footX, x2 - x1, w, relativeVx, ttc,
        C.COLLISION_ZONE_RATIO, C.COURSE_HORIZON_SEC, pathCenterX));
      probability = combinedRiskPct(probability, levelRatio, proximityLevel, speedPctS, speedLevel, proximityScale, onCourse);

      updated.set(trackId, {
        rawLabel: det.rawLabel, label: det.label, box: det.box, realArea: usedArea, smoothSpeed,
        growthRefArea, growthRefTime, debounceCnt, state, time: now, lastSeen, stableArea, stableMask,
        trajHistory, distanceSpeedCmS, mask: displayMask, vx, vy, blurScore: det.blurScore,
        isBlurry: det.isBlurry, elongation: det.elongation, maskQuality: det.maskQuality,
        ttcSec: heldTtc, ttcHoldCount: holdCount, ttcTime: now, ttcMeasuredAt, proximityLevel, speedLevel, depthM, depthTime,
        inCollisionZone, maskRejects, groundHits, ttcSource,
      });

      results.push({
        trackId, label: det.label, rawLabel: det.rawLabel, box: det.box, mask: displayMask, state,
        smoothSpeed, occupancyRatio, blurScore: det.blurScore, elongation: det.elongation, motionBlurConfirmed,
        maskReliable, horizontalPosition: horizontalPosition(det.box, w), growthPctS, lateralRate: latRate,
        speedPctS, speedSource, speedLevel, ttcSec: heldTtc, predictedPoint, inCollisionZone, onCourse,
        collisionProbability: probability, predictedOffsetPx: predictedPoint[0] - pathCenterX,
        vx, vy, relativeVx, relativeVy, distanceCm: fusedM * 100, distanceSpeedCmS, approachState, proximityLevel,
        isPredicted, distanceM: fusedM, occluded, truncated: [...truncated].sort(),
        ttcSource, groundVector: ground && { x: ground.x, z: ground.z, vx: ground.vx, vz: ground.vz, missM: ground.missM },
      });
    }

    this.trackedObjects = updated;
    this.updateStatic(current, now, pathCenterX, disp, depthFresh, w, h);
    return results;
  }
}
