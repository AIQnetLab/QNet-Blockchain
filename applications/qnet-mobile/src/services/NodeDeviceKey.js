/**
 * The node's device key: the hardware key that ties this install's light node to this phone or tablet (not the
 * vault's device seal of DeviceSecurity)
 * (docs/protocols/light-node-messages.md sections 5.1, 5.3, 5.4). One API over the native module QNetDeviceAttest:
 * - iOS: an App Attest key in the Secure Enclave, attested by Apple over SHA-256(preimage) once it exists; it signs
 *   as assertions; a DeviceCheck token goes with its messages.
 * - Android: an EC P-256 Keystore key (StrongBox or TEE) made with SHA-256(preimage) as its attestation challenge; it
 *   signs DER ECDSA-SHA256 over the preimage; a Google Play integrity token bound to the message goes with it.
 * One key per install, never one per wallet. A new key stays pending until the node took it (commitKey). Which key is
 * current lives in the Keychain, after first unlock and on this device only, so a restored backup brings none.
 * Nothing here decides whether this device may run a node: the genesis nodes check the evidence, and a device that
 * cannot make it keeps the whole wallet. Failures carry `code`: UNSUPPORTED, KEY_GONE (reinstall, restore, offload:
 * the node needs "Use this device" again), BUSY (try later), PLAY_FIXABLE (Google Play's dialog can fix it),
 * PLAY_UNAVAILABLE, INVALID, FAILED.
 */
import { NativeModules, Platform } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
  androidFlags, androidReport, b64url, deviceChallengeHash, deviceTag, deviceTagH, hwPublicKeySha3, iosFlags, playNonce,
  playNonceForEnrol,
} from '../crypto/NodePreimages';
import { attestationPublicKey, certificatePublicKey } from '../crypto/DeviceEvidence';
import { MIN_AGREEMENT } from './LightNode';

export const NODE_DEVICE_KEY_SERVICE = 'qnet_node_device_key_v1';
const ALIAS_PREFIX = 'qnet_dev_';
const HW_PUB_RE = /^04[0-9a-f]{128}$/;
const PLAY_NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
// How long a key sent in a message that got no answer may still become the node's: the rotation's oracle claim and
// attestor round (95 s at most) and the statement's re-sends to the other owners (15 s, 2 min, 10 min and 1 h: node
// batch V3, R6), with a margin past the last. Before then no status read that still names the current key drops it
// (MN-R4-07).
export const UNANSWERED_SETTLE_MS = 75 * 60000;

const native = () => NativeModules.QNetDeviceAttest || null;
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const unb64 = (text) => new Uint8Array(Buffer.from(String(text), 'base64'));
const utf8 = (text) => new Uint8Array(Buffer.from(String(text), 'utf8'));

function fail(code, message, cause) {
  const e = new Error(message || code);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

// The native modules' codes (QNetDeviceAttestModule.m, DeviceAttestModule.kt) under this module's names.
const NATIVE_CODES = {
  UNSUPPORTED: 'UNSUPPORTED',
  INVALID_INPUT: 'INVALID',
  INVALID_KEY: 'KEY_GONE',
  KEY_MISSING: 'KEY_GONE',
  SERVER_UNAVAILABLE: 'BUSY',
  KEYSTORE_BUSY: 'BUSY',
  PLAY_BUSY: 'BUSY',
  PLAY_FIXABLE: 'PLAY_FIXABLE',
  PLAY_UNAVAILABLE: 'PLAY_UNAVAILABLE',
};

async function call(method, ...args) {
  const n = native();
  if (!n || typeof n[method] !== 'function') throw fail('UNSUPPORTED', 'This build has no device key');
  try {
    return await n[method](...args);
  } catch (e) {
    throw fail(NATIVE_CODES[e && e.code] || 'FAILED', e && e.message, e);
  }
}

/** 'ios' or 'android'; null anywhere else. */
export const platform = () => (Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null);

// ---- the stored record: { current, pending } ----

function keyOf(k) {
  if (!k || typeof k !== 'object' || k.platform !== platform()) return null;
  if (typeof k.handle !== 'string' || k.handle.length === 0 || k.handle.length > 64) return null;
  if (k.platform === 'android' && !k.handle.startsWith(ALIAS_PREFIX)) return null;
  const hwPub = typeof k.hwPub === 'string' && HW_PUB_RE.test(k.hwPub) ? k.hwPub : null;
  // Only an iOS key Apple has not attested yet (its server was unavailable) is kept without its point.
  if (!hwPub && !(k.platform === 'ios' && k.attested === false)) return null;
  const key = { platform: k.platform, handle: k.handle, hwPub, attested: !!hwPub };
  // A pending key sent in a message that got no answer, and when: the node may hold it (keepUnanswered, settleByTag).
  if (!hwPub || k.unanswered !== true) return key;
  return { ...key, unanswered: true, sentAt: Number.isSafeInteger(k.sentAt) && k.sentAt > 0 ? k.sentAt : 0 };
}

async function readRecord() {
  try {
    const item = await Keychain.getGenericPassword({ service: NODE_DEVICE_KEY_SERVICE });
    const r = item && item.password ? JSON.parse(item.password) : null;
    return { current: keyOf(r && r.current), pending: keyOf(r && r.pending) };
  } catch (_) {
    return { current: null, pending: null };
  }
}

async function writeRecord(record) {
  if (!record.current && !record.pending) {
    await Keychain.resetGenericPassword({ service: NODE_DEVICE_KEY_SERVICE });
    return;
  }
  const ok = await Keychain.setGenericPassword('device_key', JSON.stringify(record), {
    service: NODE_DEVICE_KEY_SERVICE,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
  if (!ok) throw fail('FAILED', 'The Keychain refused the device key record');
}

// One change of the record at a time.
let queue = Promise.resolve();
function serial(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

const sameKey = (a, b) => !!a && !!b && a.platform === b.platform && a.handle === b.handle;

async function dropNativeKey(key) {
  if (key && key.platform === 'android') await call('deleteKey', key.handle).catch(() => {});
  // iOS has no call that deletes an App Attest key: a key the app forgets is never used again.
}

// ---- what this device is ----

/**
 * Whether this device can hold a node's device key, before any key exists: { capable: true, platform, flags, report }
 * (`report` the Android report text, null on iOS), or { capable: false, reason } with a refusal reason of
 * light-node-messages section 8. No operating-system version is asked for. Emulators and uncertified devices pass
 * here and are refused by the network.
 */
export async function checkDevice() {
  const os = platform();
  let env = null;
  try {
    env = os ? await call('environment') : null;
  } catch (_) {
    env = null;
  }
  if (!env) return { capable: false, reason: 'device_unsupported' };
  if (os === 'ios') {
    if (env.mac || env.catalyst || env.vision || (env.idiom !== 'phone' && env.idiom !== 'pad')) {
      return { capable: false, reason: 'device_desktop' };
    }
    if (!env.attest || env.simulator) return { capable: false, reason: 'device_unsupported' };
    return { capable: true, platform: os, flags: iosFlags(env.idiom), report: null };
  }
  let report;
  try {
    report = androidReport(env.report);
  } catch (_) {
    return { capable: false, reason: 'device_unsupported' };
  }
  const r = env.report;
  if (!r.system_user || r.hsum) return { capable: false, reason: 'device_secondary_user' };
  if (r.feature_pc || r.arc || r.leanback || r.watch || r.automotive || r.embedded || !r.touchscreen) {
    return { capable: false, reason: 'device_desktop' };
  }
  return { capable: true, platform: os, flags: androidFlags(report), report };
}

/** The key the node holds for this install, or null. */
export async function currentKey() {
  return (await readRecord()).current;
}

/** A key made for a message the node has not answered yet, or null. */
export async function pendingKey() {
  return (await readRecord()).pending;
}

// The `device_tag_h` values of a signed status read (LightNode.readNodeStatus `deviceTags`, one per owner that took the
// signature: only the signed form names the device, ND-7), as a list of well-formed tags; a single tag counts as a list
// of one.
const tagList = (tags) => (Array.isArray(tags) ? tags : [tags]).filter((t) => typeof t === 'string' && /^[0-9a-f]{16}$/.test(t));

// How many of `tags` name `key` for the query nonce `nonceHex`.
function naming(nonceHex, tags, key) {
  if (!key || !key.hwPub || typeof nonceHex !== 'string') return 0;
  let mine;
  try {
    mine = deviceTagH(nonceHex, deviceTag(key.platform, key.hwPub));
  } catch (_) {
    return 0;
  }
  return tags.filter((t) => t === mine).length;
}

/**
 * Whether the device tags of a signed status read with the nonce `nonceHex` (light-node-messages section 5.9) name this
 * install's current key: true when one owner names it; false only when MIN_AGREEMENT owners name a device key and none
 * names this one (an owner the last rotation's statement has not reached yet still names the key before); null when
 * there is nothing to compare.
 */
export async function isThisDevice(nonceHex, tags) {
  const list = tagList(tags);
  if (typeof nonceHex !== 'string' || list.length === 0) return null;
  const key = await currentKey();
  if (!key || !key.hwPub) return null;
  if (naming(nonceHex, list, key) > 0) return true;
  return list.length >= MIN_AGREEMENT ? false : null;
}

// ---- tokens ----

/**
 * The vendor token that goes with a device message: { field: 'dc_token', value } (iOS DeviceCheck, b64url) or
 * { field: 'pi_token', value } (Android: a Google Play integrity token bound to `nonce`, a Play nonce of
 * NodePreimages). Throws with a code.
 */
export async function vendorToken(nonce) {
  if (platform() === 'ios') return { field: 'dc_token', value: b64url(unb64(await call('deviceCheckToken'))) };
  if (typeof nonce !== 'string' || !PLAY_NONCE_RE.test(nonce)) throw fail('INVALID', 'No Play nonce');
  return { field: 'pi_token', value: String(await call('integrityToken', nonce)) };
}

async function tokenOrError(nonce) {
  try {
    return { token: await vendorToken(nonce), tokenError: null };
  } catch (e) {
    return { token: null, tokenError: e.code || 'FAILED' };
  }
}

/** Google Play's own dialog on Android: 'licence' or 'integrity'. 'ok', 'cancelled', 'unavailable' or 'failed'. */
export async function showPlayDialog(kind) {
  if (platform() !== 'android') return 'unavailable';
  try {
    return String(await call('showPlayDialog', kind));
  } catch (_) {
    return 'failed';
  }
}

// ---- signing ----

/**
 * The device signature of a preimage (section 5.1), b64url: the iOS assertion's CBOR, or the Android DER signature.
 * KEY_GONE means the key no longer exists on this device; the error names it (`key`), so a caller forgets that key and
 * no other (forgetKey).
 */
export async function sign(key, preimage) {
  if (!key || key.platform !== platform() || !key.attested) throw fail('INVALID', 'Not a device key of this install');
  const hash = deviceChallengeHash(preimage); // refuses anything but a non-empty string
  try {
    if (key.platform === 'ios') return b64url(unb64(await call('generateAssertion', key.handle, b64(hash))));
    return b64url(unb64(await call('sign', key.handle, b64(utf8(preimage)))));
  } catch (e) {
    if (e && e.code === 'KEY_GONE') e.key = key;
    throw e;
  }
}

// ---- new keys ----

function canonicalReport(report) {
  let fields = null;
  try {
    fields = JSON.parse(report);
  } catch (_) {
    fields = null;
  }
  let text = null;
  try {
    text = androidReport(fields);
  } catch (_) {
    text = null;
  }
  if (text === null || text !== report) throw fail('INVALID', 'Not a device report');
}

// iOS: an App Attest key attested over `hash`. A key Apple has not attested yet (its server was unavailable) is used
// again, as Apple asks, so this device's count of keys does not grow.
async function iosAttestedKey(hash, record) {
  const reuse = record.pending && !record.pending.attested ? record.pending.handle : null;
  const keyId = reuse || String(await call('generateKey'));
  let attestation;
  try {
    attestation = unb64(await call('attestKey', keyId, b64(hash)));
  } catch (e) {
    const retry = e.code === 'BUSY' ? { platform: 'ios', handle: keyId, hwPub: null, attested: false } : null;
    await writeRecord({ ...record, pending: retry });
    // An invalid key here is the new one, never the current key the node holds: no caller may forget that one for it (M2).
    if (e.code === 'KEY_GONE') throw fail('FAILED', 'The new device key could not be attested', e);
    throw e;
  }
  let hwPub = null;
  try {
    hwPub = attestationPublicKey(attestation);
  } catch (_) {
    hwPub = null;
  }
  // The key id is SHA-256 of the key's point: the certificate must certify this very key.
  if (!hwPub || bytesToHex(sha256(Buffer.from(hwPub, 'hex'))) !== bytesToHex(unb64(keyId))) {
    await writeRecord({ ...record, pending: null });
    throw fail('FAILED', 'The attestation does not certify this key');
  }
  const key = { platform: 'ios', handle: keyId, hwPub, attested: true };
  await writeRecord({ ...record, pending: key });
  return { key, device: { platform: 'ios', key_id: b64url(unb64(keyId)), attestation: b64url(attestation) } };
}

// iOS: the current key, which the network already holds, proves itself with an assertion over the preimage: Apple
// attests a key once. It is pending again until the node answers.
async function iosAssertedKey(preimage, record) {
  const key = record.current;
  const assertion = await sign(key, preimage);
  await writeRecord({ ...record, pending: key });
  return { key, device: { platform: 'ios', key_id: b64url(unb64(key.handle)), assertion } };
}

// Android: a Keystore key made with `hash` as its attestation challenge, and its signature over the report.
async function androidAttestedKey(hash, record, report) {
  if (record.pending && !sameKey(record.pending, record.current)) await dropNativeKey(record.pending);
  const key = { platform: 'android', handle: `${ALIAS_PREFIX}${bytesToHex(randomBytes(16))}`, hwPub: null, attested: true };
  const created = await call('createKey', key.handle, b64(hash));
  try {
    const chain = (created && Array.isArray(created.chain) ? created.chain : []).map(unb64);
    if (chain.length === 0) throw fail('FAILED', 'The key came without its certificate chain');
    try {
      key.hwPub = certificatePublicKey(chain[0]);
    } catch (e) {
      throw fail('FAILED', e.message, e);
    }
    const reportSig = await sign(key, report);
    await writeRecord({ ...record, pending: key });
    return { key, device: { platform: 'android', chain: chain.map(b64url), report, report_sig: reportSig } };
  } catch (e) {
    await dropNativeKey(key);
    await writeRecord({ ...record, pending: null }).catch(() => {});
    // A failure of the key just made says nothing of the current one (M2).
    if (e && e.code === 'KEY_GONE') throw fail('FAILED', 'The new device key could not sign', e);
    throw e;
  }
}

/**
 * A new device key and its evidence for an enrolment (section 5.3). `preimage` is the enrolment text built with
 * checkDevice()'s `flags`; on Android `report` is checkDevice()'s report. Returns { key, device, playNonce, token,
 * tokenError }: `device` is the wire block without `nonce` and `stamp`, `token` the vendor token, or null with
 * `tokenError` (the key exists either way; after Google Play's dialog vendorToken(playNonce) asks again). The key
 * stays pending until commitKey or dropPendingKey.
 * `reuse` (iOS): the current key, when the network holds it, sends an assertion instead of a new key's attestation,
 * so this device's count of attested keys does not grow; a current key iOS no longer has gives way to a new one.
 * Android always makes a new key, its attestation challenge being the preimage.
 */
export function enrolEvidence({ preimage, flags, report = null, reuse = false }) {
  return serial(async () => {
    const os = platform();
    if (!os) throw fail('UNSUPPORTED', 'Not a phone or tablet');
    if (typeof preimage !== 'string' || !preimage.startsWith('qnet_dev_enrol:v1|') || typeof flags !== 'string'
      || !preimage.endsWith(`|${flags}`)) throw fail('INVALID', 'Not an enrolment with these flags');
    const hash = deviceChallengeHash(preimage);
    const record = await readRecord();
    if (os === 'ios') {
      let made = null;
      if (reuse && record.current) {
        try {
          made = await iosAssertedKey(preimage, record);
        } catch (e) {
          if (e.code !== 'KEY_GONE') throw e;
        }
      }
      if (!made) made = await iosAttestedKey(hash, record);
      return { ...made, device: { ...made.device, flags }, playNonce: null, ...(await tokenOrError(null)) };
    }
    canonicalReport(report);
    if (androidFlags(report) !== flags) throw fail('INVALID', 'The report does not match the flags');
    const made = await androidAttestedKey(hash, record, report);
    const nonce = playNonceForEnrol(preimage, made.key.hwPub, report);
    return { ...made, playNonce: nonce, ...(await tokenOrError(nonce)) };
  });
}

/**
 * The evidence of a rotation (section 5.4): a new key attested over `preimage` (built with the current key's point),
 * and the current key's signature over the same preimage. Android needs checkDevice()'s `report`; iOS may add its
 * `flags` to the block. Returns { key, device, oldSig, playNonce, token, tokenError: null }; the new key stays pending.
 * Neither vendor token depends on the new key (the Play nonce is taken from the preimage; a DeviceCheck token has none),
 * so the token is asked first, and without one no key is made: the node refuses a rotation without a token
 * (device_stale), and every attested key counts toward the device's limits (plan R8). The error then carries the
 * token's code. `deadline` (ms): with less than `minLeftMs` left once the token came, no key is made either (BUSY).
 */
export function rotationEvidence({ preimage, flags = null, report = null, deadline = null, minLeftMs = 0 }) {
  return serial(async () => {
    const os = platform();
    if (!os) throw fail('UNSUPPORTED', 'Not a phone or tablet');
    const record = await readRecord();
    if (!record.current) throw fail('KEY_GONE', 'No device key to rotate');
    if (typeof preimage !== 'string' || !preimage.startsWith('qnet_dev_rotate:v1|')
      || !preimage.includes(`|${hwPublicKeySha3(record.current.hwPub)}|`)) {
      throw fail('INVALID', 'Not a rotation of the current key');
    }
    if (os === 'android') canonicalReport(report);
    const hash = deviceChallengeHash(preimage);
    const oldSig = await sign(record.current, preimage);
    const nonce = os === 'android' ? playNonce(preimage) : null;
    const { token, tokenError } = await tokenOrError(nonce);
    if (!token) throw fail(tokenError || 'FAILED', 'No vendor token for the rotation');
    if (deadline && deadline - Date.now() < minLeftMs) throw fail('BUSY', 'No time left to attest a new key');
    if (os === 'ios') {
      const made = await iosAttestedKey(hash, record);
      const device = flags ? { ...made.device, flags } : made.device;
      return { ...made, device, oldSig, playNonce: null, token, tokenError: null };
    }
    const made = await androidAttestedKey(hash, record, report);
    return { ...made, oldSig, playNonce: nonce, token, tokenError: null };
  });
}

/** The node took the pending key: it becomes current, and the key it replaced is deleted where the platform can. */
export function commitKey(key) {
  return serial(async () => {
    const record = await readRecord();
    if (!sameKey(record.pending, key) || !record.pending.attested) throw fail('INVALID', 'Not the pending key');
    const { unanswered, sentAt, ...taken } = record.pending; // eslint-disable-line no-unused-vars
    const replaced = record.current && !sameKey(record.current, taken) ? record.current : null;
    await writeRecord({ current: taken, pending: null });
    await dropNativeKey(replaced);
    return taken;
  });
}

/**
 * A message that carried the pending key got no answer, so the node may have taken it: the key is kept, marked with the
 * time it went, until the node's signed status tells (settleByTag). A new enrolment replaces it; a rotation waits for it.
 */
export function keepUnanswered(key, now = Date.now()) {
  return serial(async () => {
    const record = await readRecord();
    if (!sameKey(record.pending, key) || !record.pending.attested) return;
    await writeRecord({ ...record, pending: { ...record.pending, unanswered: true, sentAt: now } });
  });
}

/** Whether a pending key waits for the node's status to tell whether the node took it. */
export async function hasUnansweredKey() {
  const { pending } = await readRecord();
  return !!(pending && pending.unanswered);
}

/**
 * Settles a pending key that got no answer by the device tags of a signed status read with the nonce `nonceHex`
 * (`tags`, one per owner that took the signature): an owner names it (it becomes current, as commitKey), or, once
 * UNANSWERED_SETTLE_MS passed since it went, MIN_AGREEMENT owners name the current key and none the pending one (it is
 * dropped). A read made
 * while the node is still taking it, or that the statement has not reached, never drops it. 'pending', 'current' or
 * null when the status settles nothing yet.
 */
export function settleByTag(nonceHex, tags, now = Date.now()) {
  return serial(async () => {
    const record = await readRecord();
    const pending = record.pending;
    const list = tagList(tags);
    if (!pending || !pending.unanswered || typeof nonceHex !== 'string' || list.length === 0) return null;
    if (naming(nonceHex, list, pending) > 0) {
      const { unanswered, sentAt, ...taken } = pending; // eslint-disable-line no-unused-vars
      const replaced = record.current && !sameKey(record.current, taken) ? record.current : null;
      await writeRecord({ current: taken, pending: null });
      await dropNativeKey(replaced);
      return 'pending';
    }
    // A clock set back past the send counts as time passed: a key kept for ever would hold every later rotation back.
    const age = now - pending.sentAt;
    if (age >= 0 && age < UNANSWERED_SETTLE_MS) return null;
    if (naming(nonceHex, list, record.current) >= MIN_AGREEMENT) {
      await writeRecord({ ...record, pending: null });
      if (!sameKey(pending, record.current)) await dropNativeKey(pending);
      return 'current';
    }
    return null;
  });
}

/**
 * The node did not take `key`: it is dropped while it is still the pending key, and deleted where the platform can. A
 * key another message made meanwhile (an enrolment beside a rotation) is that message's to settle, and stays (MN-R3-02).
 */
export function dropPendingKey(key) {
  return serial(async () => {
    const record = await readRecord();
    if (!record.pending || !sameKey(record.pending, key)) return;
    await writeRecord({ ...record, pending: null });
    if (!sameKey(record.pending, record.current)) await dropNativeKey(record.pending);
  });
}

/**
 * Forgets `key`, a key a signature failed with (KEY_GONE): it leaves the record wherever it is (current or pending) and
 * is deleted where the platform can. Resolves true when it was the current key, the one the node's binding holds; false
 * when another key is current by now (a rotation replaced it), which stays.
 */
export function forgetKey(key) {
  return serial(async () => {
    const record = await readRecord();
    const wasCurrent = sameKey(record.current, key);
    const wasPending = sameKey(record.pending, key);
    if (!wasCurrent && !wasPending) return false;
    await writeRecord({ current: wasCurrent ? null : record.current, pending: wasPending ? null : record.pending });
    await dropNativeKey(key);
    return wasCurrent;
  });
}

/** Forgets every device key of this install (the binding ended here, a key that is gone, erasing the app's data). */
export function forgetKeys() {
  return serial(async () => {
    const record = await readRecord();
    await writeRecord({ current: null, pending: null });
    await dropNativeKey(record.current);
    await dropNativeKey(record.pending);
  });
}
