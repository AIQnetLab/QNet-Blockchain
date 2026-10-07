#!/usr/bin/env node
// Shared test vectors for the light node contracts, one file for the app, the extension, the site and the node:
//   - the light node messages and the device layer (docs/protocols/light-node-messages.md);
//   - QNet Link revision 2 (docs/protocols/qnet-link-v1.md section 14).
// SHA-2, SHA-3, SHAKE256, PBKDF2, X25519, HKDF, AES-GCM, Ed25519 and every P-256 check come from node:crypto.
// BLAKE3 and the RFC 6979 nonce are written out here and checked against published answers and against every
// @noble/hashes a client package resolves. ML-DSA-65 (FIPS 204, deterministic; an empty context, and the context
// QNET_OFFCHAIN_MSG_v1 for the wallet's signed reservation of a `reserve` answer) comes from the @noble/post-quantum a
// client package resolves; every other resolvable copy verifies each signature again.
//
//   node docs/protocols/tools/light-node-vectors.mjs            write ../light-node.vectors.json
//   node docs/protocols/tools/light-node-vectors.mjs --check    exit 1 if the file differs from a fresh run

import {
  createCipheriv, createDecipheriv, createECDH, createHash, createHmac, createPrivateKey, createPublicKey,
  diffieHellman, hkdfSync, pbkdf2Sync, sign as nodeSign, verify as nodeVerify,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const OUT = resolve(HERE, '../light-node.vectors.json');
// Packages whose @noble libraries sign or verify these messages; resolved from each package's directory.
export const NOBLE_PACKAGES = [
  'applications/qnet-mobile',
  'applications/qnet-wallet/tools/crypto-bundle',
  'applications/qnet-explorer/frontend',
];

// ---- constants (light-node-messages.md section 2; qnet-link-v1.md section 14.2) ----

export const CHAIN_ID = '1337';
export const CHAIN_TAG = `q${CHAIN_ID}|`;
export const EPOCH_BLOCKS = 14400;
const WALLET_SEED_PREFIX = 'QNET_WALLET_MLDSA65_v1:';
const MLDSA65 = Object.freeze({ PUBLIC_KEY_BYTES: 1952, SIGNATURE_BYTES: 3309 });
export const PLATFORM_BYTE = Object.freeze({ ios: 1, android: 2 });
// A sample Team ID: the real one is the owner's (App Store Connect); rpIdHash = SHA-256("<TeamID>.com.qnetmobile").
const SAMPLE_TEAM_ID = 'ABCDE12345';
const IOS_BUNDLE_ID = 'com.qnetmobile';

export const LINK2 = Object.freeze({
  PREFIX: 'https://link.aiqnet.io/l#v1.',
  RE: /^https:\/\/link\.aiqnet\.io\/l#v1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})\.(connect|link|claim|reserve|unlink)(?:\.([A-Za-z0-9_-]{43}))?$/,
  ANDROID_PACKAGE: 'io.aiqnet.wallet',
  HKDF_INFO: 'qnet-link-v1',
  SAS_INFO: 'qnet-link-v1-sas',
  AAD_PREFIX: 'qnet-link-v1|',
  WALLET_HASH_PREFIX: 'qnet-link-wallet:',
  SESSION_TTL_S: 600,
  SESSION_BODY_MAX_BYTES: 2048,
  CAPS: Object.freeze({
    connect: Object.freeze({ plaintext: 1024, ct: 1040, body: 4096 }),
    link: Object.freeze({ plaintext: 8192, ct: 8208, body: 12288 }),
    claim: Object.freeze({ plaintext: 1024, ct: 1040, body: 4096 }),
    reserve: Object.freeze({ plaintext: 8192, ct: 8208, body: 12288 }),
    unlink: Object.freeze({ plaintext: 1024, ct: 1040, body: 4096 }),
  }),
  CT_MIN_BYTES: 17,
  INTENTS: ['connect', 'link', 'claim', 'reserve', 'unlink'],
  STATUSES: Object.freeze({
    connect: ['ok', 'rejected', 'error'],
    link: ['ok', 'linked', 'rejected', 'error'],
    claim: ['ok', 'empty', 'rejected', 'error'],
    reserve: ['ok', 'rejected', 'error'],
    unlink: ['ok', 'rejected', 'error'],
  }),
  ERRORS: Object.freeze({
    connect: ['NO_WALLET', 'INTERNAL'],
    link: ['NO_WALLET', 'WALLET_MISMATCH', 'NO_NODE', 'NODE_OTHER', 'NETWORK', 'BIND_REFUSED', 'INTERNAL'],
    claim: ['NO_WALLET', 'WALLET_MISMATCH', 'NO_NODE', 'NETWORK', 'CLAIM_REFUSED', 'CLAIM_BUSY', 'INTERNAL'],
    reserve: ['NO_WALLET', 'WALLET_MISMATCH', 'NODE_OTHER', 'NETWORK', 'INTERNAL'],
    unlink: ['NO_WALLET', 'WALLET_MISMATCH', 'NOT_LINKED', 'NETWORK', 'UNLINK_REFUSED', 'INTERNAL'],
  }),
  CONSENT_PAST_S: 86400,
  CONSENT_PAST_LEGACY_S: 300,
  CONSENT_FUTURE_S: 300,
  // The site takes a `reserve` answer's time from 15 minutes before its clock to 5 minutes after.
  RESERVE_PAST_S: 900,
  RESERVE_FUTURE_S: 300,
  CLAIM_MIN_NANO: 1_000_000_000n,
});

// The wallet's signed reservation (qnet-link-v1.md section 14): a message the wallet signs for aiqnet.io, inside the
// envelope the wallets build for a site, with the FIPS 204 context QNET_OFFCHAIN_MSG_v1.
export const SITE_RECORD = Object.freeze({
  ORIGIN: 'https://aiqnet.io',
  HEADER: 'QNet Signed Message:\n',
  CONTEXT: 'QNET_OFFCHAIN_MSG_v1',
  CLUSTER: 'devnet',
});
export const reservationMessage = (wallet, nodeType, way, burner, time) =>
  `QNet node reservation v1\nwallet: ${wallet}\nnode: ${nodeType}\nway: ${way}\nburner: ${burner}\ntime: ${time}\ncluster: ${SITE_RECORD.CLUSTER}`;
export const siteRecordEnvelope = (message) => {
  const body = Buffer.from(message, 'utf8');
  return Buffer.concat([Buffer.from(`${SITE_RECORD.HEADER}${SITE_RECORD.ORIGIN}\n${body.length}\n`, 'utf8'), body]);
};

// ---- encodings ----

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(s, 'hex');
const b64u = (b) => Buffer.from(b).toString('base64url');
const utf8 = (s) => Buffer.from(s, 'utf8');
const cat = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? utf8(p) : Buffer.from(p))));
const sha256 = (b) => createHash('sha256').update(b).digest();
const sha512 = (b) => createHash('sha512').update(b).digest();
const sha3 = (b) => createHash('sha3-256').update(b).digest();
/** Lowercase hex of SHA3-256 over bytes, or over the UTF-8 of a string. */
export const sha3Hex = (x) => hex(sha3(typeof x === 'string' ? utf8(x) : x));
const shake256x32 = (b) => createHash('shake256', { outputLength: 32 }).update(b).digest();
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

/** Canonical unpadded base64url of exactly `len` bytes (any length when len is null), or null. */
export function decodeB64url(text, len = null) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (b64u(bytes) !== text) return null;
  return len === null || bytes.length === len ? bytes : null;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  let n = BigInt(`0x${hex(bytes) || '0'}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}

function base58Length(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 100) return -1;
  let n = 0n;
  for (const c of text) {
    const v = B58.indexOf(c);
    if (v < 0) return -1;
    n = n * 58n + BigInt(v);
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const digits = n === 0n ? 0 : Math.ceil(n.toString(16).length / 2);
  return zeros + digits;
}

export const isSolanaAddress = (s) => base58Length(s) === 32;
export const isSolanaSignature = (s) => base58Length(s) === 64;

const U64_MAX = (1n << 64n) - 1n;
/** A u64 as the canonical decimal string (no sign, no leading zero), the form every u64 takes in these JSON bodies. */
export const isU64String = (s) => typeof s === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(s) && BigInt(s) <= U64_MAX;

// ---- BLAKE3, one chunk (every input here is at most 1024 bytes) ----

const B3_IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const B3_PERM = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

function b3Compress(cv, m, blockLen, flags) {
  const s = [...cv, B3_IV[0], B3_IV[1], B3_IV[2], B3_IV[3], 0, 0, blockLen, flags];
  const g = (a, b, c, d, x, y) => {
    s[a] = (s[a] + s[b] + x) >>> 0; s[d] = rotr(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotr(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b] + y) >>> 0; s[d] = rotr(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotr(s[b] ^ s[c], 7);
  };
  let w = [...m];
  for (let round = 0; round < 7; round++) {
    g(0, 4, 8, 12, w[0], w[1]); g(1, 5, 9, 13, w[2], w[3]); g(2, 6, 10, 14, w[4], w[5]); g(3, 7, 11, 15, w[6], w[7]);
    g(0, 5, 10, 15, w[8], w[9]); g(1, 6, 11, 12, w[10], w[11]); g(2, 7, 8, 13, w[12], w[13]); g(3, 4, 9, 14, w[14], w[15]);
    w = B3_PERM.map((i) => w[i]);
  }
  return s.slice(0, 8).map((x, i) => (x ^ s[i + 8]) >>> 0);
}

/** BLAKE3 (32-byte output) of at most one 1024-byte chunk. */
export function blake3(input) {
  const data = Buffer.from(input);
  if (data.length > 1024) throw new Error('blake3: this reference takes one chunk');
  const blocks = Math.max(1, Math.ceil(data.length / 64));
  let cv = B3_IV;
  for (let i = 0; i < blocks; i++) {
    const block = Buffer.alloc(64);
    data.copy(block, 0, i * 64, Math.min(data.length, (i + 1) * 64));
    const words = Array.from({ length: 16 }, (_, j) => block.readUInt32LE(j * 4));
    const len = Math.min(64, data.length - i * 64);
    const flags = (i === 0 ? 1 : 0) | (i === blocks - 1 ? 2 | 8 : 0);
    cv = b3Compress(cv, words, len, flags);
  }
  const out = Buffer.alloc(32);
  cv.forEach((x, i) => out.writeUInt32LE(x, i * 4));
  return out;
}

// ---- P-256 ECDSA with the RFC 6979 nonce (the curve operations are OpenSSL's, through ECDH) ----

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const big = (b) => BigInt(`0x${hex(b) || '0'}`);
const be32 = (x) => unhex(x.toString(16).padStart(64, '0'));
const modn = (a) => ((a % P256_N) + P256_N) % P256_N;

function invModN(a) {
  let [r0, r1] = [modn(a), P256_N];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new Error('p256: no inverse');
  return modn(s0);
}

/** The uncompressed SEC1 point (65 bytes, 0x04 || X || Y) of the scalar d. */
export function p256Public(d) {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(be32(d));
  return ecdh.getPublicKey();
}

function rfc6979Nonce(d, h1) {
  const mac = (key, ...parts) => createHmac('sha256', key).update(Buffer.concat(parts)).digest();
  const x = be32(d);
  const h = be32(modn(big(h1)));
  let v = Buffer.alloc(32, 1);
  let k = Buffer.alloc(32, 0);
  k = mac(k, v, Buffer.from([0]), x, h); v = mac(k, v);
  k = mac(k, v, Buffer.from([1]), x, h); v = mac(k, v);
  for (;;) {
    v = mac(k, v);
    const t = big(v);
    if (t >= 1n && t < P256_N) return t;
    k = mac(k, v, Buffer.from([0])); v = mac(k, v);
  }
}

/** ECDSA P-256 with SHA-256 over `message`, the RFC 6979 nonce, s not normalized: {r, s} as BigInt. */
export function p256Sign(d, message) {
  const h1 = sha256(message);
  const k = rfc6979Nonce(d, h1);
  const r = modn(big(p256Public(k).subarray(1, 33)));
  const s = modn(invModN(k) * (big(h1) + r * d));
  if (r === 0n || s === 0n) throw new Error('p256: degenerate signature');
  return { r, s };
}

function derInteger(x) {
  let b = be32(x);
  let i = 0;
  while (i < 31 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return Buffer.concat([Buffer.from([0x02, b.length]), b]);
}

/** DER SEQUENCE { INTEGER r, INTEGER s }, the form the device platforms return. */
export function derSignature({ r, s }) {
  const body = Buffer.concat([derInteger(r), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

const rawSignature = ({ r, s }) => Buffer.concat([be32(r), be32(s)]);

function p256KeyObject(pub) {
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
}

/** node:crypto (OpenSSL) check of a DER ECDSA-SHA256 signature over `message` under the 65-byte point `pub`. */
export function p256Verify(pub, message, der) {
  return nodeVerify('sha256', message, { key: p256KeyObject(pub), dsaEncoding: 'der' }, der);
}

// ---- CBOR, only what an App Attest assertion holds: a map of text keys to byte strings ----

function cborHead(major, len) {
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len < 256) return Buffer.from([(major << 5) | 24, len]);
  if (len < 65536) return Buffer.from([(major << 5) | 25, len >> 8, len & 255]);
  throw new Error('cbor: too long');
}

function cborMap(entries) {
  return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, v]) => {
    const key = utf8(k);
    return [cborHead(3, key.length), key, cborHead(2, v.length), v];
  })]);
}

// ---- ML-DSA-65 through a client package's @noble/post-quantum (0.5 or later) ----

function resolveFrom(dir, ...specs) {
  const req = createRequire(join(dir, 'package.json'));
  for (const spec of specs) {
    try { return req.resolve(spec); } catch { /* next spelling */ }
  }
  return null;
}

function versionOf(file, name) {
  for (let d = dirname(file); d !== dirname(d); d = dirname(d)) {
    try {
      const p = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
      if (p.name === name) return p.version;
    } catch { /* go up */ }
  }
  return '?';
}

const nobleDirs = () => NOBLE_PACKAGES.map((p) => join(REPO, p)).filter((d) => existsSync(join(d, 'package.json')));

async function loadMlDsa() {
  for (const dir of nobleDirs()) {
    const file = resolveFrom(dir, '@noble/post-quantum/ml-dsa.js');
    if (!file) continue;
    const version = versionOf(file, '@noble/post-quantum');
    const [major, minor] = version.split('.').map(Number);
    if (major === 0 && minor < 5) continue; // older argument order
    const { ml_dsa65: mldsa } = await import(pathToFileURL(file).href);
    return { mldsa, where: `@noble/post-quantum ${version}: ${dir}` };
  }
  throw new Error('no @noble/post-quantum 0.5 or later in the client packages: run npm ci in applications/qnet-mobile');
}

const { mldsa: ML, where: ML_WHERE } = await loadMlDsa();

function mldsaKeys(xi) {
  const { publicKey, secretKey } = ML.keygen(Uint8Array.from(xi));
  return { publicKey: Buffer.from(publicKey), secretKey: Buffer.from(secretKey) };
}

/** FIPS 204 deterministic ML-DSA-65 (rnd = 32 zero bytes), empty context, over the UTF-8 of `text`: raw bytes. */
const mldsaSign = (keys, text) => Buffer.from(ML.sign(utf8(text), keys.secretKey, { extraEntropy: false }));
export const mldsaVerify = (publicKey, text, signature) => ML.verify(Uint8Array.from(signature), utf8(text), Uint8Array.from(publicKey));
/** The same over the site-record envelope of `message`, with the context QNET_OFFCHAIN_MSG_v1. */
const siteRecordSign = (keys, message) => Buffer.from(ML.sign(Uint8Array.from(siteRecordEnvelope(message)), keys.secretKey,
  { extraEntropy: false, context: utf8(SITE_RECORD.CONTEXT) }));
export const siteRecordVerify = (publicKey, message, signature, ml = ML) =>
  ml.verify(Uint8Array.from(signature), Uint8Array.from(siteRecordEnvelope(message)), Uint8Array.from(publicKey), { context: utf8(SITE_RECORD.CONTEXT) });

// ---- identity (light-node-messages.md section 3) ----

/** EON address of an ML-DSA-65 public key. */
export function eonOf(publicKey) {
  const full = hex(sha512(publicKey));
  const head = `${full.slice(0, 19)}eon${full.slice(19, 34)}`;
  return `${head}${sha3Hex(head).slice(0, 8)}`;
}

export function isEonAddress(s) {
  const m = typeof s === 'string' ? /^([0-9a-f]{19}eon[0-9a-f]{15})([0-9a-f]{8})$/.exec(s) : null;
  return m !== null && sha3Hex(m[1]).slice(0, 8) === m[2];
}

export const lightNodeId = (wallet) => `light_mobile_${hex(blake3(utf8(`LIGHT_NODE_PRIVACY_${wallet}`))).slice(0, 16)}`;
export const registrationProof = (burnTx, nodeId, wallet) => hex(blake3(utf8(`${burnTx}:${nodeId}:${wallet}`))).slice(0, 32);
export const walletHash = (wallet) => sha3Hex(`${LINK2.WALLET_HASH_PREFIX}${wallet}`).slice(0, 16);
export const epochOf = (height) => Math.floor(height / EPOCH_BLOCKS);

// ---- wallet-key and ping-key messages (light-node-messages.md section 4) ----

export const M = Object.freeze({
  consent: (nodeId, wallet, proof, ts) => `${CHAIN_TAG}client_node_reg:${nodeId}:${wallet}:${proof}:${ts}`,
  ownerBind: (nodeId, wallet, proof, ts, publicKeySha3, burnTx) =>
    `qnet_onchain_reg:${nodeId}:${wallet}:${proof}:${ts}:${publicKeySha3}:${burnTx}`,
  // A payment key's bind with no time (a Light registration only): finished later, anywhere, with a fresh consent.
  ownerBindV2: (nodeId, wallet, proof, publicKeySha3, burnTx) => `qnet_burn_owner_v2:${nodeId}:${wallet}:${proof}:${publicKeySha3}:${burnTx}`,
  delegationV2: (pingPublicKeyHex, nodeId, seq) => `${CHAIN_TAG}delegate_ping:v2:${pingPublicKeyHex}:${nodeId}:${seq}`,
  attachV2: (nodeId, pingPublicKeySha3, pushTargetSha3, seq, ts) =>
    `${CHAIN_TAG}light_attach:${nodeId}:${pingPublicKeySha3}:${pushTargetSha3}:${seq}:${ts}`,
  tokenRefreshV2: (nodeId, pushTargetSha3, seq, ts) => `${CHAIN_TAG}token_refresh:${nodeId}:${pushTargetSha3}:${seq}:${ts}`,
  unbind: (nodeId, seq, ts) => `${CHAIN_TAG}light_unbind:${nodeId}:${seq}:${ts}`,
  // The wallet key's unbind of the node's device binding `seq`, from any device that holds the wallet.
  walletUnbind: (nodeId, seq, ts) => `${CHAIN_TAG}light_unbind_wallet:${nodeId}:${seq}:${ts}`,
  selfAttest: (height, hash) => `selfattest:${height}:${hash}`,
  claimRewards: (nodeId, wallet) => `${CHAIN_TAG}claim_rewards:${nodeId}:${wallet}`,
  claimPayload: (wallet, ts, claimsDataSha3) => `${CHAIN_TAG}qnet_claim_v1:${wallet}:${ts}:${claimsDataSha3}`,
  status: (nodeId, ts) => `${CHAIN_TAG}light_status:${nodeId}:${ts}`,
});

// ---- device messages (light-node-messages.md section 5) ----

const D = `|${CHAIN_ID}|`;
export const DM = Object.freeze({
  enrol: (nodeId, wallet, pingPublicKeySha3, seq, nonce, flags) =>
    `qnet_dev_enrol:v1${D}${nodeId}|${wallet}|${pingPublicKeySha3}|${seq}|${nonce}|${flags}`,
  iosFlags: (idiom) => `mac=0,vision=0,idiom=${idiom}`,
  androidFlags: (reportText) => `r=${sha3Hex(reportText)}`,
  rotate: (nodeId, oldHwPublicKeySha3, pingPublicKeySha3, seq, nonce) =>
    `qnet_dev_rotate:v1${D}${nodeId}|${oldHwPublicKeySha3}|${pingPublicKeySha3}|${seq}|${nonce}`,
  rebind: (fromNodeId, toNodeId, seq, nonce) => `qnet_dev_rebind:v1${D}${fromNodeId}|${toNodeId}|${seq}|${nonce}`,
  refresh: (nodeId, nonce) => `qnet_dev_refresh:v1${D}${nodeId}|${nonce}`,
  release: (nodeId, seq, nonce) => `qnet_dev_release:v1${D}${nodeId}|${seq}|${nonce}`,
  hwPing: (nodeId, height, hash, sigmaSha3, hwSeq) =>
    `qnet_hwping:v2${D}${nodeId}|${epochOf(height)}|${height}|${hash}|${sigmaSha3}|${hwSeq}`,
  lease: (nodeId, deviceTagHex, lease, effective, gate, piDigest, issuedAt) =>
    `qnet_device_lease:v1${D}${nodeId}|${deviceTagHex}|${lease}|${effective}|${gate}|${piDigest}|${issuedAt}`,
  statement: (f) => `qnet_device_stmt:v1${D}${f.nodeId}|${f.deviceTag}|p256|${f.hwPublicKeySha3}|${f.platform}|${f.prov}|`
    + `${f.trust}|${f.op}|${f.issuedEpoch}|${f.effectiveEpoch}|${f.state}|${f.leaseSha3}`,
  state: (nodeId, state, stateSeq, untilEpoch, reason) =>
    `qnet_device_state:v1${D}${nodeId}|${state}|${stateSeq}|${untilEpoch}|${reason}`,
  crl: (fetchedAt, listSha3) => `qnet_crl:v1|${fetchedAt}|${listSha3}`,
  pingWire: (sigmaHex, hwSignature, hwSeq) => `ping_hw2:${sigmaHex}.${b64u(hwSignature)}.${hwSeq}`,
});

const REPORT_KEYS = ['arc', 'automotive', 'embedded', 'feature_pc', 'hsum', 'leanback', 'system_user', 'touchscreen', 'watch'];

/** The Android device report: canonical JSON, the nine boolean keys in this order, no spaces. */
export function androidReport(fields) {
  for (const k of REPORT_KEYS) if (typeof fields[k] !== 'boolean') throw new Error(`report: ${k}`);
  return `{${REPORT_KEYS.map((k) => `"${k}":${fields[k]}`).join(',')}}`;
}

/** SHA3-256("qnet_device_tag:v1|" || chain_id || "|" || platform byte || hw_pub): 32 bytes. */
export const deviceTag = (platform, hwPublicKey) => sha3(cat(`qnet_device_tag:v1|${CHAIN_ID}|`, [PLATFORM_BYTE[platform]], hwPublicKey));
/** First 16 hex of SHA3-256("qnet_device_tag_h:v1|" || nonce (16 bytes) || device_tag). */
export const deviceTagH = (nonce16, tag) => sha3Hex(cat('qnet_device_tag_h:v1|', nonce16, tag)).slice(0, 16);
/** First 8 hex of SHA3-256("qnet_dev_ref:v1|" || nonce (32 bytes) || device_tag). */
export const resetRef = (nonce32, tag) => sha3Hex(cat('qnet_dev_ref:v1|', nonce32, tag)).slice(0, 8);
/** Play Integrity request nonce of an enrolment: b64url(SHA-256(E || SHA3-256(K_dev) || SHA3-256(R))). */
export const playNonceEnrol = (enrolPreimage, hwPublicKey, reportText) =>
  b64u(sha256(cat(enrolPreimage, sha3(hwPublicKey), sha3(utf8(reportText)))));
/** Play Integrity request nonce of every other device message: b64url(SHA-256(preimage)). */
export const playNonce = (preimage) => b64u(sha256(utf8(preimage)));

/**
 * A synthetic App Attest assertion: authenticatorData = rpIdHash || flags || counter (big-endian), nonce =
 * SHA-256(authenticatorData || clientDataHash), and an ECDSA-SHA256 signature over nonce; CBOR
 * {signature, authenticatorData}. Our rules read the rpIdHash, the counter and the signature.
 */
function iosAssertion(d, counter, clientDataHash) {
  const authenticatorData = Buffer.concat([sha256(utf8(`${SAMPLE_TEAM_ID}.${IOS_BUNDLE_ID}`)), Buffer.from([0]), u32be(counter)]);
  const nonce = sha256(Buffer.concat([authenticatorData, clientDataHash]));
  const signature = derSignature(p256Sign(d, nonce));
  return { authenticatorData, nonce, signature, assertion: cborMap([['signature', signature], ['authenticatorData', authenticatorData]]) };
}

// ---- QNet Link revision 2 (qnet-link-v1.md section 14) ----

const PKCS8_X25519 = unhex('302e020100300506032b656e04220420');
const SPKI_X25519 = unhex('302a300506032b656e032100');
const x25519Priv = (raw) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const x25519Pub = (raw) => createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
const x25519Public = (priv) => createPublicKey(x25519Priv(priv)).export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length);

function clamp(bytes) {
  const k = Buffer.from(bytes);
  k[0] &= 248; k[31] &= 127; k[31] |= 64;
  return k;
}

function x25519Shared(priv, pub) {
  let shared;
  try {
    shared = diffieHellman({ privateKey: x25519Priv(priv), publicKey: x25519Pub(pub) });
  } catch {
    throw new Error('x25519: rejected public key');
  }
  if (shared.every((b) => b === 0)) throw new Error('x25519: all-zero shared secret');
  return shared;
}

const linkKey = (shared, id) => Buffer.from(hkdfSync('sha256', shared, unhex(id), utf8(LINK2.HKDF_INFO), 32));

/** The six-digit check number both sides derive (section 14.6): HKDF-SHA256, 4 bytes big-endian, mod 10^6. */
export function checkNumber(shared, id) {
  const n = Buffer.from(hkdfSync('sha256', shared, unhex(id), utf8(LINK2.SAS_INFO), 4)).readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** AAD of revision 2: connect keeps "qnet-link-v1|<id>|connect"; link and claim append "|<reqHash>". */
export const aadOf = (id, intent, reqHash) => `${LINK2.AAD_PREFIX}${id}|${intent}${reqHash ? `|${reqHash}` : ''}`;

function seal(key, iv, aad, plaintext) {
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(aad);
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

function open(key, iv, aad, ct) {
  if (ct.length < LINK2.CT_MIN_BYTES) throw new Error('aes-gcm: short ciphertext');
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAAD(aad);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

/** The site's side: decrypt an answer for the session it created. */
export function openAnswer({ sessionId, intent, reqHash = null, sitePrivateKey, appPub, iv, ct }) {
  const app = decodeB64url(appPub, 32);
  const ivb = decodeB64url(iv, 12);
  const ctb = decodeB64url(ct);
  if (!app || !ivb || !ctb) throw new Error('encoding');
  const key = linkKey(x25519Shared(unhex(sitePrivateKey), app), sessionId);
  return open(key, ivb, utf8(aadOf(sessionId, intent, reqHash)), ctb).toString('utf8');
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (obj, keys) => {
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
};
const REQUEST_KEYS = Object.freeze({
  link: ['burnTx', 'walletHash', 'check'], claim: ['walletHash'], reserve: ['walletHash', 'burner'], unlink: ['walletHash'],
});

/** The request of a link, claim, reserve or unlink session, checked: exact keys and value forms. Returns it or null. */
export function checkRequest(intent, request) {
  const keys = REQUEST_KEYS[intent];
  if (!keys || !isPlainObject(request) || !sameKeys(request, keys)) return null;
  if (request.walletHash !== null && !(typeof request.walletHash === 'string' && /^[0-9a-f]{16}$/.test(request.walletHash))) return null;
  // A reserve request always names the wallet, and the payment address that burns.
  if (intent === 'reserve' && (request.walletHash === null || !isSolanaAddress(request.burner))) return null;
  // An unlink request always names the wallet whose node the page shows.
  if (intent === 'unlink' && request.walletHash === null) return null;
  if (intent === 'link') {
    if (request.burnTx !== null && !isSolanaSignature(request.burnTx)) return null;
    if (typeof request.check !== 'boolean') return null;
  }
  return request;
}

/** The request bytes: its keys in the order of section 14.4, no spaces. */
export function requestText(intent, request) {
  if (!checkRequest(intent, request)) throw new Error('request');
  return JSON.stringify(Object.fromEntries(REQUEST_KEYS[intent].map((k) => [k, request[k]])));
}

export const reqHashOf = (text) => b64u(sha256(utf8(text)));

/** Parses a revision 2 link exactly; returns {id, sitePub, intent, reqHash?} or null. */
export function parseLink(text) {
  const m = typeof text === 'string' ? LINK2.RE.exec(text) : null;
  if (!m) return null;
  const [, id, sitePub, intent, reqHash] = m;
  if ((intent === 'connect') !== (reqHash === undefined)) return null;
  if (!decodeB64url(sitePub, 32) || (reqHash !== undefined && !decodeB64url(reqHash, 32))) return null;
  return reqHash ? { id, sitePub, intent, reqHash } : { id, sitePub, intent };
}

/** POST /api/link/sessions body (JSON text) → the body, or null (400; 413 for size). */
export function validateSessionRequest(text) {
  if (typeof text !== 'string' || utf8(text).length > LINK2.SESSION_BODY_MAX_BYTES) return null;
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  if (!isPlainObject(body) || !LINK2.INTENTS.includes(body.intent)) return null;
  const withRequest = body.intent !== 'connect';
  if (!sameKeys(body, withRequest ? ['id', 'sitePub', 'intent', 'request'] : ['id', 'sitePub', 'intent'])) return null;
  if (typeof body.id !== 'string' || !/^[0-9a-f]{32}$/.test(body.id) || !decodeB64url(body.sitePub, 32)) return null;
  if (withRequest && !checkRequest(body.intent, body.request)) return null;
  return body;
}

/** POST /api/link/sessions/:id/response body for a session of `intent` → the body, or null. */
export function validateResponseRequest(text, intent) {
  const caps = LINK2.CAPS[intent];
  if (!caps || typeof text !== 'string' || utf8(text).length > caps.body) return null;
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  if (!isPlainObject(body) || !sameKeys(body, ['appPub', 'iv', 'ct'])) return null;
  if (!decodeB64url(body.appPub, 32) || !decodeB64url(body.iv, 12)) return null;
  const ct = decodeB64url(body.ct);
  return ct && ct.length >= LINK2.CT_MIN_BYTES && ct.length <= caps.ct ? body : null;
}

const ANSWER_KEYS = Object.freeze({
  'connect/ok': ['qnet', 'solana'],
  'link/ok': ['qnet', 'nodeId', 'consent', 'bound'],
  'link/linked': ['qnet', 'nodeId', 'seq'],
  'claim/ok': ['qnet', 'nodeId', 'amountNano', 'txHash', 'stoppedAtEpoch'],
  'claim/empty': ['qnet', 'nodeId'],
  'reserve/ok': ['qnet', 'time', 'pk', 'sig'],
  'unlink/ok': ['qnet', 'nodeId', 'unbound'],
});

/**
 * A decrypted answer against the session the site made ({intent, request, now, consent24h}). Returns the parsed
 * answer or throws with the reason, in the order of section 14.7.
 */
export function validateAnswer(plaintext, { intent, request = null, now, consent24h = true }) {
  const caps = LINK2.CAPS[intent];
  if (typeof plaintext !== 'string' || utf8(plaintext).length > caps.plaintext) throw new Error('size');
  let r;
  try { r = JSON.parse(plaintext); } catch { throw new Error('json'); }
  if (!isPlainObject(r)) throw new Error('json');
  if (r.v !== 1) throw new Error('v');
  if (r.intent !== intent) throw new Error('intent');
  if (!LINK2.STATUSES[intent].includes(r.status)) throw new Error('status');
  if (intent === 'link' && r.status === 'ok' && (!request || request.burnTx === null)) throw new Error('status');
  const base = ['v', 'intent', 'status'];
  const want = r.status === 'rejected' ? base : r.status === 'error' ? [...base, 'error'] : [...base, ...ANSWER_KEYS[`${intent}/${r.status}`]];
  if (!sameKeys(r, want)) throw new Error('keys');
  if (r.status === 'error' && !LINK2.ERRORS[intent].includes(r.error)) throw new Error('error');
  if (r.status === 'rejected' || r.status === 'error') return r;
  if (!isEonAddress(r.qnet)) throw new Error('qnet');
  if (intent === 'connect') {
    if (!isSolanaAddress(r.solana)) throw new Error('solana');
    return r;
  }
  if (intent === 'reserve') {
    // The wallet the request names signs its reservation of a light node paid from the request's payment address.
    if (!request || walletHash(r.qnet) !== request.walletHash) throw new Error('walletHash');
    if (!isU64String(r.time)) throw new Error('time');
    const time = Number(r.time);
    if (time < now - LINK2.RESERVE_PAST_S || time > now + LINK2.RESERVE_FUTURE_S) throw new Error('time');
    const pk = decodeB64url(r.pk, MLDSA65.PUBLIC_KEY_BYTES);
    if (!pk || eonOf(pk) !== r.qnet) throw new Error('pk');
    const sig = decodeB64url(r.sig, MLDSA65.SIGNATURE_BYTES);
    if (!sig || !siteRecordVerify(pk, reservationMessage(r.qnet, 'light', 'payment', request.burner, r.time), sig)) throw new Error('sig');
    return r;
  }
  if (r.nodeId !== lightNodeId(r.qnet)) throw new Error('nodeId');
  if (request && request.walletHash !== null && walletHash(r.qnet) !== request.walletHash) throw new Error('walletHash');
  if (intent === 'link' && r.status === 'ok') {
    if (typeof r.bound !== 'boolean') throw new Error('bound');
    const c = r.consent;
    if (!isPlainObject(c) || !sameKeys(c, ['ts', 'pk', 'sig'])) throw new Error('keys');
    if (!isU64String(c.ts)) throw new Error('ts');
    const ts = Number(c.ts);
    const past = consent24h ? LINK2.CONSENT_PAST_S : LINK2.CONSENT_PAST_LEGACY_S;
    if (ts < now - past || ts > now + LINK2.CONSENT_FUTURE_S) throw new Error('ts');
    const pk = decodeB64url(c.pk, MLDSA65.PUBLIC_KEY_BYTES);
    if (!pk || eonOf(pk) !== r.qnet) throw new Error('pk');
    const sig = decodeB64url(c.sig, MLDSA65.SIGNATURE_BYTES);
    const proof = registrationProof(request.burnTx, r.nodeId, r.qnet);
    if (!sig || !mldsaVerify(pk, M.consent(r.nodeId, r.qnet, proof, c.ts), sig)) throw new Error('sig');
  }
  if (intent === 'link' && r.status === 'linked' && !isU64String(r.seq)) throw new Error('seq');
  if (intent === 'unlink' && r.status === 'ok' && typeof r.unbound !== 'boolean') throw new Error('unbound');
  if (intent === 'claim' && r.status === 'ok') {
    // At least 1 QNC for the whole balance; above zero for a part the node's quote stopped short of (section 14.7).
    const least = r.stoppedAtEpoch === null ? LINK2.CLAIM_MIN_NANO : 1n;
    if (!isU64String(r.amountNano) || BigInt(r.amountNano) < least) throw new Error('amountNano');
    if (typeof r.txHash !== 'string' || !/^[0-9a-f]{64}$/.test(r.txHash)) throw new Error('txHash');
    if (r.stoppedAtEpoch !== null && !isU64String(r.stoppedAtEpoch)) throw new Error('stoppedAtEpoch');
  }
  return r;
}

// ---- vector construction ----

const label = (name, part) => `qnet-light-node/vector/${name}/${part}`;
const burnTxOf = (name) => base58Encode(sha512(utf8(label(name, 'burnTx'))));
// Fixed times: T is the consent time of the link sheet (seq = ts = T there).
const T = 1790000000;
const ANCHOR = Object.freeze({ height: 2241838, hash: sha3Hex(label('anchor', 'hash')) });

// Two recovery phrases: the KAT phrase every client pins, and a 24-word phrase of the published word-list test set.
const PHRASES = [
  ['kat-12', `${'abandon '.repeat(11)}about`],
  ['phrase-24', 'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length'],
];
// The KAT wallet as the node's genesis_key.rs pins it (applications/qnet-mobile/__tests__/fixtures/wallet_kat.json).
const KAT_PIN = Object.freeze({
  xi: '5c5c79cac60d06d566b9c23047ad28b5da96dab4367593563ef34539067b57f6',
  publicKeySha3: 'cc8dbbec8ddd7b01f7926748b3738028ab92570e04e694bf0f4ddc346085de6f',
  address: 'd9fa370374e24333242eon847d1d354dcd87fe873823e',
});

function buildWallet([name, mnemonic]) {
  const seed = pbkdf2Sync(utf8(mnemonic.normalize('NFKD')), utf8('mnemonic'), 2048, 64, 'sha512');
  const seedString = `${WALLET_SEED_PREFIX}${hex(seed)}`;
  const xi = shake256x32(utf8(seedString));
  const keys = mldsaKeys(xi);
  const address = eonOf(keys.publicKey);
  return {
    keys,
    view: {
      name, mnemonic, phraseSeedHex: hex(seed), seedString, xi: hex(xi), publicKey: hex(keys.publicKey),
      publicKeySha3: sha3Hex(keys.publicKey), address, nodeId: lightNodeId(address), walletHash: walletHash(address),
    },
  };
}

// The ping key is random on a device; here a seed string fixes it (the app's native module SHAKE256s a seed string
// into the 32-byte KeyGen seed, as for the wallet key). The oracle's test key is made the same way.
function buildSeededKey(name, prefix) {
  const seedString = `${prefix}${hex(sha256(utf8(label(name, 'seed'))))}`;
  const keys = mldsaKeys(shake256x32(utf8(seedString)));
  return { keys, view: { seedString, publicKey: hex(keys.publicKey), publicKeySha3: sha3Hex(keys.publicKey) } };
}

function buildBurner() {
  const seed = sha256(utf8(label('burner', 'seed')));
  const priv = createPrivateKey({ key: Buffer.concat([unhex('302e020100300506032b657004220420'), seed]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(12);
  return { priv, pub, view: { seedHex: hex(seed), address: base58Encode(pub) } };
}

const PUSH_TARGET = hex(sha256(utf8(label('push', 'token'))));
// The step-1 quote as the node writes it (keys sorted): per epoch the amount in nano-QNC and the reward proof,
// a list of [sibling hash, sibling is left].
const CLAIMS_DATA = JSON.stringify({ claims: [{ amount: 12500000000, epoch: 155, proof: [[sha3Hex(label('claim', 'sibling')), false]] }] });

function buildNodeMessages(w, ping, burner) {
  const { address: W, nodeId: N } = w.view;
  const burnTx = burnTxOf(w.view.name);
  const proof = registrationProof(burnTx, N, W);
  const pp = ping.view.publicKey;
  const messages = [];
  const add = (name, inputs, preimage, signer) => {
    let signature;
    if (signer === 'burner') signature = hex(nodeSign(null, utf8(preimage), burner.priv));
    else signature = hex(mldsaSign(signer === 'wallet' ? w.keys : ping.keys, preimage));
    messages.push({ name, inputs, preimage, preimageSha3: sha3Hex(preimage), signer, signature });
  };
  add('consent', { nodeId: N, wallet: W, proof, ts: String(T) }, M.consent(N, W, proof, T), 'wallet');
  add('ownerBind', { nodeId: N, wallet: W, proof, ts: String(T), walletPublicKeySha3: w.view.publicKeySha3, burnTx },
    M.ownerBind(N, W, proof, T, w.view.publicKeySha3, burnTx), 'burner');
  add('ownerBindV2', { nodeId: N, wallet: W, proof, walletPublicKeySha3: w.view.publicKeySha3, burnTx },
    M.ownerBindV2(N, W, proof, w.view.publicKeySha3, burnTx), 'burner');
  add('delegationV2', { pingPublicKey: pp, nodeId: N, seq: String(T) }, M.delegationV2(pp, N, T), 'wallet');
  add('attachV2', { nodeId: N, pingPublicKeySha3: ping.view.publicKeySha3, pushTarget: PUSH_TARGET, pushTargetSha3: sha3Hex(PUSH_TARGET), seq: String(T), ts: String(T) },
    M.attachV2(N, ping.view.publicKeySha3, sha3Hex(PUSH_TARGET), T, T), 'wallet');
  add('attachV2NoPushTarget', { nodeId: N, pingPublicKeySha3: ping.view.publicKeySha3, pushTarget: '', pushTargetSha3: sha3Hex(''), seq: String(T), ts: String(T) },
    M.attachV2(N, ping.view.publicKeySha3, sha3Hex(''), T, T), 'wallet');
  add('tokenRefreshV2', { nodeId: N, pushTarget: PUSH_TARGET, pushTargetSha3: sha3Hex(PUSH_TARGET), seq: String(T), ts: String(T + 3600) },
    M.tokenRefreshV2(N, sha3Hex(PUSH_TARGET), T, T + 3600), 'ping');
  add('unbind', { nodeId: N, seq: String(T), ts: String(T + 7200) }, M.unbind(N, T, T + 7200), 'ping');
  add('walletUnbind', { nodeId: N, seq: String(T), ts: String(T + 7260) }, M.walletUnbind(N, T, T + 7260), 'wallet');
  add('selfAttest', { height: String(ANCHOR.height), hash: ANCHOR.hash }, M.selfAttest(ANCHOR.height, ANCHOR.hash), 'ping');
  add('claimRewards', { nodeId: N, wallet: W }, M.claimRewards(N, W), 'wallet');
  add('claimPayload', { wallet: W, ts: String(T + 120), claimsData: CLAIMS_DATA, claimsDataSha3: sha3Hex(CLAIMS_DATA) },
    M.claimPayload(W, T + 120, sha3Hex(CLAIMS_DATA)), 'wallet');
  add('statusByPingKey', { nodeId: N, ts: String(T + 60) }, M.status(N, T + 60), 'ping');
  add('statusByWalletKey', { nodeId: N, ts: String(T + 60) }, M.status(N, T + 60), 'wallet');
  return { wallet: w.view.name, nodeId: N, burnTx, proof, messages };
}

// Device keys: P-256 scalars from labels (on a device they never leave the secure hardware).
function hwKey(name) {
  const d = modn(big(sha256(utf8(label(name, 'hw'))))) || 1n;
  const pub = p256Public(d);
  return { d, pub, view: { privateKey: hex(be32(d)), publicKey: hex(pub), publicKeySha3: sha3Hex(pub), keyId: b64u(sha256(pub)) } };
}

const nonceOf = (purpose) => b64u(sha256(utf8(label('nonce', purpose))));

function buildDevice(kat, w24, ping, oracle) {
  const N = kat.view.nodeId;
  const W = kat.view.address;
  const pps = ping.view.publicKeySha3;
  const keys = { ios: hwKey('ios'), iosRotated: hwKey('ios-rotated'), android: hwKey('android'), androidRotated: hwKey('android-rotated') };
  const out = { keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.view])) };
  out.sampleTeamId = SAMPLE_TEAM_ID;
  out.rpIdHash = hex(sha256(utf8(`${SAMPLE_TEAM_ID}.${IOS_BUNDLE_ID}`)));

  const androidSig = (key, preimage) => {
    const sig = p256Sign(key.d, utf8(preimage));
    return { signatureDer: b64u(derSignature(sig)), signatureRaw: hex(rawSignature(sig)) };
  };
  const iosSig = (key, counter, preimage) => {
    const a = iosAssertion(key.d, counter, sha256(utf8(preimage)));
    return { counter, clientDataHash: hex(sha256(utf8(preimage))), authenticatorData: hex(a.authenticatorData),
      nonce: hex(a.nonce), signatureDer: b64u(a.signature), assertion: b64u(a.assertion) };
  };

  const report = androidReport({ arc: false, automotive: false, embedded: false, feature_pc: false, hsum: false,
    leanback: false, system_user: true, touchscreen: true, watch: false });
  const enrolIos = DM.enrol(N, W, pps, T, nonceOf('enrol-ios'), DM.iosFlags('phone'));
  const enrolAndroid = DM.enrol(N, W, pps, T, nonceOf('enrol-android'), DM.androidFlags(report));
  const ka = keys.android;
  out.report = { text: report, sha3: sha3Hex(report), signedBy: 'android', ...androidSig(ka, report) };
  out.messages = [
    { name: 'enrol', platform: 'ios', nonce: nonceOf('enrol-ios'), flags: DM.iosFlags('phone'), preimage: enrolIos,
      clientDataHash: hex(sha256(utf8(enrolIos))), reenrolAssertion: iosSig(keys.ios, 3, enrolIos) },
    { name: 'enrol', platform: 'android', nonce: nonceOf('enrol-android'), flags: DM.androidFlags(report), preimage: enrolAndroid,
      attestationChallenge: hex(sha256(utf8(enrolAndroid))), playNonce: playNonceEnrol(enrolAndroid, ka.pub, report) },
  ];
  const rotateIos = DM.rotate(N, keys.ios.view.publicKeySha3, pps, T, nonceOf('rotate-ios'));
  const rotateAndroid = DM.rotate(N, ka.view.publicKeySha3, pps, T, nonceOf('rotate-android'));
  const rotatedReportSig = androidSig(keys.androidRotated, report);
  out.messages.push(
    { name: 'rotate', platform: 'ios', nonce: nonceOf('rotate-ios'), preimage: rotateIos, newKey: 'iosRotated',
      newKeyClientDataHash: hex(sha256(utf8(rotateIos))), oldKey: iosSig(keys.ios, 9, rotateIos) },
    { name: 'rotate', platform: 'android', nonce: nonceOf('rotate-android'), preimage: rotateAndroid, newKey: 'androidRotated',
      newKeyAttestationChallenge: hex(sha256(utf8(rotateAndroid))), newKeyReportSignatureDer: rotatedReportSig.signatureDer,
      playNonce: playNonce(rotateAndroid), oldKey: androidSig(ka, rotateAndroid) },
  );
  const N24 = w24.view.nodeId;
  for (const [platform, key, extra] of [['ios', keys.ios, (p) => iosSig(keys.ios, 11, p)], ['android', ka, (p) => androidSig(ka, p)]]) {
    const rebind = DM.rebind(N, N24, T + 86400, nonceOf(`rebind-${platform}`));
    out.messages.push({ name: 'rebind', platform, nonce: nonceOf(`rebind-${platform}`), preimage: rebind,
      device: extra(rebind), walletSignature: hex(mldsaSign(w24.keys, rebind)), walletPublicKeySha3: w24.view.publicKeySha3 });
    const refresh = DM.refresh(N, nonceOf(`refresh-${platform}`));
    out.messages.push({ name: 'refresh', platform, nonce: nonceOf(`refresh-${platform}`), preimage: refresh,
      ...(platform === 'android' ? { playNonce: playNonce(refresh) } : {}),
      device: platform === 'ios' ? iosSig(key, 12, refresh) : androidSig(key, refresh) });
    const release = DM.release(N, T, nonceOf(`release-${platform}`));
    out.messages.push({ name: 'release', platform, nonce: nonceOf(`release-${platform}`), preimage: release,
      device: platform === 'ios' ? iosSig(key, 13, release) : androidSig(key, release) });
  }

  // The ping reply of one epoch, both platforms.
  const challenge = M.selfAttest(ANCHOR.height, ANCHOR.hash);
  const sigma = mldsaSign(ping.keys, challenge);
  const sigmaSha3 = sha3Hex(sigma);
  const hwSeq = '1790000000123';
  const hIos = DM.hwPing(N, ANCHOR.height, ANCHOR.hash, sigmaSha3, 0);
  const hAndroid = DM.hwPing(N, ANCHOR.height, ANCHOR.hash, sigmaSha3, hwSeq);
  const iosPing = iosSig(keys.ios, 42, hIos);
  const androidPing = derSignature(p256Sign(ka.d, utf8(hAndroid)));
  out.ping = {
    nodeId: N, height: String(ANCHOR.height), hash: ANCHOR.hash, epoch: String(epochOf(ANCHOR.height)), challenge,
    sigma: hex(sigma), sigmaSha3,
    ios: { hwSeq: '0', preimage: hIos, ...iosPing, wire: DM.pingWire(hex(sigma), Buffer.from(iosPing.assertion, 'base64url'), 0) },
    android: { hwSeq, preimage: hAndroid, signatureDer: b64u(androidPing), wire: DM.pingWire(hex(sigma), androidPing, hwSeq) },
  };
  // Statements: the oracle's lease statement (signed), the genesis device statement, a state change, a CRL snapshot.
  const tagIos = deviceTag('ios', keys.ios.pub);
  const tagAndroid = deviceTag('android', ka.pub);
  out.deviceTags = { ios: hex(tagIos), android: hex(tagAndroid) };
  const issuedAt = String(T + 5);
  const piPayload = '{"sample":"decoded verdict payload"}';
  const leases = [
    ['ios', tagIos, DM.lease(N, hex(tagIos), 'claimed_virgin', 'now', 'ok', '', issuedAt)],
    ['android', tagAndroid, DM.lease(N, hex(tagAndroid), 'claimed_foreign', 'next', 'ok', hex(sha256(utf8(piPayload))), issuedAt)],
  ];
  out.statements = leases.map(([platform, tag, lease]) => {
    const oracleSignature = mldsaSign(oracle.keys, lease);
    const key = platform === 'ios' ? keys.ios : ka;
    const epoch = epochOf(ANCHOR.height);
    const fields = {
      nodeId: N, deviceTag: hex(tag), hwPublicKeySha3: key.view.publicKeySha3, platform,
      prov: platform === 'ios' ? 'na' : 'rkp', trust: 'store', op: 'enrol', issuedEpoch: String(epoch),
      effectiveEpoch: String(platform === 'ios' ? epoch : epoch + 1),
      state: platform === 'ios' ? 'active' : 'pending_next_epoch',
      leaseSha3: sha3Hex(Buffer.concat([utf8(lease), oracleSignature])),
    };
    return { platform, lease, ...(platform === 'android' ? { piPayload } : {}), oracleSignature: hex(oracleSignature),
      statementFields: fields, statement: DM.statement(fields) };
  });
  out.stateChange = { preimage: DM.state(N, 'paused', '7', String(epochOf(ANCHOR.height) + 180), 'two_strikes') };
  const serials = ['c0ffee', '1a2b', '7'];
  const listText = [...serials].sort().join('\n');
  out.crl = { serials, listText, listSha3: sha3Hex(listText), fetchedAt: String(T), preimage: DM.crl(String(T), sha3Hex(listText)) };

  // Status: the public device_tag_h and the reset reference.
  const nonce16 = sha256(utf8(label('status', 'nonce'))).subarray(0, 16);
  const refNonce = decodeB64url(nonceOf('enrol-android'), 32);
  out.status = {
    nonce: hex(nonce16),
    deviceTagH: { ios: deviceTagH(nonce16, tagIos), android: deviceTagH(nonce16, tagAndroid) },
    refNonce: nonceOf('enrol-android'),
    ref: { android: resetRef(refNonce, tagAndroid) },
  };
  out.oracle = oracle.view;
  return out;
}

// ---- QNet Link revision 2 cases ----

function linkCases(kat, w24, burner) {
  const W = kat.view.address;
  const N = kat.view.nodeId;
  const solana = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'; // the KAT phrase's Solana address
  const burn = burnTxOf('link-ok');
  const consent = (burnTx) => ({
    ts: String(T), pk: b64u(kat.keys.publicKey),
    sig: b64u(mldsaSign(kat.keys, M.consent(N, W, registrationProof(burnTx, N, W), T))),
  });
  const txHash = sha3Hex(label('claim', 'txHash'));
  // The payment address of a reserve request: the vectors' burner.
  const pay = burner.view.address;
  const reservation = { status: 'ok', qnet: W, time: String(T), pk: b64u(kat.keys.publicKey),
    sig: b64u(siteRecordSign(kat.keys, reservationMessage(W, 'light', 'payment', pay, T))) };
  return [
    ['connect-ok', 'connect', null, { status: 'ok', qnet: W, solana }],
    ['connect-rejected', 'connect', null, { status: 'rejected' }],
    ['connect-error', 'connect', null, { status: 'error', error: 'NO_WALLET' }],
    // A QR on a desktop that did not know the wallet: check is true, and the app shows the check number.
    ['link-ok-check', 'link', { burnTx: burn, walletHash: null, check: true }, { status: 'ok', qnet: W, nodeId: N, consent: consent(burn), bound: true }],
    ['link-ok-known-wallet', 'link', { burnTx: burn, walletHash: kat.view.walletHash, check: false }, { status: 'ok', qnet: W, nodeId: N, consent: consent(burn), bound: false }],
    ['link-linked', 'link', { burnTx: null, walletHash: kat.view.walletHash, check: false }, { status: 'linked', qnet: W, nodeId: N, seq: String(T + 86400) }],
    ['link-rejected', 'link', { burnTx: null, walletHash: null, check: false }, { status: 'rejected' }],
    ['link-error', 'link', { burnTx: burn, walletHash: w24.view.walletHash, check: false }, { status: 'error', error: 'WALLET_MISMATCH' }],
    ['claim-ok', 'claim', { walletHash: null }, { status: 'ok', qnet: W, nodeId: N, amountNano: '12500000000', txHash, stoppedAtEpoch: null }],
    ['claim-ok-partial', 'claim', { walletHash: kat.view.walletHash }, { status: 'ok', qnet: W, nodeId: N, amountNano: '1000000000', txHash, stoppedAtEpoch: '155' }],
    // A part below 1 QNC: the node's quote stopped at epoch 155 with more epochs left (section 14.2).
    ['claim-ok-partial-small', 'claim', { walletHash: null }, { status: 'ok', qnet: W, nodeId: N, amountNano: '400000000', txHash, stoppedAtEpoch: '155' }],
    ['claim-empty', 'claim', { walletHash: null }, { status: 'empty', qnet: W, nodeId: N }],
    ['claim-rejected', 'claim', { walletHash: null }, { status: 'rejected' }],
    ['claim-error', 'claim', { walletHash: null }, { status: 'error', error: 'CLAIM_BUSY' }],
    // QNet Wallet signs the reservation of a light node for its wallet, paid from the page's payment address.
    ['reserve-ok', 'reserve', { walletHash: kat.view.walletHash, burner: pay }, reservation],
    ['reserve-rejected', 'reserve', { walletHash: kat.view.walletHash, burner: pay }, { status: 'rejected' }],
    ['reserve-error', 'reserve', { walletHash: kat.view.walletHash, burner: pay }, { status: 'error', error: 'NODE_OTHER' }],
    // QNet Wallet on the device that runs the node unlinks it; `unbound` false: the network did not confirm the unbind.
    ['unlink-ok', 'unlink', { walletHash: kat.view.walletHash }, { status: 'ok', qnet: W, nodeId: N, unbound: true }],
    ['unlink-ok-unconfirmed', 'unlink', { walletHash: kat.view.walletHash }, { status: 'ok', qnet: W, nodeId: N, unbound: false }],
    ['unlink-rejected', 'unlink', { walletHash: kat.view.walletHash }, { status: 'rejected' }],
    ['unlink-error', 'unlink', { walletHash: kat.view.walletHash }, { status: 'error', error: 'NOT_LINKED' }],
    // The wallet key unlinks the node from whatever device runs it, on any device that holds the wallet (section 14.8);
    // the network refusing it is UNLINK_REFUSED.
    ['unlink-ok-wallet-key', 'unlink', { walletHash: kat.view.walletHash }, { status: 'ok', qnet: W, nodeId: N, unbound: true }],
    ['unlink-error-refused', 'unlink', { walletHash: kat.view.walletHash }, { status: 'error', error: 'UNLINK_REFUSED' }],
  ];
}

function buildLinkCase([name, intent, request, answer]) {
  const id = hex(sha256(utf8(label(name, 'id'))).subarray(0, 16));
  const sitePriv = clamp(sha256(utf8(label(name, 'site'))));
  const appPriv = clamp(sha256(utf8(label(name, 'app'))));
  const iv = sha256(utf8(label(name, 'iv'))).subarray(0, 12);
  const sitePub = x25519Public(sitePriv);
  const appPub = x25519Public(appPriv);
  const shared = x25519Shared(appPriv, sitePub);
  if (!shared.equals(x25519Shared(sitePriv, appPub))) throw new Error(`${name}: ECDH mismatch`);
  const key = linkKey(shared, id);
  const text = request ? requestText(intent, request) : null;
  const reqHash = text ? reqHashOf(text) : null;
  const aad = aadOf(id, intent, reqHash);
  const plaintext = JSON.stringify({ v: 1, intent, ...answer });
  const ct = seal(key, iv, utf8(aad), utf8(plaintext));
  const sessionRequest = { id, sitePub: b64u(sitePub), intent, ...(request ? { request } : {}) };
  const check = checkNumber(shared, id);
  return {
    name, intent,
    context: { request, now: String(T + 60), consent24h: true },
    sessionId: id, hkdfSalt: id,
    sitePrivateKey: hex(sitePriv), sitePublicKey: hex(sitePub),
    request, requestText: text, reqHash,
    link: `${LINK2.PREFIX}${id}.${b64u(sitePub)}.${intent}${reqHash ? `.${reqHash}` : ''}`,
    sessionRequest,
    sessionView: { ...sessionRequest, ...(reqHash ? { reqHash } : {}) },
    appPrivateKey: hex(appPriv), appPublicKey: hex(appPub), sharedSecret: hex(shared),
    hkdfInfo: LINK2.HKDF_INFO, key: hex(key), aad,
    checkNumber: check, checkNumberShown: request !== null && request.check === true, checkNumberDisplay: `${check.slice(0, 3)} ${check.slice(3)}`,
    plaintext, iv: hex(iv), ciphertext: hex(ct),
    responseRequest: { appPub: b64u(appPub), iv: b64u(iv), ct: b64u(ct) },
  };
}

const B64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
// Flips the lowest bit of the last character, a padding bit for 32-byte values: only a canonical check refuses it.
const nonCanonical = (text) => text.slice(0, -1) + B64URL_CHARS[B64URL_CHARS.indexOf(text.at(-1)) ^ 1];

function flipByte(b64, index) {
  const bytes = Buffer.from(b64, 'base64url');
  bytes[index < 0 ? bytes.length + index : index] ^= 0x01;
  return b64u(bytes);
}

function linkNegatives(cases, kat, w24) {
  const byName = (n) => cases.find((c) => c.name === n);
  const ok = byName('link-ok-check');
  const known = byName('link-ok-known-wallet');
  const con = byName('connect-ok');
  const base = { sessionId: ok.sessionId, intent: 'link', reqHash: ok.reqHash, sitePrivateKey: ok.sitePrivateKey, ...ok.responseRequest };
  const cryptoMustFail = [
    { name: 'tag-bit-flipped', ...base, ct: flipByte(base.ct, -1) },
    { name: 'iv-bit-flipped', ...base, iv: flipByte(base.iv, 0) },
    { name: 'reqhash-of-another-request', ...base, reqHash: known.reqHash },
    { name: 'revision-1-aad', ...base, reqHash: null },
    { name: 'intent-swapped', ...base, intent: 'claim' },
    { name: 'connect-with-a-reqhash-aad', sessionId: con.sessionId, intent: 'connect', reqHash: ok.reqHash, sitePrivateKey: con.sitePrivateKey, ...con.responseRequest },
  ];

  const H = 'https://link.aiqnet.io/l';
  const { sessionId: id, reqHash: rh } = ok;
  const pub = ok.sessionRequest.sitePub;
  const L = ok.link;
  const invalidLinks = [
    [`${H}#v1.${id}.${pub}.activate.light`, 'activate: revision 1 only'],
    [`${H}#v1.${id}.${pub}.activate`, 'activate: revision 1 only'],
    [`${H}#v1.${id}.${pub}.link`, 'link without reqHash'],
    [`${H}#v1.${id}.${pub}.claim`, 'claim without reqHash'],
    [`${H}#v1.${id}.${pub}.reserve`, 'reserve without reqHash'],
    [`${H}#v1.${id}.${pub}.unlink`, 'unlink without reqHash'],
    [`${H}#v1.${id}.${pub}.connect.${rh}`, 'connect with reqHash'],
    [`${H}#v1.${id}.${pub}.link.${nonCanonical(rh)}`, 'reqHash non-canonical'],
    [`${H}#v1.${id}.${pub}.link.${rh.slice(1)}`, 'reqHash length'],
    [`${H}#v1.${id}.${pub}.link.${rh}=`, 'reqHash padding'],
    [`${H}#v1.${id}.${pub}.link.light`, 'node type instead of reqHash'],
    [`${H}#v1.${id}.${pub}.link-device.${rh}`, 'intent'],
    [`${H}#v1.${id}.${pub}.reactivate.${rh}`, 'intent'],
    [`${H}#v1.${id}.${pub}.Link.${rh}`, 'intent case'],
    [`${H}#v1.${id}.${nonCanonical(pub)}.link.${rh}`, 'sitePub non-canonical'],
    [`${H}#v1.${id.toUpperCase()}.${pub}.link.${rh}`, 'id uppercase'],
    [`${H}#v2.${id}.${pub}.link.${rh}`, 'version'],
    [`https://aiqnet.io/l#v1.${id}.${pub}.link.${rh}`, 'host (the site, not the link host)'],
    [`http://link.aiqnet.io/l#v1.${id}.${pub}.link.${rh}`, 'scheme'],
    [`${H}?x=1#v1.${id}.${pub}.link.${rh}`, 'query'],
    [`intent://link.aiqnet.io/l#v1.${id}.${pub}.link.${rh}#Intent;scheme=https;package=${LINK2.ANDROID_PACKAGE};end`, 'intent URL'],
    [`${L}.`, 'trailing separator'],
    [`${L}.extra`, 'extra segment'],
    [`${L} `, 'trailing space'],
    [` ${L}`, 'leading space'],
    [L.replace('#', '%23'), 'encoded fragment'],
  ].map(([link, reason]) => ({ link, reason }));

  const sr = ok.sessionRequest;
  const cr = con.sessionRequest;
  const shortTx = base58Encode(sha512(utf8('short')).subarray(0, 63));
  const invalidSessionRequests = [
    [{ ...sr, extra: 1 }, 'extra key'],
    [{ id: sr.id, sitePub: sr.sitePub, intent: 'link' }, 'link without request'],
    [{ ...cr, request: { walletHash: null } }, 'connect with request'],
    [{ ...sr, request: null }, 'request null'],
    [{ ...sr, intent: 'activate', nodeType: 'light' }, 'activate: revision 1 only'],
    [{ ...sr, intent: 'link-device' }, 'intent'],
    [{ ...sr, request: { ...sr.request, extra: true } }, 'request extra key'],
    [{ ...sr, request: { burnTx: sr.request.burnTx, walletHash: null } }, 'request missing check'],
    [{ ...sr, request: { ...sr.request, check: 'true' } }, 'check not a boolean'],
    [{ ...sr, request: { ...sr.request, burnTx: shortTx } }, 'burnTx length'],
    [{ ...sr, request: { ...sr.request, walletHash: kat.view.walletHash.toUpperCase() } }, 'walletHash uppercase'],
    [{ ...sr, request: { ...sr.request, walletHash: kat.view.walletHash.slice(1) } }, 'walletHash length'],
    [{ ...sr, intent: 'claim' }, 'claim with a link request'],
    [{ ...sr, intent: 'reserve' }, 'reserve with a link request'],
    [{ ...sr, intent: 'reserve', request: { walletHash: null, burner: byName('reserve-ok').request.burner } }, 'reserve without a wallet'],
    [{ ...sr, intent: 'reserve', request: { walletHash: kat.view.walletHash, burner: shortTx } }, 'reserve burner not an address'],
    [{ ...sr, intent: 'unlink' }, 'unlink with a link request'],
    [{ ...sr, intent: 'unlink', request: { walletHash: null } }, 'unlink without a wallet'],
    [{ ...sr, sitePub: nonCanonical(sr.sitePub) }, 'sitePub non-canonical'],
  ].map(([body, reason]) => ({ body: JSON.stringify(body), reason }));
  invalidSessionRequests.push({ body: `${JSON.stringify(sr)}${' '.repeat(LINK2.SESSION_BODY_MAX_BYTES)}`, reason: 'size' });

  const rr = ok.responseRequest;
  const invalidResponseRequests = [
    ['link', { ...rr, extra: 1 }, 'extra key'],
    ['link', { ...rr, ct: b64u(Buffer.alloc(LINK2.CAPS.link.ct + 1, 3)) }, 'ct longer than the link cap'],
    ['claim', { ...rr, ct: b64u(Buffer.alloc(LINK2.CAPS.claim.ct + 1, 3)) }, 'ct longer than the claim cap'],
    ['connect', { ...rr, ct: b64u(Buffer.alloc(16, 2)) }, 'ct shorter than tag + 1'],
    ['link', { ...rr, appPub: nonCanonical(rr.appPub) }, 'appPub non-canonical'],
  ].map(([intent, body, reason]) => ({ intent, body: JSON.stringify(body), reason }));

  const answerOf = (n) => JSON.parse(byName(n).plaintext);
  const ctx = (n) => byName(n).context;
  const now = T + 60;
  const okA = answerOf('link-ok-check');
  const flipLast = (s) => s.slice(0, -1) + (s.at(-1) === '0' ? '1' : '0');
  const w24Consent = { ts: String(T), pk: b64u(w24.keys.publicKey), sig: okA.consent.sig };
  const resA = answerOf('reserve-ok');
  const invalidPlaintexts = [
    ['link-ok-check', { ...okA, nodeId: flipLast(okA.nodeId) }, 'nodeId'],
    ['link-ok-check', { ...okA, qnet: flipLast(okA.qnet) }, 'qnet'],
    ['link-ok-check', { ...okA, consent: w24Consent }, 'pk'],
    ['link-ok-check', { ...okA, consent: { ...okA.consent, sig: flipByte(okA.consent.sig, 10) } }, 'sig'],
    ['link-ok-check', { ...okA, consent: { ...okA.consent, ts: String(now - LINK2.CONSENT_PAST_S - 1) } }, 'ts'],
    ['link-ok-check', { ...okA, consent: { ...okA.consent, ts: String(now + LINK2.CONSENT_FUTURE_S + 1) } }, 'ts'],
    ['link-ok-check', { ...okA, consent: { ...okA.consent, ts: T } }, 'ts'],
    ['link-ok-check', { ...okA, consent: { ...okA.consent, pk: okA.consent.pk.slice(4) } }, 'pk'],
    ['link-ok-check', { ...okA, consent: { ts: okA.consent.ts, pk: okA.consent.pk } }, 'keys'],
    ['link-ok-check', { ...okA, bound: 'true' }, 'bound'],
    ['link-ok-check', { ...okA, device: { platform: 'ios' } }, 'keys'],
    ['link-ok-check', { ...okA, status: 'exists' }, 'status'],
    ['link-ok-check', { ...okA, v: 2 }, 'v'],
    ['link-ok-check', { ...okA, intent: 'claim' }, 'intent'],
    ['link-error', { ...okA }, 'walletHash'],
    ['link-linked', { ...okA }, 'status'],
    ['link-linked', { ...answerOf('link-linked'), seq: Number(T + 86400) }, 'seq'],
    ['link-linked', { ...answerOf('link-linked'), seq: '01' }, 'seq'],
    ['link-error', { ...answerOf('link-error'), error: 'PRICE_UNAVAILABLE' }, 'error'],
    ['claim-ok', { ...answerOf('claim-ok'), amountNano: '999999999' }, 'amountNano'],
    ['claim-ok', { ...answerOf('claim-ok'), amountNano: 12500000000 }, 'amountNano'],
    ['claim-ok', { ...answerOf('claim-ok'), txHash: answerOf('claim-ok').txHash.toUpperCase() }, 'txHash'],
    ['claim-ok', { ...answerOf('claim-ok'), stoppedAtEpoch: 155 }, 'stoppedAtEpoch'],
    ['claim-ok', (() => { const { stoppedAtEpoch, ...rest } = answerOf('claim-ok'); return rest; })(), 'keys'],
    ['claim-ok-partial', { ...answerOf('claim-ok-partial'), qnet: w24.view.address, nodeId: w24.view.nodeId }, 'walletHash'],
    ['claim-ok-partial-small', { ...answerOf('claim-ok-partial-small'), stoppedAtEpoch: null }, 'amountNano'],
    ['claim-ok-partial-small', { ...answerOf('claim-ok-partial-small'), amountNano: '0' }, 'amountNano'],
    ['claim-ok-partial-small', { ...answerOf('claim-ok-partial-small'), stoppedAtEpoch: 155 }, 'stoppedAtEpoch'],
    ['claim-empty', { ...answerOf('claim-empty'), nodeId: w24.view.nodeId }, 'nodeId'],
    ['connect-ok', { ...answerOf('connect-ok'), nodeType: 'light' }, 'keys'],
    ['connect-ok', { ...answerOf('connect-ok'), solana: base58Encode(sha256(utf8('short')).subarray(0, 31)) }, 'solana'],
    ['reserve-ok', { ...resA, qnet: w24.view.address }, 'walletHash'],
    ['reserve-ok', { ...resA, time: String(now - LINK2.RESERVE_PAST_S - 1) }, 'time'],
    ['reserve-ok', { ...resA, time: String(now + LINK2.RESERVE_FUTURE_S + 1) }, 'time'],
    ['reserve-ok', { ...resA, time: T }, 'time'],
    ['reserve-ok', { ...resA, pk: b64u(w24.keys.publicKey) }, 'pk'],
    ['reserve-ok', { ...resA, sig: flipByte(resA.sig, 10) }, 'sig'],
    // The same wallet's signature over another payment address's reservation.
    ['reserve-ok', { ...resA, sig: b64u(siteRecordSign(kat.keys, reservationMessage(resA.qnet, 'light', 'payment', 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', T))) }, 'sig'],
    // Its message with an empty context, as a plain signed message is not.
    ['reserve-ok', { ...resA, sig: b64u(ML.sign(Uint8Array.from(siteRecordEnvelope(reservationMessage(resA.qnet, 'light', 'payment', byName('reserve-ok').request.burner, T))), kat.keys.secretKey, { extraEntropy: false })) }, 'sig'],
    ['reserve-ok', { ...resA, nodeId: kat.view.nodeId }, 'keys'],
    ['reserve-ok', (() => { const { time, ...rest } = resA; return rest; })(), 'keys'],
    ['reserve-ok', { ...resA, status: 'linked' }, 'status'],
    ['reserve-error', { ...answerOf('reserve-error'), error: 'NO_NODE' }, 'error'],
    ['unlink-ok', { ...answerOf('unlink-ok'), unbound: 'true' }, 'unbound'],
    ['unlink-ok', (() => { const { unbound, ...rest } = answerOf('unlink-ok'); return rest; })(), 'keys'],
    ['unlink-ok', { ...answerOf('unlink-ok'), qnet: w24.view.address, nodeId: w24.view.nodeId }, 'walletHash'],
    ['unlink-ok', { ...answerOf('unlink-ok'), nodeId: w24.view.nodeId }, 'nodeId'],
    ['unlink-ok', { ...answerOf('unlink-ok'), status: 'linked' }, 'status'],
    ['unlink-error', { ...answerOf('unlink-error'), error: 'BIND_REFUSED' }, 'error'],
  ].map(([session, value, reason]) => ({ session, context: ctx(session), plaintext: JSON.stringify(value), reason }));
  invalidPlaintexts.push({ session: 'claim-rejected', context: ctx('claim-rejected'),
    plaintext: `{"v":1,"intent":"claim","status":"rejected"}${' '.repeat(LINK2.CAPS.claim.plaintext)}`, reason: 'size' });
  invalidPlaintexts.push({ session: 'claim-rejected', context: ctx('claim-rejected'), plaintext: '[1]', reason: 'json' });
  // Before two genesis nodes advertise consent_24h the window is the admission's 300 s.
  invalidPlaintexts.push({ session: 'link-ok-check', context: { ...ctx('link-ok-check'), now: String(T + 301), consent24h: false },
    plaintext: JSON.stringify(okA), reason: 'ts' });

  const androidIntent = {
    link: ok.link, package: LINK2.ANDROID_PACKAGE, browserFallbackUrl: ok.link,
    intentUrl: `intent://${ok.link.slice('https://'.length)}#Intent;scheme=https;package=${LINK2.ANDROID_PACKAGE};`
      + `S.browser_fallback_url=${encodeURIComponent(ok.link)};end`,
  };
  return { cryptoMustFail, invalidLinks, invalidSessionRequests, invalidResponseRequests, invalidPlaintexts, androidIntent };
}

// ---- self-checks ----

function assert(cond, what) {
  if (!cond) throw new Error(`self-check failed: ${what}`);
}

function referenceChecks() {
  // Published answers for the two primitives written out above.
  assert(hex(blake3(Buffer.alloc(0))) === 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262', 'blake3("")');
  const rfc = p256Sign(0xc9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721n, utf8('sample'));
  assert(rfc.r === 0xefd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716n
    && rfc.s === 0xf7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8n, 'RFC 6979 A.2.5 P-256/SHA-256 "sample"');
}

function selfCheck(v) {
  const kat = v.wallets[0];
  assert(kat.xi === KAT_PIN.xi && kat.publicKeySha3 === KAT_PIN.publicKeySha3 && kat.address === KAT_PIN.address, 'KAT wallet pin');
  for (const w of v.wallets) assert(isEonAddress(w.address) && w.nodeId === lightNodeId(w.address), `${w.name}: identity`);
  const pub = (name) => (name === 'ping' ? unhex(v.pingKey.publicKey) : unhex(v.wallets.find((w) => w.name === name).publicKey));
  for (const n of v.node) {
    for (const m of n.messages) {
      assert(sha3Hex(m.preimage) === m.preimageSha3, `${n.wallet} ${m.name}: sha3`);
      if (m.signer === 'burner') {
        const key = createPublicKey({ key: Buffer.concat([unhex('302a300506032b6570032100'), unhex(v.burner.publicKey)]), format: 'der', type: 'spki' });
        assert(nodeVerify(null, utf8(m.preimage), key, unhex(m.signature)), `${n.wallet} ${m.name}: ed25519`);
      } else {
        assert(mldsaVerify(pub(m.signer === 'wallet' ? n.wallet : 'ping'), m.preimage, unhex(m.signature)), `${n.wallet} ${m.name}: ml-dsa`);
      }
    }
  }
  const d = v.device;
  const key = (name) => unhex(d.keys[name].publicKey);
  const checkIos = (k, s, preimage, what) => {
    const cdh = sha256(utf8(preimage));
    assert(s.clientDataHash === hex(cdh), `${what}: clientDataHash`);
    const nonce = sha256(Buffer.concat([unhex(s.authenticatorData), cdh]));
    assert(hex(nonce) === s.nonce && unhex(s.authenticatorData).subarray(0, 32).equals(unhex(d.rpIdHash)), `${what}: nonce`);
    assert(p256Verify(key(k), nonce, Buffer.from(s.signatureDer, 'base64url')), `${what}: ios assertion`);
    assert(unhex(s.authenticatorData).readUInt32BE(33) === s.counter, `${what}: counter`);
  };
  const checkAndroid = (k, s, preimage, what) => {
    assert(p256Verify(key(k), utf8(preimage), Buffer.from(s.signatureDer, 'base64url')), `${what}: android signature`);
  };
  checkAndroid('android', d.report, d.report.text, 'report');
  for (const m of d.messages) {
    const what = `${m.name}/${m.platform}`;
    const oldKey = m.platform;
    if (m.reenrolAssertion) checkIos('ios', m.reenrolAssertion, m.preimage, what);
    if (m.name === 'rotate') {
      if (m.platform === 'ios') checkIos('ios', m.oldKey, m.preimage, what);
      else {
        checkAndroid('android', m.oldKey, m.preimage, what);
        assert(p256Verify(key('androidRotated'), utf8(d.report.text), Buffer.from(m.newKeyReportSignatureDer, 'base64url')), `${what}: new report`);
      }
    }
    if (m.device) (m.platform === 'ios' ? checkIos : checkAndroid)(oldKey, m.device, m.preimage, what);
    if (m.walletSignature) assert(mldsaVerify(pub('phrase-24'), m.preimage, unhex(m.walletSignature)), `${what}: wallet`);
  }
  const p = d.ping;
  assert(mldsaVerify(pub('ping'), p.challenge, unhex(p.sigma)) && sha3Hex(unhex(p.sigma)) === p.sigmaSha3, 'ping sigma');
  checkIos('ios', p.ios, p.ios.preimage, 'ping ios');
  checkAndroid('android', p.android, p.android.preimage, 'ping android');
  assert(p.android.wire === `ping_hw2:${p.sigma}.${p.android.signatureDer}.${p.android.hwSeq}`, 'ping android wire');
  assert(p.ios.wire === `ping_hw2:${p.sigma}.${p.ios.assertion}.0`, 'ping ios wire');
  for (const s of d.statements) {
    assert(mldsaVerify(unhex(d.oracle.publicKey), s.lease, unhex(s.oracleSignature)), `${s.platform}: lease signature`);
    assert(s.statement === DM.statement(s.statementFields), `${s.platform}: statement`);
  }

  const L = v.link;
  for (const c of L.cases) {
    assert(JSON.stringify(parseLink(c.link)) === JSON.stringify({ id: c.sessionId, sitePub: c.sessionRequest.sitePub, intent: c.intent, ...(c.reqHash ? { reqHash: c.reqHash } : {}) }), `${c.name}: link`);
    assert(validateSessionRequest(JSON.stringify(c.sessionRequest)), `${c.name}: session request`);
    assert(validateResponseRequest(JSON.stringify(c.responseRequest), c.intent), `${c.name}: response request`);
    if (c.request) assert(reqHashOf(requestText(c.intent, c.request)) === c.reqHash, `${c.name}: reqHash`);
    const pt = openAnswer({ sessionId: c.sessionId, intent: c.intent, reqHash: c.reqHash, sitePrivateKey: c.sitePrivateKey, ...c.responseRequest });
    assert(pt === c.plaintext, `${c.name}: decrypt`);
    validateAnswer(pt, { ...c.context, intent: c.intent, now: Number(c.context.now) });
  }
  for (const n of L.cryptoMustFail) {
    let failed = false;
    try { openAnswer(n); } catch { failed = true; }
    assert(failed, `crypto must fail: ${n.name}`);
  }
  for (const n of L.invalidLinks) assert(parseLink(n.link) === null, `link must fail: ${n.reason}`);
  for (const n of L.invalidSessionRequests) assert(validateSessionRequest(n.body) === null, `session request must fail: ${n.reason}`);
  for (const n of L.invalidResponseRequests) assert(validateResponseRequest(n.body, n.intent) === null, `response request must fail: ${n.reason}`);
  for (const n of L.invalidPlaintexts) {
    const session = L.cases.find((c) => c.name === n.session);
    let reason = null;
    try { validateAnswer(n.plaintext, { ...n.context, intent: session.intent, now: Number(n.context.now) }); } catch (e) { reason = e.message; }
    assert(reason === n.reason, `plaintext must fail with ${n.reason}, got ${reason} (${n.session})`);
  }
}

// Every other resolvable @noble copy: BLAKE3 over each identity input, and ML-DSA-65 over each signed message.
async function nobleCheck(dir, v) {
  const b3file = resolveFrom(dir, '@noble/hashes/blake3.js', '@noble/hashes/blake3');
  const pqfile = resolveFrom(dir, '@noble/post-quantum/ml-dsa.js');
  const checked = [];
  if (b3file) {
    const { blake3: nb3 } = await import(pathToFileURL(b3file).href);
    for (const w of v.wallets) {
      assert(`light_mobile_${hex(nb3(utf8(`LIGHT_NODE_PRIVACY_${w.address}`))).slice(0, 16)}` === w.nodeId, `noble blake3 ${w.name}`);
    }
    for (const n of v.node) assert(hex(nb3(utf8(`${n.burnTx}:${n.nodeId}:${v.wallets.find((w) => w.name === n.wallet).address}`))).slice(0, 32) === n.proof, `noble blake3 proof ${n.wallet}`);
    checked.push(`BLAKE3 (@noble/hashes ${versionOf(b3file, '@noble/hashes')})`);
  }
  if (pqfile) {
    const [major, minor] = versionOf(pqfile, '@noble/post-quantum').split('.').map(Number);
    if (major > 0 || minor >= 5) {
      const { ml_dsa65: nml } = await import(pathToFileURL(pqfile).href);
      for (const w of v.wallets) {
        const { publicKey } = nml.keygen(Uint8Array.from(unhex(w.xi)));
        assert(hex(publicKey) === w.publicKey, `noble ml-dsa keygen ${w.name}`);
      }
      const walletPk = (name) => Uint8Array.from(unhex(v.wallets.find((w) => w.name === name).publicKey));
      for (const n of v.node) {
        for (const m of n.messages.filter((x) => x.signer !== 'burner')) {
          const pk = m.signer === 'wallet' ? walletPk(n.wallet) : Uint8Array.from(unhex(v.pingKey.publicKey));
          assert(nml.verify(Uint8Array.from(unhex(m.signature)), utf8(m.preimage), pk), `noble ml-dsa ${n.wallet} ${m.name}`);
        }
      }
      for (const c of v.link.cases.filter((x) => x.intent === 'reserve' && JSON.parse(x.plaintext).status === 'ok')) {
        const a = JSON.parse(c.plaintext);
        const message = reservationMessage(a.qnet, 'light', 'payment', c.request.burner, a.time);
        assert(siteRecordVerify(decodeB64url(a.pk), message, decodeB64url(a.sig), nml), `noble ml-dsa ${c.name}`);
      }
      checked.push(`ML-DSA-65 (@noble/post-quantum ${versionOf(pqfile, '@noble/post-quantum')})`);
    }
  }
  return checked.length ? `ok, ${checked.join(', ')}: ${dir}` : `skipped (no @noble/hashes or @noble/post-quantum: ${dir})`;
}

// ---- main ----

function build() {
  const wallets = PHRASES.map(buildWallet);
  const [kat, w24] = wallets;
  const ping = buildSeededKey('ping', 'QNET_PING_');
  const oracle = buildSeededKey('oracle', 'QNET_TEST_ORACLE_');
  const burner = buildBurner();
  const cases = linkCases(kat, w24, burner).map(buildLinkCase);
  const negatives = linkNegatives(cases, kat, w24);
  return {
    about: 'Known answers for the light node contracts: identity, the wallet-key and ping-key messages, the device '
      + 'layer and QNet Link revision 2. Checked by the app (__tests__/LightNodeVectors.test.js), the extension '
      + '(test/light-node-vectors.test.mjs), the site (src/lib/__tests__/light-node-vectors.test.mjs) and, later, the node.',
    specs: ['docs/protocols/light-node-messages.md', 'docs/protocols/qnet-link-v1.md#14-revision-2'],
    generator: 'docs/protocols/tools/light-node-vectors.mjs',
    encodings: 'Preimages are UTF-8 text. Keys, hashes and ML-DSA-65 signatures are lowercase hex; ML-DSA-65 signatures '
      + 'are raw 3309-byte FIPS 204 signatures, deterministic (rnd = 32 zero bytes) with an empty context, except a '
      + '`reserve` answer\'s, which signs the site-record envelope of its reservation message with the context '
      + 'QNET_OFFCHAIN_MSG_v1 (constants.siteRecord). P-256 '
      + 'public keys are 65-byte uncompressed SEC1 points; device signatures are DER (b64url) and, for Android, also '
      + 'raw r||s (hex); nonces, key ids and QNet Link wire values are unpadded base64url; every u64 in a JSON body '
      + 'is a decimal string. Device keys, the ping key, the oracle key and the burner key are test keys from labels.',
    constants: {
      chainId: CHAIN_ID, chainTag: CHAIN_TAG, epochBlocks: EPOCH_BLOCKS, walletSeedPrefix: WALLET_SEED_PREFIX,
      mldsa65: { publicKeyBytes: MLDSA65.PUBLIC_KEY_BYTES, signatureBytes: MLDSA65.SIGNATURE_BYTES },
      platformBytes: PLATFORM_BYTE, iosBundleId: IOS_BUNDLE_ID,
      link: {
        prefix: LINK2.PREFIX, pattern: LINK2.RE.source, androidPackage: LINK2.ANDROID_PACKAGE, hkdfInfo: LINK2.HKDF_INFO,
        sasInfo: LINK2.SAS_INFO, aadPrefix: LINK2.AAD_PREFIX, walletHashPrefix: LINK2.WALLET_HASH_PREFIX,
        sessionTtlSeconds: LINK2.SESSION_TTL_S, sessionBodyMaxBytes: LINK2.SESSION_BODY_MAX_BYTES, caps: LINK2.CAPS,
        ciphertextMinBytes: LINK2.CT_MIN_BYTES, intents: LINK2.INTENTS, statuses: LINK2.STATUSES, errors: LINK2.ERRORS,
        requestKeys: REQUEST_KEYS, consentWindow: { pastSeconds: LINK2.CONSENT_PAST_S, pastSecondsBeforeConsent24h: LINK2.CONSENT_PAST_LEGACY_S, futureSeconds: LINK2.CONSENT_FUTURE_S },
        reserveWindow: { pastSeconds: LINK2.RESERVE_PAST_S, futureSeconds: LINK2.RESERVE_FUTURE_S },
        claimMinNano: String(LINK2.CLAIM_MIN_NANO),
      },
      siteRecord: { origin: SITE_RECORD.ORIGIN, header: SITE_RECORD.HEADER, context: SITE_RECORD.CONTEXT, cluster: SITE_RECORD.CLUSTER },
    },
    wallets: wallets.map((w) => w.view),
    pingKey: ping.view,
    burner: { ...burner.view, publicKey: hex(burner.pub) },
    anchor: { height: String(ANCHOR.height), hash: ANCHOR.hash, epoch: String(epochOf(ANCHOR.height)) },
    node: wallets.map((w) => buildNodeMessages(w, ping, burner)),
    device: buildDevice(kat, w24, ping, oracle),
    link: { cases, ...negatives },
  };
}

async function main(argv) {
  const check = argv.includes('--check');
  referenceChecks();
  const vectors = build();
  selfCheck(vectors);
  console.log(`node:crypto + ${ML_WHERE}: ${vectors.node.reduce((s, n) => s + n.messages.length, 0)} node messages, `
    + `${vectors.device.messages.length} device messages, ${vectors.link.cases.length} link cases, `
    + `${vectors.link.invalidLinks.length + vectors.link.invalidSessionRequests.length + vectors.link.invalidResponseRequests.length} `
    + `link/relay and ${vectors.link.invalidPlaintexts.length} answer negatives: ok`);
  for (const dir of nobleDirs()) console.log(`noble: ${await nobleCheck(dir, vectors)}`);

  const text = `${JSON.stringify(vectors, null, 2)}\n`;
  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== text) {
      console.error(`${OUT} differs from a fresh run`);
      process.exitCode = 1;
      return;
    }
    console.log(`${OUT} is up to date`);
    return;
  }
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
