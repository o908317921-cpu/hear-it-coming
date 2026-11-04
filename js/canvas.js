// 舊版 iPhone（iOS 16.4 以前）沒有 OffscreenCanvas，改用一般的 canvas；少了它整個辨識都啟動不了
export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}
