// 科展版新增：地面高低差、紅綠燈、斑馬線。
// 三者都只「說明前方有什麼」，不下指令：系統分不出行人號誌和車輛號誌，也不知道使用者要不要過馬路。
// 門檻用 Wikimedia Commons 的真實街景照片調過（tests/field.html），但照片不是胸前視角，仍要實地測試。
import { C } from "./config.js";
import { median } from "./analysis.js";

// ============================================================
// 地面高低差（深度圖）
// ============================================================
// 看行走路徑中間那一條，每一列逆深度的中位數，由上往下應該平順地變大（越下面越近）。
// 真實照片實測發現 Depth Anything 的輸出在平地上也是彎的：「擬合直線看偏離多少」在 8 張平地照片上全部誤報。
// 改看局部變化才分得開：
//   跳變：往下幾列之內突然變近很多（比平常的坡度陡 STEP_JUMP_RATIO 倍以上）＝邊緣（落差、台階的邊）
//   平台：一段距離內逆深度幾乎不變（坡度不到平常的 STEP_FLAT_RATIO）＝立起來的面（台階、路緣的側面）
// 往上還是往下在實測裡分不準（往上的樓梯常被判成跳變），所以只說「地面有高低差」。
// 不誤報比抓到更重要（第二、三輪照片測試）：
//   · 路徑切成 STEP_BANDS 條，每一條都要看到、而且在差不多的高度：台階橫跨整條路，電線桿、柱子、路邊植物只佔一部分
//     （切兩半時，盲測照片裡路邊植物佔一半、柱子佔另一半就誤報了）
//   · 要真的看得到往前延伸的地面（坡度夠明顯）：仰拍時中間是天空與燈桿，不是地面
//   · 鏡頭明顯朝天或朝地時由 detector 直接不判斷（手機的傾斜角度）
// 已知還會誤報的：一整排擋車的石柱、橫過路面的深色影子邊線（深度模型把它們算成高低差）
// disparity：{data, width, height}；回傳 null 或 {kind: "level", row, box, centerX, reason}
// debug：傳入物件時填入 {bands：每一條的結果, groundSeen：每一條都看得到地面, anyEdge：有任何一條看到邊緣}
export function findGroundSteps(disparity, pathCenterX, exclude = null, pathRatio = C.COLLISION_ZONE_RATIO, debug = null) {
  const { width: w, height: h } = disparity;
  const half = w * pathRatio / 2;
  const x0 = Math.floor(Math.max(0, pathCenterX - half)), x1 = Math.floor(Math.min(w, pathCenterX + half));
  const n = C.STEP_BANDS;
  if (x1 - x0 < 3 * n) return null;
  const bands = [];
  for (let i = 0; i < n; i++) {
    bands.push(stepInBand(disparity, Math.floor(x0 + (x1 - x0) * i / n), Math.floor(x0 + (x1 - x0) * (i + 1) / n), exclude));
  }
  const rows = bands.map(b => b?.row).filter(r => r != null);
  if (debug) Object.assign(debug, { bands, groundSeen: bands.every(b => b?.ground), anyEdge: rows.length > 0 });
  if (rows.length < n || Math.max(...rows) - Math.min(...rows) > h * C.STEP_SIDE_AGREE_RATIO) return null;
  const row = Math.round(rows.reduce((a, b) => a + b, 0) / n), k = Math.max(2, Math.round(h * C.STEP_WINDOW_RATIO));
  return { kind: "level", row, reason: bands.map(b => b.reason).join("；"), centerX: (x0 + x1) / 2,
           box: [x0, Math.max(0, row - 2 * k), x1, Math.min(h, row + 2 * k)] };
}

// 一條直條（x0～x1 欄）裡有沒有跳變或平台；回傳 null（看不到地面）、{ground: true}（平地）或 {ground: true, row, reason}
function stepInBand(disparity, x0, x1, exclude) {
  const { data, width: w, height: h } = disparity;
  const y0 = Math.floor(h * C.STEP_SEARCH_TOP_RATIO), y1 = Math.floor(h * C.STEP_SEARCH_BOTTOM_RATIO);
  // 幾列平均一次，去掉單列雜訊；窗內有被擋住的列就不算
  const k = Math.max(2, Math.round(h * C.STEP_WINDOW_RATIO));
  const raw = new Float64Array(h).fill(NaN);
  for (let y = Math.max(0, y0 - k); y < h; y++) {
    const row = [];
    for (let x = x0; x < x1; x++) if (!exclude || !exclude[y * w + x]) row.push(data[y * w + x]);
    if (row.length >= (x1 - x0) * 0.5) raw[y] = median(row);
  }
  const p = new Float64Array(h).fill(NaN);
  for (let y = y0; y < h; y++) {
    let sum = 0, n = 0;
    for (let j = y - (k >> 1); j < y - (k >> 1) + k; j++) if (j >= 0 && j < h && !Number.isNaN(raw[j])) { sum += raw[j]; n++; }
    if (n === k) p[y] = sum / n;
  }
  const bottom = p[y1 - 1];
  if (!(bottom > 0)) return null;
  const slope = new Float64Array(h).fill(NaN);            // 往下 k 列，逆深度變大多少
  for (let y = y0; y + k < y1; y++) slope[y] = p[y + k] - p[y];
  // 平常的坡度：近處地面（逆深度超過最下面的一半）的中位數
  const near = [];
  for (let y = y0; y + k < y1; y++) if (p[y] > 0.5 * bottom && !Number.isNaN(slope[y])) near.push(slope[y]);
  const ref = near.length ? median(near) : NaN;
  if (!(ref > 0)) return null;                             // 越下面沒有越近：不是在看地面
  // 坡度換算成「整個畫面高度內逆深度變化幾倍」：平地約 1～3，仰拍天空、燈桿時只有 0.1～0.4
  if (ref / k * h / bottom < C.STEP_MIN_GROUND_GRADIENT) return null;
  const found = (row, reason) => ({ ground: true, row, reason });
  let jumpY = -1, jump = 0;
  for (let y = y0; y + k < y1; y++) {
    if (p[y] > C.STEP_NEAR_FRAC * bottom && slope[y] > jump) { jump = slope[y]; jumpY = y; }
  }
  if (jumpY >= 0 && jump > C.STEP_JUMP_RATIO * ref) return found(jumpY + (k >> 1), `跳變 ${(jump / ref).toFixed(1)} 倍`);
  const minRun = Math.max(2, Math.round(h * C.STEP_FLAT_RUN_RATIO));
  let run = 0;
  for (let y = y1 - k - 1; y >= y0; y--) {
    if (p[y] > C.STEP_FLAT_NEAR_FRAC * bottom && slope[y] < C.STEP_FLAT_RATIO * ref) {
      if (++run >= minRun) return found(y + run - 1, `平台 ${run} 列`);   // 平台最下面一列：立面和地面的交界
    } else run = 0;
  }
  return { ground: true };
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
      // 台灣的綠燈偏藍綠，色相範圍放寬到青色。實測：紅燈集中在 340°～10°，黃燈（偏橘）散在 10°～40°；
      // 紅色範圍原本到 20°，盲測照片把黃燈說成紅燈。10°～15° 兩邊都可能，不算
      if (hue < 10 || hue >= 340) counts.red++;
      else if (hue >= 15 && hue < 70) counts.yellow++;
      else if (hue >= 90 && hue < 200) counts.green++;
    }
  }
  if (!total) return null;
  const ranked = Object.entries(counts).sort((p, q) => q[1] - p[1]);
  const [best, n] = ranked[0];
  if (n / total < C.SIGNAL_MIN_LIT_SHARE || n < ranked[1][1] * 2) return null;
  return best;
}

// 好幾個燈裡要說哪一個：判讀得出顏色的燈都同一個顏色才說；一紅一綠（不同方向的號誌同時入鏡）就不說，
// 說錯燈號比不說更危險。lights：[{box, color}]；回傳顏色或 null
export function pickLight(lights) {
  const colors = new Set(lights.map(l => l.color).filter(Boolean));
  return colors.size === 1 ? [...colors][0] : null;
}

// ============================================================
// 斑馬線：路徑前方的地面上，好幾條又寬又扁、上下疊著的白色色塊
// ============================================================
// 真實照片實測：「每一欄亮暗交錯」連樓梯、磚牆、樹影都算；「整列都亮」又抓不到斜的斑馬線。
// 改成找白漆：夠亮、不鮮豔，連成一塊後要夠寬、夠扁，而且好幾塊上下疊著。
// rgba：畫面像素；回傳符合透視規律的白色橫條數（≥ CROSSWALK_MIN_STRIPES 才算斑馬線）
export function crosswalkStripes(rgba, w, h, pathCenterX) {
  const half = w * C.CROSSWALK_WIDTH_RATIO / 2;
  const x0 = Math.floor(Math.max(0, pathCenterX - half)), x1 = Math.floor(Math.min(w, pathCenterX + half));
  const y0 = Math.floor(h * C.CROSSWALK_TOP_RATIO);
  const bw = x1 - x0, bh = h - y0;
  if (bw < 10 || bh < 10) return 0;
  const val = new Uint8Array(bw * bh), sat = new Float32Array(bw * bh), hist = new Uint32Array(256);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((y0 + y) * w + x0 + x) * 4;
      const mx = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]), mn = Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
      val[y * bw + x] = mx; sat[y * bw + x] = mx ? (mx - mn) / mx : 0; hist[mx]++;
    }
  }
  const pct = q => { let acc = 0; for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= q * bw * bh) return v; return 255; };
  const lo = pct(0.2), hi = pct(0.9);
  if (hi - lo < C.CROSSWALK_MIN_CONTRAST) return 0;
  const cut = lo + 0.6 * (hi - lo);
  let mask = new Uint8Array(bw * bh);
  for (let i = 0; i < mask.length; i++) mask[i] = val[i] > cut && sat[i] < C.CROSSWALK_MAX_SAT ? 1 : 0;
  // 先侵蝕再膨脹（3×3）：去掉零星的亮點與細線
  const morph = (src, erode) => {
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      let all = 1, any = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        const v = yy >= 0 && yy < bh && xx >= 0 && xx < bw ? src[yy * bw + xx] : 0;
        all &= v; any |= v;
      }
      dst[y * bw + x] = erode ? all : any;
    }
    return dst;
  };
  mask = morph(morph(mask, true), false);
  // 連通區域，記下每塊的外框
  const seen = new Uint8Array(mask.length), stack = [], stripes = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let minX = bw, maxX = -1, minY = bh, maxY = -1;
    seen[start] = 1; stack.push(start);
    while (stack.length) {
      const i = stack.pop(), x = i % bw, y = (i - x) / bw;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const j of [x > 0 ? i - 1 : -1, x < bw - 1 ? i + 1 : -1, y > 0 ? i - bw : -1, y < bh - 1 ? i + bw : -1]) {
        if (j >= 0 && mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    const ww = maxX - minX + 1, hh = maxY - minY + 1;
    if (ww >= C.CROSSWALK_MIN_WIDTH_RATIO * bw && hh <= C.CROSSWALK_MAX_ASPECT * ww && hh >= 2) stripes.push([(minY + maxY) / 2, hh, ww]);
  }
  // 上下疊著：中心至少差上一條的高度（同一條被切成兩塊不重複算）
  stripes.sort((p, q) => p[0] - q[0]);
  const layers = [];
  for (const st of stripes) if (!layers.length || st[0] - layers[layers.length - 1][0] > Math.max(3, layers[layers.length - 1][1] * 0.8)) layers.push(st);
  // 透視規律（盲測照片找到的）：真的斑馬線越近越粗、寬度差不多；樓梯、路面邊線、人行道邊緣的白色塊大小亂跳。
  // 回傳最長的一串「由上往下每一條都比上一條粗、寬度差不到 2 倍」的白條數
  let best = layers.length ? 1 : 0, run = 1;
  for (let i = 1; i < layers.length; i++) {
    const [, h0, w0] = layers[i - 1], [, h1, w1] = layers[i];
    const ok = h1 >= h0 * C.CROSSWALK_GROW_MIN && Math.max(w0, w1) <= Math.min(w0, w1) * 2;
    run = ok ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
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

  // signals：[{box, score}]（traffic light）；crosswalk：要不要判斷斑馬線
  // （前方有地面高低差時不判斷：實測裡樓梯的踏面看起來就像白色橫條）。回傳要念的句子
  update({ signals = [], rgba = null, crosswalk = false, w, h, pathCenterX, now }) {
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
    const L = this.light;
    L.votes.push(pickLight(this.lights));
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
    if (rgba) {
      const X = this.cross;
      X.votes.push(crosswalk && crosswalkStripes(rgba, w, h, pathCenterX) >= C.CROSSWALK_MIN_STRIPES);
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
