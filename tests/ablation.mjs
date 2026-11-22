// 模擬實驗（亂數種子 5–8，調參沒用過 × 每秒 4/7/10 幀）：
//   node tests/ablation.mjs                 消融（一次拿掉一個，ABLATIONS）
//   node tests/ablation.mjs factorial       排列組合（FACTORS 的所有組合）
//   再加 stress 用加倍雜訊，例：node tests/ablation.mjs factorial stress > tests/factorial-stress.csv
// 一列約 4 分鐘，整張消融表約 1 小時
import { ABLATIONS, SCENARIOS, HELD_OUT, NOISE, STRESS_NOISE, combinations, evaluate } from "./sim.js";

const args = process.argv.slice(2), stress = args.includes("stress");
if (stress) Object.assign(NOISE, STRESS_NOISE);
const rows = args.includes("factorial") ? combinations().map(([names, set]) => [names.join("／"), set]) : ABLATIONS;
const opts = { fpsList: [4, 7, 10], seeds: [5, 6, 7, 8] };
const pct = x => (x * 100).toFixed(1);
console.log("﻿設定,雜訊,場景組,及時警告率%,漏報率%,危險誤報率%,提前時間中位數秒");
for (const [name, set] of rows) {
  for (const [group, scenarios] of [["13 個主要場景", SCENARIOS], ["5 個驗證場景（未調參）", HELD_OUT]]) {
    const r = await evaluate(set, { ...opts, scenarios });
    console.log([name, stress ? "加倍雜訊" : "一般", group, pct(r.timelyRate), pct(r.missRate), pct(r.falseAlarmRate), r.medianLead.toFixed(2)].join(","));
  }
}
