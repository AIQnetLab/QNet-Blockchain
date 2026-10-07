#!/usr/bin/env node
// Test vectors for QNet Link v1 (docs/protocols/qnet-link-v1.md). No dependencies: X25519, HKDF-SHA256,
// AES-256-GCM and SHA3-256 come from node:crypto (OpenSSL), independent of the @noble libraries the site
// and the app use. The @noble libraries each package of NOBLE_PACKAGES resolves (or --noble) recompute
// each vector as well, every primitive that package takes from @noble.
// The file also holds a reference link parser, the Android intent: URL builder with a model of Android's
// Intent.parseUri, the burn order, and a response validator;
// they run over every vector.
//
//   node docs/protocols/tools/qnet-link-vectors.mjs            write ../qnet-link-v1.vectors.json
//   node docs/protocols/tools/qnet-link-vectors.mjs --check    exit 1 if the file differs from a fresh run
//   node docs/protocols/tools/qnet-link-vectors.mjs --noble <package or node_modules dir>   (repeatable)

import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const OUT = resolve(HERE, '../qnet-link-v1.vectors.json');
// The packages whose @noble libraries implement the protocol: the extension's crypto bundle, the site and the
// app. Resolved from each package's directory as Node resolves its imports, so a hoisted install counts (the
// site's @noble sits in the workspace root, applications/qnet-explorer/node_modules).
export const NOBLE_PACKAGES = [
  'applications/qnet-wallet/tools/crypto-bundle',
  'applications/qnet-explorer/frontend',
  'applications/qnet-mobile',
];

// ---- protocol constants (section 2 of the spec) ----

export const LINK = Object.freeze({
  PREFIX: 'https://link.aiqnet.io/l#v1.',
  RE: /^https:\/\/link\.aiqnet\.io\/l#v1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})\.(connect|activate)(?:\.(light|super))?$/,
  // The one Android package (sections 2 and 4.1).
  ANDROID_PACKAGES: ['io.aiqnet.wallet'],
  HKDF_INFO: 'qnet-link-v1',
  AAD_PREFIX: 'qnet-link-v1|',
  SESSION_TTL_S: 600,
  POLL_INTERVAL_MS: 2000,
  SESSION_BODY_MAX_BYTES: 1024,
  RESPONSE_BODY_MAX_BYTES: 4096,
  PLAINTEXT_MAX_BYTES: 1024,
  CT_MIN_BYTES: 17,
  CT_MAX_BYTES: 1040,
  BURN_AMOUNT_MAX: 1_000_000_000,
  INTENTS: ['connect', 'activate'],
  NODE_TYPES: ['light', 'super'],
  STATUSES: { connect: ['ok', 'rejected', 'error'], activate: ['ok', 'exists', 'pending', 'rejected', 'error'] },
  ERRORS: [
    'PRICE_UNAVAILABLE', 'PHASE_UNSUPPORTED', 'PRICE_CHANGED', 'INSUFFICIENT_SOL', 'INSUFFICIENT_TOKENS',
    'SIMULATION_FAILED', 'TX_FAILED', 'SOLANA_UNAVAILABLE', 'HISTORY_TOO_LONG', 'NODE_EXISTS', 'BURN_UNUSABLE',
    'BURN_IN_PROGRESS', 'NO_WALLET', 'INTERNAL',
  ],
});

const ID_RE = /^[0-9a-f]{32}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const CODE_RE = /^QNET-[LS][0-9A-F]{5}-[0-9A-F]{6}-[0-9A-F]{6}$/;
const EON_RE = /^([0-9a-f]{19})eon([0-9a-f]{15})([0-9a-f]{8})$/;

// ---- encodings ----

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(s, 'hex');
const b64u = (b) => Buffer.from(b).toString('base64url');
const utf8 = (s) => Buffer.from(s, 'utf8');
const sha256 = (s) => createHash('sha256').update(s).digest();
const sha512 = (s) => createHash('sha512').update(s).digest();
const sha3Hex = (s) => createHash('sha3-256').update(s, 'utf8').digest('hex');

/** Canonical unpadded base64url of exactly `len` bytes (any length when len is null), or null. */
export function decodeB64url(text, len = null) {
  if (typeof text !== 'string' || !B64URL_RE.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (b64u(bytes) !== text) return null; // padding bits must be zero
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

function base58Decode(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 100) return null;
  let n = 0n;
  for (const c of text) {
    const v = B58.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const body = n === 0n ? [] : [...unhex(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0'))];
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  return Buffer.from([...new Array(zeros).fill(0), ...body]);
}

const base58Len = (text) => base58Decode(text)?.length ?? -1;
export const isSolanaAddress = (s) => base58Len(s) === 32;
export const isSolanaSignature = (s) => base58Len(s) === 64;

export function isEonAddress(s) {
  const m = typeof s === 'string' ? EON_RE.exec(s) : null;
  return m !== null && sha3Hex(`${m[1]}eon${m[2]}`).slice(0, 8) === m[3];
}

// ---- activation code (node-identical, as core.generateActivationCode / core.walletActivationCode) ----

export function activationCode(nodeType, solana, burnTx, burnAmount) {
  const key = sha3Hex(`${burnTx}:${nodeType}:${burnAmount}`).substring(0, 32);
  const enc = Array.from(solana, (c, i) => (c.charCodeAt(0) ^ key.charCodeAt(i % 32)).toString(16).padStart(2, '0'))
    .join('').toUpperCase();
  const seg1 = (nodeType === 'super' ? 'S' : 'L') + sha3Hex(`ts:${burnTx}:${nodeType}`).substring(0, 5).toUpperCase();
  const seg2 = (enc + '000000').substring(0, 6);
  const seg3 = ((enc.substring(6, 10) + '0000').substring(0, 4)
    + sha3Hex(`entropy:${solana}:${burnTx}:${nodeType}`).substring(0, 4).toUpperCase()).substring(0, 6);
  return `QNET-${seg1}-${seg2}-${seg3}`;
}

// ---- crypto (node:crypto) ----

const PKCS8_X25519 = unhex('302e020100300506032b656e04220420');
const SPKI_X25519 = unhex('302a300506032b656e032100');

function clamp(bytes) {
  const k = Buffer.from(bytes);
  k[0] &= 248; k[31] &= 127; k[31] |= 64;
  return k;
}

const privKey = (raw) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const pubKey = (raw) => createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });

function x25519Public(priv) {
  return createPublicKey(privKey(priv)).export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length);
}

/** X25519(priv, pub); throws on a low-order public key (all-zero shared secret). */
function x25519Shared(priv, pub) {
  let shared;
  try {
    shared = diffieHellman({ privateKey: privKey(priv), publicKey: pubKey(pub) });
  } catch {
    throw new Error('x25519: rejected public key');
  }
  if (shared.every((b) => b === 0)) throw new Error('x25519: all-zero shared secret');
  return shared;
}

const aadOf = (id, intent) => utf8(`${LINK.AAD_PREFIX}${id}|${intent}`);
const deriveKey = (shared, id) => Buffer.from(hkdfSync('sha256', shared, unhex(id), utf8(LINK.HKDF_INFO), 32));

function seal(key, iv, aad, plaintext) {
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(aad);
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

function open(key, iv, aad, ct) {
  if (ct.length < 17) throw new Error('aes-gcm: short ciphertext');
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAAD(aad);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

/** The site's side: decrypt a relay response body for the session it created. */
export function openResponse({ sessionId, intent, sitePrivateKey, appPub, iv, ct }) {
  const app = decodeB64url(appPub, 32);
  const ivb = decodeB64url(iv, 12);
  const ctb = decodeB64url(ct);
  if (!app || !ivb || !ctb) throw new Error('encoding');
  const key = deriveKey(x25519Shared(unhex(sitePrivateKey), app), sessionId);
  return open(key, ivb, aadOf(sessionId, intent), ctb).toString('utf8');
}

// ---- reference parsers and validators ----

/** Parses a link exactly (no trimming, no decoding); returns {id, sitePub, intent, nodeType} or null. */
export function parseLink(text) {
  const m = typeof text === 'string' ? LINK.RE.exec(text) : null;
  if (!m) return null;
  const [, id, sitePub, intent, nodeType] = m;
  if ((intent === 'activate') !== (nodeType !== undefined)) return null;
  if (!decodeB64url(sitePub, 32)) return null;
  return nodeType ? { id, sitePub, intent, nodeType } : { id, sitePub, intent };
}

// ---- Android launch (section 4.1) ----

/** The intent: URL that opens `link` in the app `pkg`; Chrome loads `fallback` when that app is missing. */
export function androidIntentUrl(link, pkg, fallback) {
  if (!parseLink(link) || !LINK.ANDROID_PACKAGES.includes(pkg) || !/^https:\/\//.test(fallback)) throw new Error('intent');
  return `intent://${link.slice('https://'.length)}#Intent;scheme=https;package=${pkg};`
    + `S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

/**
 * What Android's Intent.parseUri(url, URI_INTENT_SCHEME) makes of an intent: URL, as Chrome calls it:
 * {data, package, fallback}. The extras start at the LAST '#', so the text before it keeps its own fragment.
 */
export function parseIntentUrl(url) {
  const i = url.lastIndexOf('#');
  if (!url.startsWith('intent:') || i < 0 || !url.startsWith('#Intent;', i) || !url.endsWith(';end')) return null;
  const fields = Object.fromEntries(url.slice(i + 8, -4).split(';').map((f) => {
    const eq = f.indexOf('=');
    return [f.slice(0, eq), decodeURIComponent(f.slice(eq + 1))];
  }));
  return { data: `${fields.scheme}:${url.slice('intent:'.length, i)}`, package: fields.package, fallback: fields['S.browser_fallback_url'] };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (obj, keys) => {
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
};

/** POST /api/link/sessions body (JSON text) → {id, sitePub, intent, nodeType?} or null. */
export function validateSessionRequest(text) {
  if (typeof text !== 'string' || utf8(text).length > LINK.SESSION_BODY_MAX_BYTES) return null;
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  if (!isPlainObject(body)) return null;
  const activate = body.intent === 'activate';
  if (!sameKeys(body, activate ? ['id', 'sitePub', 'intent', 'nodeType'] : ['id', 'sitePub', 'intent'])) return null;
  if (typeof body.id !== 'string' || !ID_RE.test(body.id)) return null;
  if (!decodeB64url(body.sitePub, 32)) return null;
  if (!LINK.INTENTS.includes(body.intent)) return null;
  if (activate && !LINK.NODE_TYPES.includes(body.nodeType)) return null;
  return body;
}

/** POST /api/link/sessions/:id/response body (JSON text) → {appPub, iv, ct} or null. */
export function validateResponseRequest(text) {
  if (typeof text !== 'string' || utf8(text).length > LINK.RESPONSE_BODY_MAX_BYTES) return null;
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  if (!isPlainObject(body) || !sameKeys(body, ['appPub', 'iv', 'ct'])) return null;
  if (!decodeB64url(body.appPub, 32) || !decodeB64url(body.iv, 12)) return null;
  const ct = decodeB64url(body.ct);
  if (!ct || ct.length < LINK.CT_MIN_BYTES || ct.length > LINK.CT_MAX_BYTES) return null;
  return body;
}

const ADDRS = ['qnet', 'solana'];
const ACTIVATION = ['nodeType', 'burnTx', 'burnAmount', 'code'];
const BASE = ['v', 'intent', 'status'];

// The optional key of section 7.1: only in an `exists` answer.
function marksOf(intent, status, body) {
  if (intent !== 'activate') return [];
  return status === 'exists' && Object.hasOwn(body, 'supersededBurnTx') ? ['supersededBurnTx'] : [];
}

function shapeOf(intent, status, body) {
  if (status === 'rejected') return BASE;
  if (status === 'error') return [...BASE, 'error'];
  const marks = marksOf(intent, status, body);
  if (status === 'pending') return [...BASE, ...ADDRS, 'nodeType', 'burnTx', 'burnAmount', ...marks];
  if (intent === 'connect' && !Object.hasOwn(body, 'code') && !Object.hasOwn(body, 'nodeType')) return [...BASE, ...ADDRS];
  return [...BASE, ...ADDRS, ...ACTIVATION, ...marks];
}

/**
 * The decrypted response plaintext against the session the site created. Returns the parsed object, or
 * throws with a reason. The extension's qnet_activateNode result is checked the same way after adding
 * {v: 1, intent: 'activate'}.
 */
export function validateResponse(plaintext, { intent, nodeType }) {
  if (typeof plaintext !== 'string' || utf8(plaintext).length > LINK.PLAINTEXT_MAX_BYTES) throw new Error('size');
  let r;
  try { r = JSON.parse(plaintext); } catch { throw new Error('json'); }
  if (!isPlainObject(r)) throw new Error('json');
  if (r.v !== 1) throw new Error('v');
  if (r.intent !== intent) throw new Error('intent');
  if (!LINK.STATUSES[intent].includes(r.status)) throw new Error('status');
  if (!sameKeys(r, shapeOf(intent, r.status, r))) throw new Error('keys');
  if (r.status === 'error' && !LINK.ERRORS.includes(r.error)) throw new Error('error');
  if (Object.hasOwn(r, 'qnet') && !isEonAddress(r.qnet)) throw new Error('qnet');
  if (Object.hasOwn(r, 'solana') && !isSolanaAddress(r.solana)) throw new Error('solana');
  if (Object.hasOwn(r, 'nodeType')) {
    if (!LINK.NODE_TYPES.includes(r.nodeType)) throw new Error('nodeType');
    if (r.status === 'ok' && intent === 'activate' && r.nodeType !== nodeType) throw new Error('nodeType');
    if (!isSolanaSignature(r.burnTx)) throw new Error('burnTx');
    if (!Number.isSafeInteger(r.burnAmount) || r.burnAmount < 1 || r.burnAmount > LINK.BURN_AMOUNT_MAX) {
      throw new Error('burnAmount');
    }
  }
  if (Object.hasOwn(r, 'code')) {
    if (typeof r.code !== 'string' || !CODE_RE.test(r.code)) throw new Error('code');
    if (activationCode(r.nodeType, r.solana, r.burnTx, r.burnAmount) !== r.code) throw new Error('code');
  }
  if (Object.hasOwn(r, 'supersededBurnTx') && (!isSolanaSignature(r.supersededBurnTx) || r.supersededBurnTx === r.burnTx)) {
    throw new Error('supersededBurnTx');
  }
  return r;
}

// ---- vector construction ----

const label = (name, part) => `qnet-link-v1/vector/${name}/${part}`;
const WALLET = Object.freeze({
  // core.KAT (applications/qnet-wallet/tools/crypto-bundle/src/selftest.js): 'abandon' x11 + 'about'.
  qnet: 'd9fa370374e24333242eon847d1d354dcd87fe873823e',
  solana: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
});
const CODE_KAT = Object.freeze({
  nodeType: 'light',
  solanaAddress: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR',
  burnTx: 'nqh74heddHDKQbzTqJAmu6o8VZEyBbdsfJcDJTtfPCYgTmGagX2xsrdZhkKFKBGFHyEq6tyNFrgZWrbTatq8Ywx',
  burnAmount: 1500,
  code: 'QNET-LFEFD9-706058-537636',
});
// A light burn made by aiqnet.io's one-time payment key for the KAT wallet: the code names the wallet's QNet address.
const WALLET_CODE_KAT = Object.freeze({
  nodeType: 'light',
  qnetAddress: WALLET.qnet,
  burnTx: CODE_KAT.burnTx,
  burnAmount: CODE_KAT.burnAmount,
  code: activationCode('light', WALLET.qnet, CODE_KAT.burnTx, CODE_KAT.burnAmount),
});

// Synthetic burn signatures (64 bytes each); they exist on no cluster.
const burnTx = (name) => base58Encode(sha512(label(name, 'burnTx')));

function activationOf(nodeType, name, burnAmount) {
  const tx = burnTx(name);
  return { nodeType, burnTx: tx, burnAmount, code: activationCode(nodeType, WALLET.solana, tx, burnAmount) };
}

// ---- burn order (section 3) ----

// A wallet's burns oldest first: by slot, then by place in the getSignaturesForAddress listing, which runs
// newest first, so of two entries of one slot the one listed later is the older. `pages` are the listing's
// pages in the order they were fetched, each newest first; places count across pages.
export function burnsOldestFirst(pages) {
  const entries = pages.flat().map((e, place) => ({ signature: e.signature, slot: e.slot, place }));
  return entries.sort((a, b) => (a.slot - b.slot) || (b.place - a.place)).map((e) => e.signature);
}

const orderSig = (name) => base58Encode(sha512(label(name, 'burnOrder')));

// Each case with the order written out by hand (labels, oldest first): the reference must reproduce it.
const BURN_ORDER_CASES = [
  ['distinct-slots', [[['a', 300], ['b', 200], ['c', 100]]], ['c', 'b', 'a']],
  ['same-slot', [[['d', 501], ['e', 500], ['f', 500], ['g', 499]]], ['g', 'f', 'e', 'd']],
  ['same-slot-across-pages', [[['h', 700], ['i', 650]], [['j', 650], ['k', 600]]], ['k', 'j', 'i', 'h']],
  ['three-in-one-slot', [[['l', 900], ['m', 900], ['n', 900]]], ['n', 'm', 'l']],
];

function buildBurnOrder() {
  return {
    rule: 'Oldest first by slot; of two entries of one slot, the one getSignaturesForAddress lists later (it lists '
      + 'newest first) is the older. Places count across pages. The first entry of oldestFirst is the wallet\'s '
      + 'activation when every entry is a valid burn.',
    cases: BURN_ORDER_CASES.map(([name, pages, expected]) => {
      const listing = pages.map((page) => page.map(([l, slot]) => ({ signature: orderSig(l), slot })));
      const oldestFirst = burnsOldestFirst(listing);
      assert(JSON.stringify(oldestFirst) === JSON.stringify(expected.map(orderSig)), `burn order ${name}: reference`);
      return { name, pages: listing, oldestFirst };
    }),
  };
}

const CASES = [
  ['activate-light-ok', 'activate', 'light', { status: 'ok', ...WALLET, ...activationOf('light', 'activate-light-ok', 1500) }],
  ['activate-super-ok', 'activate', 'super', { status: 'ok', ...WALLET, ...activationOf('super', 'activate-super-ok', 1500) }],
  // The wallet already holds a light activation; a super request answers with that one.
  ['activate-super-exists-light', 'activate', 'super', { status: 'exists', ...WALLET, ...activationOf('light', 'existing', 1500) }],
  ['activate-light-pending', 'activate', 'light', (() => {
    const { code, ...rest } = activationOf('light', 'activate-light-pending', 1500);
    return { status: 'pending', ...WALLET, ...rest };
  })()],
  ['activate-light-rejected', 'activate', 'light', { status: 'rejected' }],
  ['activate-super-error', 'activate', 'super', { status: 'error', error: 'INSUFFICIENT_TOKENS' }],
  ['connect-ok', 'connect', null, { status: 'ok', ...WALLET }],
  ['connect-ok-activated', 'connect', null, { status: 'ok', ...WALLET, ...activationOf('light', 'existing', 1500) }],
  ['connect-rejected', 'connect', null, { status: 'rejected' }],
  // Section 7.1: this device's super burn went through, but another device's older light burn is the wallet's
  // activation; the answer carries that one and names this device's burn.
  ['activate-super-exists-superseded', 'activate', 'super', {
    status: 'exists', ...WALLET, ...activationOf('light', 'older-device', 1500),
    supersededBurnTx: burnTx('activate-super-exists-superseded'),
  }],
];

function buildCase([name, intent, nodeType, answer]) {
  const id = hex(sha256(label(name, 'id')).subarray(0, 16));
  const sitePriv = clamp(sha256(label(name, 'site')));
  const appPriv = clamp(sha256(label(name, 'app')));
  const iv = sha256(label(name, 'iv')).subarray(0, 12);
  const sitePub = x25519Public(sitePriv);
  const appPub = x25519Public(appPriv);
  const shared = x25519Shared(appPriv, sitePub);
  if (!shared.equals(x25519Shared(sitePriv, appPub))) throw new Error(`${name}: ECDH mismatch`);
  const key = deriveKey(shared, id);
  const plaintext = JSON.stringify({ v: 1, intent, ...answer });
  const aad = `${LINK.AAD_PREFIX}${id}|${intent}`;
  const ct = seal(key, iv, utf8(aad), utf8(plaintext));
  const sessionRequest = { id, sitePub: b64u(sitePub), intent, ...(nodeType ? { nodeType } : {}) };
  return {
    name,
    intent,
    nodeType,
    sessionId: id,
    hkdfSalt: id,
    sitePrivateKey: hex(sitePriv),
    sitePublicKey: hex(sitePub),
    link: `${LINK.PREFIX}${id}.${b64u(sitePub)}.${intent}${nodeType ? `.${nodeType}` : ''}`,
    sessionRequest,
    appPrivateKey: hex(appPriv),
    appPublicKey: hex(appPub),
    sharedSecret: hex(shared),
    hkdfInfo: LINK.HKDF_INFO,
    key: hex(key),
    aad,
    plaintext,
    iv: hex(iv),
    ciphertext: hex(ct),
    responseRequest: { appPub: b64u(appPub), iv: b64u(iv), ct: b64u(ct) },
  };
}

const B64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Flips the lowest bit of the last character, a padding bit for 32-byte keys: a lenient decoder still
// returns the same bytes, so only a canonical check refuses it.
function nonCanonical(text) {
  const last = B64URL_CHARS.indexOf(text.at(-1));
  return text.slice(0, -1) + B64URL_CHARS[last ^ 1];
}

function flipByte(b64, index) {
  const bytes = Buffer.from(b64, 'base64url');
  bytes[index < 0 ? bytes.length + index : index] ^= 0x01;
  return b64u(bytes);
}

const LOW_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];

function buildNegatives(cases) {
  const a = cases[0];
  const c = cases[6];
  const base = {
    sessionId: a.sessionId, intent: a.intent, sitePrivateKey: a.sitePrivateKey,
    appPub: a.responseRequest.appPub, iv: a.responseRequest.iv, ct: a.responseRequest.ct,
  };
  const otherId = hex(sha256(label('negative', 'id')).subarray(0, 16));
  const cryptoMustFail = [
    { name: 'tag-bit-flipped', ...base, ct: flipByte(base.ct, -1) },
    { name: 'ciphertext-bit-flipped', ...base, ct: flipByte(base.ct, 0) },
    { name: 'iv-bit-flipped', ...base, iv: flipByte(base.iv, 0) },
    { name: 'aad-intent-swapped', ...base, intent: 'connect' },
    { name: 'session-id-changed', ...base, sessionId: otherId },
    { name: 'wrong-site-key', ...base, sitePrivateKey: c.sitePrivateKey },
    { name: 'app-key-from-other-session', ...base, appPub: c.responseRequest.appPub },
    ...LOW_ORDER.map((k, i) => ({ name: `low-order-app-key-${i}`, ...base, appPub: b64u(unhex(k)) })),
  ];

  const L = a.link;
  const id = a.sessionId;
  const pub = a.sessionRequest.sitePub;
  const tail = `${id}.${pub}.activate.light`;
  const H = 'https://link.aiqnet.io/l';
  const invalidLinks = [
    [`http://link.aiqnet.io/l#v1.${tail}`, 'scheme'],
    [`https://aiqnet.io/l#v1.${tail}`, 'host (the site, not the link host)'],
    [`https://www.link.aiqnet.io/l#v1.${tail}`, 'host'],
    [`https://link.aiqnet.io.example.com/l#v1.${tail}`, 'host'],
    [`https://LINK.AIQNET.IO/l#v1.${tail}`, 'host case'],
    [`https://link.aiqnet.io:443/l#v1.${tail}`, 'port'],
    [`https://user@link.aiqnet.io/l#v1.${tail}`, 'userinfo'],
    [`https://link.aiqnet.io/l/#v1.${tail}`, 'path'],
    [`https://link.aiqnet.io/L#v1.${tail}`, 'path case'],
    [`https://link.aiqnet.io/l?x=1#v1.${tail}`, 'query'],
    [`https://link.aiqnet.io/l?v1.${tail}`, 'payload in the query'],
    [`https://link.aiqnet.io/l/v1.${tail}`, 'payload in the path'],
    [`intent://link.aiqnet.io/l#v1.${tail}#Intent;scheme=https;package=io.aiqnet.wallet;end`, 'intent URL'],
    [`${L}#Intent;scheme=https;end`, 'second fragment'],
    [`${H}#v2.${tail}`, 'version'],
    [`${H}#V1.${tail}`, 'version case'],
    [`${H}#v1.${id.toUpperCase()}.${pub}.activate.light`, 'id uppercase'],
    [`${H}#v1.${id.slice(1)}.${pub}.activate.light`, 'id length'],
    [`${H}#v1.${id}.${nonCanonical(pub)}.activate.light`, 'sitePub non-canonical'],
    [`${H}#v1.${id}.${pub}=.activate.light`, 'sitePub padding'],
    [`${H}#v1.${id}.${pub.slice(1)}.activate.light`, 'sitePub length'],
    [`${H}#v1.${id}.+${pub.slice(1)}.activate.light`, 'sitePub alphabet'],
    [`${H}#v1.${id}.${pub}.activate`, 'activate without nodeType'],
    [`${H}#v1.${id}.${pub}.connect.light`, 'connect with nodeType'],
    [`${H}#v1.${id}.${pub}.activate.full`, 'nodeType'],
    [`${H}#v1.${id}.${pub}.Activate.light`, 'intent case'],
    [`${H}#v1.${id}.${pub}.burn.light`, 'intent'],
    [`${L}.`, 'trailing separator'],
    [`${L}.extra`, 'extra segment'],
    [`${L} `, 'trailing space'],
    [`${L}\n`, 'trailing newline'],
    [` ${L}`, 'leading space'],
    [L.replace('#', '%23'), 'encoded fragment'],
    [H, 'no fragment'],
    [`${H}#`, 'empty fragment'],
  ].map(([link, reason]) => ({ link, reason }));

  const sr = a.sessionRequest;
  const cr = c.sessionRequest;
  const invalidSessionRequests = [
    [{ ...sr, extra: 1 }, 'extra key'],
    [{ ...cr, nodeType: 'light' }, 'connect with nodeType'],
    [{ id: sr.id, sitePub: sr.sitePub, intent: 'activate' }, 'activate without nodeType'],
    [{ ...sr, nodeType: 'Light' }, 'nodeType'],
    [{ ...sr, intent: 'burn' }, 'intent'],
    [{ ...sr, id: sr.id.toUpperCase() }, 'id uppercase'],
    [{ ...sr, id: sr.id.slice(2) }, 'id length'],
    [{ ...sr, sitePub: nonCanonical(sr.sitePub) }, 'sitePub non-canonical'],
    [{ ...sr, sitePub: `${sr.sitePub}=` }, 'sitePub padding'],
    [{ ...sr, sitePub: b64u(Buffer.alloc(31, 7)) }, 'sitePub length'],
    [[sr], 'not an object'],
  ].map(([body, reason]) => ({ body: JSON.stringify(body), reason }));
  invalidSessionRequests.push({ body: `${JSON.stringify(sr)}${' '.repeat(LINK.SESSION_BODY_MAX_BYTES)}`, reason: 'size' });
  invalidSessionRequests.push({ body: '{"id":', reason: 'json' });

  const rr = a.responseRequest;
  const invalidResponseRequests = [
    [{ ...rr, extra: 1 }, 'extra key'],
    [{ appPub: rr.appPub, iv: rr.iv }, 'missing ct'],
    [{ ...rr, appPub: nonCanonical(rr.appPub) }, 'appPub non-canonical'],
    [{ ...rr, iv: rr.iv.slice(1) }, 'iv length'],
    [{ ...rr, iv: b64u(Buffer.alloc(16, 1)) }, 'iv 16 bytes'],
    [{ ...rr, ct: '' }, 'ct empty'],
    [{ ...rr, ct: b64u(Buffer.alloc(16, 2)) }, 'ct shorter than tag + 1'],
    [{ ...rr, ct: b64u(Buffer.alloc(LINK.CT_MAX_BYTES + 1, 3)) }, 'ct longer than the plaintext cap allows'],
    [{ ...rr, ct: `${rr.ct}==` }, 'ct padding'],
    [{ ...rr, ct: `/${rr.ct.slice(1)}` }, 'ct alphabet'],
  ].map(([body, reason]) => ({ body: JSON.stringify(body), reason }));

  const lightOk = JSON.parse(a.plaintext);
  const act = { intent: 'activate', nodeType: 'light' };
  const con = { intent: 'connect', nodeType: null };
  const flipLast = (s) => s.slice(0, -1) + (s.at(-1) === '0' ? '1' : '0');
  const shortTx = base58Encode(sha512('short').subarray(0, 63));
  const shortAddr = base58Encode(sha256('short').subarray(0, 31));
  const invalidPlaintexts = [
    [act, { ...lightOk, code: flipLast(lightOk.code) }, 'code'],
    [act, { ...lightOk, code: `QNET-S${lightOk.code.slice(6)}` }, 'code'],
    [act, { ...lightOk, qnet: flipLast(lightOk.qnet) }, 'qnet'],
    [act, { ...lightOk, solana: shortAddr }, 'solana'],
    [act, { ...lightOk, burnTx: shortTx }, 'burnTx'],
    [act, { ...lightOk, burnAmount: '1500' }, 'burnAmount'],
    [act, { ...lightOk, burnAmount: 1500.5 }, 'burnAmount'],
    [act, { ...lightOk, burnAmount: 0 }, 'burnAmount'],
    [{ intent: 'activate', nodeType: 'super' }, lightOk, 'nodeType'],
    [act, { ...lightOk, note: 'x' }, 'keys'],
    [act, { ...lightOk, v: 2 }, 'v'],
    [act, { ...lightOk, intent: 'connect' }, 'intent'],
    [act, (() => { const { qnet, ...r } = lightOk; return r; })(), 'keys'],
    [act, { v: 1, intent: 'activate', status: 'rejected', ...WALLET }, 'keys'],
    [act, { v: 1, intent: 'activate', status: 'error', error: 'NOT_A_CODE' }, 'error'],
    [act, { v: 1, intent: 'activate', status: 'done' }, 'status'],
    [con, { v: 1, intent: 'connect', status: 'exists', ...WALLET, ...activationOf('light', 'existing', 1500) }, 'status'],
    [con, (() => { const { code, ...r } = JSON.parse(cases[7].plaintext); return r; })(), 'keys'],
  ].map(([session, value, reason]) => ({ session, plaintext: JSON.stringify(value), reason }));
  invalidPlaintexts.push({ session: act, plaintext: '[1]', reason: 'json' });
  invalidPlaintexts.push({ session: act, plaintext: 'not json', reason: 'json' });
  invalidPlaintexts.push({
    session: act,
    plaintext: `{"v":1,"intent":"activate","status":"rejected"}${' '.repeat(LINK.PLAINTEXT_MAX_BYTES)}`,
    reason: 'size',
  });

  // Section 7.1: the optional key, where it may stand and what it holds.
  const byName = (name) => JSON.parse(cases.find((c) => c.name === name).plaintext);
  const superseded = byName('activate-super-exists-superseded');
  const pending = byName('activate-light-pending');
  const actSuper = { intent: 'activate', nodeType: 'super' };
  const otherTx = burnTx('negative-superseded');
  invalidPlaintexts.push(...[
    [actSuper, { ...superseded, supersededBurnTx: superseded.burnTx }, 'supersededBurnTx'],
    [actSuper, { ...superseded, supersededBurnTx: shortTx }, 'supersededBurnTx'],
    [actSuper, { ...superseded, supersededBurnTx: null }, 'supersededBurnTx'],
    [act, { ...lightOk, supersededBurnTx: otherTx }, 'keys'],
    [act, { ...pending, supersededBurnTx: otherTx }, 'keys'],
    [con, { ...byName('connect-ok-activated'), supersededBurnTx: otherTx }, 'keys'],
  ].map(([session, value, reason]) => ({ session, plaintext: JSON.stringify(value), reason })));

  return { cryptoMustFail, invalidLinks, invalidSessionRequests, invalidResponseRequests, invalidPlaintexts };
}

// The site's Android launches (section 4.1): the one package, with the link page (the link itself) as the fallback.
function buildAndroidIntents(cases) {
  const byName = (name) => cases.find((c) => c.name === name);
  return [
    ['activate-light-ok', 'io.aiqnet.wallet', null],
    ['connect-ok', 'io.aiqnet.wallet', null],
  ].map(([name, pkg, fallback]) => {
    const { link } = byName(name);
    const browserFallbackUrl = fallback ?? link;
    return { case: name, package: pkg, link, browserFallbackUrl, intentUrl: androidIntentUrl(link, pkg, browserFallbackUrl) };
  });
}

// ---- self-checks ----

function assert(cond, what) {
  if (!cond) throw new Error(`self-check failed: ${what}`);
}

function selfCheck(v) {
  const k = v.activationCodeKat;
  assert(activationCode(k.nodeType, k.solanaAddress, k.burnTx, k.burnAmount) === k.code, 'activation code KAT');
  const w = v.walletActivationCodeKat;
  assert(isEonAddress(w.qnetAddress) && w.code !== k.code, 'wallet activation code KAT');
  assert(activationCode(w.nodeType, w.qnetAddress, w.burnTx, w.burnAmount) === w.code, 'wallet activation code KAT');
  assert(isEonAddress(v.wallet.qnet) && isSolanaAddress(v.wallet.solana), 'KAT wallet addresses');
  for (const c of v.cases) {
    assert(JSON.stringify(parseLink(c.link)) === JSON.stringify(c.sessionRequest), `${c.name}: link parse`);
    assert(validateSessionRequest(JSON.stringify(c.sessionRequest)), `${c.name}: session request`);
    assert(validateResponseRequest(JSON.stringify(c.responseRequest)), `${c.name}: response request`);
    const pt = openResponse({ sessionId: c.sessionId, intent: c.intent, sitePrivateKey: c.sitePrivateKey, ...c.responseRequest });
    assert(pt === c.plaintext, `${c.name}: decrypt`);
    validateResponse(pt, { intent: c.intent, nodeType: c.nodeType });
  }
  for (const n of v.cryptoMustFail) {
    let failed = false;
    try { openResponse(n); } catch { failed = true; }
    assert(failed, `crypto must fail: ${n.name}`);
  }
  for (const n of v.invalidLinks) assert(parseLink(n.link) === null, `link must fail: ${n.reason}`);
  for (const a of v.androidIntents) {
    const parsed = parseIntentUrl(a.intentUrl);
    assert(parsed.data === a.link && parsed.package === a.package && parsed.fallback === a.browserFallbackUrl,
      `android intent ${a.case} ${a.package}: parseUri`);
    assert(parseLink(a.intentUrl) === null, `android intent ${a.case}: not a link itself`);
  }
  for (const n of v.invalidSessionRequests) assert(validateSessionRequest(n.body) === null, `session request must fail: ${n.reason}`);
  for (const n of v.invalidResponseRequests) assert(validateResponseRequest(n.body) === null, `response request must fail: ${n.reason}`);
  for (const n of v.invalidPlaintexts) {
    let reason = null;
    try { validateResponse(n.plaintext, n.session); } catch (e) { reason = e.message; }
    assert(reason === n.reason, `plaintext must fail with ${n.reason}, got ${reason}`);
  }
  assert(v.burnOrder.cases.some((c) => c.pages.length > 1), 'burn order: a case across pages');
  for (const c of v.burnOrder.cases) {
    for (const e of c.pages.flat()) assert(isSolanaSignature(e.signature) && Number.isSafeInteger(e.slot), `burn order ${c.name}: entry`);
    assert(JSON.stringify(burnsOldestFirst(c.pages)) === JSON.stringify(c.oldestFirst), `burn order ${c.name}`);
  }
}

// The @noble modules `dir` (a package directory, or a node_modules directory) resolves, and where each is.
export function nobleResolver(dir) {
  const req = createRequire(join(dir, 'package.json'));
  const resolveFirst = (...specs) => {
    for (const spec of specs) {
      try { return req.resolve(spec); } catch { /* next spelling */ }
    }
    return null;
  };
  return {
    curves: resolveFirst('@noble/curves/ed25519.js', '@noble/curves/ed25519'),
    hkdf: resolveFirst('@noble/hashes/hkdf.js', '@noble/hashes/hkdf'),
    sha2: resolveFirst('@noble/hashes/sha2.js', '@noble/hashes/sha256'),
    aes: resolveFirst('@noble/ciphers/aes.js', '@noble/ciphers/aes'),
  };
}

// The version in the package.json of the package that holds `file` (the nearest one named `name`).
function versionOf(file, name) {
  for (let d = dirname(file); d !== dirname(d); d = dirname(d)) {
    try {
      const p = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
      if (p.name === name) return p.version;
    } catch { /* go up */ }
  }
  return '?';
}

async function nobleCheck(dir, v) {
  const found = nobleResolver(dir);
  const load = async (file) => (file ? import(pathToFileURL(file).href) : null);
  const [curves, hkdfMod, sha2Mod, aesMod] = await Promise.all([load(found.curves), load(found.hkdf), load(found.sha2), load(found.aes)]);
  const x25519 = curves?.x25519;
  const hkdf = hkdfMod?.hkdf;
  const nobleSha256 = sha2Mod?.sha256;
  const gcm = aesMod?.gcm;
  if (!x25519) return `skipped (no @noble/curves: ${dir})`;
  const withHkdf = Boolean(hkdf && nobleSha256);
  const withGcm = Boolean(gcm);
  for (const c of v.cases) {
    const site = unhex(c.sitePrivateKey);
    const app = unhex(c.appPrivateKey);
    assert(hex(x25519.getPublicKey(site)) === c.sitePublicKey, `noble ${c.name}: site public key`);
    assert(hex(x25519.getPublicKey(app)) === c.appPublicKey, `noble ${c.name}: app public key`);
    const shared = x25519.getSharedSecret(app, unhex(c.sitePublicKey));
    assert(hex(shared) === c.sharedSecret, `noble ${c.name}: shared`);
    assert(hex(x25519.getSharedSecret(site, unhex(c.appPublicKey))) === c.sharedSecret, `noble ${c.name}: shared (site)`);
    const key = withHkdf ? hkdf(nobleSha256, shared, unhex(c.sessionId), utf8(c.hkdfInfo), 32) : unhex(c.key);
    assert(hex(key) === c.key, `noble ${c.name}: key`);
    if (withGcm) {
      const ct = gcm(key, unhex(c.iv), utf8(c.aad)).encrypt(utf8(c.plaintext));
      assert(hex(ct) === c.ciphertext, `noble ${c.name}: ciphertext`);
      assert(Buffer.from(gcm(key, unhex(c.iv), utf8(c.aad)).decrypt(ct)).toString('utf8') === c.plaintext, `noble ${c.name}: decrypt`);
    }
  }
  const site = unhex(v.cases[0].sitePrivateKey);
  for (const k of v.lowOrderPublicKeys) {
    let rejected = false;
    try {
      const s = x25519.getSharedSecret(site, unhex(k));
      rejected = s.every((b) => b === 0);
    } catch { rejected = true; }
    assert(rejected, `noble: low-order key ${k} rejected`);
  }
  const checked = [`X25519 (@noble/curves ${versionOf(found.curves, '@noble/curves')})`];
  if (withHkdf) checked.push(`HKDF-SHA256 (@noble/hashes ${versionOf(found.hkdf, '@noble/hashes')})`);
  if (withGcm) checked.push(`AES-256-GCM (@noble/ciphers ${versionOf(found.aes, '@noble/ciphers')})`);
  return `ok, ${checked.join(', ')}: ${dir}`;
}

// ---- main ----

function build() {
  const cases = CASES.map(buildCase);
  const negatives = buildNegatives(cases);
  return {
    protocol: 'qnet-link-v1',
    spec: 'docs/protocols/qnet-link-v1.md',
    generator: 'docs/protocols/tools/qnet-link-vectors.mjs',
    encodings: 'Keys, secrets, iv and ciphertext as lowercase hex; wire values (sitePub, appPub, iv, ct in the '
      + 'request bodies and the link) as unpadded base64url; ciphertext = AES-GCM output || 16-byte tag; '
      + 'private keys are already clamped; hkdfSalt = the 16 bytes the sessionId hex encodes.',
    constants: {
      linkPrefix: LINK.PREFIX,
      linkPattern: LINK.RE.source,
      androidPackages: LINK.ANDROID_PACKAGES,
      hkdfInfo: LINK.HKDF_INFO,
      aadPrefix: LINK.AAD_PREFIX,
      sessionTtlSeconds: LINK.SESSION_TTL_S,
      pollIntervalMs: LINK.POLL_INTERVAL_MS,
      sessionBodyMaxBytes: LINK.SESSION_BODY_MAX_BYTES,
      responseBodyMaxBytes: LINK.RESPONSE_BODY_MAX_BYTES,
      plaintextMaxBytes: LINK.PLAINTEXT_MAX_BYTES,
      ciphertextMinBytes: LINK.CT_MIN_BYTES,
      ciphertextMaxBytes: LINK.CT_MAX_BYTES,
      burnAmountMax: LINK.BURN_AMOUNT_MAX,
      statuses: LINK.STATUSES,
      errors: LINK.ERRORS,
    },
    activationCodeKat: CODE_KAT,
    walletActivationCodeKat: WALLET_CODE_KAT,
    wallet: WALLET,
    cases,
    cryptoMustFail: negatives.cryptoMustFail,
    lowOrderPublicKeys: LOW_ORDER,
    invalidLinks: negatives.invalidLinks,
    androidIntents: buildAndroidIntents(cases),
    invalidSessionRequests: negatives.invalidSessionRequests,
    invalidResponseRequests: negatives.invalidResponseRequests,
    invalidPlaintexts: negatives.invalidPlaintexts,
    burnOrder: buildBurnOrder(),
  };
}

async function main(argv) {
  const check = argv.includes('--check');
  const dirs = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--noble' && argv[i + 1]) dirs.push(resolve(argv[++i]));
  if (dirs.length === 0) {
    for (const p of NOBLE_PACKAGES) {
      const dir = join(REPO, p);
      if (!existsSync(join(dir, 'package.json'))) continue;
      if (nobleResolver(dir).curves) dirs.push(dir);
      else console.log(`noble: not installed (${dir})`);
    }
  }

  const vectors = build();
  selfCheck(vectors);
  console.log(`node:crypto: ${vectors.cases.length} cases, ${vectors.cryptoMustFail.length} crypto, `
    + `${vectors.invalidLinks.length} link, ${vectors.androidIntents.length} android intent, `
    + `${vectors.invalidSessionRequests.length + vectors.invalidResponseRequests.length} relay `
    + `and ${vectors.invalidPlaintexts.length} plaintext negatives: ok`);
  for (const dir of dirs) console.log(`noble: ${await nobleCheck(dir, vectors)}`);

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
