/**
 * The Node tab (plan-mobile 3.2, unified plan 3.1): this wallet's node as the network records it, and what this device
 * can do about it here: keep it running (Use this device, where the card offers it) and move its balance into the
 * wallet. One wallet, one node (owner, 11.10): a light node shows only on the device it is bound to; bound to another
 * device, or to none, it is not shown at all and the tab says what it says for a wallet without a node (binding is done
 * on aiqnet.io; the tab names neither it nor activation). It stops running on a device only on a request the user
 * confirms on that device's QNet Link sheet (`unlink`, which the device's own key signs), when another device takes it
 * over, or with the wallet's deletion: the tab has no button for it (owner, 30.09). A super node runs on its server and
 * shows on every device that holds the wallet: its card only shows it (status, last seen, heartbeats, missed epochs, the
 * balance) and moves its balance; a super node the network registered but does not admit to consensus yet says it
 * waits for admission, never Offline. A wallet with a super and a light node on the chain (an older wallet) shows both
 * cards, the server's first, and the node balance (the wallet's, whichever node id is asked) with its move once, on the
 * server card. A super node aiqnet.io recorded for the wallet that the network does not list yet is said as such. A move
 * of the wallet's node balance in transit (services/ClaimTransit) shows as "Moving X" with the rest of the balance, and
 * holds every move button.
 * The same states, texts and buttons on every phone and tablet; no link or pointer to any other place. `nodeView`
 * derives the state from the status alone, so it is tested without the screen.
 */
import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { hasKey } from '../i18n';
import { InfoField, InfoRow } from '../components/InfoRow';
import { BIND_SETTLE_MS, freshMiss, shownMiss } from '../services/LightNode';
import { heldMove } from '../services/ClaimTransit';
import styles from './WalletScreen.styles';

const EPOCH_BLOCKS = 14400;
const ONE_QNC_NANO = 1e9;
// The node counts a device whose key rotation fell due for this many epochs more (30 days; light_device
// ROTATION_GRACE_EPOCHS), then holds it in check_pending until a new key comes.
export const ROTATION_GRACE_EPOCHS = 180;
// How long after a binding its device check still reads as running with nothing else to say so: the network rechecks
// a record that waits once a day (light-node-messages section 8).
export const CHECK_RUNNING_MS = 24 * 3600 * 1000;

// Why the network did not take this device's binding, as the tab says it (light-node-messages section 8).
const REFUSAL_TEXT = {
  device_unsupported: 'node_cant_run',
  device_desktop: 'node_cant_run',
  device_emulator: 'node_cant_run',
  device_not_genuine: 'node_cant_run_now',
  device_compromised: 'node_cant_run_now',
  device_app_unrecognized: 'node_cant_run_now',
  device_unlicensed: 'node_cant_run_now',
  device_key_in_use: 'node_cant_run_now',
  device_slot_paused: 'node_cant_run_now',
  device_secondary_user: 'node_main_profile',
  identity_mismatch: 'node_use_err_key',
  bad_signature: 'node_use_err_key',
  not_registered: 'node_none',
  rate_limited: 'node_use_err_limit',
  device_rate_limited: 'node_use_err_limit',
};

// The latest epoch the network did not count the node in (LightNode.freshMiss), as the tab says it: what happened, with
// the owner's time where it noted one (the untimed text, the timed text, which time), and what to do on this device. The
// network's own misses (LightNode.NETWORK_MISSES) say so, and that nothing is needed on this device.
const MISS_TEXT = {
  not_committed: ['node_miss_not_committed', null, null, 'node_miss_do_nothing'],
  not_sent: ['node_miss_not_sent', null, null, 'node_miss_do_nothing'],
  woken_no_answer: ['node_miss_woken', 'node_miss_woken_at', 'wokenAt', 'node_miss_do_background'],
  answered_late: ['node_miss_late', 'node_miss_late_at', 'answeredAt', 'node_miss_do_background'],
  not_delivered: ['node_miss_not_delivered', null, null, 'node_miss_do_background'],
  answer_refused: ['node_miss_refused', 'node_miss_refused_at', 'answeredAt', 'node_miss_do_use'],
  not_woken_inactive: ['node_miss_inactive', null, null, 'node_miss_do_open'],
  no_push_address: ['node_miss_no_address', null, null, 'node_miss_do_open_once'],
};

// A wake that reached this device and got no answer, by what the app reported of it later (`appOutcome`): why, in plain
// words, and what to do; the text after "and the app did not answer:". An answer the app sent is not said this way.
const WHY_TEXT = {
  not_opened_since_boot: 'node_miss_why_not_opened',
  swiped: 'node_miss_why_swiped',
  after_commit: 'node_miss_why_after_commit',
  answer_failed: 'node_miss_why_answer_failed',
  already_counted: 'node_miss_why_already_counted',
  no_key: 'node_miss_why_no_key',
};

const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// When block `target` is due, at one block a second from `height`.
const blockTime = (target, height, now) => now + (target - height) * 1000;

/**
 * Where the node runs, decided by the binding sequence (contract 4): 'here' (this device's binding `local` is the one the
 * network holds), 'linking' (a binding made here less than BIND_SETTLE_MS ago that two owners do not name yet),
 * 'elsewhere' (a newer binding holds a device), 'no_device' (no device is bound now) or 'unknown'. B is the binding
 * sequence two signed answers name alike (`bindingSeqAgreed`), D whether two owners say a device is bound
 * (`deviceBoundAgreed`). Without B (no signed answer, a refused key without a sequence, no network) a binding of this
 * device stands: the caller passes the last verdict read for that binding when it has one, and nothing else ever turns
 * it into elsewhere or no_device. Owners refusing this device's key, or a device tag of another key (`tagOurs`), decide
 * nothing here: the tag only asks for a new device key (nodeView `reenrol`).
 */
export function bindingVerdict(status, local, now = Date.now()) {
  const D = status.deviceBoundAgreed;
  if (!local) return D === true ? 'elsewhere' : (D === false ? 'no_device' : 'unknown');
  const B = Number.isSafeInteger(status.bindingSeqAgreed) ? status.bindingSeqAgreed : null;
  if (B === null) return 'here';
  const seq = Number.isSafeInteger(local.seq) ? local.seq : 0;
  if (B < seq) {
    const age = Number.isSafeInteger(local.boundAt) ? now - local.boundAt * 1000 : Infinity;
    if (age >= 0 && age < BIND_SETTLE_MS) return 'linking';
    return D === true ? 'elsewhere' : (D === false ? 'no_device' : 'here');
  }
  if (D === false) return 'no_device';
  return B === seq ? 'here' : 'elsewhere';
}

/** Whether this device answers for the node now (bindingVerdict 'here' or 'linking'). */
export function linkedHere(status, local, now = Date.now()) {
  const v = bindingVerdict(status, local, now);
  return v === 'here' || v === 'linking';
}

/**
 * Where the device check of a record that waits in `check_pending` (within its key rotation's grace) stands, so the tab
 * never says "still checking" for good: 'refused' when the network refused the check of this binding's re-send
 * (`check.refusal`, PushService.nodeCheckState); 'running' while the network names its next check (`refreshWindow`: a
 * lease to refresh, a daily recheck), while this device still has the binding to send again with a token
 * (`check.resending`), or within CHECK_RUNNING_MS of the binding (`boundAt`, Unix seconds: this device's, else the
 * network's); otherwise 'ended': the check ended with no verdict (no lease, nothing left to send), and only a new
 * enrolment (Use this device) can end the wait.
 */
export function checkState(signed, { local = null, check = null, now = Date.now() } = {}) {
  if (check && check.refusal) return 'refused';
  if (signed.refreshWindow) return 'running';
  if (check && check.resending) return 'running';
  const since = (local && local.boundAt) || signed.boundAt || null;
  return since !== null && now - since * 1000 < CHECK_RUNNING_MS ? 'running' : 'ended';
}

/**
 * The tab's state for a light node: `status` from LightNode.readNodeStatus (null before the first answer), `local`
 * this device's binding of the node, `pending` the QNet Link sheet's pending-link record, `check` what this device
 * knows of its device check beyond the status (PushService.nodeCheckState), `now` the clock (ms).
 * checking · unreachable · none · linking · not_recorded · here (with `online`, a device `notice`, `reenrol` and
 * `offerUse`) · elsewhere · no_device. Where the node runs comes from bindingVerdict alone; a binding made here that the
 * network has not taken yet, or a device the network linked less than an epoch ago that has not answered
 * (`device.state` other_device_pending), is `here` with the notice that it waits for its first answer. `reenrol`: two genesis nodes take device keys, and this device's binding holds
 * none (made before they did, or its key is gone: a reinstall, a restore, an iOS offload), or the node takes this
 * device's ping key while its owners name another device key (`tagOurs` false: a key this install no longer holds). Such
 * a binding gets no device signature on its replies, and nothing but Use this device, with one foreground
 * authentication, can give it a key (MN-2); until the network requires the device signature its replies still count,
 * so the notice is advice, never "not counted" (MN-R4-08). A pause with no end (`paused_until` null: the network revoked
 * the device's certificate chain) holds until a new enrolment with a new key, so it says the device cannot run the node
 * right now and offers Use this device too (node batch T3, T4). A record that waits in `check_pending` once the chain's
 * epoch (`height`, the block height the screen knows) is past its key rotation's due epoch plus the node's grace
 * (ROTATION_GRACE_EPOCHS: the 30 days the node still counts an unrotated key) waits for a new key: only a new key ends
 * that, and the app's own rotation did not (MN-R2-01), so the tab says so and offers Use this device too, which attests
 * a new key on every platform (PushService bindNow). Within the grace a `check_pending` record waits for something else
 * (a lapsed lease, a check), which a new key does not end (MN-R4-02): checkState says whether that check still runs,
 * ended with no verdict or was refused, and the last two offer Use this device, a new enrolment. `offerUse`: the tab
 * shows Use this device in this state, also under an answer the network refused in an epoch it did not count the node
 * in, with nothing counted since (missText). An expired link is `not_recorded` only on the network's word that the node is
 * not on the chain; with no verdict it is `unreachable`.
 */
export function nodeView({ status, local = null, pending = null, height = 0, check = null, now = Date.now() }) {
  if (!status) return { state: 'checking' };
  if (pending && status.onChain !== true) {
    if (!pending.expired) return { state: 'linking' };
    if (status.onChain === false) return { state: 'not_recorded' };
  }
  if (status.onChain === null) return { state: 'unreachable' };
  if (status.onChain === false) return { state: 'none' };
  const signed = status.signed || null;
  const verdict = bindingVerdict(status, local, now);
  if ((verdict === 'here' || verdict === 'linking') && !(signed && signed.deviceState === 'ended')) {
    let notice = null;
    const revoked = !!signed && signed.deviceState === 'paused' && signed.pausedUntil === null;
    const overdue = !!signed && signed.deviceState === 'check_pending' && Number.isSafeInteger(signed.rotationDue)
      && height > 0 && Math.floor(height / EPOCH_BLOCKS) > signed.rotationDue + ROTATION_GRACE_EPOCHS;
    let checkEnded = false;
    if (signed && signed.deviceState === 'pending_next_epoch') notice = { key: 'node_next_epoch', epoch: signed.effectiveEpoch };
    else if (overdue) notice = { key: 'node_key_overdue' };
    else if (signed && signed.deviceState === 'check_pending') {
      const where = checkState(signed, { local, check, now });
      checkEnded = where !== 'running';
      notice = { key: `node_check_${where}`, ...(where === 'refused' ? { reason: check.refusal.reason } : {}) };
    } else if (revoked) notice = { key: 'node_cant_run_now' };
    else if (signed && signed.deviceState === 'paused') notice = { key: 'node_paused', epoch: signed.pausedUntil };
    const reenrol = !!local && (local.hw !== true || status.tagOurs === false)
      && Array.isArray(status.features) && status.features.includes('device_v1');
    if (reenrol) notice = { key: 'node_device_again' };
    // Linked here and not counted yet: the network has not taken the binding, or the device has not answered since.
    const waiting = verdict === 'linking' || (!!status.device && status.device.state === 'other_device_pending');
    if (waiting && !notice) notice = { key: 'node_linked_waiting' };
    const miss = freshMiss(status);
    // A refused answer, or a wake this device could not answer for want of the node's key: Use this device mends both.
    const refused = !!miss && (miss.reason === 'answer_refused' || (miss.reason === 'woken_no_answer' && miss.appOutcome === 'no_key'));
    // "Online" only from the network's own verdict on this node's answers, never from anything else it reports.
    return {
      state: 'here', online: status.needsReactivation !== true, notice, reenrol,
      offerUse: reenrol || revoked || overdue || checkEnded || refused,
    };
  }
  if (verdict === 'unknown') return { state: 'checking' };
  // A device record that ended went with its binding: no device runs the node.
  if (verdict === 'here' || verdict === 'linking') return { state: 'no_device' };
  return { state: verdict };
}

/**
 * Whether the light card shows this wallet's light node on this device (owner, 11.10: one wallet, one node, shown only
 * where it runs): a node being linked here, or one this device holds a binding of that the network does not name as
 * another device's or none's. `light` null (nothing read yet) is still being checked. Otherwise the card says what a
 * wallet without a node says: a node on another device, unbound, or with no binding here is not this device's to show.
 */
export function lightShownHere(light, view) {
  if (!light) return true;
  if (view.state === 'elsewhere' || view.state === 'no_device') return false;
  if (view.state === 'linking' || view.state === 'not_recorded' || view.state === 'here') return true;
  return !!light.local || !!light.pending;
}

/**
 * The tab's sentence for a device that cannot run a node at all (NodeDeviceKey.checkDevice answered `capable: false`),
 * or null. Such a device keeps the whole wallet and is offered nothing to run.
 */
export function deviceText(t, device) {
  if (!device || device.capable !== false) return null;
  return t(device.reason === 'device_secondary_user' ? 'node_main_profile' : 'node_cant_run');
}

/** The text of the last refusal of "Use this device", or null. */
export function refusalText(t, refusal, now = Date.now()) {
  if (!refusal) return null;
  // The binding went out and nothing told whether the node took it: never "try again" as if nothing had changed.
  if (refusal.unknown === true) return t('node_use_unknown');
  const key = REFUSAL_TEXT[refusal.reason] || 'node_use_err_network';
  if (key === 'node_use_err_limit' && refusal.retryAfterSeconds) {
    return t('node_move_limit', { time: clock(now + refusal.retryAfterSeconds * 1000) });
  }
  return t(key);
}

/**
 * The one line under the status rows for the latest epoch the network did not count the node in (LightNode.shownMiss):
 * while nothing counted it since, and also after that when the record carries this device's own account of the wake,
 * which reaches the network only with a later answer; such a past one names its epoch first (`node_miss_past`) and the
 * day of a time not today. What happened, at the local time the owner noted where it noted one; how long the wake took to
 * reach this device where an answer told the owner (the push's own time on its way, apart from this app's handling of
 * it, so a late answer is shown to be the delivery's or not); and what the user can do. A wake with no answer that the
 * app's later answer accounted for says when it reached this device, how long after it was sent, and why the app did not
 * answer (reachedText); one the app answered says that the network did not count the answer; one the app's record shows
 * never reached this device says so (`not_delivered`). Null otherwise.
 */
export function missText(t, status, now = Date.now()) {
  const shown = shownMiss(status);
  const miss = shown ? shown.miss : null;
  const text = miss ? MISS_TEXT[miss.reason] : null;
  if (!text) return null;
  const stamp = (secs) => (shown.past && day(secs * 1000) !== day(now) ? `${day(secs * 1000)} ${clock(secs * 1000)}` : clock(secs * 1000));
  const line = (...parts) => [shown.past ? t('node_miss_past', { epoch: miss.epoch }) : null, ...parts].filter(Boolean).join(' ');
  if (miss.reason === 'woken_no_answer' && miss.appOutcome === 'answered') return line(t('node_miss_answered'));
  const why = miss.reason === 'woken_no_answer' ? WHY_TEXT[miss.appOutcome] : null;
  if (why) return line(reachedText(t, miss, t(why), stamp));
  const [untimed, timed, field, advice] = text;
  const at = field ? miss[field] : null;
  const what = Number.isSafeInteger(at) && at > 0 ? t(timed, { time: stamp(at) }) : t(untimed);
  const secs = miss.deliveryDelaySecs;
  const delay = !Number.isSafeInteger(secs) || secs < 0 ? null
    : (secs < 60 ? t('node_miss_delay_short') : t('node_miss_delay', { n: Math.round(secs / 60) }));
  return line(what, delay, t(advice));
}

// "The wake reached this device at {time}, {n} min after it was sent, and the app did not answer: {why}", with as much of
// the time as the owner could tell (`deliveredAt` on its own clock, as `stamp` writes it; `deliveryDelaySecs`).
function reachedText(t, miss, why, stamp) {
  const at = miss.deliveredAt;
  if (!Number.isSafeInteger(at) || at <= 0) return t('node_miss_reached', { why });
  const time = stamp(at);
  const secs = miss.deliveryDelaySecs;
  if (!Number.isSafeInteger(secs) || secs < 0) return t('node_miss_reached_at', { time, why });
  return secs < 60 ? t('node_miss_reached_soon', { time, why })
    : t('node_miss_reached_after', { time, n: Math.round(secs / 60), why });
}

function noticeText(t, notice, height, now) {
  if (!notice) return null;
  if (notice.key === 'node_next_epoch') {
    return Number.isSafeInteger(notice.epoch) && height > 0
      ? t('node_next_epoch', { time: clock(blockTime(notice.epoch * EPOCH_BLOCKS, height, now)) }) : t('node_check_running');
  }
  if (notice.key === 'node_paused') {
    const until = Number.isSafeInteger(notice.epoch) && height > 0 ? day(blockTime(notice.epoch * EPOCH_BLOCKS, height, now)) : '—';
    return t('node_paused', { date: until });
  }
  return t(notice.key);
}

function answeredText(t, answered, answeredAt, height) {
  const epoch = height > 0 ? Math.floor(height / EPOCH_BLOCKS) : null;
  const localHere = !!answeredAt && epoch !== null && answeredAt.epoch === epoch;
  if (answered === false || (answered === null && !localHere)) return t('node_answered_no');
  return localHere ? t('node_answered_yes', { time: clock(answeredAt.at) }) : t('node_answered_yes_untimed');
}

// The epoch clock, or null while no height is known (the row is left out rather than shown loading): about how long is
// left, at least a minute. At a block a second, the blocks left would only say the same in seconds.
function epochEndsText(t, height) {
  if (!(height > 0)) return null;
  const minutes = Math.max(1, Math.floor((EPOCH_BLOCKS - (height % EPOCH_BLOCKS)) / 60));
  const hours = Math.floor(minutes / 60);
  return t('node_about', { time: hours > 0 ? t('node_ago_hm', { h: hours, m: minutes % 60 }) : t('node_ago_m', { m: minutes }) });
}

// How long ago a node was last seen, in the language's own units: minutes (at least one), hours and minutes, or days
// and hours. Null for anything but a whole number of seconds.
export function agoText(t, seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  let time;
  if (seconds < 3600) time = t('node_ago_m', { m: Math.max(1, Math.round(seconds / 60)) });
  else if (seconds < 86400) time = t('node_ago_hm', { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) });
  else time = t('node_ago_d', { d: Math.floor(seconds / 86400), h: Math.floor((seconds % 86400) / 3600) });
  return t('node_last_seen_ago', { time });
}

/**
 * The status row of how much the system lets the app run in the background (services/BackgroundPriority), the same on
 * every phone and tablet: { key, tone, open } (`tone`: the row's colour, components/InfoRow TONES; `open`: the one button
 * to the system settings, shown only while it is restricted and the user can change it), or null while unknown.
 */
export function backgroundView(background) {
  if (!background || (background.priority !== 'unrestricted' && background.priority !== 'restricted')) return null;
  const free = background.priority === 'unrestricted';
  return {
    key: free ? 'node_background_unrestricted' : 'node_background_restricted',
    tone: free ? 'ok' : 'warn',
    open: !free && background.changeable === true,
  };
}

function balanceText(nano, hidden) {
  if (hidden) return '••••';
  // Not read yet, or no node answered: unknown, never "0 QNC".
  if (!Number.isFinite(nano) || nano < 0) return '—';
  const qnc = nano / ONE_QNC_NANO;
  return qnc === 0 ? '0 QNC' : `${qnc.toFixed(6).replace(/\.?0+$/, '')} QNC`;
}

// `waiting`: a super node registered and not admitted to consensus yet, which is neither online nor offline.
const Badge = ({ t, online, waiting = false }) => (
  <View style={[styles.statusBadge, online && !waiting ? styles.statusBadgeActivated : styles.statusBadgeInactive]}>
    <Text style={[styles.statusBadgeText, waiting ? { color: '#ff9500' } : !online && { color: '#ff3b30' }]}>
      {t(waiting ? 'node_badge_waiting' : (online ? 'node_badge_online' : 'node_badge_offline'))}
    </Text>
  </View>
);

const Button = ({ label, onPress, disabled, secondary, testID }) => (
  <TouchableOpacity
    style={[styles.button, secondary && styles.secondaryButton, disabled && styles.buttonDisabled]}
    disabled={!!disabled}
    onPress={onPress}
    accessibilityRole="button"
    testID={testID}
  >
    <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
  </TouchableOpacity>
);

// The node id at the head of its card, whole on one line; a tap copies a light node's (`onCopy`).
const NodeId = ({ t, nodeId, copied = false, onCopy = null }) => (
  <View style={styles.nodeIdBox}>
    <InfoField t={t} label={t('node_name')} value={nodeId} mono fit divider={false} onCopy={onCopy ? () => onCopy(nodeId) : null}
      copied={copied} copyTestID="node-id" />
  </View>
);

// The lines under a device check that did not end in counting (checkState 'ended' or 'refused'): why, when the network
// refused it, and on Android Google Play's licence, where the build carries its text, for a check that ended with no
// verdict or found the install not Google Play's. What the user can do is the card's own: Use this device.
function CheckLines({ t, notice, onPlayDialog }) {
  if (!notice || (notice.key !== 'node_check_ended' && notice.key !== 'node_check_refused')) return null;
  const why = notice.key === 'node_check_refused' ? refusalText(t, { reason: notice.reason }) : null;
  const play = !!onPlayDialog && hasKey('node_play_licence') && (notice.key === 'node_check_ended'
    || notice.reason === 'device_unlicensed' || notice.reason === 'device_app_unrecognized');
  return (
    <>
      {why ? <Text style={styles.rewardHint}>{why}</Text> : null}
      {play ? <Text style={styles.rewardHint}>{t('node_play_licence')}</Text> : null}
      {play ? <Button label={t('node_play_open')} onPress={() => onPlayDialog('licence')} secondary testID="node-play" /> : null}
    </>
  );
}

// Balance rows and the move button, the same for a light node and a server node. The button takes a balance of 1 QNC
// or more (the node refuses a smaller move), with no note about it (owner, 04.10). `alone`: the card holds nothing else.
// The wallet's move in transit (`move`, ClaimTransit.heldMove): the balance is its rest and the button, off, says
// "Moving X" until a certified read shows the wallet holds X, or a part of it (owner, 11.10 and 12.10).
function BalanceBlock({ t, balanceNano, hidden, moving, onMove, alone = false, move = null }) {
  const shownNano = move ? (move.restNano !== null ? move.restNano : Math.max(0, balanceNano - Number(move.amountNano))) : balanceNano;
  const known = Number.isFinite(shownNano) && shownNano >= 0;
  const movable = known && shownNano >= ONE_QNC_NANO;
  const label = move ? t('node_moving', { amount: balanceText(Number(move.amountNano), hidden) })
    : (moving ? t('claiming') : t('node_move'));
  return (
    <>
      <InfoRow label={t('node_balance')} value={balanceText(shownNano, hidden)} tone="accent" ltr fit divider={!alone} />
      <Button label={label} onPress={onMove} disabled={!movable || moving || !!move} testID="node-move" />
    </>
  );
}

// The light node on this device, or what a wallet without a node shows (lightShownHere: a node bound to another device,
// or to none, is not this device's to show, nor one aiqnet.io recorded that the network does not list yet).
// `showBalance` false: the server card above shows the wallet's node balance and its move (the same figure), so this
// card does not show it twice.
function LightNodeCard({
  t, light, height, balancesHidden, busy, refusal, copied, onMove, onUse, onCopy, onPlayDialog, onOpenBackground, now,
  transit = null, showBalance = true,
}) {
  const view = light ? nodeView({ ...light, height, now }) : { state: 'checking' };
  const nodeId = light ? light.nodeId : '';
  if (view.state === 'none' || !lightShownHere(light, view)) {
    return <View style={styles.emptyState}><Text style={styles.emptyText}>{t('node_none')}</Text></View>;
  }
  const move = heldMove(transit);
  // The balance stays on screen in every state of the node this device runs, so it never vanishes while the binding or
  // the network is unclear (owner, 05.10).
  const balance = nodeId && showBalance ? (
    <View style={styles.rewardsCard}>
      <BalanceBlock t={t} balanceNano={light.balanceNano} hidden={balancesHidden} moving={busy.move} onMove={onMove} alone
        move={move} />
    </View>
  ) : null;
  if (view.state === 'linking' || view.state === 'not_recorded') {
    // A registration on its way: no node on the chain yet, so nothing to move.
    const key = view.state === 'linking' ? 'node_linking' : 'node_link_failed';
    return <View style={styles.nodeMonitoringCard}><Text style={styles.nodeExplainer}>{t(key)}</Text></View>;
  }
  if (view.state === 'checking' || view.state === 'unreachable') {
    return (
      <View>
        <View style={styles.nodeMonitoringCard}>
          <Text style={styles.nodeExplainer}>{t(view.state === 'checking' ? 'node_checking' : 'node_unreachable')}</Text>
        </View>
        {balance}
      </View>
    );
  }
  // A device that cannot run a node at all is never told to register again: it says so, and offers nothing to press.
  const cant = view.offerUse ? deviceText(t, light.device) : null;
  const offerUse = view.offerUse && !cant;
  const notice = cant || noticeText(t, view.notice, height, now);
  const miss = missText(t, light.status, now);
  const background = backgroundView(light.background);
  return (
    <View>
      <View style={styles.nodeMonitoringCard}>
        <View style={styles.nodeMonitoringHeader}>
          <NodeId t={t} nodeId={nodeId} copied={copied === nodeId} onCopy={onCopy} />
          <Badge t={t} online={view.online} />
        </View>
        {notice ? <Text style={styles.rewardHint}>{notice}</Text> : null}
        {cant ? null : <CheckLines t={t} notice={view.notice} onPlayDialog={onPlayDialog} />}
        {offerUse ? <Button label={t('node_use')} onPress={onUse} disabled={busy.use} testID="node-use" /> : null}
        {offerUse && refusal ? <Text style={styles.rewardHint}>{refusalText(t, refusal, now)}</Text> : null}
      </View>
      <View style={styles.rewardsCard}>
        <Text style={styles.rewardsTitle}>{t('node_status')}</Text>
        {/* No device model and no count of epochs here: the site's node cabinet shows both (owner, 11.10). */}
        <InfoRow label={t('node_status_node')} value={t(view.online ? 'node_status_online' : 'node_status_offline')}
          tone={view.online ? 'ok' : 'warn'} divider={false} />
        <InfoRow label={t('node_answered')} value={answeredText(t, light.status.answered, light.answeredAt, height)} />
        {height > 0 && <InfoRow label={t('node_epoch_ends')} value={epochEndsText(t, height)} />}
        {background ? <InfoRow label={t('node_background')} value={t(background.key)} tone={background.tone} /> : null}
        {background && background.open && onOpenBackground ? (
          <Button label={t('node_background_open')} onPress={onOpenBackground} secondary testID="node-background" />
        ) : null}
        {miss ? <Text style={styles.rewardHint} testID="node-miss">{miss}</Text> : null}
        {showBalance ? (
          <BalanceBlock t={t} balanceNano={light.balanceNano} hidden={balancesHidden} moving={busy.move} onMove={onMove}
            move={move} />
        ) : null}
      </View>
    </View>
  );
}

/**
 * Whether the network registered a super node and does not admit it yet (owner, 11.10: registrations stay open while a
 * rule holds outside super nodes back): the node's own word in its status, its admission 'waiting' (the site's WAITING
 * state, node-view superState) or `consensus_admitted` false (PushService.checkServerNodeStatus). A node that says
 * nothing of it (every node before that rule) is not waiting.
 */
export function waitingAdmission(status) {
  return serverRegistered(status) && (status.admission === 'waiting' || status.consensusAdmitted === false);
}

/**
 * A super node's admission to the epoch's rewarded set as its status reports it (PushService `admission`), for the
 * card's row: 'admitted' or 'waiting' (registered, no super share while outside: waiting for network admission). null
 * when the node says nothing of it (an older node), says no admission rule governs the epoch ('not_required'), or for a
 * node the network does not list.
 */
export function rewardAdmission(status) {
  if (!serverRegistered(status)) return null;
  return status.admission === 'admitted' || status.admission === 'waiting' ? status.admission : null;
}

/** Whether a server node's status is one the network registered (its card then shows the node and its balance). */
export function serverRegistered(status) {
  return !!status && status.success === true && status.registered !== false;
}

/**
 * A server node's status after a read (`status`, for node `nodeId` when known): a good answer replaces what was shown;
 * a failed one keeps the last good status of the same node, marked `stale` (the card says the network could not be
 * reached above it, and keeps the balance and its move), so the card never turns into another one and back; with none,
 * the failure.
 */
export function keptServerStatus(prev, status, nodeId = null) {
  if (status && status.success === true) return status;
  if (prev && prev.success === true && (!nodeId || prev.nodeId === nodeId)) return prev.stale ? prev : { ...prev, stale: true };
  return status || { success: false, error: 'network' };
}

// A super or genesis node: it runs on its server, this device only shows it and moves its balance (S6), on every device
// that holds the wallet. `server` is { nodeType, nodeId, status, epochs } (epochs: PushService.getNodeEpochs, null
// while unknown), or null for a super node aiqnet.io recorded for the wallet that the network does not list yet
// (`recordedOnly`). Its id heads the card, as a light node's does, and its type is the first status row. One the
// network registered and does not admit yet (waitingAdmission) says so in place of Active or Offline, as the site does;
// what it earned moves all the same. An admitted one, when the node reports it (rewardAdmission), says so in a row of
// its own, and epochs outside the admitted set are counted apart from missed ones (PushService.getNodeEpochs
// notAdmitted). Before its first answer it is
// being checked; a read that failed with no good status before it says the network could not be reached; the server
// text alone is for a node the network says is not registered.
function ServerNodeCard({ t, server, height, balancesHidden, busy, onMove, nodeTitle, recordedOnly = false, transit = null }) {
  const { nodeType, nodeId, status, epochs } = server || { nodeType: 'super', nodeId: '', status: null, epochs: null };
  if (!serverRegistered(status)) {
    const waitText = recordedOnly ? null : (!status ? 'node_checking' : (status.success !== true ? 'node_unreachable' : null));
    if (waitText) {
      return (
        <View style={styles.nodeMonitoringCard}>
          <Text style={styles.nodeMonitoringTitle}>{nodeTitle(nodeType)}</Text>
          <Text style={styles.nodeExplainer}>{t(waitText)}</Text>
        </View>
      );
    }
    return (
      <View style={styles.nodeMonitoringCard}>
        <Text style={styles.nodeMonitoringTitle}>{nodeTitle(nodeType)}</Text>
        <View style={[styles.serverActivationNotice, { marginTop: 16 }]}>
          {recordedOnly ? <Text style={styles.serverActivationText}>{t('node_not_on_network_super')}</Text> : (
            <>
              <Text style={styles.serverActivationText}>{t('node_super_server')}</Text>
              <Text style={styles.serverActivationSubtext}>{t('node_super_server_sub')}</Text>
            </>
          )}
        </View>
      </View>
    );
  }
  // Last seen only from a node that saw it (an answer from a node that has it offline names no time).
  const seen = status.lastSeen > 0 ? agoText(t, status.lastSeenAgoSeconds) : null;
  const beats = Number.isSafeInteger(status.heartbeatCount) && Number.isSafeInteger(status.requiredHeartbeats);
  // Reputation is binary: only the permanent ban for proven equivocation is worth a row, its reason under it.
  const banned = status.reputation != null && status.reputation < 70;
  const waiting = waitingAdmission(status);
  const statusText = waiting ? t('node_waiting_admission') : t(status.isOnline ? 'node_active' : 'node_server_offline');
  const admission = rewardAdmission(status);
  return (
    <View>
      <View style={styles.nodeMonitoringCard}>
        <View style={styles.nodeMonitoringHeader}>
          {nodeId ? <NodeId t={t} nodeId={nodeId} />
            : <Text style={styles.nodeMonitoringTitle}>{nodeTitle(nodeType)}</Text>}
          <Badge t={t} online={!!status.isOnline} waiting={waiting} />
        </View>
        {/* The last good status, kept while a read fails (keptServerStatus): said, never swapped for another card. */}
        {status.stale ? <Text style={styles.rewardHint} testID="node-server-stale">{t('node_unreachable')}</Text> : null}
      </View>
      <View style={styles.rewardsCard}>
        <Text style={styles.rewardsTitle}>{t('node_status')}</Text>
        {nodeId ? <InfoRow label={t('node_type')} value={nodeTitle(nodeType)} divider={false} /> : null}
        {/* The waiting sentence is too long to share a line with its label in most languages: it goes under it, whole. */}
        {waiting ? <InfoField label={t('node_status_node')} value={statusText} tone="warn" divider={!!nodeId} /> : (
          <InfoRow label={t('node_status_node')} value={statusText} tone={status.isOnline ? 'ok' : 'bad'} divider={!!nodeId} />
        )}
        {seen ? <InfoRow label={t('node_last_seen')} value={seen} /> : null}
        {/* The super node's admission when it reports it admitted; waiting is the node's status above. */}
        {admission === 'admitted' ? <InfoRow label={t('node_admission')} value={t('node_admission_admitted')} tone="ok" /> : null}
        {beats ? (
          <InfoRow label={t('node_heartbeats')} value={t('node_heartbeats_of', { n: status.heartbeatCount, m: status.requiredHeartbeats })} />
        ) : null}
        {/* Over the last 64 epochs the network settled, from the node's registration on (PushService.getNodeEpochs); the
            count of epochs is the site's (owner, 11.10). */}
        {epochs ? <InfoRow label={t('node_missed')} value={String(epochs.missed)} tone={epochs.missed > 0 ? 'warn' : 'default'} /> : null}
        {/* Epochs outside the admitted set are the network's admission, never missed ones: counted apart, when any. */}
        {epochs && epochs.notAdmitted > 0 ? <InfoRow label={t('node_not_admitted')} value={String(epochs.notAdmitted)} /> : null}
        {(height || status.currentBlockHeight) > 0 && (
          <InfoRow label={t('node_epoch_ends')} value={epochEndsText(t, height || status.currentBlockHeight)} />
        )}
        {banned ? <InfoRow label={t('node_reputation')} value={t('node_banned')} tone="bad" /> : null}
        {banned ? <Text style={styles.rewardHint}>{t('node_banned_hint')}</Text> : null}
        <BalanceBlock t={t} balanceNano={status.pendingRewards} hidden={balancesHidden} moving={busy.move} onMove={onMove}
          move={heldMove(transit)} />
      </View>
    </View>
  );
}

// The light card's states that show a node of this wallet on this device (being linked here, or bound here): the ones a
// wallet with a server node shows under the server card.
const LIGHT_NODE_STATES = new Set(['linking', 'not_recorded', 'here']);

/**
 * The tab's content under its title. `server` ({ nodeType, nodeId, status, epochs }) when this wallet has a super or
 * genesis node; `light` ({ nodeId, status, local, pending, check, answeredAt, background, balanceNano, device }), `device`
 * being NodeDeviceKey.checkDevice's answer or null while unknown, `background` BackgroundPriority.readBackground's (the
 * Background row, and `onOpenBackground` its button to the system settings). The light card shows the light node only on
 * the device it is bound to (lightShownHere); with a server node it shows only then (both on the chain: the server card
 * first). `recorded` ('light' | 'super' | null): the node type aiqnet.io recorded for this wallet that the network does
 * not list yet (NodeRecordRead.pendingNodeType); only a super node's is said. `transit`: the moves of a node balance in
 * transit (services/ClaimTransit). `onMove` moves the light node's balance, `onMoveServer` the server node's.
 */
export default function NodeTab({
  t, server = null, light, recorded = null, height = 0, balancesHidden = false, busy = {}, refusal = null, copied = '',
  onMove, onMoveServer = null, onUse, onCopy, onPlayDialog = null, onOpenBackground = null, nodeTitle, now = Date.now(),
  transit = null,
}) {
  const b = { move: !!busy.move, use: !!busy.use };
  const serverCard = !!server || recorded === 'super';
  // The node balance is the wallet's: with a registered server node it is shown, and moved, on the server card only.
  const serverBalance = !!server && recorded !== 'super' && serverRegistered(server.status);
  const lightCard = (
    <LightNodeCard t={t} light={light} height={height} balancesHidden={balancesHidden} busy={b} refusal={refusal}
      copied={copied} onMove={onMove} onUse={onUse} onCopy={onCopy} onPlayDialog={onPlayDialog}
      onOpenBackground={onOpenBackground} now={now} transit={transit} showBalance={!(serverCard && serverBalance)} />
  );
  const lightView = light ? nodeView({ ...light, height, now }) : { state: 'checking' };
  const lightHere = LIGHT_NODE_STATES.has(lightView.state) && lightShownHere(light, lightView);
  return (
    <View>
      <Text style={styles.tabTitle}>{t('node_title')}</Text>
      {serverCard ? (
        <ServerNodeCard t={t} server={server} height={height} balancesHidden={balancesHidden} busy={b}
          onMove={onMoveServer || onMove} nodeTitle={nodeTitle} recordedOnly={recorded === 'super'} transit={transit} />
      ) : lightCard}
      {serverCard && lightHere ? <View style={{ marginTop: 16 }}>{lightCard}</View> : null}
    </View>
  );
}
