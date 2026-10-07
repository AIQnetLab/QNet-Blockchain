/**
 * Final audit, mobile fixer round 1 (MN-R1-01 … MN-R1-08), the node on this device: a key sent without an answer is
 * never dropped by a read the node or the other owners have not caught up with, and the tab offers Use this device when
 * the owners name a key this install lost; a record that waits with no lease is enrolled again whatever the first
 * enrolment carried; the lease refresh backs off; a message with a device block goes to its challenge's issuer only; an
 * expired link takes its binding with it; the link sheet reuses the key the network holds; no claim is signed that
 * cannot be reported; and the counted row says what the node counts.
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
const messaging = require('@react-native-firebase/messaging').default;
const DeviceKey = require('../src/services/NodeDeviceKey');
const E = require('../src/services/DeviceEnrolment');
const Push = require('../src/services/PushService');
const { postBind, postPendingBind, readNodeStatus } = require('../src/services/LightNode');
const { lightShardOwnerUrls } = require('../src/config/nodes');
const { nodeView } = require('../src/screens/NodeTab');
const { WalletManager } = require('../src/components/WalletManager');

const V = require('../../../docs/protocols/light-node.vectors.json');

const NODE = V.wallets[0].nodeId;
const WALLET = V.wallets[0].address;
const OWNERS = lightShardOwnerUrls(NODE);
const PP = V.pingKey.publicKey;
const SEQ = 1790000000;
const ANDROID_KEY = { platform: 'android', handle: 'qnet_dev_a', hwPub: V.device.keys.android.publicKey, attested: true };
const IOS_KEY = { platform: 'ios', handle: 'kid', hwPub: V.device.keys.ios.publicKey, attested: true };
const FLAGS = V.device.messages.find((m) => m.name === 'enrol' && m.platform === 'android').flags;
const DEVICE = { capable: true, platform: 'android', flags: FLAGS, report: V.device.report.text };
const NONCE = 'n'.repeat(43);

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
  Keychain.getGenericPassword.mockResolvedValue({ password: 'ping-sk' });
  calls = [];
  answers = () => ({ success: true });
  global.fetch = jest.fn((url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body, at: Date.now() });
    const a = answers(url, body, opts);
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
const useDevice = () => Push.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, device: DEVICE, interactive: true });
const challengeFrom = (issuer) => ({ nonce: NONCE, stamp: 'st', exp: 1, issuer: 'genesis_node_00x', _issuer: issuer });
const enrolAnswers = (bindAnswer, { issuer = OWNERS[0] } = {}) => (url, body) => {
  if (url.includes('/device-challenge')) return url.startsWith(issuer) ? challengeFrom(issuer) : new Error('down');
  if (url.includes('/light-node/status') && !body) return pub();
  if (url.endsWith('/light-node/status')) return { ...pub(), binding_seq: SEQ - 1 };
  if (url.endsWith('/light-node/bind')) return bindAnswer(body, url);
  return { success: true };
};
const binds = () => calls.filter((c) => c.url.endsWith('/light-node/bind'));
const again = async () => JSON.parse(await AsyncStorage.getItem(Push.ENROL_AGAIN_KEY));

describe('MN-R1-01: a key the owners do not name any more is offered back, never left OFFLINE', () => {
  const LOCAL = { nodeId: NODE, seq: SEQ, pushType: 'fcm', hw: true };
  const status = (over = {}) => ({
    onChain: true, deviceBound: true, needsReactivation: true, keyOurs: true, features: ['device_v1', 'hwping_v2'], signed: null, ...over,
  });

  it('the node takes the ping key while two owners name another device key: Use this device, with its notice', () => {
    const v = nodeView({ status: status({ tagOurs: false }), local: LOCAL });
    expect(v).toMatchObject({ state: 'here', reenrol: true, offerUse: true, notice: { key: 'node_device_again' } });
    // An owner naming this device's key, or no verdict, changes nothing.
    for (const tagOurs of [true, null, undefined]) {
      expect(nodeView({ status: status({ tagOurs }), local: LOCAL })).toMatchObject({ state: 'here', reenrol: false, offerUse: false });
    }
  });

  it('the status carries every agreeing owner\'s tag, from its signed answer only (ND-7)', async () => {
    const sign = async () => ({ signer: 'ping', sig: 'ab' });
    const TAGS = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
    const at = (url) => lightShardOwnerUrls(NODE).findIndex((o) => url.startsWith(o));
    answers = (url, body) => (url.includes('/light-node/status')
      ? pub(body ? { device_tag_h: TAGS[at(url)] } : { device_tag_h: 'dddddddddddddddd' }) : { success: true });
    const s = await readNodeStatus(NODE, { signStatus: sign });
    expect(s.deviceTags.sort()).toEqual(TAGS);
    // Each owner is asked with the signature and the read's nonce; a tag in a public answer is never read.
    const posts = calls.filter((c) => c.body);
    expect(posts.map((c) => c.body.nonce)).toEqual([s.nonce, s.nonce, s.nonce]);
    expect(s.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect((await readNodeStatus(NODE)).deviceTags).toEqual([]);
    // An owner that refused the key, or says the node is not on the chain, names nothing.
    answers = (url, body) => {
      if (!url.includes('/light-node/status')) return {};
      if (!body) return pub();
      return at(url) === 0 ? { success: false, reason: 'bad_signature' }
        : pub({ onchain_registered: at(url) === 1, device_tag_h: TAGS[at(url)] });
    };
    expect((await readNodeStatus(NODE, { signStatus: sign })).deviceTags).toEqual([TAGS[1]]);
  });

  it('no ping key here: nothing is asked with a signature, and the read says so', async () => {
    answers = (url) => (url.includes('/light-node/status') ? pub() : {});
    const s = await readNodeStatus(NODE, { signStatus: async () => null });
    expect(s).toMatchObject({ noStatusKey: true, deviceTags: [], keyOurs: null, signed: null });
    expect(calls.filter((c) => c.body)).toEqual([]);
    // A signature that failed is no verdict on the key.
    const failed = await readNodeStatus(NODE, { signStatus: async () => { throw new Error('locked'); } });
    expect(failed.noStatusKey).toBe(false);
  });
});

describe('MN-R1-02: a record that waits with no lease is enrolled again, a token or not the first time', () => {
  const withToken = { key: ANDROID_KEY, device: { platform: 'android', chain: ['c'] }, playNonce: 'pn', token: { field: 'pi_token', value: 'p1' }, tokenError: null };
  const unleased = (seq) => ({
    onChain: true, features: ['device_v1', 'bind_v2'], deviceTags: [], signed: { deviceState: 'check_pending', refreshWindow: null, bindingSeq: seq },
  });

  it('a binding sent with a token that the oracle could not lease is re-sent with a fresh challenge and token', async () => {
    const t0 = 1790000000000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    answers = enrolAnswers((body) => ({ success: true, bound: true, seq: body.seq, device_state: 'check_pending' }));
    DeviceKey.enrolEvidence.mockResolvedValue(withToken);
    const r = await useDevice();
    expect(r.ok).toBe(true);
    expect(binds()[0].body).toMatchObject({ pi_token: 'p1' });
    expect(await again()).toMatchObject({ nodeId: NODE, seq: r.seq, tries: 0, nextTryAt: t0 + Push.ENROL_AGAIN_FIRST_WAIT_MS });
    expect((await again()).bindBlob).not.toHaveProperty('device');
    expect((await again()).bindBlob).not.toHaveProperty('pi_token');
    // After the attestors' vote, the oracle back: the tab sends the same binding again.
    Date.now.mockReturnValue(t0 + Push.ENROL_AGAIN_FIRST_WAIT_MS);
    calls = [];
    DeviceKey.enrolEvidence.mockResolvedValue({ ...withToken, token: { field: 'pi_token', value: 'p2' } });
    expect(await Push.enrolAgainIfUnleased(NODE, unleased(r.seq))).toBe(true);
    expect(binds()).toHaveLength(1);
    expect(binds()[0].body).toMatchObject({ seq: r.seq, pi_token: 'p2', attach_sig: `att${r.seq}` });
    expect(await again()).toMatchObject({ seq: r.seq, tries: 1 });
    // A counted record ends the task.
    expect(await Push.enrolAgainIfUnleased(NODE, { ...unleased(r.seq), signed: { deviceState: 'active', refreshWindow: { from: 1, to: 2 } } })).toBe(false);
    expect(await again()).toBeNull();
  });

  it('none while a key sent without an answer waits for the status to settle it', async () => {
    const t0 = 1790000000000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    await linkedHere();
    await AsyncStorage.setItem(Push.ENROL_AGAIN_KEY, JSON.stringify({
      nodeId: NODE, seq: SEQ, wallet: WALLET, bindBlob: { node_id: NODE, seq: SEQ, ping_pubkey: PP }, tries: 0, nextTryAt: t0 - 1,
    }));
    DeviceKey.hasUnansweredKey.mockResolvedValue(true);
    expect(await Push.enrolAgainIfUnleased(NODE, unleased(SEQ))).toBe(false);
    expect(calls).toEqual([]);
    expect(DeviceKey.enrolEvidence).not.toHaveBeenCalled();
  });
});

describe('MN-R1-03: the lease refresh backs off', () => {
  const window = (now) => ({ refresh: { from: Math.floor(now / 1000) - 10, to: Math.floor(now / 1000) + 3 * 86400 } });

  it('a failed try waits 30 min, doubling, and at least what the node asked, with no challenge or token meanwhile', async () => {
    const now = 1790000000000;
    await linkedHere({ schedule: window(now) });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockResolvedValue('dsig');
    DeviceKey.vendorToken.mockResolvedValue({ field: 'pi_token', value: 'tok' });
    // The oracle does not answer: device_stale, retry in 600 s.
    answers = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' }
      : { success: false, reason: 'device_stale', retry_after_seconds: 600 });
    expect(await E.refreshIfDue(NODE, { now })).toBe(false);
    expect(calls.filter((c) => c.url.endsWith('/device-refresh'))).toHaveLength(1);
    // Every wake of the next half hour asks nothing: no challenge, no Play Integrity token, no POST.
    calls = [];
    DeviceKey.vendorToken.mockClear();
    for (const t of [now + 60_000, now + 10 * 60_000, now + E.REFRESH_FIRST_WAIT_MS - 1]) {
      expect(await E.refreshIfDue(NODE, { now: t })).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(DeviceKey.vendorToken).not.toHaveBeenCalled();
    // The second try, then a wait of an hour.
    expect(await E.refreshIfDue(NODE, { now: now + E.REFRESH_FIRST_WAIT_MS })).toBe(false);
    expect(calls.filter((c) => c.url.endsWith('/device-refresh'))).toHaveLength(1);
    calls = [];
    expect(await E.refreshIfDue(NODE, { now: now + E.REFRESH_FIRST_WAIT_MS + 59 * 60_000 })).toBe(false);
    expect(calls).toEqual([]);
    // No owner gives a challenge at all: the try counts all the same.
    answers = () => new Error('down');
    await expect(E.refreshIfDue(NODE, { now: now + 3 * E.REFRESH_FIRST_WAIT_MS })).rejects.toMatchObject({ code: 'NETWORK' });
    calls = [];
    expect(await E.refreshIfDue(NODE, { now: now + 4 * E.REFRESH_FIRST_WAIT_MS })).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a rate limit longer than the back-off is waited out; a refresh that goes through ends the window\'s tries', async () => {
    const now = 1790000000000;
    await linkedHere({ schedule: window(now) });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockResolvedValue('dsig');
    DeviceKey.vendorToken.mockResolvedValue({ field: 'pi_token', value: 'tok' });
    answers = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' }
      : { success: false, reason: 'rate_limited', retry_after_seconds: 5 * 3600 });
    expect(await E.refreshIfDue(NODE, { now })).toBe(false);
    calls = [];
    expect(await E.refreshIfDue(NODE, { now: now + 5 * 3600 * 1000 - 1 })).toBe(false);
    expect(calls).toEqual([]);
    answers = (url) => (url.includes('/device-challenge') ? { nonce: NONCE, stamp: 'st', exp: 1, issuer: 'g' }
      : { success: true, device_state: 'active', rotation_due: 200 });
    expect(await E.refreshIfDue(NODE, { now: now + 5 * 3600 * 1000 })).toBe(true);
    const s = JSON.parse(await AsyncStorage.getItem(E.SCHEDULE_KEY));
    expect(s).toMatchObject({ refreshedFor: window(now).refresh.from, refreshTries: 0, refreshNextAt: null, rotationDue: 200 });
  });

  it('the source keeps the rule: the back-off is written before the challenge is asked', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'DeviceEnrolment.js'), 'utf8');
    const body = src.slice(src.indexOf('export async function refreshIfDue'), src.indexOf('export async function rotateIfDue'));
    expect(body.indexOf('refreshTries: tries')).toBeGreaterThan(0);
    expect(body.indexOf('refreshTries: tries')).toBeLessThan(body.indexOf("fetchChallenge(nodeId, 'refresh'"));
  });
});

describe('MN-R1-04: a message with a device block goes to its challenge\'s issuer only', () => {
  it('postBind: an issuer that does not answer leaves it unanswered; no other owner is asked', async () => {
    answers = (url) => (url.startsWith(OWNERS[1]) ? new Error('timeout') : { success: false, reason: 'device_stale' });
    const r = await postBind(NODE, { seq: 5, device: { stamp: 's' } }, { first: OWNERS[1] });
    expect(r).toMatchObject({ ok: false, reason: 'network' });
    expect(calls.map((c) => c.url)).toEqual([`${OWNERS[1]}/api/v1/light-node/bind`]);
    // A binding without a device block still goes to every owner in turn.
    calls = [];
    answers = (url) => (url.startsWith(OWNERS[0]) ? new Error('timeout') : { success: true, bound: true, seq: 6 });
    expect(await postBind(NODE, { seq: 6 }, {})).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('postPendingBind: the backup\'s device_stale for a stamp it did not issue refuses nothing', async () => {
    answers = (url) => (url.startsWith(OWNERS[2]) ? new Error('timeout') : { success: false, reason: 'device_stale' });
    expect(await postPendingBind(NODE, { seq: 7, device: { stamp: 's' } }, { first: OWNERS[2] }))
      .toMatchObject({ ok: false, reason: 'network' });
    expect(calls).toHaveLength(2);
    // The issuer's own device_stale is a refusal.
    answers = () => ({ success: false, reason: 'device_stale', retry_after_seconds: 60 });
    expect(await postPendingBind(NODE, { seq: 7, device: { stamp: 's' } }, { first: OWNERS[2] }))
      .toMatchObject({ ok: false, reason: 'device_stale', retryAfterSeconds: 60 });
  });

  it('a re-send whose issuer gave no answer keeps its key for the status, never deletes it', async () => {
    const t0 = 1790000000000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);
    await linkedHere();
    await AsyncStorage.setItem(Push.ENROL_AGAIN_KEY, JSON.stringify({
      nodeId: NODE, seq: SEQ, wallet: WALLET, bindBlob: { node_id: NODE, seq: SEQ, ping_pubkey: PP }, tries: 0, nextTryAt: t0 - 1,
    }));
    DeviceKey.enrolEvidence.mockResolvedValue({ key: ANDROID_KEY, device: { platform: 'android' }, playNonce: 'pn', token: { field: 'pi_token', value: 'p' } });
    answers = enrolAnswers((body, url) => (url.startsWith(OWNERS[0]) ? new Error('timeout') : { success: false, reason: 'device_stale' }));
    const status = { onChain: true, features: ['device_v1', 'bind_v2'], deviceTags: [], signed: { deviceState: 'check_pending', refreshWindow: null, bindingSeq: SEQ } };
    expect(await Push.enrolAgainIfUnleased(NODE, status)).toBe(false);
    expect(binds().map((c) => c.url)).toEqual([`${OWNERS[0]}/api/v1/light-node/bind`]);
    expect(DeviceKey.keepUnanswered).toHaveBeenCalledWith(ANDROID_KEY);
    expect(DeviceKey.dropPendingKey).not.toHaveBeenCalled();
    expect(await again()).toMatchObject({ tries: 1 });
  });
});

describe('MN-R1-05: an expired link that never landed takes its binding with it', () => {
  const T = 1790000000;
  const pendingRecord = async () => AsyncStorage.setItem('qnet_node_link_pending', JSON.stringify({
    nodeId: NODE, wallet: WALLET, T, createdAt: T * 1000, bound: false, bindBlob: { node_id: NODE, seq: T, ping_pubkey: PP },
  }));
  const expiredAt = (T + 86400 + 601) * 1000;

  it('two owners say the node is not on the chain: the record, the ping key, the push token and the wakes go', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(expiredAt);
    await linkedHere({ seq: T, hw: false });
    await AsyncStorage.setItem('qnet_last_sent_fcm_token', 'tok');
    await pendingRecord();
    expect(await Push.resendPendingBinding(NODE, { onChain: false, features: [] })).toBe(false);
    expect(await AsyncStorage.getItem('qnet_node_link_pending')).toBeNull();
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBeNull();
    expect(await AsyncStorage.getItem('qnet_light_node_info')).toBeNull();
    expect(messaging().deleteToken).toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('no verdict keeps the record and the binding; a binding the node took, or a newer one, is never torn down', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(expiredAt);
    await linkedHere({ seq: T, hw: false });
    await pendingRecord();
    const rec = { ...JSON.parse(await AsyncStorage.getItem('qnet_node_link_pending')), expired: true };
    expect(await Push.endExpiredLink(NODE, { onChain: null }, rec)).toBe(false);
    expect(await AsyncStorage.getItem('qnet_node_link_pending')).not.toBeNull();
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(NODE);
    // On the chain and the ping key taken: only the record goes.
    expect(await Push.endExpiredLink(NODE, { onChain: true, keyOurs: true }, rec)).toBe(false);
    expect(await AsyncStorage.getItem('qnet_node_link_pending')).toBeNull();
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(NODE);
    // Two owners refuse the ping key of the link's binding: it goes.
    expect(await Push.endExpiredLink(NODE, { onChain: true, keyOurs: false }, rec)).toBe(true);
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBeNull();
    // A binding made after the link (Use this device) is not the link's.
    await linkedHere({ seq: T + 50, hw: true });
    expect(await Push.endExpiredLink(NODE, { onChain: false }, rec)).toBe(false);
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(NODE);
  });

  it('the tab says "not recorded" only on the network\'s word, and "could not be reached" without one', () => {
    expect(nodeView({ status: { onChain: false }, pending: { expired: true } })).toEqual({ state: 'not_recorded' });
    expect(nodeView({ status: { onChain: null }, pending: { expired: true } })).toEqual({ state: 'unreachable' });
    expect(nodeView({ status: { onChain: null }, pending: { expired: false } })).toEqual({ state: 'linking' });
  });
});

describe('MN-R1-06: the link sheet reuses the key the network holds, as Use this device does', () => {
  const consentSigner = {
    prepareLinkConsent: async (cred, { ts }) => ({
      nodeId: NODE, wallet: WALLET, identityPublicKey: '00'.repeat(1952), consentSig: '00'.repeat(3309), proof: 'p',
      binding: { wallet: WALLET, identityPublicKey: 'id', pingPublicKey: PP, delegation: 'del', attachSig: `att${ts}`, keep: async () => {}, wipe: () => {} },
    }),
  };
  const link = () => Push.linkWithConsent({
    signer: consentSigner, credential: {}, nodeId: NODE, burnTx: 'b'.repeat(88), device: { ...DEVICE, platform: 'ios' }, features: ['device_v1'],
  });

  it('an assertion by the current key first; one the network no longer holds is replaced once', async () => {
    DeviceKey.enrolEvidence
      .mockResolvedValueOnce({ key: IOS_KEY, device: { platform: 'ios', key_id: 'k', assertion: 'as' }, token: { field: 'dc_token', value: 'dc' } })
      .mockResolvedValueOnce({ key: { ...IOS_KEY, handle: 'new' }, device: { platform: 'ios', key_id: 'n', attestation: 'at' }, token: { field: 'dc_token', value: 'dc' } });
    // The issuer refuses the assertion once; the backup answers every device block device_stale (not its stamp).
    let n = 0;
    answers = enrolAnswers((body, url) => {
      if (!url.startsWith(OWNERS[0])) return { success: false, reason: 'device_stale' };
      return n++ === 0 ? { success: false, reason: 'device_not_genuine' } : { success: true, pending: true, seq: body.seq };
    });
    const r = await link();
    expect(r).toMatchObject({ bound: true, reason: null });
    expect(DeviceKey.enrolEvidence.mock.calls.map((c) => c[0].reuse)).toEqual([true, false]);
    expect(DeviceKey.forgetKeys).toHaveBeenCalledTimes(1);
    expect(binds()[binds().length - 1].body.device).toMatchObject({ attestation: 'at' });
  });
});

describe('MN-R1-07: no claim is signed that cannot be reported', () => {
  const quote = (over) => ({
    success: true, needs_signature: true, claims_data: JSON.stringify({ claims: [{ epoch: 5 }] }), sign_message: 'x',
    last_claimed_epoch: 4, amount_nano: '970000000', claim_timestamp: 1790000000, stopped_at_epoch: null, ...over,
  });
  const manager = (q) => {
    const wm = new WalletManager();
    wm.loadWallet = async () => ({ qnetAddress: WALLET });
    wm._walletDilithiumKeys = async () => ({ secretKey: 'sk', publicKey: 'pk' });
    wm.getTrustedNodes = () => ['https://a', 'https://b', 'https://c'];
    wm._hedged = jest.fn(async (p) => (p === '/api/v1/rewards/claim'
      ? { ok: true, data: q, base: 'https://a' } : { ok: true, data: { first_unclaimed_epoch: 5 } }));
    wm._submitClaim = jest.fn(async () => ({ ok: true, data: { success: true, tx_hash: 'cd'.repeat(32) } }));
    return wm;
  };

  it('an uncapped quote below 1 QNC is refused as the smallest move before anything is signed or submitted', async () => {
    const { signWithDilithium } = require('../src/crypto/DilithiumCrypto');
    const wm = manager(quote());
    signWithDilithium.mockClear();
    await expect(wm.claimRewards('light', WALLET, 'pw', 1_020_000_000, NODE)).rejects.toMatchObject({ code: 'MIN_CLAIM' });
    // Only the ownership proof of the quote request was signed; no claim message, and nothing submitted.
    expect(signWithDilithium.mock.calls.every((c) => !String(c[0]).includes('qnet_claim_v1'))).toBe(true);
    expect(wm._submitClaim).not.toHaveBeenCalled();
    // The QNet Link sheet answers it as empty, which the protocol can carry.
    const { nodeLinkActions } = require('../src/services/NodeLinkActions');
    const a = nodeLinkActions({ walletManager: wm, credential: 'pw' });
    expect(await a.claim({ nodeId: NODE, qnet: WALLET, amountNano: 1_020_000_000 })).toEqual({ status: 'empty' });
  });

  it('a capped part below 1 QNC still moves: the whole balance can always be moved in several claims', async () => {
    const { sha3_256 } = require('js-sha3');
    const q = quote({ stopped_at_epoch: 7 });
    q.sign_message = `q1337|qnet_claim_v1:${WALLET}:${q.claim_timestamp}:${sha3_256(q.claims_data)}`;
    const wm = manager(q);
    const r = await wm.claimRewards('light', WALLET, 'pw', 1_020_000_000, NODE);
    expect(r).toMatchObject({ success: true, amountNano: '970000000', stoppedAtEpoch: 7 });
    expect(wm._submitClaim).toHaveBeenCalledTimes(1);
  });
});

describe('MN-R1-08: the counted row says what the node counts', () => {
  it('"n of the last m" in every language, and no "since registration" key left', () => {
    const translations = require('../src/i18n/translations').default;
    for (const [lang, t] of Object.entries(translations)) {
      expect([lang, typeof t.node_counted_last === 'string' && t.node_counted_last.includes('{n}') && t.node_counted_last.includes('{m}')]).toEqual([lang, true]);
      expect([lang, t.node_counted_since]).toEqual([lang, undefined]);
    }
    expect(translations.en.node_counted).toBe('Counted epochs:');
    expect(translations.en.node_counted_last).toBe('{n} of the last {m}');
  });
});

describe('a submit reaches every genesis name while connections fail', () => {
  it('a claim whose first two nodes cannot be reached goes through the third; an answer still settles at once', async () => {
    const wm = new WalletManager();
    const names = ['https://a', 'https://b', 'https://c', 'https://d', 'https://e'];
    wm.getTrustedNodes = (n = 2) => names.slice(0, n);
    const seen = [];
    const saved = global.fetch;
    global.fetch = jest.fn(async (url) => {
      seen.push(url.split('/api/')[0]);
      if (url.startsWith('https://a') || url.startsWith('https://b')) throw new TypeError('Network request failed');
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    try {
      const res = await wm._hedged('/api/v1/rewards/claim', { method: 'POST', timeoutMs: 2000, hedgeMs: 1000, body: { x: 1 } });
      expect(res).toMatchObject({ ok: true, base: 'https://c' });
      expect(seen).toEqual(['https://a', 'https://b', 'https://c']);
      // Every name down: the error is the connection's, after all five were tried.
      seen.length = 0;
      global.fetch.mockImplementation(async (url) => { seen.push(url.split('/api/')[0]); throw new TypeError('Network request failed'); });
      await expect(wm._hedged('/api/v1/rewards/claim', { method: 'POST', timeoutMs: 2000, hedgeMs: 1000, body: { x: 1 } }))
        .rejects.toThrow('Network request failed');
      expect(seen).toEqual(names);
    } finally {
      global.fetch = saved;
    }
  });
});
