/**
 * The Node tab (plan-mobile 3.2, unified plan 3.1): this wallet's node as the network records it, the same states,
 * texts and buttons on every phone and tablet. The state comes from the status alone (NodeTab.nodeView), and the
 * status from the node's shard owners, two of which must agree (LightNode.readNodeStatus).
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import NodeTab, {
  nodeView, linkedHere, bindingVerdict, refusalText, deviceText, agoText, checkState, CHECK_RUNNING_MS,
} from '../src/screens/NodeTab';
import {
  readNodeStatus, agreedFeatures, readLinkPending, BIND_SETTLE_MS, LINK_PENDING_KEY,
} from '../src/services/LightNode';
import { lightShardOwnerUrls } from '../src/config/nodes';
import { hasKey, makeT } from '../src/i18n';

const AsyncStorage = require('@react-native-async-storage/async-storage');

const NODE = 'light_mobile_83afab763b9058fd'; // shard 3: owners 004, 005, 001
const t = makeT('en');
// Two owners' device-bound answer follows the first owner's unless a test names it (`deviceBoundAgreed`).
const status = (over = {}) => {
  const s = {
    reachable: true, onChain: true, registrationPending: false, deviceBound: true, answered: null, needsReactivation: false,
    counted: null, device: null, deviceTags: [], features: [], signed: null, keyOurs: null, bindingSeqAgreed: null, ...over,
  };
  if (!('deviceBoundAgreed' in over)) s.deviceBoundAgreed = s.deviceBound;
  return s;
};
const LOCAL = { nodeId: NODE, seq: 1790000000, pushType: 'fcm' };

describe('the state, from the status alone', () => {
  it('checks first, and says "unknown" rather than "no node" when the network gives no verdict', () => {
    expect(nodeView({ status: null }).state).toBe('checking');
    expect(nodeView({ status: status({ onChain: null, reachable: false }) }).state).toBe('unreachable');
    expect(nodeView({ status: status({ onChain: false }) }).state).toBe('none');
  });

  it('a pending link waits for the chain, and says once that it was not recorded', () => {
    const pending = { nodeId: NODE, T: 1790000000, expired: false };
    expect(nodeView({ status: status({ onChain: false }), pending }).state).toBe('linking');
    expect(nodeView({ status: status({ onChain: null }), pending }).state).toBe('linking');
    expect(nodeView({ status: status({ onChain: false }), pending: { ...pending, expired: true } }).state).toBe('not_recorded');
    // On the chain, the record decides nothing any more.
    expect(nodeView({ status: status(), pending, local: LOCAL }).state).toBe('here');
  });

  // Contract 4 (04.10): where the node runs is decided by the binding two owners name (B, bindingSeqAgreed) and whether
  // two say a device is bound (D), never by a refused ping key, a missing one or another device key alone: after a plain
  // offline period the tab said "another device" although nothing was linked again.
  it('this device answers while the network names its binding, or gives no verdict on it', () => {
    const S = LOCAL.seq;
    expect(linkedHere(status(), null)).toBe(false);
    expect(linkedHere(status(), LOCAL)).toBe(true); // no B: the binding stands
    for (const over of [{ keyOurs: false }, { tagOurs: false }, { noStatusKey: true }, { deviceBound: null }]) {
      expect([over, linkedHere(status(over), LOCAL)]).toEqual([over, true]);
    }
    expect(linkedHere(status({ bindingSeqAgreed: S }), LOCAL)).toBe(true);
    expect(linkedHere(status({ bindingSeqAgreed: S + 1 }), LOCAL)).toBe(false);
    expect(linkedHere(status({ bindingSeqAgreed: S, deviceBound: false }), LOCAL)).toBe(false);
    expect(bindingVerdict(status({ bindingSeqAgreed: S, deviceBoundAgreed: null }), LOCAL)).toBe('here');
    // A device record that ended went with its binding.
    expect(nodeView({ status: status({ signed: { deviceState: 'ended' } }), local: LOCAL }).state).toBe('no_device');
  });

  it('another device, or none at all, only on two owners\' word', () => {
    expect(nodeView({ status: status() }).state).toBe('elsewhere');
    expect(nodeView({ status: status({ deviceBound: false }) }).state).toBe('no_device');
    expect(nodeView({ status: status({ deviceBoundAgreed: null }) }).state).toBe('checking');
    const S = LOCAL.seq;
    expect(nodeView({ status: status({ bindingSeqAgreed: S + 5 }), local: LOCAL }).state).toBe('elsewhere');
    // Unlinked here, or by the wallet key from anywhere: no device runs it, whatever binding was last.
    expect(nodeView({ status: status({ bindingSeqAgreed: S, deviceBound: false }), local: LOCAL }).state).toBe('no_device');
    expect(nodeView({ status: status({ bindingSeqAgreed: S + 5, deviceBound: false }), local: LOCAL }).state).toBe('no_device');
  });

  it('a binding made here that the owners do not name yet waits for them, then the network decides', () => {
    const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
    const local = { ...LOCAL, boundAt: Math.floor(NOW / 1000) - 60 };
    const older = { bindingSeqAgreed: LOCAL.seq - 100 };
    expect(nodeView({ status: status(older), local, now: NOW })).toMatchObject({ state: 'here', notice: { key: 'node_linked_waiting' } });
    const later = NOW + BIND_SETTLE_MS + 1000;
    expect(nodeView({ status: status(older), local, now: later }).state).toBe('elsewhere');
    expect(nodeView({ status: status({ ...older, deviceBound: false }), local, now: later }).state).toBe('no_device');
    // The network linked this device less than an epoch ago and has not counted it yet: here, waiting, Offline.
    const pending = { platform: 'android', linkedSince: 1790035200, lastAnswerEpoch: null, state: 'other_device_pending' };
    expect(nodeView({ status: status({ bindingSeqAgreed: LOCAL.seq, needsReactivation: true, device: pending }), local: LOCAL }))
      .toMatchObject({ state: 'here', online: false, notice: { key: 'node_linked_waiting' } });
    expect(t('node_linked_waiting')).toBe('Linked to this device. Waiting for its first answer.');
  });

  it('Online only from the network\'s verdict on this node\'s answers', () => {
    expect(nodeView({ status: status(), local: LOCAL })).toEqual({ state: 'here', online: true, notice: null, reenrol: false, offerUse: false });
    expect(nodeView({ status: status({ needsReactivation: true, answered: true }), local: LOCAL }).online).toBe(false);
  });

  it('a device state from the signed status becomes a notice under the card', () => {
    const here = (signed) => nodeView({ status: status({ signed }), local: LOCAL }).notice;
    expect(here({ deviceState: 'pending_next_epoch', effectiveEpoch: 160 })).toEqual({ key: 'node_next_epoch', epoch: 160 });
    expect(here({ deviceState: 'check_pending', refreshWindow: { from: 1, to: 2 } })).toEqual({ key: 'node_check_running' });
    expect(here({ deviceState: 'paused', pausedUntil: 170, ref: 'ab12cd34' })).toEqual({ key: 'node_paused', epoch: 170 });
    expect(here({ deviceState: 'active' })).toBe(null);
  });

  // Owner, 30.09: a check that waits never reads "still checking" for good. It runs while the network names its next
  // check, while this device still sends the binding again with a token, or within a day of the binding; it ended with
  // no verdict when none of that holds; it was refused when the network refused the re-send's check.
  it('a device check that waits: running, ended with no verdict, or refused; the last two offer Use this device', () => {
    const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
    const bound = (msAgo) => ({ ...LOCAL, boundAt: Math.floor((NOW - msAgo) / 1000) });
    const waiting = { deviceState: 'check_pending', refreshWindow: null, ref: 'ab12cd34' };
    const view = (signed, over = {}) => nodeView({ status: status({ signed }), local: LOCAL, now: NOW, ...over });
    expect(CHECK_RUNNING_MS).toBe(24 * 3600 * 1000);
    // Running: a window the network named, a re-send still to go, a binding younger than a day.
    expect(checkState({ ...waiting, refreshWindow: { from: 1, to: 2 } }, { now: NOW })).toBe('running');
    expect(checkState(waiting, { check: { resending: true, refusal: null }, now: NOW })).toBe('running');
    expect(checkState(waiting, { local: bound(CHECK_RUNNING_MS - 1000), now: NOW })).toBe('running');
    expect(checkState({ ...waiting, boundAt: Math.floor((NOW - 60_000) / 1000) }, { now: NOW })).toBe('running');
    // Ended: none of that; the binding's age unknown or past a day.
    expect(checkState(waiting, { now: NOW })).toBe('ended');
    expect(checkState(waiting, { local: bound(CHECK_RUNNING_MS + 1000), check: { resending: false, refusal: null }, now: NOW })).toBe('ended');
    // Refused, whatever else holds.
    const refusal = { reason: 'device_not_genuine', ref: '0f0f0f0f' };
    expect(checkState({ ...waiting, refreshWindow: { from: 1, to: 2 } }, { check: { resending: true, refusal }, now: NOW })).toBe('refused');

    expect(view({ ...waiting, refreshWindow: { from: 1, to: 2 } })).toMatchObject({ offerUse: false, notice: { key: 'node_check_running' } });
    expect(view(waiting, { local: bound(CHECK_RUNNING_MS + 1000) }))
      .toEqual(expect.objectContaining({ offerUse: true, notice: { key: 'node_check_ended' } }));
    expect(view(waiting, { check: { resending: false, refusal } }))
      .toEqual(expect.objectContaining({ offerUse: true, notice: { key: 'node_check_refused', reason: 'device_not_genuine' } }));
    // No reference rides on a notice: nothing on the card asks the user to quote one (owner, 05.10).
  });

  it('a refusal of "Use this device" in words', () => {
    expect(refusalText(t, null)).toBe(null);
    expect(refusalText(t, { reason: 'device_emulator' })).toBe(t('node_cant_run'));
    expect(refusalText(t, { reason: 'device_compromised' })).toBe(t('node_cant_run_now'));
    expect(refusalText(t, { reason: 'bad_signature' })).toBe(t('node_use_err_key'));
    expect(refusalText(t, { reason: 'network' })).toBe(t('node_use_err_network'));
    expect(refusalText(t, { reason: 'rate_limited' })).toBe(t('node_use_err_limit'));
    const at = new Date(2026, 8, 26, 10, 0, 0).getTime();
    expect(refusalText(t, { reason: 'rate_limited', retryAfterSeconds: 3600 }, at)).toBe(t('node_move_limit', { time: '11:00' }));
  });
});

describe('what each state shows', () => {
  const noop = () => {};
  const render = (props) => {
    let tree;
    act(() => {
      tree = renderer.create(<NodeTab t={t} onMove={noop} onUse={noop} onCopy={noop}
        nodeTitle={(type) => t(`node_title_${type}`)} height={2241840} {...props} />);
    });
    return tree;
  };
  const shown = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('\n');
  const buttons = (tree) => tree.root.findAllByType(TouchableOpacity)
    .filter((n) => typeof n.props.onPress === 'function' && n.props.testID !== 'node-id').map((n) => n.props.testID);
  const light = (over) => ({ nodeId: NODE, status: status(), local: null, pending: null, answeredAt: null, balanceNano: 0, ...over });

  it('no node: the one sentence, no button and no link', () => {
    const tree = render({ light: light({ status: status({ onChain: false }) }) });
    expect(shown(tree)).toContain(t('node_none'));
    expect(buttons(tree)).toEqual([]);
    expect(tree.root.findAll((n) => typeof n.props.onPress === 'function')).toEqual([]);
  });

  it('no node id yet, or a registration on its way: no button', () => {
    for (const [l, key] of [
      [null, 'node_checking'],
      [light({ status: status({ onChain: false }), pending: { nodeId: NODE, T: 1, expired: false } }), 'node_linking'],
      [light({ status: status({ onChain: false }), pending: { nodeId: NODE, T: 1, expired: true } }), 'node_link_failed'],
    ]) {
      const tree = render({ light: l });
      expect(shown(tree)).toContain(t(key));
      expect(buttons(tree)).toEqual([]);
    }
  });

  it('checking and unreachable keep the balance and Move of a node the wallet has (owner, 05.10)', () => {
    for (const [l, key] of [
      [light({ status: null, balanceNano: 4_714_356_375_000 }), 'node_checking'],
      [light({ status: status({ onChain: null }), balanceNano: 4_714_356_375_000 }), 'node_unreachable'],
    ]) {
      const tree = render({ light: l });
      expect(shown(tree)).toContain(t(key));
      expect(shown(tree)).toContain('4714.356375 QNC');
      expect(buttons(tree)).toEqual(['node-move']);
      expect(tree.root.find((n) => n.props.testID === 'node-move' && typeof n.props.onPress === 'function').props.disabled).toBe(false);
    }
  });

  it('another device: Use this device, the reason of a refusal, and the balance with Move', () => {
    let tree = render({ light: light({ balanceNano: 2 * 1e9 }) });
    expect(shown(tree)).toContain(t('node_other_device'));
    expect(shown(tree)).toContain('2 QNC');
    expect(buttons(tree)).toEqual(['node-use', 'node-move']);
    tree = render({ light: light({ status: status({ deviceBound: false }) }), refusal: { reason: 'device_unsupported' } });
    expect(shown(tree)).toContain(t('node_no_device'));
    expect(shown(tree)).toContain(t('node_cant_run'));
    expect(buttons(tree)).toEqual(['node-use', 'node-move']);
  });

  it('an unknown balance reads as unknown, never 0 QNC, and cannot be moved', () => {
    for (const l of [light({ balanceNano: null }), light({ status: status({ onChain: null }), balanceNano: undefined })]) {
      const tree = render({ light: l });
      expect(shown(tree)).toContain('—');
      expect(shown(tree)).not.toContain('0 QNC');
      expect(tree.root.find((n) => n.props.testID === 'node-move' && typeof n.props.onPress === 'function').props.disabled).toBe(true);
    }
  });

  it('a device that cannot run a node says so and offers nothing to run it with', () => {
    expect(deviceText(t, null)).toBe(null);
    expect(deviceText(t, { capable: true })).toBe(null);
    expect(deviceText(t, { capable: false, reason: 'device_desktop' })).toBe(t('node_cant_run'));
    expect(deviceText(t, { capable: false, reason: 'device_unsupported' })).toBe(t('node_cant_run'));
    expect(deviceText(t, { capable: false, reason: 'device_secondary_user' })).toBe(t('node_main_profile'));
    for (const s of [status(), status({ deviceBound: false })]) {
      const tree = render({ light: light({ status: s, device: { capable: false, reason: 'device_unsupported' } }) });
      expect(shown(tree)).toContain(t('node_cant_run'));
      // Nothing to run the node with; moving its balance takes only the wallet key, so that stays.
      expect(buttons(tree)).toEqual(['node-move']);
    }
    // The wallet stays whole: a node on another device still shows, and so does no node.
    const none = render({ light: light({ status: status({ onChain: false }), device: { capable: false, reason: 'device_desktop' } }) });
    expect(shown(none)).toContain(t('node_none'));
  });

  it('this device, Online: the rows and Move to wallet from 1 QNC; no off switch (owner, 30.09)', () => {
    const at = new Date(2026, 8, 26, 14, 5, 0).getTime();
    const epoch = Math.floor(2241840 / 14400);
    const tree = render({
      light: light({
        local: LOCAL, balanceNano: 12.5e9, answeredAt: { epoch, at },
        status: status({ answered: true, counted: { since: 6, counted: 5, last: epoch - 1 } }),
      }),
    });
    const text = shown(tree);
    expect(text).toContain(t('node_badge_online'));
    expect(text).toContain(t('node_answered_yes', { time: '14:05' }));
    expect(text).toContain(t('node_counted_last', { n: 5, m: 6 }));
    expect(text).toContain('12.5 QNC');
    // No line on how the node works: status rows, the balance and Move to wallet only.
    expect(text).not.toMatch(/app switcher|status requests|until you move it|reaches 1 QNC/);
    expect(buttons(tree)).toEqual(['node-move']);
    expect(tree.root.findAllByType(TouchableOpacity).find((n) => n.props.testID === 'node-move').props.disabled).toBe(false);
  });

  it('this device, Offline: the hint, nothing to press for it; below 1 QNC nothing moves, with no note about it', () => {
    const tree = render({ light: light({ local: LOCAL, balanceNano: 0.4e9, status: status({ needsReactivation: true, answered: false }) }) });
    const text = shown(tree);
    expect(text).toContain(t('node_badge_offline'));
    expect(text).not.toMatch(/answers again when the app is opened|reaches 1 QNC/);
    expect(text).toContain(t('node_answered_no'));
    expect(buttons(tree)).toEqual(['node-move']);
    expect(tree.root.findAllByType(TouchableOpacity).find((n) => n.props.testID === 'node-move').props.disabled).toBe(true);
    // The text that named the 1 QNC floor is gone from every language (owner, 04.10).
    expect(hasKey('node_move_min')).toBe(false);
  });

  // Self-service (owner, 05.10): what the user can do is on the card, Use this device; nothing to write to anyone.
  it('a check that ended with no verdict or was refused says so plainly, with Use this device and no reference', () => {
    const now = Date.UTC(2026, 8, 30, 12, 0, 0);
    const old = { ...LOCAL, boundAt: Math.floor(now / 1000) - 3 * 86400 };
    const waiting = { deviceState: 'check_pending', refreshWindow: null, ref: 'ab12cd34' };
    let tree = render({ now, light: light({ local: old, status: status({ signed: waiting }) }) });
    let text = shown(tree);
    expect(text).toContain(t('node_check_ended'));
    expect(text).not.toContain('ab12cd34');
    expect(text).not.toContain(t('node_check_running'));
    expect(buttons(tree)).toEqual(['node-use', 'node-move']);
    tree = render({ now, light: light({ local: old, status: status({ signed: { ...waiting, ref: null } }), check: { resending: false, refusal: { reason: 'device_compromised', ref: 'cd34ab12' } } }) });
    text = shown(tree);
    expect(text).toContain(t('node_check_refused'));
    expect(text).toContain(t('node_cant_run_now'));
    expect(text).not.toContain('cd34ab12');
    expect(buttons(tree)).toEqual(['node-use', 'node-move']);
    // Still running: the plain notice, nothing more to press.
    tree = render({ now, light: light({ local: old, status: status({ signed: { ...waiting, refreshWindow: { from: 1, to: 2 } } }) }) });
    expect(shown(tree)).toContain(t('node_check_running'));
    expect(buttons(tree)).toEqual(['node-move']);
  });

  it('a paused node names the date, and nothing to quote to anyone', () => {
    const now = new Date(2026, 8, 26, 12, 0, 0).getTime();
    const signed = { deviceState: 'paused', pausedUntil: 157, ref: 'ab12cd34' }; // block 2 260 800, 18 960 s ahead
    const tree = render({ now, light: light({ local: LOCAL, status: status({ signed }) }) });
    expect(shown(tree)).toContain(t('node_paused', { date: '2026-09-26' }));
    expect(shown(tree)).not.toContain('ab12cd34');
    expect(buttons(tree)).toEqual(['node-move']);
  });

  it('a server node: its card and Move to wallet, no light-node line', () => {
    const tree = render({
      server: { nodeType: 'super', nodeId: 'super_x', status: { success: true, isOnline: true, pendingRewards: 3e9 } },
      light: null,
    });
    const text = shown(tree);
    expect(text).not.toMatch(/status requests/);
    expect(text).toContain('3 QNC');
    expect(buttons(tree)).toEqual(['node-move']);
  });

  // R4: a super node's monitoring, read only apart from Move to wallet.
  const SUPER = 'super_node_60a735f53dd87f1b';
  const serverStatus = (over = {}) => ({
    success: true, registered: true, nodeId: SUPER, nodeType: 'super', isOnline: true, lastSeen: 1790000000,
    lastSeenAgoSeconds: 125, heartbeatCount: 4, requiredHeartbeats: 9, pendingRewards: 2e9, reputation: 70, ...over,
  });

  it('a server node shows last seen, its heartbeats this epoch, counted and missed epochs, and the balance', () => {
    const tree = render({
      server: { nodeType: 'super', nodeId: SUPER, status: serverStatus(), epochs: { counted: 5, missed: 1 } }, light: null,
    });
    const text = shown(tree);
    expect(text).toContain(SUPER);
    expect(text).toContain(t('node_badge_online'));
    expect(text).toContain(`${t('node_last_seen')}\n${t('node_last_seen_ago', { time: t('node_ago_m', { m: 2 }) })}`);
    expect(text).toContain(`${t('node_heartbeats')}\n${t('node_heartbeats_of', { n: 4, m: 9 })}`);
    expect(text).toContain(`${t('node_counted')}\n${t('node_counted_last', { n: 5, m: 6 })}`);
    expect(text).toContain(`${t('node_missed')}\n1`);
    expect(text).toContain('2 QNC');
    expect(buttons(tree)).toEqual(['node-move']);
    // Offline, as a node that has it offline answers: no time seen, no epochs yet (unknown until read).
    const off = shown(render({
      server: { nodeType: 'super', nodeId: SUPER, status: serverStatus({ isOnline: false, lastSeen: 0, lastSeenAgoSeconds: undefined }), epochs: null },
      light: null,
    }));
    expect(off).toContain(t('node_badge_offline'));
    expect(off).toContain(t('node_server_offline'));
    expect(off).not.toContain(t('node_last_seen'));
    expect(off).not.toContain(t('node_missed'));
  });

  it('how long ago, in the language\'s units: at least a minute, then hours and minutes, then days and hours', () => {
    expect(agoText(t, 0)).toBe(t('node_last_seen_ago', { time: t('node_ago_m', { m: 1 }) }));
    expect(agoText(t, 3599)).toBe(t('node_last_seen_ago', { time: t('node_ago_m', { m: 60 }) }));
    expect(agoText(t, 3 * 3600 + 7 * 60 + 5)).toBe(t('node_last_seen_ago', { time: t('node_ago_hm', { h: 3, m: 7 }) }));
    expect(agoText(t, 2 * 86400 + 5 * 3600)).toBe(t('node_last_seen_ago', { time: t('node_ago_d', { d: 2, h: 5 }) }));
    expect(agoText(t, -1)).toBe(null);
    expect(agoText(t, undefined)).toBe(null);
    expect(agoText(t, 1.5)).toBe(null);
  });

  it('a wallet with a super and a light node on the chain: both cards, the server first, each with its move', () => {
    const moved = [];
    const tree = render({
      server: { nodeType: 'super', nodeId: SUPER, status: serverStatus(), epochs: null },
      light: light({ local: LOCAL, balanceNano: 3e9, status: status({ answered: true }) }),
      onMove: () => moved.push('light'), onMoveServer: () => moved.push('server'),
    });
    const text = shown(tree);
    expect(text.indexOf(SUPER)).toBeGreaterThan(-1);
    expect(text.indexOf(SUPER)).toBeLessThan(text.indexOf(NODE));
    expect(buttons(tree)).toEqual(['node-move', 'node-move']);
    const moves = tree.root.findAllByType(TouchableOpacity).filter((n) => n.props.testID === 'node-move');
    act(() => { moves[0].props.onPress(); moves[1].props.onPress(); });
    expect(moved).toEqual(['server', 'light']);
    // Under a server node a light node that is not the wallet's shows nothing: no "no node" line under the server card.
    for (const s of [status({ onChain: false }), status({ onChain: null })]) {
      const only = render({ server: { nodeType: 'super', nodeId: SUPER, status: serverStatus(), epochs: null }, light: light({ status: s }) });
      expect(shown(only)).not.toContain(t('node_none'));
      expect(shown(only)).not.toContain(t('node_unreachable'));
      expect(buttons(only)).toEqual(['node-move']);
    }
  });

  it('a node aiqnet.io recorded that the network does not list yet: its sentence for either type, nothing to press', () => {
    let tree = render({ light: light({ status: status({ onChain: false }) }), recorded: 'light' });
    expect(shown(tree)).toContain(t('node_not_on_network_light'));
    expect(shown(tree)).not.toContain(t('node_none'));
    expect(buttons(tree)).toEqual([]);
    tree = render({ light: light({ status: status({ onChain: false }) }), recorded: 'super' });
    expect(shown(tree)).toContain(t('node_title_super'));
    expect(shown(tree)).toContain(t('node_not_on_network_super'));
    expect(shown(tree)).not.toContain(t('node_super_server'));
    expect(buttons(tree)).toEqual([]);
    // A linked server node whose registration the network does not record yet says the same.
    tree = render({ server: { nodeType: 'super', nodeId: SUPER, status: serverStatus({ registered: false }), epochs: null }, light: null, recorded: 'super' });
    expect(shown(tree)).toContain(t('node_not_on_network_super'));
    expect(buttons(tree)).toEqual([]);
    // Without such a record, as before.
    tree = render({ light: light({ status: status({ onChain: false }) }) });
    expect(shown(tree)).toContain(t('node_none'));
    tree = render({ server: { nodeType: 'super', nodeId: SUPER, status: serverStatus({ registered: false }), epochs: null }, light: null });
    expect(shown(tree)).toContain(t('node_super_server'));
    expect(t('node_not_on_network_super')).toBe(
      "This wallet's super node has not joined the QNet network yet. It runs on a server with the QNet node software.");
    expect(t('node_not_on_network_light')).toBe("This wallet's light node is not on the QNet network yet.");
  });

  it('no card shows a code, a price, a link or an address to open', () => {
    const trees = [
      render({ server: { nodeType: 'super', nodeId: SUPER, status: serverStatus(), epochs: { counted: 1, missed: 0 } },
        light: light({ local: LOCAL, status: status() }) }),
      render({ light: light({ status: status({ onChain: false }) }), recorded: 'super' }),
      render({ light: light({ status: status({ onChain: false }) }), recorded: 'light' }),
    ];
    for (const tree of trees) {
      expect(shown(tree)).not.toMatch(/QNET-|https?:|www\.|aiqnet|1DEV|price|\$/i);
      expect(tree.root.findAll((n) => typeof n.props.href === 'string' || typeof n.props.url === 'string')).toEqual([]);
    }
  });

  it('the tab has no platform branch and no link anywhere', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'NodeTab.js'), 'utf8');
    expect(src).not.toMatch(/Platform|Linking|openURL|https?:\/\//);
  });

  it('the open tab asks the owners for a signature check at most every five minutes', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'WalletScreen.js'), 'utf8');
    expect(src).toMatch(/const SIGNED_STATUS_MS = 5 \* 60_000;/);
    expect(src).toMatch(/if \(!server \|\| lightShownRef\.current\) loadLightNodeStatus\(\{ fresh: false \}\);\s*\}, NODE_STATUS_MS\);/);
    expect(src).toMatch(/const sign = !!local && \(fresh \|\| !same \|\| Date\.now\(\) - last\.at >= SIGNED_STATUS_MS\);/);
    // The last signed answer stands only for the binding it was read for, and a teardown only for that binding.
    expect(src).toMatch(/const same = !!local && last\.nodeId === nodeId && last\.seq === local\.seq;/);
    expect(src).toMatch(/forgetIfReplaced\(nodeId, status, local\.seq\)/);
  });
});

describe('the status, from the shard owners', () => {
  const owners = lightShardOwnerUrls(NODE);
  const reply = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  const pub = (over = {}) => ({
    onchain_registered: true, registration_pending: false, device_bound: true, answered_this_epoch: true,
    needs_reactivation: false, counted: { epochs_since_registration: 6, counted: 5, last_counted_epoch: 150 },
    features: ['bind_v2', 'status_signed'], ...over,
  });
  let calls;
  beforeEach(() => { calls = []; });
  const answers = (byOwner, post = () => ({ success: false })) => {
    global.fetch = jest.fn((url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (opts && opts.method === 'POST') return reply(post(url));
      const i = owners.findIndex((o) => url.startsWith(o));
      const a = byOwner[i];
      return a instanceof Error ? Promise.reject(a) : reply(a);
    });
  };

  it('asks only the three shard owners, the public form with no nonce (it names no device, ND-7)', async () => {
    answers([pub(), pub(), pub()]);
    const s = await readNodeStatus(NODE);
    expect(calls.map((c) => c.url.split('/api/')[0]).sort()).toEqual([...owners].sort());
    expect(calls.every((c) => c.url.endsWith(`?node_id=${NODE}`))).toBe(true);
    expect(s).toMatchObject({ onChain: true, deviceBound: true, answered: true, needsReactivation: false,
      counted: { since: 6, counted: 5, last: 150 } });
  });

  it('no node only when two owners say so; one answer or a split is unknown', async () => {
    answers([pub({ onchain_registered: false }), pub({ onchain_registered: false }), new Error('down')]);
    expect((await readNodeStatus(NODE)).onChain).toBe(false);
    answers([pub({ onchain_registered: false }), new Error('down'), { success: false, error: 'rate limited' }]);
    expect((await readNodeStatus(NODE)).onChain).toBe(null);
    answers([pub({ onchain_registered: false }), pub(), new Error('down')]);
    expect((await readNodeStatus(NODE)).onChain).toBe(null);
  });

  it('never reads Online from anything but needs_reactivation, and Offline only when every owner says so (F13)', async () => {
    answers([pub({ needs_reactivation: true, is_active: true }), pub({ needs_reactivation: true, is_active: true }), pub()]);
    expect((await readNodeStatus(NODE)).needsReactivation).toBe(false);
    answers([pub({ needs_reactivation: true, is_active: true }), pub({ needs_reactivation: true }), pub({ needs_reactivation: true })]);
    expect((await readNodeStatus(NODE)).needsReactivation).toBe(true);
  });

  it('a form is switched on only when two owners list it', () => {
    expect(agreedFeatures([{ features: ['a', 'b'] }, { features: ['a'] }, { features: ['b', 'b'] }])).toEqual(['a', 'b']);
    expect(agreedFeatures([{ features: ['a'] }, { features: [] }])).toEqual([]);
  });

  it('the signed status: its fields when the key is the node\'s, "not ours" on a refused key', async () => {
    const sign = jest.fn(async () => ({ signer: 'ping', sig: 'ab' }));
    answers([pub(), pub(), pub()], () => ({ ...pub(), binding_seq: 1790000000, device_state: 'active', ref: '0123abcd' }));
    let s = await readNodeStatus(NODE, { signStatus: sign });
    expect(s.keyOurs).toBe(true);
    expect(s.signed).toMatchObject({ bindingSeq: 1790000000, deviceState: 'active', ref: '0123abcd' });
    // The signed form goes to every owner, with the nonce its device tag is for.
    const posted = calls.filter((c) => c.body);
    expect(posted.map((c) => c.url.split('/api/')[0]).sort()).toEqual([...owners].sort());
    for (const c of posted) expect(c.body).toEqual({ node_id: NODE, ts: sign.mock.calls[0][1], signer: 'ping', sig: 'ab', nonce: s.nonce });
    expect(s.nonce).toMatch(/^[0-9a-f]{32}$/);
    answers([pub(), pub(), pub()], () => ({ success: false, reason: 'bad_signature' }));
    s = await readNodeStatus(NODE, { signStatus: sign });
    expect(s.keyOurs).toBe(false);
    expect(s.signed).toBe(null);
    // In rank order, as when the owners were asked one by one: two refusals before any took it say "not ours".
    const takenBy = (i) => (url) => (url.startsWith(owners[i]) ? { ...pub(), binding_seq: 1 } : { success: false, reason: 'bad_signature' });
    answers([pub(), pub(), pub()], takenBy(2));
    expect((await readNodeStatus(NODE, { signStatus: sign })).keyOurs).toBe(false);
    answers([pub(), pub(), pub()], takenBy(0));
    expect((await readNodeStatus(NODE, { signStatus: sign })).keyOurs).toBe(true);
    // Without status_signed on two owners nothing is signed at all.
    sign.mockClear();
    answers([pub({ features: [] }), pub({ features: ['status_signed'] }), pub({ features: [] })]);
    s = await readNodeStatus(NODE, { signStatus: sign });
    expect(sign).not.toHaveBeenCalled();
    expect(s.keyOurs).toBe(null);
  });

  // Contract 4: the binding two signed answers name alike (any signer), and "ours" only for this device's ping key.
  it('the binding sequence two signed answers name alike, whichever key signed; a wallet-key answer says nothing of "ours"', async () => {
    const seqBy = (seqs) => (url) => ({ ...pub(), binding_seq: seqs[owners.findIndex((o) => url.startsWith(o))] });
    const wallet = jest.fn(async () => ({ signer: 'wallet', sig: 'ab', identityPublicKey: 'cd' }));
    answers([pub(), pub(), pub()], seqBy([1790000500, 1790000500, 1790000000]));
    let s = await readNodeStatus(NODE, { signStatus: wallet });
    expect(s).toMatchObject({ bindingSeqAgreed: 1790000500, keyOurs: null, signer: 'wallet' });
    expect(calls.filter((c) => c.body)[0].body).toMatchObject({ signer: 'wallet', identity_pubkey: 'cd' });
    answers([pub(), pub(), pub()], seqBy([1, 2, 3]));
    expect((await readNodeStatus(NODE, { signStatus: wallet })).bindingSeqAgreed).toBe(null);
    // A wallet key refused by two owners is not "this device's key refused".
    answers([pub(), pub(), pub()], () => ({ success: false, reason: 'bad_signature' }));
    expect((await readNodeStatus(NODE, { signStatus: wallet })).keyOurs).toBe(null);
    const ping = jest.fn(async () => ({ signer: 'ping', sig: 'ab' }));
    answers([pub(), pub(), pub()], seqBy([7, 7, 7]));
    s = await readNodeStatus(NODE, { signStatus: ping });
    expect(s).toMatchObject({ bindingSeqAgreed: 7, keyOurs: true, signer: 'ping' });
  });

  it('the public device view of the agreed answer, read strictly; none for a node not on the chain', async () => {
    const device = { platform: 'android', linked_since: 1790035200, last_answer_epoch: 1240, state: 'offline' };
    answers([pub({ device }), pub({ device }), pub()]);
    expect((await readNodeStatus(NODE)).device).toEqual({ platform: 'android', model: null, linkedSince: 1790035200, lastAnswerEpoch: 1240, state: 'offline' });
    answers([pub({ device: { ...device, platform: 'other', linked_since: -1, state: 'other_device_pending' } }), pub(), pub()]);
    expect((await readNodeStatus(NODE)).device).toEqual({ platform: 'unknown', model: null, linkedSince: null, lastAnswerEpoch: 1240, state: 'other_device_pending' });
    for (const bad of [{ ...device, state: 'busy' }, 'android', null]) {
      answers([pub({ device: bad }), pub({ device: bad }), pub()]);
      expect((await readNodeStatus(NODE)).device).toBe(null);
    }
    answers([pub({ onchain_registered: false, device }), pub({ onchain_registered: false, device }), pub()]);
    expect((await readNodeStatus(NODE)).device).toBe(null);
  });

  it('the pending-link record lives T + 24 h + 10 min', async () => {
    const T = 1790000000;
    await AsyncStorage.setItem(LINK_PENDING_KEY, JSON.stringify({ nodeId: NODE, wallet: 'w', T, createdAt: T, bound: false }));
    expect((await readLinkPending(NODE, (T + 86400 + 599) * 1000)).expired).toBe(false);
    expect((await readLinkPending(NODE, (T + 86400 + 601) * 1000)).expired).toBe(true);
    expect(await readLinkPending('light_mobile_0000000000000001', T * 1000)).toBe(null);
  });
});
