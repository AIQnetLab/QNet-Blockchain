/**
 * The bytes a light node's wallet key, ping key and device key sign (docs/protocols/light-node-messages.md), one
 * copy for the app and the extension's crypto bundle. Pure JS, no native calls: every builder checks its fields, so
 * nothing malformed is ever signed. Known answers: docs/protocols/light-node.vectors.json
 * (__tests__/LightNodeVectors.test.js; the extension's test/light-node-vectors.test.mjs).
 */

import { blake3 } from '@noble/hashes/blake3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { QNET_CHAIN_TAG, isValidQnetAddress } from './WalletIdentity.js';

// The decimal network id inside the chain tag "q1337|".
export const QNET_CHAIN_ID = QNET_CHAIN_TAG.slice(1, -1);
export const EPOCH_BLOCKS = 14400;
export const DEVICE_PLATFORM_BYTE = Object.freeze({ ios: 1, android: 2 });

const NODE_ID_RE = /^light_mobile_[0-9a-f]{16}$/;
const HEX32_RE = /^[0-9a-f]{64}$/;
const PROOF_RE = /^[0-9a-f]{32}$/;
const MLDSA_PK_RE = /^[0-9a-f]{3904}$/;
const MLDSA_SIG_RE = /^[0-9a-f]{6618}$/;
const HW_PUB_RE = /^04[0-9a-f]{128}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const BURN_TX_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const U64_MAX = '18446744073709551615';

function fail(name) {
  throw new TypeError(`NodePreimages: invalid ${name}`);
}

function match(value, re, name) {
  if (typeof value !== 'string' || !re.test(value)) fail(name);
  return value;
}

/** A u64 as its canonical decimal string, from a safe non-negative integer or such a string. */
function u64(value, name) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  const inRange = (s) => s.length < U64_MAX.length || s <= U64_MAX; // equal-length digit strings compare as numbers
  if (typeof value === 'string' && U64_RE.test(value) && inRange(value)) return value;
  return fail(name);
}

/** A block height: a safe non-negative integer, as a number or its decimal string. */
function heightOf(value) {
  const s = u64(value, 'height');
  return Number(s) <= Number.MAX_SAFE_INTEGER ? s : fail('height');
}

const nodeIdOf = (v) => match(v, NODE_ID_RE, 'nodeId');
const walletOf = (v) => (isValidQnetAddress(v) ? v : fail('wallet'));
const sha3Hex = (x) => bytesToHex(sha3_256(typeof x === 'string' ? utf8ToBytes(x) : x));

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url of bytes. */
export function b64url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] * 65536 + (bytes[i + 1] || 0) * 256 + (bytes[i + 2] || 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += B64URL[Math.floor(n / 64 ** (3 - j)) % 64];
  }
  return out;
}

function b64urlBytes(text, name) {
  match(text, /^[A-Za-z0-9_-]+$/, name);
  if (text.length % 4 === 1) fail(name);
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  for (let i = 0, o = 0; i < text.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) n = n * 64 + (i + j < text.length ? B64URL.indexOf(text[i + j]) : 0);
    for (let k = 0; k < 3 && o < out.length; k++) out[o++] = Math.floor(n / 256 ** (2 - k)) % 256;
  }
  if (b64url(out) !== text) fail(name); // non-zero padding bits
  return out;
}

// ---- identity ----

/** The light node id of a wallet: "light_mobile_" + first 16 hex of BLAKE3("LIGHT_NODE_PRIVACY_" + wallet). */
export function lightNodeId(wallet) {
  return `light_mobile_${bytesToHex(blake3(utf8ToBytes(`LIGHT_NODE_PRIVACY_${walletOf(wallet)}`))).slice(0, 16)}`;
}

/** The registration proof: first 32 hex of BLAKE3("{burnTx}:{nodeId}:{wallet}"). */
export function registrationProof(burnTx, nodeId, wallet) {
  const text = `${match(burnTx, BURN_TX_RE, 'burnTx')}:${nodeIdOf(nodeId)}:${walletOf(wallet)}`;
  return bytesToHex(blake3(utf8ToBytes(text))).slice(0, 32);
}

/** SHA3-256 hex of an ML-DSA-65 public key given as hex (the attest root tag of a wallet key). */
export function publicKeySha3(publicKeyHex) {
  return sha3Hex(hexToBytes(match(publicKeyHex, MLDSA_PK_RE, 'publicKey')));
}

/** SHA3-256 hex of a push token or endpoint; the empty string for a device without one. */
export function pushTargetSha3(target) {
  if (typeof target !== 'string') fail('pushTarget');
  return sha3Hex(target);
}

export function epochOf(height) {
  return Math.floor(Number(heightOf(height)) / EPOCH_BLOCKS);
}

// ---- wallet-key and ping-key messages (section 4) ----

export function consentPreimage(nodeId, wallet, proof, ts) {
  return `${QNET_CHAIN_TAG}client_node_reg:${nodeIdOf(nodeId)}:${walletOf(wallet)}:${match(proof, PROOF_RE, 'proof')}:${u64(ts, 'ts')}`;
}

/**
 * The burner's owner bind: the cabinet's payment key, the extension's Solana key, or the app's own Solana key for a burn
 * made from the wallet's own Solana address signs it; the app signs no other burner's.
 */
export function ownerBindPreimage(nodeId, wallet, proof, ts, walletPublicKeyHex, burnTx) {
  return `qnet_onchain_reg:${nodeIdOf(nodeId)}:${walletOf(wallet)}:${match(proof, PROOF_RE, 'proof')}:${u64(ts, 'ts')}:`
    + `${publicKeySha3(walletPublicKeyHex)}:${match(burnTx, BURN_TX_RE, 'burnTx')}`;
}

// Chain-tagged: the node takes a binding on its delegation alone, and one wallet key names the same node on every chain.
export function delegationPreimage(pingPublicKeyHex, nodeId, seq) {
  return `${QNET_CHAIN_TAG}delegate_ping:v2:${match(pingPublicKeyHex, MLDSA_PK_RE, 'pingPublicKey')}:${nodeIdOf(nodeId)}:`
    + `${u64(seq, 'seq')}`;
}

export function attachPreimage(nodeId, pingPublicKeyHex, pushTarget, seq, ts) {
  return `${QNET_CHAIN_TAG}light_attach:${nodeIdOf(nodeId)}:${publicKeySha3(pingPublicKeyHex)}:${pushTargetSha3(pushTarget)}:`
    + `${u64(seq, 'seq')}:${u64(ts, 'ts')}`;
}

export function tokenRefreshPreimage(nodeId, pushTarget, seq, ts) {
  return `${QNET_CHAIN_TAG}token_refresh:${nodeIdOf(nodeId)}:${pushTargetSha3(pushTarget)}:${u64(seq, 'seq')}:${u64(ts, 'ts')}`;
}

export function unbindPreimage(nodeId, seq, ts) {
  return `${QNET_CHAIN_TAG}light_unbind:${nodeIdOf(nodeId)}:${u64(seq, 'seq')}:${u64(ts, 'ts')}`;
}

/**
 * The unbind the wallet key signs from any device that holds the wallet: it withdraws the binding `seq` (the one the
 * node's signed status names while a device is bound), whichever device holds it. Its own token, so it can never pass
 * for the ping key's unbind.
 */
export function walletUnbindPreimage(nodeId, seq, ts) {
  return `${QNET_CHAIN_TAG}light_unbind_wallet:${nodeIdOf(nodeId)}:${u64(seq, 'seq')}:${u64(ts, 'ts')}`;
}

/** The challenge the ping key signs every epoch: a canonical block of the current epoch. */
export function answerChallenge(height, hash) {
  return `selfattest:${heightOf(height)}:${match(hash, HEX32_RE, 'hash')}`;
}

export function claimQuotePreimage(nodeId, wallet) {
  return `${QNET_CHAIN_TAG}claim_rewards:${nodeIdOf(nodeId)}:${walletOf(wallet)}`;
}

/** The claim payload: `claimsData` is the exact string the node quoted. */
export function claimPayloadPreimage(wallet, ts, claimsData) {
  if (typeof claimsData !== 'string' || claimsData.length === 0) fail('claimsData');
  return `${QNET_CHAIN_TAG}qnet_claim_v1:${walletOf(wallet)}:${u64(ts, 'ts')}:${sha3Hex(claimsData)}`;
}

export function statusPreimage(nodeId, ts) {
  return `${QNET_CHAIN_TAG}light_status:${nodeIdOf(nodeId)}:${u64(ts, 'ts')}`;
}

/** The signed poll of the pending-challenge route, by the ping key: only such a poll counts as the challenge fetched. */
export function pollPreimage(nodeId, ts) {
  return `${QNET_CHAIN_TAG}light_poll:${nodeIdOf(nodeId)}:${u64(ts, 'ts')}`;
}

// ---- device messages (section 5) ----

const D = `|${QNET_CHAIN_ID}|`;
const REPORT_KEYS = ['arc', 'automotive', 'embedded', 'feature_pc', 'hsum', 'leanback', 'system_user', 'touchscreen', 'watch'];
const FLAGS_RE = /^(mac=0,vision=0,idiom=(phone|pad)|r=[0-9a-f]{64})$/;

export function iosFlags(idiom) {
  if (idiom !== 'phone' && idiom !== 'pad') fail('idiom');
  return `mac=0,vision=0,idiom=${idiom}`;
}

/** The Android device report: canonical JSON of the nine booleans in this order, no spaces. */
export function androidReport(fields) {
  if (!fields || typeof fields !== 'object') fail('report');
  for (const k of REPORT_KEYS) if (typeof fields[k] !== 'boolean') fail(`report.${k}`);
  return `{${REPORT_KEYS.map((k) => `"${k}":${fields[k]}`).join(',')}}`;
}

export function androidFlags(reportText) {
  if (typeof reportText !== 'string' || reportText.length === 0) fail('report');
  return `r=${sha3Hex(reportText)}`;
}

export function enrolPreimage({ nodeId, wallet, pingPublicKey, seq, nonce, flags }) {
  return `qnet_dev_enrol:v1${D}${nodeIdOf(nodeId)}|${walletOf(wallet)}|${publicKeySha3(pingPublicKey)}|${u64(seq, 'seq')}|`
    + `${match(nonce, NONCE_RE, 'nonce')}|${match(flags, FLAGS_RE, 'flags')}`;
}

/** `oldHwPublicKey`: the 65-byte uncompressed P-256 point of the key being replaced, as hex. */
export function rotatePreimage({ nodeId, oldHwPublicKey, pingPublicKey, seq, nonce }) {
  return `qnet_dev_rotate:v1${D}${nodeIdOf(nodeId)}|${hwPublicKeySha3(oldHwPublicKey)}|${publicKeySha3(pingPublicKey)}|`
    + `${u64(seq, 'seq')}|${match(nonce, NONCE_RE, 'nonce')}`;
}

export function rebindPreimage({ fromNodeId, toNodeId, seq, nonce }) {
  return `qnet_dev_rebind:v1${D}${nodeIdOf(fromNodeId)}|${nodeIdOf(toNodeId)}|${u64(seq, 'seq')}|${match(nonce, NONCE_RE, 'nonce')}`;
}

export function refreshPreimage(nodeId, nonce) {
  return `qnet_dev_refresh:v1${D}${nodeIdOf(nodeId)}|${match(nonce, NONCE_RE, 'nonce')}`;
}

export function releasePreimage(nodeId, seq, nonce) {
  return `qnet_dev_release:v1${D}${nodeIdOf(nodeId)}|${u64(seq, 'seq')}|${match(nonce, NONCE_RE, 'nonce')}`;
}

/** What the device key signs with every ping reply; `sigma` is the ping key's raw signature as hex. */
export function hwPingPreimage({ nodeId, height, hash, sigma, hwSeq }) {
  const h = heightOf(height);
  return `qnet_hwping:v2${D}${nodeIdOf(nodeId)}|${epochOf(h)}|${h}|${match(hash, HEX32_RE, 'hash')}|`
    + `${sha3Hex(hexToBytes(match(sigma, MLDSA_SIG_RE, 'sigma')))}|${u64(hwSeq, 'hwSeq')}`;
}

/** The ping reply's `signature` parameter: the ping key's signature, the device signature (b64url), hw_seq. */
export function pingWire(sigma, hwSignatureB64url, hwSeq) {
  b64urlBytes(hwSignatureB64url, 'hwSignature');
  return `ping_hw2:${match(sigma, MLDSA_SIG_RE, 'sigma')}.${hwSignatureB64url}.${u64(hwSeq, 'hwSeq')}`;
}

export function hwPublicKeySha3(hwPublicKeyHex) {
  return sha3Hex(hexToBytes(match(hwPublicKeyHex, HW_PUB_RE, 'hwPublicKey')));
}

/** SHA-256 of a device preimage: the iOS clientDataHash and the Android attestation challenge. */
export function deviceChallengeHash(preimage) {
  if (typeof preimage !== 'string' || preimage.length === 0) fail('preimage');
  return sha256(utf8ToBytes(preimage));
}

/** Play Integrity nonce of an enrolment: b64url(SHA-256(E || SHA3-256(hw_pub) || SHA3-256(report))). */
export function playNonceForEnrol(enrolText, hwPublicKeyHex, reportText) {
  if (typeof enrolText !== 'string' || typeof reportText !== 'string') fail('preimage');
  const pub = hexToBytes(match(hwPublicKeyHex, HW_PUB_RE, 'hwPublicKey'));
  return b64url(sha256(concatBytes(utf8ToBytes(enrolText), sha3_256(pub), sha3_256(utf8ToBytes(reportText)))));
}

/** Play Integrity nonce of a rotation, refresh or release: b64url(SHA-256(preimage)). */
export function playNonce(preimage) {
  return b64url(deviceChallengeHash(preimage));
}

/** device_tag as hex: SHA3-256("qnet_device_tag:v1|" || chain id || "|" || platform byte || hw_pub). */
export function deviceTag(platform, hwPublicKeyHex) {
  const byte = DEVICE_PLATFORM_BYTE[platform];
  if (!byte) fail('platform');
  const pub = hexToBytes(match(hwPublicKeyHex, HW_PUB_RE, 'hwPublicKey'));
  return sha3Hex(concatBytes(utf8ToBytes(`qnet_device_tag:v1|${QNET_CHAIN_ID}|`), Uint8Array.of(byte), pub));
}

/** device_tag_h of the signed status for its nonce of 16 bytes (32 hex). */
export function deviceTagH(nonceHex, deviceTagHex) {
  const nonce = hexToBytes(match(nonceHex, /^[0-9a-f]{32}$/, 'nonce'));
  const tag = hexToBytes(match(deviceTagHex, HEX32_RE, 'deviceTag'));
  return sha3Hex(concatBytes(utf8ToBytes('qnet_device_tag_h:v1|'), nonce, tag)).slice(0, 16);
}

/** The support reference for a device message's challenge nonce (b64url, 32 bytes). */
export function resetRef(nonce, deviceTagHex) {
  const n = b64urlBytes(match(nonce, NONCE_RE, 'nonce'), 'nonce');
  const tag = hexToBytes(match(deviceTagHex, HEX32_RE, 'deviceTag'));
  return sha3Hex(concatBytes(utf8ToBytes('qnet_dev_ref:v1|'), n, tag)).slice(0, 8);
}
