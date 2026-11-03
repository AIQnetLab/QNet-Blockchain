// Byte encodings the vector tools share, with no dependency: base58, as Solana writes addresses, keys and signatures, and
// the PKCS #8 envelope of an Ed25519 seed (RFC 8410), which node:crypto takes as a private key.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

// Bytes as base58: the number they spell, then a '1' for each leading zero byte.
export function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

// Base58 back to bytes; with `length`, text of any other length is refused.
export function unbase58(text, length = null) {
  let n = 0n;
  for (const c of text) {
    const digit = B58.indexOf(c);
    if (digit < 0) throw new Error(`not base58: ${text}`);
    n = n * 58n + BigInt(digit);
  }
  const digits = n.toString(16);
  const body = n === 0n ? [] : [...Buffer.from(digits.padStart(Math.ceil(digits.length / 2) * 2, '0'), 'hex')];
  const zeros = text.length - text.replace(/^1+/, '').length;
  const out = Buffer.from([...Array(zeros).fill(0), ...body]);
  if (length !== null && out.length !== length) throw new Error(`not ${length} bytes: ${text}`);
  return out;
}

// A 32-byte Ed25519 seed as the DER of its PKCS #8 private key.
export const ed25519Pkcs8 = (seed) => Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]);
