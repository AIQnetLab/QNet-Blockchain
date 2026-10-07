/**
 * Final audit, mobile fixer round 2, the node on this device (MN2-01 … MN2-12, SD-R2-05): a binding owed its vendor
 * token is re-sent only after the attestors' vote on the first key and survives that vote's stale_seq; a device that
 * can never give a vendor token binds nothing; the rotation attests no key it cannot use; Stop gives the unbind its
 * time; background re-sends stay within the wake; an iOS key is reused when the node moves back; the Node tab offers
 * only what can work; a reply racing a rotation keeps the new key; a changed push token goes out from any wake; and no
 * push channel the app does not have is left in it.
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
import { Text, TouchableOpacity } from 'react-native';

const fs = require('fs');
const path = require('path');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const DeviceKey = require('../src/services/NodeDeviceKey');
const E = require('../src/services/DeviceEnrolment');
const Push = require('../src/services/PushService');
const { postBind } = require('../src/services/LightNode');
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
const ROTATED_KEY = { platform: 'android', handle: 'qnet_dev_b', hwPub: V.device.keys.androidRotated.publicKey, attested: true };
const IOS_KEY = { platform: 'ios', handle: 'kid', hwPub: V.device.keys.ios.publicKey, attested: true };
const FLAGS = V.device.messages.find((m) => m.name === 'enrol' && m.platform === 'android').flags;
const DEVICE = { capable: true, platform: 'android', flags: FLAGS, report: V.device.report.text };
const NONCE = 'n'.repeat(43);
const t = makeT('en');

let calls;
let answers;
const reply = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const hang = (opts) => new Promise((_, reject) => {
  if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
});
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  DeviceKey.isThisDevice.mockResolvedValue(null);
  DeviceKey.hasUnansweredKey.mockResolvedValue(false);
  DeviceKey.settleByTag.mockResolvedValue(null);
  DeviceKey.checkDevice.mockResolvedValue(DEVICE);
  DeviceKey.forgetKey.mockResolvedValue(true);
  require('../src/crypto/DilithiumCrypto').signDetached.mockResolvedValue(V.device.ping.sigma);
  Keychain.getGenericPassword.mockResolvedValue({ password: 'ping-sk' });
  calls = [];
  answers = () => ({ success: true });
  global.fetch = jest.fn((url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body, at: Date.now() });
    const a = answers(url, body, opts);
    if (a && typeof a.then === 'function') return a;
    return a instanceof Error ? Promise.reject(a) : reply(a);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  Keychain.getGenericPassword.mockResolvedValue(false);
});

const linkedHere = async ({ hw = true, features = ['device_v1', 'hwping_v2', 'status_signed'], schedule = {}, pushType = 'fcm' } = {}) => {
  await AsyncStorage.multiSet([
    ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, walletAddress: WALLET, pushType, seq: SEQ, hw })],
    ['qnet_ping_node_id', NODE],
    [`qnet_ping_dilithium_pk_${NODE}`, PP],
    [E.SCHEDULE_KEY, JSON.stringify({ nodeId: NODE, features, refresh: null, refreshedFor: null, rotationDue: null, ...schedule })],
  ]);
};
const info = async () => JSON.parse(await AsyncStorage.getItem('qnet_light_node_info'));
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
const useDevice = () => Push.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, device: DEVICE, interactive: true });
const enrolAnswers = (bindAnswer) => (url, body) => {
  if (url.includes('/device-challenge')) return { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'genesis_node_004' };
  if (url.includes('/light-node/status') && !body) return pub();
  if (url.endsWith('/light-node/status')) return { ...pub(), binding_seq: SEQ - 1 };
  if (url.endsWith('/light-node/bind')) return bindAnswer(body);
  return { success: true };
};
const owed = async () => JSON.parse(await AsyncStorage.getItem(Push.ENROL_AGAIN_KEY));
const binds = () => calls.filter((c) => c.url.endsWith('/light-node/bind'));

describe('MN2-01: a binding owed its vendor token is re-sent only after the vote, and survives its stale_seq', () => {
  const tokenless = { key: ANDROID_KEY, device: { platform: 'android', chain: ['c'] }, playNonce: 'pn', token: null, tokenError: 'BUSY' };

  it('the owed record waits past the attestors\' vote: the status read right after the bind sends nothing', async () => {
    const t0 = 1790000000000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    answers = enrolAnswers((body) => ({ success: true, bound: true, seq: body.seq, device_state: 'check_pending' }));
    DeviceKey.enrolEvidence.mockResolvedValue(tokenless);
    const r = await useDevice();
    expect(r.ok).toBe(true);
    const rec = await owed();
    expect(rec).toMatchObject({ nodeId: NODE, seq: r.seq, tries: 0 });
    expect(rec.nextTryAt).toBeGreaterThanOrEqual(t0 + Push.ENROL_AGAIN_FIRST_WAIT_MS);
    // 600 + 2 x 120 s: the vote refuses another key for the same seq until then.
    expect(Push.ENROL_AGAIN_FIRST_WAIT_MS).toBeGreaterThan(840 * 1000);
    calls = [];
    const status = { onChain: true, features: ['device_v1', 'bind_v2'], nonce: 'ab'.repeat(16), deviceTags: [], signed: { deviceState: 'check_pending', refreshWindow: null, bindingSeq: r.seq } };
    expect(await Push.enrolAgainIfUnleased(NODE, status)).toBe(false);
    expect(calls).toEqual([]);
    expect(DeviceKey.enrolEvidence).toHaveBeenCalledTimes(1); // no second Android key, no second Play request
    expect(await owed()).toMatchObject({ seq: r.seq });
  });

  it('a stale_seq while the signed status still names this binding waits and tries again; a newer binding ends it', async () => {
    const t0 = 1790000000000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    await linkedHere({ hw: true });
    await AsyncStorage.setItem(Push.ENROL_AGAIN_KEY, JSON.stringify({
      nodeId: NODE, seq: SEQ, wallet: WALLET, bindBlob: { node_id: NODE, seq: SEQ, ping_pubkey: PP }, tries: 0, nextTryAt: t0 - 1,
    }));
    DeviceKey.enrolEvidence.mockResolvedValue(tokenless);
    answers = enrolAnswers(() => ({ success: false, reason: 'stale_seq' }));
    const status = (bindingSeq) => ({
      onChain: true, features: ['device_v1', 'bind_v2'], nonce: 'ab'.repeat(16), deviceTags: [],
      signed: { deviceState: 'check_pending', refreshWindow: null, bindingSeq },
    });
    expect(await Push.enrolAgainIfUnleased(NODE, status(SEQ))).toBe(false);
    expect(await owed()).toMatchObject({ seq: SEQ, tries: 1, nextTryAt: t0 + 4 * 3600 * 1000 });
    Date.now.mockReturnValue(t0 + 4 * 3600 * 1000);
    expect(await Push.enrolAgainIfUnleased(NODE, status(SEQ + 5))).toBe(false);
    expect(await owed()).toBeNull();
  });
});

describe('MN2-02: a device that can never give a vendor token binds nothing', () => {
  for (const [os, code] of [['android', 'PLAY_UNAVAILABLE'], ['ios', 'UNSUPPORTED']]) {
    it(`${os}: ${code} drops the key and posts no binding, so the device that runs the node keeps it`, async () => {
      answers = enrolAnswers((body) => ({ success: true, bound: true, seq: body.seq }));
      DeviceKey.enrolEvidence.mockResolvedValue({
        key: os === 'ios' ? IOS_KEY : ANDROID_KEY, device: { platform: os }, playNonce: null, token: null, tokenError: code,
      });
      const r = await useDevice();
      expect(r).toEqual({ ok: false, reason: 'device_unsupported' });
      expect(binds()).toEqual([]);
      expect(DeviceKey.dropPendingKey).toHaveBeenCalled();
      expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBeNull();
      expect(await AsyncStorage.getItem(Push.ENROL_AGAIN_KEY)).toBeNull();
    });
  }

  it('a token that failed for now still binds (taken, counted once a token completes it)', async () => {
    answers = enrolAnswers((body) => ({ success: true, bound: true, seq: body.seq, device_state: 'check_pending' }));
    DeviceKey.enrolEvidence.mockResolvedValue({ key: ANDROID_KEY, device: { platform: 'android' }, playNonce: 'pn', token: null, tokenError: 'BUSY' });
    expect((await useDevice()).ok).toBe(true);
    expect(binds()).toHaveLength(1);
    expect(binds()[0].body).not.toHaveProperty('pi_token');
  });

  it('the QNet Link sheet answers not bound for such a device, and keeps nothing', async () => {
    DeviceKey.enrolEvidence.mockResolvedValue({ key: ANDROID_KEY, device: { platform: 'android' }, playNonce: 'pn', token: null, tokenError: 'PLAY_UNAVAILABLE' });
    answers = enrolAnswers((body) => ({ success: true, pending: true, seq: body.seq }));
    const consentSigner = {
      prepareLinkConsent: async (cred, { ts }) => ({
        nodeId: NODE, wallet: WALLET, identityPublicKey: '00'.repeat(1952), consentSig: '00'.repeat(3309), proof: 'p',
        binding: { wallet: WALLET, identityPublicKey: 'id', pingPublicKey: PP, delegation: 'del', attachSig: `att${ts}`, keep: async () => {}, wipe: () => {} },
      }),
    };
    const r = await Push.linkWithConsent({ signer: consentSigner, credential: {}, nodeId: NODE, burnTx: 'b'.repeat(88), device: DEVICE, features: ['device_v1'] });
    expect(r).toMatchObject({ bound: false, reason: 'device_unsupported' });
    expect(binds()).toEqual([]);
    expect(await AsyncStorage.getItem('qnet_node_link_pending')).toBeNull();
  });
});

describe('MN2-04: the rotation attests no key it cannot use', () => {
  const challenge = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' } : { success: true });

  it('no rotation while the record is paused or ended, or waits for a check with no lease', async () => {
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    for (const schedule of [{ deviceState: 'paused' }, { deviceState: 'ended' }, { deviceState: 'check_pending', refresh: null }]) {
      await linkedHere({ schedule: { rotationDue: 10, ...schedule } });
      expect(await E.rotateIfDue(NODE, { epoch: 11, seq: SEQ, pingPublicKey: PP, device: DEVICE })).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(DeviceKey.rotationEvidence).not.toHaveBeenCalled();
    // A gate-held check with its lease still rotates.
    await linkedHere({ schedule: { rotationDue: 10, deviceState: 'check_pending', refresh: { from: 1, to: 2 } } });
    answers = challenge;
    DeviceKey.rotationEvidence.mockResolvedValue({ key: ROTATED_KEY, device: {}, oldSig: 'o', token: { field: 'pi_token', value: 'p' } });
    expect(await E.rotateIfDue(NODE, { epoch: 11, seq: SEQ, pingPublicKey: PP, device: DEVICE })).toBe(true);
  });

  it('the evidence is asked with the wake\'s deadline, and a key never posted is dropped, never kept as unanswered', async () => {
    await linkedHere({ schedule: { rotationDue: 10, deviceState: 'active' } });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    answers = challenge;
    const deadline = Date.now() + 20000;
    // Evidence that takes all the time the wake had left.
    DeviceKey.rotationEvidence.mockImplementation(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(deadline - 100);
      return { key: ROTATED_KEY, device: {}, oldSig: 'o', token: { field: 'pi_token', value: 'p' } };
    });
    expect(await E.rotateIfDue(NODE, { epoch: 11, seq: SEQ, pingPublicKey: PP, device: DEVICE, deadline })).toBe(false);
    expect(DeviceKey.rotationEvidence.mock.calls[0][0]).toMatchObject({ deadline, minLeftMs: E.ATTEST_MS + E.MIN_CALL_MS });
    expect(calls.some((c) => c.url.endsWith('/device-rotate'))).toBe(false);
    expect(DeviceKey.keepUnanswered).not.toHaveBeenCalled();
    expect(DeviceKey.dropPendingKey).toHaveBeenCalled();
  });

  it('a rotation that went out and got no answer keeps its key for the status to settle', async () => {
    await linkedHere({ schedule: { rotationDue: 10, deviceState: 'active' } });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    answers = (url) => (url.includes('/device-challenge') ? challenge(url) : new Error('timeout'));
    DeviceKey.rotationEvidence.mockResolvedValue({ key: ROTATED_KEY, device: {}, oldSig: 'o', token: { field: 'pi_token', value: 'p' } });
    expect(await E.rotateIfDue(NODE, { epoch: 11, seq: SEQ, pingPublicKey: PP, device: DEVICE })).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/device-rotate'))).toBe(true);
    expect(DeviceKey.keepUnanswered).toHaveBeenCalledWith(ROTATED_KEY);
  });

  it('evidence refused for want of a token (the key is never made) waits six hours like any failure', async () => {
    const now = 1790000000000;
    await linkedHere({ schedule: { rotationDue: 10, deviceState: 'active' } });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    answers = challenge;
    DeviceKey.rotationEvidence.mockRejectedValue(Object.assign(new Error('no token'), { code: 'BUSY' }));
    // One clock for the try and the next look, an hour later (a try written ahead of the clock holds nothing back).
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await E.maintain(NODE, { deadline: Date.now() + 25000, epoch: 11, binding: { seq: SEQ, pingPublicKey: PP }, device: async () => DEVICE });
    expect(DeviceKey.rotationEvidence).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.url.endsWith('/device-rotate'))).toBe(false);
    clock.mockReturnValue(now + 3600000);
    expect(await E.rotateIfDue(NODE, { epoch: 11, seq: SEQ, pingPublicKey: PP, device: DEVICE, now: now + 3600000 })).toBe(false);
    expect(DeviceKey.rotationEvidence).toHaveBeenCalledTimes(1);
  });
});

describe('MN2-05: Stop gives the unbind its time, whatever the release challenge does', () => {
  it('an owner that hangs on the release challenge costs 3 s at most; the unbind goes without the release', async () => {
    await linkedHere({ hw: true });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    answers = (url, body, opts) => (url.includes('/device-challenge') ? hang(opts) : { success: true });
    const started = Date.now();
    const r = await Push.stopLightNode();
    expect(r).toEqual({ unbound: true });
    const unbind = calls.find((c) => c.url.endsWith('/light-node/unbind'));
    expect(unbind.body).not.toHaveProperty('device_release');
    expect(unbind.at - started).toBeLessThan(4500);
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBeNull();
  }, 20000);

  it('a release that comes in time goes with the unbind, to the owner that issued its challenge', async () => {
    await linkedHere({ hw: true });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockResolvedValue('rel-sig');
    answers = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' } : { success: true, device_released: true });
    expect(await Push.stopLightNode()).toEqual({ unbound: true });
    const unbind = calls.find((c) => c.url.endsWith('/light-node/unbind'));
    expect(unbind.body.device_release).toEqual({ nonce: NONCE, stamp: 'st', sig: 'rel-sig' });
    expect(unbind.url.startsWith(OWNERS[0])).toBe(true);
  });
});

describe('MN2-06: a background re-send stays within its wake', () => {
  const T = Math.floor(Date.now() / 1000); // a consent given just now: its record is live
  const pending = async () => AsyncStorage.setItem('qnet_node_link_pending', JSON.stringify({
    nodeId: NODE, wallet: WALLET, T, createdAt: T * 1000, bound: false, bindBlob: { node_id: NODE, seq: T, ping_pubkey: PP },
  }));
  const unbound = { onChain: true, deviceBound: false, features: ['bind_v2', 'device_v1'], nonce: 'ab'.repeat(16), deviceTags: [] };

  it('with too little of the wake left no key is made and nothing is posted, and no try is counted', async () => {
    await linkedHere({ hw: false });
    await pending();
    answers = enrolAnswers((body) => ({ success: true, bound: true, seq: body.seq }));
    expect(await Push.resendPendingBinding(NODE, unbound, { deadline: Date.now() + E.ATTEST_MS })).toBe(false);
    expect(DeviceKey.enrolEvidence).not.toHaveBeenCalled();
    expect(binds()).toEqual([]);
    expect(JSON.parse(await AsyncStorage.getItem('qnet_node_link_pending'))).not.toHaveProperty('tries');
  });

  it('with time for it the binding goes, every POST within the deadline', async () => {
    await linkedHere({ hw: false });
    await pending();
    DeviceKey.enrolEvidence.mockResolvedValue({ key: ANDROID_KEY, device: {}, token: { field: 'pi_token', value: 'p' } });
    answers = enrolAnswers((body) => ({ success: true, bound: true, seq: body.seq }));
    expect(await Push.resendPendingBinding(NODE, unbound, { deadline: Date.now() + 20000 })).toBe(true);
    expect(binds()).toHaveLength(1);
  });

  it('a POST to owners that hang ends at the deadline, and no owner is asked past it', async () => {
    answers = (url, body, opts) => hang(opts);
    const started = Date.now();
    const r = await postBind(NODE, { seq: 1 }, { deadline: started + 2500 });
    expect(r).toMatchObject({ ok: false, reason: 'network' });
    expect(Date.now() - started).toBeLessThan(3500);
    expect(calls).toHaveLength(1);
  });
});

describe('MN2-07: an iOS key is reused when the node moves back here', () => {
  it('the owed re-send asserts with the current key although the status names another device', async () => {
    const t0 = 1790000000000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    await linkedHere({ hw: true });
    await AsyncStorage.setItem(Push.ENROL_AGAIN_KEY, JSON.stringify({
      nodeId: NODE, seq: SEQ, wallet: WALLET, bindBlob: { node_id: NODE, seq: SEQ, ping_pubkey: PP }, tries: 0, nextTryAt: t0 - 1,
    }));
    DeviceKey.isThisDevice.mockResolvedValue(false);
    DeviceKey.enrolEvidence.mockResolvedValue({ key: IOS_KEY, device: { platform: 'ios', assertion: 'as' }, token: { field: 'dc_token', value: 'dc' } });
    answers = enrolAnswers((body) => ({ success: true, bound: true, seq: body.seq }));
    const status = { onChain: true, features: ['device_v1', 'bind_v2'], nonce: 'ab'.repeat(16), deviceTags: ['ffffffffffffffff'], signed: { deviceState: 'check_pending', refreshWindow: null, bindingSeq: SEQ } };
    expect(await Push.enrolAgainIfUnleased(NODE, status)).toBe(true);
    expect(DeviceKey.enrolEvidence.mock.calls[0][0].reuse).toBe(true);
  });
});

describe('MN2-08, MN2-09: the Node tab offers only what can work', () => {
  const LOCAL = { nodeId: NODE, seq: SEQ, pushType: 'fcm', hw: true };
  const ready = (over = {}) => ({
    reachable: true, onChain: true, registrationPending: false, deviceBound: true, answered: true, needsReactivation: false,
    counted: null, deviceTags: [], features: ['device_v1'], signed: null, keyOurs: true, ...over,
  });
  const render = (light) => {
    let tree;
    act(() => {
      tree = renderer.create(<NodeTab t={t} light={{ nodeId: NODE, local: LOCAL, pending: null, answeredAt: null, balanceNano: 0, ...light }}
        onMove={() => {}} onUse={() => {}} onCopy={() => {}} nodeTitle={() => ''} />);
    });
    const text = tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('\n');
    const ids = tree.root.findAllByType(TouchableOpacity).map((n) => n.props.testID);
    return { text, ids };
  };

  it('MN2-08: a binding without a key on a device that cannot run a node is not told to register again', () => {
    const local = { ...LOCAL, hw: false };
    const cant = render({ status: ready(), local, device: { capable: false, reason: 'device_desktop' } });
    expect(cant.text).toContain(t('node_cant_run'));
    expect(cant.text).not.toContain(t('node_device_again'));
    expect(cant.ids).not.toContain('node-use');
    const profile = render({ status: ready(), local, device: { capable: false, reason: 'device_secondary_user' } });
    expect(profile.text).toContain(t('node_main_profile'));
    expect(profile.ids).not.toContain('node-use');
    // A device that can: the notice and the button, as before.
    const can = render({ status: ready(), local, device: DEVICE });
    expect(can.text).toContain(t('node_device_again'));
    expect(can.ids).toContain('node-use');
  });

  it('MN2-09: a pause with no end says the device cannot run the node now and offers Use this device', () => {
    const revoked = ready({ signed: { deviceState: 'paused', pausedUntil: null, ref: 'ab12cd34' } });
    expect(nodeView({ status: revoked, local: LOCAL })).toMatchObject({ state: 'here', notice: { key: 'node_cant_run_now' }, offerUse: true, reenrol: false });
    const shown = render({ status: revoked, device: DEVICE });
    expect(shown.text).toContain(t('node_cant_run_now'));
    expect(shown.text).not.toContain('—');
    expect(shown.ids).toContain('node-use');
    // A timed pause keeps its date and offers nothing to press.
    const timed = ready({ signed: { deviceState: 'paused', pausedUntil: 170, ref: 'ab12cd34' } });
    expect(nodeView({ status: timed, local: LOCAL })).toMatchObject({ notice: { key: 'node_paused', epoch: 170 }, offerUse: false });
    expect(render({ status: timed, device: DEVICE }).ids).not.toContain('node-use');
  });
});

describe('MN2-10: a reply racing a rotation keeps the new key', () => {
  const P = V.device.ping.challenge;
  const SIGMA = V.device.ping.sigma;

  it('a KEY_GONE of a key a rotation just replaced is signed again with the current key', async () => {
    await linkedHere();
    DeviceKey.currentKey.mockResolvedValueOnce(ANDROID_KEY).mockResolvedValueOnce(ROTATED_KEY);
    DeviceKey.sign.mockImplementation(async (key) => {
      if (key.handle === ANDROID_KEY.handle) throw Object.assign(new Error('gone'), { code: 'KEY_GONE', key });
      return 'AA';
    });
    const wire = await E.hwPingSignature(NODE, P, SIGMA);
    expect(wire.startsWith('ping_hw2:')).toBe(true);
    expect(DeviceKey.sign.mock.calls.map((c) => c[0].handle)).toEqual([ANDROID_KEY.handle, ROTATED_KEY.handle]);
  });

  it('only the key that failed is forgotten, and only while it is current', async () => {
    await linkedHere({ hw: true });
    DeviceKey.forgetKey.mockResolvedValue(false); // a rotation made another key current meanwhile
    await Push.markDeviceKeyLost(NODE, ANDROID_KEY);
    expect(DeviceKey.forgetKey).toHaveBeenCalledWith(ANDROID_KEY);
    expect(DeviceKey.forgetKeys).not.toHaveBeenCalled();
    expect((await info()).hw).toBe(true);
    DeviceKey.forgetKey.mockResolvedValue(true);
    await Push.markDeviceKeyLost(NODE, ANDROID_KEY);
    expect((await info()).hw).toBe(false);
    expect(DeviceKey.forgetKeys).not.toHaveBeenCalled();
  });

  it('a reply whose key is gone for good marks the binding through that key alone', async () => {
    await linkedHere({ hw: true });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockImplementation(async (key) => { throw Object.assign(new Error('gone'), { code: 'KEY_GONE', key }); });
    await Push.handlePushMessage({ action: 'wake', anchor: `${V.device.ping.height}:${V.device.ping.hash}` });
    expect(DeviceKey.forgetKey).toHaveBeenCalledWith(ANDROID_KEY);
    expect(DeviceKey.forgetKeys).not.toHaveBeenCalled();
    expect((await info()).hw).toBe(false);
  });
});

describe('MN2-11: a changed push token goes out from any wake', () => {
  const hold = async () => AsyncStorage.setItem('qnet_self_attest_hold', JSON.stringify({ nodeId: NODE, at: Date.now(), until: Date.now() + 3600000, failures: 0 }));

  it('a push wake and a background fetch send an owed token refresh, signed by the ping key', async () => {
    const BackgroundFetch = require('react-native-background-fetch').default;
    for (const wake of [() => Push.handlePushMessage({ action: 'epoch', anchor: `28800:${'a'.repeat(64)}` }), () => Push.onBackgroundFetch('t1')]) {
      await AsyncStorage.clear();
      await linkedHere({ hw: false });
      await hold();
      await AsyncStorage.setItem('qnet_needs_token_refresh', 'true');
      calls = [];
      await wake();
      const refresh = calls.find((c) => c.url.endsWith('/light-node/token-refresh'));
      expect(refresh.body).toMatchObject({ node_id: NODE, push_type: 'fcm', device_token: 'test-fcm-token', seq: SEQ });
      expect(refresh.url.startsWith(OWNERS[0])).toBe(true);
      expect(await AsyncStorage.getItem('qnet_needs_token_refresh')).toBe('false');
    }
    expect(BackgroundFetch.finish).toHaveBeenCalledWith('t1');
  });

  it('nothing is sent when no refresh is owed', async () => {
    await linkedHere({ hw: false });
    await hold();
    await AsyncStorage.multiSet([['qnet_last_sent_fcm_token', 'test-fcm-token'], ['qnet_needs_token_refresh', 'false']]);
    await Push.handlePushMessage({ action: 'epoch', anchor: `28800:${'a'.repeat(64)}` });
    expect(calls.some((c) => c.url.endsWith('/light-node/token-refresh'))).toBe(false);
  });
});

describe('MN2-12, SD-R2-05: no push channel the app does not have', () => {
  it('the push target is FCM or polling; a stored endpoint of another channel is never read or signed', async () => {
    await AsyncStorage.setItem('qnet_unified_push_endpoint', 'https://push.invalid/endpoint');
    expect(await Push.pushTarget()).toEqual({ type: 'fcm', token: 'test-fcm-token', target: 'test-fcm-token' });
    expect(Push.PushType).toEqual({ FCM: 'fcm', POLLING: 'polling' });
    expect(Push.setUnifiedPushEndpoint).toBeUndefined();
    expect(Push.default.setUnifiedPushEndpoint).toBeUndefined();
  });

  it('no code or comment names that channel or its store', () => {
    const root = path.join(__dirname, '..');
    for (const f of ['App.tsx', 'src/services/PushService.js', 'index.js']) {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      expect([f, /unified.?push|f-droid|fdroid/i.test(text)]).toEqual([f, false]);
    }
  });
});
