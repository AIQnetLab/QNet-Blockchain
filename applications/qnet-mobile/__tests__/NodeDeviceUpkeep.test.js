/**
 * The device layer's upkeep and re-enrolments (final audit MN-1..MN-8): a node woken only in the background learns each
 * new lease window itself; a binding with no usable device key is offered Use this device; an iOS key the network no
 * longer names is replaced; a binding posted without a vendor token is completed from the Node tab; failed tries do not
 * attest a new key each time; one owner behind the others ends nothing on this device; the Android counter heals from a
 * clock set forward; a wake's calls stay within its deadline.
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
  forgetKeys: jest.fn(async () => {}),
  hasUnansweredKey: jest.fn(async () => false),
  settleByTag: jest.fn(async () => null),
}));

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';

const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const DeviceKey = require('../src/services/NodeDeviceKey');
const E = require('../src/services/DeviceEnrolment');
const Push = require('../src/services/PushService');
const { readNodeStatus } = require('../src/services/LightNode');
const { lightShardOwnerUrls } = require('../src/config/nodes');
const { default: NodeTab, nodeView } = require('../src/screens/NodeTab');
const { makeT } = require('../src/i18n');

const V = require('../../../docs/protocols/light-node.vectors.json');

const NODE = V.wallets[0].nodeId;
const OWNERS = lightShardOwnerUrls(NODE);
const SEQ = 1790000000;
const WALLET = V.wallets[0].address;
const PP = V.pingKey.publicKey;
const ANDROID_KEY = { platform: 'android', handle: 'qnet_dev_a', hwPub: V.device.keys.android.publicKey, attested: true };
const FLAGS = V.device.messages.find((m) => m.name === 'enrol' && m.platform === 'android').flags;
const DEVICE = { capable: true, platform: 'android', flags: FLAGS, report: V.device.report.text };
const NONCE = 'n'.repeat(43);
const t = makeT('en');

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
  require('../src/crypto/DilithiumCrypto').signDetached.mockResolvedValue(V.device.ping.sigma);
  Keychain.getGenericPassword.mockResolvedValue({ password: 'ping-sk' });
  calls = [];
  answers = () => ({ success: true });
  global.fetch = jest.fn((url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const a = answers(url, body, opts);
    if (a && typeof a.then === 'function') return a;
    return a instanceof Error ? Promise.reject(a) : reply(a);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  Keychain.getGenericPassword.mockResolvedValue(false);
});

const linkedHere = async ({ hw = true, features = ['device_v1', 'hwping_v2', 'status_signed'], schedule = {} } = {}) => {
  await AsyncStorage.multiSet([
    ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, walletAddress: WALLET, pushType: 'fcm', seq: SEQ, hw })],
    ['qnet_ping_node_id', NODE],
    [`qnet_ping_dilithium_pk_${NODE}`, PP],
    [E.SCHEDULE_KEY, JSON.stringify({ nodeId: NODE, features, refresh: null, refreshedFor: null, rotationDue: null, ...schedule })],
  ]);
};
const pub = (over = {}) => ({
  onchain_registered: true, device_bound: true, answered_this_epoch: true, features: ['status_signed', 'device_v1', 'hwping_v2', 'bind_v2'],
  ...over,
});
const schedule = async () => JSON.parse(await AsyncStorage.getItem(E.SCHEDULE_KEY));
const info = async () => JSON.parse(await AsyncStorage.getItem('qnet_light_node_info'));

describe('MN-1: a node woken only in the background learns each new lease window itself', () => {
  it('two lease windows, headless wakes only: the second window comes from a signed status the wake reads', async () => {
    const DAY = 86400;
    const t0 = 1790000000;
    let now = (t0 + 100) * 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockResolvedValue('dsig');
    DeviceKey.vendorToken.mockResolvedValue({ field: 'pi_token', value: 'pt' });
    const window = () => (now / 1000 < t0 + DAY ? { from: t0, to: t0 + DAY } : { from: t0 + DAY, to: t0 + 2 * DAY });
    answers = (url, body) => {
      if (url.includes('/device-challenge')) return { nonce: NONCE, stamp: 'st', exp: t0 + 600, issuer: 'genesis_node_004' };
      if (url.includes('/light-node/status') && !body) return pub();
      if (url.endsWith('/light-node/status')) return { ...pub(), binding_seq: SEQ, device_state: 'active', refresh_window: window(), rotation_due: 999 };
      return { success: true, device_state: 'active' };
    };
    // Linked with the first window known (the bind's status read, then only wakes).
    await linkedHere({ schedule: { refresh: { from: t0, to: t0 + DAY }, rotationDue: 999, statusAt: now } });
    await Push.handlePushMessage({ action: 'epoch', anchor: `28800:${'a'.repeat(64)}` });
    expect(calls.filter((c) => c.url.endsWith('/device-refresh'))).toHaveLength(1);
    expect(calls.some((c) => c.url.endsWith('/light-node/status') && c.body)).toBe(false); // nothing to ask yet
    // A day later the first window is spent: the wake reads the signed status with the ping key, and refreshes in the
    // second window the status names.
    now = (t0 + DAY + 3600) * 1000;
    calls = [];
    await Push.handlePushMessage({ action: 'epoch', anchor: `43200:${'b'.repeat(64)}` });
    const signed = calls.find((c) => c.url.endsWith('/light-node/status') && c.body);
    expect(signed.body).toMatchObject({ node_id: NODE, signer: 'ping' });
    expect(calls.filter((c) => c.url.endsWith('/device-refresh'))).toHaveLength(1);
    expect(await schedule()).toMatchObject({ refresh: { from: t0 + DAY, to: t0 + 2 * DAY }, refreshedFor: t0 + DAY, rotationDue: 999 });
    // A third wake in the same window asks nothing more.
    calls = [];
    now += 3600 * 1000;
    await Push.handlePushMessage({ action: 'epoch', anchor: `46800:${'c'.repeat(64)}` });
    expect(calls.some((c) => c.url.endsWith('/device-refresh') || (c.url.endsWith('/light-node/status') && c.body))).toBe(false);
  });

  it('the status is read at most every few hours, whatever it gives', async () => {
    const now = 1790000000 * 1000;
    await linkedHere();
    expect(await E.needsStatus(NODE, now)).toBe(true);
    await E.noteStatusTry(NODE, now);
    expect(await E.needsStatus(NODE, now + 3600 * 1000)).toBe(false);
    expect(await E.needsStatus(NODE, now + E.STATUS_READ_MS)).toBe(true);
    // A window ahead and a rotation epoch known: nothing to read.
    await linkedHere({ schedule: { refresh: { from: 1790000000, to: 1790090000 }, rotationDue: 200 } });
    expect(await E.needsStatus(NODE, now)).toBe(false);
  });

  it('the refresh and rotation answers keep the next rotation epoch and the record state', async () => {
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockResolvedValue('dsig');
    DeviceKey.vendorToken.mockResolvedValue({ field: 'pi_token', value: 'pt' });
    const now = Date.now();
    await linkedHere({ schedule: { refresh: { from: Math.floor(now / 1000) - 10, to: Math.floor(now / 1000) + 100 } } });
    answers = (url) => (url.includes('/device-challenge')
      ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' } : { success: true, device_state: 'suspect', rotation_due: 321 });
    expect(await E.refreshIfDue(NODE, { now })).toBe(true);
    expect(await schedule()).toMatchObject({ rotationDue: 321, deviceState: 'suspect' });
    DeviceKey.rotationEvidence.mockResolvedValue({ key: { ...ANDROID_KEY, handle: 'qnet_dev_b' }, device: {}, oldSig: 'o', token: null });
    answers = (url) => (url.includes('/device-challenge')
      ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' } : { success: true, device_state: 'active', rotation_due: 654 });
    expect(await E.rotateIfDue(NODE, { epoch: 321, seq: SEQ, pingPublicKey: PP, device: DEVICE })).toBe(true);
    expect(await schedule()).toMatchObject({ rotationDue: 654, deviceState: 'active' });
  });
});

describe('MN-2: a binding with no usable device key is offered Use this device', () => {
  const light = (over) => ({ nodeId: NODE, status: readyStatus(), local: null, pending: null, answeredAt: null, balanceNano: 0, ...over });
  const readyStatus = (over = {}) => ({
    reachable: true, onChain: true, registrationPending: false, deviceBound: true, answered: null, needsReactivation: true,
    counted: null, deviceTags: [], features: ['device_v1'], signed: null, keyOurs: true, ...over,
  });

  it('a key that is gone when a reply is signed marks the binding and forgets the key', async () => {
    await linkedHere();
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockRejectedValue(Object.assign(new Error('gone'), { code: 'KEY_GONE' }));
    await Push.handlePushMessage({ action: 'wake', anchor: `${V.device.ping.height}:${V.device.ping.hash}` });
    expect(calls.find((c) => c.url.endsWith('/ping-response')).body.signature).toBe('ping_dilithium:sig');
    expect((await info()).hw).toBe(false);
    expect(DeviceKey.forgetKeys).toHaveBeenCalled();
  });

  it('a key that is gone at a refresh does the same', async () => {
    const now = Date.now();
    await linkedHere({ schedule: { refresh: { from: Math.floor(now / 1000) - 10, to: Math.floor(now / 1000) + 100 }, rotationDue: 9, statusAt: now } });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockRejectedValue(Object.assign(new Error('gone'), { code: 'KEY_GONE' }));
    answers = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' } : { success: true });
    await E.maintain(NODE, { deadline: now + 25000, onKeyGone: () => Push.markDeviceKeyLost(NODE) });
    expect((await info()).hw).toBe(false);
    expect(DeviceKey.forgetKeys).toHaveBeenCalled();
  });

  it('the tab shows the reason and Use this device, and no "answers again by itself" hint', () => {
    const local = { nodeId: NODE, seq: SEQ, pushType: 'fcm', hw: false };
    expect(nodeView({ status: readyStatus(), local })).toMatchObject({ state: 'here', reenrol: true, notice: { key: 'node_device_again' } });
    // Before two genesis take device keys, a binding without one is as it should be.
    expect(nodeView({ status: readyStatus({ features: [] }), local }).reenrol).toBe(false);
    expect(nodeView({ status: readyStatus(), local: { ...local, hw: true } }).reenrol).toBe(false);
    let tree;
    act(() => {
      tree = renderer.create(<NodeTab t={t} light={light({ local })} onMove={() => {}} onUse={() => {}}
        onCopy={() => {}} nodeTitle={() => ''} />);
    });
    const text = tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('\n');
    expect(text).toContain(t('node_device_again'));
    expect(text).not.toMatch(/answers again when the app is opened/);
    const ids = tree.root.findAllByType(TouchableOpacity).map((n) => n.props.testID);
    expect(ids).toEqual(expect.arrayContaining(['node-use']));
    expect(ids).not.toContain('node-stop');
  });
});

// Use this device with a signer that signs anything (the preimages have their own tests).
const signer = () => ({
  signNodeStatus: async () => ({ signer: 'wallet', sig: 'ws', identityPublicKey: 'id' }),
  prepareLightNodeBinding: async (cred, { seq }) => ({
    nodeId: NODE, wallet: WALLET, identityPublicKey: 'id', pingPublicKey: PP, delegation: 'del', attachSig: `att${seq}`,
    keep: async () => {}, wipe: () => {},
  }),
});
const useDevice = () => Push.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, device: DEVICE, interactive: true });
const enrolAnswers = (bindAnswer) => (url, body) => {
  if (url.includes('/device-challenge')) return { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'genesis_node_004' };
  if (url.includes('/light-node/status') && !body) return pub();
  if (url.endsWith('/light-node/status')) {
    return { ...pub(), device_tag_h: 'ab12ab12ab12ab12', binding_seq: SEQ - 1, rotation_due: 5, refresh_window: { from: 1, to: 2 } };
  }
  if (url.endsWith('/light-node/bind')) return bindAnswer(body);
  return { success: true };
};

describe('MN-3: an iOS key the network no longer names is not asserted with again', () => {
  const IOS_KEY = { platform: 'ios', handle: 'kid', hwPub: V.device.keys.ios.publicKey, attested: true };

  // MN2-07: the current key is reused also when the status names another device's key (the node moving back here): the
  // network keeps a key's entry past the record it served, and a refused assertion falls back to a new key once.
  it('the current key is reused whatever device the public status names', async () => {
    answers = enrolAnswers((body) => ({ success: true, bound: true, seq: body.seq }));
    DeviceKey.enrolEvidence.mockResolvedValue({ key: IOS_KEY, device: { platform: 'ios', key_id: 'k', attestation: 'a' }, token: { field: 'dc_token', value: 'dc' } });
    DeviceKey.isThisDevice.mockResolvedValue(false);
    expect((await useDevice()).ok).toBe(true);
    expect(DeviceKey.enrolEvidence.mock.calls[0][0].reuse).toBe(true);
    DeviceKey.isThisDevice.mockResolvedValue(true);
    await useDevice();
    expect(DeviceKey.enrolEvidence.mock.calls[1][0].reuse).toBe(true);
  });

  it('an assertion refused as device_not_genuine forgets the key and attests a new one, once', async () => {
    let binds = 0;
    answers = enrolAnswers((body) => {
      binds += 1;
      return binds === 1 ? { success: false, reason: 'device_not_genuine' } : { success: true, bound: true, seq: body.seq };
    });
    DeviceKey.enrolEvidence
      .mockResolvedValueOnce({ key: IOS_KEY, device: { platform: 'ios', key_id: 'k', assertion: 'as' }, token: { field: 'dc_token', value: 'dc' } })
      .mockResolvedValueOnce({ key: { ...IOS_KEY, handle: 'new' }, device: { platform: 'ios', key_id: 'n', attestation: 'at' }, token: { field: 'dc_token', value: 'dc' } });
    expect(await useDevice()).toEqual({ ok: true, seq: expect.any(Number) });
    expect(DeviceKey.forgetKeys).toHaveBeenCalledTimes(1);
    expect(DeviceKey.enrolEvidence.mock.calls.map((c) => c[0].reuse)).toEqual([true, false]);
  });
});

describe('MN-4: a binding posted without a vendor token is completed from the Node tab', () => {
  it('kept as owed, and re-sent in the foreground with the same sequence and a token while the check is pending', async () => {
    const KEY = { ...ANDROID_KEY };
    answers = enrolAnswers((body) => ({ success: true, bound: true, seq: body.seq, device_state: 'check_pending' }));
    DeviceKey.enrolEvidence.mockResolvedValueOnce({ key: KEY, device: { platform: 'android', chain: ['c'] }, playNonce: 'pn', token: null, tokenError: 'PLAY_BUSY' });
    const r = await useDevice();
    expect(r.ok).toBe(true);
    const owed = JSON.parse(await AsyncStorage.getItem(Push.ENROL_AGAIN_KEY));
    expect(owed).toMatchObject({ nodeId: NODE, seq: r.seq });
    expect(owed.bindBlob).not.toHaveProperty('device');
    // The tab, once the attestors' vote on the first key is over (MN2-01): the signed status still says check_pending,
    // so the same binding goes again with a token.
    const later = Date.now() + Push.ENROL_AGAIN_FIRST_WAIT_MS;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    DeviceKey.enrolEvidence.mockResolvedValueOnce({ key: KEY, device: { platform: 'android', chain: ['c2'] }, playNonce: 'pn', token: null, tokenError: 'PLAY_FIXABLE' });
    DeviceKey.showPlayDialog.mockResolvedValue('ok');
    DeviceKey.vendorToken.mockResolvedValue({ field: 'pi_token', value: 'fixed' });
    calls = [];
    const status = { onChain: true, features: ['device_v1', 'bind_v2'], nonce: 'ab'.repeat(16), deviceTags: [], signed: { deviceState: 'check_pending', refreshWindow: null } };
    expect(await Push.enrolAgainIfUnleased(NODE, status)).toBe(true);
    const bind = calls.find((c) => c.url.endsWith('/light-node/bind'));
    expect(bind.body).toMatchObject({ seq: r.seq, pi_token: 'fixed', attach_sig: `att${r.seq}` });
    expect(DeviceKey.showPlayDialog).toHaveBeenCalledWith('integrity'); // the foreground may show Google Play's dialog
    // Kept for the next status read to judge (the record may wait again), at the enrolment re-send's pace.
    expect(JSON.parse(await AsyncStorage.getItem(Push.ENROL_AGAIN_KEY))).toMatchObject({ seq: r.seq, tries: 1 });
  });

  // Owner, 30.09: a check that waits never reads "still checking" for good. The tab learns here whether this device still
  // owes the network a re-send, and whether the network refused the check of one (NodeTab checkState).
  it('a refused check of the re-send is kept for the tab with its reference; the binding\'s sequence scopes it', async () => {
    const KEY = { ...ANDROID_KEY };
    answers = enrolAnswers((body) => ({ success: true, bound: true, seq: body.seq, device_state: 'check_pending' }));
    DeviceKey.enrolEvidence.mockResolvedValueOnce({ key: KEY, device: { platform: 'android', chain: ['c'] }, playNonce: 'pn', token: null, tokenError: 'PLAY_BUSY' });
    const r = await useDevice();
    expect(r.ok).toBe(true);
    expect(await Push.nodeCheckState(NODE, r.seq)).toEqual({ resending: true, refusal: null });
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + Push.ENROL_AGAIN_FIRST_WAIT_MS);
    answers = enrolAnswers(() => ({ success: false, reason: 'device_not_genuine', ref: '0f0f0f0f' }));
    DeviceKey.enrolEvidence.mockResolvedValueOnce({ key: KEY, device: { platform: 'android', chain: ['c2'] }, playNonce: 'pn', token: { field: 'pi_token', value: 'p' } });
    const status = { onChain: true, features: ['device_v1', 'bind_v2'], nonce: 'ab'.repeat(16), deviceTags: [], signed: { deviceState: 'check_pending', refreshWindow: null } };
    expect(await Push.enrolAgainIfUnleased(NODE, status)).toBe(false);
    // Nothing more to send; the tab says the check was refused, with the reference to quote.
    expect(await AsyncStorage.getItem(Push.ENROL_AGAIN_KEY)).toBeNull();
    expect(await Push.nodeCheckState(NODE, r.seq)).toEqual({ resending: false, refusal: { reason: 'device_not_genuine', ref: '0f0f0f0f' } });
    // Another binding (Use this device takes a later sequence) is not the refused one.
    expect(await Push.nodeCheckState(NODE, r.seq + 1)).toEqual({ resending: false, refusal: null });
    // The end of the binding here takes it along.
    await Push.teardownLightNode();
    expect(await AsyncStorage.getItem(Push.CHECK_REFUSED_KEY)).toBeNull();
  });

  it('a counted record ends the task without a re-send; a binding sent with a token is kept, and re-sent only unleased', async () => {
    await linkedHere();
    await AsyncStorage.setItem(Push.ENROL_AGAIN_KEY, JSON.stringify({ nodeId: NODE, seq: SEQ, wallet: WALLET, bindBlob: { seq: SEQ } }));
    expect(await Push.enrolAgainIfUnleased(NODE, { onChain: true, features: ['device_v1'], signed: { deviceState: 'active' } })).toBe(false);
    expect(await AsyncStorage.getItem(Push.ENROL_AGAIN_KEY)).toBeNull();
    expect(calls).toEqual([]);
    answers = enrolAnswers((body) => ({ success: true, bound: true, seq: body.seq }));
    DeviceKey.enrolEvidence.mockResolvedValue({ key: ANDROID_KEY, device: {}, token: { field: 'pi_token', value: 'p' } });
    const r = await useDevice();
    expect(r.ok).toBe(true);
    expect(JSON.parse(await AsyncStorage.getItem(Push.ENROL_AGAIN_KEY))).toMatchObject({ seq: r.seq, tries: 0 });
    // A record with a lease (a refresh window) is not re-sent: only a check with no lease needs a new enrolment.
    calls = [];
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + Push.ENROL_AGAIN_FIRST_WAIT_MS);
    const leased = { onChain: true, features: ['device_v1'], signed: { deviceState: 'check_pending', refreshWindow: { from: 1, to: 2 }, bindingSeq: r.seq } };
    expect(await Push.enrolAgainIfUnleased(NODE, leased)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('the tab says the check is not finished without promising it finishes by itself', () => {
    expect(t('node_check_running')).not.toMatch(/will run on this device when/i);
  });
});

describe('MN-5: failed tries do not attest a key each time', () => {
  it('Use this device starts a new schedule: the bind answer, not the status read before it', async () => {
    answers = enrolAnswers((body) => ({ success: true, bound: true, seq: body.seq, rotation_due: 77, device_state: 'active' }));
    DeviceKey.enrolEvidence.mockResolvedValue({ key: ANDROID_KEY, device: {}, token: { field: 'pi_token', value: 'p' } });
    expect((await useDevice()).ok).toBe(true);
    // The status read before the binding named rotation 5 and window {1, 2}: the previous device's record.
    expect(await schedule()).toMatchObject({ nodeId: NODE, refresh: null, rotationDue: 77, deviceState: 'active' });
  });

  it('a re-send that carries an enrolment waits hours after a failure; one that got no answer keeps its key', async () => {
    const T = 1790000000;
    jest.spyOn(Date, 'now').mockReturnValue(T * 1000);
    await linkedHere({ hw: false });
    await AsyncStorage.setItem('qnet_node_link_pending', JSON.stringify({
      nodeId: NODE, wallet: WALLET, T, createdAt: T * 1000, bound: false, bindBlob: { node_id: NODE, seq: T, ping_pubkey: PP },
    }));
    DeviceKey.enrolEvidence.mockResolvedValue({ key: ANDROID_KEY, device: {}, token: { field: 'pi_token', value: 'p' } });
    const unbound = { onChain: true, deviceBound: false, features: ['bind_v2', 'device_v1'], nonce: 'ab'.repeat(16), deviceTags: [] };
    answers = enrolAnswers(() => ({ success: false, reason: 'device_stale' }));
    expect(await Push.resendPendingBinding(NODE, unbound)).toBe(false);
    expect(JSON.parse(await AsyncStorage.getItem('qnet_node_link_pending'))).toMatchObject({ tries: 1, nextTryAt: T * 1000 + 4 * 3600 * 1000 });
    expect(DeviceKey.dropPendingKey).toHaveBeenCalledTimes(1); // refused: the node did not take it
    // No owner answered the POST: the key may be the node's, so it waits for the tag instead of a new one.
    Date.now.mockReturnValue(T * 1000 + 4 * 3600 * 1000);
    answers = enrolAnswers(() => new Error('timeout'));
    expect(await Push.resendPendingBinding(NODE, unbound)).toBe(false);
    expect(DeviceKey.keepUnanswered).toHaveBeenCalledWith(ANDROID_KEY);
    expect(DeviceKey.dropPendingKey).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await AsyncStorage.getItem('qnet_node_link_pending'))).toMatchObject({ tries: 2, nextTryAt: T * 1000 + 12 * 3600 * 1000 });
    // The chain then lists a device: the tag names the kept key, which becomes the node's.
    DeviceKey.settleByTag.mockResolvedValue('pending');
    expect(await Push.resendPendingBinding(NODE, { ...unbound, deviceBound: true, deviceTags: ['ab12ab12ab12ab12'] })).toBe(false);
    expect((await info()).hw).toBe(true);
    expect(await AsyncStorage.getItem('qnet_node_link_pending')).toBeNull();
  });
});

describe('MN-6: one owner behind the others ends nothing on this device', () => {
  const status = (byOwner) => {
    global.fetch = jest.fn((url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      calls.push({ url, body });
      if (!body) return reply(pub());
      const i = OWNERS.findIndex((o) => url.startsWith(o));
      return reply(byOwner[i]);
    });
    return readNodeStatus(NODE, { signStatus: async () => ({ signer: 'ping', sig: 's' }) });
  };
  const refuse = { success: false, reason: 'bad_signature' };
  const take = { ...pub(), binding_seq: SEQ, device_state: 'active' };

  it('a refusal from the first owner and the key taken by the next: the key is ours', async () => {
    const s = await status([refuse, take, refuse]);
    expect(s.keyOurs).toBe(true);
    expect(s.signed).toMatchObject({ bindingSeq: SEQ });
  });

  it('only two refusals make the key not ours; one refusal and silence says nothing', async () => {
    expect((await status([refuse, refuse, take])).keyOurs).toBe(false);
    expect((await status([refuse, { success: false, reason: 'rate_limited' }, { weird: true }])).keyOurs).toBe(null);
  });

  it('so a lagging owner cannot tear down a binding just made', async () => {
    await linkedHere();
    const s = await status([refuse, take, take]);
    expect(await Push.forgetIfReplaced(NODE, s, SEQ)).toBe(false);
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(NODE);
  });
});

describe('MN-7: the Android counter heals from a clock set forward', () => {
  const P = V.device.ping.challenge;
  const SIGMA = V.device.ping.sigma;

  it('a counter more than a day ahead restarts from the clock, and each key has its own', async () => {
    const now = 1790000000000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    DeviceKey.sign.mockResolvedValue('AA');
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    await AsyncStorage.setItem(E.HW_SEQ_KEY, JSON.stringify({ handle: ANDROID_KEY.handle, last: now + 90 * 86400 * 1000 }));
    expect((await E.hwPingSignature(NODE, P, SIGMA)).endsWith(`.${now}`)).toBe(true);
    expect((await E.hwPingSignature(NODE, P, SIGMA)).endsWith(`.${now + 1}`)).toBe(true);
    // Within a day ahead it only climbs.
    await AsyncStorage.setItem(E.HW_SEQ_KEY, JSON.stringify({ handle: ANDROID_KEY.handle, last: now + 3600 * 1000 }));
    expect((await E.hwPingSignature(NODE, P, SIGMA)).endsWith(`.${now + 3600 * 1000 + 1}`)).toBe(true);
    // A new key starts from the clock.
    DeviceKey.currentKey.mockResolvedValue({ ...ANDROID_KEY, handle: 'qnet_dev_other' });
    expect((await E.hwPingSignature(NODE, P, SIGMA)).endsWith(`.${now}`)).toBe(true);
  });
});

describe('MN-8: a wake\'s calls stay within its deadline', () => {
  it('no challenge is asked with too little time left, and a slow owner is left at the deadline', async () => {
    answers = (url, body, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    await expect(E.fetchChallenge(NODE, 'refresh', { deadline: Date.now() + 1000 })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(calls).toHaveLength(0);
    const started = Date.now();
    await expect(E.fetchChallenge(NODE, 'refresh', { deadline: started + 1800 })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(calls).toHaveLength(1); // the next owner is not asked past the deadline
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('a refresh with no time left for its POST sends nothing after the challenge', async () => {
    const now = Date.now();
    await linkedHere({ schedule: { refresh: { from: Math.floor(now / 1000) - 10, to: Math.floor(now / 1000) + 7200 } } });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    // A slow Keystore: the signature takes most of what the wake had left.
    DeviceKey.sign.mockImplementation(() => new Promise((r) => setTimeout(() => r('dsig'), 1000)));
    DeviceKey.vendorToken.mockImplementation(() => new Promise((r) => setTimeout(() => r({ field: 'pi_token', value: 'late' }), 5000)));
    answers = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' } : { success: true });
    expect(await E.refreshIfDue(NODE, { now, deadline: Date.now() + 2000 })).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/device-refresh'))).toBe(false);
    // With the time for it, once the try's back-off is over, the POST goes (a token that is late is left out: the node
    // answers device_stale for now).
    calls = [];
    DeviceKey.sign.mockResolvedValue('dsig');
    const started = Date.now();
    await E.refreshIfDue(NODE, { now: now + E.REFRESH_FIRST_WAIT_MS, deadline: started + 6000 });
    const post = calls.find((c) => c.url.endsWith('/device-refresh'));
    expect(post.body.token).toBe(null);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
