/**
 * Solana transfers built byte by byte: a SOL transfer (System program) and a token transfer (Token program
 * TransferChecked), with the idempotent create of the recipient's associated token account before it when that account
 * does not exist yet, and a memo when a payment request asks for one. Legacy message format, one signer: the wallet,
 * which pays the fee. Pure: no network, no key, no storage. The wallet signs the message these functions return
 * (WalletManager.signSolanaMessage) and services/SolanaSend puts it on the wire.
 *
 * Message layout: header (required signatures, read-only signed, read-only unsigned), the account keys (compact-u16
 * count, 32 bytes each), the recent blockhash (32 bytes), then the instructions (compact-u16 count; each: program index,
 * compact-u16 account count and indexes, compact-u16 data length and data). Account order: the fee payer first, then
 * the other writable signers, read-only signers, writable accounts, read-only accounts, each group in the order the
 * instructions name them (program ids after every instruction's accounts). Any order within a group is valid; this one
 * is fixed so the same transfer always gives the same bytes.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// The largest serialized transaction a Solana node accepts.
export const PACKET_DATA_SIZE = 1232;
// The size of a token account of the Token program, which sets the rent its creation locks.
export const TOKEN_ACCOUNT_SIZE = 165;
export const SOL_DECIMALS = 9;

const U64_MAX = (1n << 64n) - 1n;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = Object.fromEntries([...B58].map((c, i) => [c, i]));
const PDA_MARKER = utf8ToBytes('ProgramDerivedAddress');

export function base58Encode(bytes) {
  const input = Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < input.length; i++) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

/** The bytes of a base58 text, or null when it is not base58. */
export function base58Decode(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 128) return null;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const bytes = [];
  for (const ch of text) {
    let carry = B58_INDEX[ch];
    if (carry === undefined) return null;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // The leading '1's are the zero bytes; the loop above also counted them as value zero, which added nothing.
  const out = new Uint8Array(zeros + bytes.length);
  bytes.reverse().forEach((b, i) => { out[zeros + i] = b; });
  return out;
}

/** The 32 bytes of a Solana address (a public key, a program id or a blockhash), or null. */
export function decodeKey(text) {
  const bytes = base58Decode(text);
  return bytes && bytes.length === 32 && base58Encode(bytes) === text ? bytes : null;
}

function key(text) {
  const bytes = decodeKey(text);
  if (!bytes) throw new TypeError('invalid Solana address');
  return bytes;
}

/** Whether 32 bytes are a point of the Ed25519 curve: an address a key controls, as opposed to a program address. */
export function isOnCurve(bytes) {
  try {
    ed25519.Point.fromHex(bytes);
    return true;
  } catch (_) {
    return false;
  }
}

export const isWalletAddress = (text) => {
  const bytes = decodeKey(text);
  return !!bytes && isOnCurve(bytes);
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** The program address of `seeds` under `programId`: the first bump from 255 down whose hash is off the curve. */
export function findProgramAddress(seeds, programId) {
  if (seeds.some((s) => s.length > 32)) throw new TypeError('seed longer than 32 bytes');
  const program = key(programId);
  for (let bump = 255; bump > 0; bump--) {
    const candidate = sha256(concat(...seeds, Uint8Array.of(bump), program, PDA_MARKER));
    if (!isOnCurve(candidate)) return { address: base58Encode(candidate), bump };
  }
  throw new Error('no program address');
}

/** The associated token account of `owner` for `mint`. */
export function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM_ID) {
  return findProgramAddress([key(owner), key(tokenProgram), key(mint)], ASSOCIATED_TOKEN_PROGRAM_ID).address;
}

function u32le(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError('u32 out of range');
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

function u64le(value) {
  const v = BigInt(value);
  if (v < 0n || v > U64_MAX) throw new RangeError('u64 out of range');
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return out;
}

const readonlyKeys = (keys) => (keys || []).map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));

/** System program Transfer (instruction 2): [from (signer, writable), to (writable)], then any reference keys. */
export function systemTransfer(from, to, lamports, references = []) {
  return {
    programId: SYSTEM_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      ...readonlyKeys(references),
    ],
    data: concat(u32le(2), u64le(lamports)),
  };
}

/** Associated Token Account program CreateIdempotent (instruction 1): does nothing when the account exists. */
export function createAssociatedTokenAccountIdempotent(payer, ata, owner, mint, tokenProgram = TOKEN_PROGRAM_ID) {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1),
  };
}

/**
 * Token program TransferChecked (instruction 12): [source (writable), mint, destination (writable), owner (signer)],
 * then any reference keys; data: 12, the amount in base units (u64 LE), the mint's decimals. The program refuses it
 * when the decimals are not the mint's.
 */
export function tokenTransferChecked(source, mint, destination, owner, amount, decimals, references = [], tokenProgram = TOKEN_PROGRAM_ID) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError('decimals out of range');
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      ...readonlyKeys(references),
    ],
    data: concat(Uint8Array.of(12), u64le(amount), Uint8Array.of(decimals)),
  };
}

/** A memo (Memo program), with no signer listed: its text as UTF-8. */
export function memoInstruction(text) {
  return { programId: MEMO_PROGRAM_ID, keys: [], data: utf8ToBytes(String(text)) };
}

function compactU16(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError('compact-u16 out of range');
  const out = [];
  let rest = n;
  for (;;) {
    const low = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(low);
      return out;
    }
    out.push(low | 0x80);
  }
}

/** The legacy message of `instructions`, paid for by `feePayer`, at `recentBlockhash`. */
export function compileMessage(instructions, feePayer, recentBlockhash) {
  if (!Array.isArray(instructions) || instructions.length === 0) throw new Error('no instructions');
  const blockhash = key(recentBlockhash);
  key(feePayer);

  const metas = [{ pubkey: feePayer, isSigner: true, isWritable: true }];
  for (const ix of instructions) for (const k of ix.keys) metas.push(k);
  for (const ix of instructions) metas.push({ pubkey: ix.programId, isSigner: false, isWritable: false });
  const merged = [];
  for (const m of metas) {
    key(m.pubkey);
    const seen = merged.find((u) => u.pubkey === m.pubkey);
    if (seen) {
      seen.isSigner = seen.isSigner || m.isSigner;
      seen.isWritable = seen.isWritable || m.isWritable;
    } else {
      merged.push({ ...m });
    }
  }
  const group = (signer, writable) => merged.filter((m) => m.isSigner === signer && m.isWritable === writable);
  const payer = merged[0];
  const ordered = [
    payer,
    ...group(true, true).filter((m) => m !== payer),
    ...group(true, false),
    ...group(false, true),
    ...group(false, false),
  ];
  const signers = ordered.filter((m) => m.isSigner);
  const header = [
    signers.length,
    signers.filter((m) => !m.isWritable).length,
    ordered.filter((m) => !m.isSigner && !m.isWritable).length,
  ];
  const index = (pubkey) => ordered.findIndex((m) => m.pubkey === pubkey);

  const ixBytes = [...compactU16(instructions.length)];
  for (const ix of instructions) {
    ixBytes.push(index(ix.programId), ...compactU16(ix.keys.length), ...ix.keys.map((k) => index(k.pubkey)));
    ixBytes.push(...compactU16(ix.data.length), ...ix.data);
  }
  return concat(
    Uint8Array.from([...header, ...compactU16(ordered.length)]),
    ...ordered.map((m) => key(m.pubkey)),
    blockhash,
    Uint8Array.from(ixBytes),
  );
}

/** The wire form of a message its one signer, the fee payer, signed: one signature, then the message. */
export function serializeTransaction(signature, message) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('signature length');
  if (!(message instanceof Uint8Array) || message[0] !== 1) throw new Error('the fee payer must be the only signer');
  const wire = concat(Uint8Array.of(1), signature, message);
  if (wire.length > PACKET_DATA_SIZE) throw new Error('transaction too large');
  return wire;
}

/** The fee payer a legacy message names (its first account), or null when it is not a one-signer legacy message. */
export function messageFeePayer(message) {
  if (!(message instanceof Uint8Array) || message.length < 4 + 32 + 32 || message[0] !== 1) return null;
  // Fewer than 128 accounts: the count is one byte.
  if (message[3] & 0x80 || message[3] < 1) return null;
  return base58Encode(message.subarray(4, 36));
}

// ── Amounts ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An amount typed or read in whole units ("1.5") as base units (BigInt), scaled by `decimals`. Throws code
 * INVALID_AMOUNT for anything that is not a plain positive decimal and AMOUNT_DECIMALS for more decimal places than the
 * token has. No float is ever involved.
 */
export function toBaseUnits(text, decimals) {
  const s = String(text == null ? '' : text).trim();
  const m = /^(\d{1,20})(?:\.(\d{1,64}))?$/.exec(s);
  if (!m) throw Object.assign(new Error('Amount must be a valid positive number'), { code: 'INVALID_AMOUNT' });
  const frac = (m[2] || '').replace(/0+$/, '');
  if (frac.length > decimals) {
    throw Object.assign(new Error(`At most ${decimals} decimal places`), { code: 'AMOUNT_DECIMALS', params: { decimals } });
  }
  const base = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((frac || '0').padEnd(decimals, '0') || '0');
  if (base <= 0n) throw Object.assign(new Error('Amount must be a valid positive number'), { code: 'INVALID_AMOUNT' });
  if (base > U64_MAX) throw Object.assign(new Error('Amount too large'), { code: 'INVALID_AMOUNT' });
  return base;
}

/** Base units as whole units, with no trailing zeros: 1500000000n, 9 → "1.5". */
export function fromBaseUnits(base, decimals) {
  const v = BigInt(base);
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

// ── Whole transfers ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The instructions of one transfer. `plan`:
 *   SOL:   { kind: 'sol', from, to, amount (lamports), references?, memo? }
 *   token: { kind: 'token', from, to (the recipient's wallet address), mint, decimals, amount (base units), source
 *            (the sender's token account), destination (the recipient's associated token account), createDestination,
 *            tokenProgram?, references?, memo? }
 * The memo, when there is one, comes right before the transfer; the account create before both.
 */
export function transferInstructions(plan) {
  const out = [];
  const refs = plan.references || [];
  if (plan.kind === 'sol') {
    if (plan.memo) out.push(memoInstruction(plan.memo));
    out.push(systemTransfer(plan.from, plan.to, plan.amount, refs));
    return out;
  }
  if (plan.kind !== 'token') throw new Error('unknown transfer kind');
  const program = plan.tokenProgram || TOKEN_PROGRAM_ID;
  if (plan.createDestination) {
    out.push(createAssociatedTokenAccountIdempotent(plan.from, plan.destination, plan.to, plan.mint, program));
  }
  if (plan.memo) out.push(memoInstruction(plan.memo));
  out.push(tokenTransferChecked(plan.source, plan.mint, plan.destination, plan.from, plan.amount, plan.decimals, refs, program));
  return out;
}

/** The message of one transfer at `recentBlockhash` (see transferInstructions). */
export function transferMessage(plan, recentBlockhash) {
  return compileMessage(transferInstructions(plan), plan.from, recentBlockhash);
}
