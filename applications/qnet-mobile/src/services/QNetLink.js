// QNet Link v1, revision 2 (docs/protocols/qnet-link-v1.md section 14): a page of aiqnet.io asks this wallet, through
// a verified https://link.aiqnet.io/l#v1... link, to share its addresses (`connect`), to confirm that the page may
// prepare this wallet's light node with a one-time address it makes (`reserve`), to consent to its light node and run
// it on this device (`link`), to stop running it on the device it runs on (`unlink`: on that device its own key signs the
// unbind; on any other device that holds the wallet, the wallet key), or to move its node balance (`claim`). The answer goes back end-to-end encrypted through
// the site's relay. The wallet answers only after the user confirmed on the wallet's own screen
// (screens/QNetLinkScreen).
//
// The relay is untrusted: its session must match the link exactly (the request included, bound by its hash), an answer
// is sealed to the site's ephemeral key, and nothing the relay or the link says can change what the wallet signs: the
// app builds every message from its own keys, the request's few fields and the network's answers. A `link` request
// for a burn made from this wallet's own Solana address names that address (`burner`); only when it is the open
// wallet's own does the wallet's Solana key sign the burn's owner bind for the wallet's own light node with the consent.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { isSolanaAddress, isSolanaSignature } from '../utils/solanaFormat';
import { eonFromPublicKeyBytes } from '../crypto/WalletIdentity';
import { lightNodeId } from '../crypto/NodePreimages';

const CAPS = Object.freeze({
  connect: Object.freeze({ plaintext: 1024, ct: 1040 }),
  link: Object.freeze({ plaintext: 8192, ct: 8208 }),
  claim: Object.freeze({ plaintext: 1024, ct: 1040 }),
  reserve: Object.freeze({ plaintext: 8192, ct: 8208 }),
  unlink: Object.freeze({ plaintext: 1024, ct: 1040 }),
});

const INTENT_ERRORS = Object.freeze({
  connect: Object.freeze(['NO_WALLET', 'INTERNAL']),
  link: Object.freeze(['NO_WALLET', 'WALLET_MISMATCH', 'NO_NODE', 'NODE_OTHER', 'NETWORK', 'BIND_REFUSED', 'INTERNAL']),
  claim: Object.freeze(['NO_WALLET', 'WALLET_MISMATCH', 'NO_NODE', 'NETWORK', 'CLAIM_REFUSED', 'CLAIM_BUSY', 'INTERNAL']),
  reserve: Object.freeze(['NO_WALLET', 'WALLET_MISMATCH', 'NODE_OTHER', 'NETWORK', 'INTERNAL']),
  unlink: Object.freeze(['NO_WALLET', 'WALLET_MISMATCH', 'NOT_LINKED', 'NETWORK', 'UNLINK_REFUSED', 'INTERNAL']),
});

export const LINK = Object.freeze({
  // The link has a host of its own (a browser may keep a same-host link as a page); the relay does not move.
  PREFIX: 'https://link.aiqnet.io/l#v1.',
  RE: /^https:\/\/link\.aiqnet\.io\/l#v1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})\.(connect|link|claim|reserve|unlink)(?:\.([A-Za-z0-9_-]{43}))?$/,
  // Constant of the build, never taken from a link.
  RELAY: 'https://aiqnet.io',
  HKDF_INFO: 'qnet-link-v1',
  SAS_INFO: 'qnet-link-v1-sas',
  AAD_PREFIX: 'qnet-link-v1|',
  WALLET_HASH_PREFIX: 'qnet-link-wallet:',
  SESSION_TTL_S: 600,
  // A session with less time left is refused before anything is shown.
  MIN_REMAINING_S: 30,
  CAPS,
  CT_MIN_BYTES: 17,
  RELAY_TIMEOUT_MS: 10000,
  // Every u64 of an answer is a decimal string; the smallest move is 1 QNC.
  CLAIM_MIN_NANO: 1000000000,
  // A consent is admitted this long after it was signed (qnet-link-v1 section 14.2).
  CONSENT_PAST_S: 86400,
  CONSENT_FUTURE_S: 300,
  // A reservation's time as the site admits it, and as the app checks its own signature before it goes.
  RESERVE_PAST_S: 900,
  RESERVE_FUTURE_S: 300,
  RESERVE_SKEW_S: 300,
  STATUSES: Object.freeze({
    connect: Object.freeze(['ok', 'rejected', 'error']),
    link: Object.freeze(['ok', 'linked', 'rejected', 'error']),
    claim: Object.freeze(['ok', 'empty', 'rejected', 'error']),
    reserve: Object.freeze(['ok', 'rejected', 'error']),
    unlink: Object.freeze(['ok', 'rejected', 'error']),
  }),
  INTENT_ERRORS,
  // Every error code of every intent: each has a text (link_err_*).
  ERRORS: Object.freeze([...new Set(Object.values(INTENT_ERRORS).flat())]),
  REQUEST_KEYS: Object.freeze({
    link: Object.freeze(['burnTx', 'walletHash', 'check']),
    claim: Object.freeze(['walletHash']),
    reserve: Object.freeze(['walletHash', 'burner']),
    unlink: Object.freeze(['walletHash']),
  }),
  // A `link` request for a burn made from the wallet's own Solana address: the keys above, then that address. Its consent
  // carries the owner bind of that address's key (`ownerSig`, 64 bytes).
  OWN_BURN_REQUEST_KEYS: Object.freeze(['burnTx', 'walletHash', 'check', 'burner']),
  OWNER_SIG_BYTES: 64,
});

const HANDLED_KEY = 'qnet_link_handled';
const HANDLED_MAX = 64;

// ---------------------------------------------------------------- encodings

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url (RFC 4648 section 5). */
export function encodeB64url(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  if (bytes.length - i === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (bytes.length - i === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

/**
 * Canonical unpadded base64url of exactly `len` bytes (any length when null), else null: no other character,
 * no padding, no length of 1 mod 4, and zero padding bits (the text re-encodes to itself).
 */
export function decodeB64url(text, len = null) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    acc = ((acc << 6) | B64URL.indexOf(text[i])) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (encodeB64url(out) !== text) return null;
  return len === null || out.length === len ? out : null;
}

const allZero = (bytes) => bytes.every((b) => b === 0);

// A clamped scalar (a multiple of 8) sends every low-order point to zero, so this refuses exactly the keys an
// exchange with them would refuse.
const PROBE = new Uint8Array(32).fill(9);

/** Whether an X25519 public key can take part in an exchange (not a low-order point). */
export function contributoryKey(publicKey) {
  try {
    return !allZero(x25519.getSharedSecret(PROBE, publicKey));
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------- requests (section 14.4)

const WALLET_HASH_RE = /^[0-9a-f]{16}$/;

/** First 16 hex of SHA3-256("qnet-link-wallet:" + wallet): how a request names the wallet the page already knows. */
export function walletHashOf(wallet) {
  return bytesToHex(sha3_256(utf8ToBytes(`${LINK.WALLET_HASH_PREFIX}${wallet}`))).slice(0, 16);
}

const exactly = (have, keys) => have.length === keys.length && keys.every((k) => have.includes(k));

/**
 * The request bytes of a request object for `intent`: its exact keys in the protocol's order, no whitespace. Null when
 * the object is not exactly such a request (another key, a key missing, a value of another form). A `link` request with
 * `burner` names the burn, the wallet and that Solana address.
 */
export function requestText(intent, request) {
  if (!LINK.REQUEST_KEYS[intent] || !request || typeof request !== 'object' || Array.isArray(request)) return null;
  const have = Object.keys(request);
  const ownBurn = intent === 'link' && exactly(have, LINK.OWN_BURN_REQUEST_KEYS);
  const keys = ownBurn ? LINK.OWN_BURN_REQUEST_KEYS : LINK.REQUEST_KEYS[intent];
  if (!exactly(have, keys)) return null;
  const { burnTx, walletHash, check, burner } = request;
  if (walletHash !== null && !(typeof walletHash === 'string' && WALLET_HASH_RE.test(walletHash))) return null;
  if (intent === 'link') {
    if (burnTx !== null && !isSolanaSignature(burnTx)) return null;
    if (typeof check !== 'boolean') return null;
    if (ownBurn && (burnTx === null || walletHash === null || !isSolanaAddress(burner))) return null;
  }
  // A reservation always names the wallet, and the one-time address the page made; an unlink the wallet the page shows.
  if (intent === 'reserve' && (walletHash === null || !isSolanaAddress(burner))) return null;
  if (intent === 'unlink' && walletHash === null) return null;
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, request[k]])));
}

/** reqHash: b64url(SHA-256(request bytes)), 43 characters. */
export const reqHashOf = (text) => encodeB64url(sha256(utf8ToBytes(text)));

// ---------------------------------------------------------------- the link (section 14.3)

/**
 * The parsed link { id, sitePub, intent, reqHash? }, or null for anything that is not exactly a revision 2 link: the
 * whole string against the pattern (no trimming, case folding or decoding), `reqHash` present exactly when the intent
 * is not `connect`, and canonical 32-byte site key (not a low-order point) and request hash.
 */
export function parseLink(url) {
  if (typeof url !== 'string' || url.length > 200) return null;
  const m = LINK.RE.exec(url);
  if (!m) return null;
  const [, id, sitePub, intent, reqHash] = m;
  if ((intent === 'connect') !== (reqHash === undefined)) return null;
  const key = decodeB64url(sitePub, 32);
  if (!key || !contributoryKey(key)) return null;
  if (reqHash !== undefined && !decodeB64url(reqHash, 32)) return null;
  return Object.freeze(reqHash === undefined ? { id, sitePub, intent } : { id, sitePub, intent, reqHash });
}

let initialTaken = false;

/** The URL that launched the app, once per run (a remount must not replay it). */
export async function takeInitialUrl(linking) {
  if (initialTaken) return null;
  initialTaken = true;
  try { return await linking.getInitialURL(); } catch (_) { return null; }
}

// ---------------------------------------------------------------- crypto (sections 6 and 14.6)

// `connect`: qnet-link-v1|<id>|connect; every other intent: qnet-link-v1|<id>|<intent>|<reqHash>.
const aad = (id, intent, reqHash) => utf8ToBytes(`${LINK.AAD_PREFIX}${id}|${intent}${reqHash ? `|${reqHash}` : ''}`);

/** HKDF-SHA256(shared, salt = the 16 bytes of the session id, info = "qnet-link-v1"), 32 bytes. */
export function sessionKey(shared, id) {
  return hkdf(sha256, shared, hexToBytes(id), utf8ToBytes(LINK.HKDF_INFO), 32);
}

/** The check number: HKDF-SHA256(shared, salt = id bytes, info = "qnet-link-v1-sas", 4) big-endian mod 10^6, six digits. */
export function checkNumber(shared, id) {
  const b = hkdf(sha256, shared, hexToBytes(id), utf8ToBytes(LINK.SAS_INFO), 4);
  return String((((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]) % 1000000).padStart(6, '0');
}

/** The check number as the screens show it: two groups of three. */
export const groupCheckNumber = (n) => `${n.slice(0, 3)} ${n.slice(3)}`;

function sharedSecret(privateKey, publicKey) {
  const shared = x25519.getSharedSecret(privateKey, publicKey); // throws on a low-order key
  if (allZero(shared)) throw new Error('Low-order key');
  return shared;
}

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

// The body and the check number of one answer; every secret is wiped before it returns.
function seal({ id, intent, reqHash = null, sitePub, plaintext, appPrivateKey = null, iv = null }) {
  const pub = typeof sitePub === 'string' ? decodeB64url(sitePub, 32) : sitePub;
  if (!pub) throw new Error('Bad site key');
  const priv = appPrivateKey ? Uint8Array.from(appPrivateKey) : randomBytes(32);
  const nonce = iv ? Uint8Array.from(iv) : randomBytes(12);
  let shared = null;
  let key = null;
  try {
    const appPub = x25519.getPublicKey(priv);
    shared = sharedSecret(priv, pub);
    key = sessionKey(shared, id);
    const ct = gcm(key, nonce, aad(id, intent, reqHash)).encrypt(utf8ToBytes(plaintext));
    return {
      body: { appPub: encodeB64url(appPub), iv: encodeB64url(nonce), ct: encodeB64url(ct) },
      check: checkNumber(shared, id),
    };
  } finally {
    priv.fill(0);
    if (shared) shared.fill(0);
    if (key) key.fill(0);
  }
}

/**
 * The encrypted answer body { appPub, iv, ct } for `plaintext`: a fresh app key pair and IV per answer
 * (tests pass the vectors' ones), X25519 with the site's key, AES-256-GCM with the session's AAD.
 */
export function sealAnswer(args) {
  return seal(args).body;
}

/** The site's side (the app never decrypts; kept for the round-trip tests). Throws on any failure. */
export function openAnswer({ id, intent, reqHash = null, sitePrivateKey, appPub, iv, ct }) {
  const caps = CAPS[intent];
  const pub = decodeB64url(appPub, 32);
  const nonce = decodeB64url(iv, 12);
  const sealed = decodeB64url(ct);
  if (!caps || (intent === 'connect') !== !reqHash || !pub || !nonce || !sealed
      || sealed.length < LINK.CT_MIN_BYTES || sealed.length > caps.ct) {
    throw new Error('Unreadable answer');
  }
  const shared = sharedSecret(Uint8Array.from(sitePrivateKey), pub);
  const key = sessionKey(shared, id);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(gcm(key, nonce, aad(id, intent, reqHash)).decrypt(sealed));
  } finally {
    shared.fill(0);
    key.fill(0);
  }
}

// ---------------------------------------------------------------- the answer (section 14.7)

const EON_RE = /^([0-9a-f]{19})eon([0-9a-f]{15})([0-9a-f]{8})$/;

/** A QNet address with its SHA3-256 checksum. */
export function isEonAddress(s) {
  const m = typeof s === 'string' ? EON_RE.exec(s) : null;
  return !!m && bytesToHex(sha3_256(utf8ToBytes(`${m[1]}eon${m[2]}`))).slice(0, 8) === m[3];
}

// The keys of each answer's row, in the order the protocol's examples write them.
const ROWS = Object.freeze({
  connect: { ok: ['qnet', 'solana'] },
  link: { ok: ['qnet', 'nodeId', 'consent', 'bound'], linked: ['qnet', 'nodeId', 'seq'] },
  claim: { ok: ['qnet', 'nodeId', 'amountNano', 'txHash', 'stoppedAtEpoch'], empty: ['qnet', 'nodeId'] },
  reserve: { ok: ['qnet', 'time', 'pk', 'sig'] },
  unlink: { ok: ['qnet', 'nodeId', 'unbound'] },
});

function keysFor(intent, status) {
  const base = ['v', 'intent', 'status'];
  if (status === 'rejected') return base;
  if (status === 'error') return [...base, 'error'];
  return [...base, ...((ROWS[intent] && ROWS[intent][status]) || [])];
}

const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const isU64 = (v) => typeof v === 'string' && U64_RE.test(v) && (v.length < 20 || v <= '18446744073709551615');
const bigOf = (v) => BigInt(v);

/**
 * Why a plaintext answer is unreadable for a session { intent, request }, or null when it is valid: the site's checks
 * in the order of section 14.7, except the consent signature, which the app made itself. `now` (Unix seconds) places
 * the consent window, which reaches 300 s into the past until two genesis nodes advertise `consent_24h`. The app runs
 * them over its own answer before sending it.
 */
export function plaintextProblem(text, session, { now = Math.floor(Date.now() / 1000), consent24h = true } = {}) {
  const { intent } = session;
  const request = session.request || null;
  const caps = CAPS[intent];
  if (typeof text !== 'string' || !caps || utf8ToBytes(text).length > caps.plaintext) return 'size';
  let obj;
  try { obj = JSON.parse(text); } catch (_) { return 'json'; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'json';
  if (obj.v !== 1) return 'v';
  if (obj.intent !== intent) return 'intent';
  if (!LINK.STATUSES[intent].includes(obj.status)) return 'status';
  if (intent === 'link' && obj.status === 'ok' && !(request && request.burnTx)) return 'status';
  const want = keysFor(intent, obj.status);
  const have = Object.keys(obj);
  if (have.length !== want.length || !want.every((k) => have.includes(k))) return 'keys';
  // A consent to a burn of the wallet's own Solana address carries that key's owner bind too.
  const ownBurn = intent === 'link' && !!request && request.burner !== undefined;
  if ('consent' in obj) {
    const c = obj.consent;
    const ck = c && typeof c === 'object' && !Array.isArray(c) ? Object.keys(c) : [];
    if (!exactly(ck, ownBurn ? ['ts', 'pk', 'sig', 'ownerSig'] : ['ts', 'pk', 'sig'])) return 'keys';
  }
  if ('error' in obj && !LINK.INTENT_ERRORS[intent].includes(obj.error)) return 'error';
  if ('qnet' in obj && !isEonAddress(obj.qnet)) return 'qnet';
  if ('solana' in obj && !isSolanaAddress(obj.solana)) return 'solana';
  if ('nodeId' in obj && obj.nodeId !== lightNodeId(obj.qnet)) return 'nodeId';
  if ('qnet' in obj && request && request.walletHash && walletHashOf(obj.qnet) !== request.walletHash) return 'walletHash';
  if (intent === 'link' && obj.status === 'ok') {
    if (typeof obj.bound !== 'boolean') return 'bound';
    const { ts, pk, sig } = obj.consent;
    const past = consent24h ? LINK.CONSENT_PAST_S : LINK.CONSENT_FUTURE_S;
    if (!isU64(ts) || bigOf(ts) < BigInt(now - past) || bigOf(ts) > BigInt(now + LINK.CONSENT_FUTURE_S)) return 'ts';
    const key = decodeB64url(pk, 1952);
    if (!key || eonFromPublicKeyBytes(key) !== obj.qnet) return 'pk';
    if (!decodeB64url(sig, 3309)) return 'sig';
    if (ownBurn && !decodeB64url(obj.consent.ownerSig, LINK.OWNER_SIG_BYTES)) return 'ownerSig';
  }
  // The reservation's signature is over the site-record envelope of the request's facts at `time` (the site verifies it).
  if (intent === 'reserve' && obj.status === 'ok') {
    const key = decodeB64url(obj.pk, 1952);
    if (!key || eonFromPublicKeyBytes(key) !== obj.qnet) return 'pk';
    if (!decodeB64url(obj.sig, 3309)) return 'sig';
    if (!isU64(obj.time) || bigOf(obj.time) < BigInt(now - LINK.RESERVE_PAST_S)
        || bigOf(obj.time) > BigInt(now + LINK.RESERVE_FUTURE_S)) {
      return 'time';
    }
  }
  if ('seq' in obj && !isU64(obj.seq)) return 'seq';
  if ('unbound' in obj && typeof obj.unbound !== 'boolean') return 'unbound';
  // A claim takes at least 1 QNC, except a part the node's quote capped (`stoppedAtEpoch` set: more epochs remain), which
  // may be less, so the whole balance can always be moved in several claims (owner decision 6, 27.09).
  if ('amountNano' in obj) {
    const capped = obj.stoppedAtEpoch !== null && obj.stoppedAtEpoch !== undefined;
    const least = capped ? 1n : BigInt(LINK.CLAIM_MIN_NANO);
    if (!(isU64(obj.amountNano) && bigOf(obj.amountNano) >= least)) return 'amountNano';
  }
  if ('txHash' in obj && !(typeof obj.txHash === 'string' && /^[0-9a-f]{64}$/.test(obj.txHash))) return 'txHash';
  if ('stoppedAtEpoch' in obj && obj.stoppedAtEpoch !== null && !isU64(obj.stoppedAtEpoch)) return 'stoppedAtEpoch';
  return null;
}

/**
 * The plaintext for an answer { status, ...fields } to a session { intent, request }: exactly the keys of its row, in
 * the protocol's order. Throws when the result would not pass the site's checks.
 */
export function buildPlaintext(session, answer, window = {}) {
  const obj = { v: 1, intent: session.intent, status: answer.status };
  for (const k of keysFor(session.intent, answer.status).slice(3)) {
    const value = answer[k];
    if (value === undefined) continue;
    obj[k] = k === 'consent' && value && typeof value === 'object'
      ? { ts: value.ts, pk: value.pk, sig: value.sig, ...(value.ownerSig !== undefined ? { ownerSig: value.ownerSig } : {}) }
      : value;
  }
  const text = JSON.stringify(obj);
  const problem = plaintextProblem(text, session, window);
  if (problem) throw new Error(`Refusing to send a malformed answer (${problem})`);
  return text;
}

// ---------------------------------------------------------------- the relay (sections 5 and 14.5)

/** Why a link was not opened: 'handled' | 'network' | 'not_found' | 'mismatch' | 'answered' | 'expiring'. */
export class LinkRefusal extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

async function relayRequest(path, { method = 'GET', body = null } = {}) {
  const url = `${LINK.RELAY}${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LINK.RELAY_TIMEOUT_MS);
  try {
    // No `cache: 'no-store'` option: React Native's fetch turns it into a `?_=<time>` query on the URL, and the
    // redirect check below then refused every real answer (found on a phone, 28.09). The header asks the same.
    const headers = { Accept: 'application/json', 'Cache-Control': 'no-store' };
    if (body !== null) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method, headers, body, credentials: 'omit', redirect: 'error', signal: ctl.signal,
    });
    // A redirect is a failure: the answer must come from the relay itself (same origin and path; a query the
    // platform's fetch added is not a redirect).
    if (res.redirected || (typeof res.url === 'string' && res.url !== '' && res.url.split(/[?#]/)[0] !== url)) {
      throw new Error('Redirected');
    }
    const text = res.status === 204 ? '' : await res.text();
    if (text.length > 4096) throw new Error('Oversized relay answer');
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// The session view must name this link exactly; for every intent but `connect` its request must be one the app rebuilds
// to the link's own hash (the relay cannot swap it).
function sessionProblem(body, link) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'mismatch';
  const want = link.intent === 'connect'
    ? ['id', 'sitePub', 'intent', 'answered', 'expiresIn']
    : ['id', 'sitePub', 'intent', 'request', 'reqHash', 'answered', 'expiresIn'];
  const have = Object.keys(body);
  if (have.length !== want.length || !want.every((k) => have.includes(k))) return 'mismatch';
  if (body.id !== link.id || body.sitePub !== link.sitePub || body.intent !== link.intent) return 'mismatch';
  if (link.intent !== 'connect') {
    const text = requestText(link.intent, body.request);
    if (text === null || body.reqHash !== link.reqHash || reqHashOf(text) !== link.reqHash) return 'mismatch';
  }
  if (typeof body.answered !== 'boolean' || !Number.isSafeInteger(body.expiresIn) || body.expiresIn < 0
      || body.expiresIn > LINK.SESSION_TTL_S) {
    return 'mismatch';
  }
  if (body.answered) return 'answered';
  if (body.expiresIn < LINK.MIN_REMAINING_S) return 'expiring';
  return null;
}

// Handled session ids, kept for the session TTL as a hash, never the id itself.
const idTag = (id) => bytesToHex(sha256(utf8ToBytes(`${LINK.AAD_PREFIX}${id}`))).slice(0, 32);

async function readHandled(now) {
  let list = [];
  try { list = JSON.parse((await AsyncStorage.getItem(HANDLED_KEY)) || '[]'); } catch (_) { list = []; }
  return Array.isArray(list) ? list.filter((e) => e && typeof e.tag === 'string' && Number(e.until) > now) : [];
}

export async function wasHandled(id, now = Date.now()) {
  const tag = idTag(id);
  return (await readHandled(now)).some((e) => e.tag === tag);
}

/** Remembers that this device decided on session `id` (for the session TTL). */
export async function markHandled(id, now = Date.now()) {
  const tag = idTag(id);
  const list = (await readHandled(now)).filter((e) => e.tag !== tag);
  list.push({ tag, until: now + LINK.SESSION_TTL_S * 1000 });
  try { await AsyncStorage.setItem(HANDLED_KEY, JSON.stringify(list.slice(-HANDLED_MAX))); } catch (_) {}
}

/**
 * The relay's session for a parsed link, checked against it: { expiresAt, request } (`request` null for `connect`).
 * Throws LinkRefusal. A session this device already decided on is refused before anything is fetched.
 */
export async function openSession(link, { now = Date.now } = {}) {
  if (await wasHandled(link.id, now())) throw new LinkRefusal('handled');
  let reply;
  try {
    reply = await relayRequest(`/api/link/sessions/${link.id}`);
  } catch (_) {
    throw new LinkRefusal('network');
  }
  if (reply.status === 404) throw new LinkRefusal('not_found');
  if (reply.status !== 200) throw new LinkRefusal('network');
  let body = null;
  try { body = JSON.parse(reply.text); } catch (_) { body = null; }
  const problem = sessionProblem(body, link);
  if (problem) throw new LinkRefusal(problem);
  const request = link.intent === 'connect' ? null : Object.freeze(JSON.parse(requestText(link.intent, body.request)));
  return { expiresAt: now() + body.expiresIn * 1000, request };
}

/**
 * Seals and posts the answer, retrying the identical body after a network failure while the session lives.
 * 'delivered' | 'conflict' (another device answered first) | 'expired' | 'failed'. An answer this wallet could
 * not build goes out as INTERNAL. `onCheck(number)` hears the check number once the relay took an answer that names
 * this wallet, when the request asked for it (`check: true`).
 */
export async function deliverAnswer(link, session, answer, {
  now = Date.now, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), onCheck = null,
} = {}) {
  const view = { intent: link.intent, request: (session && session.request) || null };
  let plaintext;
  try {
    plaintext = buildPlaintext(view, answer);
  } catch (_) {
    plaintext = buildPlaintext(view, { status: 'error', error: 'INTERNAL' });
  }
  const sealed = seal({ id: link.id, intent: link.intent, reqHash: link.reqHash || null, sitePub: link.sitePub, plaintext });
  const body = JSON.stringify(sealed.body);
  const named = JSON.parse(plaintext).qnet !== undefined;
  let wait = 2000;
  for (;;) {
    let reply = null;
    try { reply = await relayRequest(`/api/link/sessions/${link.id}/response`, { method: 'POST', body }); } catch (_) { reply = null; }
    if (reply) {
      if (reply.status === 201 || reply.status === 200) {
        if (onCheck && named && view.request && view.request.check === true) onCheck(sealed.check);
        return 'delivered';
      }
      if (reply.status === 409) return 'conflict';
      if (reply.status === 404) return 'expired';
      if (reply.status !== 429 && reply.status < 500) return 'failed';
    }
    if (now() + wait >= session.expiresAt) return 'failed';
    await sleep(wait);
    wait = Math.min(wait * 2, 30000);
  }
}

// ---------------------------------------------------------------- the intents (section 14.8)

/** This wallet's two addresses, from the unlocked wallet's public view. null when they are not usable. */
export function walletAddresses(wallet) {
  const qnet = wallet && wallet.qnetAddress;
  const solana = wallet && (wallet.solanaAddress || wallet.address || wallet.publicKey);
  return isEonAddress(qnet) && isSolanaAddress(solana) ? { qnet, solana } : null;
}

const unavailable = (error, extra = {}) => ({ kind: 'unavailable', error, ...extra });

// One wallet, one node type, chosen once: no light node is prepared or consented to for a wallet the network holds a
// super or genesis node for (two genesis nodes decide), or whose super node's burn aiqnet.io holds and the network does
// not list yet (reserved, on its way or recorded). A source that cannot answer gives nothing. null when neither stands
// in the way, else the error code.
async function otherNodeProblem(node, qnet) {
  if (typeof node.otherNode !== 'function' || typeof node.record !== 'function') return 'INTERNAL';
  const [other, record] = await Promise.all([node.otherNode(qnet), node.record(qnet)]);
  if (other === true) return 'NODE_OTHER';
  if (record && record.state !== 'none' && record.nodeType === 'super') return 'NODE_OTHER';
  if (other !== false || !record) return 'NETWORK';
  return null;
}

/**
 * What the confirmation screen shows for a request, read before any authentication and without signing anything.
 * `node` is the Node side the wallet screen hands over (services/NodeLinkActions): status, device, balance, the
 * wallet's other node (`otherNode`), aiqnet.io's record of its burn (`record`), this device's binding (`binding`), and
 * the actions that sign. Answers { kind: 'connect', addresses } · { kind: 'reserve', qnet, nodeId, burner } ·
 * { kind: 'link', mode: 'consent' | 'device', nodeId, qnet, device, switchFrom } · { kind: 'unlink', mode: 'here', nodeId,
 * qnet, since } · { kind: 'unlink', mode: 'wallet', nodeId, qnet, platform, since } · { kind: 'claim', nodeId, qnet,
 * amountNano } · { kind: 'claim_empty', nodeId, qnet } · { kind: 'unavailable', error, reason? }.
 */
export async function prepareOffer(link, { wallet, session = null, node = null }) {
  if (link.intent === 'connect') {
    const addresses = walletAddresses(wallet);
    return addresses ? { kind: 'connect', addresses } : unavailable('NO_WALLET');
  }
  const qnet = wallet && isEonAddress(wallet.qnetAddress) ? wallet.qnetAddress : null;
  if (!qnet) return unavailable('NO_WALLET');
  const request = (session && session.request) || {};
  if (request.walletHash && request.walletHash !== walletHashOf(qnet)) return unavailable('WALLET_MISMATCH');
  if (!node) return unavailable('INTERNAL');
  const nodeId = lightNodeId(qnet);
  if ((link.intent === 'link' || link.intent === 'reserve') && node.serverNode) return unavailable('NODE_OTHER');

  if (link.intent === 'unlink') {
    // The device that runs this wallet's node unbinds it with its own key (`here`), unless two owners name another
    // binding than this device's; any other device that holds the wallet withdraws the binding with the wallet key
    // (`wallet`, once two genesis nodes serve `unbind_wallet`), whichever device it is on (contract 1.9b).
    if (!request.walletHash || typeof node.binding !== 'function' || typeof node.status !== 'function') return unavailable('INTERNAL');
    const local = await node.binding(nodeId);
    if (local) {
      const signed = typeof node.pingStatus === 'function' ? await node.pingStatus(nodeId).catch(() => null) : null;
      const named = signed && Number.isSafeInteger(signed.bindingSeqAgreed) ? signed.bindingSeqAgreed : null;
      if (named === null || named === local.seq) {
        return { kind: 'unlink', mode: 'here', qnet, nodeId, since: Number.isSafeInteger(local.boundAt) ? local.boundAt : null };
      }
    }
    const status = await node.status(nodeId).catch(() => null);
    if (!status || status.onChain === null) return unavailable('NETWORK');
    if (status.onChain === false || !(status.features || []).includes('unbind_wallet') || status.deviceBoundAgreed === false) {
      return unavailable('NOT_LINKED');
    }
    if (status.deviceBoundAgreed !== true || typeof node.unlinkByWallet !== 'function') return unavailable('NETWORK');
    const device = status.device || null;
    return {
      kind: 'unlink', mode: 'wallet', qnet, nodeId,
      platform: device && device.platform ? device.platform : null,
      since: device && Number.isSafeInteger(device.linkedSince) ? device.linkedSince : null,
    };
  }

  if (link.intent === 'reserve') {
    // The page makes its one-time address for this wallet's light node only once the wallet signed that it may.
    if (!request.walletHash || !isSolanaAddress(request.burner) || typeof node.reserve !== 'function') {
      return unavailable('INTERNAL');
    }
    const problem = await otherNodeProblem(node, qnet);
    return problem ? unavailable(problem) : { kind: 'reserve', qnet, nodeId, burner: request.burner };
  }

  const status = await node.status(nodeId);
  if (!status || status.onChain === null) return unavailable('NETWORK');

  if (link.intent === 'claim') {
    if (status.onChain !== true) return unavailable('NO_NODE');
    if (node.claimBusy && node.claimBusy()) return unavailable('CLAIM_BUSY');
    const amount = await node.balance(nodeId);
    if (!Number.isSafeInteger(amount) || amount < 0) return unavailable('NETWORK');
    return amount >= LINK.CLAIM_MIN_NANO
      ? { kind: 'claim', nodeId, qnet, amountNano: amount }
      : { kind: 'claim_empty', nodeId, qnet };
  }

  const features = status.features || [];
  const device = await node.device();
  const capable = !!device && device.capable === true;
  const local = node.localNode ? await node.localNode() : null;
  const switchFrom = local && local.nodeId !== nodeId ? local.walletAddress || local.nodeId : null;
  if (status.onChain === true) {
    // Linking a recorded node binds this device; a device that cannot run one has nothing to confirm.
    if (!capable) return unavailable('BIND_REFUSED', { reason: device ? device.reason : 'device_unsupported' });
    if (!features.includes('bind_v2')) return unavailable('NETWORK');
    return { kind: 'link', mode: 'device', nodeId, qnet, device, features, switchFrom };
  }
  if (!request.burnTx) return unavailable('NO_NODE');
  // A burn made from a Solana address: only the wallet whose own address it is signs that key's owner bind.
  const burner = request.burner === undefined ? null : request.burner;
  if (burner !== null) {
    const own = walletAddresses(wallet);
    if (!own || own.solana !== burner) return unavailable('WALLET_MISMATCH');
  }
  const problem = await otherNodeProblem(node, qnet);
  if (problem) return unavailable(problem);
  // A device that runs the node takes a pending binding with the consent; one that cannot gives the consent only.
  if (capable && !(features.includes('bind_v2') && features.includes('pending_bind'))) return unavailable('NETWORK');
  return {
    kind: 'link', mode: 'consent', nodeId, qnet, burnTx: request.burnTx, burner, device, features, switchFrom: capable ? switchFrom : null,
  };
}

const u64Text = (n) => (typeof n === 'bigint' ? n.toString() : String(n));

/** The answer { status, ... } to a request the user confirmed. Only the confirmation screen calls this. */
export async function performIntent(link, offer, { node = null, now = Date.now } = {}) {
  if (offer.kind === 'connect') {
    const { qnet, solana } = offer.addresses;
    return { status: 'ok', qnet, solana };
  }
  const { qnet, nodeId } = offer;
  if (offer.kind === 'reserve') {
    // T = now; the wallet key signs the reservation of its light node for the page's one-time address. The app checks
    // what it signed before it goes: the open wallet's key, a whole signature, and T within the skew of now.
    const time = Math.floor(now() / 1000);
    const r = await node.reserve({ burner: offer.burner, time });
    const key = r ? decodeB64url(r.pk, 1952) : null;
    if (!key || eonFromPublicKeyBytes(key) !== qnet || !decodeB64url(r.sig, 3309)
        || Math.abs(time - Math.floor(now() / 1000)) > LINK.RESERVE_SKEW_S) {
      return { status: 'error', error: 'INTERNAL' };
    }
    return { status: 'ok', qnet, time: String(time), pk: r.pk, sig: r.sig };
  }
  if (offer.kind === 'unlink' && offer.mode === 'wallet') {
    // The wallet key withdraws the binding on whichever device holds it; `ok` only when the network took it.
    const r = await node.unlinkByWallet(nodeId);
    // `byWallet` is for this device's screen only (the plaintext carries the row's keys alone).
    if (r && r.status === 'ok') return { status: 'ok', qnet, nodeId, unbound: true, byWallet: true };
    const error = r && INTENT_ERRORS.unlink.includes(r.error) ? r.error : 'INTERNAL';
    return { status: 'error', error };
  }
  if (offer.kind === 'unlink') {
    // This device stops answering for the node whatever the network says; `unbound`: the network took the unbind.
    const r = await node.unlink(nodeId);
    return { status: 'ok', qnet, nodeId, unbound: !!r && r.unbound === true };
  }
  if (offer.kind === 'claim_empty') return { status: 'empty', qnet, nodeId };
  if (offer.kind === 'claim') {
    const r = await node.claim({ nodeId, qnet, amountNano: offer.amountNano });
    if (r.status === 'empty') return { status: 'empty', qnet, nodeId };
    if (r.status !== 'ok') {
      return {
        status: 'error', error: INTENT_ERRORS.claim.includes(r.error) ? r.error : 'INTERNAL', ...(r.unknown ? { unknown: true } : {}),
      };
    }
    return {
      status: 'ok', qnet, nodeId, amountNano: u64Text(r.amountNano), txHash: r.txHash,
      stoppedAtEpoch: r.stoppedAtEpoch === null || r.stoppedAtEpoch === undefined ? null : u64Text(r.stoppedAtEpoch),
    };
  }
  // `reason`, `ref`, `here`, `byWallet` and `unknown` are for this device's screen only: an answer's plaintext carries
  // the keys of its row alone. `ref`: the support reference of a refused enrolment (light-node-messages section 5.9).
  // `unknown`: the request went out and no answer told whether it was done; the wire says NETWORK, the screen never
  // "nothing changed" (MN-R4-05).
  if (offer.kind === 'link' && offer.mode === 'device') {
    const r = await node.useDevice({ nodeId, device: offer.device });
    if (r.ok) return { status: 'linked', qnet, nodeId, seq: u64Text(r.seq) };
    return {
      status: 'error', error: r.reason === 'network' ? 'NETWORK' : 'BIND_REFUSED', reason: r.reason || null, ...(r.ref ? { ref: r.ref } : {}),
      ...(r.unknown ? { unknown: true } : {}),
    };
  }
  if (offer.kind === 'link' && offer.mode === 'consent') {
    const burner = offer.burner || null;
    const r = await node.consent({ nodeId, burnTx: offer.burnTx, burner, device: offer.device, features: offer.features || [] });
    // A consent to a burn of the wallet's own Solana address goes only with that key's owner bind.
    if (burner !== null && !(r && r.consent && typeof r.consent.ownerSig === 'string')) return { status: 'error', error: 'INTERNAL' };
    const here = !!offer.device && offer.device.capable === true;
    // `reason`: the network refused this device's binding for good; the consent stands.
    return {
      status: 'ok', qnet, nodeId, consent: r.consent, bound: r.bound === true, here, reason: (here && r.reason) || null,
      ...(here && r.reason && r.ref ? { ref: r.ref } : {}),
    };
  }
  return { status: 'error', error: 'INTERNAL' };
}
