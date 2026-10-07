/**
 * Final audit, mobile fixer round 3, the node on this device (MN-R3-02, MN-R3-03, MN-R3-05): the 30-day rotation makes
 * its key in the enrolment lane and a refused message drops only its own key; a signed status read before a rotation or
 * binding the node took never puts back the schedule before it, and the Node tab hands the wakes only a signed status it
 * read itself; and a background wake's status read keeps the wake's deadline.
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

const fs = require('fs');
const path = require('path');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const DeviceKey = require('../src/services/NodeDeviceKey');
const E = require('../src/services/DeviceEnrolment');
const Push = require('../src/services/PushService');
const { readNodeStatus } = require('../src/services/LightNode');
const { lightShardOwnerUrls } = require('../src/config/nodes');

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
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
const evidence = (handle = 'qnet_dev_b') => ({
  key: { ...ANDROID_KEY, handle }, device: { platform: 'android', chain: ['c'] }, oldSig: 'o', token: { field: 'pi_token', value: 'pt' },
});
const enrolled = (handle) => ({
  key: { ...ANDROID_KEY, handle }, device: { platform: 'android', chain: ['c'] }, playNonce: 'pn', token: { field: 'pi_token', value: 'p' }, tokenError: null,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const until = async (cond) => {
  for (let i = 0; i < 400 && !cond(); i++) await wait(5);
  expect(cond()).toBe(true);
};
// Every endpoint a wake and a binding reach here.
const everything = (url, body) => {
  if (url.endsWith('/ping-response')) return { success: false, reason: 'device_stale' };
  if (url.includes('/device-challenge')) return { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' };
  if (url.endsWith('/device-rotate')) return { success: true, device_state: 'active', rotation_due: EPOCH + 180 };
  if (url.includes('/light-node/status') && !body) return pub();
  if (url.endsWith('/light-node/status')) return { ...pub(), binding_seq: SEQ };
  if (url.endsWith('/light-node/bind')) return { success: true, bound: true, seq: body.seq };
  return { success: true };
};
const wake = () => Push.handlePushMessage({ action: 'epoch', anchor: `${V.device.ping.height}:${V.device.ping.hash}` });

describe('MN-R3-02: the rotation and an enrolment never make keys beside each other', () => {
  const overdue = async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    await linkedHere({ schedule: { rotationDue: EPOCH - 5, deviceState: 'active', statusAt: now } });
    await AsyncStorage.setItem(Push.LAST_ANSWER_KEY, JSON.stringify({ epoch: EPOCH - 6, at: now - 86400000 }));
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockResolvedValue('dsig');
    answers = everything;
  };

  it('Use this device waits for a wake\'s rotation that runs, and enrols after it', async () => {
    await overdue();
    const gate = deferred();
    const order = [];
    DeviceKey.rotationEvidence.mockImplementation(async () => { order.push('rotation'); await gate.promise; return evidence('qnet_dev_b'); });
    DeviceKey.enrolEvidence.mockImplementation(async () => { order.push('enrol'); return enrolled('qnet_dev_c'); });
    const woken = wake();
    await until(() => order.length === 1);
    const use = Push.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, device: DEVICE, interactive: true });
    await wait(40);
    expect(order).toEqual(['rotation']); // no key made beside the rotation's
    gate.resolve();
    await woken;
    await use;
    expect(order).toEqual(['rotation', 'enrol']);
    expect(DeviceKey.commitKey.mock.calls.map(([k]) => k.handle)).toEqual(['qnet_dev_b', 'qnet_dev_c']);
  });

  it('a wake that finds an enrolment running leaves the rotation to a later wake', async () => {
    await overdue();
    const gate = deferred();
    DeviceKey.enrolEvidence.mockImplementation(async () => { await gate.promise; return enrolled('qnet_dev_c'); });
    DeviceKey.rotationEvidence.mockResolvedValue(evidence('qnet_dev_b'));
    const use = Push.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, device: DEVICE, interactive: true });
    await until(() => DeviceKey.enrolEvidence.mock.calls.length === 1);
    await wake();
    expect(DeviceKey.rotationEvidence).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.url.endsWith('/device-rotate'))).toHaveLength(0);
    gate.resolve();
    expect(await use).toMatchObject({ ok: true });
  });

  it('a refused rotation or enrolment drops only the key it made', async () => {
    await linkedHere({ schedule: { rotationDue: 10, deviceState: 'active' } });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.rotationEvidence.mockResolvedValue(evidence('qnet_dev_r'));
    answers = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' }
      : { success: false, reason: 'device_stale' });
    expect(await E.rotateIfDue(NODE, { epoch: 20, seq: SEQ, pingPublicKey: PP, device: DEVICE, now: 1790000000000 })).toBe(false);
    expect(DeviceKey.dropPendingKey).toHaveBeenCalledWith(expect.objectContaining({ handle: 'qnet_dev_r' }));
    DeviceKey.dropPendingKey.mockClear();
    expect(await E.settle({ key: { ...ANDROID_KEY, handle: 'qnet_dev_e' } }, false)).toBe(false);
    expect(DeviceKey.dropPendingKey).toHaveBeenCalledWith(expect.objectContaining({ handle: 'qnet_dev_e' }));
    for (const call of DeviceKey.dropPendingKey.mock.calls) expect(call[0]).toBeTruthy();
    expect(read('src/services/DeviceEnrolment.js')).not.toMatch(/dropPendingKey\(\)/);
    expect(read('src/services/PushService.js')).toMatch(/inEnrolLane\(nodeId, \(\) => Enrolment\.maintain\(/);
  });
});

describe('MN-R3-03: a status read before a rotation the node took never puts its schedule back', () => {
  it('the rotation\'s answer stands against a signed status read before it; a later read is taken', async () => {
    const t0 = 1790000000000;
    await linkedHere({ schedule: { rotationDue: 10, deviceState: 'active' } });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.rotationEvidence.mockResolvedValue(evidence());
    answers = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' }
      : { success: true, device_state: 'active', rotation_due: 190 });
    const spy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    expect(await E.rotateIfDue(NODE, { epoch: 20, seq: SEQ, pingPublicKey: PP, device: DEVICE, now: t0 })).toBe(true);
    expect(await schedule()).toMatchObject({ rotationDue: 190, rotateTriedAt: t0, answerAt: t0 });
    // The Node tab's signed status from a minute before: the old epoch, already reached.
    spy.mockReturnValue(t0 + 30000);
    const old = { onChain: true, features: ['device_v1', 'hwping_v2'], signed: { refreshWindow: null, rotationDue: 10, deviceState: 'active' } };
    await E.noteStatus(NODE, old, { readAt: t0 - 60000 });
    expect(await schedule()).toMatchObject({ rotationDue: 190, features: ['device_v1', 'hwping_v2'] });
    // A wake within the next hours attests no key for a rotation the node would refuse.
    expect(await E.rotateIfDue(NODE, { epoch: 20, seq: SEQ, pingPublicKey: PP, device: DEVICE, now: t0 + 3600000 })).toBe(false);
    expect(DeviceKey.rotationEvidence).toHaveBeenCalledTimes(1);
    // A read that started after the answer is the record as it is now.
    await E.noteStatus(NODE, { ...old, signed: { ...old.signed, rotationDue: 191 } }, { readAt: t0 + 1000 });
    expect(await schedule()).toMatchObject({ rotationDue: 191, statusAt: t0 + 1000 });
  });

  it('a binding the node took stands against a status read before it', async () => {
    const t0 = 1790000000000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    await E.noteBinding(NODE, ['device_v1'], { rotation_due: 300, device_state: 'pending_next_epoch' });
    await E.noteStatus(NODE, { onChain: true, features: ['device_v1'], signed: { refreshWindow: null, rotationDue: 12, deviceState: 'active' } }, { readAt: t0 - 5 });
    expect(await schedule()).toMatchObject({ rotationDue: 300, deviceState: 'pending_next_epoch', statusAt: null });
  });

  it('the Node tab gives the wakes only a signed status it read now, with the time the read began', () => {
    const ws = read('src/screens/WalletScreen.js');
    const load = ws.slice(ws.indexOf('const loadLightNodeStatus = async'), ws.indexOf('const pending = await readLinkPending(nodeId);'));
    // The time is taken right before the read; between them only the signers are set up (no await).
    const head = load.slice(load.indexOf('const readAt = Date.now();'), load.indexOf('let status = await readNodeStatus('));
    expect(head.length).toBeGreaterThan(0);
    expect(head).not.toMatch(/\bawait\b(?! signStatusWithPingKey)/);
    // Only a status read now with this device's ping key: an answer to the wallet key may describe another device's record.
    expect(load).toMatch(/noteDeviceStatus\(nodeId, sign && status\.signer === 'ping' \? status : \{ \.\.\.status, signed: null \}, \{ readAt \}\)/);
    const push = read('src/services/PushService.js');
    expect((push.match(/Enrolment\.noteStatus\([^)]*\{ readAt \}\)/g) || []).length).toBe(2);
  });
});

describe('MN-R3-05: a wake\'s status read keeps the wake\'s deadline', () => {
  const hanging = (url, body, opts) => {
    if (!body) return pub();
    // A signed status POST no owner answers: only the abort ends it.
    return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(new Error('aborted'))));
  };

  // MN-R4-10: on the fake clock, so a loaded machine cannot fail it; the time is the timers', not the wall's.
  // Every owner is asked at once (each owner's device tag counts, ND-7), each within the deadline.
  it('owners slow to answer the signed POST: the read ends by the deadline, and no POST starts too late', async () => {
    jest.useFakeTimers({ now: 1790000000000 });
    try {
      answers = hanging;
      const started = Date.now();
      const deadline = started + 2500;
      let status = null;
      const read = readNodeStatus(NODE, { signStatus: async () => ({ signer: 'ping', sig: 's' }), timeoutMs: 5000, deadline })
        .then((st) => { status = st; });
      for (let i = 0; i < 100 && status === null; i++) await jest.advanceTimersByTimeAsync(50);
      await read;
      expect(status).not.toBe(null);
      // Ended by the deadline on the timers' clock: the last abort fires at it.
      expect(Date.now()).toBeLessThanOrEqual(deadline + 50);
      expect(status.onChain).toBe(true);
      expect(status.signed).toBe(null);
      const posts = calls.filter((c) => c.body);
      expect(posts.length).toBe(OWNERS.length);
      expect(new Set(posts.map((p) => p.at)).size).toBe(1);
      // No POST started with less than MIN_POST_MS (1.5 s) of the deadline left.
      for (const p of posts) expect(p.at).toBeLessThanOrEqual(deadline - 1500);
    } finally {
      jest.useRealTimers();
    }
  });

  it('too little left: nothing is asked, and nothing is learned', async () => {
    const status = await readNodeStatus(NODE, { signStatus: async () => ({ signer: 'ping', sig: 's' }), deadline: Date.now() + 1000 });
    expect(calls).toHaveLength(0);
    expect(status.onChain).toBe(null);
  });

  it('the wakes pass their deadline to it', () => {
    const push = read('src/services/PushService.js');
    const reads = push.match(/readNodeStatus\(nodeId, \{ signStatus: signStatusWithPingKey, timeoutMs: 5000, deadline \}\)/g) || [];
    expect(reads).toHaveLength(2);
    expect(push).not.toMatch(/readNodeStatus\(nodeId, \{ signStatus: signStatusWithPingKey, timeoutMs: 5000 \}\)/);
  });
});
