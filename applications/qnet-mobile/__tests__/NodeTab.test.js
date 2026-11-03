/**
 * The Node tab (plan-mobile 3.2, unified plan 3.1): this wallet's node as the network records it, the same states,
 * texts and buttons on every phone and tablet. The state comes from the status alone (NodeTab.nodeView), and the
 * status from the node's shard owners, two of which must agree (LightNode.readNodeStatus).
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import Action from '../src/components/ui/Action';
import Section from '../src/components/ui/Section';
import Status from '../src/components/ui/Status';
import NodeTab, {
  nodeView, refusalText, deviceText, agoText, checkState, CHECK_RUNNING_MS, lightShownHere,
  waitingAdmission, serverStatusAfter, rewardAdmission,
} from '../src/screens/NodeTab';
import {
  readNodeStatus, readAgreedNodeStatus, agreedFeatures, readLinkPending, linkedHere, bindingVerdict, BIND_SETTLE_MS,
  LINK_PENDING_KEY,
} from '../src/services/LightNode';
import { lightShardOwnerUrls } from '../src/config/nodes';
import { hasKey, makeT } from '../src/i18n';
import { reasonText } from '../src/utils/bindRefusal';

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
// What the tab shows for a wallet without a node (and a light node on no device): the line, then a card for each kind.
const NO_NODE = [t('node_title'), t('node_none'), t('node_title_light'), t('node_light_device'), t('node_title_super'),
  t('node_super_server')].join('\n');

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

  // With no binding sequence (the owners refuse the ping key of a binding that was replaced, and a background read has no
  // other key), the day two owners date the network's binding to, later than this device's binding, tells it all the
  // same; the same day or an earlier one decides nothing.
  it('without a binding sequence, a binding two owners date to a later day than this one is another device\'s', () => {
    const S = LOCAL.seq;
    const day = S - (S % 86400);
    expect(nodeView({ status: status({ linkedSinceAgreed: day + 86400 }), local: LOCAL }).state).toBe('elsewhere');
    for (const d of [day, day - 86400, null]) {
      expect([d, bindingVerdict(status({ linkedSinceAgreed: d }), LOCAL)]).toEqual([d, 'here']);
    }
    // Only with a device bound on two owners' word, and never for a binding older builds made (no sequence).
    expect(bindingVerdict(status({ linkedSinceAgreed: day + 86400, deviceBoundAgreed: null }), LOCAL)).toBe('here');
    expect(bindingVerdict(status({ linkedSinceAgreed: day + 86400 }), { ...LOCAL, seq: 0 })).toBe('here');
    // A binding sequence two owners name decides as before.
    expect(bindingVerdict(status({ linkedSinceAgreed: day + 86400, bindingSeqAgreed: S }), LOCAL)).toBe('here');
  });

  it('a binding made here that the owners do not name yet waits for them, then the network decides', () => {
    const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
    const local = { ...LOCAL, boundAt: Math.floor(NOW / 1000) - 60 };
    const older = { bindingSeqAgreed: LOCAL.seq - 100 };
    expect(nodeView({ status: status(older), local, now: NOW })).toMatchObject({ state: 'here', notice: { key: 'node_linked_waiting' } });
    const later = NOW + BIND_SETTLE_MS + 1000;
    expect(nodeView({ status: status(older), local, now: later }).state).toBe('elsewhere');
    expect(nodeView({ status: status({ ...older, deviceBound: false }), local, now: later }).state).toBe('no_device');
    // The network linked this device and has not counted it since: here, waiting, Offline.
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

  // The Node tab and the QNet Link sheet say why a binding was refused in the same words (utils/bindRefusal reasonText);
  // for a reason with none of its own the tab says a network failure, the sheet nothing (its error line says it).
  it('a refusal of "Use this device" in words, the QNet Link sheet\'s too', () => {
    for (const [reason, key] of [
      ['device_emulator', 'node_cant_run'], ['device_compromised', 'node_cant_run_now'], ['bad_signature', 'node_use_err_key'],
      ['device_secondary_user', 'node_main_profile'], ['rate_limited', 'node_use_err_limit'],
      // A phone clock off the network's refused the move as "try again", which never helps.
      ['expired', 'node_use_err_clock'], ['future_seq', 'node_use_err_clock'],
      // A device refusal this build has no text for is a device that cannot run the node now, not a network failure.
      ['device_something_new', 'node_cant_run_now'],
    ]) {
      expect([reason, reasonText(t, { reason }), refusalText(t, { reason })]).toEqual([reason, t(key), t(key)]);
    }
    const at = new Date(2026, 8, 26, 10, 0, 0).getTime();
    expect(refusalText(t, { reason: 'rate_limited', retryAfterSeconds: 3600 }, at)).toBe(t('node_move_limit', { time: '11:00' }));
    expect(reasonText(t, { reason: 'device_rate_limited', retryAfterSeconds: 120 }, at)).toBe(t('node_move_limit', { time: '10:02' }));
    for (const reason of ['network', 'stale_seq', null, undefined]) {
      expect([reason, reasonText(t, { reason }), refusalText(t, { reason })]).toEqual([reason, null, t('node_use_err_network')]);
    }
    expect([reasonText(t, null), refusalText(t, null)]).toEqual([null, null]);
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
  // The tab's actions by their ids (the node id's Copy act has none).
  const buttons = (tree) => tree.root.findAllByType(Action)
    .filter((n) => typeof n.props.onPress === 'function' && n.props.testID).map((n) => n.props.testID);
  const moveButton = (tree) => tree.root.findAllByType(Action).find((n) => n.props.testID === 'node-move');
  // The node's status in a word under its identity: its tone (live, needs) and the word.
  const statusOf = (tree) => tree.root.findAllByType(Status).map((n) => [n.props.tone, n.props.label]);
  const light = (over) => ({ nodeId: NODE, status: status(), local: null, pending: null, answeredAt: null, balanceNano: 0, ...over });

  // QNet Blockchain has two kinds of node: a wallet without one names both, and before the first answer the tab names
  // no kind of node.
  it('no node: that it has none, then both kinds on a card each with where it runs; no button and no link', () => {
    const tree = render({ light: light({ status: status({ onChain: false }) }), walletNode: 'none' });
    expect(shown(tree)).toBe(NO_NODE);
    const cards = tree.root.findAllByType(Section).map((n) => [n.props.testID, n.props.title]);
    expect(cards).toEqual([['node-none-light', t('node_title_light')], ['node-none-super', t('node_title_super')]]);
    expect(buttons(tree)).toEqual([]);
    expect(tree.root.findAll((n) => typeof n.props.onPress === 'function')).toEqual([]);
    // Where each kind runs, never that one runs here: the wallet has none.
    expect([t('node_light_device'), t('node_super_server')]).toEqual(['Light nodes run in QNet Wallet', 'Super nodes run on a server']);
  });

  it('before the first answer it names no kind of node: the wallet may have none', () => {
    const tree = render({ light: null });
    expect(shown(tree)).toBe(`${t('node_title')}\n${t('node_checking')}`);
    expect(shown(tree)).not.toContain(t('node_title_light'));
    // This device's light node being checked keeps its title.
    expect(shown(render({ light: light({ local: LOCAL, status: null }) }))).toContain(t('node_title_light'));
  });

  // "No node" takes two owners' word on the light node and two genesis nodes' word that the wallet has none at all: while
  // the wallet's node is unknown, or the genesis nodes name one, a light node not on the chain is still being checked.
  it('no light node on the chain and the wallet\'s node unknown or named: being checked, never "no node"', () => {
    for (const walletNode of [null, undefined, { nodeId: NODE, nodeType: 'light' }]) {
      const tree = render({ light: light({ status: status({ onChain: false }) }), walletNode });
      expect([walletNode, shown(tree)]).toEqual([walletNode, `${t('node_title')}\n${t('node_checking')}`]);
      expect(buttons(tree)).toEqual([]);
    }
    expect(shown(render({ light: light({ status: status({ onChain: false }) }), walletNode: 'none' }))).toBe(NO_NODE);
  });

  it('a hidden node name: masked in its line, light and super alike; shown again when the user turns it off', () => {
    const SUPER_ID = 'super_node_60a735f53dd87f1b';
    const lightTree = render({ light: light({ local: LOCAL }), namesHidden: true });
    const id = (tree) => tree.root.find((n) => n.type === Text && n.props.testID === 'node-id');
    const copy = (tree) => tree.root.find((n) => n.props.testID === 'node-id-copy' && typeof n.props.onPress === 'function');
    expect(id(lightTree).props.children).toBe('••••');
    expect(copy(lightTree).props.accessibilityLabel).toBe(`${t('node_name')} ••••`);
    expect(shown(lightTree)).not.toContain(NODE);
    const superStatus = { success: true, registered: true, isOnline: true, nodeId: SUPER_ID, pendingRewards: 2e9 };
    const superTree = render({ server: { nodeType: 'super', nodeId: SUPER_ID, status: superStatus, epochs: null }, light: null, namesHidden: true });
    expect(id(superTree).props.children).toBe('••••');
    expect(shown(superTree)).not.toContain(SUPER_ID);
    // The same line and style either way, so nothing moves.
    const plain = render({ light: light({ local: LOCAL }) });
    expect(id(plain).props.children).toBe(NODE);
    expect(id(plain).props.style).toBe(id(lightTree).props.style);
    expect(id(plain).props.numberOfLines).toBe(id(lightTree).props.numberOfLines);
    expect(copy(plain).props.accessibilityLabel).toBe(`${t('node_name')} ${NODE}`);
  });

  // The node's name is copied as every value is, by a tap on it; a hidden name still copies whole.
  it('a tap on the node\'s name copies it whole, hidden or not; its copy mark turns to the tick', async () => {
    const Clipboard = require('@react-native-clipboard/clipboard').default;
    const SUPER_ID = 'super_node_60a735f53dd87f1b';
    const superStatus = { success: true, registered: true, isOnline: true, nodeId: SUPER_ID, pendingRewards: 2e9 };
    const glyphs = (tree) => tree.root.findAll((n) => typeof n.type === 'string' && /^copy-glyph/.test(n.props.testID || ''))
      .map((n) => n.props.testID);
    for (const [props, whole] of [
      [{ light: light({ local: LOCAL }), namesHidden: true }, NODE],
      [{ server: { nodeType: 'super', nodeId: SUPER_ID, status: superStatus, epochs: null }, light: null }, SUPER_ID],
    ]) {
      const tree = render(props);
      const copy = tree.root.find((n) => n.props.testID === 'node-id-copy' && typeof n.props.onPress === 'function');
      expect(copy.findAll((n) => n.type === Text && n.props.testID === 'node-id')).toHaveLength(1);
      expect(glyphs(tree)).toEqual(['copy-glyph']);
      Clipboard.setString.mockClear();
      await act(async () => { await copy.props.onPress(); });
      expect(Clipboard.setString).toHaveBeenCalledWith(whole);
      expect(glyphs(tree)).toEqual(['copy-glyph-done']);
      await act(async () => { tree.unmount(); });
    }
  });

  it('no node id yet, or a registration on its way: no button', () => {
    for (const [l, key] of [
      [null, 'node_checking'],
      [light({ status: status({ onChain: false }), pending: { nodeId: NODE, T: 1, expired: false } }), 'node_linking'],
      // The registration in the genesis nodes' pool, on its way into a block (owner, 18.10: before, the tab said nothing
      // of it while the owners reported it).
      [light({ status: status({ onChain: false, registrationPending: true }), pending: { nodeId: NODE, T: 1, expired: false } }), 'node_linking_pool'],
      [light({ status: status({ onChain: false }), pending: { nodeId: NODE, T: 1, expired: true } }), 'node_link_failed'],
    ]) {
      const tree = render({ light: l });
      expect(shown(tree)).toContain(t(key));
      expect(buttons(tree)).toEqual([]);
    }
    expect(nodeView({ status: status({ onChain: false, registrationPending: true }), pending: { expired: false } }))
      .toEqual({ state: 'linking', pooled: true });
    expect(nodeView({ status: status({ onChain: false }), pending: { expired: false } })).toEqual({ state: 'linking' });
  });

  // A binding sent from a phone that held none, with no answer: with no binding sequence in the status (signed answers
  // that do not agree, no signed status) it is still being linked here, never "runs here", and asks for no device key.
  it('a waiting binding on a phone with none, no binding sequence named: being linked, the waiting line, no device-key advice', () => {
    const now = Date.now();
    const waiting = { ...LOCAL, boundAt: Math.floor(now / 1000) - 3600, hw: false, unconfirmed: true };
    const features = ['device_v1', 'bind_v2'];
    expect(bindingVerdict(status(), waiting, now)).toBe('linking');
    expect(nodeView({ status: status({ features }), local: waiting, now }))
      .toMatchObject({ state: 'here', notice: { key: 'node_linked_waiting' }, reenrol: false, offerUse: false });
    // This device's own binding with no sequence named stands as before.
    expect(bindingVerdict(status(), { ...waiting, unconfirmed: undefined }, now)).toBe('here');
    const tree = render({ light: light({ local: waiting, status: status({ features }) }) });
    expect(shown(tree)).toContain(t('node_linked_waiting'));
    expect(shown(tree)).not.toContain(t('node_device_again'));
    expect(buttons(tree)).not.toContain('node-use');
  });

  it('checking and unreachable keep the balance and Move of the node this device runs (owner, 05.10)', () => {
    for (const [l, key] of [
      [light({ local: LOCAL, status: null, balanceNano: 4_714_356_375_000 }), 'node_checking'],
      [light({ local: LOCAL, status: status({ onChain: null }), balanceNano: 4_714_356_375_000 }), 'node_unreachable'],
    ]) {
      const tree = render({ light: l });
      expect(shown(tree)).toContain(t(key));
      expect(shown(tree)).toContain('4,714.356375 QNC');
      expect(buttons(tree)).toEqual(['node-move']);
      expect(moveButton(tree).props.disabled).toBe(false);
    }
  });

  // One wallet, one node. A light node bound to none is not this device's to show: what a wallet without a node says,
  // no balance, no button. With no binding here and no verdict yet nothing names a kind of node, and nothing says the
  // wallet has none (that takes two owners' word): it is being checked, or could not be read.
  it('no device: what a wallet without a node says; no binding here and no verdict: never "no node", nothing to press', () => {
    const S = LOCAL.seq;
    for (const l of [
      light({ status: status({ deviceBound: false }), balanceNano: 2 * 1e9 }), // bound to no device
      light({ local: LOCAL, status: status({ bindingSeqAgreed: S, deviceBound: false }), balanceNano: 2 * 1e9 }), // unlinked
    ]) {
      const tree = render({ light: l, refusal: { reason: 'device_unsupported' } });
      expect(shown(tree)).toBe(NO_NODE);
      expect(buttons(tree)).toEqual([]);
      expect(lightShownHere(l, nodeView(l))).toBe(false);
    }
    for (const [l, key] of [
      [light({ status: status({ deviceBoundAgreed: null }), balanceNano: 2 * 1e9 }), 'node_checking'], // no verdict, no binding here
      [light({ status: status({ onChain: null }), balanceNano: 2 * 1e9 }), 'node_unreachable'], // network not reached, no binding here
    ]) {
      const tree = render({ light: l, refusal: { reason: 'device_unsupported' } });
      expect(shown(tree)).toBe(`${t('node_title')}\n${t(key)}`);
      expect(buttons(tree)).toEqual([]);
      expect(lightShownHere(l, nodeView(l))).toBe(false);
    }
    // The node on no device keeps what a wallet without a node says: the site's sentence only (owner, 11.10).
    expect(hasKey('node_no_device')).toBe(false);
    // Not read yet: still being checked; bound here or being linked here: shown.
    expect(lightShownHere(null, { state: 'checking' })).toBe(true);
    expect(lightShownHere(light({ local: LOCAL }), nodeView(light({ local: LOCAL })))).toBe(true);
    const pending = light({ status: status({ onChain: false }), pending: { nodeId: NODE, T: 1, expired: false } });
    expect(lightShownHere(pending, nodeView(pending))).toBe(true);
  });

  // On another device the tab says exactly which device runs the node ("The node runs on iPhone 15 Pro", the model the
  // status names), its status by the network's verdict, the last counted epoch and the node balance with its move; one
  // the network stopped waking says why and where it resumes. Never Use this device here.
  it('another device: which device runs it, its status, the last counted epoch, the balance; no Use this device', () => {
    const S = LOCAL.seq;
    const IPHONE = { platform: 'ios', model: 'iPhone 15 Pro', linkedSince: 1790035200, lastAnswerEpoch: 151, state: 'online' };
    const counted = { since: 60, counted: 48, last: 1234 };
    const onAnother = (over = {}, more = {}) => light({ balanceNano: 2.5e9, status: status({ device: IPHONE, counted, ...over }), ...more });
    const sentence = (tree) => tree.root.find((n) => n.type === Text && n.props.testID === 'node-elsewhere').props.children;
    const stoppedLine = (tree) => tree.root.findAll((n) => n.type === Text && n.props.testID === 'node-elsewhere-stopped');

    // Online on the other device: its model, the chip, the last counted epoch, the balance and Move to wallet.
    let tree = render({ light: onAnother() });
    expect(nodeView(onAnother())).toEqual({ state: 'elsewhere', online: true, model: 'iPhone 15 Pro', waiting: false, stopped: false });
    expect(sentence(tree)).toBe('The node runs on iPhone 15 Pro.');
    expect(statusOf(tree)).toEqual([['live', t('node_status_online')]]);
    expect(stoppedLine(tree)).toEqual([]);
    expect(shown(tree)).toContain(`${t('node_last_counted')}\nEpoch 1,234`);
    expect(shown(tree)).toContain(`${t('node_balance')}\n2.5 QNC`);
    expect(shown(tree)).toContain(NODE);
    expect(buttons(tree)).toEqual(['node-move']);
    expect(moveButton(tree).props.disabled).toBe(false);

    // The network stopped waking it: Offline, why, and where it resumes; still nothing to run it here, whatever this
    // device's refusal, key or check would offer on its own node.
    const off = onAnother({ needsReactivation: true, features: ['device_v1'] }, { device: { capable: true } });
    tree = render({ light: off, refusal: { reason: 'device_unsupported' } });
    expect(statusOf(tree)).toEqual([['needs', t('node_status_offline')]]);
    expect(stoppedLine(tree).map((n) => n.props.children)).toEqual([
      'It did not answer for 2 epochs, so QNet Blockchain stopped waking it. It resumes when QNet Wallet is opened on iPhone 15 Pro.',
    ]);
    expect(buttons(tree)).toEqual(['node-move']);
    expect(shown(tree)).not.toContain(t('node_use'));

    // Linked to that device and not answered since: waiting, never "stopped", and nothing said of how long ago.
    tree = render({ light: onAnother({ needsReactivation: true, device: { ...IPHONE, state: 'other_device_pending' } }) });
    expect(stoppedLine(tree)).toEqual([]);
    expect(shown(tree)).toContain(t('node_elsewhere_waiting'));
    expect(t('node_elsewhere_waiting')).toBe('Waiting for its first answer.');

    // No model in the status (a binding of a build before the model, or this device before a reinstall): today's
    // sentence, and the stopped line names the device it is linked to.
    tree = render({ light: onAnother({ needsReactivation: true, device: { ...IPHONE, model: null } }) });
    expect(sentence(tree)).toBe(t('node_elsewhere'));
    expect(stoppedLine(tree).map((n) => n.props.children)).toEqual([t('node_elsewhere_stopped_device')]);

    // Never counted yet; counted unknown (an older node): no epoch row.
    expect(shown(render({ light: onAnother({ counted: { since: 1, counted: 0, last: null } }) })))
      .toContain(`${t('node_last_counted')}\n${t('node_counted_none')}`);
    expect(shown(render({ light: onAnother({ counted: null }) }))).not.toContain(t('node_last_counted'));

    // Taken over from this device: the same card. A hidden name stays masked here too.
    const taken = light({ local: LOCAL, status: status({ bindingSeqAgreed: S + 5, device: IPHONE, counted }), balanceNano: 2.5e9 });
    expect(sentence(render({ light: taken }))).toBe('The node runs on iPhone 15 Pro.');
    expect(shown(render({ light: taken, namesHidden: true }))).not.toContain(NODE);
    expect(lightShownHere(taken, nodeView(taken))).toBe(false);
  });

  it('an unknown balance reads as unknown, never 0 QNC, and cannot be moved', () => {
    for (const l of [light({ local: LOCAL, balanceNano: null }), light({ local: LOCAL, status: status({ onChain: null }), balanceNano: undefined })]) {
      const tree = render({ light: l });
      expect(shown(tree)).toContain('—');
      expect(shown(tree)).not.toContain('0 QNC');
      expect(moveButton(tree).props.disabled).toBe(true);
    }
  });

  it('a device that cannot run a node says so and offers nothing to run it with', () => {
    expect(deviceText(t, null)).toBe(null);
    expect(deviceText(t, { capable: true })).toBe(null);
    expect(deviceText(t, { capable: false, reason: 'device_desktop' })).toBe(t('node_cant_run'));
    expect(deviceText(t, { capable: false, reason: 'device_unsupported' })).toBe(t('node_cant_run'));
    expect(deviceText(t, { capable: false, reason: 'device_secondary_user' })).toBe(t('node_main_profile'));
    // The node on this device, whose card would offer Use this device (a binding with no device key once two genesis nodes
    // take them): the device says it cannot run a node instead, and moving the balance, the wallet key's alone, stays.
    const tree = render({ light: light({ local: LOCAL, status: status({ features: ['device_v1'] }), device: { capable: false, reason: 'device_unsupported' } }) });
    expect(shown(tree)).toContain(t('node_cant_run'));
    expect(buttons(tree)).toEqual(['node-move']);
    // The wallet stays whole: no node says so.
    const none = render({ light: light({ status: status({ onChain: false }), device: { capable: false, reason: 'device_desktop' } }), walletNode: 'none' });
    expect(shown(none)).toContain(t('node_none'));
  });

  it('this device, Online: the rows and Move to wallet from 1 QNC; no off switch (owner, 30.09)', () => {
    const at = new Date(2026, 8, 26, 14, 5, 0).getTime();
    const epoch = Math.floor(2241840 / 14400);
    const tree = render({
      light: light({
        local: LOCAL, balanceNano: 12.5e9, answeredAt: { epoch, at },
        status: status({ answered: true, counted: { since: 6, counted: 5, last: epoch - 1 },
          device: { platform: 'android', model: 'Acme Phone 7', linkedSince: 1790035200, lastAnswerEpoch: epoch - 1, state: 'online' } }),
      }),
    });
    const text = shown(tree);
    expect(statusOf(tree)).toEqual([['live', t('node_status_online')]]);
    expect(text).toContain(t('node_answered_yes', { time: '14:05' }));
    // No count of epochs and no device model: the site's node cabinet shows both (owner, 11.10).
    expect(text).not.toMatch(/Counted epochs|5 of 6|Acme Phone 7|Device/);
    expect(text).toContain('12.5 QNC');
    // No line on how the node works: status rows, the balance and Move to wallet only.
    expect(text).not.toMatch(/app switcher|status requests|until you move it|reaches 1 QNC/);
    expect(buttons(tree)).toEqual(['node-move']);
    expect(moveButton(tree).props.disabled).toBe(false);
  });

  it('the node tile: its status chip before its type, its whole name under them on one line, copied by a tap, the epoch mark', () => {
    const epoch = Math.floor(2241840 / 14400);
    const mark = (tree) => tree.root.findAll((n) => typeof n.type === 'string' && /^node-epoch-(answered|waiting)$/.test(n.props.testID || ''))
      .map((n) => n.props.testID);
    let tree = render({ light: light({ local: LOCAL, answeredAt: { epoch, at: Date.now() }, status: status({ answered: true }) }) });
    expect(mark(tree)).toEqual(['node-epoch-answered']);
    // No round mark at the head; the chip comes first on the type's row.
    expect(tree.root.findAll((n) => /^node-pulse-/.test(n.props.testID || '')).length).toBe(0);
    const row = tree.root.find((n) => typeof n.type === 'string' && n.props.testID === 'node-head-row');
    const [first, last] = [row.children[0], row.children[row.children.length - 1]];
    expect([first.findAll((n) => n.props.testID === 'node-status').length > 0, last.type]).toEqual([true, Text]);
    // The whole name on one line, shrunk to fit and never cut, in the one copy element (components/ui/Copyable) with its
    // copy mark at the end; no Copy word.
    const name = tree.root.find((n) => n.type === Text && n.props.testID === 'node-id');
    expect([[].concat(name.props.children).join(''), name.props.numberOfLines, name.props.adjustsFontSizeToFit, name.props.ellipsizeMode, name.props.onPress])
      .toEqual([NODE, 1, true, undefined, undefined]);
    const Copyable = require('../src/components/ui/Copyable').default;
    const copy = tree.root.findAllByType(Copyable);
    expect(copy.map((c) => [c.props.text, c.props.testID])).toEqual([[NODE, 'node-id-copy']]);
    expect(copy[0].findAll((n) => n === name)).toHaveLength(1);
    expect(tree.root.findAll((n) => typeof n.type === 'string' && /^copy-glyph/.test(n.props.testID || ''))).toHaveLength(1);
    tree = render({ light: light({ local: LOCAL, status: status({ answered: false }) }) });
    expect(mark(tree)).toEqual(['node-epoch-waiting']);
    // The title stays with the tab unless the screen pins it above its scroll.
    const heads = (tr) => tr.root.findAll((n) => n.type === Text && n.props.accessibilityRole === 'header').map((n) => n.props.children);
    expect(heads(render({ light: light({ local: LOCAL }) }))).toEqual([t('node_title')]);
    expect(heads(render({ light: light({ local: LOCAL }), showHead: false }))).toEqual([]);
  });

  // Two sections: the node's identity on top (type, whole name, status chip), then one Status
  // section with the epoch bar and the rows, the Background row in Mint while unrestricted and in Ember while
  // restricted, and the node balance with Move to wallet at its foot. A server node's card is built the same way.
  it('two sections: the identity, then the status with the balance and Move to wallet at its foot', () => {
    const { color } = require('../src/theme');
    const sections = (tree) => tree.root.findAll((n) => n.type === Section);
    // What the section holds, in order, by the ids of its parts.
    const order = (node) => node.findAll((n) => n !== node
      && /^node-(epoch-bar|background-value|background|use|balance|move)$/.test(n.props.testID || ''), { deep: false })
      .map((n) => n.props.testID);
    const toneOf = (tree) => StyleSheet.flatten(tree.root.find((n) => n.type === Text && n.props.testID === 'node-background-value')
      .props.style).color;
    const here = (priority) => render({ onOpenBackground: noop, light: light({ local: LOCAL, balanceNano: 2e9, status: status({ answered: true }),
      background: { priority, changeable: true } }) });
    const tree = here('unrestricted');
    const [identity, card, ...more] = sections(tree);
    expect([identity.props.testID, card.props.testID, more.length]).toEqual(['node-identity', 'node-status-section', 0]);
    // The identity holds the chip, the type and the whole name (a tap copies it), and no action.
    expect(identity.findAll((n) => n.props.testID === 'node-status').length).toBeGreaterThan(0);
    expect(identity.findAll((n) => n.type === Text && n.props.testID === 'node-id')).toHaveLength(1);
    expect(identity.findAllByType(Action)).toHaveLength(0);
    expect(card.props.title).toBe(t('node_status'));
    expect(order(card)).toEqual(['node-epoch-bar', 'node-background-value', 'node-balance', 'node-move']);
    expect(toneOf(tree)).toBe(color.mint);
    // Restricted: Ember, with the one way to lift it under the row; the balance and Move still last.
    const held = here('restricted');
    expect(toneOf(held)).toBe(color.ember);
    expect(order(sections(held)[1])).toEqual(['node-epoch-bar', 'node-background-value', 'node-background', 'node-balance', 'node-move']);
    // A server node: its identity, then its status with the balance and Move to wallet last.
    const server = render({ server: { nodeType: 'super', nodeId: 'super_node_60a735f53dd87f1b',
      status: { success: true, registered: true, isOnline: true, pendingRewards: 2e9, lastSeen: 1, lastSeenAgoSeconds: 60 } }, light: null });
    const [sId, sCard, ...sMore] = sections(server);
    expect([sId.props.testID, sCard.props.testID, sMore.length]).toEqual(['node-identity', 'node-status-section', 0]);
    expect(order(sCard)).toEqual(['node-epoch-bar', 'node-balance', 'node-move']);
  });

  it('this device, Offline: the hint, nothing to press for it; below 1 QNC nothing moves, with no note about it', () => {
    const tree = render({ light: light({ local: LOCAL, balanceNano: 0.4e9, status: status({ needsReactivation: true, answered: false }) }) });
    const text = shown(tree);
    expect(statusOf(tree)).toEqual([['needs', t('node_status_offline')]]);
    expect(text).not.toMatch(/answers again when the app is opened|reaches 1 QNC/);
    expect(text).toContain(t('node_answered_no'));
    expect(buttons(tree)).toEqual(['node-move']);
    expect(moveButton(tree).props.disabled).toBe(true);
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

  // The app shows no missed epochs: the site's node cabinet does (owner, 18.10); before, a "Missed epochs" row.
  it('a server node shows last seen, its heartbeats this epoch and the balance, and no missed epochs', () => {
    const tree = render({
      server: { nodeType: 'super', nodeId: SUPER, status: serverStatus(), epochs: { counted: 5, missed: 1, notAdmitted: 0 } }, light: null,
    });
    const text = shown(tree);
    expect(text).toContain(SUPER);
    expect(statusOf(tree)).toEqual([['live', t('node_active')]]);
    expect(text).toContain(`${t('node_last_seen')}\n${t('node_last_seen_ago', { time: t('node_ago_m', { m: 2 }) })}`);
    expect(text).toContain(`${t('node_heartbeats')}\n${t('node_heartbeats_of', { n: 4, m: 9 })}`);
    expect(text).not.toMatch(/Counted epochs|5 of 6/); // the site's node cabinet counts epochs (owner, 11.10)
    expect(text).not.toMatch(/Missed|node_missed/);
    expect(hasKey('node_missed')).toBe(false);
    expect(text).toContain('2 QNC');
    expect(buttons(tree)).toEqual(['node-move']);
    // Offline, as a node that has it offline answers: no time seen, no epochs yet (unknown until read).
    const offTree = render({
      server: { nodeType: 'super', nodeId: SUPER, status: serverStatus({ isOnline: false, lastSeen: 0, lastSeenAgoSeconds: undefined }), epochs: null },
      light: null,
    });
    const off = shown(offTree);
    expect(statusOf(offTree)).toEqual([['needs', t('node_server_offline')]]);
    expect(off).toContain(t('node_server_offline'));
    expect(off).not.toContain(t('node_last_seen'));
  });

  // Owner, 11.10: a network rule holds outside super nodes back from consensus while registrations stay open. Such a
  // node, registered and not admitted (its status's admission 'waiting'), says so in place of Offline, and what it
  // earned moves all the same. A node that says nothing of admission is not waiting.
  it('a super node registered and not admitted to consensus yet: said so, never Offline, its balance movable', () => {
    const waiting = serverStatus({ isOnline: false, lastSeen: 0, lastSeenAgoSeconds: undefined, admission: 'waiting' });
    const tree = render({ server: { nodeType: 'super', nodeId: SUPER, status: waiting, epochs: null }, light: null });
    const text = shown(tree);
    expect(statusOf(tree)).toEqual([['needs', t('node_waiting_admission')]]);
    expect(text).not.toContain(t('node_server_offline'));
    expect(text).toContain('2 QNC');
    expect(moveButton(tree).props.disabled).toBe(false);
    expect(t('node_waiting_admission')).toBe('Registered, not admitted to consensus yet');
    expect(waitingAdmission(waiting)).toBe(true);
    for (const s of [serverStatus({ isOnline: false }), serverStatus({ admission: 'admitted' }),
      serverStatus({ admission: 'not_required' }), serverStatus({ registered: false, admission: 'waiting' }), null]) {
      expect(waitingAdmission(s)).toBe(false);
    }
    // The node's admission 'waiting' (what live nodes report) is the same state, as the site shows it: online or not.
    expect(waitingAdmission(serverStatus({ admission: 'waiting' }))).toBe(true);
    const reportedTree = render({ server: { nodeType: 'super', nodeId: SUPER, status: serverStatus({ admission: 'waiting' }), epochs: null }, light: null });
    expect(statusOf(reportedTree)).toEqual([['needs', t('node_waiting_admission')]]);
    expect(shown(reportedTree)).not.toContain(t('node_active'));
    // Online, as before, while the node names no admission rule.
    expect(statusOf(render({ server: { nodeType: 'super', nodeId: SUPER, status: serverStatus(), epochs: null }, light: null })))
      .toEqual([['live', t('node_active')]]);
  });

  // Plan P1: the node's own admission field, when it reports it admitted, is a row of the card ("Admitted"); waiting is
  // the node's status (the test above); a node that says nothing of it, or that no rule governs the epoch, shows no row.
  // Epochs outside the admitted set are not admitted, never missed.
  it('a super node\'s admission, when the node reports it, and its epochs outside admission counted apart', () => {
    const card = (over, epochs = null) => shown(render({ server: { nodeType: 'super', nodeId: SUPER, status: serverStatus(over), epochs }, light: null }));
    expect(card({ admission: 'admitted' })).toContain(`${t('node_admission')}\n${t('node_admission_admitted')}`);
    for (const over of [{}, { admission: 'waiting' }, { admission: 'not_required' }, { admission: undefined }]) {
      expect(card(over)).not.toContain(t('node_admission'));
    }
    expect(rewardAdmission(serverStatus({ admission: 'waiting', registered: false }))).toBe(null);
    expect(rewardAdmission(null)).toBe(null);
    const text = card({ admission: 'waiting' }, { counted: 3, missed: 1, notAdmitted: 4 });
    expect(text).not.toMatch(/Missed/);
    expect(text).toContain(`${t('node_not_admitted')}\n4`);
    expect(card({}, { counted: 3, missed: 0, notAdmitted: 0 })).not.toContain(t('node_not_admitted'));
  });

  // Owner, 11.10: a move in transit (services/ClaimTransit) shows as "Moving X" with the button off and the rest of the
  // balance; one that did not go through is said under the button. The balance and its watermark are the wallet's, so a
  // move made by either node id holds the card that shows the balance, whichever it is.
  it('a move in transit: Moving X, the button off, the rest of the balance; nothing else says what became of it', () => {
    const move = (nodeId, amountNano, restNano) => ({ nodeId, amountNano, restNano, prevWatermark: 100, lastEpoch: 103, parts: null, txHash: 'ab'.repeat(32), time: Date.now() });
    // A move of the light node's id (a QNet Link sheet), with the super node's card showing the wallet's balance.
    const transit = { owner: 'w', moves: [move(NODE, '12500000000', 500_000_000)], outcomes: [], floor: null };
    const tree = render({
      server: { nodeType: 'super', nodeId: SUPER, status: serverStatus({ pendingRewards: 13e9 }), epochs: null },
      light: light({ local: LOCAL, balanceNano: 13e9, status: status({ answered: true }) }),
      transit,
    });
    const text = shown(tree);
    expect(text).toContain(t('node_moving', { amount: '12.5 QNC' }));
    // The rest of the balance, never the amount moving, and once: the light card under it shows no balance of its own.
    expect(text).toContain(`${t('node_balance')}\n0.5 QNC`);
    expect(text).not.toContain('13 QNC');
    expect(text.split(t('node_balance')).length - 1).toBe(1);
    const moves = tree.root.findAllByType(Action).filter((n) => n.props.testID === 'node-move');
    expect(moves.map((n) => n.props.disabled)).toEqual([true]);
    // The light card alone holds the same move whichever id made it.
    const alone = render({ light: light({ local: LOCAL, balanceNano: 13e9, status: status({ answered: true }) }),
      transit: { ...transit, moves: [move(SUPER, '12500000000', 500_000_000)] } });
    expect(shown(alone)).toContain(t('node_moving', { amount: '12.5 QNC' }));
    expect(moveButton(alone).props.disabled).toBe(true);
    // A settled move leaves no sentence on the card (owner, 12.10: no "did not go through"): the balance, the button on.
    const settled = { owner: 'w', moves: [], outcomes: [{ nodeId: SUPER, txHash: null, amountNano: '12500000000', result: 'done', at: Date.now() }], floor: 103 };
    const after = render({ light: light({ local: LOCAL, balanceNano: 13e9, status: status({ answered: true }) }), transit: settled });
    expect(moveButton(after).props.disabled).toBe(false);
    expect(shown(after)).toContain(`${t('node_balance')}\n13 QNC`);
    expect(after.root.findAll((n) => n.props.testID === 'node-move-failed')).toEqual([]);
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

  // The node balance is the wallet's (the network sums one wallet's reward leaves whichever node id is asked), so with
  // both cards it shows, and moves, once: on the server card. Before, each card showed the same figure with its own move.
  it('a wallet with a super and a light node on the chain: both cards, the server first, the balance and its move once', () => {
    const moved = [];
    const tree = render({
      server: { nodeType: 'super', nodeId: SUPER, status: serverStatus({ pendingRewards: 3e9 }), epochs: null },
      light: light({ local: LOCAL, balanceNano: 3e9, status: status({ answered: true }) }),
      onMove: () => moved.push('light'), onMoveServer: () => moved.push('server'),
    });
    const text = shown(tree);
    expect(text.indexOf(SUPER)).toBeGreaterThan(-1);
    expect(text.indexOf(SUPER)).toBeLessThan(text.indexOf(NODE));
    expect(buttons(tree)).toEqual(['node-move']);
    expect(text.split('3 QNC').length - 1).toBe(1);
    act(() => { moveButton(tree).props.onPress(); });
    expect(moved).toEqual(['server']);
    // A server card that shows no balance (not registered): the light card keeps its own.
    const unregistered = render({
      server: { nodeType: 'super', nodeId: SUPER, status: serverStatus({ registered: false }), epochs: null },
      light: light({ local: LOCAL, balanceNano: 3e9, status: status({ answered: true }) }),
    });
    expect(buttons(unregistered)).toEqual(['node-move']);
    expect(shown(unregistered)).toContain('3 QNC');
    // Under a server node a light node that is not the wallet's shows nothing: no "no node" line under the server card.
    for (const s of [status({ onChain: false }), status({ onChain: null })]) {
      const only = render({ server: { nodeType: 'super', nodeId: SUPER, status: serverStatus(), epochs: null }, light: light({ status: s }) });
      expect(shown(only)).not.toContain(t('node_none'));
      expect(shown(only)).not.toContain(t('node_unreachable'));
      expect(buttons(only)).toEqual(['node-move']);
    }
  });

  // A light node on another device shows under the server card too: which device runs it, its status and its last
  // counted epoch; the wallet's one balance and its move stay on the server card.
  it('a wallet with a super node and a light node on another device: both cards, the server first, one balance and one move', () => {
    const IPHONE = { platform: 'ios', model: 'iPhone 15 Pro', linkedSince: 1790035200, lastAnswerEpoch: 151, state: 'online' };
    const moved = [];
    const tree = render({
      server: { nodeType: 'super', nodeId: SUPER, status: serverStatus({ pendingRewards: 3e9 }), epochs: null },
      light: light({ balanceNano: 3e9, status: status({ device: IPHONE, counted: { since: 60, counted: 48, last: 1234 } }) }),
      onMove: () => moved.push('light'), onMoveServer: () => moved.push('server'),
    });
    const text = shown(tree);
    expect(text.indexOf(SUPER)).toBeGreaterThan(-1);
    expect(text.indexOf(SUPER)).toBeLessThan(text.indexOf('The node runs on iPhone 15 Pro.'));
    expect(text).toContain(`${t('node_last_counted')}\nEpoch 1,234`);
    expect(statusOf(tree)).toEqual([['live', t('node_active')], ['live', t('node_status_online')]]);
    expect(text.split(t('node_balance')).length - 1).toBe(1);
    expect(text.split('3 QNC').length - 1).toBe(1);
    expect(text).not.toContain(t('node_use'));
    expect(buttons(tree)).toEqual(['node-move']);
    act(() => { moveButton(tree).props.onPress(); });
    expect(moved).toEqual(['server']);
    // A server card that shows no balance (not registered): the other device's card keeps it, with its move.
    const unregistered = render({
      server: { nodeType: 'super', nodeId: SUPER, status: serverStatus({ registered: false }), epochs: null },
      light: light({ balanceNano: 3e9, status: status({ device: IPHONE }) }),
    });
    expect(shown(unregistered)).toContain('The node runs on iPhone 15 Pro.');
    expect(shown(unregistered)).toContain(`${t('node_balance')}\n3 QNC`);
    expect(buttons(unregistered)).toEqual(['node-move']);
  });

  // Only an answer that names the card's node registered replaces its status; any other keeps the last good one, said
  // stale above it, so the card never turns into another and back. Before a good status it is being checked, and a
  // failed read with none says the network could not be reached.
  it('a super node\'s card: only an answer about its node replaces the status; any other keeps the last good one, stale', () => {
    const card = (status) => render({ server: { nodeType: 'super', nodeId: SUPER, status, epochs: null }, light: null });
    const generic = (tree) => shown(tree).includes(t('node_super_server'));
    expect(shown(card(null))).toContain(t('node_checking'));
    expect(shown(card({ success: false, error: 'network' }))).toContain(t('node_unreachable'));
    expect(buttons(card({ success: false, error: 'network' }))).toEqual([]);
    const good = serverStatus();
    // Not registered, no node named, another node, a failure, nothing at all: the last good status stays, marked stale.
    for (const answer of [
      serverStatus({ registered: false }), { success: true, registered: false, nodeId: null, isOnline: false },
      serverStatus({ nodeId: 'super_node_other' }), { success: false, error: 'network' }, null,
    ]) {
      const kept = serverStatusAfter(good, answer, SUPER);
      expect([answer, kept]).toEqual([answer, { ...good, stale: true }]);
      const tree = card(kept);
      expect(shown(tree)).toContain(t('node_unreachable'));
      expect(statusOf(tree)).toEqual([['live', t('node_active')]]);
      expect(shown(tree)).toContain('2 QNC');
      expect(buttons(tree)).toEqual(['node-move']);
      expect(generic(tree)).toBe(false);
      expect(serverStatusAfter(kept, answer, SUPER)).toBe(kept);
    }
    // The next answer about the node replaces it, with no stale mark.
    const next = serverStatus({ pendingRewards: 5e9 });
    expect(serverStatusAfter({ ...good, stale: true }, next, SUPER)).toBe(next);
    // With no good status of this node, never another node's: an answer leaves it being checked, a failure unreachable.
    expect(serverStatusAfter(serverStatus({ nodeId: 'super_node_other' }), serverStatus({ registered: false }), SUPER)).toBe(null);
    expect(serverStatusAfter(null, serverStatus({ nodeId: 'super_node_other' }), SUPER)).toBe(null);
    expect(serverStatusAfter(good, { success: false }, 'super_node_other')).toEqual({ success: false, error: 'network' });
    expect(serverStatusAfter(null, null, SUPER)).toEqual({ success: false, error: 'network' });
    // A status that says the node is not registered never shows as a card of its own.
    expect(shown(card(serverStatus({ registered: false })))).toContain(t('node_checking'));
    expect(generic(card(serverStatus({ registered: false })))).toBe(false);
    expect(hasKey('node_super_server_sub')).toBe(false);
  });

  // What aiqnet.io records of a super node is said only once two genesis nodes say the wallet has no node: while the
  // wallet's node is unknown nothing is claimed, and a node they name shows as itself.
  it('a super node aiqnet.io recorded for a wallet the genesis nodes say has none: its sentence, nothing to press; a light one is not this device\'s', () => {
    // A light node bound to no device yet is not shown (owner, 11.10): what a wallet without a node shows.
    let tree = render({ light: light({ status: status({ onChain: false }) }), recorded: 'light', walletNode: 'none' });
    expect(shown(tree)).toBe(NO_NODE);
    expect(buttons(tree)).toEqual([]);
    tree = render({ light: light({ status: status({ onChain: false }) }), recorded: 'super', walletNode: 'none' });
    expect(shown(tree)).toContain(t('node_title_super'));
    expect(shown(tree)).toContain(t('node_not_on_network_super'));
    expect(shown(tree)).not.toContain(t('node_super_server'));
    expect(buttons(tree)).toEqual([]);
    // While the wallet's node is unknown: being checked, neither "not joined" nor "no node".
    tree = render({ light: light({ status: status({ onChain: false }) }), recorded: 'super' });
    expect(shown(tree)).toBe(`${t('node_title')}\n${t('node_checking')}`);
    // A node the genesis nodes name whose status is still being read or could not be read: its card, never "not joined".
    for (const s of [null, { success: false, error: 'network' }]) {
      tree = render({ server: { nodeType: 'super', nodeId: SUPER, status: s, epochs: null }, light: null, recorded: 'super',
        walletNode: { nodeId: SUPER, nodeType: 'super' } });
      expect(shown(tree)).toContain(t(s ? 'node_unreachable' : 'node_checking'));
      expect(shown(tree)).not.toContain(t('node_not_on_network_super'));
    }
    // Its status in: the detailed card, its balance and its move.
    tree = render({ server: { nodeType: 'super', nodeId: SUPER, status: serverStatus(), epochs: null }, light: null, recorded: 'super',
      walletNode: { nodeId: SUPER, nodeType: 'super' } });
    expect(statusOf(tree)).toEqual([['live', t('node_active')]]);
    expect(buttons(tree)).toEqual(['node-move']);
    expect(shown(tree)).not.toContain(t('node_not_on_network_super'));
    // Without such a record, as before.
    tree = render({ light: light({ status: status({ onChain: false }) }), walletNode: 'none' });
    expect(shown(tree)).toContain(t('node_none'));
    expect(t('node_not_on_network_super')).toBe(
      "This wallet's super node has not joined QNet Blockchain yet. It runs on a server with QNet Blockchain node software.");
    expect(hasKey('node_not_on_network_light')).toBe(false);
  });

  it('no card shows a code, a price, a link or an address to open', () => {
    const trees = [
      render({ server: { nodeType: 'super', nodeId: SUPER, status: serverStatus(), epochs: { counted: 1, missed: 0 } },
        light: light({ local: LOCAL, status: status() }) }),
      render({ light: light({ status: status({ onChain: false }) }), recorded: 'super', walletNode: 'none' }),
      render({ light: light({ status: status({ onChain: false }) }), recorded: 'light', walletNode: 'none' }),
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
    expect(src).toMatch(/if \(!server \|\| lightShownRef\.current\) load\.loadLightNodeStatus\(\{ fresh: false \}\);\s*\}, NODE_STATUS_MS\);/);
    // While a binding with no answer waits, every read asks for the network's word on it.
    expect(src).toMatch(/const sign = !!unconfirmed \|\| \(!!local && \(fresh \|\| !same \|\| Date\.now\(\) - last\.at >= SIGNED_STATUS_MS\)\);/);
    // It is settled by this read's word only, before the check that would end the binding it replaced.
    expect(src.indexOf('settleUnconfirmedBinding(nodeId, status)')).toBeGreaterThan(-1);
    expect(src.indexOf('settleUnconfirmedBinding(nodeId, status)')).toBeLessThan(src.indexOf('kept.verdict) {'));
    expect(src.indexOf('settleUnconfirmedBinding(nodeId, status)')).toBeLessThan(src.indexOf('forgetIfReplaced(nodeId, status, local.seq)'));
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
      if (opts && opts.method === 'POST') {
        const p = post(url);
        return p && typeof p.then === 'function' ? p.then(reply) : reply(p);
      }
      const i = owners.findIndex((o) => url.startsWith(o));
      const a = byOwner[i];
      if (a && typeof a.then === 'function') return a.then(reply);
      return a instanceof Error ? Promise.reject(a) : reply(a);
    });
  };
  // An owner's answer that comes only when the test gives it.
  const later = () => {
    let give;
    const p = new Promise((r) => { give = r; });
    p.give = give;
    return p;
  };
  const flush = () => new Promise((r) => { setTimeout(r, 0); });

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

  it('the day of the bound device\'s binding only as two owners report it alike', async () => {
    const device = { platform: 'ios', model: 'iPhone 15 Pro', linked_since: 1790035200, last_answer_epoch: 1240, state: 'online' };
    answers([pub({ device }), pub({ device }), pub()]);
    expect((await readNodeStatus(NODE)).linkedSinceAgreed).toBe(1790035200);
    answers([pub({ device }), pub({ device: { ...device, linked_since: 1790121600 } }), pub()]);
    expect((await readNodeStatus(NODE)).linkedSinceAgreed).toBe(null);
    answers([pub({ device }), new Error('down'), { success: false, error: 'rate limited' }]);
    expect((await readNodeStatus(NODE)).linkedSinceAgreed).toBe(null);
  });

  // A shard owner that does not answer (down, or a connection gone silent) holds nothing back: the status settles as
  // soon as two owners agree, and the third refines what one owner's word decides.
  it('settles once two owners agree, before the third, which then refines it (answered on any owner\'s word)', async () => {
    const third = later();
    answers([pub({ answered_this_epoch: false }), pub({ answered_this_epoch: false }), third]);
    const agreed = jest.fn();
    let done = null;
    const read = readNodeStatus(NODE, { onAgreed: agreed }).then((s) => { done = s; });
    await flush();
    expect(agreed).toHaveBeenCalledTimes(1);
    expect(agreed.mock.calls[0][0]).toMatchObject({ onChain: true, deviceBoundAgreed: true, answered: false, features: ['bind_v2', 'status_signed'] });
    expect(done).toBe(null);
    third.give(pub({ answered_this_epoch: true }));
    await read;
    expect(done).toMatchObject({ onChain: true, answered: true });
    expect(agreed).toHaveBeenCalledTimes(1);
    // The sheet's read takes the agreed status and never waits for the third.
    const slow = later();
    answers([pub(), pub(), slow]);
    expect(await readAgreedNodeStatus(NODE)).toMatchObject({ onChain: true });
    slow.give(pub());
    // No node, as soon as two owners say so.
    const down = later();
    answers([pub({ onchain_registered: false }), down, pub({ onchain_registered: false })]);
    expect((await readAgreedNodeStatus(NODE)).onChain).toBe(false);
    down.give(pub({ onchain_registered: false }));
  });

  it('waits for the third while it could still change a verdict two owners must give alike', async () => {
    const splits = [
      [pub(), pub({ onchain_registered: false })], // on the chain or not
      [pub({ device_bound: true }), pub({ device_bound: false })], // whether a device is bound
      [pub({ features: ['bind_v2'] }), pub({ features: ['bind_v2', 'status_signed'] })], // a form one of them lists
    ];
    for (const [a, b] of splits) {
      const third = later();
      answers([a, b, third]);
      const agreed = jest.fn();
      const read = readNodeStatus(NODE, { onAgreed: agreed });
      await flush();
      expect(agreed).not.toHaveBeenCalled();
      third.give(pub());
      await read;
      // Every answer was in by then: the read itself is the answer.
      expect(agreed).not.toHaveBeenCalled();
    }
  });

  it('asks for the signed status once the public verdicts settle, and settles on the binding two signed answers name', async () => {
    const third = later();
    answers([pub(), pub(), third], () => ({ ...pub(), binding_seq: 1790000000, device_state: 'active' }));
    const sign = jest.fn(async () => ({ signer: 'ping', sig: 'ab' }));
    const agreed = jest.fn();
    const read = readNodeStatus(NODE, { signStatus: sign, onAgreed: agreed });
    await flush();
    expect(calls.filter((c) => c.body)).toHaveLength(3);
    expect(agreed).toHaveBeenCalledTimes(1);
    expect(agreed.mock.calls[0][0]).toMatchObject({ onChain: true, bindingSeqAgreed: 1790000000, keyOurs: true, signer: 'ping' });
    third.give(pub());
    expect(await read).toMatchObject({ onChain: true, bindingSeqAgreed: 1790000000, keyOurs: true });
    // Signed answers that name two bindings wait for the third.
    const seqs = { 0: later(), 1: 5, 2: 6 };
    answers([pub(), pub(), pub()], (url) => {
      const i = owners.findIndex((o) => url.startsWith(o));
      return i === 0 ? seqs[0].then((seq) => ({ ...pub(), binding_seq: seq })) : { ...pub(), binding_seq: seqs[i] };
    });
    const waiting = jest.fn();
    const split = readNodeStatus(NODE, { signStatus: sign, onAgreed: waiting });
    await flush();
    expect(waiting).not.toHaveBeenCalled();
    seqs[0].give(6);
    expect((await split).bindingSeqAgreed).toBe(6);
  });

  it('the pending-link record lives T + 24 h + 10 min', async () => {
    const T = 1790000000;
    await AsyncStorage.setItem(LINK_PENDING_KEY, JSON.stringify({ nodeId: NODE, wallet: 'w', T, createdAt: T, bound: false }));
    expect((await readLinkPending(NODE, (T + 86400 + 599) * 1000)).expired).toBe(false);
    expect((await readLinkPending(NODE, (T + 86400 + 601) * 1000)).expired).toBe(true);
    expect(await readLinkPending('light_mobile_0000000000000001', T * 1000)).toBe(null);
  });
});
