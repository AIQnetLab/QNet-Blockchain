/**
 * QNet Push Service: the light node on this device. Firebase Cloud Messaging or polling wakes it; it answers the
 * network's requests with its ping key. A push token exists only while this wallet's node is linked to this device.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import messaging from '@react-native-firebase/messaging';
import BackgroundFetch from 'react-native-background-fetch';
import { AppState, Platform } from 'react-native';
// v3.35: Centralized node configuration (no duplication!)
import {
  GENESIS_NODES, getRandomGenesisNode, shuffledGenesisNodes, lightShardOwnerUrls, genesisResponseUrl,
} from '../config/nodes';
import {
  dropLinkPending, freshMiss, onChainAt, postBind, postPendingBind, postUnbind, readLinkPending, readNodeStatus,
  writeLinkPending, BIND_SETTLE_MS, LINK_PENDING_KEY,
} from './LightNode';
import {
  b64url, deviceTag, pollPreimage, resetRef, statusPreimage, tokenRefreshPreimage, unbindPreimage,
} from '../crypto/NodePreimages';
import * as Enrolment from './DeviceEnrolment';
import { checkDevice, forgetKey, forgetKeys, hasUnansweredKey, settleByTag } from './NodeDeviceKey';
import { mayAnswer, noteOpen } from './AnswerGate';
import * as Receipts from './PushReceipts';
import { BG_REFRESH_STATUS_KEY } from './BackgroundPriority';
import { deviceModel, withDeviceModel } from './DeviceModel';
import { LEGACY_MOVE } from '../config/legacy';
import logger from '../utils/logger';

// Push types: Firebase Cloud Messaging, else polling.
export const PushType = {
  FCM: 'fcm',
  POLLING: 'polling',
};

// Every call in this module goes to a genesis name: each one carries this device's node id, and most carry
// its push token, device id, wallet address or a ping answer — nothing a third-party operator should link
// to this device's IP, and nothing a node's own answer about other nodes may redirect.
const genesisNode = getRandomGenesisNode;

// A ping stamp lives until its epoch's commit window opens, at most one 14,400-block epoch at one block
// per second (rpc/mod.rs challenge_lifetime_at). The device clock may be off, so the bound is loose.
const STAMP_HORIZON_SECS = 2 * 86400;

/**
 * Whether the ping key may sign `challenge`. Exactly two forms exist (rpc/light_nodes.rs
 * handle_light_node_ping_response): a server stamp — lowercase hex of nonce(16) ‖ expiry(u64 big-endian) ‖
 * mac(16), 80 characters (rpc/mod.rs make_challenge_stamp) — or this device's self-attestation,
 * "selfattest:{height}:{64-hex block hash}". The same key signs token refreshes, so signing any other
 * string (a push or a node can send one) could hand out an authorisation this device never meant to give.
 */
export function isSignableChallenge(challenge, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof challenge !== 'string') return false;
  if (/^[0-9a-f]{80}$/.test(challenge)) {
    const expiry = parseInt(challenge.slice(32, 48), 16);
    return Number.isSafeInteger(expiry) && Math.abs(expiry - nowSec) <= STAMP_HORIZON_SECS;
  }
  return /^selfattest:\d{1,15}:[0-9a-f]{64}$/.test(challenge);
}

// RN fetch has no timeout of its own: an unreachable node would hold a call for the OS TCP timeout, past
// the ~30 s iOS gives a background wake. Every network call in this module goes through this cap.
function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.max(0, ms));
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}

// The promise's value, or `onTimeout` once `deadline` passes first; the promise itself runs on.
function untilDeadline(promise, deadline, onTimeout) {
  let timer;
  const expiry = new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout), Math.max(0, deadline - Date.now())); });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

// The record of the pushes this device took (PushReceipts) is display data: an answer waits for it at most this long, and
// goes without it after that (its writes run on, in order).
const RECEIPTS_WAIT_MS = 1000;
const receiptsWithin = (promise) => untilDeadline(promise.catch(() => null), Date.now() + RECEIPTS_WAIT_MS, null);

const _selfAttestRounds = new Map(); // node id -> { force, promise } of the round in flight
const _pingLanes = new Map();        // node id -> settles when the last queued answer for it is done

// One ping-response POST at a time per node, whichever path sends it. A queued answer gives up (false) once its
// own deadline leaves less than SELF_ATTEST_MIN_POST_MS; one that gives up keeps its place in the queue.
async function inPingLane(nodeId, deadline, answer) {
  const before = _pingLanes.get(nodeId);
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = before ? before.then(() => mine) : mine;
  _pingLanes.set(nodeId, tail);
  try {
    if (before && !(await untilDeadline(before.then(() => true), deadline - SELF_ATTEST_MIN_POST_MS, false))) return false;
    return await answer();
  } finally {
    release();
    if (_pingLanes.get(nodeId) === tail) _pingLanes.delete(nodeId);
  }
}

// One enrolment of this device at a time per node (MN-R2-03). Each one makes a pending device key that replaces the one
// before it (Android deletes that key), so an enrolment beside another could leave the node holding a key this install
// no longer has. A re-send that finds one running is skipped (false; the one running reloads the tab), and a binding the
// user asked for (Use this device, the QNet Link sheet) waits for it.
const _enrolLanes = new Map(); // node id -> the last enrolment queued for it
function inEnrolLane(nodeId, task, { wait = false } = {}) {
  const before = _enrolLanes.get(nodeId);
  if (before && !wait) return Promise.resolve(false);
  // The lane is free again before the caller goes on: the entry goes as the task settles, not a turn later.
  const lane = (async () => {
    if (before) await before.catch(() => {});
    try {
      return await task();
    } finally {
      if (_enrolLanes.get(nodeId) === lane) _enrolLanes.delete(nodeId);
    }
  })();
  _enrolLanes.set(nodeId, lane);
  return lane;
}

// The support reference of a device message the network refused (light-node-messages section 5.9): the enrolment's
// challenge nonce and the tag of the key it carried, or null (no enrolment went, or its key has no point).
function refusalRef(enrolment) {
  try {
    const nonce = enrolment && enrolment.fields && enrolment.fields.device && enrolment.fields.device.nonce;
    const key = enrolment && enrolment.key;
    return nonce && key && key.hwPub ? resetRef(nonce, deviceTag(key.platform, key.hwPub)) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Where the network wakes this device: an FCM token, else polling. `target` is the string the binding signs
 * (light-node-messages section 4). Read only while linking or refreshing a linked node: with auto-init off
 * (firebase.json) Firebase issues no token before this asks for one.
 */
export async function pushTarget() {
  try {
    await messaging().registerDeviceForRemoteMessages();
    const token = await messaging().getToken();
    if (token) return { type: PushType.FCM, token, target: token };
  } catch (e) {
    logger.log('[Push] FCM not available:', e && e.message);
  }
  return { type: PushType.POLLING, target: '' };
}

// How long a teardown waits for Firebase to forget the token (teardownLightNode).
const TOKEN_DROP_WAIT_MS = 4000;

// Firebase forgets this device's token: no push can reach it any more.
async function dropPushToken() {
  try { await messaging().deleteToken(); } catch (_) { /* never issued, or not registered */ }
}

// A token taken for a binding that did not happen is given back: none exists while nothing is linked here.
async function giveBackToken(push) {
  try {
    if (push && push.token && !(await AsyncStorage.getItem('qnet_ping_node_id'))) await dropPushToken();
  } catch (_) { /* the next teardown gives it back */ }
}

// The ping key of `nodeId` on this device, or null.
async function pingKeyOf(nodeId) {
  try {
    const Keychain = require('react-native-keychain');
    const entry = await Keychain.getGenericPassword({ service: `qnet_ping_sk_${nodeId}` });
    return entry && entry.password ? entry.password : null;
  } catch (_) {
    return null;
  }
}

/**
 * This device's binding of `nodeId`: { nodeId, seq, pushType, hw, boundAt } (seq 0 for a binding older builds made; `hw`
 * when the node took this device's key with it; `boundAt` Unix seconds, null when an older build wrote none), or null.
 */
export async function localBinding(nodeId) {
  try {
    const [[, infoStr], [, pingNode]] = await AsyncStorage.multiGet(['qnet_light_node_info', 'qnet_ping_node_id']);
    const info = JSON.parse(infoStr || 'null');
    if (!info || info.nodeId !== nodeId || pingNode !== nodeId) return null;
    return {
      nodeId, seq: Number.isSafeInteger(info.seq) && info.seq > 0 ? info.seq : 0, pushType: info.pushType || null,
      hw: info.hw === true, boundAt: Number.isSafeInteger(info.boundAt) && info.boundAt > 0 ? info.boundAt : null,
    };
  } catch (_) {
    return null;
  }
}

// The node took this device's key after all (the pending binding's re-send carried it).
async function markDeviceKeyTaken(nodeId) {
  try {
    const info = JSON.parse((await AsyncStorage.getItem('qnet_light_node_info')) || 'null');
    if (info && info.nodeId === nodeId) await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ ...info, hw: true }));
  } catch (_) { /* replies go without the device signature until the next binding */ }
}

/**
 * Settles a device key that went in a message with no answer by the device tags of a signed status read (`status` from
 * LightNode.readNodeStatus), whatever this device's binding says of its key: every read that names tags settles it, not
 * only the first, and a key an owner names makes the binding one that holds this device's key (MN-R4-03). 'pending',
 * 'current' or null, as NodeDeviceKey.settleByTag.
 */
export async function settleUnansweredKey(nodeId, status) {
  if (!status || !Array.isArray(status.deviceTags) || status.deviceTags.length === 0) return null;
  const settled = await settleByTag(status.nonce, status.deviceTags).catch(() => null);
  if (settled === 'pending') await markDeviceKeyTaken(nodeId);
  return settled;
}

/**
 * This install's device key no longer exists (reinstall, restore, iOS offload): no reply, refresh or rotation can be
 * signed with it again. The binding is marked as holding no device key and the dead key is forgotten, so the Node tab
 * offers Use this device, which enrols a new key behind one foreground authentication (NodeTab nodeView `reenrol`).
 * `failedKey`: the key a signature failed with (NodeDeviceKey.sign names it on a KEY_GONE). Only that key is forgotten,
 * and only while it is still the current one: a rotation that committed a new key meanwhile leaves the binding as it is.
 */
export async function markDeviceKeyLost(nodeId, failedKey = null) {
  try {
    if (failedKey && !(await forgetKey(failedKey))) return;
    const info = JSON.parse((await AsyncStorage.getItem('qnet_light_node_info')) || 'null');
    if (info && info.nodeId === nodeId && info.hw) {
      await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ ...info, hw: false }));
    }
    if (!failedKey) await forgetKeys();
  } catch (_) { /* the next reply finds it again */ }
}

// A binding the node took with this device's enrolment (section 5.3): { nodeId, seq, wallet, bindBlob, tries, nextTryAt }.
// No secrets: the signed binding the owners already hold, without its device block. A record whose statement carried no
// lease waits in check_pending and is never renewed or rotated into counting (node batch D2, T5, R5): no vendor token
// went with it, or the oracle was not configured, did not answer in time or its lease did not verify. Only a new
// enrolment of the same binding with a token completes it, re-sent from the Node tab in the foreground
// (enrolAgainIfUnleased), whatever the first enrolment carried.
export const ENROL_AGAIN_KEY = 'qnet_node_enrol_again';
// The first re-send waits past the attestors' vote on the key just posted: for 600 + 2 x 120 s they refuse any other key
// for the same node and sequence (stale_seq), and an Android re-send always carries a new key.
export const ENROL_AGAIN_FIRST_WAIT_MS = 15 * 60000;

async function noteEnrolAgain(nodeId, seq, wallet, bindBlob) {
  try {
    await AsyncStorage.setItem(ENROL_AGAIN_KEY, JSON.stringify({
      nodeId, seq, wallet, bindBlob, tries: 0, nextTryAt: Date.now() + ENROL_AGAIN_FIRST_WAIT_MS,
    }));
  } catch (_) { /* the tab's notice still says the check is not finished */ }
}

async function readEnrolAgain(nodeId) {
  try {
    const rec = JSON.parse((await AsyncStorage.getItem(ENROL_AGAIN_KEY)) || 'null');
    return rec && rec.nodeId === nodeId && Number.isSafeInteger(rec.seq) && rec.bindBlob ? rec : null;
  } catch (_) {
    return null;
  }
}

const dropEnrolAgain = () => AsyncStorage.removeItem(ENROL_AGAIN_KEY).catch(() => {});

// The network's refusal of the device check that the re-send of a binding got ({ nodeId, seq, reason, ref }): the task
// ends (or, for `device_unlicensed`, waits for Google Play's licence) and the Node tab says why the node is not counted
// here, never that a check still runs (nodeCheckState). It belongs to that binding: a new one (a later sequence, as Use
// this device makes) leaves it unread; a re-send the node takes, the record read counted while a re-send was owed, and
// the end of the binding here (teardownLightNode) clear it.
export const CHECK_REFUSED_KEY = 'qnet_node_check_refused';
const noteCheckRefused = (nodeId, seq, r) => AsyncStorage.setItem(CHECK_REFUSED_KEY, JSON.stringify({
  nodeId, seq, reason: r.reason, ref: typeof r.ref === 'string' && /^[0-9a-f]{8}$/.test(r.ref) ? r.ref : null,
})).catch(() => {});
const dropCheckRefused = () => AsyncStorage.removeItem(CHECK_REFUSED_KEY).catch(() => {});

/**
 * What the Node tab knows beyond the signed status of a binding whose device record waits in `check_pending`
 * (screens/NodeTab checkState): `resending` while this device still has the same binding to send again with a token
 * (enrolAgainIfUnleased), `refusal` { reason, ref } when the network refused the check of that re-send. For this
 * device's binding of `nodeId` at `seq` only.
 */
export async function nodeCheckState(nodeId, seq) {
  const rec = await readEnrolAgain(nodeId);
  let refused = null;
  try { refused = JSON.parse((await AsyncStorage.getItem(CHECK_REFUSED_KEY)) || 'null'); } catch (_) { refused = null; }
  const refusal = refused && refused.nodeId === nodeId && refused.seq === seq && typeof refused.reason === 'string'
    ? { reason: refused.reason, ref: refused.ref || null } : null;
  return { resending: !!rec && rec.seq === seq, refusal };
}

// A binding's fields without a device block or vendor token: what a re-send enrols afresh.
function withoutDevice(body) {
  const { device, dc_token: dc, pi_token: pi, ...rest } = body; // eslint-disable-line no-unused-vars
  return rest;
}

/** This device's node, whichever wallet it belongs to: { nodeId, walletAddress }, or null. */
export async function localNode() {
  try {
    const info = JSON.parse((await AsyncStorage.getItem('qnet_light_node_info')) || 'null');
    return info && typeof info.nodeId === 'string' ? { nodeId: info.nodeId, walletAddress: info.walletAddress || null } : null;
  } catch (_) {
    return null;
  }
}

// Why the device could not produce its evidence, as a refusal reason the Node tab says (light-node-messages section 8).
// No vendor token can ever come (no Google Play on the device, no DeviceCheck): the device cannot run a node, and nothing
// is bound (plan AF4). An enrolment the wake's deadline left no time for is 'deadline': nothing was sent or counted.
function enrolRefusal(e) {
  const code = e && e.code;
  if (code === 'UNSUPPORTED' || code === 'PLAY_UNAVAILABLE') return 'device_unsupported';
  if (code === 'DEADLINE') return 'deadline';
  return 'network';
}

/** The ping key's signature of the node's signed-status request, or null when this device holds no ping key for it. */
export async function signStatusWithPingKey(nodeId, ts) {
  const sk = await pingKeyOf(nodeId);
  if (!sk) return null;
  const { signDetached } = require('../crypto/DilithiumCrypto');
  return { signer: 'ping', sig: await signDetached(statusPreimage(nodeId, ts), sk) };
}

/**
 * Keeps a binding the node took: the previous light node of this device goes first (one node per device), then the new
 * ping key (`keepKey`), the records the wakes read, and the periodic wake; the first answer goes out at once.
 */
export async function adoptBinding({ nodeId, walletAddress, push, seq, pingPublicKey, cert, identityPublicKey, keepKey, hw = false }) {
  await teardownLightNode({ keepToken: true });
  await keepKey();
  const now = Math.floor(Date.now() / 1000);
  await AsyncStorage.multiSet([
    ['qnet_light_node_info', JSON.stringify({ nodeId, walletAddress, pushType: push.type, seq, boundAt: now, hw })],
    ['qnet_ping_node_id', nodeId],
    [`qnet_ping_dilithium_pk_${nodeId}`, pingPublicKey],
    [`qnet_ping_cert_${nodeId}`, cert],
    [`qnet_identity_pk_${nodeId}`, identityPublicKey],
    ...(push.token ? [['qnet_last_sent_fcm_token', push.token], ['qnet_last_token_refresh_ts', String(now)]] : []),
  ]);
  if (push.type === PushType.POLLING) {
    const next = await getNextPingTime();
    await setupPollingService(nodeId, (next && next.next_ping_time) || 0);
  } else {
    await configureBackgroundFetch();
  }
  selfAttestIfNeeded(nodeId, true).catch(() => {});
}

// The /bind fields of a binding a WalletManager signed (light-node-messages section 4), without any device block. The
// platform ("ios" on an iPad too) and the model (DeviceModel: a short marketing name, never an identifier) are unsigned
// hints the public status shows as the bound device; a node that does not know a field ignores it.
const PLATFORM_HINT = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null;
function bindBody(nodeId, b, push, seq, ts, model = null) {
  return {
    ...(PLATFORM_HINT ? { platform: PLATFORM_HINT } : {}),
    ...(model ? { model } : {}),
    node_id: nodeId,
    wallet_address: b.wallet,
    identity_pubkey: b.identityPublicKey,
    ping_pubkey: b.pingPublicKey,
    delegation_cert: b.delegation,
    seq,
    ts,
    attach_sig: b.attachSig,
    push_type: push.type,
    ...(push.token ? { device_token: push.token } : {}),
  };
}

/**
 * "Use this device", and the QNet Link sheet for a node already on the chain: binds this wallet's light node to this
 * device with a sequence above the node's current one, so the device that answered before stops (light-node-messages
 * section 4). Once two genesis nodes serve `device_v1` the binding carries this device's enrolment (section 5.3), and a
 * device that cannot run a node binds nothing. `signer` is the WalletManager holding the open wallet: it signs the
 * status request, the delegation and the attach over values it builds itself. `device`: NodeDeviceKey.checkDevice's
 * answer when the caller has it; `interactive`: Google Play's dialog may fix a token; `epoch`: the chain's epoch as the
 * caller read it (else the one this device last knew). Resolves { ok: true, seq } or { ok: false, reason, ref?,
 * unknown? }: a /bind refusal reason, 'not_registered' or 'network', with the support reference of a refused enrolment
 * (refusalRef); `unknown` when the binding went out, got no answer, and no status told whether the node took it
 * (MN-R4-04). It waits for an enrolment of this device that is running (inEnrolLane).
 */
export function bindThisDevice(args) {
  return inEnrolLane(args.nodeId, () => bindNow(args), { wait: true });
}

// After a /bind that got no answer, the node's signed status is read again at these waits (ms): an issuer answers a bind
// within its device budget (12 s), so a binding it took is in its status by then (MN-R4-04).
export const BIND_RECHECK_MS = [2000, 6000];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether the node took the binding `seq` that got no answer: { taken: true, status } when a signed status names it,
 * { taken: false, known: true } when every signed status names another binding, { taken: false, known: false } when no
 * signed status came.
 */
async function bindOutcome(nodeId, seq, signStatus) {
  let known = false;
  for (const ms of BIND_RECHECK_MS) {
    await pause(ms);
    const s = await readNodeStatus(nodeId, { signStatus }).catch(() => null);
    const bound = s && s.signed ? s.signed.bindingSeq : null;
    if (bound === seq) return { taken: true, status: s };
    if (Number.isSafeInteger(bound) && bound > seq) return { taken: false, known: true };
    if (Number.isSafeInteger(bound)) known = true;
  }
  return { taken: false, known };
}

/**
 * Whether the key rotation of this node's device record fell due by the chain's epoch (`epoch`, else the one this
 * device last knew), by the node's signed status or by this device's schedule. A statement over a key the attestors
 * already hold keeps that key's period (the node's key_rotation_due, ND-2), so re-proving such a key would leave the
 * record held for rotation: a binding then attests a new key, as Android always does (MN-R4-01).
 */
async function rotationFellDue(nodeId, status, epoch = null) {
  const dues = [status && status.signed ? status.signed.rotationDue : null, await Enrolment.scheduledRotationDue(nodeId)]
    .filter(Number.isSafeInteger);
  if (dues.length === 0) return false;
  const now = Number.isSafeInteger(epoch) ? epoch : await knownChainEpoch();
  return Number.isSafeInteger(now) && dues.some((due) => now >= due);
}

async function bindNow({ signer, credential, nodeId, device = null, interactive = false, epoch = null }) {
  const signStatus = (id, ts) => signer.signNodeStatus(credential, id, ts);
  let status = await readNodeStatus(nodeId, { signStatus });
  // iOS: this install's current key, when it has one, proves itself with an assertion, also when the node moves back
  // here from another device (the network keeps a key's entry past the record it served), so no move adds to Apple's
  // count of attested keys; one the network no longer holds answers device_not_genuine, and the key is then replaced
  // once (node batch D4, V3). A key whose rotation fell due is never proven again: a new one is attested (MN-R4-01).
  let freshKey = await rotationFellDue(nodeId, status, epoch);
  // The push token an earlier try took: given back when a later try ends before a binding (MN-R2-04).
  let taken = null;
  const model = await deviceModel();
  const end = async (answer) => {
    await giveBackToken(taken);
    return answer;
  };
  for (let attempt = 0; ; attempt++) {
    if (status.onChain === false) return end({ ok: false, reason: 'not_registered' });
    if (status.onChain !== true || !status.features.includes('bind_v2')) return end({ ok: false, reason: 'network' });
    const dev = status.features.includes(Enrolment.FEATURE_DEVICE) ? (device || await checkDevice()) : null;
    if (dev && dev.capable !== true) return end({ ok: false, reason: dev.reason || 'device_unsupported' });
    const ts = Math.floor(Date.now() / 1000);
    // Above the binding two owners name alike, and above the one the first owner names (a newer one it holds already).
    const held = Math.max(Number.isSafeInteger(status.bindingSeqAgreed) ? status.bindingSeqAgreed : 0,
      (status.signed && status.signed.bindingSeq) || 0);
    const seq = Math.max(ts, held + 1);
    const push = await pushTarget();
    taken = push;
    let b;
    try {
      b = await signer.prepareLightNodeBinding(credential, { seq, ts, pushTarget: push.target });
    } catch (e) {
      await giveBackToken(push);
      throw e;
    }
    let enrolment = null;
    try {
      if (b.nodeId !== nodeId) {
        await giveBackToken(push);
        return { ok: false, reason: 'identity_mismatch' };
      }
      const body = bindBody(nodeId, b, push, seq, ts, model);
      if (dev) {
        try {
          enrolment = await Enrolment.enrol({
            nodeId, wallet: b.wallet, pingPublicKey: b.pingPublicKey, seq, device: dev, reuse: !freshKey, interactive,
          });
        } catch (e) {
          await giveBackToken(push);
          return { ok: false, reason: enrolRefusal(e) };
        }
        Object.assign(body, enrolment.fields);
      }
      const r = await postBind(nodeId, body, { first: enrolment && enrolment.url });
      // Sent and unanswered: the node may have taken it. Its signed status tells; a binding it took is kept here as
      // taken, its device key waiting for the device tag, as the link sheet keeps one (MN-R4-04).
      if (!r.ok && r.reason === 'network') {
        const outcome = await bindOutcome(nodeId, seq, signStatus);
        if (outcome.taken) {
          await Enrolment.settle(enrolment, false, { unanswered: true });
          const tagged = !!enrolment
            && (await settleByTag(outcome.status.nonce, outcome.status.deviceTags).catch(() => null)) === 'pending';
          await adoptBinding({
            nodeId, walletAddress: b.wallet, push, seq, pingPublicKey: b.pingPublicKey, cert: `v2.${seq}.${b.delegation}`,
            identityPublicKey: b.identityPublicKey, keepKey: b.keep, hw: tagged,
          });
          await Enrolment.noteBinding(nodeId, status.features, null);
          if (enrolment) await noteEnrolAgain(nodeId, seq, b.wallet, withoutDevice(body));
          else await dropEnrolAgain();
          return { ok: true, seq };
        }
        await Enrolment.settle(enrolment, false);
        await giveBackToken(push);
        return outcome.known ? r : { ...r, unknown: true };
      }
      const committed = await Enrolment.settle(enrolment, r.ok);
      if (r.ok) {
        await adoptBinding({
          nodeId, walletAddress: b.wallet, push, seq, pingPublicKey: b.pingPublicKey,
          // The delegation as the node's own records carry it: its sequence in front (light-node-messages section 8).
          // `hw` only when the key the node took is this install's current key now (MN-R2-03).
          cert: `v2.${seq}.${b.delegation}`, identityPublicKey: b.identityPublicKey, keepKey: b.keep, hw: committed,
        });
        // The schedule starts over for this binding: the status read before it described the device before (MN-5).
        await Enrolment.noteBinding(nodeId, status.features, r.answer);
        if (enrolment) await noteEnrolAgain(nodeId, seq, b.wallet, withoutDevice(body));
        else await dropEnrolAgain();
        return { ok: true, seq };
      }
      // An assertion by a key the network no longer holds: that key is forgotten and a new one attested, once.
      if (r.reason === 'device_not_genuine' && enrolment && enrolment.reused && !freshKey) {
        freshKey = true;
        await forgetKeys().catch(() => {});
        continue;
      }
      // Another device bound meanwhile: once more above its sequence.
      if (r.reason === 'stale_seq' && attempt === 0) {
        status = await readNodeStatus(nodeId, { signStatus });
        continue;
      }
      await giveBackToken(push);
      // A refusal of this device's enrolment carries the reference support finds its case by (SD-R2-01): the node's own,
      // else the one the enrolment's challenge and key make.
      const ref = r.ref || refusalRef(enrolment);
      return ref ? { ...r, ref } : r;
    } finally {
      b.wipe();
    }
  }
}

const hexBytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));

/**
 * The QNet Link sheet for a node not on the chain yet (qnet-link-v1 section 14.8): after the user confirmed, the wallet
 * key signs its consent to the registration with `burnTx` at T = now; for a burn made from the wallet's own Solana
 * address `burner`, that address's key also signs the burn's owner bind at the same T. On a device that runs the node it
 * also signs the binding (seq = ts = T), takes the push token, enrols the device when two genesis nodes serve `device_v1`
 * (`features`), posts the binding with the consent to the shard owner and its backup, keeps the ping key and writes the
 * pending-link record, which re-sends the binding while the chain lists the node unbound. A device that cannot run a node
 * gives the consent only. Resolves { consent: { ts, pk, sig, ownerSig? } (b64url, decimal T), bound, reason, ref? } for
 * the answer, `reason` being a refusal of this device's binding no re-send can change (then nothing is kept here) and
 * `ref` its support reference; throws when nothing could be signed.
 */
export function linkWithConsent(args) {
  return inEnrolLane(args.nodeId, () => linkNow(args), { wait: true });
}

async function linkNow({ signer, credential, nodeId, burnTx, burner = null, device, features = [], interactive = true }) {
  const T = Math.floor(Date.now() / 1000);
  const runs = !!device && device.capable === true;
  const model = runs ? await deviceModel() : null;
  const push = runs ? await pushTarget() : null;
  let c;
  try {
    c = await signer.prepareLinkConsent(credential, { burnTx, ts: T, pushTarget: push ? push.target : null, burner });
    if (burner !== null && !c.ownerSig) throw new Error('No owner bind');
  } catch (e) {
    await giveBackToken(push);
    throw e;
  }
  const b = c.binding;
  try {
    if (c.nodeId !== nodeId) {
      await giveBackToken(push);
      throw new Error('Not this wallet\'s node');
    }
    const consent = {
      ts: String(T), pk: b64url(hexBytes(c.identityPublicKey)), sig: b64url(hexBytes(c.consentSig)),
      ...(burner !== null ? { ownerSig: b64url(hexBytes(c.ownerSig)) } : {}),
    };
    if (!b) return { consent, bound: false, reason: null };
    const bindBlob = {
      ...bindBody(nodeId, b, push, T, T, model),
      consent: { burn_tx: burnTx, registration_proof: c.proof, timestamp: T, consent_sig: c.consentSig },
    };
    let enrolment = null;
    let r = null;
    let committed = false;
    // iOS: this install's current key, when the network holds it, proves itself with an assertion, as for Use this
    // device, so no link adds to Apple's count of attested keys (plan R8); one the network no longer holds answers
    // device_not_genuine, and the key is then replaced once.
    for (let fresh = false; ; fresh = true) {
      const body = { ...bindBlob };
      enrolment = null;
      r = null;
      if (features.includes(Enrolment.FEATURE_DEVICE)) {
        try {
          enrolment = await Enrolment.enrol({
            nodeId, wallet: c.wallet, pingPublicKey: b.pingPublicKey, seq: T, device, reuse: !fresh, interactive,
          });
          Object.assign(body, enrolment.fields);
        } catch (e) {
          // The node takes no binding without the device block: nothing is posted, and a re-send enrols again.
          logger.warn('[LightNode] device check not made:', (e && e.code) || e);
          r = { ok: false, reason: enrolRefusal(e), retryAfterSeconds: null };
        }
      }
      let posted = false;
      if (!r) {
        posted = true;
        r = await postPendingBind(nodeId, body, { first: enrolment && enrolment.url });
      }
      // Sent and unanswered: the owners may hold the key, which waits for the status to tell rather than a new one (MN-5).
      committed = await Enrolment.settle(enrolment, r.ok, { unanswered: posted && !r.ok && r.reason === 'network' });
      if (!(r.reason === 'device_not_genuine' && enrolment && enrolment.reused && !fresh)) break;
      await forgetKeys().catch(() => {});
    }
    // A refusal a re-send cannot change keeps nothing here: the consent stands, and the Node tab offers Use this device
    // once the chain lists the node.
    if (!r.ok && !isTransientRefusal(r.reason)) {
      await giveBackToken(push);
      const ref = r.ref || refusalRef(enrolment);
      return { consent, bound: false, reason: r.reason, ...(ref ? { ref } : {}) };
    }
    // Otherwise the binding stays with the device: the node takes it when the registration applies, or the pending-link
    // record sends it again.
    await adoptBinding({
      nodeId, walletAddress: c.wallet, push, seq: T, pingPublicKey: b.pingPublicKey, cert: `v2.${T}.${b.delegation}`,
      identityPublicKey: c.identityPublicKey, keepKey: b.keep, hw: committed,
    });
    await writeLinkPending({ nodeId, wallet: c.wallet, T, bound: r.ok, bindBlob });
    if (r.ok && enrolment) await noteEnrolAgain(nodeId, T, c.wallet, bindBlob);
    return { consent, bound: r.ok, reason: null };
  } finally {
    if (b) b.wipe();
  }
}

// Refusals that a later try may not meet again; every other one is final for the binding it refused.
const TRANSIENT_REFUSALS = new Set(['network', 'rate_limited', 'device_rate_limited', 'device_stale']);
const isTransientRefusal = (reason) => TRANSIENT_REFUSALS.has(reason);

// A re-send that failed for now (no network, a rate limit, a device check not made) comes again after the answer's short
// waits (retryWaitMs: 1, 2, 4, then every 5 minutes, each up to a fifth sooner), or later when the node said so. Only a
// try that attested a NEW device key waits 4 h, doubling up to a day (`newKey`): the platforms limit how many keys one
// device may have attested (iOS) or certified (Android), and the network counts them (plan R8), so a day of such
// failures costs three keys at most, never nine. A try that made no key, or proved the current one, is not one of them.
const ENROL_RESEND_FIRST_WAIT_MS = 4 * 3600000;
const ENROL_RESEND_MAX_WAIT_MS = 24 * 3600000;
function laterTry(rec, refusal, { newKey = false } = {}) {
  const tries = (Number.isSafeInteger(rec.tries) ? rec.tries : 0) + 1;
  const keyTries = (Number.isSafeInteger(rec.keyTries) ? rec.keyTries : 0) + (newKey ? 1 : 0);
  const wait = newKey ? Math.min(ENROL_RESEND_FIRST_WAIT_MS * 2 ** (keyTries - 1), ENROL_RESEND_MAX_WAIT_MS) : retryWaitMs(tries);
  return { tries, keyTries, nextTryAt: Date.now() + Math.max(wait, ((refusal && refusal.retryAfterSeconds) || 0) * 1000) };
}

/**
 * One enrolment-bearing POST of `blob` (a signed binding without a device block) for `seq`, as a re-send makes it:
 * a fresh challenge and this device's evidence (an assertion by the current key where there is one; a new key once when
 * the network no longer holds it), then /light-node/bind. `deadline` (ms, a background wake's): every call stays within
 * it, and nothing is attested or posted that could not finish in time (reason 'deadline': nothing sent, nothing
 * counted). { r, enrolment, posted, committed, newKey }, `committed` when the key the node took is this install's current
 * key, `newKey` when the try attested a new device key (not an assertion of the current one).
 */
async function resendWithEnrolment(nodeId, status, { wallet, seq, blob, interactive, deadline = null }) {
  // A key whose rotation fell due is never proven again: a new one is attested (MN-R4-01).
  let fresh = await rotationFellDue(nodeId, status);
  // A binding kept by an earlier version names no model: the re-send adds this device's (an unsigned hint).
  const withModel = await withDeviceModel(blob);
  for (;;) {
    let enrolment = null;
    const body = { ...withModel };
    try {
      const device = await checkDevice();
      if (!device.capable) {
        return { r: { ok: false, reason: device.reason || 'device_unsupported' }, enrolment: null, posted: false, committed: false };
      }
      enrolment = await Enrolment.enrol({
        nodeId, wallet, pingPublicKey: body.ping_pubkey, seq, device, reuse: !fresh, interactive, deadline,
      });
      Object.assign(body, enrolment.fields);
    } catch (e) {
      // The node takes no binding without the device block: nothing is posted this time.
      return { r: { ok: false, reason: enrolRefusal(e), retryAfterSeconds: null }, enrolment: null, posted: false, committed: false };
    }
    const left = Enrolment.timeLeft(deadline);
    if (left < Enrolment.MIN_CALL_MS) {
      // Attested, but no time left to post it: the node never saw the key.
      await Enrolment.settle(enrolment, false);
      return { r: { ok: false, reason: 'deadline', retryAfterSeconds: null }, enrolment: null, posted: false, committed: false };
    }
    const r = await postBind(nodeId, body, { first: enrolment.url, deadline });
    const committed = await Enrolment.settle(enrolment, r.ok, { unanswered: !r.ok && r.reason === 'network' });
    if (!r.ok && r.reason === 'device_not_genuine' && enrolment.reused && !fresh) {
      fresh = true;
      await forgetKeys().catch(() => {});
      continue;
    }
    return { r, enrolment, posted: true, committed, newKey: !enrolment.reused };
  }
}

/**
 * The QNet Link sheet's pending-link record `rec` once its time is over (T + 24 h + 10 min) and nothing sends its binding
 * again: it goes at the first status with a verdict on the chain, and with it the binding this device kept for the link
 * (the ping key, the push token, the wakes) when the network holds none of it: two owners say the node is not on the
 * chain, two refused its ping key, or two say no device is bound (MN-R2-04: an unsigned read, as a background wake's
 * without the status form, learns nothing of the key). A push token exists only while a node is linked here. No verdict
 * keeps the record for the next read: none on the chain, and none on the binding while it is still this device's
 * (the owners disagree whether a device is bound and nothing told whose key it is). True when the binding went.
 */
export async function endExpiredLink(nodeId, status, rec) {
  if (!rec || !rec.expired || !status || (status.onChain !== true && status.onChain !== false)) return false;
  const local = await localBinding(nodeId);
  const ours = !!local && local.seq === rec.T;
  const orphan = ours && (status.onChain === false || status.keyOurs === false || status.deviceBoundAgreed === false);
  if (!orphan && ours && status.keyOurs === null && status.deviceBoundAgreed !== true) return false;
  if (orphan) await teardownLightNode();
  await dropLinkPending();
  return orphan;
}

/**
 * The late delivery of the QNet Link sheet's binding (U3): while the pending-link record lives and the chain lists the
 * node with no device bound, the same signed binding goes again, with a fresh enrolment of this device when two genesis
 * nodes serve `device_v1`; no authentication is needed. The record goes once a device is bound, the binding is refused
 * for good, or its time is over (endExpiredLink); a try that failed for now waits (laterTry) before the next. `deadline`
 * (ms): a background wake's, which the whole re-send stays within; one it leaves no time for is not made and counts no
 * try. True when the node took it.
 */
export function resendPendingBinding(nodeId, status, options = {}) {
  return inEnrolLane(nodeId, () => resendPendingNow(nodeId, status, options));
}

async function resendPendingNow(nodeId, status, { interactive = false, deadline = null } = {}) {
  const rec = await readLinkPending(nodeId);
  if (!rec) return false;
  if (rec.expired) {
    await endExpiredLink(nodeId, status, rec);
    return false;
  }
  if (!rec.bindBlob || !status || status.onChain !== true) return false;
  if (status.deviceBound === true) {
    // A try that got no answer may be the binding that took: the device tag tells, now or at a later read
    // (settleUnansweredKey), and then the key is the node's. Its statement may have gone without a lease, which only a
    // re-send with a token completes: the enrol-again record is kept for it, as for an answered link (MN-R4-03).
    await settleUnansweredKey(nodeId, status);
    const local = await localBinding(nodeId);
    if ((status.features || []).includes(Enrolment.FEATURE_DEVICE) && local && local.seq === rec.T
        && !(await readEnrolAgain(nodeId))) {
      await noteEnrolAgain(nodeId, rec.T, rec.wallet, rec.bindBlob);
    }
    await dropLinkPending();
    return false;
  }
  if (Number.isSafeInteger(rec.nextTryAt) && Date.now() < rec.nextTryAt) return false;
  const enrols = (status.features || []).includes(Enrolment.FEATURE_DEVICE);
  if (!enrols && Enrolment.timeLeft(deadline) < Enrolment.MIN_CALL_MS) return false;
  // The next try's time is written before this one runs, so no other runtime (a headless wake) starts one beside it
  // (MN-R2-03); as if the try attested a new key, the longest wait, until it is known whether it did.
  await writeLinkPending({ ...rec, ...laterTry(rec, null, { newKey: enrols }) });
  let r;
  let enrolment = null;
  let committed = false;
  let newKey = false;
  if (enrols) {
    ({ r, enrolment, committed, newKey } = await resendWithEnrolment(nodeId, status, {
      wallet: rec.wallet, seq: rec.T, blob: rec.bindBlob, interactive, deadline,
    }));
  } else {
    r = await postBind(nodeId, await withDeviceModel(rec.bindBlob), { deadline });
  }
  if (r.reason === 'deadline') {
    await writeLinkPending(rec); // nothing went out: the next wake tries as if this one had not
    return false;
  }
  if (r.ok) {
    // The binding holds this device's key only when the key it carried is this install's current key.
    if (committed) await markDeviceKeyTaken(nodeId);
    if (enrolment) await noteEnrolAgain(nodeId, rec.T, rec.wallet, rec.bindBlob);
    await dropLinkPending();
    return true;
  }
  if (isTransientRefusal(r.reason)) {
    await writeLinkPending({ ...rec, ...laterTry(rec, r, { newKey }) });
  } else {
    await dropLinkPending();
  }
  return false;
}

/**
 * The Node tab, in the foreground: a binding whose device record waits in `check_pending` with no lease (the signed
 * status's `refresh_window` null) is taken but never counted, and nothing but a new enrolment with a vendor token ends
 * that (node batch R5), whether the first enrolment went without a token or the oracle could not give it a lease. While
 * the signed status still says so, the same binding (same `seq`) goes again with a fresh challenge and a token, Google
 * Play's dialog allowed; a counted or ended record ends the task. At the enrolment re-send's pace (laterTry), the first
 * try only after ENROL_AGAIN_FIRST_WAIT_MS; a re-send the node took is kept for the next status read to judge, since a
 * record may wait again (the oracle still down). None while a key sent without an answer waits for the status to settle
 * it: a new enrolment would replace it. A `stale_seq` while the signed status still names this very binding is the
 * attestors' vote on an earlier key of the same sequence, not a newer binding: it is tried again later, never dropped.
 * True when the node took the re-send.
 */
export function enrolAgainIfUnleased(nodeId, status) {
  return inEnrolLane(nodeId, () => enrolAgainNow(nodeId, status));
}

async function enrolAgainNow(nodeId, status) {
  const rec = await readEnrolAgain(nodeId);
  if (!rec) return false;
  const binding = await localBinding(nodeId);
  const signed = status && status.signed ? status.signed : null;
  const state = signed ? signed.deviceState : null;
  if (!binding || binding.seq !== rec.seq || state === 'active' || state === 'suspect' || state === 'ended') {
    await dropEnrolAgain();
    await dropCheckRefused();
    return false;
  }
  if (!status || status.onChain !== true || state !== 'check_pending' || signed.refreshWindow !== null) return false;
  if (!(status.features || []).includes(Enrolment.FEATURE_DEVICE)) return false;
  if (Number.isSafeInteger(rec.nextTryAt) && Date.now() < rec.nextTryAt) return false;
  if (await hasUnansweredKey()) return false;
  const later = (refusal) => AsyncStorage.setItem(ENROL_AGAIN_KEY, JSON.stringify({
    ...rec, ...laterTry(rec, refusal, { newKey: true }),
  })).catch(() => {});
  // The next try's time is written before this one runs (MN-R2-03).
  await later(null);
  const { r, enrolment, committed } = await resendWithEnrolment(nodeId, status, {
    wallet: rec.wallet, seq: rec.seq, blob: rec.bindBlob, interactive: true,
  });
  if (r.ok && enrolment) {
    if (committed) await markDeviceKeyTaken(nodeId);
    await dropCheckRefused();
    await later(r);
    return true;
  }
  const sameBinding = r.reason === 'stale_seq' && signed.bindingSeq === rec.seq;
  // A refusal of the device check itself is said on the tab; one about the binding (a newer one, a key) is not.
  if (typeof r.reason === 'string' && r.reason.startsWith('device_') && !isTransientRefusal(r.reason)) {
    await noteCheckRefused(nodeId, rec.seq, r);
  }
  if (isTransientRefusal(r.reason) || r.reason === 'device_unlicensed' || sameBinding) await later(r);
  else await dropEnrolAgain();
  return false;
}

/**
 * The Node tab, in the foreground: the lease refresh of a binding that holds this device's key, when its last try went
 * without a vendor token Google Play's dialog can fix (PLAY_FIXABLE), is tried again with that dialog, at most once an
 * hour (DeviceEnrolment.refreshIfDue `interactive`; plan-technical 6.10). Without it such a device's lease lapses and
 * nothing in the app could mend it (MN-R4-09). True when a genesis node took the refresh.
 */
export function refreshLeaseFromTab(nodeId) {
  return inEnrolLane(nodeId, async () => {
    const binding = await localBinding(nodeId);
    if (!binding || !binding.hw) return false;
    return Enrolment.refreshIfDue(nodeId, { interactive: true }).catch(() => false);
  });
}

/**
 * The unlink the website asks for and the user confirms on the QNet Link sheet (services/NodeLinkActions `unlink`), and
 * every end of this device's binding that the user or the wallet causes (wallet delete, erase, another wallet on the
 * device): the ping key signs the unbind (section 4; a binding older builds made has no sequence to sign, so only the
 * device forgets it), with the device record's release where the node took this device's key, and the device stops at
 * once: the ping key, the push token, the wakes and the records go before the network answers, so no answer can be sent
 * from here again whatever the network does. The node stays registered on the chain. The network gets at most
 * UNBIND_WAIT_MS; the release may take RELEASE_WAIT_MS of it at most, so the unbind, which never depends on the release
 * (node batch V4), always has the rest. `forgetDevice` (wallet delete and erase): the device key goes too.
 * `waitForNetwork` false resolves once the device stopped, with `sent` (the network's answer, true when it took the
 * unbind) still running: { unbound: null, sent }. Otherwise resolves { unbound }.
 */
const UNBIND_WAIT_MS = 8000;
const RELEASE_WAIT_MS = 3000;
export async function stopLightNode({ waitForNetwork = true, forgetDevice = false } = {}) {
  let sent = Promise.resolve(false);
  try {
    const nodeId = await AsyncStorage.getItem('qnet_ping_node_id');
    const binding = nodeId ? await localBinding(nodeId) : null;
    const sk = binding && binding.seq > 0 ? await pingKeyOf(nodeId) : null;
    if (sk) {
      const deadline = Date.now() + UNBIND_WAIT_MS;
      const { signDetached } = require('../crypto/DilithiumCrypto');
      // The device record ends with the binding (section 5.7): its release goes to the owner that issued its challenge.
      // An owner that does not give the release's challenge in time leaves the unbind without it.
      const releaseBy = Date.now() + RELEASE_WAIT_MS;
      const release = binding.hw
        ? await untilDeadline(Enrolment.releaseBlock(nodeId, binding.seq, { deadline: releaseBy }).catch(() => null), releaseBy, null)
        : null;
      const ts = Math.floor(Date.now() / 1000);
      const sig = await signDetached(unbindPreimage(nodeId, binding.seq, ts), sk);
      const body = { node_id: nodeId, seq: binding.seq, ts, signer: 'ping', sig };
      if (release) body.device_release = release.device_release;
      sent = untilDeadline(postUnbind(nodeId, body, { deadline, first: release && release.url }).then((r) => r.ok, () => false),
        deadline, false);
    }
  } catch (error) {
    logger.warn('[LightNode] unbind failed:', (error && error.message) || error);
  }
  await teardownLightNode({ forgetDevice });
  if (!waitForNetwork) return { unbound: null, sent };
  return { unbound: await sent };
}

/**
 * The one background-wake handler, live and headless (index.js): any wake self-attests (deduped per
 * epoch); a polling phone near its ping slot also pulls the pending challenge. Always finishes the task.
 */
export async function onBackgroundFetch(taskId) {
  // Everything this wake sends shares one deadline inside the ~30 s iOS gives a background fetch.
  const deadline = Date.now() + WAKE_FETCH_MS;
  try {
    logger.log('[BackgroundFetch] Task triggered:', taskId);
    // The last update of the old Android package runs no node, from its first wake on, opened or not (MN-R2-06).
    if (LEGACY_MOVE) {
      await teardownLightNode();
      return;
    }
    // Not opened since the device started, or swiped away since: nothing runs until the app is opened (AnswerGate).
    if (!(await mayAnswer())) {
      logger.log('[BackgroundFetch] the app is not open since the device started, or was swiped away: no answer until it is opened');
      return;
    }
    await selfAttestIfNeeded(undefined, false, deadline);
    await refreshTokenIfOwed(deadline);
    await maintainDevice(deadline);
    await resendIfPending(deadline);

    const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
    const nodeInfo = nodeInfoStr ? JSON.parse(nodeInfoStr) : null;
    if (nodeInfo && nodeInfo.pushType === PushType.POLLING) {
      // Only within [-180, +300] s of the ping time, so periodic wakes cost no challenge call.
      const timeToPing = (nodeInfo.nextPingTime || 0) - Math.floor(Date.now() / 1000);
      if (timeToPing <= 300 && timeToPing >= -180) {
        await checkPendingChallenge(deadline);
      }
    }
  } catch (error) {
    logger.warn('[BackgroundFetch] Task failed:', error.message || error);
  } finally {
    BackgroundFetch.finish(taskId);
  }
}

/**
 * Periodic wake for every push type: 30 min leaves several tries per 14,400-block epoch when the OS defers
 * some. From block 1,339,200 a wake sends no self-attestation for up to 2 hours after one (the counted hold,
 * readHold); a later wake in the same epoch costs one /height read, which re-arms the hold. A polling
 * phone within [-180, +300] s of its ping time still pulls the pending challenge.
 */
async function configureBackgroundFetch() {
  try {
    // stopOnTerminate, startOnBoot and enableHeadless are Android options. On iOS the wake is a
    // BGAppRefreshTask: the OS picks the time (at least 15 minutes apart) and never wakes a force-quit app.
    // No wake after a restart: nothing answers until the app is opened in the new boot (AnswerGate), and this
    // configure runs again then.
    const status = await BackgroundFetch.configure({
      minimumFetchInterval: 30,
      stopOnTerminate: false,
      startOnBoot: false,
      enableHeadless: true,
    }, onBackgroundFetch, (taskId) => {
      logger.log('[BackgroundFetch] Task timeout:', taskId);
      BackgroundFetch.finish(taskId);
    });
    await recordBackgroundRefreshStatus(status);
  } catch (error) {
    // iOS rejects with the Background App Refresh status itself: 0 restricted, 1 turned off.
    if (typeof error === 'number') await recordBackgroundRefreshStatus(error);
    logger.warn('[BackgroundFetch] Configure failed:', (error && error.message) || error);
  }
}

// The last Background App Refresh status configure reported (2 = available; services/BackgroundPriority).
export { BG_REFRESH_STATUS_KEY };
async function recordBackgroundRefreshStatus(status) {
  if (typeof status !== 'number') return;
  try { await AsyncStorage.setItem(BG_REFRESH_STATUS_KEY, String(status)); } catch (_) { /* best effort */ }
}

/**
 * Polling devices (no FCM token): the periodic wake, and on Android a precise one-shot wake ~2
 * minutes before the ping slot.
 */
async function setupPollingService(nodeId, nextPingTime) {
  // Calculate when to check (2 minutes before expected ping)
  const now = Math.floor(Date.now() / 1000);
  const checkTime = nextPingTime - 120; // 2 minutes before
  const delaySeconds = Math.max(60, checkTime - now);

  logger.log('[Polling] Next ping at', new Date(nextPingTime * 1000).toISOString());
  logger.log('[Polling] Scheduling wake-up in', Math.round(delaySeconds / 60), 'minutes');

  try {
    // Configured first: the one-shot wake is delivered to the same handler as the periodic fetch.
    await configureBackgroundFetch();

    // Android: a precise one-shot wake for this ping (AlarmManager). iOS has no precise wake: a polling
    // iPhone relies on the periodic wake and on opening the app.
    if (Platform.OS === 'android') {
      await BackgroundFetch.scheduleTask({
        taskId: 'qnet-ping-check',
        delay: delaySeconds * 1000,
        periodic: false, // One-time task - will reschedule after ping
        forceAlarmManager: true, // Use AlarmManager for precise timing
        enableHeadless: true,
      });
      logger.log('[Polling] ✅ Scheduled precise wake-up for ping');
    }
  } catch (error) {
    logger.warn('[Polling] Failed to setup background fetch:', error.message || error);
  }
}

// A detached ML-DSA-65 signature in hex (3309 bytes), the only `sig` the node reads on a poll.
const POLL_SIG_RE = /^[0-9a-fA-F]{6618}$/;

/**
 * The query that signs a poll (light-node-messages section 4, the signed poll): `ts`, now in Unix seconds, and `sig`, the
 * ping key over `q1337|light_poll:{N}:{ts}`. Only a signed poll counts as this device's fetch of the challenge left for
 * it. '' when this device holds no ping key for the node or cannot sign: the poll goes unsigned, is served alike and
 * marks nothing.
 */
async function signedPollQuery(nodeId) {
  try {
    const sk = await pingKeyOf(nodeId);
    if (!sk) return '';
    const { signDetached } = require('../crypto/DilithiumCrypto');
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signDetached(pollPreimage(nodeId, ts), sk);
    return typeof sig === 'string' && POLL_SIG_RE.test(sig) ? `&ts=${ts}&sig=${sig}` : '';
  } catch (_) {
    return '';
  }
}

/**
 * Check for pending challenge (polling mode), with a poll the ping key signs when this device holds it.
 */
export async function checkPendingChallenge(deadline = Date.now() + WAKE_FETCH_MS) {
  try {
    if (deadline - Date.now() < SELF_ATTEST_MIN_POST_MS) return null;
    const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
    if (!nodeInfoStr) {
      logger.log('[Polling] No node registered');
      return null;
    }

    const nodeInfo = JSON.parse(nodeInfoStr);
    const apiUrl = genesisNode();
    const signed = await signedPollQuery(nodeInfo.nodeId);
    // The Keychain read and the signing come out of the same deadline.
    if (deadline - Date.now() < SELF_ATTEST_MIN_POST_MS) return null;

    const response = await fetchWithTimeout(
      `${apiUrl}/api/v1/light-node/pending-challenge?node_id=${encodeURIComponent(nodeInfo.nodeId)}${signed}`,
      { method: 'GET' }, Math.min(6000, deadline - Date.now())
    );

    const result = await response.json();

    if (result.success && result.has_challenge) {
      logger.log('[Polling] challenge received');
      
      // Respond to the node that ISSUED the challenge. The stamp is a MAC keyed by that node's
      // own seed, so any other node rejects it as unrecognized — and with 5 bootstrap nodes an
      // independent second draw matched only 1 time in 5. The push and self-attest paths already
      // pass their URL through; this one dropped it.
      await respondToChallenge(nodeInfo.nodeId, result.challenge, apiUrl, deadline);
      
      return result;
    } else if (result.next_ping_time) {
      // Schedule next check
      await setupPollingService(nodeInfo.nodeId, result.next_ping_time);
    }

    return null;
  } catch (error) {
    logger.warn('[Polling] Check failed:', error.message || error);
    return null;
  }
}

/**
 * Get next ping time from server
 */
export async function getNextPingTime() {
  try {
    const nodeInfoStr = await AsyncStorage.getItem('qnet_light_node_info');
    if (!nodeInfoStr) return null;

    const nodeInfo = JSON.parse(nodeInfoStr);
    const apiUrl = genesisNode();

    const response = await fetchWithTimeout(
      `${apiUrl}/api/v1/light-node/next-ping?node_id=${encodeURIComponent(nodeInfo.nodeId)}`,
      { method: 'GET' }, 5000
    );

    const result = await response.json();

    if (result.success) {
      // Update stored info
      nodeInfo.nextPingTime = result.next_ping_time;
      nodeInfo.nextPingWindow = result.next_ping_window;
      await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify(nodeInfo));

      return result;
    }

    return null;
  } catch (error) {
    logger.warn('[Push] Failed to get next ping time:', error.message || error);
    return null;
  }
}

/**
 * Respond to ping challenge (sign and send)
 * MANDATORY: Dilithium3 (ML-DSA-65) quantum signature — no Ed25519 fallback
 * The answer goes to the genesis node that issued the stamp (`responseUrl`, its MAC key is that node's), named by its
 * public name; a response_url that is not a genesis node is refused, not rerouted; with none given, the node's own shard
 * owner takes it. `evidence`: the push this answers (pushEvidence), sent with the answer.
 */
export async function respondToChallenge(nodeId, challenge, responseUrl, deadline = Date.now() + RESPONSE_MS, evidence = null) {
  try {
    const pingNodeId = nodeId || await AsyncStorage.getItem('qnet_ping_node_id');
    if (!pingNodeId) {
      logger.warn('[Push] Dilithium3 ping key unavailable — ping missed (will retry next window)');
      return false;
    }
    const url = responseUrl ? genesisResponseUrl(responseUrl) : lightShardOwnerUrls(pingNodeId)[0];
    return (await answerInLane(pingNodeId, challenge, [url], deadline, evidence)).kind === 'ok';
  } catch (error) {
    logger.warn('[Push] Error responding to challenge:', error.message || error);
    return false;
  }
}

/**
 * What came of one answer: `kind` 'ok' (an owner took it), 'closed' (it came after its epoch's commit: it counts for
 * nothing, and nothing more is sent for that epoch), 'superseded' (a later binding replaced this device's), 'refused' (an
 * owner refused it for good: not registered, unbound, the key or the device refused; `reason` when it named one), 'stale'
 * (the anchor or stamp is not one the owner takes now), 'rate' (rate limited, `retryAfter` seconds), 'network' (no
 * readable answer: no connection, a timeout, a server error), 'nokey' (nothing could be signed here) or 'held' (the app
 * may not answer now, AnswerGate). `posted`: a POST went out; `reached`: an owner answered it.
 */
const outcome = (kind, extra = {}) => ({ kind, posted: false, reached: false, ...extra });

const STALE_REASONS = new Set(['stale', 'stale_anchor', 'expired', 'anchor_not_current']);
// An owner's word that the answer came after its epoch's commit (light-node-messages section 5.10), whatever else the
// reply says: `epoch_closed`, or `epoch_closing` from a genesis of an earlier release, whose next-epoch height is not read.
const CLOSED_REASONS = new Set(['epoch_closed', 'epoch_closing']);

// An owner's reply to an answer, as an outcome.
function replyOutcome(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return outcome('network', { posted: true });
  const reached = { posted: true, reached: true };
  if (CLOSED_REASONS.has(result.reason)) return outcome('closed', reached);
  if (result.success === true) return outcome('ok', reached);
  if (result.reason === 'superseded') return outcome('superseded', reached);
  const wait = Number(result.retry_after_seconds);
  if (Number.isSafeInteger(wait) && wait > 0) return outcome('rate', { ...reached, retryAfter: wait });
  if (STALE_REASONS.has(result.reason) || /stale|expired|unrecognized/i.test(String(result.error || ''))) {
    return outcome('stale', reached);
  }
  return outcome('refused', { ...reached, reason: typeof result.reason === 'string' ? result.reason : null });
}

// The epoch of a self-attestation's anchor, or null for a server stamp.
function anchorEpochOf(challenge) {
  const m = /^selfattest:(\d{1,15}):/.exec(challenge);
  return m ? Math.floor(Number(m[1]) / EPOCH_BLOCKS) : null;
}

// Several owners' outcomes as one: refused only when every owner that was asked answered and refused, so a lagging
// owner's refusal beside an unreachable one is tried again soon; a rate limit's wait, the longest named.
function joinedOutcome(outcomes) {
  const posted = outcomes.some((o) => o.posted);
  const reached = outcomes.some((o) => o.reached);
  const kinds = new Set(outcomes.map((o) => o.kind));
  if (outcomes.length > 0 && [...kinds].every((k) => k === 'refused')) {
    return outcome('refused', { posted, reached, reason: outcomes[0].reason || null });
  }
  if (kinds.has('rate')) {
    return outcome('rate', { posted, reached, retryAfter: Math.max(...outcomes.map((o) => o.retryAfter || 0)) });
  }
  if (kinds.has('stale') && !kinds.has('network')) return outcome('stale', { posted, reached });
  return outcome('network', { posted, reached });
}

// An answer that does not end the round: the next owner is asked this long after the one before while that one has
// not answered, at once when it failed. One slow or unreachable owner costs a push's answer this much, not the whole
// cap of a request, and a healthy first owner is the only one asked. Once a try of the run failed, the next owner is
// asked HEDGE_RETRY_MS after the one before (or when it failed): a device adds less load to owners that are slow, and
// every owner is still reached within one wake (iOS gets about 22 s for a push and sets no wake of its own).
export const HEDGE_MS = 3000;
export const HEDGE_RETRY_MS = 4000;

// `post(url)` to `urls` in turn, each started `hedgeMs` after the one before or as soon as that one failed, none once less than SELF_ATTEST_MIN_POST_MS of `deadline` is left. The first outcome that ends the
// round ('ok', 'closed', 'superseded') wins; otherwise all of them joined (joinedOutcome).
function postHedged(urls, post, deadline, hedgeMs = HEDGE_MS) {
  return new Promise((resolve) => {
    const outcomes = [];
    let next = 0;
    let running = 0;
    let timer = null;
    let settled = false;
    const finish = (o) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };
    const launch = () => {
      clearTimeout(timer);
      if (settled) return;
      if (next >= urls.length || deadline - Date.now() < SELF_ATTEST_MIN_POST_MS) {
        if (running === 0) finish(joinedOutcome(outcomes));
        return;
      }
      const url = urls[next++];
      running += 1;
      post(url).then((o) => {
        running -= 1;
        outcomes.push(o);
        if (o.kind === 'ok' || o.kind === 'closed' || o.kind === 'superseded') finish(o);
        else launch();
      });
      if (next < urls.length) timer = setTimeout(launch, hedgeMs);
    };
    launch();
  });
}

// One answer at a time per node, whichever path sends it (inPingLane), and only while the app may answer (AnswerGate).
async function answerInLane(pingNodeId, challenge, urls, deadline, evidence = null) {
  if (!(await mayAnswer())) return outcome('held');
  let out = outcome('network');
  await inPingLane(pingNodeId, deadline, async () => {
    out = await answerChallenge(pingNodeId, challenge, urls, deadline, evidence);
    return true;
  });
  return out;
}

// The push evidence an answer carries (light-node-messages section 5.10): when the network sent the push (its clock),
// when this device took it and when it answered (this device's clock), decimal seconds, so a node can tell how long the
// push took to reach the device whatever this clock says; and the record of the pushes of the epochs before
// (PushReceipts.reportFor), dated by the same `answered_at`. Strings: the route takes a flat map of strings.
function evidenceFields(evidence, answeredAt, report = null) {
  const pushed = !!evidence && Number.isSafeInteger(evidence.receivedAt);
  if (!pushed && !report) return {};
  return {
    ...(pushed && Number.isSafeInteger(evidence.sentAt) ? { sent_at: String(evidence.sentAt) } : {}),
    ...(pushed ? { received_at: String(evidence.receivedAt) } : {}),
    answered_at: String(answeredAt),
    ...(report ? { push_receipts: JSON.stringify(report) } : {}),
  };
}

// The signed fields of an answer to `challenge`, or null when this device cannot sign it (no ping key here).
async function signedAnswer(pingNodeId, challenge) {
  const Keychain = require('react-native-keychain');
  // ── PATH A: ML-DSA-65 ping delegation key (v7.1) — background-safe ──────
  // Loads ML-DSA-65 ping secret key from Keychain (AFTER_FIRST_UNLOCK).
  // No password needed. Full quantum safety for ping responses.
  let keychainEntry = null;
  try {
    keychainEntry = await Keychain.getGenericPassword({ service: `qnet_ping_sk_${pingNodeId}` });
  } catch (keychainErr) {
    if (keychainErr.message && !keychainErr.message.includes('no item')) {
      logger.warn('[Push] Keychain unavailable for ping:', keychainErr.message);
    }
    return null;
  }
  if (!keychainEntry || !keychainEntry.password) return null;
  const { signWithDilithium, signDetached, isDilithiumAvailable } = require('../crypto/DilithiumCrypto');
  if (!isDilithiumAvailable()) return null;
  const pingSkHex = keychainEntry.password;
  const pingPkHex = await AsyncStorage.getItem(`qnet_ping_dilithium_pk_${pingNodeId}`);
  if (!pingPkHex) return null;
  // With a device key the node holds, a self-attestation carries the device signature over the same anchor
  // (light-node-messages section 5.8); a device key that cannot sign leaves the reply without it.
  let formattedSignature = null;
  const binding = await localBinding(pingNodeId);
  if (binding && binding.hw && challenge.startsWith('selfattest:') && await Enrolment.signsReplies(pingNodeId)) {
    try {
      formattedSignature = await Enrolment.hwPingSignature(pingNodeId, challenge, await signDetached(challenge, pingSkHex));
    } catch (e) {
      logger.warn('[Push] device signature unavailable:', (e && e.code) || (e && e.message) || e);
      // The key no longer exists here: the Node tab offers Use this device (MN-2). Only the key that failed is
      // forgotten, and only while it is still current (a rotation may have just replaced it).
      if (e && e.code === 'KEY_GONE') await markDeviceKeyLost(pingNodeId, e.key || null);
    }
  }
  if (!formattedSignature) {
    formattedSignature = `ping_dilithium:${await signWithDilithium(challenge, pingSkHex, pingPkHex, pingNodeId)}`;
  }
  // Present the ping delegation so the genesis verifies it against our committed on-chain key and
  // refreshes its ping-key store — overwrites any pre-registration gossip poison. Optional/graceful.
  const pingCert = await AsyncStorage.getItem(`qnet_ping_cert_${pingNodeId}`);
  // Presented so the node can verify the delegation against the hash the chain committed.
  const identityPk = await AsyncStorage.getItem(`qnet_identity_pk_${pingNodeId}`);
  return {
    binding,
    fields: {
      node_id: pingNodeId,
      challenge,
      signature: formattedSignature,
      ping_pubkey: pingPkHex,
      ...(pingCert ? { ping_delegation_cert: pingCert } : {}),
      ...(identityPk ? { identity_pubkey: identityPk } : {}),
    },
  };
}

// Signs `challenge` once and posts it to `urls` (postHedged), every request capped at RESPONSE_MS within `deadline`,
// counted after the Keychain read and the signing.
async function answerChallenge(pingNodeId, challenge, urls, deadline, evidence) {
  try {
    if (!isSignableChallenge(challenge)) {
      logger.warn('[Push] ping refused: not a ping challenge');
      return outcome('refused', { reason: 'not_a_challenge' });
    }
    const targets = urls.filter(Boolean);
    if (targets.length === 0) {
      logger.warn('[Push] ping refused: the answer would leave the genesis nodes');
      return outcome('refused', { reason: 'not_genesis' });
    }
    const signed = await signedAnswer(pingNodeId, challenge);
    if (!signed) {
      // PATH A is the only signing path: no fallback. The node is NOT penalised for a single missed ping.
      logger.warn('[Push] Dilithium3 ping key unavailable — ping missed (will retry next window)');
      return outcome('nokey');
    }
    // Only a self-attestation names its epoch; a stamp of an older node carries no record.
    const anchorEpoch = anchorEpochOf(challenge);
    const report = anchorEpoch !== null ? await receiptsWithin(Receipts.reportFor(pingNodeId, anchorEpoch)) : null;
    const post = async (apiUrl) => {
      const timeoutMs = Math.min(RESPONSE_MS, deadline - Date.now());
      if (timeoutMs < SELF_ATTEST_MIN_POST_MS) return outcome('network');
      const body = { ...signed.fields, ...evidenceFields(evidence, Math.floor(Date.now() / 1000), report) };
      try {
        const response = await fetchWithTimeout(`${apiUrl}/api/v1/light-node/ping-response`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }, timeoutMs);
        // An owner that sheds load names its wait (Retry-After); any other server error says nothing of the answer.
        const shed = retryAfterOf(response);
        if ((response.status === 503 || response.status === 429) && shed) {
          return outcome('rate', { posted: true, reached: true, retryAfter: shed, reason: 'rate_limited' });
        }
        if (Number.isInteger(response.status) && response.status >= 500) return outcome('network', { posted: true });
        return replyOutcome(await response.json());
      } catch (_) {
        return outcome('network', { posted: true });
      }
    };
    const prev = await readHold(pingNodeId);
    const retrying = !!prev && prev.kind === 'retry' && Number.isSafeInteger(prev.tries) && prev.tries > 0;
    const out = await postHedged(targets, post, deadline, retrying ? HEDGE_RETRY_MS : HEDGE_MS);
    if (out.kind === 'ok') {
      logger.log('[Push] ✅ Ping response sent (Dilithium3 delegation, quantum-safe)');
      // Only a polling device needs its next ping time; a pushed one is woken. Not awaited: a background wake spends its
      // time on the proof.
      if (signed.binding && signed.binding.pushType === PushType.POLLING) getNextPingTime().catch(() => {});
    } else if (out.kind === 'superseded' && signed.binding) {
      // A later binding replaced this device's, or it was withdrawn (node batch B3): this device stops waking and gives
      // its push token back, as forgetIfReplaced does (MN-R2-04). Only the binding this reply was signed for ends: one
      // made since (Use this device) is not judged by it.
      const now = await localBinding(pingNodeId);
      if (now && now.seq === signed.binding.seq) await teardownLightNode();
    } else if (out.reached) {
      logger.warn('[Push] Dilithium3 delegation ping not taken:', out.kind, out.reason || '');
    }
    return out;
  } catch (error) {
    logger.warn('[Push] Error responding to challenge:', error.message || error);
    return outcome('network');
  }
}

const SELF_ATTEST_HOLD_KEY = 'qnet_self_attest_hold';
// From this height a block is never stamped ahead of the wall clock, so an epoch cannot end sooner than
// one second per block still left in it.
const WALL_CLOCK_BOUND_HEIGHT = 1339200;

// No hold outlasts this: the node that answered the height may lag the chain, and a device clock can move.
const SELF_ATTEST_MAX_HOLD_MS = 2 * 3600000;

// The shard's commit opens this many blocks before its epoch's end (node light_commit_window): an answer after it counts
// for nothing. Every ping and answer belongs to its own epoch: from GAP_MARGIN_BLOCKS before the commit (the time an
// answer takes to reach an owner) to the epoch's end the app answers nothing, and nothing is moved to the next epoch,
// which its own pushes and the app's own answers in it answer.
export const COMMIT_WINDOW_BLOCKS = 150;
export const GAP_MARGIN_BLOCKS = 5;

/** Whether an answer at `height` would come inside its epoch's closing gap. */
export function inAnswerGap(height) {
  return Number.isSafeInteger(height) && height >= 0
    && height % EPOCH_BLOCKS >= EPOCH_BLOCKS - COMMIT_WINDOW_BLOCKS - GAP_MARGIN_BLOCKS;
}

// After a failure that may pass (no connection, a timeout, a server error, a rate limit, a stale anchor) the next try
// comes 1, 2 and 4 minutes later, each up to a fifth sooner, then every 2.5 to 5 minutes (drawn per device and per try,
// so devices that failed together do not come back together), and never sooner than a rate limit asks; until the epoch
// is counted, and only before its commit: the last try comes RETRY_GAP_LEAD_MS before the gap at the latest
// (lastTryAt), and none is set past it. After RETRY_MAX_TRIES failed tries in a run no wake is set for the next one: the
// network's own pushes, the epoch's backup wake, the periodic fetch and an open of the app still answer, so a long
// outage of the owners is never met by every device's alarms.
export const RETRY_FIRST_MS = 60000;
export const RETRY_MAX_MS = 5 * 60000;
export const RETRY_MAX_TRIES = 16;
export function retryWaitMs(tries, random = Math.random) {
  if (tries > 3) return Math.round(RETRY_MAX_MS * (1 - 0.5 * random()));
  const base = Math.min(RETRY_FIRST_MS * 2 ** Math.max(0, tries - 1), RETRY_MAX_MS);
  return Math.round(base * (1 - 0.2 * random()));
}

// The seconds an owner that sheds load asks to wait (the Retry-After header, in seconds), or 0.
function retryAfterOf(response) {
  try {
    const v = response && response.headers && typeof response.headers.get === 'function' ? response.headers.get('Retry-After') : null;
    const n = /^\s*\d{1,6}\s*$/.test(String(v || '')) ? Number(v) : 0;
    return n > 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

// A rate limit's wait that would pass the epoch's last try is cut to a time drawn per device within this much before it:
// an answer of this epoch belongs to it, and the devices told to wait do not all come back at one instant.
export const LAST_TRY_SPREAD_MS = 5 * 60000;

// A refusal for good waits for the next push or an open of the app; an open answers again once this long has passed
// since it, so switching between apps sends nothing new.
const REFUSED_REOPEN_MS = 60000;

/**
 * The self-attest hold: { nodeId, at, until, kind, epoch, tries, reason }, `kind` one of
 * - 'counted': this epoch is counted here; nothing until the epoch can have ended, counted from when the height was read
 *   and only where that bound holds;
 * - 'retry': a failure that may pass; the next try at `until` (retryWaitMs);
 * - 'refused': an owner refused the answer for good, or no ping key is here (`reason` 'nokey'); only the next push or an
 *   open of the app answers again.
 * Every kind lasts at most SELF_ATTEST_MAX_HOLD_MS; a hold written before the clock moved back is void, and so is one an
 * older build wrote (its failure back-off of 30 minutes to 2 hours, and its wait past the closing gap for the next epoch,
 * are gone). A closed epoch holds nothing (closeEpoch).
 */
async function readHold(nodeId) {
  try {
    const h = JSON.parse((await AsyncStorage.getItem(SELF_ATTEST_HOLD_KEY)) || 'null');
    if (!h || h.nodeId !== nodeId || !Number.isFinite(h.until)) return null;
    if (!h.kind) return h.failures > 0 ? null : { ...h, kind: 'counted' };
    return h;
  } catch (_) {
    return null;
  }
}

const writeHold = (hold) => AsyncStorage.setItem(SELF_ATTEST_HOLD_KEY, JSON.stringify({ at: Date.now(), tries: 0, ...hold }))
  .catch(() => {});

// Whether `hold` keeps a round that is not forced silent. A delivered push with an anchor goes through every hold (a
// pushed anchor names its epoch, so the epoch check alone decides whether it was counted); a push without an anchor
// through a failure's and a refusal's; an open of the app through a refusal's.
function holdKeeps(hold, { pushed, opened, anchorEpoch }, now) {
  if (!hold || now >= hold.until || now < (hold.at || 0) || hold.until - now > SELF_ATTEST_MAX_HOLD_MS) return false;
  switch (hold.kind) {
    case 'counted': return !(pushed && anchorEpoch !== null);
    case 'retry': return !pushed;
    case 'refused': return !pushed && !(opened && now - (hold.at || 0) >= REFUSED_REOPEN_MS);
    default: return false;
  }
}

// When an epoch can have ended at the earliest, seen from `height` read at `readAt` (ms); null below the bound.
function epochEndBound(height, readAt) {
  return Number.isSafeInteger(height) && height >= WALL_CLOCK_BOUND_HEIGHT
    ? readAt + Math.min((EPOCH_BLOCKS - (height % EPOCH_BLOCKS)) * 1000, SELF_ATTEST_MAX_HOLD_MS) : null;
}

// The last try of the epoch at `height` (read at `readAt`, ms) comes this long before its closing gap at the latest.
export const RETRY_GAP_LEAD_MS = 10000;

// The latest time a try of the epoch at `height` still answers before its closing gap: the gap's first block, at one
// block a second, less RETRY_GAP_LEAD_MS; null below the bound or for no height.
function lastTryAt(height, readAt) {
  if (!Number.isSafeInteger(height) || height < WALL_CLOCK_BOUND_HEIGHT) return null;
  const blocks = EPOCH_BLOCKS - COMMIT_WINDOW_BLOCKS - GAP_MARGIN_BLOCKS - (height % EPOCH_BLOCKS);
  return readAt + blocks * 1000 - RETRY_GAP_LEAD_MS;
}

// A background wake gets about 30 s on iOS (25 s for a push handled by React Native Firebase). Each wake sets
// one deadline inside that for everything it sends; a self-attest round also stays within its own budget,
// each request capped inside it.
const WAKE_FETCH_MS = 25000;
const WAKE_PUSH_MS = 22000;
const RESPONSE_MS = 8000;
const SELF_ATTEST_BUDGET_MS = 20000;
const SELF_ATTEST_CALL_MS = 6000;
const SELF_ATTEST_MIN_POST_MS = 2000; // no answer is started with less time than this left
// A pushed anchor that went out and reached no owner at all (the network not up yet after the wake) goes again after
// these pauses, while the wake's deadline leaves room; an owner's answer, a refusal included, ends the tries.
const PUSH_RETRY_MS = [2000, 4000];

// The anchor of a per-epoch push (light-node-messages section 5.8): a block height and its 64-hex hash.
const ANCHOR_RE = /^(\d{1,15}):([0-9a-f]{64})$/;
// When this device last answered: { epoch, at } (ms). The Node tab shows the time.
export const LAST_ANSWER_KEY = 'qnet_last_self_attest_at';
// The chain's epoch as this device last read it, credited or not: { epoch, at } (ms). The key rotation falls due by the
// chain's epoch: a device whose replies the node refuses (a rotation 30 days overdue) never answers into a later epoch,
// and only the rotation ends that (MN-R2-01).
export const CHAIN_EPOCH_KEY = 'qnet_chain_epoch_seen';

// An epoch lasts at least four hours (14,400 blocks, none stamped ahead of the wall clock). A read of the chain's epoch
// (one genesis node's height, or a pushed anchor, neither signed) is taken only within reach of the last one known: one
// epoch more, plus one for every four hours since that was written. A lower read replaces the known epoch once reads
// have said less for a day. So no single wrong value, ahead or behind, pins when the key rotation falls due (MN-R4-06).
const EPOCH_MS = 14400 * 1000;
export const CHAIN_EPOCH_LOWER_MS = 24 * 3600 * 1000;

export async function noteChainEpoch(epoch) {
  try {
    if (!Number.isSafeInteger(epoch) || epoch < 0) return;
    const now = Date.now();
    const write = (v) => AsyncStorage.setItem(CHAIN_EPOCH_KEY, JSON.stringify(v));
    const prev = JSON.parse((await AsyncStorage.getItem(CHAIN_EPOCH_KEY)) || 'null');
    const known = prev && Number.isSafeInteger(prev.epoch) && Number.isSafeInteger(prev.at) ? prev : null;
    // Nothing known, or known from a clock that was set back past it since.
    if (!known || known.at > now) {
      await write({ epoch, at: now });
      return;
    }
    if (epoch === known.epoch) {
      if (known.lowerSince) await write({ epoch, at: known.at });
      return;
    }
    if (epoch > known.epoch) {
      if (epoch <= known.epoch + 1 + Math.floor((now - known.at) / EPOCH_MS)) await write({ epoch, at: now });
      return;
    }
    const since = Number.isSafeInteger(known.lowerSince) && known.lowerSince <= now ? known.lowerSince : now;
    await write(now - since >= CHAIN_EPOCH_LOWER_MS ? { epoch, at: now } : { ...known, lowerSince: since });
  } catch (_) { /* the next height read writes it */ }
}

// The latest epoch this device knows the chain reached: the chain's as last read, or the last one it answered in.
export async function knownChainEpoch() {
  let best = null;
  try {
    const [[, seen], [, answered]] = await AsyncStorage.multiGet([CHAIN_EPOCH_KEY, LAST_ANSWER_KEY]);
    for (const raw of [seen, answered]) {
      const e = JSON.parse(raw || 'null');
      if (e && Number.isSafeInteger(e.epoch) && e.epoch >= 0 && (best === null || e.epoch > best)) best = e.epoch;
    }
  } catch (_) { /* nothing known */ }
  return best;
}

/**
 * PULL self-attestation: sign a fresh same-epoch block hash and submit through the standard
 * ping-response endpoint (challenge = "selfattest:{height}:{hash}"). Proves this-epoch liveness
 * on ANY wakeup (push, background fetch, app open or return) — no dependency on FCM delivery.
 * Deduped per epoch locally; the node dedupes per epoch too. Rounds are per node: concurrent callers (a push
 * launch also mounts the app) share one, each within its own deadline. Behind a round that did not attest a caller goes
 * on only with what that round lacked: a forced one (Offline, "I'm back") behind any other, a pushed one behind a round
 * that a hold kept silent or that had no anchor to answer, an open of the app behind a round a hold kept silent. A pushed
 * anchor does not wait behind a lesser round that has none: it starts its own at once.
 * `anchor` ("{h}:{hash}", from a per-epoch push) is answered as it is; the device reads a fresh block only when the
 * network refuses it as stale or could not be reached. `how`: { pushed, opened, evidence }: `pushed` when the network
 * delivered this round's push or challenge, which is answered at once whatever hold a failure or refusal left (only an
 * epoch this device already attested skips it); `opened` when the user opened the app or returned to it; `evidence` the
 * push's (pushEvidence), sent with the answer. No answer goes inside an epoch's closing gap (inAnswerGap): that epoch is
 * closed (closeEpoch), and nothing is sent, set or held for the next one.
 */
export async function selfAttestIfNeeded(nodeId, force = false, wakeDeadline = undefined, anchor = null, how = {}) {
  const { pushed = false, opened = false, evidence = null } = how || {};
  const deadline = Math.min(Date.now() + SELF_ATTEST_BUDGET_MS, wakeDeadline || Infinity);
  const id = nodeId || await AsyncStorage.getItem('qnet_ping_node_id');
  if (!id) return false;
  const pushedAnchor = typeof anchor === 'string' && ANCHOR_RE.test(anchor) ? anchor : null;
  const level = force ? 3 : (pushed ? 2 : (opened ? 1 : 0));
  for (let running = _selfAttestRounds.get(id); running; running = _selfAttestRounds.get(id)) {
    // A pushed anchor needs no read of the chain: it goes now, not behind a round still reading one (a launch for the
    // push starts such a round too); the ping lane keeps their POSTs one at a time.
    if (pushedAnchor && !running.anchored && running.level < level) break;
    const r = await untilDeadline(running.promise, deadline, null);
    if (r === null) return false; // this caller's deadline came first; the round runs on
    if (r || level <= running.level) return r;
    if (!running.held && level < 3 && !(level === 2 && pushedAnchor)) return r;
  }
  const round = { level, anchored: !!pushedAnchor, held: false, promise: null };
  round.promise = runSelfAttest(id, { force, pushed, opened, evidence }, deadline, pushedAnchor)
    .then((r) => {
      round.held = r === HELD;
      return r === true;
    })
    .finally(() => { if (_selfAttestRounds.get(id) === round) _selfAttestRounds.delete(id); });
  _selfAttestRounds.set(id, round);
  return round.promise;
}

// A round a hold kept silent: it sent nothing.
const HELD = 'held';

async function runSelfAttest(nodeId, { force, pushed, opened, evidence }, deadline, pushedAnchor) {
  const cap = () => Math.min(SELF_ATTEST_CALL_MS, deadline - Date.now());
  let pingNodeId = null;
  try {
    pingNodeId = nodeId || await AsyncStorage.getItem('qnet_ping_node_id');
    if (!pingNodeId) return false;
    // Before any request or hold: a round the rule refuses leaves nothing behind for the open app's first round.
    if (!(await mayAnswer())) return false;
    const pushedParts = pushedAnchor ? ANCHOR_RE.exec(pushedAnchor) : null;
    const anchorEpoch = pushedParts ? Math.floor(Number(pushedParts[1]) / EPOCH_BLOCKS) : null;
    // A forced round reads no hold: inside the gap its own read of the chain finds the epoch closed.
    if (!force && holdKeeps(await readHold(pingNodeId), { pushed, opened, anchorEpoch }, Date.now())) return HELD;
    // Sends `challenge` to the nodes that OWN this shard, not to whichever node answered the height query.
    // The owner is what records eligibility and commits the epoch bitmap; anywhere else the answer
    // has to be relayed to it, and the relay carries the signature without the ping key it was signed
    // with — so a device that rotated its key (every reinstall does) attests into a void. All three
    // owners are asked (postHedged), which is also what makes one owner being down survivable; `fallbackUrl`, a
    // node known to answer, comes last.
    const answer = (challenge, fallbackUrl) => {
      const owners = lightShardOwnerUrls(pingNodeId);
      const urls = fallbackUrl && !owners.includes(fallbackUrl) ? [...owners, fallbackUrl] : owners;
      return answerInLane(pingNodeId, challenge, urls, deadline, evidence);
    };
    const last = await AsyncStorage.getItem('qnet_last_self_attest_epoch');
    // A pushed anchor: the network wakes only a node it records and links to this device, so no status read first.
    // One of an epoch before the last this device attested (a push the provider held while the device was away) is
    // left for the fresh read below, so no refused answer spends the wake's deadline. One that reached no owner at all
    // goes again after a short pause (PUSH_RETRY_MS); one refused as stale, or still unanswered, falls to the fresh read.
    if (pushedParts) {
      const height = Number(pushedParts[1]);
      const hash = pushedParts[2];
      const epoch = anchorEpoch;
      const lastEpoch = last !== null ? parseInt(last, 10) : null;
      await noteChainEpoch(epoch);
      // The tip as the push left (two above its anchor) plus the time since this device took it, at one block a second:
      // never ahead of the chain's tip. A push held on its way makes the tip later still, which the owner's reply says.
      const tookAt = evidence && Number.isSafeInteger(evidence.receivedAt) ? evidence.receivedAt * 1000 : Date.now();
      const tip = height + 2 + Math.max(0, Math.floor((Date.now() - tookAt) / 1000));
      // For the holds only, also the time since the network sent it (its clock): a push held on its way then holds no
      // answer of the next epoch back. A later tip only shortens a hold; whether the epoch is closing reads `tip` alone.
      const sentAt = evidence && Number.isSafeInteger(evidence.sentAt) ? evidence.sentAt * 1000 : null;
      const holdTip = sentAt === null ? tip : Math.max(tip, height + 2 + Math.max(0, Math.floor((Date.now() - sentAt) / 1000)));
      if (!force && lastEpoch === epoch) {
        await writeHold({ nodeId: pingNodeId, kind: 'counted', epoch, until: epochEndBound(holdTip, Date.now()) || 0 });
        await armEpochBackup(pingNodeId, tip, Date.now(), true);
        return false;
      }
      const sameEpoch = Math.floor(tip / EPOCH_BLOCKS) === epoch;
      // A push that came inside its epoch's closing gap: that epoch is closed, and the push is answered for no epoch.
      if (sameEpoch && inAnswerGap(tip)) return await closeEpoch(pingNodeId, epoch);
      if (sameEpoch && (force || lastEpoch === null || !(epoch < lastEpoch))) {
        for (let pass = 0; ; pass++) {
          const o = await answer(`selfattest:${height}:${hash}`, null);
          if (o.kind === 'ok') return await settleRound(pingNodeId, epoch, tip, o, Date.now(), holdTip);
          if (o.kind === 'closed') return await closeEpoch(pingNodeId, epoch);
          if (o.kind === 'superseded' || o.kind === 'held') return false;
          if (o.kind !== 'stale' && o.kind !== 'network') return await settleRound(pingNodeId, epoch, tip, o, Date.now(), holdTip);
          const wait = PUSH_RETRY_MS[pass];
          if (o.kind !== 'network' || !o.posted || o.reached || wait === undefined
              || deadline - Date.now() < wait + SELF_ATTEST_MIN_POST_MS) break;
          await pause(wait);
        }
      }
    }
    const apiUrl = genesisNode();
    // A rate limit or a reply with no height is a failure that may pass: the round settles with it (the next try at the
    // wait a limit names, recorded in the hold), never ends with nothing set (F10).
    const hr = await readNode(`${apiUrl}/api/v1/height`, cap());
    const readAt = Date.now();
    if (hr.failed) return await settleRound(pingNodeId, null, null, hr.failed, readAt);
    const { height } = hr.body;
    if (!Number.isSafeInteger(height) || height < 0) {
      return await settleRound(pingNodeId, null, null, outcome('network', { reason: 'no_height' }), readAt);
    }
    if (height < 3) return false;
    const epoch = Math.floor(height / EPOCH_BLOCKS);
    await noteChainEpoch(epoch);
    // The record of the pushes this device takes covers the epochs after the one read, where none was kept.
    await receiptsWithin(knownChainEpoch().then((known) => Receipts.noteEpochSeen(pingNodeId, Math.max(epoch, known || 0))));
    // A pushed anchor of an epoch the chain has left came after its commit: so its record says, before this answer of the
    // chain's epoch reports it.
    if (anchorEpoch !== null && anchorEpoch < epoch) await receiptsWithin(Receipts.noteOutcome(pingNodeId, anchorEpoch, 'after_commit'));
    // force (Offline, "I'm back"): re-attest even if already done this epoch.
    if (!force && last !== null && parseInt(last, 10) === epoch) {
      await writeHold({ nodeId: pingNodeId, kind: 'counted', epoch, until: epochEndBound(height, readAt) || 0 });
      await armEpochBackup(pingNodeId, height, readAt, true);
      return false;
    }
    if (inAnswerGap(height)) return await closeEpoch(pingNodeId, epoch);
    // Registration gate: a ping is accepted only once the node's key is committed on the chain. Skipped only on a
    // definite "not on the chain"; an older node without the field, or no answer, still gets the attestation, so a
    // live node never misses its window. Asked only until an owner took an answer of this binding (`last`), which says
    // the node is on the chain: a wake after that reads the height and one block only.
    if (last === null && await onChainAt(apiUrl, pingNodeId, cap()) === false) return false;
    // Canonical hash of block `anchor` = previous_hash of block anchor+1 (the chain link); never a block of the epoch
    // before, which no owner takes.
    const anchor = Math.max(height - 2, epoch * EPOCH_BLOCKS);
    const br = await readNode(`${apiUrl}/api/v1/microblock/${anchor + 1}`, cap());
    if (br.failed) return await settleRound(pingNodeId, epoch, height, br.failed, readAt);
    // Server-supplied bytes: reject any non-integer / out-of-[0,255] element so a
    // malformed array can't produce a garbage hash (e.g. "nan") or a bad challenge.
    const phBytes = br.body.previous_hash;
    if (!Array.isArray(phBytes) || !phBytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) {
      return await settleRound(pingNodeId, epoch, height, outcome('stale'), readAt);
    }
    const hash = phBytes.map(b => b.toString(16).padStart(2, '0')).join('');
    const o = await answer(`selfattest:${anchor}:${hash}`, apiUrl);
    if (o.kind === 'closed') return await closeEpoch(pingNodeId, epoch);
    return await settleRound(pingNodeId, epoch, height, o, readAt);
  } catch (error) {
    logger.warn('[SelfAttest] failed:', error.message || error);
    // No answer came (no connection, a timeout, an unreadable reply): the next try comes soon.
    if (pingNodeId) await settleRound(pingNodeId, null, null, outcome('network'), Date.now());
    return false;
  }
}

// What a round that answered leaves behind (holdKeeps): counted, a refusal for good, or the next try soon, with the
// reason of the failure it was (`reason`: 'rate_limited', 'network', 'no_height', 'stale', a refusal's own). `holdHeight`:
// the tip the holds end by (a push's later estimate), `height` the one the last try and the epoch's backup are set by.
async function settleRound(nodeId, epoch, height, o, readAt, holdHeight = height) {
  if (o.kind === 'ok') {
    await AsyncStorage.multiSet([
      ['qnet_last_self_attest_epoch', String(epoch)],
      [LAST_ANSWER_KEY, JSON.stringify({ epoch, at: Date.now() })],
    ]);
    logger.log('[SelfAttest] ✅ Attested for epoch', epoch);
    await writeHold({ nodeId, kind: 'counted', epoch, until: epochEndBound(holdHeight, readAt) || 0 });
    await cancelAnswerRetry();
    await Receipts.noteAnswered(nodeId, epoch);
    await armEpochBackup(nodeId, height, readAt, true);
    return true;
  }
  if (o.kind === 'superseded' || o.kind === 'held') return false;
  // A round that ran beside another (a push beside a launch's) never undoes the count that one settled for its epoch.
  const prev = await readHold(nodeId);
  if (prev && prev.kind === 'counted' && prev.until > Date.now() && (epoch === null || prev.epoch === epoch)) return false;
  if (o.kind === 'refused' || o.kind === 'nokey') {
    await writeHold({
      nodeId, kind: 'refused', epoch, reason: o.kind === 'nokey' ? 'nokey' : (o.reason || null),
      until: epochEndBound(holdHeight, readAt) || Date.now() + SELF_ATTEST_MAX_HOLD_MS,
    });
    return false;
  }
  // A failure before the height was read belongs to the run of failures before it.
  const run = !!prev && prev.kind === 'retry' && (epoch === null || prev.epoch === epoch) && Number.isSafeInteger(prev.tries);
  const tries = run ? prev.tries + 1 : 1;
  const now = Date.now();
  // Before the epoch's commit only: the last try just before its gap, also when a rate limit asks for longer.
  const last = lastTryAt(height, readAt);
  let asked = now + (o.retryAfter || 0) * 1000;
  if (last !== null && asked > last) asked = Math.max(now, last - Math.round(Math.random() * Math.min(LAST_TRY_SPREAD_MS, Math.max(0, last - now))));
  let until = Math.max(now + retryWaitMs(tries), asked);
  if (last !== null && until > last) until = Math.max(last, asked);
  const wake = tries <= RETRY_MAX_TRIES && (last === null || until <= last);
  const reason = o.reason || o.kind;
  await writeHold({ nodeId, kind: 'retry', epoch: epoch === null && run ? prev.epoch : epoch, tries, until, wake, reason });
  logger.warn('[SelfAttest] not answered:', reason, 'next try in', Math.round((until - now) / 1000), 's');
  if (wake) scheduleAnswerAt(nodeId, until);
  await armEpochBackup(nodeId, height, readAt, false);
  return false;
}

// The last epoch this device found past its commit (closeEpoch): { nodeId, epoch }. A mark of what came of a push
// (pushOutcome), never a hold: nothing waits on it.
const CLOSED_EPOCH_KEY = 'qnet_closed_epoch';

/**
 * `epoch` is past its commit (the closing gap, or an owner's word): nothing is answered for it, and nothing is set or
 * held for the next one, which its own pushes and the app's own answers in it answer. A try a failure set is dropped.
 * Never the counted hold.
 */
async function closeEpoch(nodeId, epoch) {
  try { await AsyncStorage.setItem(CLOSED_EPOCH_KEY, JSON.stringify({ nodeId, epoch })); } catch (_) { /* a mark only */ }
  await cancelAnswerRetry();
  logger.log('[SelfAttest] epoch', epoch, 'is closed: nothing is answered for it');
  return false;
}

// The next answer's time, where the system can wake for it: a timer while the app is in front, and on Android a one-shot
// alarm (also with the app in the background or its process ended; AnswerGate still decides). iOS has no such wake: the
// next push, background fetch or open answers then.
export const ANSWER_RETRY_TASK = 'qnet-answer-retry';
let _answerTimer = null;

function scheduleAnswerAt(nodeId, until) {
  const delay = Math.max(1000, until - Date.now());
  clearTimeout(_answerTimer);
  _answerTimer = null;
  if (AppState.currentState === 'active') {
    _answerTimer = setTimeout(() => {
      _answerTimer = null;
      if (AppState.currentState === 'active') selfAttestIfNeeded(nodeId).catch(() => {});
    }, delay);
    if (_answerTimer && typeof _answerTimer.unref === 'function') _answerTimer.unref();
  }
  if (Platform.OS === 'android') {
    BackgroundFetch.scheduleTask({
      taskId: ANSWER_RETRY_TASK, delay, periodic: false, forceAlarmManager: true, stopOnTerminate: false, enableHeadless: true,
    }).catch(() => { /* the next push, fetch or open answers */ });
  }
}

async function cancelAnswerRetry() {
  clearTimeout(_answerTimer);
  _answerTimer = null;
  if (Platform.OS === 'android') {
    try { await BackgroundFetch.stop(ANSWER_RETRY_TASK); } catch (_) { /* none was set */ }
  }
}

// Android: one backup wake in every epoch, EPOCH_BACKUP_LEAD_BLOCKS before its closing gap, a one-shot alarm the system
// delivers in its battery saving too (headless, as the periodic fetch). It answers by itself only while that epoch is
// not counted here, with a block of that epoch and before its commit: the answer rule and the holds decide, as for
// every wake, so a counted epoch costs it no request, and it carries nothing from one epoch to another. Armed by a round
// that counted an epoch (or found it counted) for the next epoch, and by a failure for the epoch read while its backup
// is still ahead; a refusal for good or a closed epoch arms none (the next push or open answers then). iOS has no such
// wake (its periodic fetch and the pushes answer there).
export const EPOCH_BACKUP_TASK = 'qnet-epoch-backup';
export const EPOCH_BACKUP_LEAD_BLOCKS = 1800;
const EPOCH_BACKUP_KEY = 'qnet_epoch_backup';
// A backup closer than this is not set: the epoch is answered by the round running now, or by its retries.
const EPOCH_BACKUP_MIN_MS = 60000;

/** When the backup wake of the epoch at `height` (read at `readAt`, ms), or of the next one, is due; null below the bound. */
export function epochBackupAt(height, readAt, next = false) {
  if (!Number.isSafeInteger(height) || height < WALL_CLOCK_BOUND_HEIGHT) return null;
  const point = EPOCH_BLOCKS - COMMIT_WINDOW_BLOCKS - GAP_MARGIN_BLOCKS - EPOCH_BACKUP_LEAD_BLOCKS;
  return readAt + ((next ? EPOCH_BLOCKS : 0) + point - (height % EPOCH_BLOCKS)) * 1000;
}

async function armEpochBackup(nodeId, height, readAt, counted) {
  if (Platform.OS !== 'android' || !Number.isSafeInteger(height)) return;
  try {
    const target = Math.floor(height / EPOCH_BLOCKS) + (counted ? 1 : 0);
    const at = epochBackupAt(height, readAt, counted);
    if (at === null || at < Date.now() + EPOCH_BACKUP_MIN_MS) return;
    const prev = JSON.parse((await AsyncStorage.getItem(EPOCH_BACKUP_KEY)) || 'null');
    if (prev && prev.nodeId === nodeId && prev.epoch === target && prev.at > Date.now()) return;
    try { await BackgroundFetch.stop(EPOCH_BACKUP_TASK); } catch (_) { /* none was set */ }
    await BackgroundFetch.scheduleTask({
      taskId: EPOCH_BACKUP_TASK, delay: Math.max(EPOCH_BACKUP_MIN_MS, at - Date.now()), periodic: false,
      forceAlarmManager: true, stopOnTerminate: false, enableHeadless: true,
    });
    await AsyncStorage.setItem(EPOCH_BACKUP_KEY, JSON.stringify({ nodeId, epoch: target, at }));
  } catch (_) { /* the next round arms it */ }
}

// One GET of a genesis node within `ms`: { body } for a JSON answer, or { failed } with the outcome a round settles
// with: 'rate' with the wait a rate limit names (a 200 that names `retry_after_seconds`, a 429, or a 503 with a
// Retry-After header), 'network' for no answer, another server error or a body that is not a JSON object.
async function readNode(url, ms) {
  let r;
  try {
    r = await fetchWithTimeout(url, {}, ms);
  } catch (_) {
    return { failed: outcome('network', { reason: 'network' }) };
  }
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  const plain = !!body && typeof body === 'object' && !Array.isArray(body);
  const wait = plain ? Number(body.retry_after_seconds) : NaN;
  const named = Number.isSafeInteger(wait) && wait > 0;
  const shed = retryAfterOf(r);
  if (r.status === 429 || (r.status === 503 && shed) || (plain && body.success === false && named)) {
    return { failed: outcome('rate', { retryAfter: named ? wait : shed, reason: 'rate_limited' }) };
  }
  if (!plain || (Number.isInteger(r.status) && r.status >= 500)) return { failed: outcome('network', { reason: 'network' }) };
  return { body };
}

/**
 * Fully tear down the light-node attestation identity + background task.
 * MUST be called on wallet delete: otherwise the scheduled `qnet-ping-check`, `qnet-answer-retry` and `qnet-epoch-backup`
 * wakes, the periodic background-fetch handler, and the surviving ping key keep the "deleted" device attesting (and
 * earning eligibility) for another epoch or two, and leave the Dilithium ping secret key on device.
 * The push token goes too (`keepToken` only for the binding that replaces this one): a device with no node linked
 * holds none. Firebase is asked only when a binding or a token was kept here, so a device that never linked a node
 * never reaches it, and is waited for at most TOKEN_DROP_WAIT_MS (the call runs on: a slow network never holds up a
 * wallet's deletion). `forgetDevice` (wallet delete and erase): this install's device key goes too.
 */
export async function teardownLightNode({ keepToken = false, forgetDevice = false } = {}) {
  try {
    const [[, pingNodeId], [, info], [, sent]] = await AsyncStorage.multiGet(
      ['qnet_ping_node_id', 'qnet_light_node_info', 'qnet_last_sent_fcm_token']);
    if (!keepToken && (pingNodeId || info || sent)) await untilDeadline(dropPushToken(), Date.now() + TOKEN_DROP_WAIT_MS, null);
    if (forgetDevice) await forgetKeys().catch(() => {});
    // Stop the precise scheduled wake, the next answer's wake, the epoch's backup wake AND the periodic configured fetch
    // (all call selfAttest).
    clearTimeout(_answerTimer);
    _answerTimer = null;
    try { await BackgroundFetch.stop('qnet-ping-check'); } catch (e) {}
    try { await BackgroundFetch.stop(ANSWER_RETRY_TASK); } catch (e) {}
    try { await BackgroundFetch.stop(EPOCH_BACKUP_TASK); } catch (e) {}
    try { await BackgroundFetch.stop(); } catch (e) {}
    // Wipe the Dilithium ping signing key (Keychain secret + its public half and certificate) — this node's
    // and any an interrupted earlier setup left behind: a phone runs one light node at a time.
    try {
      const Keychain = require('react-native-keychain');
      let services = [];
      // Listing only; items behind Face ID are skipped rather than prompted for (ping keys have no such lock).
      try { services = (await Keychain.getAllGenericPasswordServices({ skipUIAuth: true })) || []; } catch (_) { services = []; }
      const own = pingNodeId ? [`qnet_ping_sk_${pingNodeId}`] : [];
      for (const service of new Set([...own, ...services.filter((s) => String(s).startsWith('qnet_ping_sk_'))])) {
        try { await Keychain.resetGenericPassword({ service }); } catch (_) {}
      }
    } catch (e) {}
    const pingKeys = (await AsyncStorage.getAllKeys())
      .filter((k) => k.startsWith('qnet_ping_dilithium_pk_') || k.startsWith('qnet_ping_cert_'));
    if (pingKeys.length > 0) await AsyncStorage.multiRemove(pingKeys);
    await AsyncStorage.multiRemove([
      'qnet_light_node_info',
      'qnet_ping_node_id',
      'qnet_last_self_attest_epoch',
      LAST_ANSWER_KEY,
      CHAIN_EPOCH_KEY,
      SELF_ATTEST_HOLD_KEY,
      // A pending binding would be sent again, and the device schedule belongs to the binding that ends.
      LINK_PENDING_KEY,
      Enrolment.SCHEDULE_KEY,
      ENROL_AGAIN_KEY,
      CHECK_REFUSED_KEY,
      PUSH_READDRESS_KEY,
      CLOSED_EPOCH_KEY,
      EPOCH_BACKUP_KEY,
      Receipts.PUSH_RECEIPTS_KEY,
      ...(keepToken ? [] : ['qnet_last_sent_fcm_token', 'qnet_last_token_refresh_ts', 'qnet_needs_token_refresh']),
    ]);
    logger.log('[LightNode] teardown complete: attestation stopped, ping key wiped');
  } catch (error) {
    logger.warn('[LightNode] teardown failed:', error.message || error);
  }
}

export { BIND_SETTLE_MS };

/**
 * The network holds this device's binding no more, by the binding sequence two owners name alike (B, the status's
 * `bindingSeqAgreed`) and whether two say a device is bound (D, `deviceBoundAgreed`): a newer binding with a device bound
 * (B > seq, D true: another device answers for the node now), or no device bound at or past this binding (B >= seq,
 * D false: it was withdrawn, by this device, by the wallet key from anywhere, or a device that replaced this one stopped
 * since; MN-R2-04). This one stops waking and gives its push token back; nothing is sent. Owners refusing this device's
 * key decide nothing alone, nor does a status without B (contract 4). `seq`: the sequence of this device's binding when
 * the status was read; a binding made since then is not judged by it, nor one made less than BIND_SETTLE_MS ago, nor the
 * QNet Link sheet's binding while its record still sends it (the node takes it later). True when it did.
 */
export async function forgetIfReplaced(nodeId, status, seq = null) {
  const B = status && Number.isSafeInteger(status.bindingSeqAgreed) ? status.bindingSeqAgreed : null;
  const D = status ? status.deviceBoundAgreed : null;
  if (B === null || (D !== true && D !== false)) return false;
  const binding = await localBinding(nodeId);
  if (!binding || (seq !== null && binding.seq !== seq)) return false;
  if (!((B > binding.seq && D === true) || (B >= binding.seq && D === false))) return false;
  const age = binding.boundAt !== null ? Date.now() - binding.boundAt * 1000 : Infinity;
  if (age >= 0 && age < BIND_SETTLE_MS) return false;
  if (D === false) {
    const pending = await readLinkPending(nodeId);
    if (pending && !pending.expired && pending.T === binding.seq) return false;
  }
  await teardownLightNode();
  return true;
}

/**
 * A light-node record left by another wallet (a vault cleared as corrupted, an interrupted switch) must not
 * keep this phone answering for that node. `ownAddresses` are the current wallet's addresses — QNet, Solana,
 * and the QNet alias older builds derived from the Solana one.
 */
export async function teardownLightNodeIfForeign(ownAddresses) {
  try {
    const info = JSON.parse((await AsyncStorage.getItem('qnet_light_node_info')) || 'null');
    const owner = info && info.walletAddress;
    if (owner && !ownAddresses.filter(Boolean).includes(owner)) await stopLightNode();
  } catch (error) {
    logger.warn('[LightNode] foreign-record check failed:', error.message || error);
  }
}

/**
 * When a push was sent and when this device took it, for the answer (evidenceFields): { sentAt, receivedAt }, Unix
 * seconds; `sentAt` (the push's `sent_at`, the network's clock, a decimal string as every push field) null when the push
 * names none or a malformed one.
 */
export function pushEvidence(data, receivedAtMs = Date.now()) {
  const v = data ? data.sent_at : null;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : NaN);
  return { sentAt: Number.isSafeInteger(n) && n > 0 ? n : null, receivedAt: Math.floor(receivedAtMs / 1000) };
}

// The epoch of a push's anchor ("{h}:{hash}"), or null for a push without one.
function pushEpochOf(data) {
  const m = data && typeof data.anchor === 'string' ? ANCHOR_RE.exec(data.anchor) : null;
  return m ? Math.floor(Number(m[1]) / EPOCH_BLOCKS) : null;
}

/**
 * What came of a push of `epoch` once its wake is over (PushReceipts.APP_OUTCOMES): `before` the epoch this device had
 * attested when the push came, `force` an "I'm back", which answers again.
 */
async function pushOutcome(nodeId, epoch, before, force) {
  try {
    const last = await AsyncStorage.getItem('qnet_last_self_attest_epoch');
    if (last !== null && parseInt(last, 10) === epoch) {
      return !force && before !== null && parseInt(before, 10) === epoch ? 'already_counted' : 'answered';
    }
    const closed = JSON.parse((await AsyncStorage.getItem(CLOSED_EPOCH_KEY)) || 'null');
    const known = await knownChainEpoch();
    if ((closed && closed.nodeId === nodeId && closed.epoch >= epoch) || (Number.isSafeInteger(known) && known > epoch)) {
      return 'after_commit';
    }
    const hold = await readHold(nodeId);
    if (hold && hold.kind === 'refused' && hold.reason === 'nokey') return 'no_key';
  } catch (_) { /* no answer was taken */ }
  return 'answer_failed';
}

/**
 * Handle an incoming FCM data message. The network's pushes name no node (light-node-messages section
 * 5.8): `epoch` carries the anchor to answer, `wake` is "I'm back" from the web and answers even inside the local hold.
 * Older pushes (`ping_response` with a server stamp, or none of these) are still answered. Every push the network
 * delivered is answered at once, whatever hold a failure or a refusal left: each push of an owner's round, and of its
 * retry round, while this epoch is not attested here, and none once it is (selfAttestIfNeeded `pushed`); one that came
 * inside its epoch's closing gap is answered for no epoch, and nothing of it is moved to the next one. The answer carries
 * the push's evidence. Every push with an anchor goes into this device's record of the pushes it took, with what came of
 * it (PushReceipts), which the next answer reports.
 */
export async function handlePushMessage(data) {
  // Taken first: the time this device took the push, before anything else of the wake runs.
  const evidence = pushEvidence(data);
  // The last update of the old Android package runs no node, from its first wake on, opened or not (MN-R2-06).
  if (LEGACY_MOVE) {
    await teardownLightNode();
    return false;
  }
  let nodeId = null;
  try { nodeId = await AsyncStorage.getItem('qnet_ping_node_id'); } catch (_) { nodeId = null; }
  const epoch = pushEpochOf(data);
  const recorded = !!nodeId && epoch !== null;
  if (recorded) await receiptsWithin(Receipts.noteReceived(nodeId, epoch, evidence));
  // A light node is counted only while the wallet runs on its device: not opened since the device started, or swiped away
  // since it was last opened, it answers no push until it is opened again (AnswerGate).
  if (!(await mayAnswer())) {
    logger.log('[Push] the app is not open since the device started, or was swiped away: no answer until it is opened');
    if (recorded) await Receipts.noteHeld(nodeId, epoch);
    return false;
  }
  // The answer and a fallback self-attest share one deadline inside the 25 s a background push gets.
  const deadline = Date.now() + WAKE_PUSH_MS;
  if (data?.action === 'ping_response' && data?.challenge && data?.node_id) {
    logger.log('[Push] ping received');
    const ok = await respondToChallenge(data.node_id, data.challenge, data.response_url,
                                        Math.min(deadline, Date.now() + RESPONSE_MS), evidence);
    // A late (expired stamp) or refused ping still leaves this epoch provable by a self-attest.
    return ok || await selfAttestIfNeeded(data.node_id, false, deadline, null, { pushed: true, evidence });
  }
  // Any other wakeup still proves liveness for this epoch, for the node linked to this device.
  const force = data?.action === 'wake';
  let before = null;
  try { before = recorded ? await AsyncStorage.getItem('qnet_last_self_attest_epoch') : null; } catch (_) { before = null; }
  const ok = await selfAttestIfNeeded(undefined, force, deadline, data?.anchor, { pushed: true, evidence });
  if (recorded) await Receipts.noteOutcome(nodeId, epoch, await pushOutcome(nodeId, epoch, before, force));
  await refreshTokenIfOwed(deadline);
  await maintainDevice(deadline);
  return ok;
}

// No token refresh is started with less of a wake left than this.
const TOKEN_REFRESH_MIN_MS = 6000;

// A wake, any of them: a push target that changed while the app was closed (or within the hour after the binding) goes
// to the shard owners now, signed by the ping key, rather than at the next return to the app.
async function refreshTokenIfOwed(deadline) {
  try {
    if (deadline - Date.now() < TOKEN_REFRESH_MIN_MS) return;
    const nodeId = await AsyncStorage.getItem('qnet_ping_node_id');
    if (!nodeId || !(await isTokenRefreshNeeded())) return;
    await refreshFcmTokenOnServer(nodeId, { deadline });
  } catch (error) {
    logger.warn('[Push] token refresh from a wake failed:', (error && error.message) || error);
  }
}

// A background wake with the QNet Link sheet's binding still pending: one status read, and the binding goes
// again once the chain lists the node unbound (U3), all within the wake's deadline.
async function resendIfPending(deadline) {
  try {
    const nodeId = await AsyncStorage.getItem('qnet_ping_node_id');
    if (!nodeId || deadline - Date.now() < 12000 || !(await readLinkPending(nodeId))) return;
    // Signed with the ping key, which needs no user: an expired link's record is judged by whether the node holds this
    // device's key, never dropped for want of that answer (MN-R2-04).
    const status = await readNodeStatus(nodeId, { signStatus: signStatusWithPingKey, timeoutMs: 5000, deadline });
    await resendPendingBinding(nodeId, status, { deadline });
  } catch (error) {
    logger.warn('[LightNode] pending binding not sent again:', (error && error.message) || error);
  }
}

/**
 * The device layer's upkeep once a wake answered, within its deadline (light-node-messages sections 5.4 and 5.6): the
 * lease refresh when its window is open and the key rotation when it fell due, for a node that holds this device's key.
 */
async function maintainDevice(deadline) {
  try {
    const nodeId = await AsyncStorage.getItem('qnet_ping_node_id');
    const binding = nodeId ? await localBinding(nodeId) : null;
    if (!binding) return;
    // The schedule's next refresh window and rotation epoch come only from a signed status: a wake reads it itself, with
    // the ping key and no user, when the schedule knows none ahead (at most every few hours), so a node woken only by
    // pushes or background fetches stays counted without the app being opened (MN-1). The same read settles a key sent
    // in a message that got no answer, also for a binding not yet known to hold this device's key (MN-R4-03).
    const unanswered = await hasUnansweredKey();
    if (!binding.hw && !unanswered) return;
    if (deadline - Date.now() > 12000 && (unanswered || await Enrolment.needsStatus(nodeId))) {
      await Enrolment.noteStatusTry(nodeId);
      const readAt = Date.now();
      const status = await readNodeStatus(nodeId, { signStatus: signStatusWithPingKey, timeoutMs: 5000, deadline });
      if ((await settleUnansweredKey(nodeId, status)) === 'pending') binding.hw = true;
      await Enrolment.noteStatus(nodeId, status, { readAt });
    }
    if (!binding.hw) return;
    const pingPublicKey = await AsyncStorage.getItem(`qnet_ping_dilithium_pk_${nodeId}`);
    // The rotation falls due by the chain's epoch, never by the last one this device was credited in (MN-R2-01). It makes
    // a pending key as an enrolment does, so it runs in the enrolment lane, and not while one runs (MN-R3-02).
    const epoch = await knownChainEpoch();
    await inEnrolLane(nodeId, () => Enrolment.maintain(nodeId, {
      deadline, epoch, binding: { seq: binding.seq, pingPublicKey }, device: checkDevice,
      onKeyGone: (key) => markDeviceKeyLost(nodeId, key || null),
    }));
  } catch (error) {
    logger.warn('[LightNode] device upkeep failed:', (error && error.message) || error);
  }
}

// ─── FCM Token Refresh ───────────────────────────────────────────────
// A ping-key signed update of the push target. Called on onTokenRefresh, on every wake (push, background fetch) and on
// the return to the app while `qnet_needs_token_refresh` is set or the target differs from the last one sent.
// Debounced: at most one call an hour. Skipped when the target is unchanged.

const TOKEN_REFRESH_DEBOUNCE_SEC = 3600; // 1 hour

/**
 * Sends the device's current push target to the genesis nodes, only while this wallet's node is linked here. Signed by
 * the ping key (Keychain, after first unlock), so it works with the wallet locked. A binding made with a sequence signs
 * the target itself (light-node-messages section 4, token refresh); a binding an older build made signs the v1 message.
 * `deadline` (ms): a wake's, which every POST stays within; no owner is asked once too little of it is left. `force`:
 * the network has no push address for the node (readdressIfOwed), so the target goes even when it is the last one sent,
 * still at most once an hour; with `rotate` a token that is the last one sent is first replaced by a new one, since the
 * provider may have dropped it while Firebase still reports it. A target the owners took is this binding's push type from
 * then on (setPushType).
 * @param {string} nodeId — light-node pseudonym
 * @returns {{ success, updated, reason?, sent? }} `sent` when an owner took the target
 */
export async function refreshFcmTokenOnServer(nodeId, { deadline = null, force = false, rotate = false } = {}) {
  try {
    if (!nodeId) {
      return { success: false, error: 'missing_params' };
    }
    const binding = await localBinding(nodeId);
    if (!binding) return { success: false, error: 'not_linked' };

    let push = await pushTarget();
    if (!push.target) {
      return { success: true, updated: false, reason: 'no_push_target' };
    }

    // Skip if the target is unchanged since the last successful refresh
    const lastSent = await AsyncStorage.getItem('qnet_last_sent_fcm_token');
    if (lastSent === push.target && !force) {
      await AsyncStorage.setItem('qnet_needs_token_refresh', 'false');
      return { success: true, updated: false, reason: 'unchanged' };
    }

    // Debounce: max 1 call per hour
    const lastRefreshStr = await AsyncStorage.getItem('qnet_last_token_refresh_ts');
    const now = Math.floor(Date.now() / 1000);
    if (lastRefreshStr && (now - parseInt(lastRefreshStr, 10)) < TOKEN_REFRESH_DEBOUNCE_SEC) {
      return { success: true, updated: false, reason: 'debounced' };
    }

    // The owners lost the push address while this token was the one they held: a token the provider dropped stays the
    // one Firebase reports until it is deleted. Until a new one reaches an owner, every wake sends it again.
    if (rotate && push.token && push.token === lastSent) {
      await AsyncStorage.setItem('qnet_needs_token_refresh', 'true');
      await dropPushToken();
      push = await pushTarget();
      if (!push.target) return { success: true, updated: false, reason: 'no_push_target' };
    }

    const { signWithDilithium, signDetached, isDilithiumAvailable } = require('../crypto/DilithiumCrypto');
    if (!isDilithiumAvailable()) {
      return { success: false, error: 'Dilithium3 module required for token refresh' };
    }
    const pingSkHex = await pingKeyOf(nodeId);
    if (!pingSkHex) {
      return { success: false, error: 'Ping delegation key unavailable' };
    }
    const timestamp = now;
    let signed;
    if (binding.seq > 0) {
      signed = {
        seq: binding.seq,
        signature: await signDetached(tokenRefreshPreimage(nodeId, push.target, binding.seq, timestamp), pingSkHex),
      };
    } else {
      const pingPkHex = await AsyncStorage.getItem(`qnet_ping_dilithium_pk_${nodeId}`);
      if (!pingPkHex) {
        return { success: false, error: 'Ping public key not found' };
      }
      signed = { signature: `ping_dilithium:${await signWithDilithium(`token_refresh:${nodeId}:${timestamp}`, pingSkHex, pingPkHex, nodeId)}` };
    }

    const body = JSON.stringify({
      node_id: nodeId,
      push_type: push.type,
      ...(push.token ? { device_token: push.token } : {}),
      ...signed,
      timestamp,
    });
    const postRefresh = async (apiUrl, ms) => {
      try {
        const response = await fetchWithTimeout(`${apiUrl}/api/v1/light-node/token-refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }, ms);
        return await response.json();
      } catch (e) {
        return { success: false, error: e.message };
      }
    };
    // Only a node that took this device's ping replies holds its identity: the shard owners. Try them in
    // rank order, then the other genesis nodes; never a third-party node, which could replay the signature
    // with a token of its own.
    let result = { success: false };
    const owners = lightShardOwnerUrls(nodeId);
    for (const url of [...owners, ...GENESIS_NODES.filter((u) => !owners.includes(u))]) {
      const ms = Math.min(10000, deadline ? deadline - Date.now() : Infinity);
      if (ms < SELF_ATTEST_MIN_POST_MS) break;
      result = await postRefresh(url, ms);
      if (result.success) break;
    }
    if (result.success) {
      await AsyncStorage.multiSet([
        ['qnet_last_sent_fcm_token', push.target],
        ['qnet_last_token_refresh_ts', String(now)],
        ['qnet_needs_token_refresh', 'false'],
      ]);
      if (binding.pushType !== push.type) await setPushType(nodeId, push.type);
      if (result.updated) {
        logger.log('[Push] ✅ FCM token refreshed on server');
      }
      return { ...result, sent: true };
    }
    return result;
  } catch (error) {
    logger.warn('[Push] Token refresh failed:', error.message || error);
    return { success: false, error: error.message };
  }
}

// The owners took a push target of another type than the binding was made with: a binding made without a push token
// (polling) is woken by pushes from now on, and its precise polling wake goes.
async function setPushType(nodeId, type) {
  try {
    const info = JSON.parse((await AsyncStorage.getItem('qnet_light_node_info')) || 'null');
    if (!info || info.nodeId !== nodeId) return;
    await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ ...info, pushType: type }));
    if (info.pushType === PushType.POLLING) {
      try { await BackgroundFetch.stop('qnet-ping-check'); } catch (_) { /* never scheduled (iOS) */ }
    }
  } catch (_) { /* the next refresh writes it */ }
}

// The network could not wake this device for want of a push address: the node id whose status said so (`no_push_address`,
// `push_reregister`).
export const PUSH_READDRESS_KEY = 'qnet_push_readdress';

/**
 * On open and on each return to the app: a binding made without a push token (polling), or one the owners cannot push -
 * its latest miss put down to no push address while nothing counted the node since (LightNode.freshMiss), or an owner's
 * signed `push_reregister` (LightNode `pushReregister`), from `status` when the caller read one, else as the last read
 * left it - takes the token again and sends it the way a changed token goes (refreshFcmTokenOnServer, forced past
 * "unchanged" for a lost address, and a new token in place of the one the owners lost). A status read saying neither
 * ends the task, and so does a target the owners took. True when one went.
 */
export async function readdressIfOwed(nodeId, status = null) {
  try {
    const binding = await localBinding(nodeId);
    if (!binding) return false;
    if (status && status.onChain === true) {
      const miss = freshMiss(status);
      const owed = (miss && miss.reason === 'no_push_address') || status.pushReregister === true;
      if (owed) await AsyncStorage.setItem(PUSH_READDRESS_KEY, nodeId);
      else await AsyncStorage.removeItem(PUSH_READDRESS_KEY);
    }
    const lost = (await AsyncStorage.getItem(PUSH_READDRESS_KEY)) === nodeId;
    if (!lost && binding.pushType !== PushType.POLLING) return false;
    const r = await refreshFcmTokenOnServer(nodeId, { force: lost, rotate: lost });
    if (!r || r.sent !== true) return false;
    await AsyncStorage.removeItem(PUSH_READDRESS_KEY);
    return true;
  } catch (error) {
    logger.warn('[Push] push address not sent again:', (error && error.message) || error);
    return false;
  }
}

/**
 * onTokenRefresh: a linked node's new push target goes to its shard owners, signed by the ping key (Keychain, after
 * first unlock), so it works with the wallet locked. Until one of them takes it, the next return to the app retries.
 */
export async function backgroundRefreshFcmToken() {
  try {
    const nodeId = await AsyncStorage.getItem('qnet_ping_node_id');
    if (!nodeId) return;

    await AsyncStorage.setItem('qnet_needs_token_refresh', 'true');
    await refreshFcmTokenOnServer(nodeId);
    logger.log('[Push] ✅ FCM token refreshed in background');
  } catch (e) {
    logger.warn('[Push] Background token refresh failed (will retry on foreground):', e.message);
  }
}

/**
 * Whether a linked node's push target should be sent again: the flag onTokenRefresh sets, or a target that differs
 * from the last one sent. False while nothing is linked here, without asking Firebase for a token.
 */
export async function isTokenRefreshNeeded() {
  try {
    if (!(await AsyncStorage.getItem('qnet_ping_node_id'))) return false;
    const flag = await AsyncStorage.getItem('qnet_needs_token_refresh');
    if (flag === 'true') return true;

    const lastSent = await AsyncStorage.getItem('qnet_last_sent_fcm_token');
    if (!lastSent) return true; // never sent — first refresh after the binding

    const push = await pushTarget();
    return !!push.target && push.target !== lastSent;
  } catch {
    return false;
  }
}


let _resumeAttest = null; // the AppState subscription, registered once per process
let _launchWorkOwed = false; // the launch's answer and upkeep, held until the app is opened (AnswerGate refused them)
let _launchStatusOwed = false; // the launch's status read, held until the app comes to the front (launchWork)

/**
 * At launch: the wakes of a node linked to this device (its periodic fetch) and the return-to-app wake. The launch's
 * answer and upkeep run now only where the node may answer (AnswerGate); otherwise at the first return to the app, which
 * also notes this boot as opened. iOS launches the app in the background for a push or a fetch, so a launch is not an
 * open, and such a launch reads no status (launchWork). Takes no push token: one exists only once a node is linked here, and only a binding made without one, or one the
 * network has no push address for, takes it again (readdressIfOwed). Never rejects: the caller registers the foreground
 * push handler after it.
 */
export async function initializePushService() {
  // The last update of the old Android package runs no node: a node it ran stops here, and nothing wakes it again.
  if (LEGACY_MOVE) {
    await teardownLightNode();
    return;
  }
  // Returning to the app is a wake too, a locked wallet included (the ping key needs no password). The self-attest hold
  // keeps repeated returns from sending anything. Registered first, so an open during the launch below is not missed.
  if (!_resumeAttest) {
    _resumeAttest = AppState.addEventListener('change', (next) => {
      // Out of front: a timer would only run late beside the system's own wake (scheduleAnswerAt).
      if (next !== 'active') {
        clearTimeout(_answerTimer);
        _answerTimer = null;
        return;
      }
      // The user may have changed Background App Refresh in Settings meanwhile.
      BackgroundFetch.status().then(recordBackgroundRefreshStatus).catch(() => {});
      returnToApp().catch(() => {});
    });
  }
  // A launch in front is an open, a node linked here or not yet.
  if (AppState.currentState === 'active') await noteOpen();
  let nodeInfo = null;
  try { nodeInfo = JSON.parse((await AsyncStorage.getItem('qnet_light_node_info')) || 'null'); } catch (_) { nodeInfo = null; }
  if (!nodeInfo || typeof nodeInfo !== 'object') return;

  // Every push type gets the periodic self-attest; polling phones also get the precise ping wake.
  if (nodeInfo.pushType === PushType.POLLING) {
    await setupPollingService(nodeInfo.nodeId, nodeInfo.nextPingTime);
  } else {
    await configureBackgroundFetch();
  }
  if (await mayAnswer()) await launchWork(nodeInfo);
  else _launchWorkOwed = true;
}

// The app came to the front: this boot is opened, the periodic wake is armed again (on iOS a new background refresh
// request, so one is always pending within the epoch), and the launch's work runs if the launch held it, else a
// self-attest, the status read a launch in the background left (launchWork) and a push address owed (readdressIfOwed).
async function returnToApp() {
  await noteOpen();
  const s = await AsyncStorage.getItem('qnet_light_node_info');
  const info = s ? JSON.parse(s) : null;
  if (!info || !info.nodeId) return false;
  await configureBackgroundFetch();
  if (_launchWorkOwed) {
    _launchWorkOwed = false;
    await launchWork(info);
    return true;
  }
  const ok = await selfAttestIfNeeded(info.nodeId, false, undefined, null, { opened: true });
  await rearmAnswerTimer(info.nodeId);
  if (_launchStatusOwed) {
    _launchStatusOwed = false;
    await launchStatus(info);
  } else {
    await readdressIfOwed(info.nodeId);
  }
  return ok;
}

// Back in front: a try a failure put off gets its timer again, unless none was set for it (past its epoch's gap).
async function rearmAnswerTimer(nodeId) {
  const hold = await readHold(nodeId);
  if (hold && hold.kind === 'retry' && hold.wake !== false && hold.until > Date.now()) scheduleAnswerAt(nodeId, hold.until);
}

async function launchWork(nodeInfo) {
  // PULL: app open is a wakeup — attest for this epoch if not yet done (deduped inside). A launch in front is an open.
  const opened = AppState.currentState === 'active';
  selfAttestIfNeeded(nodeInfo.nodeId, false, undefined, null, { opened })
    .then(() => (opened ? rearmAnswerTimer(nodeInfo.nodeId) : null))
    .catch(() => {});
  // The status read runs in front only: a launch in the background (iOS starts the app for a push or a fetch, whose own
  // handler answers and does the device upkeep) reads none, and the first return to the app reads it.
  if (opened) await launchStatus(nodeInfo);
  else _launchStatusOwed = true;
}

// A device another one replaced stops waking at its next open, whichever tab is open; a binding the QNet Link sheet left
// pending goes again, and the device layer does its upkeep.
async function launchStatus(nodeInfo) {
  const signedFor = await localBinding(nodeInfo.nodeId);
  const readAt = Date.now();
  readNodeStatus(nodeInfo.nodeId, { signStatus: signStatusWithPingKey })
    .then(async (status) => {
      if (await forgetIfReplaced(nodeInfo.nodeId, status, signedFor ? signedFor.seq : null)) return;
      if (signedFor) await settleUnansweredKey(nodeInfo.nodeId, status);
      await Enrolment.noteStatus(nodeInfo.nodeId, status, { readAt });
      await resendPendingBinding(nodeInfo.nodeId, status);
      await readdressIfOwed(nodeInfo.nodeId, status);
      await maintainDevice(Date.now() + WAKE_FETCH_MS);
    })
    .catch(() => {});
}

/**
 * Check Server node (Super/Genesis) status
 * Used for monitoring server nodes from mobile app
 * v3.35: Added retry logic with different nodes
 */
export async function checkServerNodeStatus(nodeId = null, walletAddress = null, maxRetries = 3) {
  // Nodes are asked by node id, or by wallet in a header.
  let queryParams = '';
  let walletHeader = null; // wallet sent via X-QNet-Wallet header, never the URL

  if (nodeId) {
    queryParams = `node_id=${encodeURIComponent(nodeId)}`;
  } else if (walletAddress) {
    // Wallet-bridge: resolve the node on-chain by wallet (works for server-activated supers and
    // offline/banned nodes — no dependence on the RAM activation registry that misses them).
    // Privacy: the wallet goes in the X-QNet-Wallet header, NOT the URL (see fetch below).
    walletHeader = walletAddress;
  } else {
    return { success: false, error: 'node_id or wallet required' };
  }
  
  let lastError = null;
  const order = shuffledGenesisNodes(); // a different genesis node for each retry

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const apiUrl = order[attempt % order.length];
      const url = queryParams
        ? `${apiUrl}/api/v1/node/status?${queryParams}`
        : `${apiUrl}/api/v1/node/status`;

      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: walletHeader ? { 'X-QNet-Wallet': walletHeader } : undefined,
      }, 8000);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        // Only Super/Genesis nodes are real nodes
        // Light nodes = regular mobile app users (NOT nodes)
        
        // Required heartbeats for NETWORK LIVENESS (NOT rewards!)
        // This is P2P heartbeat for node health, not transaction validation
        let requiredHeartbeats = result.required_heartbeats;
        if (!requiredHeartbeats && result.node_type === 'super') {
          requiredHeartbeats = 9; // Super nodes: 9/10 (90%) for network liveness
        }
        // NO FALLBACK - if node_type is not 'super', it's invalid
        
        return {
          success: true,
          nodeId: result.node_id,
          nodeType: result.node_type,
          // Whether the chain records the node's registration (the node's reg_height): false only on the node's word,
          // undefined when it said nothing (an older node), so the Node tab's "registered" check reads it.
          registered: typeof result.onchain_registered === 'boolean' ? result.onchain_registered
            : (typeof result.registered === 'boolean' ? result.registered : undefined),
          isOnline: result.is_online,
          lastSeen: result.last_seen,
          lastSeenAgoSeconds: result.last_seen_ago_seconds,
          heartbeatCount: result.heartbeat_count || 0,
          requiredHeartbeats: requiredHeartbeats || 9, // Super nodes only
          isRewardEligible: result.is_reward_eligible,
          reputation: result.reputation, // BLOCKCHAIN reputation from DeterministicReputationState
          currentBlockHeight: result.current_block_height,
          needsAttention: result.needs_attention,
          message: result.message,
          // Rewards info (QNC tokens in smallest units)
          // TODO(trustless): pending_rewards is an UNPROVEN /node/status value (a
          // malicious node can inflate it). To make it MITM-proof, source it from the
          // QC-certified account path: extend the /balance/proof endpoint to return
          // pending_rewards and fold it into the merkle leaf (verifyMerkleProof already
          // hashes a pending_rewards slot, currently pinned 0), then gate the displayed
          // figure on QcLightClient.verifyMacroblockStateRoot like the balance. Node-side
          // change required; out of scope for this light-client module.
          pendingRewards: result.pending_rewards,
        };
      }

      return { success: false, error: result.error || 'Unknown error' };
    } catch (error) {
      lastError = error;
      // v3.35: Wait before retry (exponential backoff)
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 500));
      }
    }
  }
  
  // All retries failed
  logger.warn(`[Push] Server node status failed after ${maxRetries} retries:`, lastError?.message);
  return { success: false, error: lastError?.message || 'Network error' };
}

// NOTE: WebSocket support can be added later for real-time updates
// For now, server nodes don't need polling - user can pull-to-refresh
// Server handles heartbeats automatically, rewards calculated at end of 4h window

/**
 * Get ALL nodes owned by a wallet address (Light, Full, Super, Genesis)
 * Returns unified list for display in mobile app
 * @param {string} walletAddress - EON wallet address
 */
export async function getAllNodesByWallet(walletAddress) {
  try {
    const apiUrl = genesisNode();
    
    // NEW: Call without node_type to get ALL nodes. Wallet via header, not the URL (privacy).
    const response = await fetchWithTimeout(
      `${apiUrl}/api/v1/activations/by-wallet`,
      { method: 'GET', headers: { 'X-QNet-Wallet': walletAddress } }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    
    if (result.success && result.nodes) {
      // CRITICAL: Filter out pending_activation and HASH-only entries
      // These are NOT real activated nodes — just code generation records
      const realNodes = result.nodes.filter(n => 
        n.status !== 'pending_activation' && 
        !(n.activation_code && typeof n.activation_code === 'string' && n.activation_code.startsWith('HASH:'))
      );
      logger.log(`[Nodes] Found ${realNodes.length} real nodes for wallet (${result.nodes.length} total incl pending)`);
      return {
        success: true,
        nodes: realNodes,
        totalNodes: realNodes.length
      };
    }
    
    // The node answered but did not answer with a node list: unknown, not "this wallet owns nothing".
    // Reported as success it collapsed the node view exactly like the HTTP failure below.
    if (result && result.success === false) {
      return { success: false, nodes: [], totalNodes: 0, error: result.error || 'node returned success:false' };
    }
    return { success: true, nodes: [], totalNodes: 0 };
  } catch (error) {
    // Distinguish a network/HTTP failure from a genuinely empty wallet: a failed
    // lookup must NOT read as "no nodes" (that collapses the node view on a transient
    // hiccup). success:false → the caller keeps its last-known node state.
    return { success: false, nodes: [], totalNodes: 0, error: error.message };
  }
}

/**
 * Claimable reward total for a node from the dedicated, STATUS-INDEPENDENT endpoint.
 * Reads the merkle reward-root claimable (the real lazy reward) by node_id — returns the true accrued
 * amount whether the node is online, offline, or banned. Use this for "Pending Rewards", NOT the
 * node-status response (which derives 0 from a failed status lookup).
 */
export async function getPendingRewards(nodeId) {
  try {
    const apiUrl = genesisNode();
    const response = await fetchWithTimeout(`${apiUrl}/api/v1/rewards/pending/${encodeURIComponent(nodeId)}`, { method: 'GET' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const r = await response.json();
    // A refusal (the rate limiter answers 200 with success:false) or an answer without the figure is unknown, never 0.
    if (!r || r.success === false) throw new Error((r && r.error) || 'node returned success:false');
    if (r.pending_rewards_nano == null && r.pending_rewards == null) throw new Error('no pending figure');
    return {
      success: true,
      // Base units (nanoQNC) so the UI's /1e9 display + claim gating match /node/status semantics.
      pendingRewards: (r.pending_rewards_nano != null) ? r.pending_rewards_nano : Math.round((r.pending_rewards || 0) * 1e9),
      isClaimable: !!r.is_claimable,
      isEligible: !!r.is_eligible,
      currentEpoch: r.current_epoch,
      heartbeats: r.heartbeats,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * The nodes the chain registered for a wallet (GET /api/v1/account/{wallet}/node-events, the node registry rows, kept
 * for the life of the chain), from a genesis node, a second one when the first does not answer. Only the ids this wallet
 * derives are taken (`ids`: { light, super, genesis }, genesis null for any other wallet), so no answer can name another
 * wallet's node; the type follows the id. The event's burn is not read: the registry keeps none for it.
 * { success: true, nodes: [{ nodeId, nodeType: 'light' | 'super', height }] }, or { success: false } when no node answered.
 */
export async function getWalletNodeEvents(walletAddress, ids) {
  if (!walletAddress || !ids) return { success: false };
  const typeOf = (id) => (id === ids.light ? 'light' : (id === ids.super || (ids.genesis && id === ids.genesis) ? 'super' : null));
  for (const base of shuffledGenesisNodes().slice(0, 2)) {
    try {
      const response = await fetchWithTimeout(`${base}/api/v1/account/${encodeURIComponent(walletAddress)}/node-events`, { method: 'GET' });
      if (!response.ok) continue;
      const body = await response.json();
      if (!body || typeof body !== 'object' || body.address !== walletAddress || !Array.isArray(body.events)) continue;
      const nodes = [];
      for (const ev of body.events.slice(0, 8)) {
        const nodeType = ev && ev.type === 'node_activation' ? typeOf(ev.node_id) : null;
        if (!nodeType || !Number.isSafeInteger(ev.height) || ev.height < 0) continue;
        if (!nodes.some((n) => n.nodeId === ev.node_id)) nodes.push({ nodeId: ev.node_id, nodeType, height: ev.height });
      }
      return { success: true, nodes };
    } catch (_) { /* the next genesis node */ }
  }
  return { success: false };
}

// The chain's epochs (reward_epoch.rs): 14,400 blocks each, numbered by height / 14,400; the network settles epoch N
// under the key 160 * (N + 1), which the per-epoch history names.
const EPOCH_BLOCKS = 14400;
const KEYS_PER_EPOCH = 160;
const HISTORY_EPOCHS = 64;
const HISTORY_STATUSES = ['claimable', 'claimed', 'not_eligible', 'shard_not_certified', 'unavailable'];

// One node's per-epoch history for `nodeId`: { wallet, rows: [{ epoch, status }] } newest first, or null.
function parseEpochHistory(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.history) || body.history.length > 100) return null;
  const rows = [];
  for (const r of body.history) {
    if (!r || typeof r !== 'object' || !Number.isSafeInteger(r.epoch) || typeof r.status !== 'string') return null;
    if (r.epoch < KEYS_PER_EPOCH || r.epoch % KEYS_PER_EPOCH !== 0 || !HISTORY_STATUSES.includes(r.status)) continue;
    rows.push({ epoch: r.epoch / KEYS_PER_EPOCH - 1, status: r.status });
  }
  return { wallet: typeof body.wallet === 'string' ? body.wallet : '', rows };
}

/**
 * A node's counted and missed epochs among the last 64 the network settled (GET /api/v1/rewards/history/{id}?limit=64):
 * paid (claimable, claimed) is counted, not eligible is missed; an epoch the answering node could not serve
 * (unavailable) or whose light group was not checked is neither. A second genesis node fills the epochs the first could
 * not serve (three are asked at most); an answer for another wallet than `walletAddress` counts for nothing. Epochs before the node's registration
 * (`registeredHeight`, from node-events) are left out, and its registration epoch is never missed. { counted, missed } or
 * null when no genesis node answered.
 */
export async function getNodeEpochs(nodeId, { walletAddress = null, registeredHeight = null } = {}) {
  if (!nodeId) return null;
  const path = `/api/v1/rewards/history/${encodeURIComponent(nodeId)}?limit=${HISTORY_EPOCHS}`;
  let got = null;
  let answered = 0;
  for (const base of shuffledGenesisNodes().slice(0, 3)) {
    if (answered >= 2 || (got && !got.rows.some((r) => r.status === 'unavailable'))) break;
    let value = null;
    try {
      const response = await fetchWithTimeout(`${base}${path}`, { method: 'GET' });
      value = response.ok ? parseEpochHistory(await response.json()) : null;
    } catch (_) { value = null; }
    if (!value || (walletAddress && value.wallet !== walletAddress)) continue;
    answered += 1;
    if (!got) got = value;
    else if (value.wallet === got.wallet) {
      const served = new Map(value.rows.filter((r) => r.status !== 'unavailable').map((r) => [r.epoch, r]));
      got = { wallet: got.wallet, rows: got.rows.map((r) => (r.status === 'unavailable' ? served.get(r.epoch) || r : r)) };
    }
  }
  if (!got) return null;
  const joined = Number.isSafeInteger(registeredHeight) && registeredHeight >= 0 ? Math.floor(registeredHeight / EPOCH_BLOCKS) : null;
  const seen = new Set();
  let counted = 0;
  let missed = 0;
  for (const r of got.rows) {
    if (seen.has(r.epoch) || (joined !== null && r.epoch < joined)) continue;
    seen.add(r.epoch);
    if (r.status === 'claimable' || r.status === 'claimed') counted += 1;
    else if (r.status === 'not_eligible' && r.epoch !== joined) missed += 1;
  }
  return { counted, missed };
}

export default {
  // Push target, read only while a node is linked here
  PushType,
  pushTarget,

  // The binding of this wallet's node to this device, and ping handling
  bindThisDevice,
  linkWithConsent,
  resendPendingBinding,
  enrolAgainIfUnleased,
  endExpiredLink,
  markDeviceKeyLost,
  localNode,
  stopLightNode,
  checkPendingChallenge,
  getNextPingTime,
  respondToChallenge,
  selfAttestIfNeeded,
  handlePushMessage,
  initializePushService,

  // Push target refresh (ping-key signed)
  refreshFcmTokenOnServer,
  isTokenRefreshNeeded,
  backgroundRefreshFcmToken,
  
  // Server node status (Super/Genesis - single API call)
  checkServerNodeStatus,
  
  // Get all nodes by wallet (unified view), the chain's registrations of them, and a node's epochs
  getAllNodesByWallet,
  getWalletNodeEvents,
  getNodeEpochs,

  // Status-independent claimable rewards by node_id
  getPendingRewards,
};

