// 開始畫面的 QR code：在電腦上打開網頁時，讓協助者用手機一掃就開。
// 自己產生、不連外部網站（離線也能用）。只做這裡需要的：位元組模式、錯誤修正 M 級、版本 1～10（最多約 210 個字元的網址）。
// 演算法依 ISO/IEC 18004，寫法參考 Project Nayuki 的 QR Code generator（MIT）。

const ECC_CODEWORDS_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];  // 每個區塊的錯誤修正碼字數，索引＝版本
const BLOCKS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = ver => Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_M[ver] * BLOCKS_M[ver];

// GF(256)，生成多項式 0x11D
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}
function rsRemainder(data, divisor) {
  const r = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ r.shift();
    r.push(0);
    divisor.forEach((c, i) => { r[i] ^= gfMul(c, factor); });
  }
  return r;
}

function encodeData(bytes, ver) {
  const bits = [];
  const put = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);                              // 位元組模式
  put(bytes.length, ver <= 9 ? 8 : 16);
  bytes.forEach(b => put(b, 8));
  const capacity = dataCodewords(ver) * 8;
  put(0, Math.min(4, capacity - bits.length)); // 結束符號
  put(0, (8 - bits.length % 8) % 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < dataCodewords(ver); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function addEccAndInterleave(data, ver) {
  const numBlocks = BLOCKS_M[ver], eccLen = ECC_CODEWORDS_M[ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - raw % numBlocks, shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => { if (i !== shortLen - eccLen || j >= numShort) out.push(block[i]); });
  }
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];

function buildMatrix(codewords, ver, mask) {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  if (ver >= 2) {
    const count = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < count; p -= step) pos.splice(1, 0, p);
    const last = pos.length - 1;
    pos.forEach((ay, i) => pos.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
  }

  // 格式資訊：錯誤修正 M 級＝00
  let rem = mask;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const format = ((mask << 10) | rem) ^ 0x5412;
  const bit = (v, i) => ((v >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(format, i));
  set(8, 7, bit(format, 6)); set(8, 8, bit(format, 7)); set(7, 8, bit(format, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(format, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(format, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(format, i));
  set(8, size - 8, true);

  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const v = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + i % 3, b = Math.floor(i / 3);
      set(a, b, bit(v, i)); set(b, a, bit(v, i));
    }
  }

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
      if (!fn[y][x] && i < codewords.length * 8) { m[y][x] = bit(codewords[i >>> 3], 7 - (i & 7)); i++; }
    }
  }
  const masked = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && masked(x, y)) m[y][x] = !m[y][x];
  return m;
}

// 標準的四項扣分，選最好掃的遮罩
function penalty(m) {
  const size = m.length;
  let score = 0, dark = 0;
  const line = get => {
    let s = 0, run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) { run++; continue; }
      if (run >= 5) s += run - 2;
      run = 1;
    }
    const str = Array.from({ length: size }, (_, i) => (get(i) ? "1" : "0")).join("");
    for (const pattern of ["10111010000", "00001011101"]) {
      for (let at = str.indexOf(pattern); at !== -1; at = str.indexOf(pattern, at + 1)) s += 40;
    }
    return s;
  };
  for (let k = 0; k < size; k++) { score += line(i => m[k][i]); score += line(i => m[i][k]); }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (m[y][x]) dark++;
    if (x < size - 1 && y < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  }
  score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
  return score;
}

// 傳回 QR code 的模組矩陣（true＝黑），網址太長時傳回 null。mask 可指定（測試用），不指定時自動挑選。
export function qrMatrix(text, mask) {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  while (ver <= MAX_VERSION && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
  if (ver > MAX_VERSION) return null;
  const codewords = addEccAndInterleave(encodeData(bytes, ver), ver);
  if (mask != null) return buildMatrix(codewords, ver, mask);
  let best = null, bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    const mtx = buildMatrix(codewords, ver, k), s = penalty(mtx);
    if (s < bestScore) { best = mtx; bestScore = s; }
  }
  return best;
}

// 畫成 SVG（四格白邊）：只用矩陣產生路徑，網址文字不會進到標記裡
export function qrSvg(text) {
  const m = qrMatrix(text);
  if (!m) return null;
  const n = m.length + 8;
  let d = "";
  m.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  const bg = document.createElementNS(svg.namespaceURI, "rect");
  bg.setAttribute("width", n); bg.setAttribute("height", n); bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", d); path.setAttribute("fill", "#000");
  svg.append(bg, path);
  return svg;
}
