// QNet Link v1, the site's side (docs/protocols/qnet-link-v1.md): revision 2 (section 14), the cabinet's
// requests to the QNet app through the relay (`unlink` among them: QNet Wallet ends the node's run on the device that
// runs it, there or, once the network takes the wallet's own unbind, from any device): the link, the request and its
// hash, the relay bodies and the app's answer (a `reserve` answer's signature through a verifier the page supplies,
// burn-record.ts verifyReserveAnswer); and the extension's qnet_activateNode, qnet_claimNodeBalance and
// qnet_unlinkNodeDevice (sections 10 and 14.10). Pure
// and framework-free, shared by the cabinet, the relay routes and the tests; the key exchange and decryption are
// in qnet-link-crypto.ts.
// Checked against docs/protocols/light-node.vectors.json (revision 2) and qnet-link-v1.vectors.json (the
// extension's activation answers).

import jsSha3 from 'js-sha3';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { blake3 } from '@noble/hashes/blake3';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { ANDROID_PLAY_PACKAGE } from './app-links.ts';
import { LINK_ORIGIN, SITE_ORIGIN } from './hosts.ts';
import { callProvider, errorCode, isApprovalCooldown, isEonAddress, isSolanaAddress, type QNetProvider } from './qnet-provider.ts';
import { decodeKey } from './solana-message.ts';

export { LINK_HOST, LINK_ORIGIN, SITE_ORIGIN } from './hosts.ts';
export const LINK_PREFIX = `${LINK_ORIGIN}/l#v1.`;
export const LINK_RE = /^https:\/\/link\.aiqnet\.io\/l#v1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})\.(connect|link|claim|reserve|unlink)(?:\.([A-Za-z0-9_-]{43}))?$/;
// Where the link page's button falls back to when the app is not installed.
export const WALLET_PAGE = `${SITE_ORIGIN}/wallet`;
// The one Android package: the same Play-signed file from Google Play and from aiqnet.io (section 14.2).
export const ANDROID_PACKAGE = ANDROID_PLAY_PACKAGE;
const ID_RE = /^[0-9a-f]{32}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const CODE_RE = /^QNET-[LS][0-9A-F]{5}-[0-9A-F]{6}-[0-9A-F]{6}$/;
const WALLET_HASH_RE = /^[0-9a-f]{16}$/;
const NODE_ID_RE = /^light_mobile_[0-9a-f]{16}$/;
const SUPER_ID_RE = /^(?:super_node_[0-9a-f]{16}|genesis_node_00[1-5])$/;
const TX_HASH_RE = /^[0-9a-f]{64}$/;
const U64_RE = /^(?:0|[1-9][0-9]{0,19})$/;
const U64_MAX = 18_446_744_073_709_551_615n;

export const HKDF_INFO = 'qnet-link-v1';
export const SAS_INFO = 'qnet-link-v1-sas';
export const AAD_PREFIX = 'qnet-link-v1|';
export const WALLET_HASH_PREFIX = 'qnet-link-wallet:';
export const CHAIN_TAG = 'q1337|';
export const SESSION_TTL_S = 600;
export const POLL_INTERVAL_MS = 2_000;
export const SESSION_BODY_MAX_BYTES = 2048;
export const CT_MIN_BYTES = 17;
export const MLDSA65_PUBLIC_KEY_BYTES = 1952;
export const MLDSA65_SIGNATURE_BYTES = 3309;
// The consent window (section 14.2): 24 hours once two genesis nodes advertise consent_24h, 5 minutes before.
export const CONSENT_PAST_S = 86_400;
export const CONSENT_PAST_S_BEFORE_24H = 300;
export const CONSENT_FUTURE_S = 300;
// A `reserve` answer's time: the page takes it from 15 minutes before its clock to 5 minutes after (section 14.4).
export const RESERVE_ANSWER_PAST_S = 900;
export const RESERVE_ANSWER_FUTURE_S = 300;
// The smallest full claim: 1 QNC (a capped claim, which stops at an epoch, may move less; validateAnswer).
export const CLAIM_MIN_NANO = 1_000_000_000n;
export const BURN_AMOUNT_MAX = 1_000_000_000;
// The cluster the live network verifies burns on: a constant of this release, never a choice.
export const BURN_CLUSTER = 'devnet';
// The user may take a while in the approval window, and a burn waits up to 90 s for finality.
const ACTIVATE_TIMEOUT_MS = 15 * 60_000;

export const INTENTS = ['connect', 'link', 'claim', 'reserve', 'unlink'] as const;
export type LinkIntent = (typeof INTENTS)[number];

// Answer caps per intent: a `link` and a `reserve` answer carry an ML-DSA-65 key and signature (section 14.2).
export const CAPS: Record<LinkIntent, { plaintext: number; ct: number; body: number }> = {
  connect: { plaintext: 1024, ct: 1040, body: 4096 },
  link: { plaintext: 8192, ct: 8208, body: 12_288 },
  claim: { plaintext: 1024, ct: 1040, body: 4096 },
  reserve: { plaintext: 8192, ct: 8208, body: 12_288 },
  unlink: { plaintext: 1024, ct: 1040, body: 4096 },
};
export const RESPONSE_BODY_MAX_BYTES = Math.max(...INTENTS.map((i) => CAPS[i].body));

export type AnswerStatus = 'ok' | 'linked' | 'empty' | 'rejected' | 'error';

const STATUSES: Record<LinkIntent, readonly AnswerStatus[]> = {
  connect: ['ok', 'rejected', 'error'],
  link: ['ok', 'linked', 'rejected', 'error'],
  claim: ['ok', 'empty', 'rejected', 'error'],
  reserve: ['ok', 'rejected', 'error'],
  unlink: ['ok', 'rejected', 'error'],
};

export const LINK_ERRORS = {
  connect: ['NO_WALLET', 'INTERNAL'],
  link: ['NO_WALLET', 'WALLET_MISMATCH', 'NO_NODE', 'NODE_OTHER', 'NETWORK', 'BIND_REFUSED', 'INTERNAL'],
  claim: ['NO_WALLET', 'WALLET_MISMATCH', 'NO_NODE', 'NETWORK', 'CLAIM_REFUSED', 'CLAIM_BUSY', 'INTERNAL'],
  reserve: ['NO_WALLET', 'WALLET_MISMATCH', 'NODE_OTHER', 'NETWORK', 'INTERNAL'],
  unlink: ['NO_WALLET', 'WALLET_MISMATCH', 'NOT_LINKED', 'NETWORK', 'UNLINK_REFUSED', 'INTERNAL'],
} as const satisfies Record<LinkIntent, readonly string[]>;
export type LinkError = (typeof LINK_ERRORS)[LinkIntent][number];

// Section 14.4: what travels with a `link`, `claim`, `reserve` or `unlink` session, bound to the link by its hash.
export interface LinkDeviceRequest {
  // The burn whose registration the app's consent completes; null links the node already on the chain.
  burnTx: string | null;
  // The wallet the page already knows; null lets the app answer for the wallet open in it.
  walletHash: string | null;
  // True when the page showed a QR and knows no wallet: the app then shows the check number.
  check: boolean;
  // Only for a burn made from the wallet's own Solana address (with a burn and a named wallet): that address. The app's
  // Solana key, the same recovery phrase's, then signs the burn's owner bind with the consent (`consent.ownerSig`).
  burner?: string;
}

export interface ClaimRequest {
  walletHash: string | null;
}

// A light node for the wallet the page names, paid from the one-time payment address `burner`: the wallet signs its
// reservation (burn-record.ts reservationMessage).
export interface ReserveRequest {
  walletHash: string;
  burner: string;
}

// The wallet the page shows, whose node QNet Wallet unlinks from its device: always named.
export interface UnlinkRequest {
  walletHash: string;
}

export type LinkRequest = LinkDeviceRequest | ClaimRequest | ReserveRequest | UnlinkRequest;

// What the site created (the session request body) with the request's hash, as the relay returns it.
export interface LinkSession {
  id: string;
  sitePub: string;
  intent: LinkIntent;
  request?: LinkRequest;
  reqHash?: string;
}

// What a link carries: the request only by its hash.
export interface ParsedLink {
  id: string;
  sitePub: string;
  intent: LinkIntent;
  reqHash?: string;
}

export interface RelayAnswerBody {
  appPub: string;
  iv: string;
  ct: string;
}

export interface Consent {
  ts: string;
  pk: string;
  sig: string;
  // For a request with `burner`: the owner bind v1 of the burn by that Solana key (b64url, 64 bytes).
  ownerSig?: string;
}

// An answer that passed every check of section 14.7.
export interface LinkAnswer {
  v: 1;
  intent: LinkIntent;
  status: AnswerStatus;
  qnet?: string;
  solana?: string;
  nodeId?: string;
  consent?: Consent;
  bound?: boolean;
  seq?: string;
  amountNano?: string;
  txHash?: string;
  stoppedAtEpoch?: string | null;
  // A `reserve` answer: when the wallet signed (decimal Unix seconds), its ML-DSA-65 public key and signature.
  time?: string;
  pk?: string;
  sig?: string;
  // An `unlink` answer: whether the network took the device's unbind (the device stopped either way).
  unbound?: boolean;
  error?: LinkError;
}

// ML-DSA-65 verification with an empty context, supplied by the page that checks consents.
export type ConsentVerifier = (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;

// The check of a `reserve` answer's signature: the wallet's ML-DSA-65 signature over its reservation of a light node
// paid from `burner` at `time`, supplied by the page (burn-record.ts verifyReserveAnswer).
export type ReservationVerifier = (facts: { wallet: string; burner: string; time: string; publicKey: Uint8Array; signature: Uint8Array }) => boolean;

// ---------------------------------------------------------------- encodings

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const utf8 = new TextEncoder();

export const utf8Bytes = (text: string): Uint8Array => utf8.encode(text);
const byteLength = (text: string): number => utf8.encode(text).length;

// Unpadded base64url (RFC 4648 section 5).
export function encodeB64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.ceil((Math.min(3, bytes.length - i) * 8) / 6);
    for (let j = 0; j < chars; j += 1) out += B64URL[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

// Canonical unpadded base64url only (no '=', no other alphabet, zero padding bits), of exactly
// `length` bytes when given; null otherwise.
export function decodeB64url(text: unknown, length?: number): Uint8Array | null {
  if (typeof text !== 'string' || text.length % 4 === 1 || !B64URL_RE.test(text)) return null;
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let k = 0;
  for (let i = 0; i < text.length; i += 1) {
    acc = (acc << 6) | B64URL.indexOf(text[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[k++] = acc >> bits;
      acc &= (1 << bits) - 1;
    }
  }
  if (encodeB64url(out) !== text) return null;
  return length === undefined || out.length === length ? out : null;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error('hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const isSessionId = (value: unknown): value is string => typeof value === 'string' && ID_RE.test(value);
export const isActivationCode = (value: unknown): value is string => typeof value === 'string' && CODE_RE.test(value);
export const isWalletHash = (value: unknown): value is string => typeof value === 'string' && WALLET_HASH_RE.test(value);
export const isLightNodeId = (value: unknown): value is string => typeof value === 'string' && NODE_ID_RE.test(value);
// A super node's id: the one a wallet's super node gets (superNodeId), or a genesis node's.
export const isSuperNodeId = (value: unknown): value is string => typeof value === 'string' && SUPER_ID_RE.test(value);

// A Solana transaction signature is the base58 of 64 bytes (64 to 88 characters).
export function isSolanaSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 64 || value.length > 88) return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

// A u64 as its decimal string: no sign, no leading zero.
export function isU64String(value: unknown): value is string {
  return typeof value === 'string' && U64_RE.test(value) && BigInt(value) <= U64_MAX;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Object.hasOwn without its browser floor (older browsers lack it).
const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const have = Object.keys(value).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((key, i) => key === want[i]);
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- identity (light-node-messages.md section 3)

const sha3 = (text: string | Uint8Array): string => jsSha3.sha3_256(text);

// The first 16 hex of SHA3-256("qnet-link-wallet:" + EON): the wallet a request names.
export function walletHash(qnet: string): string {
  return sha3(`${WALLET_HASH_PREFIX}${qnet}`).slice(0, 16);
}

// N: the light node id of a wallet.
export function lightNodeId(qnet: string): string {
  return `light_mobile_${bytesToHex(blake3(utf8Bytes(`LIGHT_NODE_PRIVACY_${qnet}`))).slice(0, 16)}`;
}

// The super node id of a wallet (the node's registration_api derives it the same way).
export function superNodeId(qnet: string): string {
  return `super_node_${bytesToHex(blake3(utf8Bytes(`SUPER_NODE_PRIVACY_${qnet}`))).slice(0, 16)}`;
}

// The node id of a wallet's node of either type.
export function nodeIdOf(qnet: string, nodeType: 'light' | 'super'): string {
  return nodeType === 'super' ? superNodeId(qnet) : lightNodeId(qnet);
}

// The proof a consent signs: the first 32 hex of BLAKE3("{burnTx}:{N}:{W}").
export function consentProof(burnTx: string, nodeId: string, qnet: string): string {
  return bytesToHex(blake3(utf8Bytes(`${burnTx}:${nodeId}:${qnet}`))).slice(0, 32);
}

// The consent the wallet key signs (light-node-messages.md section 4).
export function consentMessage(nodeId: string, qnet: string, proof: string, ts: string): string {
  return `${CHAIN_TAG}client_node_reg:${nodeId}:${qnet}:${proof}:${ts}`;
}

// The burner's owner bind v1 of the same registration (qnet-state burn_owner_bind_message): the node, the wallet, the
// proof, the consent's T, SHA3-256 of the wallet's ML-DSA-65 key and the burn.
export function ownerBindMessage(nodeId: string, qnet: string, proof: string, ts: string, publicKey: Uint8Array, burnTx: string): string {
  return `qnet_onchain_reg:${nodeId}:${qnet}:${proof}:${ts}:${sha3(publicKey)}:${burnTx}`;
}

// Whether `signature` is the Ed25519 signature of `burner` (base58) over the owner bind v1 of `qnet`'s light node with
// `burnTx`, its consent's T and its key.
export function verifyOwnerBind(qnet: string, publicKey: Uint8Array, burnTx: string, ts: string, burner: string, signature: Uint8Array): boolean {
  const key = decodeKey(burner);
  if (!key || signature.length !== ED25519_SIGNATURE_BYTES || !isEonAddress(qnet) || !isSolanaSignature(burnTx)) return false;
  const nodeId = lightNodeId(qnet);
  try {
    return ed25519.verify(signature, utf8Bytes(ownerBindMessage(nodeId, qnet, consentProof(burnTx, nodeId, qnet), ts, publicKey, burnTx)), key);
  } catch {
    return false;
  }
}

// The EON address of an ML-DSA-65 public key.
export function eonOfPublicKey(publicKey: Uint8Array): string {
  const full = bytesToHex(sha512(publicKey));
  const head = `${full.slice(0, 19)}eon${full.slice(19, 34)}`;
  return `${head}${sha3(head).slice(0, 8)}`;
}

// ---------------------------------------------------------------- activation code

// The node-identical activation code of a burn (node generate_quantum_activation_code, extension
// core.generateActivationCode and core.walletActivationCode). `solana` is the wallet the code names: the burner's
// own Solana address, or for a light node paid by a payment key of aiqnet.io the wallet's QNet address.
export function activationCode(nodeType: NodeType, solana: string, burnTx: string, burnAmount: number): string {
  const key = sha3(`${burnTx}:${nodeType}:${burnAmount}`).substring(0, 32);
  const enc = Array.from(solana, (c, i) => (c.charCodeAt(0) ^ key.charCodeAt(i % 32)).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  const seg1 = (nodeType === 'super' ? 'S' : 'L') + sha3(`ts:${burnTx}:${nodeType}`).substring(0, 5).toUpperCase();
  const seg2 = `${enc}000000`.substring(0, 6);
  const seg3 = (`${enc.substring(6, 10)}0000`.substring(0, 4)
    + sha3(`entropy:${solana}:${burnTx}:${nodeType}`).substring(0, 4).toUpperCase()).substring(0, 6);
  return `QNET-${seg1}-${seg2}-${seg3}`;
}

// ---------------------------------------------------------------- requests

const REQUEST_KEYS = {
  link: ['burnTx', 'walletHash', 'check'], claim: ['walletHash'], reserve: ['walletHash', 'burner'], unlink: ['walletHash'],
} as const;
// A `link` request for a burn made from the wallet's own Solana address: the keys above, then that address.
export const OWN_BURN_REQUEST_KEYS = ['burnTx', 'walletHash', 'check', 'burner'] as const;
const CONSENT_KEYS = ['ts', 'pk', 'sig'] as const;
const OWN_BURN_CONSENT_KEYS = ['ts', 'pk', 'sig', 'ownerSig'] as const;
export const ED25519_SIGNATURE_BYTES = 64;

export type RequestIntent = Exclude<LinkIntent, 'connect'>;

const needsRequest = (intent: LinkIntent): intent is RequestIntent => intent !== 'connect';

// The request's exact keys and value forms, or null. A `reserve` and an `unlink` request always name a wallet; a `link`
// request with `burner` names the wallet and the burn too.
export function checkRequest(intent: LinkIntent, value: unknown): LinkRequest | null {
  if (!needsRequest(intent) || !isPlainObject(value)) return null;
  const ownBurn = intent === 'link' && hasExactKeys(value, OWN_BURN_REQUEST_KEYS);
  if (!ownBurn && !hasExactKeys(value, REQUEST_KEYS[intent])) return null;
  if (value.walletHash !== null && !isWalletHash(value.walletHash)) return null;
  if (intent === 'reserve') {
    if (value.walletHash === null || !isSolanaAddress(value.burner)) return null;
    return { walletHash: value.walletHash as string, burner: value.burner };
  }
  if (intent === 'unlink') return value.walletHash === null ? null : { walletHash: value.walletHash as string };
  if (intent === 'claim') return { walletHash: value.walletHash as string | null };
  if (value.burnTx !== null && !isSolanaSignature(value.burnTx)) return null;
  if (typeof value.check !== 'boolean') return null;
  const request = { burnTx: value.burnTx as string | null, walletHash: value.walletHash as string | null, check: value.check };
  if (!ownBurn) return request;
  if (request.burnTx === null || request.walletHash === null || !isSolanaAddress(value.burner)) return null;
  return { ...request, burner: value.burner };
}

// The request bytes: its keys in the order of section 14.4, no whitespace.
export function requestText(intent: RequestIntent, request: LinkRequest): string {
  const r = request as Partial<LinkDeviceRequest & ReserveRequest>;
  const keys = intent === 'link' && r.burner !== undefined ? OWN_BURN_REQUEST_KEYS : REQUEST_KEYS[intent];
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, r[k]])));
}

// reqHash = b64url(SHA-256(request bytes)), 43 characters.
export function requestHash(text: string): string {
  return encodeB64url(sha256(utf8Bytes(text)));
}

// ---------------------------------------------------------------- link

export function buildLink(s: ParsedLink): string {
  return `${LINK_PREFIX}${s.id}.${s.sitePub}.${s.intent}${s.reqHash ? `.${s.reqHash}` : ''}`;
}

// The whole string or nothing: no trimming, case folding or percent-decoding.
export function parseLink(text: unknown): ParsedLink | null {
  const m = typeof text === 'string' ? LINK_RE.exec(text) : null;
  if (!m) return null;
  const [, id, sitePub, intent, reqHash] = m;
  if (needsRequest(intent as LinkIntent) !== (reqHash !== undefined)) return null;
  if (!decodeB64url(sitePub, 32) || (reqHash !== undefined && !decodeB64url(reqHash, 32))) return null;
  return reqHash === undefined ? { id, sitePub, intent: intent as LinkIntent } : { id, sitePub, intent: intent as LinkIntent, reqHash };
}

// Sections 4.1 and 14.3: the intent: URL that opens `link` in the app on Android; the browser loads
// `fallback` when the app is not installed. Android's Intent.parseUri takes the fields from the last '#',
// so the link before it keeps its fragment and arrives as the intent's data unchanged. Null for anything
// but a valid link and an https fallback.
export function androidIntentUrl(link: string, fallback: string): string | null {
  if (!parseLink(link) || !fallback.startsWith('https://')) return null;
  return `intent://${link.slice('https://'.length)}#Intent;scheme=https;package=${ANDROID_PACKAGE};`
    + `S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

// ---------------------------------------------------------------- relay bodies

// POST /api/link/sessions: exactly {id, sitePub, intent} for `connect`, plus `request` for `link`, `claim`, `reserve`
// and `unlink`; the relay keeps the request with its hash.
export function validateSessionRequest(text: string): LinkSession | null {
  if (byteLength(text) > SESSION_BODY_MAX_BYTES) return null;
  const body = parseObject(text);
  if (!body || !(INTENTS as readonly unknown[]).includes(body.intent)) return null;
  const intent = body.intent as LinkIntent;
  if (!hasExactKeys(body, needsRequest(intent) ? ['id', 'sitePub', 'intent', 'request'] : ['id', 'sitePub', 'intent'])) return null;
  if (!isSessionId(body.id) || !decodeB64url(body.sitePub, 32)) return null;
  const session: LinkSession = { id: body.id, sitePub: body.sitePub as string, intent };
  if (!needsRequest(intent)) return session;
  const request = checkRequest(intent, body.request);
  if (!request) return null;
  return { ...session, request, reqHash: requestHash(requestText(intent, request)) };
}

// POST /api/link/sessions/:id/response (and the relay's 200 to the site's poll): exactly {appPub, iv, ct},
// within the caps of the session's intent.
export function validateResponseRequest(text: string, intent: LinkIntent): RelayAnswerBody | null {
  if (byteLength(text) > CAPS[intent].body) return null;
  const body = parseObject(text);
  if (!body || !hasExactKeys(body, ['appPub', 'iv', 'ct'])) return null;
  if (!decodeB64url(body.appPub, 32) || !decodeB64url(body.iv, 12)) return null;
  const ct = decodeB64url(body.ct);
  if (!ct || ct.length < CT_MIN_BYTES || ct.length > CAPS[intent].ct) return null;
  return { appPub: body.appPub as string, iv: body.iv as string, ct: body.ct as string };
}

// ---------------------------------------------------------------- the app's answer

const BASE_KEYS = ['v', 'intent', 'status'];

function keysFor(intent: LinkIntent, status: AnswerStatus): string[] {
  if (status === 'rejected') return BASE_KEYS;
  if (status === 'error') return [...BASE_KEYS, 'error'];
  if (intent === 'connect') return [...BASE_KEYS, 'qnet', 'solana'];
  if (intent === 'reserve') return [...BASE_KEYS, 'qnet', 'time', 'pk', 'sig'];
  if (intent === 'unlink') return [...BASE_KEYS, 'qnet', 'nodeId', 'unbound'];
  if (status === 'linked') return [...BASE_KEYS, 'qnet', 'nodeId', 'seq'];
  if (status === 'empty') return [...BASE_KEYS, 'qnet', 'nodeId'];
  if (intent === 'link') return [...BASE_KEYS, 'qnet', 'nodeId', 'consent', 'bound'];
  return [...BASE_KEYS, 'qnet', 'nodeId', 'amountNano', 'txHash', 'stoppedAtEpoch'];
}

// Where the page validates an answer: the session's intent and request, the clock and the consent window, the
// ML-DSA-65 verifier for a consent and the one for a reservation (without its verifier, that answer is refused).
export interface AnswerContext {
  intent: LinkIntent;
  request: LinkRequest | null;
  nowS: number;
  consent24h: boolean;
  verify?: ConsentVerifier;
  verifyReservation?: ReservationVerifier;
}

export type AnswerCheck = { ok: true; answer: LinkAnswer } | { ok: false; reason: string };

// Section 14.7, in its order: every check must pass, or the answer is unreadable. `reason` names the first
// failing check (the vectors' reasons).
export function validateAnswer(plaintext: string, ctx: AnswerContext): AnswerCheck {
  const fail = (reason: string): AnswerCheck => ({ ok: false, reason });
  const { intent } = ctx;
  if (typeof plaintext !== 'string' || byteLength(plaintext) > CAPS[intent].plaintext) return fail('size');
  const r = parseObject(plaintext);
  if (!r) return fail('json');
  if (r.v !== 1) return fail('v');
  if (r.intent !== intent) return fail('intent');
  const status = r.status as AnswerStatus;
  const burnTx = intent === 'link' ? (ctx.request as LinkDeviceRequest | null)?.burnTx ?? null : null;
  if (!STATUSES[intent].includes(status) || (intent === 'link' && status === 'ok' && burnTx === null)) return fail('status');
  if (!hasExactKeys(r, keysFor(intent, status))) return fail('keys');
  // A consent to a burn of the wallet's own Solana address carries that key's owner bind too.
  const burner = intent === 'link' ? (ctx.request as LinkDeviceRequest | null)?.burner ?? null : null;
  if (has(r, 'consent') && (!isPlainObject(r.consent) || !hasExactKeys(r.consent, burner === null ? CONSENT_KEYS : OWN_BURN_CONSENT_KEYS))) return fail('keys');
  if (status === 'error' && !(LINK_ERRORS[intent] as readonly unknown[]).includes(r.error)) return fail('error');
  if (status === 'rejected' || status === 'error') return { ok: true, answer: r as unknown as LinkAnswer };
  if (!isEonAddress(r.qnet)) return fail('qnet');
  const qnet = r.qnet;
  if (intent === 'connect') {
    return isSolanaAddress(r.solana) ? { ok: true, answer: r as unknown as LinkAnswer } : fail('solana');
  }
  if (intent === 'reserve') {
    // The request names the wallet, and the wallet's own key signs the reservation: no check number.
    const request = ctx.request as ReserveRequest | null;
    if (!request || walletHash(qnet) !== request.walletHash) return fail('walletHash');
    if (!isU64String(r.time)) return fail('time');
    const time = Number(r.time);
    if (time < ctx.nowS - RESERVE_ANSWER_PAST_S || time > ctx.nowS + RESERVE_ANSWER_FUTURE_S) return fail('time');
    const publicKey = decodeB64url(r.pk, MLDSA65_PUBLIC_KEY_BYTES);
    if (!publicKey || eonOfPublicKey(publicKey) !== qnet) return fail('pk');
    const signature = decodeB64url(r.sig, MLDSA65_SIGNATURE_BYTES);
    let verified = false;
    try {
      verified = signature !== null && ctx.verifyReservation !== undefined
        && ctx.verifyReservation({ wallet: qnet, burner: request.burner, time: r.time, publicKey, signature }) === true;
    } catch {
      verified = false;
    }
    return verified ? { ok: true, answer: r as unknown as LinkAnswer } : fail('sig');
  }
  const nodeId = lightNodeId(qnet);
  if (r.nodeId !== nodeId) return fail('nodeId');
  const wanted = ctx.request?.walletHash ?? null;
  if (wanted !== null && walletHash(qnet) !== wanted) return fail('walletHash');
  if (intent === 'link' && status === 'ok') {
    if (typeof r.bound !== 'boolean') return fail('bound');
    const consent = r.consent as Record<string, unknown>;
    if (!isU64String(consent.ts)) return fail('ts');
    const ts = Number(consent.ts);
    const past = ctx.consent24h ? CONSENT_PAST_S : CONSENT_PAST_S_BEFORE_24H;
    if (ts < ctx.nowS - past || ts > ctx.nowS + CONSENT_FUTURE_S) return fail('ts');
    const pk = decodeB64url(consent.pk, MLDSA65_PUBLIC_KEY_BYTES);
    if (!pk || eonOfPublicKey(pk) !== qnet) return fail('pk');
    const sig = decodeB64url(consent.sig, MLDSA65_SIGNATURE_BYTES);
    const message = utf8Bytes(consentMessage(nodeId, qnet, consentProof(burnTx as string, nodeId, qnet), consent.ts));
    let verified = false;
    try {
      verified = sig !== null && ctx.verify !== undefined && ctx.verify(pk, message, sig) === true;
    } catch {
      verified = false;
    }
    if (!verified) return fail('sig');
    if (burner !== null) {
      const ownerSig = decodeB64url(consent.ownerSig, ED25519_SIGNATURE_BYTES);
      if (!ownerSig || !verifyOwnerBind(qnet, pk, burnTx as string, consent.ts, burner, ownerSig)) return fail('ownerSig');
    }
  }
  if (status === 'linked' && !isU64String(r.seq)) return fail('seq');
  if (intent === 'unlink' && typeof r.unbound !== 'boolean') return fail('unbound');
  if (intent === 'claim' && status === 'ok') {
    // At least 1 QNC, or any amount above zero when the node's quote stopped at an epoch (`stoppedAtEpoch` set: more
    // epochs remain), so a balance spread over many small epochs can always be moved in several claims (owner
    // decision, 27.09, EXT-R1-03 option (a)).
    if (!isU64String(r.amountNano)) return fail('amountNano');
    const amount = BigInt(r.amountNano);
    if (amount === 0n || (amount < CLAIM_MIN_NANO && r.stoppedAtEpoch === null)) return fail('amountNano');
    if (typeof r.txHash !== 'string' || !TX_HASH_RE.test(r.txHash)) return fail('txHash');
    if (r.stoppedAtEpoch !== null && !isU64String(r.stoppedAtEpoch)) return fail('stoppedAtEpoch');
  }
  return { ok: true, answer: r as unknown as LinkAnswer };
}

// The check number as the app and the page show it: six digits in two groups of three.
export function formatCheckNumber(value: number): string {
  const digits = String(value % 1_000_000).padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

// ---------------------------------------------------------------- extension: qnet_activateNode (section 10)

export const NODE_TYPES = ['light', 'super'] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export type ActivationStatus = 'ok' | 'exists' | 'pending' | 'rejected' | 'error';

const ACTIVATION_STATUSES: readonly ActivationStatus[] = ['ok', 'exists', 'pending', 'rejected', 'error'];
const ACTIVATION_MAX_BYTES = 1024;

// Section 7 of revision 1: the codes of an activation answer.
export const ERROR_CODES = [
  'PRICE_UNAVAILABLE', 'PHASE_UNSUPPORTED', 'PRICE_CHANGED', 'INSUFFICIENT_SOL', 'INSUFFICIENT_TOKENS',
  'SIMULATION_FAILED', 'TX_FAILED', 'SOLANA_UNAVAILABLE', 'HISTORY_TOO_LONG', 'NODE_EXISTS', 'BURN_UNUSABLE',
  'BURN_IN_PROGRESS', 'NO_WALLET', 'INTERNAL',
] as const;
export type ActivationErrorCode = (typeof ERROR_CODES)[number];

// The extension's qnet_activateNode result that passed every check of section 7.2, read as an answer.
export interface ActivationAnswer {
  v: 1;
  intent: 'activate';
  status: ActivationStatus;
  qnet?: string;
  solana?: string;
  nodeType?: NodeType;
  burnTx?: string;
  burnAmount?: number;
  code?: string;
  error?: ActivationErrorCode;
  // Section 7.1: a burn of the answering device that went through and is not the wallet's activation.
  supersededBurnTx?: string;
}

const ADDRESS_KEYS = ['qnet', 'solana'];
const ACTIVATION_KEYS = ['nodeType', 'burnTx', 'burnAmount', 'code'];

// The optional key of section 7.1: only in an `exists` answer.
function marksFor(status: ActivationStatus, r: Record<string, unknown>): string[] {
  return status === 'exists' && has(r, 'supersededBurnTx') ? ['supersededBurnTx'] : [];
}

function activationKeys(status: ActivationStatus, r: Record<string, unknown>): string[] {
  if (status === 'rejected') return BASE_KEYS;
  if (status === 'error') return [...BASE_KEYS, 'error'];
  const marks = marksFor(status, r);
  if (status === 'pending') return [...BASE_KEYS, ...ADDRESS_KEYS, 'nodeType', 'burnTx', 'burnAmount', ...marks];
  return [...BASE_KEYS, ...ADDRESS_KEYS, ...ACTIVATION_KEYS, ...marks];
}

export type ActivationCheck = { ok: true; answer: ActivationAnswer } | { ok: false; reason: string };

// Section 7.2 for the extension's answer (`{v: 1, intent: "activate", ...result}`), in its order.
export function validateActivation(plaintext: string, nodeType: NodeType): ActivationCheck {
  const fail = (reason: string): ActivationCheck => ({ ok: false, reason });
  if (typeof plaintext !== 'string' || byteLength(plaintext) > ACTIVATION_MAX_BYTES) return fail('size');
  const r = parseObject(plaintext);
  if (!r) return fail('json');
  if (r.v !== 1) return fail('v');
  if (r.intent !== 'activate') return fail('intent');
  const status = r.status as ActivationStatus;
  if (!ACTIVATION_STATUSES.includes(status)) return fail('status');
  if (!hasExactKeys(r, activationKeys(status, r))) return fail('keys');
  if (status === 'error' && !(ERROR_CODES as readonly unknown[]).includes(r.error)) return fail('error');
  if (has(r, 'qnet') && !isEonAddress(r.qnet)) return fail('qnet');
  if (has(r, 'solana') && !isSolanaAddress(r.solana)) return fail('solana');
  if (has(r, 'nodeType')) {
    if (!(NODE_TYPES as readonly unknown[]).includes(r.nodeType)) return fail('nodeType');
    if (status === 'ok' && r.nodeType !== nodeType) return fail('nodeType');
    if (!isSolanaSignature(r.burnTx)) return fail('burnTx');
    const amount = r.burnAmount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1 || amount > BURN_AMOUNT_MAX) {
      return fail('burnAmount');
    }
  }
  if (has(r, 'code')) {
    if (typeof r.code !== 'string' || !CODE_RE.test(r.code)) return fail('code');
    const of = (address: string) => activationCode(r.nodeType as NodeType, address, r.burnTx as string, r.burnAmount as number);
    // A light node's activation from a payment key of aiqnet.io carries the wallet's QNet address (owner rule, 26.09).
    const wallet = r.nodeType === 'light' && of(r.qnet as string) === r.code;
    if (of(r.solana as string) !== r.code && !wallet) return fail('code');
  }
  if (has(r, 'supersededBurnTx') && (!isSolanaSignature(r.supersededBurnTx) || r.supersededBurnTx === r.burnTx)) {
    return fail('supersededBurnTx');
  }
  return { ok: true, answer: r as unknown as ActivationAnswer };
}

export type ExtensionFailure =
  | 'rejected' | 'cooldown' | 'unauthorized' | 'unsupported' | 'disconnected' | 'timeout' | 'failed' | 'unverifiable';
export type ExtensionActivation = { ok: true; answer: ActivationAnswer } | { ok: false; failure: ExtensionFailure };

// The extension's result {status, ...} read as the answer {v: 1, intent, ...result}; a result that names v
// or intent itself, or cannot be copied as JSON, is refused.
export function extensionAnswerText(result: unknown, intent: 'activate' | 'claim' | 'unlink' = 'activate'): string | null {
  try {
    const copy: unknown = JSON.parse(JSON.stringify(result));
    if (!isPlainObject(copy) || has(copy, 'v') || has(copy, 'intent')) return null;
    return JSON.stringify({ v: 1, intent, ...copy });
  } catch {
    return null;
  }
}

// A provider call that threw, by its protocol code (applications/qnet-wallet CONTRACTS.md 4.5); 4200 is an
// extension too old for the method.
function providerFailure(err: unknown): ExtensionFailure {
  if (err instanceof Error && err.message === 'timeout' && errorCode(err) === null) return 'timeout';
  switch (errorCode(err)) {
    case 4001:
      return isApprovalCooldown(err) ? 'cooldown' : 'rejected';
    case 4100:
      return 'unauthorized';
    case 4200:
      return 'unsupported';
    case 4900:
      return 'disconnected';
    default:
      return 'failed';
  }
}

// Section 10: the extension builds, signs and sends the burn itself after its own approval window;
// the site only names the node type and checks what comes back.
export async function activateWithExtension(provider: QNetProvider, nodeType: NodeType): Promise<ExtensionActivation> {
  let result: unknown;
  try {
    result = await callProvider(provider, 'qnet_activateNode', ACTIVATE_TIMEOUT_MS, { nodeType });
  } catch (err) {
    return { ok: false, failure: providerFailure(err) };
  }
  const text = extensionAnswerText(result);
  const checked = text === null ? null : validateActivation(text, nodeType);
  return checked?.ok ? { ok: true, answer: checked.answer } : { ok: false, failure: 'unverifiable' };
}

// ---------------------------------------------------------------- extension: qnet_getActivation (read-only)

// What the extension holds of its own wallet's activation, read without a window (shared contract C5): no wallet, locked,
// this site not connected, a search or an activation still running, a search that could not finish, a burn no code comes
// from, none (the search finished with nothing), a burn on its way, or the activation with its code. `paidOnSite`: the
// light burn of a payment address of aiqnet.io, whose code names the QNet wallet.
export type GetActivation =
  | { status: 'no_wallet' }
  | { status: 'locked' }
  | { status: 'not_connected' }
  | { status: 'searching'; qnet: string; solana: string }
  | { status: 'unknown'; qnet: string; solana: string; reason: 'SOLANA_UNAVAILABLE' | 'HISTORY_TOO_LONG' }
  | { status: 'unusable'; qnet: string; solana: string }
  | { status: 'none'; qnet: string; solana: string }
  | { status: 'pending'; qnet: string; solana: string; nodeType: NodeType; burnTx: string; burnAmount: number }
  | { status: 'exists'; qnet: string; solana: string; nodeType: NodeType; burnTx: string; burnAmount: number; code: string; paidOnSite: boolean };

const GET_ACTIVATION_KEYS: Record<GetActivation['status'], readonly string[]> = {
  no_wallet: ['status'],
  locked: ['status'],
  not_connected: ['status'],
  searching: ['status', 'qnet', 'solana'],
  unknown: ['status', 'qnet', 'solana', 'reason'],
  unusable: ['status', 'qnet', 'solana'],
  none: ['status', 'qnet', 'solana'],
  pending: ['status', 'qnet', 'solana', 'nodeType', 'burnTx', 'burnAmount'],
  exists: ['status', 'qnet', 'solana', 'nodeType', 'burnTx', 'burnAmount', 'code', 'paidOnSite'],
};
const GET_ACTIVATION_TIMEOUT_MS = 5_000;

const isBurnAmountValue = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= BURN_AMOUNT_MAX;

// Exactly one of the shapes of C5, each value of its form, and in `exists` the code its burn gives: from the burner's
// Solana address, or with `paidOnSite` a light code from the QNet address.
export function validateGetActivation(value: unknown): GetActivation | null {
  let r: unknown;
  try {
    r = JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
  if (!isPlainObject(r) || typeof r.status !== 'string' || !has(GET_ACTIVATION_KEYS, r.status)) return null;
  const status = r.status as GetActivation['status'];
  if (!hasExactKeys(r, GET_ACTIVATION_KEYS[status])) return null;
  if (has(r, 'qnet') && (!isEonAddress(r.qnet) || !isSolanaAddress(r.solana))) return null;
  if (status === 'unknown' && r.reason !== 'SOLANA_UNAVAILABLE' && r.reason !== 'HISTORY_TOO_LONG') return null;
  if (status === 'pending' || status === 'exists') {
    if (!(NODE_TYPES as readonly unknown[]).includes(r.nodeType) || !isSolanaSignature(r.burnTx) || !isBurnAmountValue(r.burnAmount)) return null;
  }
  if (status === 'exists') {
    if (typeof r.paidOnSite !== 'boolean' || !isActivationCode(r.code)) return null;
    if (r.paidOnSite && r.nodeType !== 'light') return null;
    const from = r.paidOnSite ? (r.qnet as string) : (r.solana as string);
    if (activationCode(r.nodeType as NodeType, from, r.burnTx as string, r.burnAmount as number) !== r.code) return null;
  }
  return r as unknown as GetActivation;
}

export type ExtensionActivationRead = { ok: true; value: GetActivation } | { ok: false; failure: ExtensionFailure };

// qnet_getActivation: never a window. An extension too old for the method answers 4200 (`unsupported`).
export async function getExtensionActivation(provider: QNetProvider): Promise<ExtensionActivationRead> {
  let result: unknown;
  try {
    result = await callProvider(provider, 'qnet_getActivation', GET_ACTIVATION_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, failure: providerFailure(err) };
  }
  const value = validateGetActivation(result);
  return value ? { ok: true, value } : { ok: false, failure: 'unverifiable' };
}

// ---------------------------------------------------------------- extension: qnet_claimNodeBalance (section 14.10)

// The user reads the amount in the approval window.
const CLAIM_TIMEOUT_MS = 5 * 60_000;

// `other_wallet`: a checked answer for another wallet than the one the page shows.
export type ClaimFailure = ExtensionFailure | 'other_wallet';
export type ExtensionClaim = { ok: true; answer: LinkAnswer } | { ok: false; failure: ClaimFailure };

// The extension moves the node balance of its own wallet's light node; its result is the `claim` answer of
// section 14.7 without v and intent, checked like the app's for the wallet the page shows.
export async function claimWithExtension(provider: QNetProvider, wallet: string, nowS: number): Promise<ExtensionClaim> {
  let result: unknown;
  try {
    result = await callProvider(provider, 'qnet_claimNodeBalance', CLAIM_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, failure: providerFailure(err) };
  }
  const text = extensionAnswerText(result, 'claim');
  if (text === null) return { ok: false, failure: 'unverifiable' };
  const checked = validateAnswer(text, { intent: 'claim', request: { walletHash: walletHash(wallet) }, nowS, consent24h: false });
  if (checked.ok) return { ok: true, answer: checked.answer };
  return { ok: false, failure: checked.reason === 'walletHash' ? 'other_wallet' : 'unverifiable' };
}

// ---------------------------------------------------------------- extension: qnet_unlinkNodeDevice (section 14.10)

const UNLINK_TIMEOUT_MS = 5 * 60_000;

export type ExtensionUnlink = ExtensionClaim;

// The extension unlinks its own wallet's light node from the device that runs it, with the wallet's own unbind; its
// result is the `unlink` answer of section 14.7 without v and intent, checked like the app's for the wallet the page
// shows. An extension without the method answers 4200 (`unsupported`).
export async function unlinkWithExtension(provider: QNetProvider, wallet: string, nowS: number): Promise<ExtensionUnlink> {
  let result: unknown;
  try {
    result = await callProvider(provider, 'qnet_unlinkNodeDevice', UNLINK_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, failure: providerFailure(err) };
  }
  const text = extensionAnswerText(result, 'unlink');
  if (text === null) return { ok: false, failure: 'unverifiable' };
  const checked = validateAnswer(text, { intent: 'unlink', request: { walletHash: walletHash(wallet) }, nowS, consent24h: false });
  if (checked.ok) return { ok: true, answer: checked.answer };
  return { ok: false, failure: checked.reason === 'walletHash' ? 'other_wallet' : 'unverifiable' };
}
