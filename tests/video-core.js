// 影片逐幀分析（tests/video.js）用的小工具，不碰瀏覽器，可以在自動測試裡驗證。

// 物件陣列 → CSV 文字。欄位取所有列出現過的鍵；有逗號、引號、換行的值加引號
export function toCsv(rows) {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const cell = v => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\n");
}

// 設定覆寫：只接受 config 裡已經有的名稱，型別也要一樣；打錯字時說清楚，不要默默沒效果
export function parseOverrides(text, C) {
  if (!text.trim()) return {};
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error("設定覆寫不是正確的 JSON：" + e.message); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error('設定覆寫要寫成 {"名稱": 值}');
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in C)) throw new Error(`沒有這個設定：${k}`);
    if (typeof v !== typeof C[k]) throw new Error(`${k} 應該是 ${typeof C[k]}，寫成了 ${typeof v}`);
  }
  return obj;
}

// 影片長度與每秒幀數 → 每一幀的時間點（秒）。最後一幀留一點空間，避免跳到影片結尾之後拿不到畫面
export function frameTimes(duration, fps) {
  if (!(duration > 0) || !Number.isFinite(duration) || !(fps > 0)) return [];   // 沒寫長度的影片（Infinity）不能無限產生
  const n = Math.max(1, Math.floor((duration - 0.001) * fps) + 1);
  return Array.from({ length: n }, (_, i) => +(i / fps).toFixed(6)).filter(t => t < duration);
}

// 實驗一：已知真實碰撞時刻 tc（秒）時，真實 TTC = tc − t。取「出現最多幀、沒被暫留」的那個物體，
// 只算真實 TTC 在 (0, maxTtc] 的幀（報告的警示區間），回傳平均絕對誤差與用到的幀數
export function ttcError(rows, tc, maxTtc = 3) {
  const live = rows.filter(r => !r.predicted && r.ttc !== "" && Number.isFinite(Number(r.ttc)));
  if (!live.length) return null;
  const count = new Map();
  for (const r of live) count.set(r.id, (count.get(r.id) || 0) + 1);
  const id = [...count].sort((a, b) => b[1] - a[1])[0][0];
  const errs = live.filter(r => r.id === id).map(r => [tc - r.t, Number(r.ttc)]).filter(([truth]) => truth > 0 && truth <= maxTtc)
    .map(([truth, est]) => Math.abs(est - truth));
  if (!errs.length) return { id, n: 0, mae: null };
  return { id, n: errs.length, mae: +(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(3) };
}

// ---------- 實驗二：多段影片＋人工標註 → 精確率、召回率、F1、提前時間、方向正確率（報告表 4-2） ----------
const stem = name => String(name).trim().split(/[\\/]/).pop().replace(/\.[^.]+$/, "").toLowerCase();
const DIRS = { 左: "left", 左前方: "left", left: "left", 中: "center", 正前方: "center", center: "center", 右: "right", 右前方: "right", right: "right" };

// 標註 CSV：欄位「檔名, 應警示(1/0), 碰撞時刻(秒，可空), 方向(左/中/右，可空)」，標題可用中文或英文
export function parseLabels(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return new Map();
  const head = lines[0].split(",").map(h => h.trim().toLowerCase());
  const col = names => head.findIndex(h => names.includes(h));
  const fi = col(["檔名", "file", "影片"]), ai = col(["應警示", "alert", "should_alert"]);
  const ti = col(["碰撞時刻", "tc", "collision"]), di = col(["方向", "dir", "direction"]);
  if (fi < 0 || ai < 0) throw new Error("標註檔要有「檔名」與「應警示」兩欄");
  const out = new Map();
  for (const [n, line] of lines.slice(1).entries()) {
    const c = line.split(",").map(v => v.trim());
    const a = c[ai].toLowerCase();
    if (!["1", "0", "是", "否", "true", "false"].includes(a)) throw new Error(`第 ${n + 2} 行「應警示」要填 1 或 0`);
    const tc = ti >= 0 && c[ti] !== "" && c[ti] != null ? Number(c[ti]) : null;
    if (tc != null && !(tc > 0)) throw new Error(`第 ${n + 2} 行「碰撞時刻」要是正數（秒）`);
    out.set(stem(c[fi]), { alert: ["1", "是", "true"].includes(a), tc, dir: di >= 0 ? DIRS[c[di]] ?? null : null });
  }
  return out;
}

// 一段影片的警報列 → 第一句碰撞警報（注意／危險／停）的時間與方向（方向取第一句有方向的整句）
const TIERS = ["注意", "危險", "停"];
export function clipAlert(rows) {
  const ttc = rows.filter(r => r.kind === "speech" && /^(注意|危險|停)/.test(r.text));
  if (!ttc.length) return { alerted: false, firstT: null, dir: null, count: 0, tierT: {} };
  const withDir = ttc.find(r => /左前方|正前方|右前方/.test(r.text));
  const dir = withDir ? DIRS[withDir.text.match(/左前方|正前方|右前方/)[0]] : null;
  // 三級警示各自第一次出現的時間（報告：各級的提前時間）
  const tierT = {};
  for (const tier of TIERS) { const r = ttc.find(x => x.text.startsWith(tier)); if (r) tierT[tier] = r.t; }
  return { alerted: true, firstT: ttc[0].t, dir, count: ttc.length, tierT };
}

// clips：[{ file, alerted, firstT, dir }]；labels：parseLabels 的結果。
// 應警示的片段要在碰撞時刻之前警示才算正確警示；之後才響算漏報
export function evaluateClips(clips, labels) {
  let tp = 0, fp = 0, fn = 0, tn = 0, dirOk = 0, dirN = 0;
  const leads = [], rows = [], unlabeled = [], tierLeads = Object.fromEntries(TIERS.map(t => [t, []]));
  for (const c of clips) {
    const lab = labels.get(stem(c.file));
    if (!lab) { unlabeled.push(c.file); continue; }
    const inTime = c.alerted && (lab.tc == null || c.firstT < lab.tc);
    let result;
    if (lab.alert) {
      if (inTime) {
        tp++; result = "正確警示";
        if (lab.tc != null) {
          leads.push(lab.tc - c.firstT);
          for (const tier of TIERS) if (c.tierT?.[tier] != null && c.tierT[tier] < lab.tc) tierLeads[tier].push(lab.tc - c.tierT[tier]);
        }
        if (lab.dir) { dirN++; if (c.dir === lab.dir) dirOk++; }
      } else { fn++; result = c.alerted ? "漏報（太晚）" : "漏報"; }
    } else if (c.alerted) { fp++; result = "誤報"; } else { tn++; result = "正確安靜"; }
    rows.push({ 檔名: c.file, 應警示: lab.alert ? 1 : 0, 系統警示: c.alerted ? 1 : 0, 第一句秒: c.firstT ?? "",
                碰撞時刻: lab.tc ?? "", 提前秒: inTime && lab.tc != null ? +(lab.tc - c.firstT).toFixed(2) : "",
                標註方向: lab.dir ?? "", 系統方向: c.dir ?? "", 結果: result,
                ...Object.fromEntries(TIERS.map(t => [`${t}提前秒`, inTime && lab.tc != null && c.tierT?.[t] != null && c.tierT[t] < lab.tc ? +(lab.tc - c.tierT[t]).toFixed(2) : ""])) });
  }
  const r3 = x => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));
  const precision = tp + fp ? tp / (tp + fp) : null, recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision != null && recall != null && precision + recall ? 2 * precision * recall / (precision + recall) : null;
  return { tp, fp, fn, tn, precision: r3(precision), recall: r3(recall), f1: r3(f1),
           dirAccuracy: dirN ? r3(dirOk / dirN) : null, leadMean: leads.length ? r3(leads.reduce((a, b) => a + b, 0) / leads.length) : null,
           leadByTier: Object.fromEntries(TIERS.map(t => [t, { n: tierLeads[t].length, mean: tierLeads[t].length ? r3(tierLeads[t].reduce((a, b) => a + b, 0) / tierLeads[t].length) : null }])),
           rows, unlabeled };
}
