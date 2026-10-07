// The server's record of a wallet's activation burn (unified plan R1 and R6: one wallet, one code, for a light or a
// super node, chosen once): the timers every client shares, the wallet's signed reservation (only the wallet itself can
// hold it, shared contract C1), the proof that a burn from the wallet's own Solana address is that wallet's (the message,
// its signed envelope and the check), and the exact answer of GET /api/cabinet/activation/{wallet}, read again in the
// page. Pure; the server keeps the rows (src/server/cabinet/activation-registry.ts) and the page decides with them
// (wallet-activation.ts).

import { ed25519 } from '@noble/curves/ed25519';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import bs58 from 'bs58';
import { SITE_ORIGIN } from '../hosts.ts';
import {
  BURN_AMOUNT_MAX, BURN_CLUSTER, MLDSA65_PUBLIC_KEY_BYTES, MLDSA65_SIGNATURE_BYTES, activationCode, decodeB64url, eonOfPublicKey, isActivationCode,
  isSolanaSignature, utf8Bytes, type NodeType, type ReservationVerifier,
} from '../qnet-link.ts';
import { isEonAddress, isSolanaAddress } from '../qnet-provider.ts';

// A reservation holds a wallet this long; a client signs a burn only while at least SIGN_MARGIN_MS of it is left.
export const RESERVATION_TTL_MS = 600_000;
export const SIGN_MARGIN_MS = 120_000;
// An announced burn still not found this long after the announce can no longer land.
export const SETTLE_AFTER_MS = 600_000;
// The server's search of a Solana address for activation burns is reused this long.
export const SCAN_CACHE_MS = 300_000;
// How old a wallet's signed reservation may be when the server takes it (seconds): the extension signs right before it
// burns; QNet Wallet signs a payment address's reservation before the address exists, and a payment key waits up to 24
// hours for its burn (flow.ts KEY_LIFETIME_MS), plus ten minutes. Up to five minutes ahead of the server's clock.
export const RESERVE_PROOF_PAST_S = { extension: 600, payment: 87_000 } as const;
export const RESERVE_PROOF_FUTURE_S = 300;

// The origin every record proof is signed for, in every build (the extension signs it with this constant too).
export const RECORD_ORIGIN = SITE_ORIGIN;
export const OFFCHAIN_HEADER = 'QNet Signed Message:\n';
export const OFFCHAIN_CONTEXT = 'QNET_OFFCHAIN_MSG_v1';
const CONTEXT_BYTES = utf8Bytes(OFFCHAIN_CONTEXT);

export const RECORD_STATES = ['none', 'reserved', 'sending', 'recorded'] as const;
export type RecordState = (typeof RECORD_STATES)[number];
export const BURN_WAYS = ['extension', 'payment'] as const;
export type BurnWay = (typeof BURN_WAYS)[number];

const RESERVATION_RE = /^[0-9a-f]{32}$/;

export const isReservationId = (value: unknown): value is string => typeof value === 'string' && RESERVATION_RE.test(value);
export const isNodeType = (value: unknown): value is NodeType => value === 'light' || value === 'super';
export const isBurnWay = (value: unknown): value is BurnWay => value === 'extension' || value === 'payment';
export const isBurnAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= BURN_AMOUNT_MAX;

// The code of a burn (C0): from the burner's own Solana address for a burn of the extension; for a payment address's
// light burn, from the wallet's QNet address (owner rule, 26.09).
export function recordCode(way: BurnWay, nodeType: NodeType, wallet: string, burner: string, burnTx: string, burnAmount: number): string {
  return way === 'payment' ? activationCode('light', wallet, burnTx, burnAmount) : activationCode(nodeType, burner, burnTx, burnAmount);
}

// The bytes a wallet signs for this site: "QNet Signed Message:\n" + origin + "\n" + the message's UTF-8 length + "\n" +
// the message, as the wallets build a signed message for a site.
export function burnRecordEnvelope(message: string): Uint8Array {
  const body = utf8Bytes(message);
  const head = utf8Bytes(`${OFFCHAIN_HEADER}${RECORD_ORIGIN}\n${body.length}\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasKeys = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));

// ---------------------------------------------------------------- the wallet's signed reservation (C1)

// The message the wallet signs to hold itself for one burn: exact text, LF line breaks, no trailing line break, the
// time in decimal Unix seconds. `burner`: the Solana address that burns (the extension's own, or the payment address).
export function reservationMessage(wallet: string, nodeType: NodeType, way: BurnWay, burner: string, time: number | string): string {
  return `QNet node reservation v1\nwallet: ${wallet}\nnode: ${nodeType}\nway: ${way}\nburner: ${burner}\ntime: ${time}\ncluster: ${BURN_CLUSTER}`;
}

// {pk, sig}: the wallet's ML-DSA-65 public key and signature, base64url; time: when it signed, Unix seconds.
export interface ReservationProof {
  pk: string;
  sig: string;
  time: number;
}

export interface ReservationFields {
  wallet: string;
  nodeType: NodeType;
  way: BurnWay;
  burner: string;
}

// Exactly {pk, sig, time}, each of its form.
export function parseReservationProof(value: unknown): ReservationProof | null {
  if (!isObject(value) || !hasKeys(value, ['pk', 'sig', 'time'])) return null;
  if (!decodeB64url(value.pk, MLDSA65_PUBLIC_KEY_BYTES) || !decodeB64url(value.sig, MLDSA65_SIGNATURE_BYTES)) return null;
  if (typeof value.time !== 'number' || !Number.isSafeInteger(value.time) || value.time < 0) return null;
  return { pk: value.pk as string, sig: value.sig as string, time: value.time };
}

function reservationVerifies(fields: ReservationFields, time: number | string, publicKey: Uint8Array, signature: Uint8Array): boolean {
  if (eonOfPublicKey(publicKey) !== fields.wallet) return false;
  const envelope = burnRecordEnvelope(reservationMessage(fields.wallet, fields.nodeType, fields.way, fields.burner, time));
  try {
    return ml_dsa65.verify(signature, envelope, publicKey, { context: CONTEXT_BYTES });
  } catch {
    return false;
  }
}

// The checks of C1 in their order: the proof's form, its key is the wallet's, the wallet's ML-DSA-65 signature (FIPS 204
// context QNET_OFFCHAIN_MSG_v1) verifies over the envelope of these very fields and time (`invalid` otherwise), and the
// time is within the way's window of `nowS` (`stale` otherwise). Without the wallet's key nobody holds it.
export function verifyReservationProof(fields: ReservationFields, proof: unknown, nowS: number): 'ok' | 'invalid' | 'stale' {
  const p = parseReservationProof(proof);
  if (!p || !isEonAddress(fields.wallet) || !isNodeType(fields.nodeType) || !isBurnWay(fields.way) || !isSolanaAddress(fields.burner)) return 'invalid';
  const publicKey = decodeB64url(p.pk, MLDSA65_PUBLIC_KEY_BYTES) as Uint8Array;
  const signature = decodeB64url(p.sig, MLDSA65_SIGNATURE_BYTES) as Uint8Array;
  if (!reservationVerifies(fields, p.time, publicKey, signature)) return 'invalid';
  if (p.time < nowS - RESERVE_PROOF_PAST_S[fields.way] || p.time > nowS + RESERVE_PROOF_FUTURE_S) return 'stale';
  return 'ok';
}

// QNet Wallet's `reserve` answer (qnet-link.ts validateAnswer): its signature over a payment address's light reservation.
export const verifyReserveAnswer: ReservationVerifier = ({ wallet, burner, time, publicKey, signature }) =>
  reservationVerifies({ wallet, nodeType: 'light', way: 'payment', burner }, time, publicKey, signature);

// ---------------------------------------------------------------- the proof of a burn of the extension (C1)

// The message the wallet signs for its burn: exact text, LF line breaks, no trailing line break.
export function burnRecordMessage(wallet: string, nodeType: NodeType, burner: string, burnTx: string, amount: number): string {
  return `QNet burn record v1\nwallet: ${wallet}\nnode: ${nodeType}\nburner: ${burner}\nburn: ${burnTx}\namount: ${amount}\ncluster: ${BURN_CLUSTER}`;
}

// {pk, sig}: the wallet's ML-DSA-65 public key and signature, base64url; solanaSig: the burner key's Ed25519 signature,
// base58.
export interface BurnProof {
  pk: string;
  sig: string;
  solanaSig: string;
}

export interface BurnFacts {
  wallet: string;
  nodeType: NodeType;
  burner: string;
  burnTx: string;
  burnAmount: number;
}

function decodeSignature58(text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || text.length < 64 || text.length > 88) return null;
  try {
    const bytes = bs58.decode(text);
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

// Exactly {pk, sig, solanaSig}, each of its length.
export function parseBurnProof(value: unknown): BurnProof | null {
  if (!isObject(value) || !hasKeys(value, ['pk', 'sig', 'solanaSig'])) return null;
  if (!decodeB64url(value.pk, MLDSA65_PUBLIC_KEY_BYTES) || !decodeB64url(value.sig, MLDSA65_SIGNATURE_BYTES)) return null;
  if (!decodeSignature58(value.solanaSig)) return null;
  return { pk: value.pk as string, sig: value.sig as string, solanaSig: value.solanaSig as string };
}

// Every check of C1: the key is the wallet's, the wallet's ML-DSA-65 signature (FIPS 204 context QNET_OFFCHAIN_MSG_v1)
// and the burner's Ed25519 signature both verify over the envelope of these very facts. Without both keys of the
// wallet's recovery phrase no record can be made for it. The Solana check of the burn itself is the caller's.
export function verifyBurnRecordProof(facts: BurnFacts, proof: unknown): boolean {
  const p = parseBurnProof(proof);
  if (!p || !isEonAddress(facts.wallet) || !isNodeType(facts.nodeType) || !isSolanaAddress(facts.burner)) return false;
  if (!isSolanaSignature(facts.burnTx) || !isBurnAmount(facts.burnAmount)) return false;
  const pk = decodeB64url(p.pk, MLDSA65_PUBLIC_KEY_BYTES) as Uint8Array;
  const sig = decodeB64url(p.sig, MLDSA65_SIGNATURE_BYTES) as Uint8Array;
  const solanaSig = decodeSignature58(p.solanaSig) as Uint8Array;
  if (eonOfPublicKey(pk) !== facts.wallet) return false;
  const envelope = burnRecordEnvelope(burnRecordMessage(facts.wallet, facts.nodeType, facts.burner, facts.burnTx, facts.burnAmount));
  try {
    if (!ml_dsa65.verify(sig, envelope, pk, { context: CONTEXT_BYTES })) return false;
    return ed25519.verify(solanaSig, envelope, bs58.decode(facts.burner));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- GET /api/cabinet/activation/{wallet} (C3.1)

export interface ScanBurn {
  burnTx: string;
  nodeType: NodeType;
  burnAmount: number;
}

// The server's search of the wallet's own Solana address: the valid burns oldest first; `unusable`: a burn no code
// comes from; `complete`: false when the search ran out of budget or Solana failed.
export interface ScanView {
  complete: boolean;
  unusable: boolean;
  burns: ScanBurn[];
}

export interface ActivationRecordView {
  wallet: string;
  state: RecordState;
  nodeType: NodeType | null;
  way: BurnWay | null;
  burner: string | null;
  burnTx: string | null;
  burnAmount: number | null;
  code: string | null;
  // reserved: the reservation's end; sending: the announce plus SETTLE_AFTER_MS (ms).
  until: number | null;
  recordedAt: number | null;
  scan: ScanView | null;
}

export const RECORD_VIEW_KEYS = ['wallet', 'state', 'nodeType', 'way', 'burner', 'burnTx', 'burnAmount', 'code', 'until', 'recordedAt', 'scan'] as const;
export const SCAN_BURNS_MAX = 10;

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function parseScan(value: unknown): ScanView | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || !hasKeys(value, ['complete', 'unusable', 'burns'])) return undefined;
  if (typeof value.complete !== 'boolean' || typeof value.unusable !== 'boolean' || !Array.isArray(value.burns) || value.burns.length > SCAN_BURNS_MAX) return undefined;
  const burns: ScanBurn[] = [];
  for (const b of value.burns) {
    if (!isObject(b) || !hasKeys(b, ['burnTx', 'nodeType', 'burnAmount'])) return undefined;
    if (!isSolanaSignature(b.burnTx) || !isNodeType(b.nodeType) || !isBurnAmount(b.burnAmount)) return undefined;
    burns.push({ burnTx: b.burnTx, nodeType: b.nodeType, burnAmount: b.burnAmount });
  }
  return { complete: value.complete, unusable: value.unusable, burns };
}

// The route's answer, exactly: its keys, the value forms, and the nulls each state has; a record's code must be the
// one its burn gives. Null for anything else.
export function parseActivationRecord(body: unknown, wallet?: string): ActivationRecordView | null {
  if (!isObject(body) || !hasKeys(body, RECORD_VIEW_KEYS)) return null;
  const b = body;
  if (!isEonAddress(b.wallet) || (wallet !== undefined && b.wallet !== wallet)) return null;
  if (!(RECORD_STATES as readonly unknown[]).includes(b.state)) return null;
  const scan = parseScan(b.scan);
  if (scan === undefined) return null;
  const state = b.state as RecordState;
  const nulls = (keys: readonly string[]) => keys.every((k) => b[k] === null);
  if (state === 'none') {
    if (!nulls(['nodeType', 'way', 'burner', 'burnTx', 'burnAmount', 'code', 'until', 'recordedAt'])) return null;
    return { ...(b as unknown as ActivationRecordView), scan };
  }
  if (scan !== null) return null;
  if (!isNodeType(b.nodeType) || !isBurnWay(b.way) || !isBurnAmount(b.burnAmount)) return null;
  if (b.way === 'payment' && b.nodeType !== 'light') return null;
  if (state === 'reserved') {
    if (!nulls(['burner', 'burnTx', 'code', 'recordedAt']) || !isTime(b.until)) return null;
  } else {
    if (!isSolanaAddress(b.burner) || !isSolanaSignature(b.burnTx)) return null;
    if (state === 'recorded') {
      if (b.until !== null || !isTime(b.recordedAt) || !isActivationCode(b.code)) return null;
      if (b.code !== recordCode(b.way, b.nodeType, b.wallet, b.burner, b.burnTx, b.burnAmount)) return null;
    } else if (b.code !== null || b.recordedAt !== null || !isTime(b.until)) {
      return null;
    }
  }
  return b as unknown as ActivationRecordView;
}
