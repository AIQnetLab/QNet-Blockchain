/**
 * A strict JSON reader for answers the wallet checks against a proof.
 *
 * JSON.parse keeps the last of two equal keys and turns a u64 above 2^53 into a rounded double, so the value a
 * proof is verified over and the value the screen shows can come from different places in one answer. This
 * reader refuses an object with a repeated key at any depth, and keeps every integer literal that is not a safe
 * integer as its exact decimal text. Everything else is plain JSON (RFC 8259); nothing after the value is allowed.
 */

export class StrictJsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StrictJsonError';
  }
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const MAX_DEPTH = 64;

/** The value of `text`; throws StrictJsonError on anything that is not exactly one strict JSON value. */
export function parseStrictJson(text) {
  if (typeof text !== 'string') throw new StrictJsonError('not text');
  let i = 0;

  const fail = (why) => { throw new StrictJsonError(`${why} at ${i}`); };
  const skip = () => { while (i < text.length && WS.has(text.charCodeAt(i))) i++; };

  const readString = () => {
    // text[i] is the opening quote
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) { i++; return out; }
      if (c < 0x20) fail('control character in string');
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!(e in map)) fail('bad escape');
        out += map[e];
        i += 2;
        continue;
      }
      out += text[i];
      i++;
    }
  };

  const readNumber = () => {
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(text);
    if (!m || m.index !== i) fail('bad number');
    i += m[0].length;
    const lexeme = m[0];
    if (/^-?\d+$/.test(lexeme)) {
      const n = Number(lexeme);
      return Number.isSafeInteger(n) ? n : lexeme.replace(/^-0$/, '0');
    }
    return Number(lexeme);
  };

  const readValue = (depth) => {
    if (depth > MAX_DEPTH) fail('too deep');
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj = Object.create(null);
      const seen = new Set();
      skip();
      if (text[i] === '}') { i++; return Object.assign({}, obj); }
      for (;;) {
        skip();
        if (text[i] !== '"') fail('expected key');
        const key = readString();
        if (seen.has(key)) fail(`repeated key "${key}"`);
        seen.add(key);
        skip();
        if (text[i] !== ':') fail('expected colon');
        i++;
        const value = readValue(depth + 1);
        Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        fail('expected , or }');
      }
      // A plain object (with Object.prototype) that carries own "__proto__" keys as data, never as a prototype.
      const out = {};
      for (const k of Object.keys(obj)) Object.defineProperty(out, k, { value: obj[k], enumerable: true, writable: true, configurable: true });
      return out;
    }
    if (c === '[') {
      i++;
      const arr = [];
      skip();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(readValue(depth + 1));
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        fail('expected , or ]');
      }
    }
    if (c === '"') return readString();
    if (c === '-' || (c >= '0' && c <= '9')) return readNumber();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    return fail('unexpected character');
  };

  const value = readValue(0);
  skip();
  if (i !== text.length) fail('trailing data');
  return value;
}

/**
 * A u64 field read by parseStrictJson as its exact decimal text, or null: a non-negative safe integer, a
 * decimal string, or the exact text of a larger integer literal. Anything else (a float, a sign, a missing
 * field, a value above 2^64 - 1) is null.
 */
export function u64Text(value) {
  let s;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    s = String(value);
  } else if (typeof value === 'string') {
    s = value;
  } else {
    return null;
  }
  if (!/^(0|[1-9]\d{0,19})$/.test(s)) return null;
  return BigInt(s) <= 0xffffffffffffffffn ? s : null;
}
