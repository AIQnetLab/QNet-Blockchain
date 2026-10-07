/**
 * The device layer of this device's light node (docs/protocols/light-node-messages.md sections 5 and 7): the challenge a
 * device message answers, the enrolment block /light-node/bind carries, the device signature of every ping reply, the
 * lease refresh, the 30-day key rotation and the release that goes with the unbind when the binding ends here (the
 * website's unlink request confirmed on the link sheet, a wallet deleted). Only the node's shard
 * owners are asked, and a message goes back to the owner that issued its challenge; vendor tokens go nowhere else.
 * Nothing here needs the wallet key: the device key signs without the user, so the wakes can refresh and rotate.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { lightShardOwnerUrls } from '../config/nodes';
import {
  enrolPreimage, hwPingPreimage, hwPublicKeySha3, pingWire, playNonce, refreshPreimage, releasePreimage, rotatePreimage,
} from '../crypto/NodePreimages';
import * as DeviceKey from './NodeDeviceKey';

// The forms a client uses only when two genesis nodes list them (section 7).
export const FEATURE_DEVICE = 'device_v1';
export const FEATURE_HWPING = 'hwping_v2';

// What the wakes read about this device's node, from the last status the app read and the answers of its device
// messages: { nodeId, features, refresh, refreshedFor, refreshTries, refreshNextAt, rotationDue, rotateTriedAt,
// rotateRefusals, rotateNextAt, deviceState, statusAt, statusTriedAt, answerAt }. `answerAt` (ms): when a binding or a
// rotation the node took last set the record's schedule; a signed status read before it describes the record before
// it. No secrets.
export const SCHEDULE_KEY = 'qnet_node_device_schedule';
// Android: the strictly increasing millisecond counter of the ping replies (section 5.8), per device key:
// { handle, last }.
export const HW_SEQ_KEY = 'qnet_node_hw_seq';

const CALL_MS = 8000;
// No call is started with less time than this left before the wake's deadline.
export const MIN_CALL_MS = 1500;
// What a new device key may take: StrongBox key generation, or Apple's attestation round trip. No key is made with less
// than this (and the POST after it) left before a deadline, so a key is never attested for a message that cannot go.
export const ATTEST_MS = 6000;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const ROTATE_RETRY_MS = 6 * 3600 * 1000;
// A rotation the node refused waits before the next: 6 h, doubling up to 4 days, and at least what the node asked
// (`retry_after_seconds`: up to the epoch the rotation falls due, for one it takes as early), however long (MN-R4-06).
// Every try attests a new key, and the network counts a device's attested keys (plan R8); the node refuses rotations
// while the device oracle is down (node batch V3, R5), which may last days (MN-R2-02). A wait is void on a clock that went
// back past the time it was written (`rotateWaitSetAt`).
const ROTATE_MAX_WAIT_MS = 4 * 86400 * 1000;
// What the node may ask at most: a rotation period and its grace (30 + 30 days) and a margin.
const ROTATE_ASKED_MAX_MS = 62 * 86400 * 1000;
// A refresh that did not go through waits before the next try in the same window: 30 min, doubling up to 12 h, and at
// least what the node asked (`retry_after_seconds`). The node takes 24 refreshes per node a day (node batch V2), and
// every try asks the platform for a vendor token against the app's daily quota, so no wake tries while the wait runs.
export const REFRESH_FIRST_WAIT_MS = 30 * 60000;
const REFRESH_MAX_WAIT_MS = 12 * 3600 * 1000;
// A wait written further ahead than this is void (a clock that was set back).
const REFRESH_WAIT_CAP_MS = 24 * 3600 * 1000;
// Google Play's dialog for a refresh token it can fix (PLAY_FIXABLE) is shown from the Node tab at most this often.
export const REFRESH_DIALOG_MS = 3600 * 1000;
// A wake reads the signed status for the schedule at most this often, when the schedule knows no window ahead.
export const STATUS_READ_MS = 3 * 3600 * 1000;
// A node refuses an Android hw_seq more than a day ahead of its clock (section 5.8).
const HW_SEQ_AHEAD_MS = 86400 * 1000;
const ANCHOR_RE = /^selfattest:(\d{1,15}):([0-9a-f]{64})$/;

const enc = encodeURIComponent;
const natural = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
// The time a call may take: its own cap, within the deadline of the wake that makes it.
const callMs = (deadline, cap = CALL_MS) => Math.min(cap, (deadline || Infinity) - Date.now());

/** The milliseconds left before `deadline`; Infinity without one (the foreground). */
export const timeLeft = (deadline) => (deadline ? deadline - Date.now() : Infinity);

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

async function call(url, { body = null, timeoutMs = CALL_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(0, timeoutMs));
  try {
    const r = await fetch(url, body === null
      ? { method: 'GET', signal: ctl.signal }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    const answer = await r.json();
    if (!answer || typeof answer !== 'object') throw new Error('No answer');
    return answer;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A challenge for a device message of `purpose` (section 5.2): { nonce, stamp, exp, issuer, url }, from the node's
 * shard owners in rank order (the first that answers), `url` being where the message goes. `skip` leaves out owners
 * already tried; `deadline` (ms) caps every call and stops asking once too little time is left. Throws with code
 * NETWORK.
 */
export async function fetchChallenge(nodeId, purpose, { skip = [], timeoutMs = CALL_MS, deadline = null } = {}) {
  for (const url of lightShardOwnerUrls(nodeId).filter((u) => !skip.includes(u))) {
    const ms = callMs(deadline, timeoutMs);
    if (ms < MIN_CALL_MS) break;
    let a;
    try {
      a = await call(`${url}/api/v1/light-node/device-challenge?node_id=${enc(nodeId)}&purpose=${enc(purpose)}`, { timeoutMs: ms });
    } catch (_) {
      continue;
    }
    if (typeof a.nonce === 'string' && NONCE_RE.test(a.nonce) && typeof a.stamp === 'string' && a.stamp.length > 0
        && a.stamp.length <= 512 && Number.isSafeInteger(a.exp) && typeof a.issuer === 'string') {
      return { nonce: a.nonce, stamp: a.stamp, exp: a.exp, issuer: a.issuer, url };
    }
  }
  throw fail('NETWORK', 'No shard owner gave a challenge');
}

// Token failures no later try can change on this device (NodeDeviceKey codes): no Google Play, no DeviceCheck.
export const NO_TOKEN_EVER = new Set(['PLAY_UNAVAILABLE', 'UNSUPPORTED']);

// The vendor token after Google Play's own dialog fixed what the first request could not (foreground only).
async function tokenAfterDialog(nonce) {
  if ((await DeviceKey.showPlayDialog('integrity')) !== 'ok') return null;
  try {
    return await DeviceKey.vendorToken(nonce);
  } catch (_) {
    return null;
  }
}

/**
 * The enrolment of this device for a binding (section 5.3): a challenge from the shard owners, a device key attested
 * over the preimage, and the block /light-node/bind takes. `device` is NodeDeviceKey.checkDevice's answer for a device
 * that can run a node. `interactive`: Google Play's dialog may be shown to fix a token. Returns { key, url, fields,
 * reused }: `fields` = { device: {...}, dc_token | pi_token }, `url` the issuer the binding must go to (the only owner
 * whose stamp it carries), `reused` when an existing key proved itself with an assertion (iOS). A binding that went
 * without a token is taken but never counted (section 5.3); the app enrols it again later with one
 * (PushService.enrolAgainIfUnleased). The key stays pending until settle(). A device that can never give a vendor token
 * (PLAY_UNAVAILABLE: no Google Play; UNSUPPORTED: no DeviceCheck) cannot run a node (plan AF4): its key is dropped and
 * the enrolment throws with that code, so nothing is bound and no working device is superseded; a token that failed for
 * now still lets the binding go.
 * `deadline` (ms, a background wake's): the challenge stays within it, and no key is made that could not be posted in
 * time (code DEADLINE). Throws with a code of NodeDeviceKey, NETWORK or DEADLINE.
 */
export async function enrol({
  nodeId, wallet, pingPublicKey, seq, device, reuse = false, interactive = false, skip = [], deadline = null,
}) {
  const ch = await fetchChallenge(nodeId, 'enrol', { skip, deadline });
  if (timeLeft(deadline) < ATTEST_MS + MIN_CALL_MS) throw fail('DEADLINE', 'No time left to make and post a device key');
  const preimage = enrolPreimage({ nodeId, wallet, pingPublicKey, seq, nonce: ch.nonce, flags: device.flags });
  const ev = await DeviceKey.enrolEvidence({ preimage, flags: device.flags, report: device.report, reuse });
  let token = ev.token;
  if (!token && ev.tokenError === 'PLAY_FIXABLE' && interactive) token = await tokenAfterDialog(ev.playNonce);
  if (!token && NO_TOKEN_EVER.has(ev.tokenError)) {
    await DeviceKey.dropPendingKey(ev.key).catch(() => {});
    throw fail(ev.tokenError, 'This device can give no vendor token');
  }
  const fields = { device: { ...ev.device, nonce: ch.nonce, stamp: ch.stamp } };
  if (token) fields[token.field] = token.value;
  return { key: ev.key, url: ch.url, fields, reused: !!(ev.device && ev.device.assertion) };
}

/**
 * The node took the enrolment (commit the key) or did not (drop it). `unanswered`: the message went out and no owner
 * answered, so the node may hold the key: it is kept, marked, until the signed status's device tag settles it
 * (NodeDeviceKey.settleByTag), rather than a new key being attested for the next try. Never throws. True only when the
 * key the node took is this install's current key now: a key another enrolment replaced meanwhile is not, and the
 * binding then holds no key of this device (MN-R2-03).
 */
export async function settle(enrolment, taken, { unanswered = false } = {}) {
  if (!enrolment) return false;
  try {
    if (taken) {
      await DeviceKey.commitKey(enrolment.key);
      return true;
    }
    if (unanswered) await DeviceKey.keepUnanswered(enrolment.key);
    else await DeviceKey.dropPendingKey(enrolment.key); // only that key: one another message made meanwhile stays
  } catch (_) { /* the next enrolment starts over */ }
  return false;
}

// ---- the schedule the wakes follow ----

async function readSchedule() {
  try {
    const s = JSON.parse((await AsyncStorage.getItem(SCHEDULE_KEY)) || 'null');
    return s && typeof s === 'object' && typeof s.nodeId === 'string' ? s : null;
  } catch (_) {
    return null;
  }
}

async function writeSchedule(s) {
  try { await AsyncStorage.setItem(SCHEDULE_KEY, JSON.stringify(s)); } catch (_) { /* the next status read writes it */ }
}

/**
 * Keeps what a status read (LightNode.readNodeStatus) tells the wakes about this device's node: the forms two genesis
 * nodes list and, from the signed status, the refresh window (Unix seconds), the epoch the key rotation falls due and
 * the record's state. `readAt` (ms) is when that read started: a signed status read before a binding or rotation the
 * node took since (`answerAt`) would put back the schedule before it, so only its forms are kept (MN-R3-03). A caller
 * passes only a signed status it read itself, never one kept from an earlier read.
 */
export async function noteStatus(nodeId, status, { readAt = Date.now() } = {}) {
  if (!status || status.onChain !== true) return;
  const prev = await readSchedule();
  const same = prev && prev.nodeId === nodeId ? prev : { nodeId };
  const next = { ...same, features: status.features || [] };
  const at = Number.isSafeInteger(readAt) ? readAt : 0;
  const older = Number.isSafeInteger(same.answerAt) && at < same.answerAt;
  if (status.signed && !older) {
    next.refresh = status.signed.refreshWindow || null;
    Object.assign(next, rotationFields(same, status.signed.rotationDue));
    next.deviceState = status.signed.deviceState || null;
    next.statusAt = at;
    // A new window is refreshed again, from the first try. A lapsed lease's window starts at the read itself (from now,
    // for a day: record.rs refresh_window), so its start moves on every read: a window that overlaps the one kept, which
    // was not refreshed, is that window, and its back-off and token error stay (M9).
    const prevWindow = same.refresh || null;
    const refreshed = !!prevWindow && same.refreshedFor === prevWindow.from;
    const overlaps = !!prevWindow && !!next.refresh && next.refresh.from <= prevWindow.to && next.refresh.to >= prevWindow.from;
    const moved = !!prevWindow && !!next.refresh && next.refresh.from !== prevWindow.from;
    if (!next.refresh || !prevWindow || (moved && (refreshed || !overlaps))) {
      Object.assign(next, { refreshedFor: null, refreshTries: 0, refreshNextAt: null, refreshTokenError: null });
    }
  }
  await writeSchedule(next);
}

/**
 * A binding the node just took (Use this device, the QNet Link sheet): the schedule starts over for it, with the forms
 * two genesis nodes list and what the bind answer says (`rotation_due`, `device_state`). The refresh window comes with
 * the next signed status a wake reads: never from a status read before the binding, which described the device that
 * answered before.
 */
export async function noteBinding(nodeId, features, answer = null) {
  const a = answer && typeof answer === 'object' ? answer : {};
  await writeSchedule({
    nodeId, features: Array.isArray(features) ? features : [], refresh: null, refreshedFor: null,
    rotationDue: natural(a.rotation_due), deviceState: typeof a.device_state === 'string' ? a.device_state : null,
    statusAt: null, statusTriedAt: null, answerAt: Date.now(),
  });
}

/**
 * Whether a wake should read the signed status for the schedule now: the schedule knows no refresh window ahead (none,
 * over, or refreshed) or no rotation epoch, and no read was tried in the last STATUS_READ_MS. A background wake reads it
 * with the ping key, which needs no user, so a node stays counted without the app being opened.
 */
export async function needsStatus(nodeId, now = Date.now()) {
  const s = await readSchedule();
  if (!s || s.nodeId !== nodeId) return true;
  const tried = Math.max(Number(s.statusTriedAt) || 0, Number(s.statusAt) || 0);
  if (tried <= now && now - tried < STATUS_READ_MS) return false;
  if (!Array.isArray(s.features) || !s.features.includes(FEATURE_DEVICE)) return true;
  const sec = Math.floor(now / 1000);
  const windowAhead = !!s.refresh && s.refresh.to >= sec && s.refreshedFor !== s.refresh.from;
  return !windowAhead || !Number.isSafeInteger(s.rotationDue);
}

/** The epoch this device's schedule says the key rotation of `nodeId`'s device record falls due, or null. */
export async function scheduledRotationDue(nodeId) {
  const s = await readSchedule();
  return s && s.nodeId === nodeId && Number.isSafeInteger(s.rotationDue) ? s.rotationDue : null;
}

/** Notes that a wake is reading the status now, so the next wakes wait STATUS_READ_MS whatever the read gives. */
export async function noteStatusTry(nodeId, now = Date.now()) {
  const prev = await readSchedule();
  await writeSchedule({ ...(prev && prev.nodeId === nodeId ? prev : { nodeId, features: [] }), statusTriedAt: now });
}

/** Whether ping replies of `nodeId` carry the device signature: a key the node holds, and two genesis nodes take it. */
export async function signsReplies(nodeId) {
  const s = await readSchedule();
  if (!s || s.nodeId !== nodeId || !Array.isArray(s.features) || !s.features.includes(FEATURE_HWPING)) return false;
  return !!(await DeviceKey.currentKey());
}

// Android's hw_seq for `key`: above every earlier one of the same key, kept before the reply goes out. A new key
// starts from the clock; so does a counter more than a day ahead of it (a clock that was set forward and back), which
// the node would refuse anyway: at worst the replies of the next day are refused, never months of them.
async function nextHwSeq(key) {
  let last = 0;
  try {
    const kept = JSON.parse((await AsyncStorage.getItem(HW_SEQ_KEY)) || 'null');
    if (kept && typeof kept === 'object' && kept.handle === key.handle) last = Number(kept.last) || 0;
  } catch (_) { last = 0; }
  const now = Date.now();
  if (last > now + HW_SEQ_AHEAD_MS) last = 0;
  const seq = Math.max(now, last + 1);
  await AsyncStorage.setItem(HW_SEQ_KEY, JSON.stringify({ handle: key.handle, last: seq }));
  return seq;
}

/**
 * The `signature` of a ping reply with the device signature (section 5.8): `ping_hw2:{σ}.{device signature}.{hw_seq}`,
 * `sigma` being the ping key's raw signature (hex) of `challenge`, a self-attestation. Throws when the device key cannot
 * sign; the caller then sends the reply without it. A key that is gone because a rotation finished between reading it
 * and signing (the rotation deletes the key it replaced) is not lost: the reply is signed again with the key that is
 * current now. A KEY_GONE names the key that failed (`key`).
 */
export async function hwPingSignature(nodeId, challenge, sigma) {
  const m = ANCHOR_RE.exec(challenge);
  if (!m) throw fail('INVALID', 'Not a self-attestation');
  const signWith = async (key) => {
    const hwSeq = key.platform === 'android' ? await nextHwSeq(key) : 0;
    const preimage = hwPingPreimage({ nodeId, height: m[1], hash: m[2], sigma, hwSeq });
    return pingWire(sigma, await DeviceKey.sign(key, preimage), hwSeq);
  };
  const key = await DeviceKey.currentKey();
  if (!key) throw fail('KEY_GONE', 'No device key');
  try {
    return await signWith(key);
  } catch (e) {
    if (!e || e.code !== 'KEY_GONE') throw e;
    const now = await DeviceKey.currentKey();
    if (!now || (now.platform === key.platform && now.handle === key.handle)) throw e;
    return signWith(now);
  }
}

// ---- refresh, rotation, release ----

// `promise`'s value, or `fallback` once `deadline` passes first (the promise runs on).
function within(promise, deadline, fallback) {
  if (!deadline) return promise;
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, deadline - Date.now())); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// The schedule's rotation epoch set to `due`; a new epoch starts its tries over (MN-R2-02).
function rotationFields(prev, due) {
  const same = !!prev && prev.rotationDue === due;
  return same ? { rotationDue: due } : { rotationDue: due, rotateRefusals: 0, rotateNextAt: null, rotateWaitSetAt: null };
}

// What a device answer tells the schedule: the rotation epoch and the record's state, when it names them.
function answerFields(a, prev = null) {
  const out = {};
  if (natural(a && a.rotation_due) !== null) Object.assign(out, rotationFields(prev, a.rotation_due));
  if (a && typeof a.device_state === 'string') out.deviceState = a.device_state;
  return out;
}

/**
 * The lease refresh (section 5.6), once per refresh window, posted to the challenge's issuer. True when a genesis
 * node took it. A try that did not go through (no owner answered, no time left, a refusal) counts before any call and
 * waits its back-off (REFRESH_FIRST_WAIT_MS, doubling), or what the node asked, before the next: no challenge, token or
 * POST meanwhile. `deadline` (ms): every step stays within it, and one that cannot finish in time is not started. Why the
 * last try had no vendor token is kept (`refreshTokenError`). `interactive` (the Node tab, in the foreground): only
 * after a try whose token Google Play's dialog can fix (PLAY_FIXABLE: Play Store or Play services out of date), and then
 * past the back-off, the dialog is shown when the token fails again, at most every REFRESH_DIALOG_MS (plan-technical
 * 6.10, MN-R4-09).
 */
export async function refreshIfDue(nodeId, { now = Date.now(), deadline = null, interactive = false } = {}) {
  const s = await readSchedule();
  if (!s || s.nodeId !== nodeId || !s.refresh || !(s.features || []).includes(FEATURE_DEVICE)) return false;
  const sec = Math.floor(now / 1000);
  if (sec < s.refresh.from || sec > s.refresh.to || s.refreshedFor === s.refresh.from) return false;
  let dialog = false;
  if (interactive) {
    const shownAgo = Number.isSafeInteger(s.refreshDialogAt) ? now - s.refreshDialogAt : Infinity;
    if (s.refreshTokenError !== 'PLAY_FIXABLE' || (shownAgo >= 0 && shownAgo < REFRESH_DIALOG_MS)) return false;
    dialog = true;
  } else {
    const waitLeft = Number.isSafeInteger(s.refreshNextAt) ? s.refreshNextAt - now : 0;
    if (waitLeft > 0 && waitLeft <= REFRESH_WAIT_CAP_MS) return false;
  }
  const key = await DeviceKey.currentKey();
  if (!key) return false;
  const tries = (Number.isSafeInteger(s.refreshTries) && s.refreshTries > 0 ? s.refreshTries : 0) + 1;
  await writeSchedule({
    ...s, refreshTries: tries, refreshNextAt: now + Math.min(REFRESH_FIRST_WAIT_MS * 2 ** (tries - 1), REFRESH_MAX_WAIT_MS),
    ...(dialog ? { refreshDialogAt: now } : {}),
  });
  const ch = await fetchChallenge(nodeId, 'refresh', { deadline });
  const preimage = refreshPreimage(nodeId, ch.nonce);
  const sig = await DeviceKey.sign(key, preimage);
  let token = null;
  let tokenError = null;
  try {
    // The token may take a while (a Play Integrity round trip): it is waited for only while the POST still fits after it.
    const t = await within(DeviceKey.vendorToken(playNonce(preimage)), deadline && deadline - 2 * MIN_CALL_MS, null);
    token = t ? t.value : null;
    if (!t) tokenError = 'BUSY';
  } catch (e) {
    token = null;
    tokenError = (e && e.code) || 'FAILED';
  }
  if (!token && tokenError === 'PLAY_FIXABLE' && dialog) {
    const fixed = await tokenAfterDialog(playNonce(preimage));
    if (fixed) {
      token = fixed.value;
      tokenError = null;
    }
  }
  const noted = { refreshTokenError: token ? null : tokenError };
  const ms = callMs(deadline);
  if (ms < MIN_CALL_MS) {
    await writeSchedule({ ...(await readSchedule()), ...noted });
    return false;
  }
  let a;
  try {
    a = await call(`${ch.url}/api/v1/light-node/device-refresh`, {
      body: { node_id: nodeId, nonce: ch.nonce, stamp: ch.stamp, sig, token }, timeoutMs: ms,
    });
  } catch (e) {
    await writeSchedule({ ...(await readSchedule()), ...noted });
    throw e;
  }
  if (a.success !== true) {
    const cur = await readSchedule();
    const asked = Number(a.retry_after_seconds);
    const until = Number.isSafeInteger(asked) && asked > 0 ? Math.min(now + asked * 1000, now + REFRESH_WAIT_CAP_MS) : 0;
    await writeSchedule({
      ...cur, ...noted, refreshNextAt: Math.max(Number(cur && cur.refreshNextAt) || 0, until),
      ...(typeof a.device_state === 'string' ? { deviceState: a.device_state } : {}),
    });
    return false;
  }
  const cur = await readSchedule();
  await writeSchedule({
    ...cur, refreshedFor: s.refresh.from, refreshTries: 0, refreshNextAt: null, refreshTokenError: null, ...answerFields(a, cur),
  });
  return true;
}

/**
 * The key rotation (section 5.4) once `epoch`, the chain's current epoch, reached the epoch it falls due: a new key
 * attested over the preimage, the old key's signature of it, posted to the challenge's issuer. `seq` and
 * `pingPublicKey` are the binding's; `device` is NodeDeviceKey.checkDevice's answer (Android's report). Tried again at
 * most every six hours, and after a refusal only once its back-off ran out (ROTATE_MAX_WAIT_MS). A rotation that got no
 * answer keeps its new key until the node's status tells whether it took it (NodeDeviceKey.settleByTag), and no other
 * rotation starts meanwhile. No key is attested for a rotation the node would refuse anyway or that could not be posted:
 * none while the record is paused or ended, or waits for a check with no lease (node batch R5: only a new enrolment with
 * a token helps then); none without a vendor token (the node answers device_stale); none with too little of `deadline`
 * left (NodeDeviceKey.rotationEvidence asks the token first and stops before the key). Each attested key counts toward
 * the network's per-device limits (plan R8). True when the node took the new key.
 */
export async function rotateIfDue(nodeId, { epoch, seq, pingPublicKey, device, now = Date.now(), deadline = null }) {
  const s = await readSchedule();
  if (!s || s.nodeId !== nodeId || !Number.isSafeInteger(s.rotationDue) || !Number.isSafeInteger(epoch)) return false;
  // A try written ahead of the clock (a clock set back since) holds nothing back.
  const triedAgo = s.rotateTriedAt ? now - s.rotateTriedAt : Infinity;
  if (epoch < s.rotationDue || (triedAgo >= 0 && triedAgo < ROTATE_RETRY_MS)) return false;
  // A wait holds unless the clock went back past the time it was written (older schedules, with no such time: unless it
  // is further ahead than any written then).
  const waitLeft = Number.isSafeInteger(s.rotateNextAt) ? s.rotateNextAt - now : 0;
  const setAt = Number.isSafeInteger(s.rotateWaitSetAt) ? s.rotateWaitSetAt : null;
  if (waitLeft > 0 && (setAt !== null ? now >= setAt : waitLeft <= ROTATE_MAX_WAIT_MS)) return false;
  if (!device || device.capable !== true || !(s.features || []).includes(FEATURE_DEVICE)) return false;
  if (!rotatableState(s)) return false;
  if (await DeviceKey.hasUnansweredKey()) return false;
  const current = await DeviceKey.currentKey();
  if (!current) return false;
  await writeSchedule({ ...s, rotateTriedAt: now });
  const ch = await fetchChallenge(nodeId, 'rotate', { deadline });
  const preimage = rotatePreimage({ nodeId, oldHwPublicKey: current.hwPub, pingPublicKey, seq, nonce: ch.nonce });
  const ev = await DeviceKey.rotationEvidence({
    preimage, flags: current.platform === 'ios' ? device.flags : null, report: device.report,
    deadline, minLeftMs: ATTEST_MS + MIN_CALL_MS,
  });
  const body = {
    node_id: nodeId, seq, old_key: hwPublicKeySha3(current.hwPub),
    device: { ...ev.device, nonce: ch.nonce, stamp: ch.stamp }, old_sig: ev.oldSig,
  };
  if (ev.token) body[ev.token.field] = ev.token.value;
  const ms = callMs(deadline);
  if (ms < MIN_CALL_MS) {
    // Not sent: the node never saw the new key, which goes.
    await settle({ key: ev.key }, false);
    return false;
  }
  let answer = null;
  try {
    answer = await call(`${ch.url}/api/v1/light-node/device-rotate`, { body, timeoutMs: ms });
  } catch (_) {
    // Sent and no answer: the node may hold the new key already, so it is kept until the node's status settles it.
    await DeviceKey.keepUnanswered(ev.key);
    return false;
  }
  const taken = answer.success === true;
  await settle({ key: ev.key }, taken);
  const cur = await readSchedule();
  if (taken) {
    // The answer names the next rotation epoch (and the record's state); without it the next status read tells. A
    // status read that started before this answer cannot put the epoch just reached back (answerAt), and none of this
    // install's rotations starts within ROTATE_RETRY_MS of one the node took (MN-R3-03).
    await writeSchedule({
      ...cur, rotationDue: null, rotateTriedAt: now, rotateRefusals: 0, rotateNextAt: null, answerAt: Date.now(),
      ...answerFields(answer, null),
    });
    return true;
  }
  // Refused: the key it carried is gone, and the next try attests another. It waits its back-off, or what the node
  // asked when that is longer (MN-R2-02).
  const refusals = (Number.isSafeInteger(cur && cur.rotateRefusals) && cur.rotateRefusals > 0 ? cur.rotateRefusals : 0) + 1;
  const asked = Number(answer.retry_after_seconds);
  const wait = Math.max(
    Math.min(ROTATE_RETRY_MS * 2 ** (refusals - 1), ROTATE_MAX_WAIT_MS),
    Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked * 1000, ROTATE_ASKED_MAX_MS) : 0,
  );
  await writeSchedule({
    ...cur, rotateRefusals: refusals, rotateNextAt: now + wait, rotateWaitSetAt: now,
    ...(typeof answer.device_state === 'string' ? { deviceState: answer.device_state } : {}),
  });
  return false;
}

// Whether the record's last known state lets a rotation be taken (node batch T3, R5): not paused or ended, and not a
// check that waits with no lease (check_pending and no refresh window), which only a new enrolment with a token ends.
function rotatableState(s) {
  if (s.deviceState === 'paused' || s.deviceState === 'ended') return false;
  return !(s.deviceState === 'check_pending' && !s.refresh);
}

/**
 * The release that goes with the unbind of this device's binding (section 5.7; PushService.stopLightNode, which the
 * confirmed unlink request runs): { url, device_release } for the
 * challenge's issuer, or null when the node has no device record to end (no key, or the form is not served).
 * `deadline` (ms): the challenge is asked only within it, so a slow owner cannot hold the unbind back.
 */
export async function releaseBlock(nodeId, seq, { deadline = null } = {}) {
  const s = await readSchedule();
  if (!s || s.nodeId !== nodeId || !(s.features || []).includes(FEATURE_DEVICE)) return null;
  const key = await DeviceKey.currentKey();
  if (!key) return null;
  const ch = await fetchChallenge(nodeId, 'release', { deadline });
  const sig = await DeviceKey.sign(key, releasePreimage(nodeId, seq, ch.nonce));
  return { url: ch.url, device_release: { nonce: ch.nonce, stamp: ch.stamp, sig } };
}

/**
 * What a wake does for the device layer once its reply went out, while `deadline` leaves time: the refresh when its
 * window is open, the rotation when it fell due, each call within the deadline. `binding` is { seq, pingPublicKey };
 * `epoch` the chain's epoch as this device last read it (never the last one it was credited in: a device whose replies
 * the node refuses once its rotation is 30 days overdue answers into no later epoch, and only the rotation ends that;
 * MN-R2-01); `device` a function giving NodeDeviceKey.checkDevice's answer (asked
 * only for a rotation); `onKeyGone(key)` is called with the key that failed when a device key no longer exists on this
 * device (the node needs Use this device again, unless another key became current meanwhile). Never throws.
 */
export async function maintain(nodeId, { deadline, epoch = null, binding = null, device = null, onKeyGone = null } = {}) {
  const left = () => deadline - Date.now();
  const gone = async (e) => {
    if (e && e.code === 'KEY_GONE' && onKeyGone) {
      try { await onKeyGone(e.key || null); } catch (_) { /* the next wake tells again */ }
    }
  };
  try {
    if (left() > CALL_MS) await refreshIfDue(nodeId, { deadline });
  } catch (e) {
    await gone(e); // otherwise the next wake in the window tries again
  }
  try {
    const s = await readSchedule();
    const due = s && s.nodeId === nodeId && Number.isSafeInteger(s.rotationDue) && Number.isSafeInteger(epoch) && epoch >= s.rotationDue;
    if (due && left() > CALL_MS * 2 && binding && device) {
      await rotateIfDue(nodeId, { epoch, seq: binding.seq, pingPublicKey: binding.pingPublicKey, device: await device(), deadline });
    }
  } catch (e) {
    await gone(e); // otherwise tried again after the back-off
  }
}
