/**
 * Final audit, mobile fixer round 4, the node on this device (MN-R4-01 … MN-R4-06, MN-R4-08, MN-R4-09): an overdue key
 * is never re-proven, the overdue notice waits for the node's grace, an unanswered key is settled by every read and its
 * binding re-enrolled when its statement may have had no lease, an unanswered "Use this device" is checked against the
 * node's status, an unknown outcome is never said as "nothing changed", one wrong chain epoch pins nothing, and a
 * refresh token Google Play can fix gets its dialog from the Node tab.
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

const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const DeviceKey = require('../src/services/NodeDeviceKey');
const E = require('../src/services/DeviceEnrolment');
const Push = require('../src/services/PushService');
const { writeLinkPending, readLinkPending } = require('../src/services/LightNode');
const { nodeView, refusalText, ROTATION_GRACE_EPOCHS } = require('../src/screens/NodeTab');
const { performIntent, buildPlaintext } = require('../src/services/QNetLink');
const { nodeLinkActions } = require('../src/services/NodeLinkActions');

const V = require('../../../docs/protocols/light-node.vectors.json');

const NODE = V.wallets[0].nodeId;
const WALLET = V.wallets[0].address;
const PP = V.pingKey.publicKey;
const SEQ = 1790000000;
const ANDROID_KEY = { platform: 'android', handle: 'qnet_dev_a', hwPub: V.device.keys.android.publicKey, attested: true };
const FLAGS = V.device.messages.find((m) => m.name === 'enrol' && m.platform === 'android').flags;
const DEVICE = { capable: true, platform: 'android', flags: FLAGS, report: V.device.report.text };
const IOS = { capable: true, platform: 'ios', flags: 'mac=0,vision=0,idiom=phone', report: null };
const NONCE = V.device.status.refNonce;
const EPOCH = Math.floor(V.device.ping.height / 14400);
// A chain epoch well past the first rotation periods, so the due epochs below are all natural numbers.
const E0 = 1000;
const TAG = 'ab12ab12ab12ab12';

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
    calls.push({ url, body, at: Date.now() });
    const a = answers(url, body, opts);
    if (a && typeof a.then === 'function') return a.then((x) => (x instanceof Error ? Promise.reject(x) : reply(x)));
    return a instanceof Error ? Promise.reject(a) : reply(a);
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  Keychain.getGenericPassword.mockResolvedValue(false);
});

const linkedHere = async ({ hw = true, seq = SEQ, features = ['device_v1', 'hwping_v2', 'status_signed'], schedule = {} } = {}) => {
  await AsyncStorage.multiSet([
    ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, walletAddress: WALLET, pushType: 'fcm', seq, hw })],
    ['qnet_ping_node_id', NODE],
    [`qnet_ping_dilithium_pk_${NODE}`, PP],
    [`qnet_ping_cert_${NODE}`, `v2.${seq}.cert`],
    [E.SCHEDULE_KEY, JSON.stringify({ nodeId: NODE, features, refresh: null, refreshedFor: null, rotationDue: null, ...schedule })],
  ]);
};
const info = async () => JSON.parse(await AsyncStorage.getItem('qnet_light_node_info'));
const schedule = async () => JSON.parse(await AsyncStorage.getItem(E.SCHEDULE_KEY));
const pub = (over = {}) => ({
  onchain_registered: true, device_bound: true, answered_this_epoch: true,
  features: ['status_signed', 'device_v1', 'hwping_v2', 'bind_v2'], ...over,
});
// The signed form: only it names the device (ND-7).
const signedPub = (over = {}) => pub({ device_tag_h: TAG, ...over });
const signer = () => ({
  signNodeStatus: async () => ({ signer: 'wallet', sig: 'ws', identityPublicKey: 'id' }),
  prepareLightNodeBinding: async (cred, { seq }) => ({
    nodeId: NODE, wallet: WALLET, identityPublicKey: 'id', pingPublicKey: PP, delegation: 'del', attachSig: `att${seq}`,
    keep: async () => {}, wipe: () => {},
  }),
});
const enrolled = (handle, platform = 'android') => (platform === 'ios'
  ? {
    key: { platform: 'ios', handle, hwPub: V.device.keys.ios.publicKey, attested: true },
    device: { platform: 'ios', key_id: 'kid', attestation: 'att' }, playNonce: null, token: { field: 'dc_token', value: 'dc' }, tokenError: null,
  }
  : {
    key: { ...ANDROID_KEY, handle }, device: { platform: 'android', chain: ['c'] }, playNonce: 'pn', token: { field: 'pi_token', value: 'p' }, tokenError: null,
  });
const challenge = { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' };

// Runs `start()` on the fake clock until it settles (the status re-reads after an unanswered bind wait seconds).
async function onFakeClock(start) {
  jest.useFakeTimers({ now: Date.now() });
  let out;
  let done = false;
  const p = start().then((r) => { out = r; done = true; }, (e) => { out = e; done = true; });
  for (let i = 0; i < 600 && !done; i++) await jest.advanceTimersByTimeAsync(100);
  await p;
  jest.useRealTimers();
  return out;
}

describe('MN-R4-01: Use this device never re-proves a key whose rotation fell due', () => {
  const run = async ({ rotationDue, platform = 'ios', device = IOS, epoch = E0 } = {}) => {
    answers = (url, body) => {
      if (url.includes('/device-challenge')) return challenge;
      if (url.includes('/light-node/status') && !body) return pub();
      if (url.endsWith('/light-node/status')) {
        return { ...signedPub(), binding_seq: SEQ, device_state: 'check_pending', rotation_due: rotationDue };
      }
      if (url.endsWith('/light-node/bind')) return { success: true, bound: true, seq: body.seq, device_state: 'pending_next_epoch' };
      return { success: true };
    };
    DeviceKey.enrolEvidence.mockResolvedValue(enrolled(platform === 'ios' ? 'aWQ=' : 'qnet_dev_n', platform));
    return Push.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, device, interactive: true, epoch });
  };

  it('iOS, overdue (check_pending past rotation_due): the binding attests a new key, not an assertion', async () => {
    await linkedHere({ hw: true });
    expect(await run({ rotationDue: E0 - 181 })).toMatchObject({ ok: true });
    expect(DeviceKey.enrolEvidence).toHaveBeenCalledTimes(1);
    expect(DeviceKey.enrolEvidence.mock.calls[0][0]).toMatchObject({ reuse: false });
  });

  it('iOS, due by the rotation epoch but within the grace: a new key as well (the node would keep the old period)', async () => {
    expect(await run({ rotationDue: E0 - 3 })).toMatchObject({ ok: true });
    expect(DeviceKey.enrolEvidence.mock.calls[0][0]).toMatchObject({ reuse: false });
  });

  it('iOS, not due: the current key proves itself with an assertion (no new key for Apple\'s count)', async () => {
    expect(await run({ rotationDue: E0 + 100 })).toMatchObject({ ok: true });
    expect(DeviceKey.enrolEvidence.mock.calls[0][0]).toMatchObject({ reuse: true });
  });

  it('the schedule of this device\'s own key counts too, and the epoch falls back to the one last known', async () => {
    await linkedHere({ hw: true, schedule: { rotationDue: E0 - 1 } });
    await AsyncStorage.setItem(Push.CHAIN_EPOCH_KEY, JSON.stringify({ epoch: E0, at: Date.now() - 60000 }));
    expect(await run({ rotationDue: E0 + 100, epoch: null })).toMatchObject({ ok: true });
    expect(DeviceKey.enrolEvidence.mock.calls[0][0]).toMatchObject({ reuse: false });
  });

  it('a re-send that enrols again (enrolAgainIfUnleased) attests a new key for an overdue record too', async () => {
    const T = Math.floor(Date.now() / 1000) - 3600;
    await linkedHere({ hw: true, seq: T });
    await AsyncStorage.setItem(Push.ENROL_AGAIN_KEY, JSON.stringify({
      nodeId: NODE, seq: T, wallet: WALLET, bindBlob: { node_id: NODE, seq: T, ping_pubkey: PP }, tries: 0, nextTryAt: 0,
    }));
    DeviceKey.checkDevice.mockResolvedValue(IOS);
    DeviceKey.enrolEvidence.mockResolvedValue(enrolled('aWQ=', 'ios'));
    answers = (url, body) => (url.includes('/device-challenge') ? challenge
      : url.endsWith('/light-node/bind') ? { success: true, bound: true, seq: body.seq } : { success: true });
    await AsyncStorage.setItem(Push.CHAIN_EPOCH_KEY, JSON.stringify({ epoch: E0, at: Date.now() - 60000 }));
    const status = {
      onChain: true, features: ['device_v1', 'bind_v2'], nonce: NONCE, deviceTags: [],
      signed: { deviceState: 'check_pending', refreshWindow: null, rotationDue: E0 - 200, bindingSeq: T },
    };
    expect(await Push.enrolAgainIfUnleased(NODE, status)).toBe(true);
    expect(DeviceKey.enrolEvidence.mock.calls[0][0]).toMatchObject({ reuse: false });
  });
});

describe('MN-R4-02: "not renewed in time" only past the node\'s grace', () => {
  const HEIGHT = E0 * 14400 + 100;
  const LOCAL = { nodeId: NODE, seq: SEQ, hw: true };
  // A record the network still checks (it names the next check: a lease to refresh, a daily recheck).
  const status = (signed) => ({
    onChain: true, deviceBound: true, keyOurs: true, tagOurs: true, needsReactivation: false, features: ['device_v1'],
    signed: { refreshWindow: { from: 1, to: 2 }, ...signed },
  });

  it('a check_pending record whose rotation fell due five days ago waits for something else: no new-key offer', () => {
    const v = nodeView({ status: status({ deviceState: 'check_pending', rotationDue: E0 - 30 }), local: LOCAL, height: HEIGHT });
    expect(v.notice).toEqual({ key: 'node_check_running' });
    expect(v.offerUse).toBe(false);
  });

  it('at the last epoch of the grace still not; one epoch past it, overdue', () => {
    const at = nodeView({ status: status({ deviceState: 'check_pending', rotationDue: E0 - ROTATION_GRACE_EPOCHS }), local: LOCAL, height: HEIGHT });
    expect(at.notice).toEqual({ key: 'node_check_running' });
    const past = nodeView({ status: status({ deviceState: 'check_pending', rotationDue: E0 - ROTATION_GRACE_EPOCHS - 1 }), local: LOCAL, height: HEIGHT });
    expect(past.notice).toEqual({ key: 'node_key_overdue' });
    expect(past.offerUse).toBe(true);
    expect(ROTATION_GRACE_EPOCHS).toBe(180);
  });
});

describe('MN-R4-03: an unanswered key is settled by every read, and its binding enrolled again', () => {
  it('a binding not known to hold this device\'s key becomes one once a read names the key', async () => {
    await linkedHere({ hw: false });
    DeviceKey.settleByTag.mockResolvedValue('pending');
    expect(await Push.settleUnansweredKey(NODE, { nonce: NONCE, deviceTags: [TAG] })).toBe('pending');
    expect((await info()).hw).toBe(true);
    // No tags: nothing to settle by.
    DeviceKey.settleByTag.mockClear();
    expect(await Push.settleUnansweredKey(NODE, { nonce: NONCE, deviceTags: [] })).toBe(null);
    expect(DeviceKey.settleByTag).not.toHaveBeenCalled();
  });

  it('a wake settles it for such a binding too, and does the upkeep once it holds the key', async () => {
    await linkedHere({ hw: false, schedule: { statusAt: 0 } });
    DeviceKey.hasUnansweredKey.mockResolvedValue(true);
    DeviceKey.settleByTag.mockResolvedValue('pending');
    answers = (url, body) => {
      if (url.includes('/light-node/status') && !body) return pub();
      if (url.endsWith('/light-node/status')) return { ...signedPub(), binding_seq: SEQ, device_state: 'active' };
      if (url.endsWith('/ping-response')) return { success: true };
      return { success: true };
    };
    await Push.handlePushMessage({ action: 'epoch', anchor: `${V.device.ping.height}:${V.device.ping.hash}` });
    expect(DeviceKey.settleByTag).toHaveBeenCalled();
    expect((await info()).hw).toBe(true);
  });

  it('the pending link\'s first read after the node bound it keeps the enrol-again record, whatever the tags say yet', async () => {
    const T = Math.floor(Date.now() / 1000) - 60;
    await linkedHere({ hw: false, seq: T });
    const bindBlob = { node_id: NODE, seq: T, ping_pubkey: PP };
    await writeLinkPending({ nodeId: NODE, wallet: WALLET, T, bound: false, bindBlob });
    const status = { onChain: true, deviceBound: true, features: ['device_v1', 'bind_v2'], nonce: NONCE, deviceTags: [TAG] };
    expect(await Push.resendPendingBinding(NODE, status)).toBe(false);
    expect(await readLinkPending(NODE)).toBe(null);
    expect(JSON.parse(await AsyncStorage.getItem(Push.ENROL_AGAIN_KEY))).toMatchObject({ nodeId: NODE, seq: T, wallet: WALLET, bindBlob });
    expect((await info()).hw).toBe(false);
    // A later read whose tag names the key marks the binding (the tab, a wake, the launch).
    DeviceKey.settleByTag.mockResolvedValue('pending');
    await Push.settleUnansweredKey(NODE, status);
    expect((await info()).hw).toBe(true);
  });

  it('an enrol-again record the link already wrote is not reset', async () => {
    const T = Math.floor(Date.now() / 1000) - 60;
    await linkedHere({ hw: true, seq: T });
    const kept = { nodeId: NODE, seq: T, wallet: WALLET, bindBlob: { node_id: NODE, seq: T }, tries: 2, nextTryAt: 5 };
    await AsyncStorage.setItem(Push.ENROL_AGAIN_KEY, JSON.stringify(kept));
    await writeLinkPending({ nodeId: NODE, wallet: WALLET, T, bound: true, bindBlob: kept.bindBlob });
    await Push.resendPendingBinding(NODE, { onChain: true, deviceBound: true, features: ['device_v1'], nonce: NONCE, deviceTags: [TAG] });
    expect(JSON.parse(await AsyncStorage.getItem(Push.ENROL_AGAIN_KEY))).toEqual(kept);
  });
});

describe('MN-R4-04: a "Use this device" with no answer is checked against the node\'s status', () => {
  const bind = (after) => onFakeClock(async () => {
    let posted = null;
    answers = (url, body) => {
      if (url.includes('/device-challenge')) return challenge;
      if (url.includes('/light-node/status') && !body) return pub();
      if (url.endsWith('/light-node/status')) return after(posted);
      if (url.endsWith('/light-node/bind')) { posted = body.seq; return new Error('the answer was lost'); }
      return { success: true };
    };
    DeviceKey.enrolEvidence.mockResolvedValue(enrolled('qnet_dev_n'));
    const r = await Push.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, device: DEVICE, interactive: true, epoch: EPOCH });
    return { r, posted };
  });

  it('the node took it: the binding and its ping key stay here, the device key waits for its tag', async () => {
    const { r, posted } = await bind((posted) => ({ ...signedPub(), binding_seq: posted || SEQ, device_state: 'check_pending' }));
    expect(r).toEqual({ ok: true, seq: posted });
    expect(DeviceKey.keepUnanswered).toHaveBeenCalledWith(expect.objectContaining({ handle: 'qnet_dev_n' }));
    expect(DeviceKey.dropPendingKey).not.toHaveBeenCalled();
    expect(await info()).toMatchObject({ nodeId: NODE, seq: posted, hw: false });
    expect(await AsyncStorage.getItem(`qnet_ping_cert_${NODE}`)).toBe(`v2.${posted}.del`);
    expect(JSON.parse(await AsyncStorage.getItem(Push.ENROL_AGAIN_KEY))).toMatchObject({ seq: posted });
  });

  it('the node\'s status still names the binding before: not taken, its key goes, and the answer is a plain network one', async () => {
    const { r } = await bind(() => ({ ...signedPub(), binding_seq: SEQ, device_state: 'active' }));
    expect(r).toEqual({ ok: false, reason: 'network', retryAfterSeconds: null });
    expect(DeviceKey.dropPendingKey).toHaveBeenCalledWith(expect.objectContaining({ handle: 'qnet_dev_n' }));
    expect(await info()).toBe(null);
  });

  it('no status after it either: the outcome is unknown, and the tab says so rather than "try again"', async () => {
    const { r } = await bind((posted) => (posted ? new Error('down') : { ...signedPub(), binding_seq: SEQ }));
    expect(r).toMatchObject({ ok: false, reason: 'network', unknown: true });
    const t = (k) => k;
    expect(refusalText(t, { reason: 'network', unknown: true })).toBe('node_use_unknown');
    expect(refusalText(t, { reason: 'network' })).toBe('node_use_err_network');
  });
});

describe('MN-R4-05: an unknown outcome of a QNet Link request is never said as done or undone', () => {
  const session = { intent: 'link', request: null };

  it('a device link with no answer: NETWORK on the wire, `unknown` for this screen only', async () => {
    const offer = { kind: 'link', mode: 'device', nodeId: NODE, qnet: WALLET, device: DEVICE };
    const a = await performIntent({ intent: 'link' }, offer, { node: { useDevice: async () => ({ ok: false, reason: 'network', unknown: true }) } });
    expect(a).toMatchObject({ status: 'error', error: 'NETWORK', unknown: true });
    expect(JSON.parse(buildPlaintext(session, a))).toEqual({ v: 1, intent: 'link', status: 'error', error: 'NETWORK' });
    const known = await performIntent({ intent: 'link' }, offer, { node: { useDevice: async () => ({ ok: false, reason: 'network' }) } });
    expect(known.unknown).toBeUndefined();
  });

  it('a claim with no answer carries `unknown` to the screen', async () => {
    const actions = nodeLinkActions({
      walletManager: { claimRewards: async () => { throw Object.assign(new Error('no answer'), { unknown: true }); } },
      credential: 'c',
    });
    const r = await actions.claim({ nodeId: NODE, qnet: WALLET, amountNano: '2000000000' });
    expect(r).toEqual({ status: 'error', error: 'NETWORK', unknown: true });
    const a = await performIntent({ intent: 'claim' }, { kind: 'claim', nodeId: NODE, qnet: WALLET, amountNano: '2000000000' },
      { node: { claim: async () => r } });
    expect(a).toMatchObject({ status: 'error', error: 'NETWORK', unknown: true });
    expect(JSON.parse(buildPlaintext({ intent: 'claim', request: null }, a))).toEqual({ v: 1, intent: 'claim', status: 'error', error: 'NETWORK' });
  });
});

describe('MN-R4-06: one wrong chain epoch pins nothing, and the node\'s retry_after holds', () => {
  const seen = async () => JSON.parse(await AsyncStorage.getItem(Push.CHAIN_EPOCH_KEY));

  it('an epoch beyond reach of the last one known is not taken; one within reach is', async () => {
    const t0 = 1790000000000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await Push.noteChainEpoch(EPOCH);
    expect(await seen()).toEqual({ epoch: EPOCH, at: t0 });
    spy.mockReturnValue(t0 + 3600000);
    await Push.noteChainEpoch(EPOCH + 5000);                  // one genesis far ahead, or a wrong pushed anchor
    expect((await seen()).epoch).toBe(EPOCH);
    await Push.noteChainEpoch(EPOCH + 1);
    expect((await seen()).epoch).toBe(EPOCH + 1);
    spy.mockReturnValue(t0 + 3600000 + 3 * 14400 * 1000);      // twelve hours later: three epochs more at most
    await Push.noteChainEpoch(EPOCH + 6);
    expect((await seen()).epoch).toBe(EPOCH + 1);
    await Push.noteChainEpoch(EPOCH + 4);
    expect((await seen()).epoch).toBe(EPOCH + 4);
    expect(await Push.knownChainEpoch()).toBe(EPOCH + 4);
  });

  it('a stored epoch the chain contradicts for a day is replaced; a single lower read is not taken', async () => {
    const t0 = 1790000000000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await AsyncStorage.setItem(Push.CHAIN_EPOCH_KEY, JSON.stringify({ epoch: EPOCH + 5000, at: t0 - 1000 }));
    await Push.noteChainEpoch(EPOCH);
    expect((await seen()).epoch).toBe(EPOCH + 5000);
    spy.mockReturnValue(t0 + Push.CHAIN_EPOCH_LOWER_MS - 1);
    await Push.noteChainEpoch(EPOCH + 5);
    expect((await seen()).epoch).toBe(EPOCH + 5000);
    spy.mockReturnValue(t0 + Push.CHAIN_EPOCH_LOWER_MS);
    await Push.noteChainEpoch(EPOCH + 6);
    expect((await seen()).epoch).toBe(EPOCH + 6);
  });

  it('a rotation the node takes early waits what the node asked, beyond four days; a clock set back voids the wait', async () => {
    const t0 = 1790000000000;
    await linkedHere({ schedule: { rotationDue: 10, deviceState: 'active' } });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.rotationEvidence.mockResolvedValue({
      key: { ...ANDROID_KEY, handle: 'qnet_dev_r' }, device: { platform: 'android', chain: ['c'] }, oldSig: 'o', token: { field: 'pi_token', value: 'pt' },
    });
    const days30 = 30 * 86400;
    answers = (url) => (url.includes('/device-challenge') ? challenge
      : { success: false, reason: 'device_rate_limited', retry_after_seconds: days30 });
    const at = (now) => E.rotateIfDue(NODE, { epoch: 20, seq: SEQ, pingPublicKey: PP, device: DEVICE, now });
    expect(await at(t0)).toBe(false);
    expect(await schedule()).toMatchObject({ rotateNextAt: t0 + days30 * 1000, rotateWaitSetAt: t0, rotateRefusals: 1 });
    expect(DeviceKey.rotationEvidence).toHaveBeenCalledTimes(1);
    // Five, then twenty days on: still waiting, no key attested.
    expect(await at(t0 + 5 * 86400000)).toBe(false);
    expect(await at(t0 + 20 * 86400000)).toBe(false);
    expect(DeviceKey.rotationEvidence).toHaveBeenCalledTimes(1);
    // A clock set back past the time the wait was written voids it.
    expect(await at(t0 - 7 * 3600000)).toBe(false);
    expect(DeviceKey.rotationEvidence).toHaveBeenCalledTimes(2);
  });
});

describe('MN-R4-08: a binding without a device key is told what to do, never "not counted"', () => {
  it('the notice reads as advice in every language', () => {
    for (const lang of ['en', 'ru', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'zh-CN', 'ar']) {
      const text = require(`../src/i18n/locales/${lang}.js`).default.node_device_again;
      expect(typeof text).toBe('string');
      expect(text).not.toMatch(/does not count|не засчитывает|zählt das Netzwerk|no cuenta|ne compte pas|non conta|数えていません|집계하지|não conta|不会在此计入|لا تحتسب/);
    }
    const en = require('../src/i18n/locales/en.js').default;
    expect(en.node_device_again).toBe("This device's key for the node is missing or was never registered. Tap Use this device to register it.");
  });
});

describe('MN-R4-09: a refresh token Google Play can fix gets its dialog from the Node tab', () => {
  const window = (now) => ({ from: Math.floor(now / 1000) - 60, to: Math.floor(now / 1000) + 3600 });

  it('a background try notes PLAY_FIXABLE; the tab then shows the dialog, gets a token and the refresh goes through', async () => {
    const now = Date.now();
    await linkedHere({ hw: true, schedule: { refresh: window(now) } });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockResolvedValue('dsig');
    const fixable = Object.assign(new Error('Play services out of date'), { code: 'PLAY_FIXABLE' });
    DeviceKey.vendorToken.mockRejectedValue(fixable);
    const posted = [];
    answers = (url, body) => {
      if (url.includes('/device-challenge')) return challenge;
      if (url.endsWith('/device-refresh')) {
        posted.push(body);
        return body.token ? { success: true, device_state: 'active' } : { success: false, reason: 'device_stale' };
      }
      return { success: true };
    };
    // A wake's try: no dialog, no token, refused; the reason is kept.
    expect(await E.refreshIfDue(NODE, { now })).toBe(false);
    expect(DeviceKey.showPlayDialog).not.toHaveBeenCalled();
    expect(await schedule()).toMatchObject({ refreshTokenError: 'PLAY_FIXABLE' });
    // The tab, within the back-off: the dialog, then the token.
    DeviceKey.showPlayDialog.mockResolvedValue('ok');
    DeviceKey.vendorToken.mockRejectedValueOnce(fixable).mockResolvedValueOnce({ field: 'pi_token', value: 'fixed' });
    expect(await Push.refreshLeaseFromTab(NODE)).toBe(true);
    expect(DeviceKey.showPlayDialog).toHaveBeenCalledWith('integrity');
    expect(posted[posted.length - 1].token).toBe('fixed');
    expect(await schedule()).toMatchObject({ refreshTokenError: null, refreshTries: 0 });
  });

  it('the tab does nothing for any other failure, and shows the dialog at most once an hour', async () => {
    const now = Date.now();
    await linkedHere({ hw: true, schedule: { refresh: window(now), refreshTokenError: 'BUSY' } });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    expect(await E.refreshIfDue(NODE, { now, interactive: true })).toBe(false);
    expect(calls).toHaveLength(0);
    await linkedHere({ hw: true, schedule: { refresh: window(now), refreshTokenError: 'PLAY_FIXABLE', refreshDialogAt: now - 60000 } });
    expect(await E.refreshIfDue(NODE, { now, interactive: true })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(E.REFRESH_DIALOG_MS).toBe(3600000);
  });
});
