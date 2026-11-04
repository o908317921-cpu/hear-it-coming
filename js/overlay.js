// 在畫面上疊加偵測框、遮罩、標籤、移動方向、碰撞預測與靜態障礙（對應 blindnav/overlay.py）。
import { C } from "./config.js";
import { motionArrowEndpoint, ttcIsMeaningful } from "./analysis.js";
import { isTrackOfInterest, speedDescription } from "./alerts.js";

const MUTED = "#A0A0A0";
const ARROW = "#00BEFF";
const SPEED_LEVEL = { slow: "GREEN", medium: "ORANGE", fast: "RED" };

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 標籤晶片：有底色的圓角文字，不會超出畫面邊緣
function chip(ctx, text, x, y, bg, fg, size) {
  ctx.font = `700 ${size}px system-ui, "PingFang TC", "Microsoft JhengHei", sans-serif`;
  const w = ctx.measureText(text).width + 12, h = size + 8;
  x = Math.max(0, Math.min(x, ctx.canvas.width - w));
  y = Math.max(0, Math.min(y, ctx.canvas.height - h));
  if (bg) {
    ctx.fillStyle = bg;
    roundRect(ctx, x, y, w, h, 5);
    ctx.fill();
  }
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 6, y + h / 2 + 1);
}

// 半透明遮罩：遮罩格子先畫到小畫布，再放大貼到物體位置
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");
function drawMask(ctx, mask, color, alpha) {
  if (!mask || mask.boxOnly) return;     // 輕量模型沒有輪廓，只畫框
  maskCanvas.width = mask.gw;
  maskCanvas.height = mask.gh;
  const img = maskCtx.createImageData(mask.gw, mask.gh);
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
  for (let i = 0; i < mask.data.length; i++) {
    if (!mask.data[i]) continue;
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255 * alpha;
  }
  maskCtx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(maskCanvas, mask.x, mask.y, mask.gw * mask.cell, mask.gh * mask.cell);
}

function arrow(ctx, from, to, color, width) {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const head = Math.hypot(to[0] - from[0], to[1] - from[1]) * 0.25;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(...from);
  ctx.lineTo(...to);
  ctx.moveTo(to[0] - head * Math.cos(angle - 0.5), to[1] - head * Math.sin(angle - 0.5));
  ctx.lineTo(...to);
  ctx.lineTo(to[0] - head * Math.cos(angle + 0.5), to[1] - head * Math.sin(angle + 0.5));
  ctx.stroke();
}

// 「使用者行走路徑」：展示時能直接看到碰撞判斷的依據；開啟路徑自適應時跟著平均朝向移動
function drawCollisionZone(ctx, w, h, centerX) {
  const half = w * C.COLLISION_ZONE_RATIO / 2, cx = centerX ?? w / 2;
  ctx.fillStyle = "rgba(255,255,255,.06)";
  ctx.fillRect(cx - half, 0, half * 2, h);
  ctx.setLineDash([8, 8]);
  ctx.strokeStyle = "rgba(220,220,220,.55)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - half, 0); ctx.lineTo(cx - half, h);
  ctx.moveTo(cx + half, 0); ctx.lineTo(cx + half, h);
  ctx.stroke();
  ctx.setLineDash([]);
  chip(ctx, "行走路徑", cx - half + 2, 4, null, MUTED, 13);
}

// 深度圖找到的靜態障礙：紫色斜線框，與 YOLO 物體的綠／橙／紅區分
function drawStaticHazards(ctx, hazards) {
  const c = C.STATIC_HAZARD_COLOR;
  for (const hz of hazards) {
    const [x1, y1, x2, y2] = hz.box;
    ctx.fillStyle = c + "38";
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.save();
    ctx.beginPath(); ctx.rect(x1, y1, x2 - x1, y2 - y1); ctx.clip();
    ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let d = 0; d < (x2 - x1) + (y2 - y1); d += 22) { ctx.moveTo(x1 + d, y1); ctx.lineTo(x1, y1 + d); }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = c; ctx.lineWidth = 4; ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const text = hz.label + (Number.isFinite(hz.distanceM) ? `｜約 ${hz.distanceM.toFixed(1)} 公尺` : "");
    chip(ctx, text, x1, y1 > 30 ? y1 - 28 : y1 + 4, c, "#fff", 17);
  }
}

// frame：這次分析用的那一幀。畫面與框來自同一幀，手機轉動時框才不會跟畫面錯開
export function drawOverlay(ctx, w, h, allTracks, { pathCenterX = null, staticHazards = [], frame = null } = {}) {
  if (ctx.canvas.width !== w || ctx.canvas.height !== h) { ctx.canvas.width = w; ctx.canvas.height = h; }
  ctx.clearRect(0, 0, w, h);
  if (frame) ctx.drawImage(frame, 0, 0, w, h);
  // 這一幀沒有真的看到、只是暫留的物體不畫：畫出來就是沒有東西的地方多一個框
  const tracks = allTracks.filter(tr => !tr.isPredicted);
  drawCollisionZone(ctx, w, h, pathCenterX);
  drawStaticHazards(ctx, staticHazards);

  const focus = tracks.filter(isTrackOfInterest);
  // 純背景／靜止物體：只畫細灰框＋類別名稱，不搶視覺焦點
  for (const tr of tracks.filter(t => !isTrackOfInterest(t))) {
    const [x1, y1, x2, y2] = tr.box;
    ctx.strokeStyle = "#8C8C8C"; ctx.lineWidth = 1; ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    chip(ctx, tr.label, x1, y1 - 22, null, MUTED, 13);
  }
  for (const tr of focus) drawMask(ctx, tr.mask, C.LEVEL_COLORS[tr.proximityLevel], 0.35);

  for (const tr of focus) {
    const [x1, y1, x2, y2] = tr.box;
    const color = C.LEVEL_COLORS[tr.proximityLevel];
    ctx.strokeStyle = color;
    ctx.lineWidth = tr.proximityLevel === "RED" ? 5 : 3;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

    // 移動方向箭頭；有 TTC 時另外畫出外推的碰撞落點
    const foot = [Math.trunc((x1 + x2) / 2), Math.trunc(y2)];
    const hasTtc = ttcIsMeaningful(tr.ttcSec);
    const end = motionArrowEndpoint(foot[0], foot[1], tr.relativeVx, tr.relativeVy, hasTtc ? tr.predictedPoint : foot);
    if (end[0] !== foot[0] || end[1] !== foot[1]) arrow(ctx, foot, end, ARROW, 3);
    if (hasTtc) {
      const [px, py] = tr.predictedPoint;
      const hit = tr.inCollisionZone ? C.LEVEL_COLORS.RED : MUTED;
      ctx.strokeStyle = hit; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(...foot); ctx.lineTo(px, py); ctx.stroke();
      ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.stroke();
    }

    // 標籤晶片：距離等級＋類別＋佔畫面比例
    let label = `${C.PROXIMITY_TEXT[tr.proximityLevel]}｜${tr.label} ${Math.round(tr.occupancyRatio * 100)}%`;
    if (tr.speedLevel === "fast") label += "｜速度過快";
    chip(ctx, label, x1, y1 - 28, color, "#fff", 17);

    // 資訊列：只在物體有風險、正在移動或有 TTC 時顯示，避免畫面文字太擠
    if (tr.proximityLevel !== "GREEN" || tr.speedLevel !== "slow" || hasTtc) {
      const parts = [speedDescription(tr), `風險 ${Math.round(tr.collisionProbability)}%`];
      if (Number.isFinite(tr.distanceM)) parts.unshift(`約 ${tr.distanceM.toFixed(1)} m${tr.occluded ? "（遮擋）" : ""}`);
      if (hasTtc) parts.push(`TTC ${tr.ttcSec.toFixed(1)}s${tr.inCollisionZone ? "（路徑上）" : ""}`);
      const infoColor = tr.speedLevel !== "slow" ? C.LEVEL_COLORS[SPEED_LEVEL[tr.speedLevel]] : "#E8EDEC";
      chip(ctx, parts.join("  ·  "), x1, y2 + 4, "rgba(20,24,26,.82)", infoColor, 13);
    }
    if (C.DEBUG_PANEL) {
      chip(ctx, `id=${tr.trackId} blur=${Math.round(tr.blurScore)} elong=${tr.elongation.toFixed(1)}${tr.isPredicted ? " [PRED]" : ""}`,
        x1, y2 + 28, null, "#C8C8C8", 11);
    }
  }
}
