/**
 * This wallet's light node on the genesis nodes (docs/protocols/light-node-messages.md sections 4, 7 and 8): the status
 * the network keeps for it, and the binding that makes one device the one that answers for it. Only the node's shard
 * owners among the five genesis names are asked. Nothing here signs: callers pass signatures made over the preimages of
 * crypto/NodePreimages.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { lightShardOwnerUrls } from '../config/nodes';
import { isModel } from './DeviceModel';

// A status is the network's only when this many genesis nodes agree, and a client switches a form on only when this
// many list it (section 7).
export const MIN_AGREEMENT = 2;

// How long a binding just made is not judged by owners that do not name it yet: the owner that took it passes it to the
// others within seconds, and retries for one that was down (15 s, 1 min, 5 min).
export const BIND_SETTLE_MS = 10 * 60000;

// The pending-link record the QNet Link sheet writes (qnet-link-v1 section 14.8): no secrets. It is dropped once the
// chain lists the node, or T + 24 h + 10 min after the consent.
export const LINK_PENDING_KEY = 'qnet_node_link_pending';
const LINK_PENDING_LIFE_MS = (86400 + 600) * 1000;

const STATUS_MS = 6000;
const POST_MS = 15000;
const DEVICE_STATES = new Set(['awaiting_registration', 'pending_next_epoch', 'active', 'suspect', 'check_pending', 'paused', 'ended']);
// A signed status refused for this reason was signed with a key that is not the node's current one (section 7).
const NOT_THIS_KEY = 'bad_signature';

const enc = encodeURIComponent;
const natural = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);

function randomHex(bytes) {
  return Array.from(global.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// The JSON a genesis node answered, refusals included (they may come with an HTTP error status); a throw when nothing
// readable came back in time.
async function call(url, { body = null, timeoutMs }) {
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

function countedOf(c) {
  if (!c || typeof c !== 'object') return null;
  const out = { since: natural(c.epochs_since_registration), counted: natural(c.counted), last: natural(c.last_counted_epoch) };
  return out.since !== null && out.counted !== null && out.counted <= out.since ? out : null;
}

// The public status's `device` (section 7): which kind of device the bound one is and its model, the UTC day it was
// linked, the last epoch it was counted in and its state. Display only (neither the platform nor the model is signed); null
// when absent or malformed. A model the node's rule would not keep is none.
const DEVICE_PLATFORMS = new Set(['android', 'ios', 'unknown']);
const DEVICE_VIEW_STATES = new Set(['online', 'offline', 'unlinked', 'other_device_pending']);
function deviceOf(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !DEVICE_VIEW_STATES.has(d.state)) return null;
  const platform = d.platform === null || d.platform === undefined ? null : (DEVICE_PLATFORMS.has(d.platform) ? d.platform : 'unknown');
  const model = isModel(d.model) ? d.model : null;
  return { platform, model, linkedSince: natural(d.linked_since), lastAnswerEpoch: natural(d.last_answer_epoch), state: d.state };
}

// Why an owner did not count the node in its latest missed epoch (section 7 `device.last_miss`), the most specific first:
// at equal epochs a reader takes the earliest in this list. Any other reason is ignored, never shown. Two are the
// network's own misses, which never count toward the rule that stops waking a node: `not_committed` (no row of the
// node's shard was committed for that epoch, so nothing this device did could count: first, it explains the miss whole)
// and `not_sent` (the owner's push did not go out: the provider failed it, the pacer shed it or no anchor was ready).
export const MISS_REASONS = [
  'not_committed', 'answered_late', 'not_delivered', 'answer_refused', 'woken_no_answer', 'no_push_address', 'not_sent',
  'not_woken_inactive',
];

/** The reasons that are the network's misses, not this device's: nothing is needed on the device for them. */
export const NETWORK_MISSES = new Set(['not_committed', 'not_sent']);

// What the app did with a wake that reached the device, as its answer later reported it (section 7
// `device.last_miss.app_outcome`; services/PushReceipts keeps this device's record).
export const APP_OUTCOMES = ['answered', 'not_opened_since_boot', 'swiped', 'after_commit', 'answer_failed', 'already_counted', 'no_key'];

// A whole number that may be absent (a Unix time, a count of seconds): undefined for a wrong type, so the record it is
// in is refused.
const optionalNatural = (v) => (v === null || v === undefined ? null : (natural(v) === null ? undefined : v));

const plainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// `device.last_miss` read strictly: { epoch, reason, wokenAt, answeredAt, deliveryDelaySecs, refused, deliveredAt,
// appOutcome }, or null for no record, an unknown reason or any field of another type than the status defines. An
// outcome this app does not know is left out (null), the record kept.
function missOf(d) {
  const m = plainObject(d) ? d.last_miss : null;
  if (!plainObject(m) || !MISS_REASONS.includes(m.reason)) return null;
  const epoch = natural(m.epoch);
  const wokenAt = optionalNatural(m.woken_at);
  const answeredAt = optionalNatural(m.answered_at);
  const deliveryDelaySecs = optionalNatural(m.delivery_delay_secs);
  const deliveredAt = optionalNatural(m.delivered_at);
  const refused = m.refused === null || m.refused === undefined ? null
    : (typeof m.refused === 'string' && /^[a-z0-9_]{1,40}$/.test(m.refused) ? m.refused : undefined);
  const appOutcome = m.app_outcome === null || m.app_outcome === undefined ? null
    : (typeof m.app_outcome === 'string' ? (APP_OUTCOMES.includes(m.app_outcome) ? m.app_outcome : null) : undefined);
  if (epoch === null || [wokenAt, answeredAt, deliveryDelaySecs, refused, deliveredAt, appOutcome].includes(undefined)) return null;
  return { epoch, reason: m.reason, wokenAt, answeredAt, deliveryDelaySecs, refused, deliveredAt, appOutcome };
}

// `device.last_answer` read strictly: { at, deliveryDelaySecs, handlingSecs }, or null for no record or any field of
// another type than the status defines.
function lastAnswerOf(d) {
  const a = plainObject(d) ? d.last_answer : null;
  if (!plainObject(a)) return null;
  const at = natural(a.at);
  const deliveryDelaySecs = optionalNatural(a.delivery_delay_secs);
  const handlingSecs = optionalNatural(a.handling_secs);
  if (at === null || deliveryDelaySecs === undefined || handlingSecs === undefined) return null;
  return { at, deliveryDelaySecs, handlingSecs };
}

/** Of the owners' last answers, the latest; or null. */
export function latestAnswer(answers) {
  let best = null;
  for (const a of answers) if (a && (!best || a.at > best.at)) best = a;
  return best;
}

// What a record knows of the device's own account, for a tie (section 7): `delivered_at` first, then `app_outcome`.
const told = (m) => (m.deliveredAt != null ? 2 : 0) + (m.appOutcome != null ? 1 : 0);

/**
 * Of the owners' records, the one with the highest epoch, at equal epochs the most specific (MISS_REASONS), at an equal
 * reason the one with `deliveredAt`, else with `appOutcome` (the owner that took the device's account of the wake); or
 * null.
 */
export function latestMiss(misses) {
  let best = null;
  for (const m of misses) {
    if (!m) continue;
    const rank = best && m.epoch === best.epoch ? MISS_REASONS.indexOf(m.reason) - MISS_REASONS.indexOf(best.reason) : 0;
    if (!best || m.epoch > best.epoch || (m.epoch === best.epoch && (rank < 0 || (rank === 0 && told(m) > told(best))))) best = m;
  }
  return best;
}

// Whether a record carries the device's own account of the wake: that it never arrived, or when it arrived and what the
// app did with it. That account reaches the network only with a later answer, which counts the node again.
export function hasDeviceAccount(m) {
  return !!m && (m.reason === 'not_delivered' || (m.reason === 'woken_no_answer' && (m.deliveredAt != null || m.appOutcome != null)));
}

/**
 * The status's latest missed epoch (`lastMiss`) while nothing counted the node since: not when the last counted epoch
 * (`counted.last`) or the epoch the device view last counted it in (`device.lastAnswerEpoch`) is that epoch or later.
 */
export function freshMiss(status) {
  const m = status ? status.lastMiss : null;
  if (!m) return null;
  const counted = [status.counted && status.counted.last, status.device && status.device.lastAnswerEpoch];
  return counted.some((e) => Number.isSafeInteger(e) && e >= m.epoch) ? null : m;
}

/**
 * The miss the Node tab names, as the site's Device tab does: the fresh one (freshMiss), else the latest one when it
 * carries the device's own account of the wake (hasDeviceAccount), which the network has only once a later answer
 * counted the node again (`past`). { miss, past } or null.
 */
export function shownMiss(status) {
  const fresh = freshMiss(status);
  if (fresh) return { miss: fresh, past: false };
  const m = status ? status.lastMiss : null;
  return hasDeviceAccount(m) ? { miss: m, past: true } : null;
}

// One node's public answer, or null when it gives no verdict on the chain (a refusal, a rate limit).
function publicOf(a) {
  if (!a || typeof a.onchain_registered !== 'boolean') return null;
  const device = a.onchain_registered ? deviceOf(a.device) : null;
  return {
    onChain: a.onchain_registered,
    registrationPending: a.registration_pending === true,
    deviceBound: bool(a.device_bound),
    answered: bool(a.answered_this_epoch),
    needsReactivation: a.needs_reactivation === true,
    counted: countedOf(a.counted),
    device,
    lastMiss: device ? missOf(a.device) : null,
    lastAnswer: device ? lastAnswerOf(a.device) : null,
    features: Array.isArray(a.features) ? a.features.filter((f) => typeof f === 'string') : [],
  };
}

// The `device_tag_h` of a signed answer (section 7: only the signed form carries it), or null.
const tagOf = (a) => (typeof a.device_tag_h === 'string' && /^[0-9a-f]{16}$/.test(a.device_tag_h) ? a.device_tag_h : null);

function signedOf(a) {
  const window = a.refresh_window && typeof a.refresh_window === 'object'
    ? { from: natural(a.refresh_window.from), to: natural(a.refresh_window.to) } : null;
  return {
    bindingSeq: natural(a.binding_seq),
    boundAt: natural(a.bound_at),
    registeredHeight: natural(a.registered_height),
    deviceState: DEVICE_STATES.has(a.device_state) ? a.device_state : null,
    effectiveEpoch: natural(a.effective_epoch),
    refreshWindow: window && window.from !== null && window.to !== null ? window : null,
    rotationDue: natural(a.rotation_due),
    pausedUntil: natural(a.paused_until),
    ref: typeof a.ref === 'string' && /^[0-9a-f]{8}$/.test(a.ref) ? a.ref : null,
  };
}

// Of the owners' `counted`, the one with the latest counted epoch (more counted epochs at a tie): an owner that took this
// device's answers while another was down counts what that one does not; or null.
function latestCounted(list) {
  let best = null;
  for (const c of list) {
    if (!c) continue;
    const later = !best || (c.last ?? -1) > (best.last ?? -1) || ((c.last ?? -1) === (best.last ?? -1) && c.counted > best.counted);
    if (later) best = c;
  }
  return best;
}

// The owners' device views as one (F13): the first owner's, `online` when any owner says so, and the latest epoch any
// of them counted the device in; or null.
function joinedDevice(list) {
  const views = list.filter(Boolean);
  if (views.length === 0) return null;
  const epochs = views.map((d) => d.lastAnswerEpoch).filter((e) => e !== null);
  return {
    ...views[0],
    state: views.some((d) => d.state === 'online') ? 'online' : views[0].state,
    lastAnswerEpoch: epochs.length > 0 ? Math.max(...epochs) : null,
  };
}

/** The features at least MIN_AGREEMENT answers list. */
export function agreedFeatures(answers) {
  const count = new Map();
  for (const a of answers) for (const f of new Set(a.features)) count.set(f, (count.get(f) || 0) + 1);
  return [...count].filter(([, n]) => n >= MIN_AGREEMENT).map(([f]) => f).sort();
}

/**
 * The node's status from its three shard owners (section 7). `onChain` is true or false only when two of them say so,
 * otherwise null (unreachable, one answer, a disagreement): no node is ever reported absent on one answer. Of the owners
 * that say the node is on the chain, any one's word is enough for what counts the device (F13: an owner may have taken
 * an answer while another was down, and the one relay that tells the others may be lost): `answered` is true when any of
 * them says so, `needsReactivation` only when every one of them says so, `counted` the one with the latest counted
 * epoch, and the device view `online` when any says so, with the latest epoch any counted it in.
 * `deviceBound` is the word of the first owner whose verdict on the chain agrees; `deviceBoundAgreed` is true or false
 * only when two owners that say the node is on the chain say so, null otherwise. When `signStatus(nodeId, ts)` is given ({ signer, sig } for the signed-status message, null when this
 * device holds no key to sign it with) and two owners list `status_signed`, the signed status goes to every owner: the
 * signed fields come from the first owner, in rank order, that takes the signature, and `keyOurs` tells whether the node
 * took this device's ping key: true when an owner took a ping-key signature, false only when MIN_AGREEMENT owners refused
 * it explicitly before one took it (one owner behind the others, during a roll or a lagging sync, still holds the binding
 * before; its word alone ends nothing on this device), null when nothing was learned or the wallet key signed (`signer`).
 * `bindingSeqAgreed`: the `binding_seq` MIN_AGREEMENT signed answers report alike, whichever key signed, else null: the
 * binding the network holds, which decides whether this device's binding is the current one (NodeTab nodeView,
 * forgetIfReplaced). `device`: the agreed answer's public device view (deviceOf), or null. `lastMiss`: the latest epoch an
 * owner that says the node is on the chain did not count it in, the most specific record at equal epochs (latestMiss),
 * or null. `lastAnswer`: the latest `device.last_answer` of those owners ({ at, deliveryDelaySecs, handlingSecs }), or
 * null. `deviceTags`: the
 * `device_tag_h` of every owner that took the signature and says the node is on the chain, for this read's `nonce` (only
 * the signed form names the device, ND-7; an owner a rotation's statement has not reached yet still names the key before,
 * so no single one decides). `pushReregister`: true when an owner that took the signature and says the node is on the
 * chain cannot push this device (its signed `push_reregister`: it holds no push address of this binding, or the provider
 * said the token is gone), false when the signed status was sent and none says so, null when it was not sent.
 * `noStatusKey`: signStatus had no key to sign with, so no owner was asked and no tag came.
 * `deadline` (ms, a background wake's): every call stays within it, and none is started once too little of it is left
 * (MN-R3-05); what could not be asked in time reads as not learned.
 */
export async function readNodeStatus(nodeId, { signStatus = null, timeoutMs = STATUS_MS, deadline = null } = {}) {
  const owners = lightShardOwnerUrls(nodeId);
  const publicMs = postMs(timeoutMs, deadline);
  const answers = publicMs < MIN_POST_MS ? [] : (await Promise.all(owners.map((u) => call(
    `${u}/api/v1/light-node/status?node_id=${enc(nodeId)}`, { timeoutMs: publicMs },
  ).then(publicOf, () => null)))).filter(Boolean);
  const yes = answers.filter((a) => a.onChain === true);
  const no = answers.filter((a) => a.onChain === false);
  const onChain = yes.length >= MIN_AGREEMENT ? true : (no.length >= MIN_AGREEMENT ? false : null);
  const view = onChain === true ? yes[0] : (onChain === false ? no[0] : null);
  const features = agreedFeatures(answers);
  const out = {
    reachable: answers.length > 0,
    onChain,
    registrationPending: view ? view.registrationPending : false,
    deviceBound: view ? view.deviceBound : null,
    deviceBoundAgreed: onChain !== true ? null
      : (yes.filter((a) => a.deviceBound === true).length >= MIN_AGREEMENT ? true
        : (yes.filter((a) => a.deviceBound === false).length >= MIN_AGREEMENT ? false : null)),
    answered: onChain === true && yes.some((a) => a.answered === true) ? true : (view ? view.answered : null),
    needsReactivation: onChain === true ? yes.every((a) => a.needsReactivation) : (view ? view.needsReactivation : false),
    counted: onChain === true ? latestCounted(yes.map((a) => a.counted)) : (view ? view.counted : null),
    device: onChain === true ? joinedDevice(yes.map((a) => a.device)) : (view ? view.device : null),
    lastMiss: onChain === true ? latestMiss(yes.map((a) => a.lastMiss)) : null,
    lastAnswer: onChain === true ? latestAnswer(yes.map((a) => a.lastAnswer)) : null,
    deviceTags: [],
    nonce: null,
    noStatusKey: false,
    features,
    signed: null,
    keyOurs: null,
    bindingSeqAgreed: null,
    signer: null,
    pushReregister: null,
  };
  if (!signStatus || onChain !== true || !features.includes('status_signed')) return out;
  const ts = Math.floor(Date.now() / 1000);
  let s = null;
  try {
    s = await signStatus(nodeId, ts);
    out.noStatusKey = s === null;
  } catch (_) {
    s = null;
  }
  if (!s || (s.signer !== 'ping' && s.signer !== 'wallet') || typeof s.sig !== 'string') return out;
  const ms = postMs(timeoutMs, deadline);
  if (ms < MIN_POST_MS) return out;
  const nonce = randomHex(16);
  const body = { node_id: nodeId, ts, signer: s.signer, sig: s.sig, nonce };
  if (s.signer === 'wallet' && typeof s.identityPublicKey === 'string') body.identity_pubkey = s.identityPublicKey;
  const replies = await Promise.all(owners.map((u) => call(`${u}/api/v1/light-node/status`, { body, timeoutMs: ms })
    .catch(() => null)));
  out.nonce = nonce;
  out.signer = s.signer;
  out.pushReregister = false;
  let refused = 0;
  let taken = false;
  const seqs = new Map();
  for (const a of replies) {
    if (!a) continue;
    if (a.success !== false && typeof a.onchain_registered === 'boolean') {
      if (!taken) {
        taken = true;
        out.signed = signedOf(a);
        // Only the ping key is this device's own: an answer to the wallet key says nothing of this device's binding.
        if (out.keyOurs === null && s.signer === 'ping') out.keyOurs = true;
      }
      const seq = natural(a.binding_seq);
      if (seq !== null) seqs.set(seq, (seqs.get(seq) || 0) + 1);
      if (a.onchain_registered === true && a.push_reregister === true) out.pushReregister = true;
      const tag = a.onchain_registered === true ? tagOf(a) : null;
      if (tag) out.deviceTags.push(tag);
    } else if (a.success === false && a.reason === NOT_THIS_KEY && !taken && s.signer === 'ping') {
      refused += 1;
      if (refused >= MIN_AGREEMENT) out.keyOurs = false;
    }
  }
  const agreed = [...seqs].filter(([, n]) => n >= MIN_AGREEMENT).map(([seq]) => seq);
  out.bindingSeqAgreed = agreed.length === 1 ? agreed[0] : null;
  return out;
}

/** Whether one genesis node says the node is on the chain: true, false, or null for no verdict. */
export async function onChainAt(url, nodeId, timeoutMs = STATUS_MS) {
  try {
    const a = publicOf(await call(`${url}/api/v1/light-node/status?node_id=${enc(nodeId)}`, { timeoutMs }));
    return a ? a.onChain : null;
  } catch (_) {
    return null;
  }
}

// The shard owners in rank order, `first` (the issuer of a device challenge) in front.
const ownersFrom = (nodeId, first) => {
  const owners = lightShardOwnerUrls(nodeId);
  return first && owners.includes(first) ? [first, ...owners.filter((u) => u !== first)] : owners;
};

// A refusal as the caller reads it; a device refusal may carry the node's support reference (light-node-messages 5.9).
const refusalOf = (a) => {
  const wait = Number(a.retry_after_seconds);
  const ref = typeof a.ref === 'string' && /^[0-9a-f]{8}$/.test(a.ref) ? { ref: a.ref } : {};
  return { ok: false, reason: a.reason, retryAfterSeconds: Number.isSafeInteger(wait) && wait > 0 ? wait : null, ...ref };
};

// No POST is started with less than this left before a caller's deadline.
const MIN_POST_MS = 1500;

// The time one POST may take: its own cap, within `deadline` (ms) when there is one.
const postMs = (timeoutMs, deadline) => Math.min(timeoutMs, deadline ? deadline - Date.now() : Infinity);

// A POST to `owners` in order: the first that takes it wins; a stated refusal ends the round (the owners share the
// binding), anything unreadable moves on to the next owner. `deadline` (ms): every POST stays within it, and no owner
// is asked once too little of it is left.
async function postToOwners(owners, path, body, accepted, timeoutMs, deadline = null) {
  for (const u of owners) {
    const ms = postMs(timeoutMs, deadline);
    if (ms < MIN_POST_MS) break;
    let a;
    try {
      a = await call(`${u}${path}`, { body, timeoutMs: ms });
    } catch (_) {
      continue;
    }
    if (accepted(a)) return { ok: true, answer: a };
    if (a.success === false && typeof a.reason === 'string' && a.reason) return refusalOf(a);
  }
  return { ok: false, reason: 'network', retryAfterSeconds: null };
}

// The owners a /bind of `body` goes to: a binding with a device block only to `first`, the owner that issued its
// challenge, since any other answers device_stale for a stamp it did not issue (node batch D2); one without to every
// owner, `first` in front.
const bindOwners = (nodeId, body, first) => (body && body.device ? (first ? [first] : []) : ownersFrom(nodeId, first));

/**
 * POST /light-node/bind (section 8). Taken only when the node says it bound exactly this sequence: an answer without
 * `bound: true` binds nothing, whatever else it says. `first`: the owner that issued the device challenge, the only one
 * a binding with a device block goes to, so an issuer that gave no answer leaves it unanswered ('network'), never
 * refused by an owner that could not take it; `deadline` (ms): a background wake's, which the POSTs stay within.
 */
export function postBind(nodeId, body, { timeoutMs = POST_MS, first = null, deadline = null } = {}) {
  return postToOwners(bindOwners(nodeId, body, first), '/api/v1/light-node/bind', body,
    (a) => a.success === true && a.bound === true && a.seq === body.seq, timeoutMs, deadline);
}

/**
 * POST /light-node/bind of the QNet Link sheet's binding, which carries the wallet's consent (qnet-link-v1 section
 * 14.8): to the issuer of its device challenge (`first`, else the first owner) and to the node's backup owner. Taken
 * when one of them kept it for this sequence, bound now or pending until the registration applies:
 * { ok: true, bound } | { ok: false, reason, retryAfterSeconds }. The backup's device_stale for a binding with a device
 * block says only that the stamp is not its own (node batch D2): it refuses nothing, so an issuer that gave no answer
 * leaves the binding unanswered ('network'), and the key it carried waits for the status (MN-5).
 */
export async function postPendingBind(nodeId, body, { timeoutMs = POST_MS, first = null } = {}) {
  let refusal = null;
  let out = null;
  const owners = ownersFrom(nodeId, first).slice(0, 2);
  for (const u of owners) {
    let a;
    try {
      a = await call(`${u}/api/v1/light-node/bind`, { body, timeoutMs });
    } catch (_) {
      continue;
    }
    if (a.success === true && a.seq === body.seq && (a.bound === true || a.pending === true)) {
      out = { ok: true, bound: !!(out && out.bound) || a.bound === true };
    } else if (a.success === false && typeof a.reason === 'string' && a.reason && !refusal) {
      const notItsStamp = !!body.device && u !== owners[0] && a.reason === 'device_stale';
      if (!notItsStamp) refusal = refusalOf(a);
    }
  }
  return out || refusal || { ok: false, reason: 'network', retryAfterSeconds: null };
}

/** POST /light-node/unbind (section 8). `first`: the owner that issued the release's challenge; `deadline` as postBind. */
export function postUnbind(nodeId, body, { timeoutMs = POST_MS, first = null, deadline = null } = {}) {
  return postToOwners(ownersFrom(nodeId, first), '/api/v1/light-node/unbind', body, (a) => a.success === true, timeoutMs,
    deadline);
}

/** The pending-link record of this node, with `expired` set once its time is over; null when there is none. */
export async function readLinkPending(nodeId, now = Date.now()) {
  let rec = null;
  try { rec = JSON.parse((await AsyncStorage.getItem(LINK_PENDING_KEY)) || 'null'); } catch (_) { rec = null; }
  if (!rec || typeof rec !== 'object' || rec.nodeId !== nodeId || !Number.isSafeInteger(rec.T) || rec.T <= 0) return null;
  return { ...rec, expired: now > rec.T * 1000 + LINK_PENDING_LIFE_MS };
}

/**
 * Writes the pending-link record of a consent given in the QNet Link sheet: { nodeId, wallet, T, createdAt, bound,
 * bindBlob }, `bindBlob` the signed binding without its device block, re-sent while the chain lists the node unbound;
 * after a re-send that failed for now also `tries` and `nextTryAt` (ms), before which no re-send is made, and `keyTries`,
 * the failed tries among them that attested a new device key.
 */
export async function writeLinkPending(rec) {
  await AsyncStorage.setItem(LINK_PENDING_KEY, JSON.stringify({
    nodeId: rec.nodeId, wallet: rec.wallet, T: rec.T, createdAt: rec.createdAt || Date.now(), bound: !!rec.bound,
    bindBlob: rec.bindBlob || null,
    ...(Number.isSafeInteger(rec.tries) && Number.isSafeInteger(rec.nextTryAt) ? { tries: rec.tries, nextTryAt: rec.nextTryAt } : {}),
    ...(Number.isSafeInteger(rec.keyTries) && rec.keyTries > 0 ? { keyTries: rec.keyTries } : {}),
  }));
}

/** Drops the pending-link record (the chain lists the node, or its time is over). */
export async function dropLinkPending() {
  try { await AsyncStorage.removeItem(LINK_PENDING_KEY); } catch (_) { /* the next read drops it */ }
}
