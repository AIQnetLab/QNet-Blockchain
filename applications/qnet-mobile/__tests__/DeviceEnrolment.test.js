/**
 * The device layer in JS (src/services/DeviceEnrolment.js): every message this device's key signs is built byte for
 * byte as docs/protocols/light-node.vectors.json has it (enrolment, ping reply of both platforms, refresh, rotation,
 * release), goes back to the shard owner that issued its challenge, and the wakes refresh and rotate on the schedule
 * the signed status gives. The native key is faked (NodeDeviceKey has its own test against real P-256 keys).
 */
jest.mock('../src/services/NodeDeviceKey', () => ({
  currentKey: jest.fn(),
  sign: jest.fn(),
  enrolEvidence: jest.fn(),
  rotationEvidence: jest.fn(),
  vendorToken: jest.fn(),
  showPlayDialog: jest.fn(),
  commitKey: jest.fn(async () => {}),
  dropPendingKey: jest.fn(async () => {}),
  keepUnanswered: jest.fn(async () => {}),
  hasUnansweredKey: jest.fn(async () => false),
}));

const AsyncStorage = require('@react-native-async-storage/async-storage');
const DeviceKey = require('../src/services/NodeDeviceKey');
const E = require('../src/services/DeviceEnrolment');
const { lightShardOwnerUrls } = require('../src/config/nodes');
const V = require('../../../docs/protocols/light-node.vectors.json');

const W = V.wallets[0];
const NODE = W.nodeId;
const PP = V.pingKey.publicKey;
const SEQ = 1790000000;
const msg = (name, platform) => V.device.messages.find((m) => m.name === name && m.platform === platform);
const OWNERS = lightShardOwnerUrls(NODE);
const ANDROID_KEY = { platform: 'android', handle: 'qnet_dev_x', hwPub: V.device.keys.android.publicKey, attested: true };
const IOS_KEY = { platform: 'ios', handle: 'aWQ=', hwPub: V.device.keys.ios.publicKey, attested: true };

let calls;
let answers; // (url, body) => answer
const reply = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  calls = [];
  answers = () => ({ success: true });
  global.fetch = jest.fn((url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    return reply(answers(url, body));
  });
});
afterEach(() => jest.restoreAllMocks());

// A challenge from the given owner (the first ones do not answer) with the vector's nonce.
const challengeFrom = (owner, nonce) => (url) => {
  if (!url.includes('/device-challenge')) return { success: true };
  if (!url.startsWith(owner)) throw new Error('down');
  return { nonce, stamp: 'stamp-1', exp: 1790000600, issuer: 'genesis_node_002' };
};
const fetchThrowing = (fn) => {
  global.fetch = jest.fn((url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    try { return reply(fn(url, body)); } catch (e) { return Promise.reject(e); }
  });
};

describe('the challenge', () => {
  it('comes from the first shard owner that answers, with its purpose, and names where the message goes', async () => {
    fetchThrowing(challengeFrom(OWNERS[1], msg('enrol', 'android').nonce));
    const ch = await E.fetchChallenge(NODE, 'enrol');
    expect(ch).toEqual({ nonce: msg('enrol', 'android').nonce, stamp: 'stamp-1', exp: 1790000600, issuer: 'genesis_node_002', url: OWNERS[1] });
    expect(calls[0].url).toBe(`${OWNERS[0]}/api/v1/light-node/device-challenge?node_id=${NODE}&purpose=enrol`);
  });

  it('a malformed challenge is none, and no owner answering is NETWORK', async () => {
    answers = () => ({ nonce: 'short', stamp: 's', exp: 1, issuer: 'x' });
    await expect(E.fetchChallenge(NODE, 'refresh')).rejects.toMatchObject({ code: 'NETWORK' });
    expect(calls).toHaveLength(OWNERS.length);
  });
});

describe('the enrolment', () => {
  it('Android: the preimage of the vectors, the key made over it, and the block /bind takes with nonce and stamp', async () => {
    const m = msg('enrol', 'android');
    fetchThrowing(challengeFrom(OWNERS[0], m.nonce));
    DeviceKey.enrolEvidence.mockResolvedValue({
      key: ANDROID_KEY, device: { platform: 'android', chain: ['c1', 'c2'], report: V.device.report.text, report_sig: 'rs' },
      playNonce: m.playNonce, token: { field: 'pi_token', value: 'play-token' }, tokenError: null,
    });
    const device = { capable: true, platform: 'android', flags: m.flags, report: V.device.report.text };
    const out = await E.enrol({ nodeId: NODE, wallet: W.address, pingPublicKey: PP, seq: SEQ, device });
    expect(DeviceKey.enrolEvidence).toHaveBeenCalledWith({ preimage: m.preimage, flags: m.flags, report: V.device.report.text, reuse: false });
    expect(out).toEqual({
      key: ANDROID_KEY, url: OWNERS[0],
      fields: {
        device: { platform: 'android', chain: ['c1', 'c2'], report: V.device.report.text, report_sig: 'rs', nonce: m.nonce, stamp: 'stamp-1' },
        pi_token: 'play-token',
      },
      reused: false,
    });
    expect(Buffer.from(require('../src/crypto/NodePreimages').deviceChallengeHash(m.preimage)).toString('hex')).toBe(m.attestationChallenge);
  });

  it('iOS: the flags of the vectors in the block, and Google Play\'s dialog only on Android and only when interactive', async () => {
    const m = msg('enrol', 'ios');
    fetchThrowing(challengeFrom(OWNERS[0], m.nonce));
    DeviceKey.enrolEvidence.mockResolvedValue({
      key: IOS_KEY, device: { platform: 'ios', key_id: 'kid', attestation: 'att', flags: m.flags },
      playNonce: null, token: { field: 'dc_token', value: 'dc' }, tokenError: null,
    });
    const out = await E.enrol({ nodeId: NODE, wallet: W.address, pingPublicKey: PP, seq: SEQ, device: { capable: true, platform: 'ios', flags: m.flags, report: null }, reuse: true });
    expect(DeviceKey.enrolEvidence).toHaveBeenCalledWith({ preimage: m.preimage, flags: m.flags, report: null, reuse: true });
    expect(Object.keys(out.fields.device)).toEqual(['platform', 'key_id', 'attestation', 'flags', 'nonce', 'stamp']);
    expect(out.fields.dc_token).toBe('dc');

    DeviceKey.enrolEvidence.mockResolvedValue({ key: ANDROID_KEY, device: {}, playNonce: 'pn', token: null, tokenError: 'PLAY_FIXABLE' });
    DeviceKey.showPlayDialog.mockResolvedValue('ok');
    DeviceKey.vendorToken.mockResolvedValue({ field: 'pi_token', value: 'fixed' });
    const device = { capable: true, platform: 'android', flags: msg('enrol', 'android').flags, report: V.device.report.text };
    expect((await E.enrol({ nodeId: NODE, wallet: W.address, pingPublicKey: PP, seq: SEQ, device })).fields.pi_token).toBeUndefined();
    expect(DeviceKey.showPlayDialog).not.toHaveBeenCalled();
    expect((await E.enrol({ nodeId: NODE, wallet: W.address, pingPublicKey: PP, seq: SEQ, device, interactive: true })).fields.pi_token).toBe('fixed');
    expect(DeviceKey.showPlayDialog).toHaveBeenCalledWith('integrity');
    expect(DeviceKey.vendorToken).toHaveBeenCalledWith('pn');
  });

  it('the key the node took becomes current; one it did not take is dropped', async () => {
    await E.settle({ key: ANDROID_KEY }, true);
    expect(DeviceKey.commitKey).toHaveBeenCalledWith(ANDROID_KEY);
    await E.settle({ key: ANDROID_KEY }, false);
    expect(DeviceKey.dropPendingKey).toHaveBeenCalled();
    await E.settle(null, true);
    expect(DeviceKey.commitKey).toHaveBeenCalledTimes(1);
  });
});

const schedule = async (over = {}) => AsyncStorage.setItem(E.SCHEDULE_KEY, JSON.stringify({
  nodeId: NODE, features: ['device_v1', 'hwping_v2'], refresh: null, refreshedFor: null, rotationDue: null, ...over,
}));

describe('the ping reply', () => {
  const P = V.device.ping;

  it('Android: the device signature over the anchor and sha3(σ), with a millisecond hw_seq, as the vectors wire it', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Number(P.android.hwSeq));
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockImplementation(async (key, preimage) => {
      expect(preimage).toBe(P.android.preimage);
      return P.android.signatureDer;
    });
    expect(await E.hwPingSignature(NODE, P.challenge, P.sigma)).toBe(P.android.wire);
    // The next reply's hw_seq is above it even with the clock where it was.
    DeviceKey.sign.mockResolvedValue('AA');
    expect((await E.hwPingSignature(NODE, P.challenge, P.sigma)).endsWith(`.${Number(P.android.hwSeq) + 1}`)).toBe(true);
  });

  it('iOS: the assertion over the same anchor, hw_seq 0, as the vectors wire it', async () => {
    DeviceKey.currentKey.mockResolvedValue(IOS_KEY);
    DeviceKey.sign.mockImplementation(async (key, preimage) => {
      expect(preimage).toBe(P.ios.preimage);
      return P.ios.assertion;
    });
    expect(await E.hwPingSignature(NODE, P.challenge, P.sigma)).toBe(P.ios.wire);
  });

  it('a server stamp or no key signs nothing; replies carry the device signature only where two genesis take it', async () => {
    DeviceKey.currentKey.mockResolvedValue(null);
    await expect(E.hwPingSignature(NODE, P.challenge, P.sigma)).rejects.toMatchObject({ code: 'KEY_GONE' });
    await expect(E.hwPingSignature(NODE, 'ab'.repeat(40), P.sigma)).rejects.toMatchObject({ code: 'INVALID' });
    expect(await E.signsReplies(NODE)).toBe(false);
    await schedule();
    expect(await E.signsReplies(NODE)).toBe(false); // no key
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    expect(await E.signsReplies(NODE)).toBe(true);
    await schedule({ features: ['device_v1'] });
    expect(await E.signsReplies(NODE)).toBe(false);
    expect(await E.signsReplies('light_mobile_0000000000000000')).toBe(false);
  });
});

describe('what the status tells the wakes', () => {
  it('keeps the forms and, from the signed status, the refresh window and the rotation epoch', async () => {
    await E.noteStatus(NODE, { onChain: false, features: ['device_v1'] });
    expect(await AsyncStorage.getItem(E.SCHEDULE_KEY)).toBeNull();
    await E.noteStatus(NODE, { onChain: true, features: ['device_v1'], signed: { refreshWindow: { from: 10, to: 20 }, rotationDue: 170 } });
    expect(JSON.parse(await AsyncStorage.getItem(E.SCHEDULE_KEY))).toEqual({
      nodeId: NODE, features: ['device_v1'], refresh: { from: 10, to: 20 }, rotationDue: 170, refreshedFor: null,
      refreshTries: 0, refreshNextAt: null, refreshTokenError: null, deviceState: null, statusAt: expect.any(Number),
      // A rotation epoch the schedule did not have starts its tries over (MN-R2-02).
      rotateRefusals: 0, rotateNextAt: null, rotateWaitSetAt: null,
    });
    // A read without the signed fields keeps them.
    await E.noteStatus(NODE, { onChain: true, features: ['device_v1', 'hwping_v2'], signed: null });
    expect(JSON.parse(await AsyncStorage.getItem(E.SCHEDULE_KEY))).toMatchObject({ refresh: { from: 10, to: 20 }, rotationDue: 170 });
  });

  it('a lapsed lease\'s window, whose start moves with every read, keeps its back-off and token error; a new one starts over (M9)', async () => {
    const T = 1790000000;
    const lapsed = (at) => ({ onChain: true, features: ['device_v1'], signed: { refreshWindow: { from: at, to: at + 86400 }, rotationDue: 170 } });
    await E.noteStatus(NODE, lapsed(T));
    const s = JSON.parse(await AsyncStorage.getItem(E.SCHEDULE_KEY));
    await AsyncStorage.setItem(E.SCHEDULE_KEY, JSON.stringify({
      ...s, refreshTries: 3, refreshNextAt: (T + 7200) * 1000, refreshTokenError: 'PLAY_FIXABLE',
    }));
    // Every later read of the same lapsed lease: the window moved with the read, the back-off holds.
    for (const at of [T + 60, T + 3600, T + 80000]) {
      await E.noteStatus(NODE, lapsed(at));
      expect(JSON.parse(await AsyncStorage.getItem(E.SCHEDULE_KEY))).toMatchObject({
        refresh: { from: at, to: at + 86400 }, refreshTries: 3, refreshNextAt: (T + 7200) * 1000, refreshTokenError: 'PLAY_FIXABLE',
      });
    }
    // A window past the one kept (a new lease, or a day later) is refreshed from the first try.
    await E.noteStatus(NODE, lapsed(T + 80000 + 86401));
    expect(JSON.parse(await AsyncStorage.getItem(E.SCHEDULE_KEY))).toMatchObject({
      refreshTries: 0, refreshNextAt: null, refreshTokenError: null, refreshedFor: null,
    });
  });
});

describe('the lease refresh', () => {
  it('Android: once per window, the vector preimage signed, a token bound to it, posted to the issuer', async () => {
    const m = msg('refresh', 'android');
    await schedule({ refresh: { from: 1790000000, to: 1790090000 } });
    jest.spyOn(Date, 'now').mockReturnValue(1790000100 * 1000);
    fetchThrowing((url, body) => (url.includes('/device-challenge') ? challengeFrom(OWNERS[2], m.nonce)(url) : { success: true }));
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockImplementation(async (key, preimage) => {
      expect(preimage).toBe(m.preimage);
      return m.device.signatureDer;
    });
    DeviceKey.vendorToken.mockImplementation(async (nonce) => {
      expect(nonce).toBe(m.playNonce);
      return { field: 'pi_token', value: 'play' };
    });
    expect(await E.refreshIfDue(NODE, { now: Date.now() })).toBe(true);
    const post = calls.find((c) => c.url.endsWith('/device-refresh'));
    expect(post.url).toBe(`${OWNERS[2]}/api/v1/light-node/device-refresh`);
    expect(post.body).toEqual({ node_id: NODE, nonce: m.nonce, stamp: 'stamp-1', sig: m.device.signatureDer, token: 'play' });
    calls.length = 0;
    expect(await E.refreshIfDue(NODE, { now: Date.now() })).toBe(false); // this window is done
    expect(calls).toEqual([]);
  });

  it('not before or after the window, not without the form or a key', async () => {
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    await schedule({ refresh: { from: 100, to: 200 } });
    expect(await E.refreshIfDue(NODE, { now: 50 * 1000 })).toBe(false);
    expect(await E.refreshIfDue(NODE, { now: 250 * 1000 })).toBe(false);
    await schedule({ refresh: { from: 100, to: 200 }, features: [] });
    expect(await E.refreshIfDue(NODE, { now: 150 * 1000 })).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('the key rotation', () => {
  it('Android: once due, the vector preimage with the old key\'s point, the old key\'s signature, the new key committed', async () => {
    const m = msg('rotate', 'android');
    await schedule({ rotationDue: 160 });
    fetchThrowing((url) => (url.includes('/device-challenge') ? challengeFrom(OWNERS[0], m.nonce)(url) : { success: true }));
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    const NEW = { ...ANDROID_KEY, handle: 'qnet_dev_new', hwPub: V.device.keys.androidRotated.publicKey };
    DeviceKey.rotationEvidence.mockImplementation(async ({ preimage, flags, report }) => {
      expect([preimage, flags, report]).toEqual([m.preimage, null, V.device.report.text]);
      return { key: NEW, device: { platform: 'android', chain: ['n1'], report, report_sig: m.newKeyReportSignatureDer }, oldSig: m.oldKey.signatureDer, token: { field: 'pi_token', value: 'pt' } };
    });
    const device = { capable: true, platform: 'android', flags: msg('enrol', 'android').flags, report: V.device.report.text };
    expect(await E.rotateIfDue(NODE, { epoch: 159, seq: SEQ, pingPublicKey: PP, device })).toBe(false);
    expect(await E.rotateIfDue(NODE, { epoch: 160, seq: SEQ, pingPublicKey: PP, device })).toBe(true);
    const post = calls.find((c) => c.url.endsWith('/device-rotate'));
    expect(post.url.startsWith(OWNERS[0])).toBe(true);
    expect(post.body).toEqual({
      node_id: NODE, seq: SEQ, old_key: V.device.keys.android.publicKeySha3,
      device: { platform: 'android', chain: ['n1'], report: V.device.report.text, report_sig: m.newKeyReportSignatureDer, nonce: m.nonce, stamp: 'stamp-1' },
      old_sig: m.oldKey.signatureDer, pi_token: 'pt',
    });
    expect(DeviceKey.commitKey).toHaveBeenCalledWith(NEW);
    expect(JSON.parse(await AsyncStorage.getItem(E.SCHEDULE_KEY)).rotationDue).toBeNull();
  });

  it('a refused rotation drops the new key and waits six hours before the next try', async () => {
    const m = msg('rotate', 'ios');
    await schedule({ rotationDue: 160 });
    fetchThrowing((url) => (url.includes('/device-challenge') ? challengeFrom(OWNERS[0], m.nonce)(url) : { success: false, reason: 'device_stale' }));
    DeviceKey.currentKey.mockResolvedValue(IOS_KEY);
    DeviceKey.rotationEvidence.mockResolvedValue({ key: IOS_KEY, device: { platform: 'ios' }, oldSig: 'o', token: null });
    const device = { capable: true, platform: 'ios', flags: 'mac=0,vision=0,idiom=pad', report: null };
    const now = 1790000000 * 1000;
    expect(await E.rotateIfDue(NODE, { epoch: 161, seq: SEQ, pingPublicKey: PP, device, now })).toBe(false);
    expect(DeviceKey.rotationEvidence.mock.calls[0][0]).toEqual({
      preimage: m.preimage, flags: 'mac=0,vision=0,idiom=pad', report: null, deadline: null, minLeftMs: E.ATTEST_MS + E.MIN_CALL_MS,
    });
    expect(DeviceKey.dropPendingKey).toHaveBeenCalled();
    calls.length = 0;
    expect(await E.rotateIfDue(NODE, { epoch: 161, seq: SEQ, pingPublicKey: PP, device, now: now + 3600 * 1000 })).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a rotation that got no answer keeps its new key for the status to settle, and no rotation starts meanwhile', async () => {
    const m = msg('rotate', 'android');
    await schedule({ rotationDue: 160 });
    fetchThrowing((url) => {
      if (url.includes('/device-challenge')) return challengeFrom(OWNERS[0], m.nonce)(url);
      throw new Error('timeout');
    });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    const NEW = { ...ANDROID_KEY, handle: 'qnet_dev_new', hwPub: V.device.keys.androidRotated.publicKey };
    DeviceKey.rotationEvidence.mockResolvedValue({ key: NEW, device: { platform: 'android' }, oldSig: 'o', token: null });
    const device = { capable: true, platform: 'android', flags: 'r=x', report: V.device.report.text };
    const now = 1790000000 * 1000;
    expect(await E.rotateIfDue(NODE, { epoch: 161, seq: SEQ, pingPublicKey: PP, device, now })).toBe(false);
    expect(DeviceKey.keepUnanswered).toHaveBeenCalledWith(NEW);
    expect(DeviceKey.dropPendingKey).not.toHaveBeenCalled();
    expect(DeviceKey.commitKey).not.toHaveBeenCalled();
    DeviceKey.hasUnansweredKey.mockResolvedValue(true);
    calls.length = 0;
    expect(await E.rotateIfDue(NODE, { epoch: 162, seq: SEQ, pingPublicKey: PP, device, now: now + 7 * 3600 * 1000 })).toBe(false);
    expect(calls).toEqual([]);
    DeviceKey.hasUnansweredKey.mockResolvedValue(false);
  });
});

describe('the release', () => {
  it('iOS: the vector preimage for the binding\'s sequence, for the issuer of its challenge', async () => {
    const m = msg('release', 'ios');
    await schedule();
    fetchThrowing(challengeFrom(OWNERS[1], m.nonce));
    DeviceKey.currentKey.mockResolvedValue(IOS_KEY);
    DeviceKey.sign.mockImplementation(async (key, preimage) => {
      expect(preimage).toBe(m.preimage);
      return m.device.assertion;
    });
    expect(await E.releaseBlock(NODE, SEQ)).toEqual({ url: OWNERS[1], device_release: { nonce: m.nonce, stamp: 'stamp-1', sig: m.device.assertion } });
  });

  it('nothing to release without the form or a key', async () => {
    DeviceKey.currentKey.mockResolvedValue(IOS_KEY);
    expect(await E.releaseBlock(NODE, SEQ)).toBeNull();
    await schedule({ features: [] });
    expect(await E.releaseBlock(NODE, SEQ)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('a wake\'s upkeep', () => {
  it('refreshes in its window and rotates when due, and asks the device only for a rotation', async () => {
    const now = Date.now();
    await schedule({ refresh: { from: Math.floor(now / 1000) - 10, to: Math.floor(now / 1000) + 1000 }, rotationDue: 200 });
    DeviceKey.currentKey.mockResolvedValue(ANDROID_KEY);
    DeviceKey.sign.mockResolvedValue('sig');
    DeviceKey.vendorToken.mockResolvedValue({ field: 'pi_token', value: 't' });
    DeviceKey.rotationEvidence.mockResolvedValue({ key: ANDROID_KEY, device: {}, oldSig: 'o', token: null });
    fetchThrowing((url) => (url.includes('/device-challenge') ? challengeFrom(OWNERS[0], msg('refresh', 'android').nonce)(url) : { success: true }));
    const device = jest.fn(async () => ({ capable: true, platform: 'android', flags: 'r=x', report: V.device.report.text }));
    await E.maintain(NODE, { deadline: now + 25000, epoch: 199, binding: { seq: SEQ, pingPublicKey: PP }, device });
    expect(calls.some((c) => c.url.endsWith('/device-refresh'))).toBe(true);
    expect(device).not.toHaveBeenCalled();
    await E.maintain(NODE, { deadline: now + 25000, epoch: 200, binding: { seq: SEQ, pingPublicKey: PP }, device });
    expect(device).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.url.endsWith('/device-rotate'))).toBe(true);
    // A wake with no time left does nothing more.
    calls.length = 0;
    await E.maintain(NODE, { deadline: Date.now() + 1000, epoch: 300, binding: { seq: SEQ, pingPublicKey: PP }, device });
    expect(calls).toEqual([]);
  });
});
