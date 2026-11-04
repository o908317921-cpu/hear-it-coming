// 多目標追蹤：ByteTrack 精簡版（取代 Python 版 Ultralytics 內建的 ByteTrack / BoT-SORT）。
//
// ByteTrack 的關鍵是「兩階段配對」：
//   第一階段：信心度高的偵測框，和所有軌跡（包含剛遺失的）依重疊度配對。
//   第二階段：信心度低的偵測框（例如被擋住一半的人），只和還在追蹤中的軌跡配對，
//            讓已知的物體即使這一幀看得不清楚也能延續，ID 不會改變。
// 配對前先用每條軌跡的速度推算它現在的位置，並加上鏡頭轉動造成的畫面位移（全域運動補償）。
import { C } from "./config.js";
import { computeIou } from "./analysis.js";

function shiftBox(box, dx, dy) {
  return [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
}

// 依成本由小到大貪婪配對；cost(t, d) 回傳 Infinity 代表不能配
function greedyMatch(tracks, dets, cost, maxCost) {
  const pairs = [];
  tracks.forEach((t, ti) => dets.forEach((d, di) => {
    const c = cost(t, d);
    if (c <= maxCost) pairs.push([c, ti, di]);
  }));
  pairs.sort((a, b) => a[0] - b[0]);
  const usedT = new Set(), usedD = new Set(), matches = [];
  for (const [, ti, di] of pairs) {
    if (usedT.has(ti) || usedD.has(di)) continue;
    usedT.add(ti); usedD.add(di);
    matches.push([tracks[ti], dets[di]]);
  }
  return {
    matches,
    restTracks: tracks.filter((_, i) => !usedT.has(i)),
    restDets: dets.filter((_, i) => !usedD.has(i)),
  };
}

export class ByteTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
    this.frameId = 0;
  }

  // dets：[{box, score, rawLabel, ...}]；now：秒；camera：鏡頭轉動造成的畫面位移速度 {vx, vy}
  // 回傳這一次確認追蹤到的 [{id, det}]
  update(dets, now, camera = { vx: 0, vy: 0 }) {
    this.frameId++;
    const highThresh = Math.min(...Object.values(C.CLASS_CONF_THRESHOLDS));
    const high = dets.filter(d => d.score >= highThresh);
    const low = dets.filter(d => d.score < highThresh && d.score >= C.TRACK_LOW_CONF);

    // 用速度推算每條軌跡現在的位置（物體自己的速度＋鏡頭轉動）
    for (const t of this.tracks) {
      const dt = Math.max(0, now - t.time);
      t.predicted = shiftBox(t.box, (t.vx + camera.vx) * dt, (t.vy + camera.vy) * dt);
    }
    const iouCost = (t, d) => 1 - computeIou(t.predicted, d.box);
    const fusedCost = (t, d) => 1 - computeIou(t.predicted, d.box) * d.score;

    const confirmed = this.tracks.filter(t => t.confirmed);
    const unconfirmed = this.tracks.filter(t => !t.confirmed);
    const output = [];
    const apply = (t, d) => {
      const dt = now - t.time;
      if (dt > 0.02) {
        // 速度存「扣掉鏡頭轉動」之後的值，推算時再加回當下的鏡頭轉動
        const cx = (d.box[0] + d.box[2]) / 2 - (t.box[0] + t.box[2]) / 2;
        const cy = (d.box[1] + d.box[3]) / 2 - (t.box[1] + t.box[3]) / 2;
        const a = t.hits > 1 ? 0.5 : 1;
        t.vx = (1 - a) * t.vx + a * (cx / dt - camera.vx);
        t.vy = (1 - a) * t.vy + a * (cy / dt - camera.vy);
      }
      Object.assign(t, { box: d.box, time: now, lastFrame: this.frameId, lost: false, rawLabel: d.rawLabel });
      t.hits++;
      output.push({ id: t.id, det: d });
    };

    // 第一階段：高信心框 ↔ 所有已確認軌跡（含剛遺失的）
    const first = greedyMatch(confirmed, high, fusedCost, C.TRACK_MATCH_THRESH);
    first.matches.forEach(([t, d]) => apply(t, d));
    // 第二階段：低信心框 ↔ 還在追蹤中（沒有遺失）的軌跡
    const active = first.restTracks.filter(t => !t.lost);
    const second = greedyMatch(active, low, iouCost, 0.5);
    second.matches.forEach(([t, d]) => apply(t, d));
    for (const t of second.restTracks) t.lost = true;
    // 上一次才出現的新軌跡：這一次再看到才確認，避免單幀誤判建立新物體
    const third = greedyMatch(unconfirmed, first.restDets, fusedCost, 0.7);
    third.matches.forEach(([t, d]) => {
      if (t.hits + 1 >= C.TRACK_CONFIRM_HITS) { t.confirmed = true; apply(t, d); return; }
      // 還沒看到足夠的次數：更新位置，但先不算數
      const before = output.length;
      apply(t, d);
      output.length = before;
    });
    const dropped = new Set(third.restTracks);

    // 剩下的高信心框建立新軌跡（第一次偵測時直接確認）
    for (const d of third.restDets) {
      if (d.score < (C.CLASS_CONF_THRESHOLDS[d.rawLabel] ?? C.TRACK_NEW_CONF)) continue;
      const t = { id: this.nextId++, box: d.box, vx: 0, vy: 0, time: now, lastFrame: this.frameId,
                  hits: 1, lost: false, confirmed: d.score >= C.TRACK_INSTANT_CONF, rawLabel: d.rawLabel };
      this.tracks.push(t);
      if (t.confirmed) output.push({ id: t.id, det: d });
    }
    this.tracks = this.tracks.filter(t => !dropped.has(t) && this.frameId - t.lastFrame <= C.TRACK_BUFFER_FRAMES);
    return output;
  }
}
