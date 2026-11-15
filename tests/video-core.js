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
