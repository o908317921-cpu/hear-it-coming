// 模擬實驗：沒有實拍影片時，用「已知真實碰撞時間」的合成場景，跑真正的 HazardDetector，
// 比較各種辨識流程組合的「及時警告率、誤報率、最差提前時間」。
// 畫面是針孔相機投影出來的框（加上框抖動、漏抓、偶爾框錯、胸前手機走路的上下晃與左右擺＋對應的陀螺儀讀數）。
// shortcut: 框的雜訊模型是猜的（σ = 1.5 px + 2% 框高），實測 σ_h 之後要把 NOISE 換成量到的值
import { C } from "../js/config.js";
import { focalPx } from "../js/analysis.js";
import { alertLevelOf } from "../js/alerts.js";
import { HazardDetector } from "../js/detector.js";

const W = 640, H = 480, F = focalPx(W, H);
export const NOISE = { edgePx: 1.5, edgeRatio: 0.02, dropout: 0.05, glitch: 0.02, pitchDeg: 2.5, yawDeg: 3, stepHz: 1.8 };

// 物體：類別、真實高、寬（公尺）。小孩用 person 類別但只有 1.1 m 高（偵測器以為是 1.7 m）
const KINDS = {
  walker: ["person", 1.7, 0.5], child: ["person", 1.1, 0.35],
  bike: ["bicycle", 1.0, 0.6], scooter: ["motorcycle", 1.1, 0.7],
};
// x0/z0：起點（相對使用者，公尺）；vx/vz：物體自己的速度；u：使用者往前走的速度
export const SCENARIOS = [
  { name: "正面走來（我在走）", kind: "walker", x0: 0, z0: 14, vx: 0, vz: -1.3, u: 1.0 },
  { name: "正面走來（我站著）", kind: "walker", x0: 0.1, z0: 10, vx: 0, vz: -1.4, u: 0 },
  { name: "斜向切入、會撞上", kind: "walker", x0: -4, z0: 10, vx: 4 / 6, vz: -10 / 6 + 1.0, u: 1.0 },
  { name: "腳踏車正面騎來", kind: "bike", x0: 0.2, z0: 25, vx: 0, vz: -4, u: 1.0 },
  { name: "遠處高速機車", kind: "scooter", x0: 0, z0: 35, vx: 0, vz: -6, u: 0 },
  { name: "小孩正面走來", kind: "child", x0: 0, z0: 10, vx: 0, vz: -1.0, u: 1.0 },
  { name: "路上站著的人", kind: "walker", x0: 0.1, z0: 9, vx: 0, vz: 0, u: 1.2 },
  { name: "錯身而過 0.9 m", kind: "walker", x0: 0.9, z0: 14, vx: 0, vz: -1.3, u: 1.0 },
  { name: "錯身而過 1.5 m", kind: "walker", x0: 1.5, z0: 14, vx: 0, vz: -1.3, u: 1.0 },
  { name: "遠處橫越", kind: "walker", x0: -4, z0: 8, vx: 1.4, vz: 0, u: 0 },
  { name: "前方 2 m 先橫越過去", kind: "walker", x0: -3, z0: 4.5, vx: 1.4, vz: 0, u: 1.0 },
  { name: "往前走遠", kind: "walker", x0: 0, z0: 4, vx: 0, vz: 1.5, u: 1.0 },
  { name: "路邊站著的人 1.3 m", kind: "walker", x0: 1.3, z0: 10, vx: 0, vz: 0, u: 1.2 },
];

// 驗證用（議會二）：調整時沒看過的場景，避免只對上面 13 個過度擬合
export const HELD_OUT = [
  // 手機水平半視角約 25°（焦距 700 px、寬 640 px），30° 以外的斜向來人鏡頭根本看不到，是物理極限，所以用 20°
  { name: "右邊 20° 斜向切入、會撞上", kind: "walker", x0: 2.9, z0: 8, vx: -2.9 / 5, vz: -8 / 5 + 1.0, u: 1.0 },
  { name: "錯身而過 0.5 m（該喊）", kind: "walker", x0: 0.5, z0: 14, vx: 0, vz: -1.3, u: 1.0 },
  { name: "錯身而過 1.2 m", kind: "walker", x0: 1.2, z0: 14, vx: 0, vz: -1.3, u: 1.0 },
  { name: "小孩錯身而過 0.9 m", kind: "child", x0: 0.9, z0: 10, vx: 0, vz: -1.0, u: 1.0 },
  { name: "5 m 處突然出現、正面走來", kind: "walker", x0: 0.1, z0: 5, vx: 0, vz: -1.3, u: 1.0 },
];

// 會不會撞上、何時撞上：相對位置 Z ≤ 0.6 m 時橫向 |X| ≤ 0.6 m（兩人各半個身寬再加一點）
export function truth(s) {
  for (let t = 0; t < 20; t += 0.01) {
    const x = s.x0 + s.vx * t, z = s.z0 + (s.vz - s.u) * t;
    if (z <= 0.6) return Math.abs(x) <= 0.6 ? t : null;
  }
  return null;
}

function rng(seed) {   // mulberry32
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const gauss = r => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

// 胸前手機：走路時上下晃（步頻）與左右擺（半步頻）；站著只有很小的手抖。回傳畫面平移量（像素）
function cameraShift(t, walking) {
  const a = walking ? 1 : 0.15, rad = Math.PI / 180, w = 2 * Math.PI * NOISE.stepHz;
  return [F * NOISE.yawDeg * rad * a * Math.sin(w / 2 * t), F * NOISE.pitchDeg * rad * a * Math.sin(w * t)];
}

// 第 t 秒畫面上的框（沒看到回傳 null）
function boxAt(s, t, r) {
  const [label, hm, wm] = KINDS[s.kind], camH = C.CAMERA_HEIGHT_CM / 100;
  const x = s.x0 + s.vx * t, z = s.z0 + (s.vz - s.u) * t;
  if (z < 0.3) return null;
  const [dx, dy] = cameraShift(t, s.u > 0);
  const cx = W / 2 + F * x / z + dx, half = F * wm / 2 / z;
  let box = [cx - half, H / 2 - F * (hm - camH) / z + dy, cx + half, H / 2 + F * camH / z + dy];
  const sigma = NOISE.edgePx + NOISE.edgeRatio * (box[3] - box[1]);
  box = box.map(v => v + sigma * gauss(r));
  if (r() < NOISE.glitch) box[3] += 0.3 * (box[3] - box[1]);   // 偶爾框錯（框到兩個人、多框到影子）
  box = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(W - 1, box[2]), Math.min(H - 1, box[3])].map(Math.round);
  if (box[2] - box[0] < 4 || box[3] - box[1] < 8) return null;
  return { box, score: 0.9, rawLabel: label };
}

class SimYolo {
  constructor() { this.next = []; this.backend = "sim"; }
  async detect() { return this.next; }
  buildMask(det) {
    const [x1, y1, x2, y2] = det.box;
    return { data: new Uint8Array(1).fill(1), gw: 1, gh: 1, x: x1, y: y1, cell: 1, area: (x2 - x1) * (y2 - y1) * 0.6 };
  }
}
const frame = (() => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const v = (i * 7919) % 255; data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255; }
  return { canvas: null, imageData: { data }, width: W, height: H };
})();

const RANK = { SAFE: 0, NOTICE: 1, DANGER: 2, STOP: 3 };
// 跑一個場景一次：回傳第一次「注意／危險／停」的時間與 TTC 誤差
export async function runOnce(s, fps, seed) {
  const r = rng(seed), yolo = new SimYolo(), det = new HazardDetector(yolo, null);
  const tc = truth(s), end = (tc ?? 12) + 0.3, first = { NOTICE: null, DANGER: null, STOP: null }, ttcErr = [];
  const t0 = r() / fps;   // 起始相位錯開
  for (let k = 0; ; k++) {
    const t = t0 + k / fps;
    if (t > end) break;
    const b = r() < NOISE.dropout ? null : boxAt(s, t, r);
    yolo.next = b ? [b] : [];
    // 陀螺儀：跟 App 一樣是「這一幀期間的平均角速度」（app.js 把 devicemotion 讀數累加後取平均），
    // 所以等於兩幀之間畫面平移量 ÷ 時間 ÷ 焦距（rad/s），加一點雜訊
    const [ax, ay] = cameraShift(t - 1 / fps, s.u > 0), [bx, by] = cameraShift(t, s.u > 0);
    const gyro = [(bx - ax) * fps / F + 0.01 * gauss(r), (by - ay) * fps / F + 0.01 * gauss(r)];
    const tracks = await det.process(frame, t, gyro);
    let level = 0;
    for (const tr of tracks) {
      level = Math.max(level, RANK[alertLevelOf(tr)]);
      if (tc != null && tr.inCollisionZone && Number.isFinite(tr.ttcSec) && tc - t >= 1 && tc - t <= 4) ttcErr.push(Math.abs(tr.ttcSec - (tc - t)));
    }
    for (const [name, rank] of Object.entries(RANK)) if (rank && level >= rank && first[name] == null) first[name] = t;
  }
  return { tc, first, ttcErr };
}

const quantile = (xs, q) => { if (!xs.length) return NaN; const v = [...xs].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(q * v.length))]; };

// 一組設定跑完所有場景 × 幀率 × 亂數種子，回傳彙總指標
export async function evaluate(settings, { fpsList = [4, 10], seeds = [1, 2, 3], scenarios = SCENARIOS } = {}) {
  const saved = Object.fromEntries(Object.keys(settings).map(k => [k, C[k]]));
  Object.assign(C, settings);
  const leads = [], err = [], perScenario = {};
  let hits = 0, timely = 0, misses = 0, safe = 0, falseAlarms = 0, noticeFa = 0;
  try {
    for (const s of scenarios) for (const fps of fpsList) for (const seed of seeds) {
      const { tc, first, ttcErr } = await runOnce(s, fps, seed * 1000 + fps);
      err.push(...ttcErr);
      const row = perScenario[s.name] ??= { runs: 0, ok: 0 };
      row.runs++;
      if (tc != null) {
        hits++;
        const warnAt = first.DANGER;   // 危險或停
        const lead = warnAt == null ? 0 : Math.max(0, tc - warnAt);
        leads.push(lead);
        if (warnAt == null) misses++;
        if (lead >= C.TTC_URGENT_SEC - 0.3) { timely++; row.ok++; }   // 至少約 1.5 秒前喊危險
      } else {
        safe++;
        if (first.DANGER != null) falseAlarms++; else row.ok++;
        if (first.NOTICE != null) noticeFa++;
      }
    }
  } finally { Object.assign(C, saved); }
  return {
    timelyRate: timely / hits, missRate: misses / hits, falseAlarmRate: falseAlarms / safe, noticeRate: noticeFa / safe,
    worstLead: Math.min(...leads), p5Lead: quantile(leads, 0.05), medianLead: quantile(leads, 0.5),
    ttcMedianErr: quantile(err, 0.5), perScenario,
  };
}

// 要比較的四個因子（每個都是設定開關，預設值＝現在的 App）
export const FACTORS = [
  ["TTC 估計", [["原本（15 px/s 門檻）", {}], ["相對門檻", { TTC_FLOOR_NORMALIZED: true }], ["信賴下界", { TTC_LOWER_BOUND: true }]]],
  ["腳底向量", [["完整", {}], ["只否決錯身", { GROUND_VETO_ONLY: true }], ["關閉", { GROUND_VECTOR_ENABLED: false }]]],
  ["預測落點", [["有", {}], ["沒有", { ABLATE_LANDING: true }]]],
  ["確認等待", [["有", {}], ["沒有", { ZONE_CONFIRM_OFF: true }]]],
];
export function combinations() {
  let out = [[[], {}]];
  for (const [, levels] of FACTORS) {
    out = out.flatMap(([names, set]) => levels.map(([n, s]) => [[...names, n], { ...set, ...s }]));
  }
  return out;
}
