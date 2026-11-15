// 科展版新增：實測紀錄。每一句警報都記在手機裡（不上傳），陪走的協助者可以當場標記「誤報」或「漏報」，
// 回家後匯出 CSV，算誤報率、警報提早幾秒，當作報告的實驗數據。
const KEY = "hic-fieldlog";
const MAX_EVENTS = 5000;          // 約 1 MB 以內；超過時丟掉最舊的
const MARK_WINDOW_MS = 15000;     // 「誤報」標記到最近 15 秒內的那一句警報

const fixed = (x, d = 1) => (Number.isFinite(x) ? +x.toFixed(d) : null);

export class FieldLog {
  constructor(storage) {
    try { this.storage = storage ?? globalThis.localStorage; } catch (e) { this.storage = null; }   // 無痕模式可能直接丟錯
    this.session = null;
    try { this.events = JSON.parse(storage?.getItem(KEY) || "[]"); } catch (e) { this.events = []; }
    if (!Array.isArray(this.events)) this.events = [];
  }

  save() {
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    try { this.storage?.setItem(KEY, JSON.stringify(this.events)); } catch (e) { /* 無痕模式或空間滿了：只留在記憶體 */ }
  }

  push(event) {
    this.events.push({ t: Date.now(), s: this.session, ...event });
    this.save();
    return this.events[this.events.length - 1];
  }

  start(info = {}) {
    this.session = Date.now().toString(36);
    this.push({ type: "start", ...info });
  }

  stop() {
    if (this.session) this.push({ type: "stop" });
    this.session = null;
  }

  // text：念出的句子；track：這句警報針對的物體（可為 null）；fps：當時每秒幾幀
  alert(text, kind, track = null, fps = null) {
    if (!this.session) return null;
    return this.push({
      type: "alert", kind, text,
      obj: track?.label ?? null, dir: track?.horizontalPosition ?? null,
      ttc: fixed(track?.ttcSec), dist: fixed(track?.distanceM), age: fixed(track?.ageSec), fps: fixed(fps),
    });
  }

  // 實驗四（運算成本）：每隔一段時間記一次效能，安靜沒有警報的時候也有數據
  perf({ fps, ms, yolo, depth }) {
    if (!this.session) return null;
    return this.push({ type: "perf", fps: fixed(fps), ms: fixed(ms, 0), engine: yolo, depth: depth ? "開" : "關" });
  }

  // which："false"（剛才那句是誤報）或 "miss"（剛才有危險但沒有警報）；回傳要念的確認句
  mark(which) {
    if (!this.session) return "還沒開始偵測，沒有記錄";
    if (which === "miss") { this.push({ type: "miss" }); return "已記錄漏報"; }
    const now = Date.now();
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.s !== this.session || now - e.t > MARK_WINDOW_MS) break;
      if (e.type === "alert" && !e.flag) { e.flag = "false"; this.save(); return "已標記誤報"; }
    }
    return "最近 15 秒沒有警報可以標記";
  }

  summary() {
    const alerts = this.events.filter(e => e.type === "alert");
    const falses = alerts.filter(e => e.flag === "false").length;
    const misses = this.events.filter(e => e.type === "miss").length;
    // 每一場的長度：第一筆到最後一筆
    const span = new Map();
    for (const e of this.events) {
      const [first] = span.get(e.s) || [e.t];
      span.set(e.s, [first, e.t]);
    }
    const minutes = [...span.values()].reduce((acc, [a, b]) => acc + (b - a) / 60000, 0);
    // 研究主體：碰撞警報發出時，預計還有幾秒會撞上（越大代表越早提醒）。標成誤報的不算
    const ttc = {};
    for (const tier of ["注意", "危險", "停"]) {
      const v = alerts.filter(e => e.kind === tier && e.flag !== "false" && Number.isFinite(e.ttc)).map(e => e.ttc);
      ttc[tier] = { n: v.length, mean: v.length ? fixed(v.reduce((a, b) => a + b, 0) / v.length) : null };
    }
    const perf = this.events.filter(e => e.type === "perf" && Number.isFinite(e.fps));
    const avg = k => perf.length ? fixed(perf.reduce((a, e) => a + e[k], 0) / perf.length, k === "ms" ? 0 : 1) : null;
    return { sessions: span.size, minutes: fixed(minutes), alerts: alerts.length, falseAlarms: falses, misses,
             falseRate: alerts.length ? fixed(falses / alerts.length * 100) : null, ttc,
             fps: avg("fps"), frameMs: avg("ms"), perfSamples: perf.length };
  }

  csv() {
    const head = ["時間", "場次", "類型", "警報種類", "內容", "物體", "方向", "TTC秒", "距離公尺", "已追蹤秒", "FPS", "標記", "每幀毫秒", "辨識引擎", "深度模型"];
    const type = { start: "開始", stop: "停止", alert: "警報", miss: "漏報", perf: "效能" };
    const cell = v => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const time = t => {
      const d = new Date(t), p = n => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    const rows = this.events.map(e => [time(e.t), e.s, type[e.type] || e.type, e.kind, e.text, e.obj, e.dir,
      e.ttc, e.dist, e.age, e.fps, e.flag === "false" ? "誤報" : "", e.ms, e.engine, e.depth]);
    return "﻿" + [head, ...rows].map(r => r.map(cell).join(",")).join("\r\n");   // BOM：Excel 才認得中文
  }

  clear() {
    this.events = [];
    this.save();
  }
}
