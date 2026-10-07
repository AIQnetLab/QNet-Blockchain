// QR code (ISO/IEC 18004) of a short text, for the receive screen: drawn in the page, so no remote
// service ever sees the address (EXT-08). Byte mode, error correction level M, versions 1-10 (up to
// 213 bytes): every QNet and Solana address fits, with a fraction of a general encoder's code.

// Level M per version: EC codewords per block, then [block count, data codewords per block] groups.
const BLOCKS_M = Object.freeze([
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
const ALIGNMENT_CENTERS = Object.freeze([
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
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed-Solomon generator polynomial of `degree`, coefficients highest power first (monic). */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/**
 * Reed-Solomon error-correction codewords of one block.
 * @param {number[]} data
 * @param {number} degree number of EC codewords
 * @returns {number[]}
 */
export function rsRemainder(data, degree) {
  const generator = rsGenerator(degree);
  const remainder = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) remainder[i] ^= gfMul(generator[i + 1], factor);
  }
  return remainder;
}

const dataCapacity = (version) => BLOCKS_M[version].slice(1).reduce((sum, [count, size]) => sum + count * size, 0);
const countBits = (version) => (version < 10 ? 8 : 16);

function encodeData(bytes, version) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);
  const capacity = dataCapacity(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  for (let pad = 0xec; out.length < capacity / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function interleave(data, version) {
  const [ecLength, ...groups] = BLOCKS_M[version];
  const blocks = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i += 1) {
      const block = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: block, ec: rsRemainder(block, ecLength) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < ecLength; i += 1) {
    for (const block of blocks) out.push(block.ec[i]);
  }
  return out;
}

const bitAt = (value, index) => ((value >>> index) & 1) === 1;

/**
 * The 15 format bits (level M, mask) with their BCH code and the standard XOR mask.
 * @param {number} mask 0..7
 * @returns {number}
 */
export function formatBits(mask) {
  const data = (FORMAT_ECC_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

function versionBits(version) {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

const MASKS = Object.freeze([
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]);

class Grid {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = new Uint8Array(this.size * this.size);
    this.fixed = new Uint8Array(this.size * this.size);
  }

  get(x, y) {
    return this.modules[y * this.size + x];
  }

  setFixed(x, y, dark) {
    this.modules[y * this.size + x] = dark ? 1 : 0;
    this.fixed[y * this.size + x] = 1;
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          this.setFixed(x, y, ring !== 2 && ring !== 4);
        }
      }
    }
    for (let i = 8; i < size - 8; i += 1) {
      this.setFixed(6, i, i % 2 === 0);
      this.setFixed(i, 6, i % 2 === 0);
    }
    const centers = ALIGNMENT_CENTERS[this.version];
    const last = centers.length - 1;
    centers.forEach((cy, row) => centers.forEach((cx, column) => {
      if ((row === 0 && column === 0) || (row === 0 && column === last) || (row === last && column === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) this.setFixed(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }));
    this.drawFormat(0); // reserves the format areas; redrawn once the mask is known
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i += 1) {
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.setFixed(a, b, bitAt(bits, i));
        this.setFixed(b, a, bitAt(bits, i));
      }
    }
  }

  drawFormat(mask) {
    const { size } = this;
    const bits = formatBits(mask);
    for (let i = 0; i <= 5; i += 1) this.setFixed(8, i, bitAt(bits, i));
    this.setFixed(8, 7, bitAt(bits, 6));
    this.setFixed(8, 8, bitAt(bits, 7));
    this.setFixed(7, 8, bitAt(bits, 8));
    for (let i = 9; i < 15; i += 1) this.setFixed(14 - i, 8, bitAt(bits, i));
    for (let i = 0; i < 8; i += 1) this.setFixed(size - 1 - i, 8, bitAt(bits, i));
    for (let i = 8; i < 15; i += 1) this.setFixed(8, size - 15 + i, bitAt(bits, i));
    this.setFixed(8, size - 8, true);
  }

  drawCodewords(codewords) {
    const { size } = this;
    let index = 0;
    const total = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let vert = 0; vert < size; vert += 1) {
        const y = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          if (this.fixed[y * size + x] || index >= total) continue;
          this.modules[y * size + x] = (codewords[index >>> 3] >>> (7 - (index & 7))) & 1;
          index += 1;
        }
      }
    }
  }

  applyMask(mask) {
    const test = MASKS[mask];
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        const at = y * this.size + x;
        if (!this.fixed[at] && test(x, y)) this.modules[at] ^= 1;
      }
    }
  }

  penalty() {
    const { size } = this;
    let result = 0;
    const addHistory = (length, history) => {
      history.pop();
      history.unshift(history[0] === 0 ? length + size : length);
    };
    const countPatterns = (history) => {
      const n = history[1];
      const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
      return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
    };
    const line = (read) => {
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
    for (let y = 0; y < size; y += 1) line((x) => this.get(x, y));
    for (let x = 0; x < size; x += 1) line((y) => this.get(x, y));
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const color = this.get(x, y);
        if (color === this.get(x + 1, y) && color === this.get(x, y + 1) && color === this.get(x + 1, y + 1)) result += PENALTY.N2;
      }
    }
    const dark = this.modules.reduce((sum, value) => sum + value, 0);
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * PENALTY.N4;
    return result;
  }
}

/**
 * The smallest level-M version (1..QR_MAX_VERSION) whose byte mode holds `length` bytes, or 0.
 * @param {number} length
 * @returns {number}
 */
export function qrVersionFor(length) {
  for (let version = 1; version <= QR_MAX_VERSION; version += 1) {
    if (4 + countBits(version) + length * 8 <= dataCapacity(version) * 8) return version;
  }
  return 0;
}

/**
 * The module matrix of `text` (UTF-8, byte mode, level M), row by row, 1 = dark; no quiet zone.
 * @param {string} text
 * @param {{mask?: number}} [options] a fixed mask 0..7; by default the one with the lowest penalty
 * @returns {{version: number, size: number, mask: number, modules: Uint8Array}}
 * @throws {RangeError} when the text does not fit version QR_MAX_VERSION
 */
export function qrMatrix(text, options = {}) {
  const bytes = new TextEncoder().encode(String(text));
  const version = qrVersionFor(bytes.length);
  if (version === 0) throw new RangeError('text too long for a QR code');
  const grid = new Grid(version);
  grid.drawFunctionPatterns();
  grid.drawCodewords(interleave(encodeData(bytes, version), version));
  let { mask } = options;
  if (mask === undefined) {
    let best = Infinity;
    for (let candidate = 0; candidate < MASKS.length; candidate += 1) {
      grid.applyMask(candidate);
      grid.drawFormat(candidate);
      const score = grid.penalty();
      if (score < best) {
        best = score;
        mask = candidate;
      }
      grid.applyMask(candidate);
    }
  } else if (!Number.isInteger(mask) || mask < 0 || mask >= MASKS.length) {
    throw new RangeError('mask must be 0..7');
  }
  grid.applyMask(mask);
  grid.drawFormat(mask);
  return { version, size: grid.size, mask, modules: grid.modules };
}
