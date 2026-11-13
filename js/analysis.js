// 核心演算法：分級、TTC、碰撞預測、多線索距離、深度圖靜態障礙等純計算（對應 blindnav/analysis.py）。
import { C } from "./config.js";

export function computeIou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

export function median(values) {
  const n = values.length;
  if (!n) return NaN;
  const sorted = Float64Array.from(values).sort();
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// 依「面積變化率」(%/秒) 分級：慢/中/快。已在較高等級時要降到門檻 × SPEED_HYSTERESIS 以下才降級。
export function classifyGrowth(growthPctS, prevLevel = null) {
  let walkMax = C.GROWTH_WALK_MAX_PCT_S, runMin = C.GROWTH_RUN_MIN_PCT_S;
  if (prevLevel === "fast") runMin *= C.SPEED_HYSTERESIS;
  if (prevLevel === "medium" || prevLevel === "fast") walkMax *= C.SPEED_HYSTERESIS;
  if (growthPctS < walkMax) return "slow";
  if (growthPctS < runMin) return "medium";
  return "fast";
}

// 依 [x, y] 轉折點做分段線性內插；超出最後一點時固定為最後一點的 y。
export function piecewiseLinear(value, points) {
  if (value <= points[0][0]) return points[0][1];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[i + 1];
    if (value <= x1) return y0 + (y1 - y0) * (value - x0) / Math.max(x1 - x0, 1e-9);
  }
  return points[points.length - 1][1];
}

// 0 → 0%、橙色門檻 → 35%、紅色門檻 → 60%、滿格值 → 100%
export function levelToRiskPct(value, orangeAt, redAt, fullAt) {
  return piecewiseLinear(value, [[0, 0], [orangeAt, C.PROBABILITY_ORANGE_PCT],
    [redAt, C.PROBABILITY_RED_PCT], [fullAt, 100]]);
}

// 回傳 [橙色門檻, 紅色門檻, 滿格值]；scale 依物體種類放大（汽車、公車比人大）
export function proximityThresholds(scale = 1.0) {
  return [C.PROXIMITY_ORANGE_RATIO, C.PROXIMITY_RED_RATIO, C.PROXIMITY_FULL_RATIO]
    .map(v => Math.min(C.PROXIMITY_MAX_RATIO, v * scale));
}

// 橫向速度（每秒移動幾個物體高度）。只計算「已在行走路徑上」或「正朝路徑移動」的物體。
export function lateralRate(relativeVx, footX, frameWidth, heightPx, pathRatio = C.COLLISION_ZONE_RATIO,
                            centerX = null) {
  const offset = footX - (centerX == null ? frameWidth / 2 : centerX);
  const inPath = Math.abs(offset) <= frameWidth * pathRatio / 2;
  const movingTowardPath = offset * relativeVx < 0;
  if (!(inPath || movingTowardPath)) return 0;
  return Math.abs(relativeVx) / Math.max(heightPx, 1);
}

// 橫向速度換算到與「面積變化率」相同的刻度，兩種速度才能放在同一條速度條上比較
export function lateralToSpeedPct(rate) {
  return piecewiseLinear(rate, [
    [0, 0],
    [C.LATERAL_MEDIUM_RATE, C.GROWTH_WALK_MAX_PCT_S],
    [C.LATERAL_FAST_RATE, C.GROWTH_RUN_MIN_PCT_S],
    [C.LATERAL_FAST_RATE * 2.5, C.GROWTH_GAUGE_MAX_PCT_S],
  ]);
}

// 碰撞風險 = TTC 預測、距離、速度三者取最大值；並保證橙色 ≥ 35%、紅色 ≥ 60%
// 軌跡不會進入行走路徑（onCourse=false）時，距離與速度只算一部分，也不保底
export function combinedRiskPct(ttcProbability, occupancyRatio, proximityLevel, speedPctS, speedLevel,
                                proximityScale = 1.0, onCourse = true) {
  let proximityRisk = levelToRiskPct(occupancyRatio, ...proximityThresholds(proximityScale));
  let speedRisk = levelToRiskPct(speedPctS, C.GROWTH_WALK_MAX_PCT_S, C.GROWTH_RUN_MIN_PCT_S,
    C.GROWTH_GAUGE_MAX_PCT_S);
  const floors = { ORANGE: C.PROBABILITY_ORANGE_PCT, RED: C.PROBABILITY_RED_PCT,
                   medium: C.PROBABILITY_ORANGE_PCT, fast: C.PROBABILITY_RED_PCT };
  let levelFloor = Math.max(floors[proximityLevel] || 0, floors[speedLevel] || 0);
  if (C.TRAJECTORY_FIRST && !onCourse) {
    proximityRisk *= C.OFF_COURSE_RISK_SCALE;
    speedRisk *= C.OFF_COURSE_RISK_SCALE;
    levelFloor = 0;
  }
  const risk = Math.min(100, Math.max(ttcProbability, proximityRisk, speedRisk, levelFloor));
  return Math.round(risk * 10) / 10;
}

export function riskColor(probability) {
  if (probability >= C.PROBABILITY_RED_PCT) return C.LEVEL_COLORS.RED;
  if (probability >= C.PROBABILITY_ORANGE_PCT) return C.LEVEL_COLORS.ORANGE;
  return C.LEVEL_COLORS.GREEN;
}

// 依物體佔畫面比例分級：GREEN（遠）/ ORANGE（偏近）/ RED（過近），同樣帶遲滯
export function classifyProximity(occupancyRatio, prevLevel = null, scale = 1.0) {
  let [orangeOn, redOn] = proximityThresholds(scale);
  if (prevLevel === "RED") redOn *= C.PROXIMITY_HYSTERESIS;
  if (prevLevel === "ORANGE" || prevLevel === "RED") orangeOn *= C.PROXIMITY_HYSTERESIS;
  if (occupancyRatio >= redOn) return "RED";
  if (occupancyRatio >= orangeOn) return "ORANGE";
  return "GREEN";
}

// 行人用「走路/小跑/跑步」，其他類別用「慢速/中速/快速」
export function speedLevelText(label, level) {
  if (label === C.TARGET_CLASSES.person) return C.PERSON_SPEED_LEVEL_TEXT[level];
  return C.SPEED_LEVEL_TEXT[level];
}

// 對一組 (時間, 數值) 做線性回歸，回傳斜率；比前後兩幀相減更抗雜訊
export function linearSlope(times, values) {
  const n = times.length;
  if (n < 2) return 0;
  const t0 = times[0];
  let mt = 0, mv = 0;
  for (let i = 0; i < n; i++) { mt += times[i] - t0; mv += values[i]; }
  mt /= n; mv /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dt = times[i] - t0 - mt;
    num += dt * (values[i] - mv);
    den += dt * dt;
  }
  return den < 1e-12 ? 0 : num / den;
}

// TTC 達到上限值代表「預測不到會碰撞」，不應顯示成數字
export function ttcIsMeaningful(ttcSec) {
  return Number.isFinite(ttcSec) && ttcSec < C.TTC_MAX_CLAMP_SEC;
}

// 「迫近」(looming) 碰撞時間公式 TTC = h / (dh/dt)；dh/dt 太小視為不會碰撞
export function computeTtc(height, dhDt) {
  if (dhDt < C.MIN_DH_DT_FOR_TTC) return Infinity;
  return Math.max(0, Math.min(height / dhDt, C.TTC_MAX_CLAMP_SEC));
}

export function estimatePersonDistanceCm(pixelHeight) {
  if (pixelHeight <= 1) return Infinity;
  const cameraDistance = C.CAMERA_FOCAL_LENGTH_PX * C.PERSON_REAL_HEIGHT_CM / pixelHeight;
  return Math.sqrt(Math.max(0, cameraDistance ** 2 - C.CAMERA_HEIGHT_CM ** 2));
}

export function classifyApproach(distanceSpeedCmS) {
  if (distanceSpeedCmS > C.APPROACH_SPEED_THRESHOLD_CM_S) return "approaching";
  if (distanceSpeedCmS < -C.APPROACH_SPEED_THRESHOLD_CM_S) return "receding";
  return "stable";
}

// 時間窗回歸：取「近 windowSec 秒」與整段歷史較短者，但至少 minFrames 幀。
// history 的每一項是 [時間, ...]
export function regressionWindow(history, now, windowSec = C.TRAJECTORY_WINDOW_SEC,
                                 minFrames = C.TRAJECTORY_MIN_FRAMES) {
  const recent = history.filter(item => now - item[0] <= windowSec);
  return recent.length < minFrames ? history.slice(-minFrames) : recent;
}

export function relativeVelocity(vx, vy) {
  return [vx - C.CAMERA_VELOCITY_X_PX_S, vy - C.CAMERA_VELOCITY_Y_PX_S];
}

// 預測物體是否會進入使用者行走路徑：TTC = h / (dh/dt)，再用速度外推 TTC 秒後的位置。
// 回傳 [ttc, [預測 x, 預測 y], 是否命中]
export function predictCollision({ footX, footY, objectWidth, frameWidth, frameHeight, vx, vy,
                                   height, dhDt, pathRatio, centerX = null }) {
  const ttc = computeTtc(height, dhDt);
  if (!Number.isFinite(ttc)) return [Infinity, [footX, footY], false];
  const [rvx, rvy] = relativeVelocity(vx, vy);
  const cx = centerX == null ? frameWidth / 2 : centerX;
  const predictedOffset = footX - cx + rvx * ttc;
  const predictedX = cx + predictedOffset;
  const predictedY = footY + rvy * ttc;
  const pathHalf = frameWidth * pathRatio / 2;
  const objectHalf = Math.max(1, objectWidth / 2);
  const insideX = Math.abs(predictedOffset) <= pathHalf + objectHalf;
  // 只排除「往畫面上方退去」的物體。正面走來的物體落地點本來就會超出畫面下緣，
  // 不能當成不會撞上（報告公式 3-6 也只看水平落點）。
  const insideY = predictedY >= -objectWidth;
  return [ttc, [predictedX, predictedY], insideX && insideY];
}

// 影像尺度的相對成長率 (ds/dt)/s，也就是 1/TTC（每秒）。
// 尺度 s = fH/Z 對時間是曲線：直接對 s 做直線回歸，斜率代表的是時間窗中段的成長，
// 時間窗 1 秒時 TTC 3 秒會被算成約 4 秒。等速趨近時 1/s = Z/(fH) 對時間是嚴格的直線，
// 所以改對 1/s 回歸：TTC = (1/s) ÷ (−斜率)，沒有這個偏差。
export function loomingRate(times, sizes) {
  const inverse = sizes.map(s => 1 / Math.max(s, 1));
  const slope = linearSlope(times, inverse);
  const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
  const fittedNow = mean(inverse) + slope * (times[times.length - 1] - mean(times));
  return fittedNow > 0 ? -slope / fittedNow : 0;
}

// 估計框高成長率（可代入 TTC = h / (dh/dt)）。win 的每一項是 [時間, x, y, 高, 寬, 頭頂離地平線, 側邊被切到]。
// 物體上下被畫面切掉時框高不再隨距離等比例變大，TTC 會高估（報告實驗一 0.5 m/s 的誤差來源），
// 這時優先看物體上半部（頭頂到地平線的距離，同樣與距離成反比）的成長率；看不到頭頂才用框寬。
// 框寬在腳被切掉的過程中不可靠：張開的雙腿跑出畫面，框反而變窄，「停」會晚將近 1 秒。
// 腳被切掉又很矮（鏡頭上仰時最下緣露出的一顆頭）量不出靠近速度，不算。
// 框都沒被切到時也要對照框寬：真的靠近時高和寬一起變大，只有高變大多半是從遮擋後露出來。
export function loomingDhDt(win, height, sides, reachesPath = false, frameHeight = 0) {
  if (frameHeight && sides.has("bottom") && !sides.has("top") && height < C.TRUNCATED_NEAR_MIN_HEIGHT * frameHeight) return 0;
  const left = sides.has("left"), right = sides.has("right");
  if (!sides.has("top") && !sides.has("bottom")) {
    // 剛從畫面側邊進來、還沒到路徑：看得到的部分越來越多，框高不代表真的在靠近
    if (left !== right && !reachesPath) return 0;
    if (!left && !right) {
      win = win.filter(p => !p[6]);   // 剛才進場時的殘缺框也不能算
      if (win.length < C.TRAJECTORY_MIN_FRAMES) return 0;
    }
  }
  const ts = win.map(p => p[0]);
  let rate = loomingRate(ts, win.map(p => p[3]));
  const widthRate = !left && !right ? loomingRate(ts, win.map(p => p[4])) : null;
  if (sides.has("top") || sides.has("bottom")) {
    const tops = win.map(p => p[5]);
    if (!sides.has("top") && Math.min(...tops) >= C.TOP_SCALE_MIN_PX) rate = loomingRate(ts, tops);
    else rate = widthRate ?? 0;
  } else if (rate > 0 && widthRate != null && widthRate < rate * C.LOOMING_MIN_WIDTH_SHARE) {
    rate = 0;
  }
  return rate * height;
}

// 判定「會撞上」的半徑（公尺）：愈久以後的事愈不準，半徑愈小
export function hitRadiusM(ttc) {
  return piecewiseLinear(ttc, [[C.TTC_URGENT_SEC, C.GROUND_HIT_RADIUS_M], [C.TTC_DANGER_SEC, C.HIT_RADIUS_FAR_M]]);
}

// 預測軌跡是否會落在使用者行走路徑上：沿橫向速度外推 min(TTC, horizon) 秒。
// 靜止在路徑上、或途中會穿過路徑的物體都算；從旁邊經過、正往外離開的物體不算。
export function trajectoryOnCourse(footX, objectWidth, frameWidth, relativeVx, ttc,
                                   pathRatio = C.COLLISION_ZONE_RATIO, horizon = C.COURSE_HORIZON_SEC,
                                   centerX = null) {
  const cx = centerX == null ? frameWidth / 2 : centerX;
  const t = Number.isFinite(ttc) ? Math.min(ttc, horizon) : horizon;
  const start = footX - cx, end = start + relativeVx * t;
  const reach = frameWidth * pathRatio / 2 + Math.max(1, objectWidth / 2);
  return start * end <= 0 || Math.abs(end) <= reach;
}

// ============================================================
// 腳底向量：落地點換算到地面，在地面上看對方是不是朝使用者走來
// ============================================================
// 畫面上直線外推看不出斜向走來的人：會撞上的人方位固定，在畫面上的左右位置幾乎不動，
// 外推結果永遠是「從旁邊經過」。落地點換算成地面上的公尺座標後，相對速度向量指向使用者就是會撞上。
//
// 落地點 → 地面座標 [橫向 X, 前方 Z]（公尺，使用者在原點、面向 +Z）。
// xFromHeadingPx：落地點離行走方向中心幾像素；belowHorizonPx：落地點在地平線下幾像素
export function groundPoint(xFromHeadingPx, belowHorizonPx, frameWidth, frameHeight) {
  if (!(belowHorizonPx >= C.GROUND_MIN_BELOW_PX)) return null;   // 太接近地平線：差一個像素就是好幾公尺
  const cameraM = C.CAMERA_HEIGHT_CM / 100;
  return [xFromHeadingPx * cameraM / belowHorizonPx, cameraM * focalPx(frameWidth, frameHeight) / belowHorizonPx];
}

// 整個身體都看得到時改用框高當尺：距離 = 焦距 × 實際高度 ÷ 框高，橫向位置再照比例換算。
// 上面的算法要假設手機拿得水平（地平線在畫面正中央），掛在胸前稍微朝下幾度，6 公尺外的人就會差到一倍；
// 用框高就不必知道手機的俯仰。身高跟預設不同只會讓整體等比例縮放，不影響「幾秒後最接近」。
export function groundPointByHeight(xFromHeadingPx, heightPx, rawLabel, frameWidth, frameHeight) {
  const realCm = C.CLASS_REAL_HEIGHT_CM[rawLabel];
  if (realCm == null || !(heightPx > 1)) return null;
  return [xFromHeadingPx * realCm / 100 / heightPx, focalPx(frameWidth, frameHeight) * realCm / 100 / heightPx];
}

// samples：[[時間, X, Z]]。對 X、Z 各做直線回歸得到相對速度向量，算出最接近使用者的時刻與距離。
// now：現在的時間（預設是最後一個樣本）。腳剛出畫面時最後幾個樣本是稍早的，位置要沿速度推到現在，TTC 才不會停住。
// 回傳 {x, z, vx, vz, ttc, missM, missX}；樣本不夠或太舊回傳 null；沒在動或正在遠離時 ttc 為無限大
export function groundApproach(samples, now = null) {
  const n = samples.length;
  if (n < C.GROUND_MIN_SAMPLES || samples[n - 1][0] - samples[0][0] < C.GROUND_MIN_SPAN_SEC) return null;
  const ts = samples.map(s => s[0]);
  const at = now ?? ts[n - 1];
  if (at - ts[n - 1] > C.GROUND_MAX_STALE_SEC) return null;
  const fit = values => {
    const slope = linearSlope(ts, values);
    const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
    return [mean(values) + slope * (at - mean(ts)), slope];   // 用回歸線上「現在」的位置，比單一幀穩定
  };
  const [x, vx] = fit(samples.map(s => s[1])), [z, vz] = fit(samples.map(s => s[2]));
  const out = { x, z, vx, vz, ttc: Infinity, missM: Infinity, missX: x };
  const speedSq = vx * vx + vz * vz;
  if (speedSq < C.GROUND_MIN_SPEED_M_S ** 2) return out;
  const t = -(x * vx + z * vz) / speedSq;
  if (t <= 0) return out;
  out.ttc = Math.min(t, C.TTC_MAX_CLAMP_SEC);
  out.missX = x + vx * t;
  out.missM = Math.hypot(out.missX, z + vz * t);
  return out;
}

// 以 TTC 與預測落點估算 0-100 的碰撞可能性
export function collisionProbability({ ttc, predictedX, objectWidth, frameWidth, pathRatio, maxTtc,
                                       centerX = null }) {
  if (!Number.isFinite(ttc) || ttc > maxTtc) return 0;
  const cx = centerX == null ? frameWidth / 2 : centerX;
  const timeScore = 1 - ttc / Math.max(maxTtc, 1e-6);
  const reach = frameWidth * pathRatio / 2 + Math.max(1, objectWidth / 2);
  const lateralScore = Math.max(0, 1 - Math.abs(predictedX - cx) / reach);
  return Math.round(Math.max(0, Math.min(100, timeScore * lateralScore * 100)) * 10) / 10;
}

// ============================================================
// 多線索距離估測
// ============================================================
// 焦距以長邊 FRAME_WIDTH 的畫面校正；畫面縮放時等比例換算。
// 手機直拿時畫面是 480×640：感光元件還是同一個，要看長邊，用寬邊換算距離會少算 1/4。
export function focalPx(frameWidth, frameHeight = 0) {
  return C.CAMERA_FOCAL_LENGTH_PX * Math.max(frameWidth, frameHeight) / C.FRAME_WIDTH;
}

// 鏡頭水平架設時，畫面最下緣看到的地面離使用者多遠（公尺）
export function groundDistanceM(frameWidth, frameHeight) {
  return C.CAMERA_HEIGHT_CM / 100 * focalPx(frameWidth, frameHeight) / Math.max(frameHeight / 2, 1);
}

// 物體底邊落在地面上時，由它在畫面中的高度推算距離（只在地平線以下有效）
export function groundPlaneDistanceM(footY, frameWidth, frameHeight) {
  const below = footY - frameHeight / 2;
  if (below <= 1) return Infinity;
  return C.CAMERA_HEIGHT_CM / 100 * focalPx(frameWidth, frameHeight) / below;
}

// 深度圖的距離基準：地面基準帶中央那一列地面的距離
export function groundReferenceDistanceM(frameWidth, frameHeight) {
  return groundPlaneDistanceM(frameHeight * (1 - C.GROUND_STRIP_RATIO / 2), frameWidth, frameHeight);
}

// 邊界框碰到哪幾個畫面邊緣：回傳 "top" / "bottom" / "left" / "right" 的 Set
export function truncationSides(box, frameWidth, frameHeight, margin = C.TRUNCATION_MARGIN_PX) {
  const [x1, y1, x2, y2] = box;
  const sides = new Set();
  if (y1 <= margin) sides.add("top");
  if (y2 >= frameHeight - margin) sides.add("bottom");
  if (x1 <= margin) sides.add("left");
  if (x2 >= frameWidth - margin) sides.add("right");
  return sides;
}

// 遮罩面積 ÷ 邊界框面積 明顯低於該類別完整入鏡時的常態值，視為被擋住
export function isOccluded(rawLabel, maskFill) {
  const normal = C.FULL_VIEW_MASK_FILL[rawLabel];
  return normal != null && maskFill < normal * C.OCCLUSION_RATIO;
}

// 比例法：面積與距離平方成反比，以「行人佔 PROXIMITY_ORANGE_RATIO 時約 2 公尺」為基準
export function ratioDistanceM(occupancyRatio, scale = 1.0) {
  if (occupancyRatio <= 0) return Infinity;
  return C.RATIO_REFERENCE_DISTANCE_M * Math.sqrt(C.PROXIMITY_ORANGE_RATIO * scale / occupancyRatio);
}

export function ratioFromDistance(distanceM, scale = 1.0) {
  if (!Number.isFinite(distanceM) || distanceM <= 0) return 0;
  return C.PROXIMITY_ORANGE_RATIO * scale * (C.RATIO_REFERENCE_DISTANCE_M / distanceM) ** 2;
}

// 針孔公式 d = f × H ÷ h
export function pinholeDistanceM(rawLabel, heightPx, frameWidth, frameHeight = 0) {
  const realCm = C.CLASS_REAL_HEIGHT_CM[rawLabel];
  if (realCm == null || heightPx <= 1) return Infinity;
  return focalPx(frameWidth, frameHeight) * realCm / 100 / heightPx;
}

// 深度圖（相對逆深度，越大越近）：d = 地面距離 × 地面逆深度 ÷ 物體逆深度
export function depthDistanceM(disparity, groundDisparity, groundM) {
  if (disparity <= 0 || groundDisparity <= 0) return Infinity;
  return groundM * groundDisparity / disparity;
}

// 多個 [距離, 權重] 依權重加權平均；無效的略過，全部無效回傳無限大
export function fuseDistance(estimates) {
  const valid = estimates.filter(([d, w]) => w > 0 && Number.isFinite(d) && d > 0);
  const total = valid.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return Infinity;
  return valid.reduce((s, [d, w]) => s + d * w, 0) / total;
}

// 回傳 [融合距離, 是否被遮擋, 截斷的邊]
export function distanceEstimates(rawLabel, box, occupancyRatio, maskFill, frameWidth, frameHeight,
                                  depthM = Infinity, scale = 1.0) {
  const sides = truncationSides(box, frameWidth, frameHeight);
  const occluded = isOccluded(rawLabel, maskFill);
  const ratioW = C.FUSION_WEIGHT_RATIO * (occluded || sides.size ? C.FUSION_UNRELIABLE_WEIGHT : 1);
  // 上下被切掉時框高不是真正的高度；物體已經很近，而深度圖近處飽和會讀得太遠
  const cutVertically = sides.has("top") || sides.has("bottom");
  let fused = fuseDistance([
    [ratioDistanceM(occupancyRatio, scale), ratioW],
    [pinholeDistanceM(rawLabel, box[3] - box[1], frameWidth, frameHeight), cutVertically ? 0 : C.FUSION_WEIGHT_PINHOLE],
    [depthM, cutVertically ? 0 : C.FUSION_WEIGHT_DEPTH],
  ]);
  // 腳已出畫面：一定比畫面最下緣看到的地面還近
  if (sides.has("bottom")) fused = Math.min(fused, groundDistanceM(frameWidth, frameHeight));
  return [fused, occluded, sides];
}

// 距離分級用的面積比例；遮擋或截斷時改用融合距離反推的比例（取較大者）
export function effectiveOccupancy(occupancyRatio, fusedM, occluded, sides, scale = 1.0) {
  if (occluded || sides.size) return Math.max(occupancyRatio, ratioFromDistance(fusedM, scale));
  return occupancyRatio;
}

// ============================================================
// 深度圖：靜態障礙（頭部高度障礙、柱子、牆）
// ============================================================
// disparity：{data: Float32Array, width, height}，相對逆深度（越大越近）
// exclude：與 disparity 同大小的 Uint8Array，1 的像素不分析（YOLO 已追蹤的物體）
// 座標都以深度圖本身為準；回傳 [{kind, distanceM, box, centerX, coverage}]
export function findDepthHazards(disparity, pathCenterX, pathRatio = C.COLLISION_ZONE_RATIO, exclude = null,
                                 alertDistanceM = C.STATIC_ALERT_DISTANCE_M) {
  const { data, width: w, height: h } = disparity;
  const groundTop = Math.floor(h * (1 - C.GROUND_STRIP_RATIO));
  const ground = [];
  for (let y = groundTop; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!exclude || !exclude[i]) ground.push(data[i]);
    }
  }
  if (ground.length < w * (h - groundTop) * 0.25) return [];   // 地面幾乎都被擋住
  const groundDisp = median(ground);
  if (!(groundDisp > 0)) return [];
  const groundM = groundReferenceDistanceM(w, h);
  // Depth Anything 輸出的是相對值，近處會飽和，不是嚴格與距離成反比：
  // 實測 2 公尺的人約為地面基準的 1.13 倍，用反比換算要 1.9 倍，等於走到約 1 公尺才會響
  const nearDisp = groundDisp * C.STATIC_NEAR_RATIO;

  const half = w * pathRatio / 2;
  const x0 = Math.floor(Math.max(0, pathCenterX - half));
  const x1 = Math.floor(Math.min(w, pathCenterX + half));
  const split = Math.floor(h * C.OVERHEAD_BAND_RATIO);
  const bands = { upper: [0, split], lower: [split, groundTop] };
  const found = {};
  for (const [band, [y0, y1]] of Object.entries(bands)) {
    const size = (y1 - y0) * (x1 - x0);
    if (size <= 0) continue;
    const nearValues = [];
    let validCount = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, sumX = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        if (exclude && exclude[i]) continue;
        validCount++;
        if (data[i] < nearDisp) continue;
        nearValues.push(data[i]);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        sumX += x;
      }
    }
    if (!validCount) continue;
    const coverage = nearValues.length / size;
    if (coverage < C.STATIC_MIN_AREA_RATIO) continue;
    found[band] = {
      // 同樣因為飽和，換算出來的距離會偏遠；已經判定夠近，就不能回報得比警示距離還遠
      distanceM: Math.min(alertDistanceM, depthDistanceM(median(nearValues), groundDisp, groundM)),
      box: [minX, minY, maxX + 1, maxY + 1],
      centerX: sumX / nearValues.length,
      coverage,
    };
  }
  if (found.lower) {
    const hazard = { ...found.lower, kind: "obstacle" };
    if (found.upper) {            // 上下都有：柱子或牆，框住整段
      const up = found.upper;
      hazard.box = [Math.min(up.box[0], hazard.box[0]), up.box[1],
                    Math.max(up.box[2], hazard.box[2]), hazard.box[3]];
      hazard.distanceM = Math.min(up.distanceM, hazard.distanceM);
    }
    return [hazard];
  }
  if (found.upper) return [{ ...found.upper, kind: "overhead" }];
  return [];
}

// ============================================================
// 警示音（倒車雷達模式）
// ============================================================
export const BEEP_LEVELS = ["far", "near", "close"];   // 由慢到急

export function beepLevel(distanceM, imminent = false) {
  if (imminent || distanceM <= C.BEEP_CLOSE_M) return "close";
  if (distanceM <= C.BEEP_NEAR_M) return "near";
  return "far";
}

// 回傳 [頻率 Hz, 響聲毫秒, 間隔毫秒]；音高固定，只有節奏不同
export function beepPattern(level) {
  const [on, off] = C.BEEP_RHYTHM[level];
  return [C.BEEP_FREQ_HZ, on, off];
}

// 把像素/秒速度向量轉成固定長度箭頭
export function motionArrowEndpoint(ox, oy, vx, vy, fallbackPoint, length = C.MOTION_ARROW_LENGTH) {
  let speed = Math.hypot(vx, vy);
  if (speed < 1) {
    const dx = fallbackPoint[0] - ox, dy = fallbackPoint[1] - oy;
    const fallbackSpeed = Math.hypot(dx, dy);
    if (fallbackSpeed < 1) return [Math.trunc(ox), Math.trunc(oy)];
    vx = dx; vy = dy; speed = fallbackSpeed;
  }
  return [Math.trunc(ox + vx / speed * length), Math.trunc(oy + vy / speed * length)];
}
