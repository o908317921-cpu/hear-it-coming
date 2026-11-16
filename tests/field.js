// 真實照片測試：用真的 YOLO 與深度模型跑 Wikimedia Commons 的街景照片，和人工標的答案比對。
// 照片與來源（作者、授權）在 tests/field-photos/sources.json；照片不進 git（python tests/fetch_field_photos.py 下載）。
// 目標是「說出口的都要對」：誤報（說錯）要是 0；漏報（該說沒說）次之。
import { C } from "../js/config.js";
import { YoloSegmenter } from "../js/yolo.js";
import { DepthWorker } from "../js/depth.js";
import { findGroundSteps, trafficLightColor, crosswalkStripes, pickLight, pedestrianSignals } from "../js/scene.js";

// ---------- 人工標註 ----------
// 第 1 組（54 張）：調門檻用的照片。第 2 組（91 張）：調完門檻後才下載的盲測照片，門檻不再依它修改。
// 紅綠燈：沒列的照片＝畫面裡沒有燈；"mixed"＝不同燈號同時入鏡（安靜才算對）；"skip"＝燈太小看不清，不計分
// 地面 level：行走路徑上真的有台階、路緣、樓梯；tilted：鏡頭明顯朝天或朝地（App 會用手機傾斜角度直接不判斷）
// 斑馬線 cross：畫面裡行走方向前方有斑馬線
const SETS = {
  1: {
    dir: "field-photos",
    light: { "light-00": "green", "light-01": "red", "light-02": "skip", "light-03": "green", "light-04": "red", "light-05": "red",
      "light-06": "red", "light-07": "mixed", "light-08": "green", "light-09": "red", "light-10": "green",
      "cross-46": "skip", "cross-47": "red", "cross-51": "skip" },
    level: ["ground-13", "ground-14", "ground-16", "ground-17", "ground-18", "ground-19", "ground-20", "ground-21",
      "ground-22", "ground-24", "ground-28", "ground-29", "ground-30", "ground-31"],
    groundSkip: ["ground-25", "ground-26", "cross-38", "cross-48", "cross-49"],
    tilted: ["light-03", "light-05", "light-06", "light-08", "light-09", "light-10", "ground-13", "ground-14",
      "ground-16", "ground-28", "ground-29", "ground-30", "ground-31", "ground-32", "ground-33", "ground-34", "ground-35",
      "ground-36", "ground-37"],
    cross: ["cross-38", "cross-39", "cross-41", "cross-43", "cross-44", "cross-45", "cross-47", "cross-48",
      "cross-49", "cross-51", "cross-52", "cross-53"],
    crossSkip: [],
  },
  2: {
    dir: "field-photos-2",
    // 英國斑馬線旁的黃色閃燈（cross-85、86、88、90）不是紅綠燈：沒列＝應該安靜
    light: { "light-00": "green", "light-02": "green", "light-04": "green", "light-05": "skip", "light-06": "skip",
      "light-07": "red", "light-08": "mixed", "light-09": "red", "light-10": "skip", "light-11": "red", "light-12": "green",
      "light-13": "red", "light-14": "red", "light-15": "skip", "light-16": "skip", "light-17": "yellow", "light-18": "skip",
      "light-19": "red", "cross-74": "skip", "cross-75": "skip", "cross-79": "skip", "cross-87": "skip", "ground-37": "skip" },
    level: ["ground-23", "ground-25", "ground-26", "ground-29", "ground-30", "ground-31", "ground-32", "ground-55",
      "ground-57", "ground-58", "ground-59", "ground-60",
      "ground-37"],   // 盲測後重看才發現路緣（第一次標成平地）
    groundSkip: ["ground-27", "ground-28", "ground-35", "ground-36", "ground-48", "ground-56", "ground-61",
      "light-03", "light-09", "light-19", "cross-70", "cross-79",
      "light-10"],    // 行車記錄器畫面（下面是車頭），不是行人視角；盲測後才發現
    tilted: ["light-01", "ground-25", "ground-26", "ground-44", "ground-49", "ground-50", "ground-51", "ground-52", "ground-63"],
    cross: ["cross-64", "cross-65", "cross-66", "cross-67", "cross-68", "cross-69", "cross-70", "cross-71", "cross-72",
      "cross-73", "cross-74", "cross-75", "cross-78", "cross-79", "cross-81", "cross-83", "cross-84", "cross-85", "cross-86",
      "cross-88", "cross-89", "cross-90", "ground-36", "light-11"],
    crossSkip: ["light-01", "light-12", "light-13", "light-17"],
  },
  3: {
    // 第 3 組（71 張）：第 2 組調完門檻後才下載，跑之前就標好答案，跑完不再修改門檻與標註
    dir: "field-photos-3",
    light: { "light-00": "skip", "light-01": "skip", "light-07": "skip", "light-08": "mixed", "light-09": "mixed", "light-10": "green",
      "light-12": "skip", "light-13": "skip", "light-14": "skip", "light-15": "red", "light-16": "skip", "light-17": "skip",
      "light-18": "skip", "light-19": "skip", "light-20": "skip", "cross-53": "skip", "cross-64": "skip", "cross-66": "skip",
      "cross-67": "green", "cross-69": "mixed", "cross-70": "green" },
    level: ["ground-21", "ground-22", "ground-23", "ground-35", "ground-37"],
    groundSkip: ["ground-25", "ground-26", "ground-33", "ground-34", "ground-36", "ground-43", "ground-44", "ground-45", "ground-46",
      "ground-47", "ground-48", "ground-49", "ground-50", "light-02", "light-03", "light-17", "light-18", "light-19", "light-20",
      "cross-52", "cross-61", "cross-68", "cross-69"],
    tilted: ["ground-24", "ground-42", "light-10", "cross-57"],
    cross: ["cross-53", "cross-54", "cross-55", "cross-56", "cross-57", "cross-59", "cross-62", "cross-66", "light-09"],
    crossSkip: ["cross-52", "cross-58", "cross-67", "cross-69", "cross-70", "light-17", "light-18", "light-19", "light-20"],
  },
};
// 台灣紅綠燈組（tests/fetch_tw_signals.py 下載）：只測紅綠燈，答案在 tests/tw-labels.json
const SET_KEY = new URLSearchParams(location.search).get("set") || "1";
if (SET_KEY === "tw") {
  SETS.tw = { dir: "field-photos-tw", light: await (await fetch("tw-labels.json")).json(), lightOnly: true,
    level: [], groundSkip: [], tilted: [], cross: [], crossSkip: [] };
}
const SET = SETS[SET_KEY];
const LIGHT = SET.light, LEVEL = new Set(SET.level), GROUND_SKIP = new Set(SET.groundSkip), TILTED = new Set(SET.tilted);
const CROSS = new Set(SET.cross), CROSS_SKIP = new Set(SET.crossSkip);

const log = t => { document.getElementById("log").textContent += t + "\n"; };
const tbody = document.querySelector("#out tbody");
const row = (...cells) => {
  const tr = document.createElement("tr");
  cells.forEach((c, i) => {
    const td = document.createElement("td");
    td.textContent = c;
    if (i === 4) td.className = c.startsWith("對") ? "ok" : c === "誤報" ? "bad" : "skip";
    tr.append(td);
  });
  tbody.append(tr);
};

async function loadImage(src) {
  // 不用 img.decode()：瀏覽器分頁在背景時它會一直等下去
  const img = await createImageBitmap(await (await fetch(src)).blob());
  const w = 640, h = Math.round(640 * img.height / img.width);
  const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, w, h, rgba: ctx.getImageData(0, 0, w, h).data };
}

function depthOf(depth, canvas, w, h, ts) {
  return new Promise((ok, fail) => {
    const started = performance.now();
    const wait = () => {
      if (!depth.busy && depth.result?.ts === ts) return ok(depth.result.disp);
      if (depth.error || performance.now() - started > 30000) return fail(new Error(depth.error || "深度逾時"));
      setTimeout(wait, 30);
    };
    if (!depth.submit(canvas, w, h, ts)) return fail(new Error("深度模型忙碌或未就緒"));
    wait();
  });
}

// want：應該說的內容（null＝應該安靜）；got：系統說的（null＝安靜）
function judge(want, got) {
  if (got == null) return want == null ? "對（安靜）" : "漏報";
  return got === want ? "對" : "誤報";
}

export async function run() {
  const sources = await (await fetch(SET.dir + "/sources.json")).json();
  log(`照片：${SET.dir}（${sources.length} 張）`);
  // ?cpu：改用 CPU 跑（沒有顯示晶片的電腦）
  if (new URLSearchParams(location.search).has("cpu")) { C.USE_WEBGPU = false; C.DEPTH_ON_WASM = true; }
  log("載入 YOLO…");
  const yolo = await YoloSegmenter.load();
  log(`YOLO：${yolo.backend}；載入深度模型…`);
  // 瀏覽器分頁在背景時，第一個深度執行緒偶爾一直沒有就緒：等 40 秒，不行就重開一次
  let depth;
  for (let attempt = 0; attempt < 3 && !depth?.ready; attempt++) {
    depth?.close();
    depth = new DepthWorker();
    depth.start();
    const t0 = performance.now();
    while (!depth.ready && !depth.error && performance.now() - t0 < 40000) await new Promise(r => setTimeout(r, 200));
    log(`深度模型第 ${attempt + 1} 次：${depth.ready ? "就緒 " + depth.backend : depth.error || "逾時"}（下載 ${Math.round(depth.progress * 100)}%）`);
  }
  if (depth.error) throw new Error("深度模型無法使用：" + depth.error);
  const results = [], depthFailed = [];
  const tally = {};
  const count = (key, verdict) => { tally[key] = tally[key] || {}; tally[key][verdict] = (tally[key][verdict] || 0) + 1; };
  let ts = 1;
  for (const src of sources) {
    const name = src.file.replace(".jpg", "");
    const { canvas, w, h, rgba } = await loadImage(SET.dir + "/" + src.file);
    const raw = await yolo.detect(canvas, w, h);
    const r = { name };

    // ---- 紅綠燈（照片不是胸前視角，不套路徑位置限制）
    const lights = raw.filter(d => d.rawLabel === "traffic light" && d.score >= C.SIGNAL_MIN_CONF)
      .map(d => ({ box: d.box.map(Math.round), score: +d.score.toFixed(2), color: trafficLightColor(rgba, w, d.box) }));
    // 和 App 一樣：YOLO 認不得的台灣 LED 行人號誌另外找（js/scene.js pedestrianSignals）
    if (C.PED_ENABLED) lights.push(...pedestrianSignals(rgba, w, h).map(l => ({ ...l, ped: true, score: "小綠人規則" })));
    r.light = pickLight(lights)?.replace("ped_", "") ?? null;   // 答案只標顏色，不分是不是行人號誌
    // 台灣組只人工確認過一部分（tw-labels.json）：沒列的照片不計分，不是「應該安靜」
    const lightWant = LIGHT[name] ?? (SET_KEY === "tw" ? "skip" : null);
    if (lightWant !== "skip") {
      const v = judge(lightWant === "mixed" ? null : lightWant, r.light);
      count("紅綠燈", v);
      if (lightWant || r.light || lights.length) row(name, "紅綠燈", lightWant ?? "沒有燈", r.light ?? "安靜", v, JSON.stringify(lights.map(l => [l.color, l.score])));
    }

    if (SET.lightOnly || new URLSearchParams(location.search).has("lightonly")) { results.push(r); continue; }   // ?lightonly：只測紅綠燈
    // ---- 地面高低差（鏡頭傾斜的照片，App 不判斷）
    let level = false, flat = false, disp = null;
    if (!TILTED.has(name)) {
      // 顯示晶片忙的時候深度偶爾逾時：再試一次，還是不行就這張的地面與斑馬線不計分，不讓整組測試中斷
      for (let k = 0; k < 2 && !disp; k++) {
        try { disp = await depthOf(depth, canvas, w, h, ts++); } catch (e) { console.warn(name, e.message); }
      }
      if (!disp) { depthFailed.push(name); results.push({ ...r, ground: "深度失敗，不計分" }); continue; }
    }
    if (TILTED.has(name)) {
      r.ground = "鏡頭傾斜，不判斷";
    } else {
      const sx = disp.width / w, sy = disp.height / h, exclude = new Uint8Array(disp.width * disp.height);
      for (const d of raw.filter(d => d.score >= 0.4 && d.rawLabel !== "traffic light")) {
        for (let y = Math.floor(d.box[1] * sy); y < Math.min(disp.height, d.box[3] * sy); y++)
          for (let x = Math.floor(d.box[0] * sx); x < Math.min(disp.width, d.box[2] * sx); x++) exclude[y * disp.width + x] = 1;
      }
      const dbg = {};
      const st = findGroundSteps(disp, disp.width / 2, exclude, C.COLLISION_ZONE_RATIO, dbg);
      level = !!st;
      flat = !st && dbg.groundSeen && !dbg.anyEdge;
      r.ground = st ? "level" : null;
      if (!GROUND_SKIP.has(name)) {
        const want = LEVEL.has(name) ? "level" : null;
        const v = judge(want, r.ground);
        count("地面高低差", v);
        if (want || st) row(name, "地面", want ? "有高低差" : "平地", st ? "地面有高低差" : "安靜", v,
          st ? st.reason : (dbg.bands || []).map(b => b?.reason ?? (b ? "平" : "看不到地面")).join("；"));
      }
    }

    // ---- 斑馬線（深度圖確認前方是平地才判斷，和 App 一樣；鏡頭傾斜時沒有深度判斷，也不報）
    const stripes = crosswalkStripes(rgba, w, h, w / 2);
    r.cross = flat && stripes >= C.CROSSWALK_MIN_STRIPES ? "crosswalk" : null;
    const crossWant = CROSS.has(name) ? "crosswalk" : null;
    const v = CROSS_SKIP.has(name) ? "不計分" : judge(crossWant, r.cross);
    if (v !== "不計分") count("斑馬線", v);
    if (crossWant || r.cross || stripes >= C.CROSSWALK_MIN_STRIPES) row(name, "斑馬線", crossWant ? "有" : "沒有", r.cross ? "前方有斑馬線" : "安靜", v,
      `白色橫條 ${stripes}${!flat && stripes >= C.CROSSWALK_MIN_STRIPES ? "（深度圖沒有確認是平地，不判斷）" : ""}`);
    results.push(r);
  }
  if (depthFailed.length) log(`深度模型逾時、地面與斑馬線不計分：${depthFailed.join("、")}`);
  for (const [k, t] of Object.entries(tally)) {
    log(`${k}：說對 ${t["對"] || 0}、正確安靜 ${t["對（安靜）"] || 0}、漏報 ${t["漏報"] || 0}、誤報 ${t["誤報"] || 0}`);
  }
  window.fieldResults = { results, tally };
  document.title = "DONE";
  return tally;
}
run().catch(e => { log("ERROR " + (e.stack || e)); document.title = "ERROR"; });
