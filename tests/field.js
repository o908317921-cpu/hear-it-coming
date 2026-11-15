// 真實照片測試：用真的 YOLO 與深度模型跑 Wikimedia Commons 的街景照片，和人工標的答案比對。
// 照片與來源（作者、授權）在 tests/field-photos/sources.json；照片不進 git。
import { C } from "../js/config.js";
import { YoloSegmenter } from "../js/yolo.js";
import { DepthWorker } from "../js/depth.js";
import { findGroundSteps, trafficLightColor, crosswalkStripes } from "../js/scene.js";

// 人工標註。light：主要燈號；ground：drop（往下）/ step（往上）/ none（平地）；cross：true / false。
// 沒列的項目不計分（俯拍、老照片、不是胸前視角的照片）
const LABELS = {
  "light-00": { light: "green" }, "light-01": { light: "red" }, "light-03": { light: "green" }, "light-04": { light: "red" },
  "light-05": { light: "red" }, "light-06": { light: "red" }, "light-07": { light: "green" }, "light-08": { light: "green" },
  "light-09": { light: "red" }, "light-10": { light: "green" },
  "ground-11": { ground: "none" }, "ground-12": { ground: "none" }, "ground-15": { ground: "none" }, "ground-27": { ground: "none" },
  "ground-16": { ground: "drop" }, "ground-19": { ground: "drop" }, "ground-20": { ground: "drop" },
  "ground-21": { ground: "step" }, "ground-22": { ground: "step" }, "ground-24": { ground: "step" }, "ground-17": { ground: "step" },
  "cross-40": { cross: false, ground: "none" }, "cross-41": { cross: true, ground: "none" }, "cross-42": { cross: false, ground: "none" },
  "cross-46": { cross: false, ground: "none" }, "cross-50": { cross: false },
  "cross-39": { cross: true }, "cross-43": { cross: true }, "cross-44": { cross: true }, "cross-51": { cross: true },
};

const log = t => { document.getElementById("log").textContent += t + "\n"; };
const tbody = document.querySelector("#out tbody");
const row = (...cells) => {
  const tr = document.createElement("tr");
  cells.forEach((c, i) => {
    const td = document.createElement("td");
    td.textContent = c;
    if (i === 4) td.className = c === "對" ? "ok" : c === "錯" ? "bad" : "skip";
    tr.append(td);
  });
  tbody.append(tr);
};

async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
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

export async function run() {
  const sources = await (await fetch("field-photos/sources.json")).json();
  log("載入 YOLO…");
  const yolo = await YoloSegmenter.load();
  log(`YOLO：${yolo.backend}；載入深度模型…`);
  const depth = new DepthWorker();
  depth.start();
  while (!depth.ready && !depth.error) await new Promise(r => setTimeout(r, 200));
  if (depth.error) log("深度模型無法使用：" + depth.error);
  const results = [];
  const score = { light: [0, 0], ground: [0, 0], cross: [0, 0] };
  let ts = 1;
  for (const src of sources) {
    const name = src.file.replace(".jpg", "");
    const label = LABELS[name] || {};
    const { canvas, w, h, rgba } = await loadImage("field-photos/" + src.file);
    const raw = await yolo.detect(canvas, w, h);
    const r = { name, w, h };

    // 紅綠燈：每個框判讀顏色；取最大、判讀得出來的那個當結果（不套路徑位置限制，照片不是胸前視角）
    const lights = raw.filter(d => d.rawLabel === "traffic light" && d.score >= C.SIGNAL_MIN_CONF)
      .map(d => ({ box: d.box.map(Math.round), score: +d.score.toFixed(2), color: trafficLightColor(rgba, w, d.box),
                   inPath: Math.abs((d.box[0] + d.box[2]) / 2 - w / 2) <= w * C.SIGNAL_MAX_OFFSET_RATIO
                     && d.box[3] - d.box[1] >= h * C.SIGNAL_MIN_HEIGHT_RATIO }));
    const main = lights.filter(l => l.color).sort((a, b) => (b.box[3] - b.box[1]) - (a.box[3] - a.box[1]))[0];
    r.light = main ? main.color : lights.length ? "框到但分不出顏色" : "沒框到";
    r.lights = lights;

    // 地面：深度圖 + 挖掉 YOLO 物體
    if (depth.ready) {
      const disp = await depthOf(depth, canvas, w, h, ts++);
      const sx = disp.width / w, sy = disp.height / h, exclude = new Uint8Array(disp.width * disp.height);
      for (const d of raw.filter(d => d.score >= 0.4 && d.rawLabel !== "traffic light")) {
        for (let y = Math.floor(d.box[1] * sy); y < Math.min(disp.height, d.box[3] * sy); y++)
          for (let x = Math.floor(d.box[0] * sx); x < Math.min(disp.width, d.box[2] * sx); x++) exclude[y * disp.width + x] = 1;
      }
      const dbg = {};
      const st = findGroundSteps(disp, disp.width / 2, exclude, C.COLLISION_ZONE_RATIO, dbg);
      r.ground = st ? st.kind : "none";
      r.groundDetail = st ? `第 ${st.row}/${disp.height} 列，${st.reason}` : `最大跳變 ${dbg.jump?.toFixed(1) ?? "-"} 倍`;
    }

    // 斑馬線
    r.stripes = crosswalkStripes(rgba, w, h, w / 2);
    r.cross = r.stripes >= C.CROSSWALK_MIN_STRIPES;

    for (const key of ["light", "ground", "cross"]) {
      // 往上、往下在實測裡分不準，系統只說「地面有高低差」：答案是 drop／step 的都算 level
      const want = key === "ground" && label.ground && label.ground !== "none" ? "level" : label[key];
      const got = r[key];
      const detail = key === "light" ? JSON.stringify(lights.map(l => [l.color, l.score, l.inPath ? "路徑內" : "路徑外"]))
        : key === "ground" ? (r.groundDetail || "") : `亮條 ${r.stripes}`;
      if (want === undefined) {
        if (key === "light" && lights.length || key === "cross" && got || key === "ground" && got && got !== "none")
          row(name, key, "（不計分）", String(got), "-", detail);
        continue;
      }
      const okk = String(want) === String(got);
      score[key][0] += okk; score[key][1]++;
      row(name, key, String(want), String(got), okk ? "對" : "錯", detail);
    }
    results.push(r);
  }
  for (const [k, [a, n]] of Object.entries(score)) log(`${k}：${a}/${n} 對`);
  window.fieldResults = { results, score };
  document.title = "DONE";
  return score;
}
run().catch(e => { log("ERROR " + (e.stack || e)); document.title = "ERROR"; });
