/**
 * Final audit, mobile fixer round 2 (MN-R2-01 … MN-R2-06, SD-R2-01), the node on this device: the key rotation falls
 * due by the chain's epoch and the tab offers a new key once the node stopped counting an unrotated one; refused
 * rotations back off; one enrolment runs at a time and a binding holds this device's key only when the key it carried is
 * current; a binding the network holds no more stops waking here; the last update of the old package runs no node from
 * its first wake; and a refused device carries the support reference its appeal needs.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signWithDilithium: jest.fn().mockResolvedValue('sig'),
  signDetached: jest.fn().mockResolvedValue('ab'.repeat(8)),
  generateRawDilithiumKeypair: jest.fn(),
}));
jest.mock('../src/services/NodeDeviceKey', () => ({
  checkDevice: jest.fn(),
  currentKey: jest.fn(async () => null),
  isThisDevice: jest.fn(async () => null),
  enrolEvidence: jest.fn(),
  rotationEvidence: jest.fn(),
  commitKey: jest.fn(async () => {}),
  dropPendingKey: jest.fn(async () => {}),
  keepUnanswered: jest.fn(async () => {}),
  showPlayDialog: jest.fn(),
  vendorToken: jest.fn(),
  sign: jest.fn(),
  forgetKey: jest.fn(async () => true),
  forgetKeys: jest.fn(async () => {}),
  hasUnansweredKey: jest.fn(async () => false),
  settleByTag: jest.fn(async () => null),
}));

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

const fs = require('fs');
const path = require('path');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const messaging = require('@react-native-firebase/messaging').default;
const DeviceKey = require('../src/services/NodeDeviceKey');
const E = require('../src/services/DeviceEnrolment');
const Push = require('../src/services/PushService');
const { readNodeStatus, writeLinkPending, LINK_PENDING_KEY } = require('../src/services/LightNode');
const { lightShardOwnerUrls } = require('../src/config/nodes');
const { default: NodeTab, nodeView } = require('../src/screens/NodeTab');
const { makeT } = require('../src/i18n');

const V = require('../../../docs/protocols/light-node.vectors.json');

const NODE = V.wallets[0].nodeId;
const WALLET = V.wallets[0].address;
const OWNERS = lightShardOwnerUrls(NODE);
const PP = V.pingKey.publicKey;
const SEQ = 1790000000;
const ANDROID_KEY = { platform: 'android', handle: 'qnet_dev_a', hwPub: V.device.keys.android.publicKey, attested: true };
const FLAGS = V.device.messages.find((m) => m.name === 'enrol' && m.platform === 'android').flags;
const DEVICE = { capable: true, platform: 'android', flags: FLAGS, report: V.device.report.text };
const NONCE = V.device.status.refNonce;
const EPOCH = Math.floor(V.device.ping.height / 14400);
const t = makeT('en');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let calls;
let answers;
const reply = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  DeviceKey.isThisDevice.mockResolvedValue(null);
  DeviceKey.hasUnansweredKey.mockResolvedValue(false);
  DeviceKey.settleByTag.mockResolvedValue(null);
  DeviceKey.checkDevice.mockResolvedValue(DEVICE);
  DeviceKey.commitKey.mockResolvedValue(undefined);
  require('../src/crypto/DilithiumCrypto').signDetached.mockResolvedValue(V.device.ping.sigma);
  Keychain.getGenericPassword.mockResolvedValue({ password: 'ping-sk' });
  calls = [];
  answers = () => ({ success: true });
  global.fetch = jest.fn((url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const a = answers(url, body, opts);
    if (a && typeof a.then === 'function') return a.then((x) => (x instanceof Error ? Promise.reject(x) : reply(x)));
    return a instanceof Error ? Promise.reject(a) : reply(a);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  Keychain.getGenericPassword.mockResolvedValue(false);
});

const linkedHere = async ({ hw = true, seq = SEQ, boundAt, features = ['device_v1', 'hwping_v2', 'status_signed'], schedule = {} } = {}) => {
  await AsyncStorage.multiSet([
    ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, walletAddress: WALLET, pushType: 'fcm', seq, hw, ...(boundAt ? { boundAt } : {}) })],
    ['qnet_ping_node_id', NODE],
    [`qnet_ping_dilithium_pk_${NODE}`, PP],
    [`qnet_ping_cert_${NODE}`, `v2.${seq}.cert`],
    [E.SCHEDULE_KEY, JSON.stringify({ nodeId: NODE, features, refresh: null, refreshedFor: null, rotationDue: null, ...schedule })],
  ]);
};
const pub = (over = {}) => ({
  onchain_registered: true, device_bound: true, answered_this_epoch: true, features: ['status_signed', 'device_v1', 'hwping_v2', 'bind_v2'],
  ...over,
});
const signer = () => ({
  signNodeStatus: async () => ({ signer: 'wallet', sig: 'ws', identityPublicKey: 'id' }),
  prepareLightNodeBinding: async (cred, { seq }) => ({
    nodeId: NODE, wallet: WALLET, identityPublicKey: 'id', pingPublicKey: PP, delegation: 'del', attachSig: `att${seq}`,
    keep: async () => {}, wipe: () => {},
  }),
});
const schedule = async () => JSON.parse(await AsyncStorage.getItem(E.SCHEDULE_KEY));
const info = async () => JSON.parse(await AsyncStorage.getItem('qnet_light_node_info'));
const binds = () => calls.filter((c) => c.url.endsWith('/light-node/bind'));
const rotations = () => calls.filter((c) => c.url.endsWith('/device-rotate'));
const evidence = (handle = 'qnet_dev_b') => ({
  key: { ...ANDROID_KEY, handle }, device: { platform: 'android', chain: ['c'] }, oldSig: 'o', token: { field: 'pi_token', value: 'pt' },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('MN-R2-01: the key rotation falls due by the chain\'s epoch', () => {
  it('a device whose replies the node refuses still rotates: the wake reads the epoch from the chain, not from its last credit', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    // The rotation fell due five epochs ago; the last credited answer is from before it, and every reply is refused now.
    await linkedHere({ schedule: { rotationDue: EPOCH - 5, deviceState: 'active', statusAt: now } });
    await AsyncStorage.setItem(Push.LAST_ANSWER_KEY, JSON.stringify({ epoch: EPOCH - 6, at: now - 86400000 }));
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockResolvedValue('dsig');
    DeviceKey.rotationEvidence.mockResolvedValue(evidence());
    answers = (url) => {
      if (url.endsWith('/ping-response')) return { success: false, reason: 'device_stale' };
      if (url.includes('/device-challenge')) return { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' };
      if (url.endsWith('/device-rotate')) return { success: true, device_state: 'active', rotation_due: EPOCH + 180 };
      return {};
    };
    await Push.handlePushMessage({ action: 'epoch', anchor: `${V.device.ping.height}:${V.device.ping.hash}` });
    expect(JSON.parse(await AsyncStorage.getItem(Push.LAST_ANSWER_KEY)).epoch).toBe(EPOCH - 6); // nothing was credited
    expect(JSON.parse(await AsyncStorage.getItem(Push.CHAIN_EPOCH_KEY)).epoch).toBe(EPOCH);
    expect(rotations()).toHaveLength(1);
    expect(await schedule()).toMatchObject({ rotationDue: EPOCH + 180 });
  });

  it('the tab offers a new key once the node stopped counting an unrotated one', () => {
    const LOCAL = { nodeId: NODE, seq: SEQ, pushType: 'fcm', hw: true };
    const status = (signed) => ({
      onChain: true, deviceBound: true, needsReactivation: true, keyOurs: true, features: ['device_v1'], signed,
    });
    const overdue = { deviceState: 'check_pending', rotationDue: EPOCH - 181, refreshWindow: { from: 1, to: 2 } };
    const height = V.device.ping.height;
    expect(nodeView({ status: status(overdue), local: LOCAL, height }))
      .toMatchObject({ state: 'here', offerUse: true, notice: { key: 'node_key_overdue' } });
    // Not yet due, or no height known: the check that runs (its next check named), nothing to press.
    expect(nodeView({ status: status({ ...overdue, rotationDue: EPOCH + 1 }), local: LOCAL, height }))
      .toMatchObject({ offerUse: false, notice: { key: 'node_check_running' } });
    expect(nodeView({ status: status(overdue), local: LOCAL })).toMatchObject({ offerUse: false, notice: { key: 'node_check_running' } });
    let tree;
    act(() => {
      tree = renderer.create(<NodeTab t={t} height={height} light={{
        nodeId: NODE, status: status(overdue), local: LOCAL, pending: null, answeredAt: null, balanceNano: 0,
      }} onMove={() => {}} onUse={() => {}} onCopy={() => {}} nodeTitle={() => ''} />);
    });
    const texts = tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join(''));
    expect(texts).toContain(t('node_key_overdue'));
    expect(tree.root.findAllByProps({ testID: 'node-use' }).length).toBeGreaterThan(0);
  });
});

describe('MN-R2-02: a refused rotation backs off before another key is attested', () => {
  const due = (over = {}) => ({ rotationDue: 10, deviceState: 'active', ...over });
  const H = 3600 * 1000;

  it('6 h, then 12 h, at least what the node asked, and a new rotation epoch starts over', async () => {
    const t0 = 1790000000000;
    await linkedHere({ schedule: due() });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.rotationEvidence.mockResolvedValue(evidence());
    answers = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' }
      : { success: false, reason: 'device_stale' });
    const rotate = (now) => E.rotateIfDue(NODE, { epoch: 20, seq: SEQ, pingPublicKey: PP, device: DEVICE, now });
    expect(await rotate(t0)).toBe(false);
    expect(await schedule()).toMatchObject({ rotateRefusals: 1, rotateNextAt: t0 + 6 * H });
    expect(await rotate(t0 + 6 * H)).toBe(false); // the first wait is over
    expect(DeviceKey.rotationEvidence).toHaveBeenCalledTimes(2);
    expect(await schedule()).toMatchObject({ rotateRefusals: 2, rotateNextAt: t0 + 18 * H });
    // Within the second wait no key is attested, although the six hours since the last try have passed.
    expect(await rotate(t0 + 17 * H)).toBe(false);
    expect(DeviceKey.rotationEvidence).toHaveBeenCalledTimes(2);
    // The node asks for two days: that is waited.
    answers = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' }
      : { success: false, reason: 'device_stale', retry_after_seconds: 2 * 86400 });
    expect(await rotate(t0 + 18 * H)).toBe(false);
    expect(await schedule()).toMatchObject({ rotateRefusals: 3, rotateNextAt: t0 + 18 * H + 48 * H });
    // A signed status with a new rotation epoch starts the tries over.
    await E.noteStatus(NODE, { onChain: true, features: ['device_v1'], signed: { refreshWindow: null, rotationDue: 40 } });
    expect(await schedule()).toMatchObject({ rotationDue: 40, rotateRefusals: 0, rotateNextAt: null });
  });

  // MN-R4-06: the back-off stops at four days, and what the node asks is waited however long; a wait of an older
  // schedule (no written-at time) further ahead than four days is from a clock set back, and void.
  it('the back-off stops at four days, the node\'s ask is waited in full, and an older schedule\'s far wait is void', async () => {
    const t0 = 1790000000000;
    await linkedHere({ schedule: due({ rotateRefusals: 9, rotateNextAt: t0 + 30 * 86400000 }) });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.rotationEvidence.mockResolvedValue(evidence());
    answers = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' }
      : { success: false, reason: 'device_stale', retry_after_seconds: 30 * 86400 });
    expect(await E.rotateIfDue(NODE, { epoch: 20, seq: SEQ, pingPublicKey: PP, device: DEVICE, now: t0 })).toBe(false);
    expect(DeviceKey.rotationEvidence).toHaveBeenCalledTimes(1);
    expect(await schedule()).toMatchObject({ rotateNextAt: t0 + 30 * 86400000, rotateWaitSetAt: t0 });
    // Without an ask, the tenth refusal still waits four days at most.
    answers = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' }
      : { success: false, reason: 'device_stale' });
    await linkedHere({ schedule: due({ rotateRefusals: 9 }) });
    expect(await E.rotateIfDue(NODE, { epoch: 20, seq: SEQ, pingPublicKey: PP, device: DEVICE, now: t0 })).toBe(false);
    expect((await schedule()).rotateNextAt).toBe(t0 + 4 * 86400000);
  });
});

describe('MN-R2-03: one enrolment at a time, and the key the node took is this install\'s', () => {
  const T = 1790000000;
  const unbound = { onChain: true, deviceBound: false, keyOurs: null, features: ['device_v1', 'bind_v2'], deviceTags: [] };
  const pending = async (over = {}) => {
    await linkedHere({ hw: false, seq: T });
    await writeLinkPending({ nodeId: NODE, wallet: WALLET, T, bound: false, bindBlob: { node_id: NODE, seq: T, ping_pubkey: PP }, ...over });
  };
  const enrolled = (handle) => ({ key: { ...ANDROID_KEY, handle }, device: { platform: 'android', chain: ['c'] }, playNonce: 'pn', token: { field: 'pi_token', value: 'p' }, tokenError: null });
  const bindAnswers = (url, body) => {
    if (url.includes('/device-challenge')) return { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' };
    if (url.endsWith('/light-node/bind')) return { success: true, bound: true, seq: body.seq };
    return { success: true };
  };

  it('a second re-send while one runs is skipped, and the next try\'s time is written before the first enrols', async () => {
    const now = T * 1000 + 1000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    await pending();
    answers = bindAnswers;
    const gate = deferred();
    DeviceKey.enrolEvidence.mockImplementation(async () => { await gate.promise; return enrolled('qnet_dev_a1'); });
    const first = Push.resendPendingBinding(NODE, unbound, { interactive: true });
    await new Promise((r) => setTimeout(r, 0));
    // The Node tab's timer, pull-to-refresh or a wake meanwhile: nothing enrols beside the first.
    expect(await Push.resendPendingBinding(NODE, unbound, { interactive: true })).toBe(false);
    expect(await Push.enrolAgainIfUnleased(NODE, { ...unbound, signed: { deviceState: 'check_pending', refreshWindow: null, bindingSeq: T } }))
      .toBe(false);
    const rec = JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY));
    expect(rec).toMatchObject({ tries: 1 });
    expect(rec.nextTryAt).toBeGreaterThan(now);
    gate.resolve();
    expect(await first).toBe(true);
    expect(DeviceKey.enrolEvidence).toHaveBeenCalledTimes(1);
    expect(binds()).toHaveLength(1);
    expect((await info()).hw).toBe(true);
  });

  it('a binding whose key is no longer the pending one holds no key of this device', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(T * 1000 + 1000);
    await pending();
    answers = bindAnswers;
    DeviceKey.enrolEvidence.mockResolvedValue(enrolled('qnet_dev_a2'));
    DeviceKey.commitKey.mockRejectedValue(Object.assign(new Error('Not the pending key'), { code: 'INVALID' }));
    expect(await Push.resendPendingBinding(NODE, unbound, { interactive: true })).toBe(true);
    expect((await info()).hw).toBe(false); // replies go without the device signature, and the tab offers Use this device
  });

  it('a binding the user asks for waits for the re-send that runs, and never enrols beside it', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(T * 1000 + 1000);
    await pending();
    const gate = deferred();
    const order = [];
    DeviceKey.enrolEvidence.mockImplementation(async ({ preimage }) => {
      order.push(preimage.includes(`|${T}|`) ? 'resend' : 'use');
      if (order.length === 1) await gate.promise;
      return enrolled(`qnet_dev_${order.length}`);
    });
    answers = (url, body) => {
      if (url.includes('/light-node/status') && !body) return pub({ device_bound: false });
      if (url.endsWith('/light-node/status')) return { ...pub({ device_bound: false }), binding_seq: T };
      return bindAnswers(url, body);
    };
    const resend = Push.resendPendingBinding(NODE, unbound, { interactive: true });
    await new Promise((r) => setTimeout(r, 0));
    const use = Push.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, device: DEVICE, interactive: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['resend']);
    gate.resolve();
    await resend;
    await use;
    expect(order).toEqual(['resend', 'use']);
  });
});

describe('MN-R2-04: a binding the network holds no more stops waking here', () => {
  it('a reply answered superseded tears the binding down; one made since is not judged by it', async () => {
    await linkedHere({ hw: false });
    answers = (url) => (url.endsWith('/ping-response') ? { success: false, reason: 'superseded', error: 'The node runs on another device' } : {});
    expect(await Push.respondToChallenge(NODE, `selfattest:${V.device.ping.height}:${V.device.ping.hash}`, null)).toBe(false);
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBeNull();
    expect(messaging().deleteToken).toHaveBeenCalled();
    // A new binding (Use this device) lands while the old reply is in flight: it stays.
    jest.clearAllMocks();
    await linkedHere({ hw: false });
    answers = (url) => (url.endsWith('/ping-response')
      ? linkedHere({ hw: false, seq: SEQ + 5 }).then(() => ({ success: false, reason: 'superseded' })) : {});
    await Push.respondToChallenge(NODE, `selfattest:${V.device.ping.height}:${V.device.ping.hash}`, null);
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(NODE);
    expect(messaging().deleteToken).not.toHaveBeenCalled();
  });

  // Contract 4 (04.10): by the binding two owners name (B) and whether two say a device is bound (D); a refused key alone
  // ends nothing.
  it('two owners say no device is bound at or past this binding: a withdrawn binding goes, a fresh or pending one stays', async () => {
    const now = SEQ * 1000 + 3600 * 1000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const withdrawn = { keyOurs: null, bindingSeqAgreed: SEQ, deviceBoundAgreed: false };
    await linkedHere({ boundAt: SEQ });
    // A refused key, or a status without B, decides nothing.
    expect(await Push.forgetIfReplaced(NODE, { keyOurs: false, deviceBound: false, deviceBoundAgreed: false }, SEQ)).toBe(false);
    expect(await Push.forgetIfReplaced(NODE, { keyOurs: false, bindingSeqAgreed: null, deviceBoundAgreed: true }, SEQ)).toBe(false);
    // This very binding, a device bound: it stays.
    expect(await Push.forgetIfReplaced(NODE, { bindingSeqAgreed: SEQ, deviceBoundAgreed: true }, SEQ)).toBe(false);
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(NODE);
    // Made a minute ago: the owner that took it may not have passed it on yet.
    await linkedHere({ boundAt: Math.floor(now / 1000) - 60 });
    expect(await Push.forgetIfReplaced(NODE, withdrawn, SEQ)).toBe(false);
    // The QNet Link sheet's binding while its record still sends it.
    await linkedHere({ boundAt: SEQ });
    await writeLinkPending({ nodeId: NODE, wallet: WALLET, T: SEQ, bound: false, bindBlob: { node_id: NODE } });
    expect(await Push.forgetIfReplaced(NODE, withdrawn, SEQ)).toBe(false);
    await AsyncStorage.removeItem(LINK_PENDING_KEY);
    expect(await Push.forgetIfReplaced(NODE, withdrawn, SEQ)).toBe(true);
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBeNull();
    expect(messaging().deleteToken).toHaveBeenCalled();
    // The same rule for a newer binding with a device bound: one made a minute ago is not judged yet, an older one goes.
    const replaced = { bindingSeqAgreed: SEQ + 7, deviceBoundAgreed: true };
    await linkedHere({ boundAt: Math.floor(now / 1000) - 60 });
    expect(await Push.forgetIfReplaced(NODE, replaced, SEQ)).toBe(false);
    await linkedHere({ boundAt: SEQ });
    expect(await Push.forgetIfReplaced(NODE, replaced, SEQ)).toBe(true);
  });

  it('an expired link is an orphan when two owners say no device is bound, and waits when they cannot say', async () => {
    const rec = { nodeId: NODE, wallet: WALLET, T: SEQ, bound: false, bindBlob: { node_id: NODE }, expired: true };
    await linkedHere({ seq: SEQ, hw: false });
    await writeLinkPending(rec);
    expect(await Push.endExpiredLink(NODE, { onChain: true, keyOurs: null, deviceBoundAgreed: null }, rec)).toBe(false);
    expect(await AsyncStorage.getItem(LINK_PENDING_KEY)).not.toBeNull();
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(NODE);
    expect(await Push.endExpiredLink(NODE, { onChain: true, keyOurs: null, deviceBoundAgreed: false }, rec)).toBe(true);
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBeNull();
    expect(await AsyncStorage.getItem(LINK_PENDING_KEY)).toBeNull();
  });

  it('the status says whether two owners agree that a device is bound', async () => {
    let n = 0;
    answers = (url) => (url.includes('/light-node/status') ? pub({ device_bound: [false, false, true][n++ % 3] }) : {});
    expect((await readNodeStatus(NODE)).deviceBoundAgreed).toBe(false);
    n = 0;
    answers = (url) => (url.includes('/light-node/status') ? pub({ device_bound: [true, false, null][n++ % 3] }) : {});
    expect((await readNodeStatus(NODE)).deviceBoundAgreed).toBe(null);
    // A background wake's read of an expired link is signed with the ping key, so the key's owner is known.
    expect(read('src/services/PushService.js')).toMatch(/const status = await readNodeStatus\(nodeId, \{ signStatus: signStatusWithPingKey, timeoutMs: 5000, deadline \}\);\s*await resendPendingBinding\(nodeId, status, \{ deadline \}\);/);
  });

  it('a stale_seq retry whose second read finds no owner gives the push token back', async () => {
    let statusReads = 0;
    answers = (url, body) => {
      if (url.includes('/light-node/status') && !body) { statusReads += 1; return statusReads <= 3 ? pub({ features: ['bind_v2', 'status_signed'] }) : new Error('offline'); }
      if (url.endsWith('/light-node/status')) return { ...pub(), binding_seq: SEQ };
      if (url.endsWith('/light-node/bind')) return { success: false, reason: 'stale_seq' };
      return {};
    };
    const r = await Push.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, device: DEVICE });
    expect(r).toMatchObject({ ok: false, reason: 'network' });
    expect(messaging().getToken).toHaveBeenCalled();
    expect(messaging().deleteToken).toHaveBeenCalled();
  });
});

describe('MN-R2-06: the last update of the old package runs no node, opened or not', () => {
  it('a push and a background fetch tear the node down and send nothing', async () => {
    // The old package's own build: its modules, with their own storage and wake mocks.
    let Legacy;
    let Store;
    let Fetch;
    jest.isolateModules(() => {
      jest.doMock('../src/config/legacy', () => ({ LEGACY_MOVE: true, NEW_APP_PLAY_URL: null, NEW_APP_SITE_URL: null }));
      Legacy = require('../src/services/PushService');
      Store = require('@react-native-async-storage/async-storage');
      Fetch = require('react-native-background-fetch').default;
    });
    const linked = () => Store.multiSet([
      ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, walletAddress: WALLET, pushType: 'fcm', seq: SEQ, hw: true })],
      ['qnet_ping_node_id', NODE],
      [`qnet_ping_dilithium_pk_${NODE}`, PP],
    ]);
    await linked();
    expect(await Legacy.handlePushMessage({ action: 'wake', anchor: `${V.device.ping.height}:${V.device.ping.hash}` })).toBe(false);
    expect(calls).toEqual([]);
    expect(await Store.getItem('qnet_ping_node_id')).toBeNull();
    await linked();
    await Legacy.onBackgroundFetch('task');
    expect(calls).toEqual([]);
    expect(await Store.getItem('qnet_light_node_info')).toBeNull();
    expect(Fetch.finish).toHaveBeenCalledWith('task');
    jest.dontMock('../src/config/legacy');
  });
});

describe('SD-R2-01: a refused device carries its reference; the app shows none (self-service, owner 05.10)', () => {
  const REF = V.device.status.ref.android;

  it('Use this device refused for the device: the answer carries the reference of the enrolment it refused', async () => {
    DeviceKey.enrolEvidence.mockResolvedValue({
      key: ANDROID_KEY, device: { platform: 'android', chain: ['c'] }, playNonce: 'pn', token: { field: 'pi_token', value: 'p' }, tokenError: null,
    });
    answers = (url, body) => {
      if (url.includes('/device-challenge')) return { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' };
      if (url.includes('/light-node/status') && !body) return pub();
      if (url.endsWith('/light-node/status')) return { ...pub(), binding_seq: SEQ - 1 };
      if (url.endsWith('/light-node/bind')) return { success: false, reason: 'device_key_in_use' };
      return {};
    };
    const r = await Push.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, device: DEVICE });
    expect(r).toMatchObject({ ok: false, reason: 'device_key_in_use', ref: REF });
    // The node's own reference, when its answer carries one, is the one kept.
    const answered = answers;
    answers = (url, body) => (url.endsWith('/light-node/bind') ? { success: false, reason: 'device_slot_paused', ref: 'abcdef01' } : answered(url, body));
    expect(await Push.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, device: DEVICE }))
      .toMatchObject({ ok: false, reason: 'device_slot_paused', ref: 'abcdef01' });
  });

  it('the tab says why under "can\'t run", with nothing to write to anyone', () => {
    let tree;
    act(() => {
      tree = renderer.create(<NodeTab t={t} light={{
        nodeId: NODE, status: {
          onChain: true, deviceBound: true, deviceBoundAgreed: true, keyOurs: false, features: ['device_v1'], signed: null, deviceTags: [],
        },
        local: null, pending: null, answeredAt: null, balanceNano: 0, device: DEVICE,
      }} refusal={{ reason: 'device_slot_paused', ref: REF }} onMove={() => {}} onUse={() => {}} onCopy={() => {}}
        nodeTitle={() => ''} />);
    });
    const texts = tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join(''));
    expect(texts).toContain(t('node_cant_run_now'));
    expect(texts.some((x) => x.includes(REF))).toBe(false);
  });

  it('no screen passes it on, and no language has a "write to support" text', () => {
    expect(read('src/screens/WalletScreen.js')).toMatch(/setUseRefusal\(r\.ok \? null : \{\s+reason: r\.reason, retryAfterSeconds: r\.retryAfterSeconds \|\| null, unknown: r\.unknown === true,\s+\}\)/);
    for (const screen of ['src/screens/QNetLinkScreen.js', 'src/screens/NodeTab.js']) {
      expect([screen, /\.ref\b|node_support_ref|node_check_support/.test(read(screen))]).toEqual([screen, false]);
    }
    const link = read('src/services/QNetLink.js');
    const rows = link.slice(link.indexOf('const ROWS = Object.freeze({'), link.indexOf('});', link.indexOf('const ROWS = Object.freeze({')));
    expect(rows).not.toMatch(/'ref'/);
    for (const locale of ['en', 'ru', 'de', 'es', 'fr', 'it', 'pt', 'ja', 'ko', 'zh-CN', 'ar']) {
      const table = require(`../src/i18n/locales/${locale}`).default;
      expect([locale, Object.keys(table).filter((k) => /support_ref|check_support/.test(k) || table[k].includes('{ref}'))])
        .toEqual([locale, []]);
    }
  });
});
