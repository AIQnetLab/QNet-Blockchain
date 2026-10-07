// A strict JSON reader for node answers the site checks against a proof, the same rules as the wallets' reader
// (applications/qnet-mobile/src/utils/strictJson.js). JSON.parse keeps the last of two equal keys and rounds a u64
// above 2^53, so the value a proof is verified over and the value shown could come from different places in one
// answer. This reader refuses a repeated key at any depth and keeps every integer literal that is not a safe integer
// as its exact decimal text.

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictJsonError';
  }
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STRING_STOP = /["\\\u0000-\u001f]/g;
const MAX_DEPTH = 64;
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** The value of `text`; throws StrictJsonError on anything that is not exactly one strict JSON value. */
export function parseStrictJson(text: string): unknown {
  if (typeof text !== 'string') throw new StrictJsonError('not text');
  let i = 0;
  const fail = (why: string): never => { throw new StrictJsonError(`${why} at ${i}`); };
  const skip = () => { while (i < text.length && WS.has(text.charCodeAt(i))) i++; };

  const readString = (): string => {
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
        if (!(e in ESCAPES)) fail('bad escape');
        out += ESCAPES[e];
        i += 2;
        continue;
      }
      // A run of plain characters is copied at once: a proof carries long hex and base64 strings.
      STRING_STOP.lastIndex = i;
      const stop = STRING_STOP.exec(text);
      const j = stop ? stop.index : text.length;
      out += text.slice(i, j);
      i = j;
    }
  };

  const readNumber = (): number | string => {
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(text);
    if (!m || m.index !== i) return fail('bad number');
    i += m[0].length;
    const lexeme = m[0];
    if (/^-?\d+$/.test(lexeme)) {
      const n = Number(lexeme);
      return Number.isSafeInteger(n) ? n : lexeme.replace(/^-0$/, '0');
    }
    return Number(lexeme);
  };

  const readValue = (depth: number): unknown => {
    if (depth > MAX_DEPTH) fail('too deep');
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const out: Record<string, unknown> = {};
      const seen = new Set<string>();
      skip();
      if (text[i] === '}') { i++; return out; }
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
        // A "__proto__" key stays data, never a prototype.
        Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return out; }
        fail('expected , or }');
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
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

/** A u64 as its exact decimal text (a safe integer, a decimal string or a larger literal), or null. */
export function u64Text(value: unknown): string | null {
  let s: string;
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

export const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
