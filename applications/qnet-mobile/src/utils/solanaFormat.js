// Shapes of Solana values the wallet checks before it uses them. Pure, no I/O.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Decoded byte length of a base58 string, or -1 when it is not base58.
function base58Length(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 100) return -1;
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return -1;
    n = n * 58n + BigInt(v);
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  let bytes = 0;
  while (n > 0n) { n >>= 8n; bytes++; }
  return zeros + bytes;
}

/** A Solana transaction signature: base58 of exactly 64 bytes. */
export const isSolanaSignature = (s) => base58Length(s) === 64;

/** A Solana account address: base58 of exactly 32 bytes. */
export const isSolanaAddress = (s) => base58Length(s) === 32;
