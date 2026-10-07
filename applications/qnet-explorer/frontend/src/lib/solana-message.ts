// Legacy Solana messages without @solana/web3.js or @solana/spl-token, shared by the faucet (src/server/solana-tx.ts
// signs with its key) and the node cabinet (src/lib/cabinet/burn-tx.ts, signed in the browser by the payment key;
// src/server/cabinet/solana-proxy.ts reads them back before it forwards one). Instructions: Compute Budget, System
// transfer, SPL Token transfer, burn and close, the idempotent Associated Token Account create and Memo. Account
// order, message and wire bytes equal what those libraries build (src/lib/__tests__/solana-tx.test.mjs and
// cabinet-burn-tx.test.mjs check the vectors they generated). No network access and no node: or browser-only API.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import bs58 from 'bs58';

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// The largest serialized transaction a Solana node accepts (IPv6 MTU minus headers).
export const PACKET_DATA_SIZE = 1232;
const U64_MAX = (1n << 64n) - 1n;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

export interface AccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: string;
  keys: AccountMeta[];
  data: Uint8Array;
}

// A base58 string that decodes to exactly 32 bytes (a public key, a program id or a blockhash); null otherwise.
export function decodeKey(text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || !BASE58_RE.test(text)) return null;
  try {
    const bytes = bs58.decode(text);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function key(text: string): Uint8Array {
  const bytes = decodeKey(text);
  if (!bytes) throw new TypeError('invalid public key');
  return bytes;
}

export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

// findProgramAddressSync: the first bump from 255 down to 1 whose address is off the curve.
export function findProgramAddress(seeds: Uint8Array[], programId: string): { address: string; bump: number } {
  if (seeds.some((s) => s.length > 32)) throw new TypeError('seed longer than 32 bytes');
  const program = key(programId);
  for (let bump = 255; bump > 0; bump -= 1) {
    const candidate = sha256(concat(...seeds, Uint8Array.of(bump), program, PDA_MARKER));
    if (!isOnCurve(candidate)) return { address: bs58.encode(candidate), bump };
  }
  throw new Error('no viable program address');
}

export function associatedTokenAddress(mint: string, owner: string): string {
  return findProgramAddress([key(owner), key(TOKEN_PROGRAM_ID), key(mint)], ASSOCIATED_TOKEN_PROGRAM_ID).address;
}

function u32le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('u32 out of range');
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > U64_MAX) throw new RangeError('u64 out of range');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function setComputeUnitPrice(microLamports: bigint): Instruction {
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: concat(Uint8Array.of(3), u64le(microLamports)) };
}

export function setComputeUnitLimit(units: number): Instruction {
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: concat(Uint8Array.of(2), u32le(units)) };
}

export function systemTransfer(from: string, to: string, lamports: bigint): Instruction {
  return {
    programId: SYSTEM_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data: concat(u32le(2), u64le(lamports)),
  };
}

export function createAssociatedTokenAccountIdempotent(payer: string, ata: string, owner: string, mint: string): Instruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1),
  };
}

export function tokenTransfer(source: string, destination: string, owner: string, amount: bigint): Instruction {
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: concat(Uint8Array.of(3), u64le(amount)),
  };
}

// SPL Token Burn (instruction 8, as the extension and the app burn): [account(w), mint(w), authority(signer)].
export function tokenBurn(account: string, mint: string, authority: string, amount: bigint): Instruction {
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: concat(Uint8Array.of(8), u64le(amount)),
  };
}

// SPL Token CloseAccount (instruction 9): [account(w), destination(w), owner(signer)].
export function tokenCloseAccount(account: string, destination: string, owner: string): Instruction {
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Uint8Array.of(9),
  };
}

// SPL Memo with its signer listed, so the memo is bound to that key.
export function memo(text: string, signer: string): Instruction {
  return { programId: MEMO_PROGRAM_ID, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: new TextEncoder().encode(text) };
}

function shortVec(n: number): number[] {
  const out: number[] = [];
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

// web3.js Transaction.compileMessage order: signers first, then writable, then by base58 string ('en'
// collation, lowercase first); the fee payer moves to the front as a writable signer.
const COLLATION: Intl.CollatorOptions = {
  localeMatcher: 'best fit',
  usage: 'sort',
  sensitivity: 'variant',
  ignorePunctuation: false,
  numeric: false,
  caseFirst: 'lower',
};

export function compileLegacyMessage(instructions: Instruction[], feePayer: string, recentBlockhash: string): Uint8Array {
  if (instructions.length === 0) throw new Error('no instructions');
  const blockhash = key(recentBlockhash);
  key(feePayer);
  const metas: AccountMeta[] = [];
  const programs: string[] = [];
  for (const ix of instructions) {
    for (const k of ix.keys) metas.push({ ...k });
    if (!programs.includes(ix.programId)) programs.push(ix.programId);
  }
  for (const p of programs) metas.push({ pubkey: p, isSigner: false, isWritable: false });

  const unique: AccountMeta[] = [];
  for (const m of metas) {
    key(m.pubkey);
    const seen = unique.find((u) => u.pubkey === m.pubkey);
    if (seen) {
      seen.isWritable = seen.isWritable || m.isWritable;
      seen.isSigner = seen.isSigner || m.isSigner;
    } else {
      unique.push(m);
    }
  }
  unique.sort((x, y) => {
    if (x.isSigner !== y.isSigner) return x.isSigner ? -1 : 1;
    if (x.isWritable !== y.isWritable) return x.isWritable ? -1 : 1;
    return x.pubkey.localeCompare(y.pubkey, 'en', COLLATION);
  });
  const payerAt = unique.findIndex((m) => m.pubkey === feePayer);
  if (payerAt > -1) unique.splice(payerAt, 1);
  unique.unshift({ pubkey: feePayer, isSigner: true, isWritable: true });

  const signed = unique.filter((m) => m.isSigner);
  const unsigned = unique.filter((m) => !m.isSigner);
  const accounts = [...signed, ...unsigned].map((m) => m.pubkey);
  const index = (pubkey: string): number => accounts.indexOf(pubkey);

  const header = [signed.length, signed.filter((m) => !m.isWritable).length, unsigned.filter((m) => !m.isWritable).length];
  const body: number[] = [...header, ...shortVec(accounts.length)];
  const parts: Uint8Array[] = [Uint8Array.from(body), ...accounts.map(key), blockhash];
  const ixBytes: number[] = [...shortVec(instructions.length)];
  for (const ix of instructions) {
    ixBytes.push(index(ix.programId), ...shortVec(ix.keys.length), ...ix.keys.map((k) => index(k.pubkey)));
    ixBytes.push(...shortVec(ix.data.length), ...ix.data);
  }
  parts.push(Uint8Array.from(ixBytes));
  return concat(...parts);
}

// The wire form of a message signed by its one signer, the fee payer.
export function singleSignerWire(signature: Uint8Array, message: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error('signature length');
  if (message[0] !== 1) throw new Error('the fee payer must be the only signer');
  const wire = concat(Uint8Array.from(shortVec(1)), signature, message);
  if (wire.length > PACKET_DATA_SIZE) throw new Error('transaction too large');
  return wire;
}

// ---------------------------------------------------------------- reading a transaction back

export interface ParsedInstruction {
  programId: string;
  accounts: AccountMeta[];
  data: Uint8Array;
}

export interface ParsedTransaction {
  signatures: Uint8Array[];
  message: Uint8Array;
  feePayer: string;
  signers: string[];
  blockhash: string;
  instructions: ParsedInstruction[];
}

// A cursor over bytes; every read past the end throws.
function reader(bytes: Uint8Array) {
  let at = 0;
  const take = (n: number): Uint8Array => {
    if (n < 0 || at + n > bytes.length) throw new Error('truncated');
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };
  const byte = (): number => take(1)[0];
  const shortVecValue = (): number => {
    let value = 0;
    for (let i = 0; i < 3; i += 1) {
      const b = byte();
      value |= (b & 0x7f) << (7 * i);
      if ((b & 0x80) === 0) {
        // The shortest form only, as the runtime requires.
        if (i > 0 && b === 0) throw new Error('shortvec');
        return value;
      }
    }
    throw new Error('shortvec');
  };
  return { take, byte, shortVec: shortVecValue, offset: () => at, done: () => at === bytes.length };
}

// A legacy transaction's wire bytes read back: signatures, the message, its accounts with their roles, and its
// instructions. Null for anything else (a versioned message, trailing bytes, an index out of range, too long).
export function parseLegacyTransaction(wire: Uint8Array): ParsedTransaction | null {
  if (!(wire instanceof Uint8Array) || wire.length > PACKET_DATA_SIZE) return null;
  try {
    const r = reader(wire);
    const sigCount = r.shortVec();
    const signatures: Uint8Array[] = [];
    for (let i = 0; i < sigCount; i += 1) signatures.push(r.take(64));
    const messageStart = r.offset();
    const [required, readonlySigned, readonlyUnsigned] = [r.byte(), r.byte(), r.byte()];
    // A versioned message starts with the 0x80 bit set.
    if (required & 0x80 || required === 0 || required !== sigCount) return null;
    const accountCount = r.shortVec();
    if (accountCount < required || readonlySigned >= required || readonlyUnsigned > accountCount - required) return null;
    const accounts: AccountMeta[] = [];
    for (let i = 0; i < accountCount; i += 1) {
      const isSigner = i < required;
      const isWritable = isSigner ? i < required - readonlySigned : i < accountCount - readonlyUnsigned;
      accounts.push({ pubkey: bs58.encode(r.take(32)), isSigner, isWritable });
    }
    if (new Set(accounts.map((a) => a.pubkey)).size !== accounts.length) return null;
    const blockhash = bs58.encode(r.take(32));
    const count = r.shortVec();
    const instructions: ParsedInstruction[] = [];
    for (let i = 0; i < count; i += 1) {
      const programIndex = r.byte();
      if (programIndex >= accountCount) return null;
      const keyCount = r.shortVec();
      const metas: AccountMeta[] = [];
      for (let k = 0; k < keyCount; k += 1) {
        const at = r.byte();
        if (at >= accountCount) return null;
        metas.push({ ...accounts[at] });
      }
      const data = r.take(r.shortVec()).slice();
      instructions.push({ programId: accounts[programIndex].pubkey, accounts: metas, data });
    }
    if (!r.done()) return null;
    return {
      signatures,
      message: wire.slice(messageStart),
      feePayer: accounts[0].pubkey,
      signers: accounts.slice(0, required).map((a) => a.pubkey),
      blockhash,
      instructions,
    };
  } catch {
    return null;
  }
}

// Every signature of a parsed transaction verifies over its message under its signer's key.
export function signaturesValid(tx: ParsedTransaction): boolean {
  if (tx.signatures.length !== tx.signers.length) return false;
  try {
    return tx.signers.every((signer, i) => ed25519.verify(tx.signatures[i], tx.message, key(signer)));
  } catch {
    return false;
  }
}

// A u64 little-endian at `offset`, or null past the end.
export function readU64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null;
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

export function readU32(data: Uint8Array, offset: number): number | null {
  if (data.length < offset + 4) return null;
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}
