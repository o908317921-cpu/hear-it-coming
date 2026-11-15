// 科展版新增：地面高低差、紅綠燈、斑馬線。
// 三者都只「說明前方有什麼」，不下指令：系統分不出行人號誌和車輛號誌，也不知道使用者要不要過馬路。
import { C } from "./config.js";
import { median } from "./analysis.js";

// ============================================================
// 地面高低差（深度圖）
// ============================================================
// 平坦地面上，深度圖的逆深度沿著畫面往上是一條直線（針孔相機：逆深度 ∝ 落地點在地平線下幾個像素）。
// Depth Anything 的輸出跟真正的逆深度只差一個比例和位移（仿射），直線仍是直線。
// 所以用最下面一段地面擬合一條直線，往上看實際值偏離多少：
//   往下的落差（路緣往下、台階往下、坑）：邊緣後面是更低的地面，看起來比直線遠 → 比值 < 1，而且之後一直偏低
//   往上的台階（路緣往上、樓梯往上）：先是一段垂直面（逆深度不變），上面是較高的地面 → 比值 > 1 但不會一路變大
//   牆、柱子：比值一路變大，交給原本的「障礙物」偵測，這裡不報
// 比值 =（實際 − 地平線處的直線值）÷（直線值 − 地平線處的直線值），抵掉仿射的位移，平地上恆為 1。
// disparity：{data, width, height}；回傳 null 或 {kind: "drop"|"step", row, box, centerX, ratio}
export function findGroundSteps(disparity, pathCenterX, exclude = null, pathRatio = C.COLLISION_ZONE_RATIO) {
  const { data, width: w, height: h } = disparity;
  const half = w * pathRatio / 2;
  const x0 = Math.floor(Math.max(0, pathCenterX - half)), x1 = Math.floor(Math.min(w, pathCenterX + half));
  if (x1 - x0 < 3) return null;
  const horizon = h * C.STEP_HORIZON_RATIO;
  const profile = new Float64Array(h).fill(NaN);
  for (let y = Math.ceil(horizon); y < h; y++) {
    const row = [];
    for (let x = x0; x < x1; x++) if (!exclude || !exclude[y * w + x]) row.push(data[y * w + x]);
    if (row.length >= (x1 - x0) * 0.5) profile[y] = median(row);
  }
  // 參考地面：最下面一段，最小平方法擬合直線 p = a·y + b
  const refTop = Math.floor(h * (1 - C.STEP_REF_RATIO));
  let n = 0, sy = 0, sp = 0, syy = 0, syp = 0;
  for (let y = refTop; y < h; y++) {
    if (Number.isNaN(profile[y])) continue;
    n++; sy += y; sp += profile[y]; syy += y * y; syp += y * profile[y];
  }
  if (n < (h - refTop) * 0.6) return null;            // 參考地面大多被擋住
  const a = (n * syp - sy * sp) / (n * syy - sy * sy), b = (sp - a * sy) / n;
  if (!(a > 0)) return null;                           // 越下面越近才是地面；不是的話（鏡頭朝天、對著牆）不判斷
  let sse = 0, sst = 0;
  for (let y = refTop; y < h; y++) {
    if (Number.isNaN(profile[y])) continue;
    sse += (profile[y] - (a * y + b)) ** 2; sst += (profile[y] - sp / n) ** 2;
  }
  if (sst <= 0 || 1 - sse / sst < C.STEP_REF_MIN_R2) return null;   // 參考段本身就不平，沒有基準
  const base = a * horizon + b;
  const ratioAt = y => (profile[y] - base) / (a * y + b - base);

  // 從參考段往上找：連續 minRows 列都偏離超過門檻，第一列就是邊緣
  const minRows = Math.max(2, Math.round(h * C.STEP_MIN_ROWS_RATIO));
  const searchTop = Math.ceil(h * C.STEP_SEARCH_TOP_RATIO);
  let run = [], runKind = null;
  for (let y = refTop - 1; y >= searchTop; y--) {
    if (Number.isNaN(profile[y])) { run = []; runKind = null; continue; }
    const r = ratioAt(y);
    const kind = r < 1 - C.STEP_DROP_RATIO ? "drop" : r > 1 + C.STEP_RISE_RATIO ? "step" : null;
    if (!kind || kind !== runKind) { run = kind ? [[y, r]] : []; runKind = kind; continue; }
    run.push([y, r]);
    if (run.length < minRows) continue;
    // 再往上多看幾列：落差後面要一直偏低；台階上面要停在某個比值（牆會一路變大）
    const above = [];
    for (let k = y - 1; k >= Math.max(searchTop, y - minRows * 2); k--) if (!Number.isNaN(profile[k])) above.push(ratioAt(k));
    const all = run.map(([, v]) => v).concat(above);
    const mid = median(all);
    if (kind === "drop" && mid >= 1 - C.STEP_DROP_RATIO) { run = []; runKind = null; continue; }
    if (kind === "step" && (mid > C.STEP_RISE_MAX_RATIO || Math.max(...all) > C.STEP_RISE_MAX_RATIO * 1.15)) return null;
    const edge = run[0][0];
    return { kind, row: edge, ratio: mid, centerX: (x0 + x1) / 2,
             box: [x0, Math.max(0, edge - minRows * 2), x1, Math.min(h, edge + minRows)] };
  }
  return null;
}

// ============================================================
// 紅綠燈：YOLO 的 traffic light 框裡，亮著的是紅、黃還是綠
// ============================================================
function hsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d) {
    if (max === r) hue = 60 * (((g - b) / d) % 6);
    else if (max === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
  }
  return [(hue + 360) % 360, max ? d / max : 0, max / 255];
}

// rgba：畫面像素（Uint8ClampedArray）；回傳 "red" / "yellow" / "green" / null（分不出來）
export function trafficLightColor(rgba, frameWidth, box) {
  const [bx1, by1, bx2, by2] = box.map(Math.round);
  const counts = { red: 0, yellow: 0, green: 0 };
  let total = 0;
  for (let y = Math.max(0, by1); y < by2; y++) {
    for (let x = Math.max(0, bx1); x < Math.min(frameWidth, bx2); x++) {
      const i = (y * frameWidth + x) * 4;
      if (i + 2 >= rgba.length) break;
      total++;
      const [hue, s, v] = hsv(rgba[i], rgba[i + 1], rgba[i + 2]);
      if (v < C.SIGNAL_MIN_VALUE || s < C.SIGNAL_MIN_SAT) continue;   // 燈殼、天空、沒亮的燈
      // 台灣的綠燈偏藍綠，色相範圍放寬到青色
      if (hue < 20 || hue >= 330) counts.red++;
      else if (hue >= 30 && hue < 70) counts.yellow++;
      else if (hue >= 90 && hue < 200) counts.green++;
    }
  }
  if (!total) return null;
  const ranked = Object.entries(counts).sort((p, q) => q[1] - p[1]);
  const [best, n] = ranked[0];
  if (n / total < C.SIGNAL_MIN_LIT_SHARE || n < ranked[1][1] * 2) return null;
  return best;
}

// ============================================================
// 斑馬線：路徑前方的地面上，亮暗交錯的橫條
// ============================================================
// gray：灰階畫面；回傳亮條數（≥ CROSSWALK_MIN_STRIPES 才算斑馬線）
export function crosswalkStripes(gray, w, h, pathCenterX) {
  const half = w * C.CROSSWALK_WIDTH_RATIO / 2;
  const x0 = Math.floor(Math.max(0, pathCenterX - half)), x1 = Math.floor(Math.min(w, pathCenterX + half));
  const y0 = Math.floor(h * C.CROSSWALK_TOP_RATIO);
  const rows = h - y0, cols = x1 - x0;
  if (rows < 10 || cols < 10) return 0;
  const mean = new Float64Array(rows), bright = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    let s = 0;
    for (let x = x0; x < x1; x++) s += gray[(y0 + r) * w + x];
    mean[r] = s / cols;
  }
  const sorted = [...mean].sort((p, q) => p - q);
  const lo = sorted[Math.floor(rows * 0.15)], hi = sorted[Math.floor(rows * 0.85)];
  if (hi - lo < C.CROSSWALK_MIN_CONTRAST) return 0;
  const mid = (lo + hi) / 2;
  // 亮條要橫貫整段路徑（白漆），不是一小塊反光：這一列大部分的點都要比中間值亮
  for (let r = 0; r < rows; r++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (gray[(y0 + r) * w + x] > mid) n++;
    bright[r] = n / cols;
  }
  const minBand = Math.max(2, Math.round(h * 0.01));
  let stripes = 0, darks = 0, state = null, len = 0;
  const close = () => {
    if (len >= minBand) { if (state === "bright") stripes++; else if (state === "dark") darks++; }
  };
  for (let r = 0; r < rows; r++) {
    const s = bright[r] >= C.CROSSWALK_ROW_FILL ? "bright" : bright[r] <= 1 - C.CROSSWALK_ROW_FILL ? "dark" : null;
    if (s === state) { len++; continue; }
    close();
    state = s; len = 1;
  }
  close();
  // 亮條之間要有暗條隔開；一整片亮（白牆、陽光）不算
  return Math.min(stripes, darks + 1);
}

// ============================================================
// 把每一幀的觀察變成語音：連續看到才說，改變時才說，說過一陣子內不重複
// ============================================================
export class SceneCues {
  constructor() {
    this.light = { color: null, votes: [], said: null, saidAt: -Infinity, lastSeen: -Infinity };
    this.cross = { votes: [], on: false, saidAt: -Infinity };
    this.lights = [];             // 這一幀判讀過的燈（畫面用）
  }

  // signals：[{box, score}]（traffic light）；回傳要念的句子
  update({ signals = [], rgba = null, gray = null, w, h, pathCenterX, now }) {
    const out = [];
    // ---- 紅綠燈：只看路徑前方附近、夠大的燈；同時看到好幾個時取最大的
    this.lights = [];
    if (rgba) {
      for (const s of signals) {
        const cx = (s.box[0] + s.box[2]) / 2;
        if (Math.abs(cx - pathCenterX) > w * C.SIGNAL_MAX_OFFSET_RATIO) continue;
        if (s.box[3] - s.box[1] < h * C.SIGNAL_MIN_HEIGHT_RATIO) continue;
        this.lights.push({ box: s.box, color: trafficLightColor(rgba, w, s.box) });
      }
    }
    const main = this.lights.filter(l => l.color)
      .sort((p, q) => (q.box[3] - q.box[1]) - (p.box[3] - p.box[1]))[0];
    const L = this.light;
    L.votes.push(main ? main.color : null);
    if (L.votes.length > C.SIGNAL_CONFIRM_WINDOW) L.votes.shift();
    const tally = {};
    for (const v of L.votes) if (v) tally[v] = (tally[v] || 0) + 1;
    const [color, count] = Object.entries(tally).sort((p, q) => q[1] - p[1])[0] || [null, 0];
    if (color && count >= C.SIGNAL_CONFIRM_HITS) {
      L.lastSeen = now;
      // 燈號變了（紅轉綠）馬上說；同一個燈號隔一陣子才再提醒一次
      if (color !== L.said || now - L.saidAt >= C.SIGNAL_REPEAT_SEC) {
        out.push({ kind: "signal", text: C.SIGNAL_TEXT[color] });
        L.said = color; L.saidAt = now;
      }
    } else if (now - L.lastSeen > C.SIGNAL_FORGET_SEC) {
      L.said = null;              // 很久沒看到燈：下一個路口第一次看到時要說
    }

    // ---- 斑馬線
    if (gray) {
      const X = this.cross;
      X.votes.push(crosswalkStripes(gray, w, h, pathCenterX) >= C.CROSSWALK_MIN_STRIPES);
      if (X.votes.length > C.CROSSWALK_CONFIRM_WINDOW) X.votes.shift();
      const hits = X.votes.filter(Boolean).length;
      if (!X.on && hits >= C.CROSSWALK_CONFIRM_HITS) {
        X.on = true;
        if (now - X.saidAt >= C.CROSSWALK_REPEAT_SEC) { out.push({ kind: "crosswalk", text: C.CROSSWALK_TEXT }); X.saidAt = now; }
      } else if (X.on && hits === 0) {
        X.on = false;
      }
    }
    return out;
  }
}
