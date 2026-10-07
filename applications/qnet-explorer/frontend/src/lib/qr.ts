// QR code (ISO/IEC 18004) of a short text, drawn in the page so no remote service sees it. Vendored from
// the extension's encoder (applications/qnet-wallet/dist/ui/qr.js): the same tables and steps, typed,
// plus qrPath for SVG; src/lib/__tests__/qr.test.mjs checks this copy against that encoder's reference
// fixture. Byte mode, error correction level M, versions 1-10 (up to 213 bytes).

// Level M per version: EC codewords per block, then [block count, data codewords per block] groups.
type BlockSpec = [number, ...[number, number][]];
const BLOCKS_M: readonly (BlockSpec | null)[] = Object.freeze([
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
]);
const ALIGNMENT_CENTERS: readonly (readonly number[] | null)[] = Object.freeze([
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]);
export const QR_MAX_VERSION = 10;
const FORMAT_ECC_M = 0b00;
const PENALTY = Object.freeze({ N1: 3, N2: 3, N3: 40, N4: 10 });

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}
const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// Reed-Solomon generator polynomial of `degree`, coefficients highest power first (monic).
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

// Reed-Solomon error-correction codewords of one block.
export function rsRemainder(data: number[], degree: number): number[] {
  const generator = rsGenerator(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() as number);
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) remainder[i] ^= gfMul(generator[i + 1], factor);
  }
  return remainder;
}

const blocks = (version: number): BlockSpec => BLOCKS_M[version] as BlockSpec;
const dataCapacity = (version: number): number =>
  (blocks(version).slice(1) as [number, number][]).reduce((sum, [count, size]) => sum + count * size, 0);
const countBits = (version: number): number => (version < 10 ? 8 : 16);

function encodeData(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);
  const capacity = dataCapacity(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  for (let pad = 0xec; out.length < capacity / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function interleave(data: number[], version: number): number[] {
  const [ecLength, ...groups] = blocks(version);
  const all: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i += 1) {
      const block = data.slice(offset, offset + size);
      offset += size;
      all.push({ data: block, ec: rsRemainder(block, ecLength) });
    }
  }
  const out: number[] = [];
  const longest = Math.max(...all.map((block) => block.data.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of all) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < ecLength; i += 1) {
    for (const block of all) out.push(block.ec[i]);
  }
  return out;
}

const bitAt = (value: number, index: number): boolean => ((value >>> index) & 1) === 1;

// The 15 format bits (level M, mask) with their BCH code and the standard XOR mask.
export function formatBits(mask: number): number {
  const data = (FORMAT_ECC_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = Object.freeze([
  (x: number, y: number) => (x + y) % 2 === 0,
  (_x: number, y: number) => y % 2 === 0,
  (x: number) => x % 3 === 0,
  (x: number, y: number) => (x + y) % 3 === 0,
  (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]);

interface Grid {
  version: number;
  size: number;
  modules: Uint8Array;
  fixed: Uint8Array;
}

function newGrid(version: number): Grid {
  const size = version * 4 + 17;
  return { version, size, modules: new Uint8Array(size * size), fixed: new Uint8Array(size * size) };
}

const get = (g: Grid, x: number, y: number): number => g.modules[y * g.size + x];

function setFixed(g: Grid, x: number, y: number, dark: boolean): void {
  g.modules[y * g.size + x] = dark ? 1 : 0;
  g.fixed[y * g.size + x] = 1;
}

function drawFunctionPatterns(g: Grid): void {
  const { size } = g;
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        setFixed(g, x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    setFixed(g, 6, i, i % 2 === 0);
    setFixed(g, i, 6, i % 2 === 0);
  }
  const centers = ALIGNMENT_CENTERS[g.version] as readonly number[];
  const last = centers.length - 1;
  centers.forEach((cy, row) => centers.forEach((cx, column) => {
    if ((row === 0 && column === 0) || (row === 0 && column === last) || (row === last && column === 0)) return;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) setFixed(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }));
  drawFormat(g, 0); // reserves the format areas; redrawn once the mask is known
  if (g.version >= 7) {
    const bits = versionBits(g.version);
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFixed(g, a, b, bitAt(bits, i));
      setFixed(g, b, a, bitAt(bits, i));
    }
  }
}

function drawFormat(g: Grid, mask: number): void {
  const { size } = g;
  const bits = formatBits(mask);
  for (let i = 0; i <= 5; i += 1) setFixed(g, 8, i, bitAt(bits, i));
  setFixed(g, 8, 7, bitAt(bits, 6));
  setFixed(g, 8, 8, bitAt(bits, 7));
  setFixed(g, 7, 8, bitAt(bits, 8));
  for (let i = 9; i < 15; i += 1) setFixed(g, 14 - i, 8, bitAt(bits, i));
  for (let i = 0; i < 8; i += 1) setFixed(g, size - 1 - i, 8, bitAt(bits, i));
  for (let i = 8; i < 15; i += 1) setFixed(g, 8, size - 15 + i, bitAt(bits, i));
  setFixed(g, 8, size - 8, true);
}

function drawCodewords(g: Grid, codewords: number[]): void {
  const { size } = g;
  let index = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        if (g.fixed[y * size + x] || index >= total) continue;
        g.modules[y * size + x] = (codewords[index >>> 3] >>> (7 - (index & 7))) & 1;
        index += 1;
      }
    }
  }
}

function applyMask(g: Grid, mask: number): void {
  const test = MASKS[mask];
  for (let y = 0; y < g.size; y += 1) {
    for (let x = 0; x < g.size; x += 1) {
      const at = y * g.size + x;
      if (!g.fixed[at] && test(x, y)) g.modules[at] ^= 1;
    }
  }
}

function penalty(g: Grid): number {
  const { size } = g;
  let result = 0;
  const addHistory = (length: number, history: number[]) => {
    history.pop();
    history.unshift(history[0] === 0 ? length + size : length);
  };
  const countPatterns = (history: number[]) => {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
  };
  const line = (read: (i: number) => number) => {
    let runColor = 0;
    let run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < size; i += 1) {
      const color = read(i);
      if (color === runColor) {
        run += 1;
        if (run === 5) result += PENALTY.N1;
        else if (run > 5) result += 1;
      } else {
        addHistory(run, history);
        if (runColor === 0) result += countPatterns(history) * PENALTY.N3;
        runColor = color;
        run = 1;
      }
    }
    if (runColor === 1) {
      addHistory(run, history);
      run = 0;
    }
    addHistory(run + size, history);
    result += countPatterns(history) * PENALTY.N3;
  };
  for (let y = 0; y < size; y += 1) line((x) => get(g, x, y));
  for (let x = 0; x < size; x += 1) line((y) => get(g, x, y));
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = get(g, x, y);
      if (color === get(g, x + 1, y) && color === get(g, x, y + 1) && color === get(g, x + 1, y + 1)) result += PENALTY.N2;
    }
  }
  const dark = g.modules.reduce((sum, value) => sum + value, 0);
  const total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * PENALTY.N4;
  return result;
}

// The smallest level-M version (1..QR_MAX_VERSION) whose byte mode holds `length` bytes, or 0.
export function qrVersionFor(length: number): number {
  for (let version = 1; version <= QR_MAX_VERSION; version += 1) {
    if (4 + countBits(version) + length * 8 <= dataCapacity(version) * 8) return version;
  }
  return 0;
}

export interface QrMatrix {
  version: number;
  size: number;
  mask: number;
  modules: Uint8Array;
}

// The module matrix of `text` (UTF-8, byte mode, level M), row by row, 1 = dark; no quiet zone.
// `mask` fixes the mask (0..7); by default the one with the lowest penalty. Throws RangeError when the
// text does not fit version QR_MAX_VERSION.
export function qrMatrix(text: string, options: { mask?: number } = {}): QrMatrix {
  const bytes = new TextEncoder().encode(String(text));
  const version = qrVersionFor(bytes.length);
  if (version === 0) throw new RangeError('text too long for a QR code');
  const grid = newGrid(version);
  drawFunctionPatterns(grid);
  drawCodewords(grid, interleave(encodeData(bytes, version), version));
  let { mask } = options;
  if (mask === undefined) {
    let best = Infinity;
    for (let candidate = 0; candidate < MASKS.length; candidate += 1) {
      applyMask(grid, candidate);
      drawFormat(grid, candidate);
      const score = penalty(grid);
      if (score < best) {
        best = score;
        mask = candidate;
      }
      applyMask(grid, candidate);
    }
  } else if (!Number.isInteger(mask) || mask < 0 || mask >= MASKS.length) {
    throw new RangeError('mask must be 0..7');
  }
  const chosen = mask as number;
  applyMask(grid, chosen);
  drawFormat(grid, chosen);
  return { version, size: grid.size, mask: chosen, modules: grid.modules };
}

// The dark modules as one SVG path in module units (numbers and fixed letters only), offset by the
// quiet zone, for <path d={...}> in a viewBox of size + 2 * quiet.
export function qrPath(matrix: QrMatrix, quiet = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.modules[y * matrix.size + x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }
  return parts.join('');
}
