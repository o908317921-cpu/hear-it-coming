// 相機自體運動補償（對應 blindnav/motion.py）：估計「鏡頭轉動造成的整幅畫面位移」，從物體速度中扣掉。
//
// TTC 是相對使用者的碰撞時間，往前走不影響它；但鏡頭左右轉動會讓整個畫面一起橫移，
// 靜止的行人看起來就像在橫向移動。兩種估計方法：
//   - 陀螺儀：手機回傳角速度 ω，畫面位移速度 = f × ω（f 為焦距像素）。
//   - 背景位移比對：Python 版用 OpenCV 光流；瀏覽器沒有 OpenCV，改用「投影比對」——
//     把背景每一欄、每一列的平均亮度排成兩條曲線，找前後兩幀最吻合的位移。
//     往前走時畫面是對稱放大，曲線中心不會移動，所以只量到鏡頭轉動。
import { C } from "./config.js";
import { focalPx } from "./analysis.js";

// 灰階圖縮小（區域平均）：gray 為 Float32Array 或 Uint8Array，回傳 Float32Array
export function downsample(gray, w, h, outW, outH) {
  const out = new Float32Array(outW * outH);
  const kx = w / outW, ky = h / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor(oy * ky), y1 = Math.max(y0 + 1, Math.floor((oy + 1) * ky));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor(ox * kx), x1 = Math.max(x0 + 1, Math.floor((ox + 1) * kx));
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += gray[y * w + x];
      out[oy * outW + ox] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

// 背景（mask=1）每一欄或每一列的平均亮度；背景像素太少的位置記為 NaN
function profile(img, mask, w, h, alongX) {
  const n = alongX ? w : h, m = alongX ? h : w;
  const out = new Float32Array(n);
  for (let a = 0; a < n; a++) {
    let sum = 0, count = 0;
    for (let b = 0; b < m; b++) {
      const i = alongX ? b * w + a : a * w + b;
      if (mask[i]) { sum += img[i]; count++; }
    }
    out[a] = count >= m * 0.3 ? sum / count : NaN;
  }
  // 減掉平均值，亮度整體變化（例如自動曝光）不影響比對
  let mean = 0, valid = 0;
  for (const v of out) if (!Number.isNaN(v)) { mean += v; valid++; }
  mean /= Math.max(valid, 1);
  for (let i = 0; i < n; i++) out[i] -= mean;
  return out;
}

// 找 cur[x] ≈ prev[x - s] 的最佳 s（畫面內容往右／下移為正）；不可信時回傳 null
function bestShift(prev, cur, maxShift) {
  const n = cur.length, errors = [];
  for (let s = -maxShift; s <= maxShift; s++) {
    let sum = 0, count = 0;
    for (let x = Math.max(0, s); x < Math.min(n, n + s); x++) {
      const a = cur[x], b = prev[x - s];
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      sum += Math.abs(a - b);
      count++;
    }
    errors.push(count >= n * 0.5 ? sum / count : Infinity);
  }
  let k = 0;
  for (let i = 1; i < errors.length; i++) if (errors[i] < errors[k]) k = i;
  const finite = errors.filter(Number.isFinite);
  if (!Number.isFinite(errors[k]) || k === 0 || k === errors.length - 1) return null;
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  if (mean < 1e-6 || mean / Math.max(errors[k], 1e-6) < C.FLOW_MIN_CONTRAST) return null;
  // 拋物線內插，取得小數點以下的位移
  const [e0, e1, e2] = [errors[k - 1], errors[k], errors[k + 1]];
  const denom = e0 - 2 * e1 + e2;
  const frac = Number.isFinite(denom) && Math.abs(denom) > 1e-9 ? 0.5 * (e0 - e2) / denom : 0;
  return k - maxShift + Math.max(-0.5, Math.min(0.5, frac));
}

export class CameraMotionEstimator {
  constructor(mode = null) {
    this.mode = mode || C.CAMERA_MOTION_MODE;
    this.reset();
  }

  reset() {
    this.prevSmall = null;
    this.prevSize = null;
    this.prevTs = null;
    this.offsetX = 0;
    this.offsetY = 0;
    this.heading = [];    // [時間, 累積位移 x]，用來算近幾秒的平均朝向
  }

  flow(small, sw, sh, dt, excludeBoxes, k) {
    const mask = new Uint8Array(sw * sh).fill(1);
    for (const [x1, y1, x2, y2] of excludeBoxes) {
      const bx0 = Math.max(0, Math.floor(x1 / k)), bx1 = Math.min(sw, Math.ceil(x2 / k) + 1);
      const by0 = Math.max(0, Math.floor(y1 / k)), by1 = Math.min(sh, Math.ceil(y2 / k) + 1);
      for (let y = by0; y < by1; y++) mask.fill(0, y * sw + bx0, y * sw + bx1);
    }
    let background = 0;
    for (const v of mask) background += v;
    if (background < sw * sh * C.FLOW_MIN_BACKGROUND) return null;  // 物體擋住大半畫面
    const sx = bestShift(profile(this.prevSmall, mask, sw, sh, true), profile(small, mask, sw, sh, true),
      C.FLOW_MAX_SHIFT);
    if (sx == null) return null;
    const sy = bestShift(profile(this.prevSmall, mask, sw, sh, false), profile(small, mask, sw, sh, false),
      C.FLOW_MAX_SHIFT);
    return [sx * k / dt, (sy ?? 0) * k / dt];
  }

  // gray：灰階畫面；gyro：[偏航, 俯仰] 角速度（rad/s，正值代表背景往右／往下移）或 null
  update(gray, w, h, ts, { excludeBoxes = [], gyro = null, pathRatio = C.COLLISION_ZONE_RATIO } = {}) {
    const k = w / C.FLOW_WIDTH;
    const sw = C.FLOW_WIDTH, sh = Math.max(1, Math.round(h / k));
    const small = downsample(gray, w, h, sw, sh);
    const dt = this.prevTs == null ? null : ts - this.prevTs;

    let gyroV = null;
    if (gyro && (this.mode === "auto" || this.mode === "gyro")) {
      const f = focalPx(w, h) * C.GYRO_GAIN;
      gyroV = [f * gyro[0], f * gyro[1]];
    }
    let flowV = null;
    if ((this.mode === "auto" || this.mode === "flow") && this.prevSmall && dt > 0 && dt <= 1
        && this.prevSize === `${sw}x${sh}`) {
      flowV = this.flow(small, sw, sh, dt, excludeBoxes, k);
    }

    let vx = 0, vy = 0, source = "none";
    if (gyroV && flowV && Math.abs(gyroV[0] - flowV[0]) <= C.MOTION_AGREE_PX_S
        && Math.abs(gyroV[1] - flowV[1]) <= C.MOTION_AGREE_PX_S) {
      [vx, vy, source] = [(gyroV[0] + flowV[0]) / 2, (gyroV[1] + flowV[1]) / 2, "gyro+flow"];
    } else if (gyroV) {
      [vx, vy, source] = [gyroV[0], gyroV[1], "gyro"];
    } else if (flowV) {
      [vx, vy, source] = [flowV[0], flowV[1], "flow"];
    }
    if (Math.abs(vx) < C.FLOW_DEADBAND_PX_S) vx = 0;
    if (Math.abs(vy) < C.FLOW_DEADBAND_PX_S) vy = 0;

    if (dt > 0 && dt <= 1) {
      this.offsetX += vx * dt;
      this.offsetY += vy * dt;
    }
    this.prevSmall = small;
    this.prevSize = `${sw}x${sh}`;
    this.prevTs = ts;

    // 行走路徑自適應：中心 = 畫面中央 +（目前累積位移 − 近幾秒平均）
    let center = w / 2;
    if (C.PATH_ADAPTIVE) {
      this.heading.push([ts, this.offsetX]);
      while (this.heading.length && ts - this.heading[0][0] > C.PATH_ADAPT_SEC) this.heading.shift();
      const meanOffset = this.heading.reduce((s, [, x]) => s + x, 0) / this.heading.length;
      const half = w * pathRatio / 2;
      center = Math.min(w - half, Math.max(half, w / 2 + this.offsetX - meanOffset));
    }
    return { vx, vy, offsetX: this.offsetX, offsetY: this.offsetY, source, pathCenterX: center };
  }
}
