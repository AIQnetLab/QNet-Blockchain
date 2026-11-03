/**
 * The Node tab (plan-mobile 3.2, unified plan 3.1): this wallet's node as the network records it, and what this device
 * can do about it here: keep it running (Use this device, where the card offers it) and move its balance into the
 * wallet. One wallet, one node: a light node runs only on the device it is bound to; on another device the
 * tab names that device, the node's status, its last counted epoch and the node balance with its move, and offers
 * nothing to run it here; bound to none, it says what it says for a wallet without a node: that it has
 * none, then QNet Blockchain's two kinds of node on a card each, a light node in QNet Wallet and a super node on a server
 * (binding is done on aiqnet.io; the tab names neither it nor activation). Before
 * the first answer, and while no verdict came for a node this device holds nothing of, it names no kind of node and
 * never says the wallet has none: that takes two owners' word on its light node and two genesis nodes' word that the
 * wallet has no node at all (`walletNode` 'none'). It stops running on a device only on a request the user
 * confirms on that device's QNet Link sheet (`unlink`, which the device's own key signs), when another device takes it
 * over, or with the wallet's deletion: the tab has no button for it (owner, 30.09). A super node runs on its server and
 * shows on every device that holds the wallet: its card only shows it (status, last seen, heartbeats, missed epochs, the
 * balance) and moves its balance; a super node the network registered but does not admit to consensus yet says so,
 * never Offline. A wallet with a super and a light node on the chain (an older wallet) shows both
 * cards, the server's first, and the node balance (the wallet's, whichever node id is asked) with its move once, on the
 * server card. A super node aiqnet.io recorded for a wallet two genesis nodes say has no node is said as such. A move
 * of the wallet's node balance in transit (services/ClaimTransit) shows as "Moving X" with the rest of the balance, and
 * holds every move button.
 * Each node is two sections: its identity (type, name, status chip), then its status, with the node balance and its
 * move at the foot.
 * The same states, texts and buttons on every phone and tablet; no link or pointer to any other place. `nodeView`
 * derives the state from the status alone, so it is tested without the screen.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { hasKey } from '../i18n';
import { InfoRow } from '../components/InfoRow';
import Action from '../components/ui/Action';
import Copyable from '../components/ui/Copyable';
import Head from '../components/ui/Head';
import Section from '../components/ui/Section';
import Status from '../components/ui/Status';
import { bindingVerdict, freshMiss, serverRegistered, serverStatusNames } from '../services/LightNode';
import { heldMove } from '../services/ClaimTransit';
import { amountText, qncText } from '../utils/amountFormat';
import { masked } from '../utils/privacy';
import { reasonText } from '../utils/bindRefusal';
import { clock, day } from '../utils/timeText';
import styles from './WalletScreen.styles';

const EPOCH_BLOCKS = 14400;
const ONE_QNC_NANO = 1e9;
// The node counts a device whose key rotation fell due for this many epochs more (30 days; light_device
// ROTATION_GRACE_EPOCHS), then holds it in check_pending until a new key comes.
export const ROTATION_GRACE_EPOCHS = 180;
// How long after a binding its device check still reads as running with nothing else to say so: the network rechecks
// a record that waits once a day (light-node-messages section 8).
export const CHECK_RUNNING_MS = 24 * 3600 * 1000;

// When block `target` is due, at one block a second from `height`.
const blockTime = (target, height, now) => now + (target - height) * 1000;

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
 * `offerUse`) · elsewhere (elsewhereView) · no_device. Where the node runs comes from bindingVerdict alone; a binding made here that the
 * network has not taken yet, or a device that has not answered since the network linked it (`device.state`
 * other_device_pending), is `here` with the notice that it waits for its first answer. `reenrol`: two genesis nodes take device keys, and this device's binding holds
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
 * in, with nothing counted since (LightNode.freshMiss). An expired link is `not_recorded` only on the network's word that the node is
 * not on the chain; with no verdict it is `unreachable`.
 */
export function nodeView({ status, local = null, pending = null, height = 0, check = null, now = Date.now() }) {
  if (!status) return { state: 'checking' };
  if (pending && status.onChain !== true) {
    // `pooled`: the registration is in the genesis nodes' pool, on its way into a block.
    if (!pending.expired) return status.registrationPending === true ? { state: 'linking', pooled: true } : { state: 'linking' };
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
    // A binding not this device's yet (`unconfirmed`) has no device key to ask about.
    const reenrol = !!local && local.unconfirmed !== true && (local.hw !== true || status.tagOurs === false)
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
  return verdict === 'elsewhere' ? elsewhereView(status) : { state: verdict };
}

/**
 * The node on another device as the network records it: that device's `model`, `online` by the network's verdict,
 * `waiting` while the device has not answered since it was linked, and `stopped` (Offline otherwise: not woken
 * again until QNet Wallet is opened there).
 */
function elsewhereView(status) {
  const device = status.device || null;
  const online = status.needsReactivation !== true;
  const waiting = !!device && device.state === 'other_device_pending';
  return { state: 'elsewhere', online, model: device ? device.model : null, waiting, stopped: !online && !waiting };
}

/**
 * Whether the light card shows this wallet's light node on this device (owner, 11.10: one wallet, one node, shown only
 * where it runs): a node being linked here, or one this device holds a binding of that the network does not name as
 * another device's or none's. `light` null (nothing read yet) is still being checked. A node on another device, unbound,
 * or with no binding here is not this device's to show: the card says where it runs (ElsewhereCard), or NoNode, or,
 * while no verdict came, that it is being checked or could not be read (Unsettled).
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
  return reasonText(t, refusal, now) || t('node_use_err_network');
}

// What the tab says for a wallet without a node (two genesis nodes say so), and the same for a light node on no device:
// that the wallet has none, then the two kinds of node QNet Blockchain has, each on its own card with where it runs.
function NoNode({ t }) {
  return (
    <View testID="node-none">
      <Text style={styles.nodeExplainer}>{t('node_none')}</Text>
      <Section title={t('node_title_light')} testID="node-none-light">
        <Text style={styles.nodeExplainer}>{t('node_light_device')}</Text>
      </Section>
      <Section title={t('node_title_super')} testID="node-none-super">
        <Text style={styles.nodeExplainer}>{t('node_super_server')}</Text>
      </Section>
    </View>
  );
}

// Before a verdict, for a node this device holds nothing of: the wallet may have none, so no kind of node is named, and
// a status that could not be read is never said as no node.
function Unsettled({ t, unreachable = false }) {
  return (
    <Section testID={unreachable ? 'node-unreachable' : 'node-checking'}>
      <Text style={styles.nodeExplainer}>{t(unreachable ? 'node_unreachable' : 'node_checking')}</Text>
    </Section>
  );
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

// Whether this device's node answered in the current epoch: the network's word, or this device's own answer in it.
function answeredNow(answered, answeredAt, height) {
  const epoch = height > 0 ? Math.floor(height / EPOCH_BLOCKS) : null;
  const localHere = !!answeredAt && epoch !== null && answeredAt.epoch === epoch;
  return { yes: !(answered === false || (answered === null && !localHere)), localHere };
}

function answeredText(t, answered, answeredAt, height) {
  const { yes, localHere } = answeredNow(answered, answeredAt, height);
  if (!yes) return t('node_answered_no');
  return localHere ? t('node_answered_yes', { time: clock(answeredAt.at) }) : t('node_answered_yes_untimed');
}

// The epoch so far as a bar, and where it stands now as a mark: Signal once the node answered in it, Fog before
// (`answered` null: no mark, a server node's). Drawn only with a known height; the rows under it say the same in words.
function EpochBar({ height, answered = null }) {
  if (!(height > 0)) return null;
  const done = Math.min(100, ((height % EPOCH_BLOCKS) / EPOCH_BLOCKS) * 100);
  return (
    <View style={styles.epochBar} testID="node-epoch-bar" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.epochFill, answered === true && styles.epochFillYes, { width: `${done}%` }]} />
      {answered === null ? null : (
        <View style={[styles.epochMark, answered ? styles.epochMarkYes : styles.epochMarkNo, { start: `${done}%` }]}
          testID={answered ? 'node-epoch-answered' : 'node-epoch-waiting'} />
      )}
    </View>
  );
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

// A node's first section, its identity: its status as a chip (live while it runs, Ember when it is offline or waits
// for admission) before its type, and under them its whole name on one line, shrunk to fit, never cut, copied whole by a
// tap as every value is; masked in the same line while the user hides node names (utils/privacy).
function Identity({ t, title, nodeId = '', tone = null, label = null, hideName = false }) {
  const name = masked(nodeId, hideName);
  return (
    <Section testID="node-identity">
      <View style={styles.nodeHead}>
        <View style={styles.nodeHeadRow} testID="node-head-row">
          {label ? (
            <View style={[styles.nodeChip, tone === 'live' ? styles.nodeChipLive : styles.nodeChipNeeds]}>
              <Status tone={tone} label={label} testID="node-status" />
            </View>
          ) : null}
          <Text style={styles.nodeMonitoringTitle}>{title}</Text>
        </View>
        {nodeId ? (
          <Copyable text={nodeId} scale={false} t={t} accessibilityLabel={`${t('node_name')} ${name}`} testID="node-id-copy">
            <Text style={styles.nodeName} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} maxFontSizeMultiplier={1.2}
              testID="node-id">{name}</Text>
          </Copyable>
        ) : null}
      </View>
    </Section>
  );
}

// A node's second section: what the network says of the node under the kicker Status, the balance and its move last.
function StatusSection({ t, children }) {
  return <Section title={t('node_status')} testID="node-status-section">{children}</Section>;
}

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
      {play ? <Action kind="text" label={t('node_play_open')} onPress={() => onPlayDialog('licence')} testID="node-play" /> : null}
    </>
  );
}

// The node balance (the status section's last row) and its move button: 1 QNC or more moves (the node refuses less),
// the figure in Signal while it can; a move in transit (`move`, ClaimTransit.heldMove) shows the rest and "Moving X".
// `second`: Use this device is the step to do now, so the move is the secondary action.
function BalanceRows({ t, balanceNano, hidden, moving, onMove, move = null, second = false }) {
  const shownNano = move ? (move.restNano !== null ? move.restNano : Math.max(0, balanceNano - Number(move.amountNano))) : balanceNano;
  const known = Number.isFinite(shownNano) && shownNano >= 0;
  const movable = known && shownNano >= ONE_QNC_NANO;
  const label = move ? t('node_moving', { amount: qncText(move.amountNano, hidden) })
    : (moving ? t('claiming') : t('node_move'));
  const canMove = movable && !moving && !move;
  return (
    <>
      <InfoRow label={t('node_balance')} value={qncText(shownNano, hidden)} tone={canMove ? 'accent' : 'default'} ltr fit
        testID="node-balance" />
      <Action kind={second ? 'text' : 'solid'} label={label} onPress={onMove} disabled={!canMove} style={styles.nodeMove}
        testID="node-move" />
    </>
  );
}

// This wallet's light node on another device: which device runs it, its status, why it is Offline when the network
// stopped waking it, its last counted epoch and the wallet's node balance unless a server node's card above shows it;
// no Use this device. With no model in the status the line says it may be this device before a reinstall.
function ElsewhereCard({ t, view, light, title, namesHidden, balancesHidden, busy, onMove, move, showBalance }) {
  const last = light.status.counted ? light.status.counted.last : undefined;
  const stopped = view.model ? t('node_elsewhere_stopped', { model: view.model }) : t('node_elsewhere_stopped_device');
  return (
    <View>
      <Identity t={t} title={title} nodeId={light.nodeId} hideName={namesHidden}
        tone={view.online ? 'live' : 'needs'} label={t(view.online ? 'node_status_online' : 'node_status_offline')} />
      <StatusSection t={t}>
        <Text style={styles.nodeExplainer} testID="node-elsewhere">
          {view.model ? t('node_runs_on', { model: view.model }) : t('node_elsewhere')}
        </Text>
        {view.stopped ? <Text style={[styles.nodeNote, styles.statusNeeds]} testID="node-elsewhere-stopped">{stopped}</Text> : null}
        {view.waiting ? <Text style={styles.nodeNote}>{t('node_elsewhere_waiting')}</Text> : null}
        {last !== undefined ? (
          <InfoRow label={t('node_last_counted')} divider={false} testID="node-last-counted"
            value={last === null ? t('node_counted_none') : t('node_epoch_n', { epoch: amountText(String(last)) })} />
        ) : null}
        {showBalance ? (
          <BalanceRows t={t} balanceNano={light.balanceNano} hidden={balancesHidden} moving={busy.move} onMove={onMove} move={move} />
        ) : null}
      </StatusSection>
    </View>
  );
}

// The light node on this device, or what the tab says for a node that is not this device's to show (lightShownHere: a
// node linked to another device is ElsewhereCard; one on no device, or none, is NoNode). Before a verdict nothing names a
// kind of node for a node this device holds nothing of: the wallet may have none (Unsettled). No light node on the chain
// is NoNode only once two genesis nodes say the wallet has no node at all (`walletNone`), Unsettled until then.
// `showBalance` false: the server card above shows the wallet's node balance and its move (the same figure), so this
// card does not show it twice.
function LightNodeCard({
  t, light, height, balancesHidden, namesHidden, busy, refusal, onMove, onUse, onPlayDialog, onOpenBackground, now,
  nodeTitle, transit = null, showBalance = true, walletNone = false,
}) {
  if (!light) return <Unsettled t={t} />;
  const view = nodeView({ ...light, height, now });
  const nodeId = light.nodeId;
  const move = heldMove(transit);
  const title = nodeTitle('light');
  if (view.state === 'elsewhere') {
    return (
      <ElsewhereCard t={t} view={view} light={light} title={title} namesHidden={namesHidden} balancesHidden={balancesHidden}
        busy={busy} onMove={onMove} move={move} showBalance={showBalance} />
    );
  }
  const shownHere = lightShownHere(light, view);
  if (!shownHere && (view.state === 'checking' || view.state === 'unreachable')) {
    return <Unsettled t={t} unreachable={view.state === 'unreachable'} />;
  }
  if (view.state === 'none' && !walletNone) return <Unsettled t={t} />;
  if (view.state === 'none' || !shownHere) return <NoNode t={t} />;
  if (view.state === 'linking' || view.state === 'not_recorded') {
    // A registration on its way: no node on the chain yet, so nothing to move. In the pool, it says so.
    const key = view.state === 'not_recorded' ? 'node_link_failed' : (view.pooled ? 'node_linking_pool' : 'node_linking');
    return (
      <View>
        <Identity t={t} title={title} />
        <StatusSection t={t}><Text style={styles.nodeExplainer}>{t(key)}</Text></StatusSection>
      </View>
    );
  }
  if (view.state === 'checking' || view.state === 'unreachable') {
    // The balance stays on screen in every state of the node this device runs, so it never vanishes while the binding or
    // the network is unclear.
    return (
      <View>
        <Identity t={t} title={title} />
        <StatusSection t={t}>
          <Text style={styles.nodeExplainer}>{t(view.state === 'checking' ? 'node_checking' : 'node_unreachable')}</Text>
          {nodeId && showBalance ? (
            <BalanceRows t={t} balanceNano={light.balanceNano} hidden={balancesHidden} moving={busy.move} onMove={onMove} move={move} />
          ) : null}
        </StatusSection>
      </View>
    );
  }
  // A device that cannot run a node at all is never told to register again: it says so, and offers nothing to press.
  const cant = view.offerUse ? deviceText(t, light.device) : null;
  const offerUse = view.offerUse && !cant;
  const notice = cant || noticeText(t, view.notice, height, now);
  const background = backgroundView(light.background);
  const answered = answeredNow(light.status.answered, light.answeredAt, height).yes;
  return (
    <View>
      <Identity t={t} title={title} nodeId={nodeId} hideName={namesHidden}
        tone={view.online ? 'live' : 'needs'} label={t(view.online ? 'node_status_online' : 'node_status_offline')} />
      <StatusSection t={t}>
        {/* No device model and no count of epochs here: the site's node cabinet shows both (owner, 11.10). */}
        <EpochBar height={height} answered={answered} />
        <InfoRow label={t('node_answered')} value={answeredText(t, light.status.answered, light.answeredAt, height)} divider={false} />
        {height > 0 && <InfoRow label={t('node_epoch_ends')} value={epochEndsText(t, height)} />}
        {/* In Mint while the system lets the app run in the background unrestricted, in Ember while it restricts it. */}
        {background ? (
          <InfoRow label={t('node_background')} value={t(background.key)} tone={background.tone} testID="node-background-value" />
        ) : null}
        {/* What needs care, in the same section: the one way to lift the system's restriction. */}
        {background && background.open && onOpenBackground ? (
          <Action kind="secondary" label={t('node_background_open')} onPress={onOpenBackground} style={styles.nodeCare}
            testID="node-background" />
        ) : null}
        {notice ? <Text style={[styles.nodeNote, offerUse && styles.statusNeeds]}>{notice}</Text> : null}
        {cant ? null : <CheckLines t={t} notice={view.notice} onPlayDialog={onPlayDialog} />}
        {offerUse ? <Action label={t('node_use')} onPress={onUse} disabled={busy.use} style={styles.nodeCare} testID="node-use" /> : null}
        {offerUse && refusal ? <Text style={styles.rewardHint}>{refusalText(t, refusal, now)}</Text> : null}
        {showBalance ? (
          <BalanceRows t={t} balanceNano={light.balanceNano} hidden={balancesHidden} moving={busy.move} onMove={onMove}
            move={move} second={offerUse} />
        ) : null}
      </StatusSection>
    </View>
  );
}

/**
 * Whether the network registered a super node and does not admit it to consensus yet (owner, 11.10: registrations stay
 * open while a rule holds outside super nodes back): the node's own word in its status, its admission 'waiting'
 * (registration.rs super_admission_label: outside the epoch's consensus-admitted set; the site's WAITING state). A node
 * that says nothing of it (every node before that rule) is not waiting.
 */
export function waitingAdmission(status) {
  return serverRegistered(status) && status.admission === 'waiting';
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

/**
 * The server card's status after `answer`, for `nodeId`, the node the genesis nodes name for the wallet (walletNode):
 * only an answer that names that node registered replaces what is shown. Anything else (not registered,
 * no node or another node named, a failure, a timeout) keeps the last good status of that node, marked `stale` (the
 * card says the network could not be reached above it and keeps the balance and its move); with none, null (still
 * being checked) after an answer, the failure after a failed read. Another node's status is never shown.
 */
export function serverStatusAfter(prev, answer, nodeId) {
  if (serverStatusNames(answer, nodeId)) return answer;
  if (serverStatusNames(prev, nodeId)) return prev.stale ? prev : { ...prev, stale: true };
  return answer && answer.success === true ? null : { success: false, error: 'network' };
}

// A super or genesis node: it runs on its server, this device only shows it and moves its balance (S6), on every device
// that holds the wallet. `server` is { nodeType, nodeId, status, epochs } (epochs: PushService.getNodeEpochs, null
// while unknown), or null for a super node aiqnet.io recorded for a wallet two genesis nodes say has no node
// (`recordedOnly`). Its type and id head the card, as a light node's do, its status in a word under them. One the
// network registered and does not admit yet (waitingAdmission) says so in place of Active or Offline, as the site does;
// what it earned moves all the same. An admitted one, when the node reports it (rewardAdmission), says so in a row of
// its own, and its epochs outside the admitted set are counted (PushService.getNodeEpochs notAdmitted); no missed epoch
// is shown, the site's cabinet shows them. Until a good status of the node it is being checked, and a read that failed
// says the network could not be reached (serverStatusAfter).
function ServerNodeCard({
  t, server, height, balancesHidden, namesHidden, busy, onMove, nodeTitle, recordedOnly = false, transit = null,
}) {
  const { nodeType, nodeId, status, epochs } = server || { nodeType: 'super', nodeId: '', status: null, epochs: null };
  if (!serverRegistered(status)) {
    const text = recordedOnly ? 'node_not_on_network_super'
      : (status && status.success !== true ? 'node_unreachable' : 'node_checking');
    return (
      <View>
        <Identity t={t} title={nodeTitle(nodeType)} />
        <StatusSection t={t}>
          <Text style={styles.nodeExplainer}>{t(text)}</Text>
        </StatusSection>
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
      <Identity t={t} title={nodeTitle(nodeType)} nodeId={nodeId} hideName={namesHidden}
        tone={status.isOnline && !waiting ? 'live' : 'needs'} label={statusText} />
      <StatusSection t={t}>
        {/* The last good status, kept while no answer names the node registered (serverStatusAfter): said, never
            swapped for another card. */}
        {status.stale ? <Text style={styles.rewardHint} testID="node-server-stale">{t('node_unreachable')}</Text> : null}
        <EpochBar height={height || status.currentBlockHeight} />
        {seen ? <InfoRow label={t('node_last_seen')} value={seen} divider={false} /> : null}
        {/* The super node's admission when it reports it admitted; waiting is the node's status above. */}
        {admission === 'admitted' ? <InfoRow label={t('node_admission')} value={t('node_admission_admitted')} tone="ok" /> : null}
        {beats ? (
          <InfoRow label={t('node_heartbeats')} value={t('node_heartbeats_of', { n: status.heartbeatCount, m: status.requiredHeartbeats })} />
        ) : null}
        {/* Of the last 64 epochs the network settled, from the node's registration on (PushService.getNodeEpochs): the
            ones outside the admitted set (the network's admission, not missed heartbeats), when any. */}
        {epochs && epochs.notAdmitted > 0 ? <InfoRow label={t('node_not_admitted')} value={String(epochs.notAdmitted)} /> : null}
        {(height || status.currentBlockHeight) > 0 && (
          <InfoRow label={t('node_epoch_ends')} value={epochEndsText(t, height || status.currentBlockHeight)} />
        )}
        {banned ? <InfoRow label={t('node_reputation')} value={t('node_banned')} tone="bad" /> : null}
        {banned ? <Text style={styles.rewardHint}>{t('node_banned_hint')}</Text> : null}
        <BalanceRows t={t} balanceNano={status.pendingRewards} hidden={balancesHidden} moving={busy.move} onMove={onMove}
          move={heldMove(transit)} />
      </StatusSection>
    </View>
  );
}

// The light card's states that show a node of this wallet on this device (being linked here, or bound here).
const LIGHT_NODE_STATES = new Set(['linking', 'not_recorded', 'here']);

/**
 * Whether the light card shows this wallet's light node (`light`, `view` its nodeView), on this device (lightShownHere)
 * or on another one (ElsewhereCard): the card a server node's card has under it, and the one the screen reads again.
 */
export function lightNodeShown(light, view) {
  return view.state === 'elsewhere' || (LIGHT_NODE_STATES.has(view.state) && lightShownHere(light, view));
}

/**
 * The tab's content under its title. `walletNode`: the wallet's node as the genesis nodes name it (WalletScreen
 * loadWalletNode), { nodeId, nodeType }, 'none' once two say the wallet has no node, null while unknown. `server`
 * ({ nodeType, nodeId, status, epochs }) when that is a super or genesis node; `light` ({ nodeId, status, local, pending,
 * check, answeredAt, background, balanceNano, device }), `device`
 * being NodeDeviceKey.checkDevice's answer or null while unknown, `background` BackgroundPriority.readBackground's (the
 * Background row, and `onOpenBackground` its button to the system settings). The light card shows the light node only on
 * the device it is bound to (lightShownHere), and elsewhere which device runs it; with a server node it shows only
 * then, under the server card. `recorded` ('light' | 'super' | null): the node type aiqnet.io recorded for this wallet
 * that the network does not list yet (NodeRecordRead.pendingNodeType); only a super node's is said, and only with
 * `walletNode` 'none'. `transit`: the
 * moves of a node balance in transit (services/ClaimTransit). `onMove` moves the light node's balance, `onMoveServer` the server node's.
 * `balancesHidden` and `namesHidden` mask the amounts and the node names (utils/privacy).
 * `showHead` false: the screen pins the tab's title above its scroll itself.
 */
export default function NodeTab({
  t, server = null, light, walletNode = null, recorded = null, height = 0, balancesHidden = false, namesHidden = false,
  busy = {}, refusal = null, onMove, onMoveServer = null, onUse, onPlayDialog = null, onOpenBackground = null, nodeTitle,
  now = Date.now(), transit = null, showHead = true,
}) {
  const b = { move: !!busy.move, use: !!busy.use };
  const walletNone = walletNode === 'none';
  const recordedOnly = !server && walletNone && recorded === 'super';
  const serverCard = !!server || recordedOnly;
  // The node balance is the wallet's: with a registered server node it is shown, and moved, on the server card only.
  const serverBalance = !!server && serverRegistered(server.status);
  const lightCard = (
    <LightNodeCard t={t} light={light} height={height} balancesHidden={balancesHidden} namesHidden={namesHidden} busy={b} refusal={refusal}
      onMove={onMove} onUse={onUse} onPlayDialog={onPlayDialog} nodeTitle={nodeTitle} walletNone={walletNone}
      onOpenBackground={onOpenBackground} now={now} transit={transit} showBalance={!serverBalance} />
  );
  const lightView = light ? nodeView({ ...light, height, now }) : { state: 'checking' };
  const lightUnder = lightNodeShown(light, lightView);
  return (
    <View>
      {showHead ? <Head title={t('node_title')} /> : null}
      {serverCard ? (
        <ServerNodeCard t={t} server={server} height={height} balancesHidden={balancesHidden} namesHidden={namesHidden} busy={b}
          onMove={onMoveServer || onMove} nodeTitle={nodeTitle} recordedOnly={recordedOnly} transit={transit} />
      ) : lightCard}
      {serverCard && lightUnder ? <View style={styles.nodeSecond}>{lightCard}</View> : null}
    </View>
  );
}
