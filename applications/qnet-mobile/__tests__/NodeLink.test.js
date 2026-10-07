/**
 * The QNet Link `link` sheet's work (qnet-link-v1 section 14.8; unified plan APP-4, DEV-6): after Confirm the wallet key
 * signs its consent and the binding with T, byte for byte as docs/protocols/light-node.vectors.json has them; the binding
 * goes with the consent (and, once served, this device's enrolment) to the shard owner and its backup; the device keeps
 * it and a pending-link record that re-sends it while the chain lists the node unbound; the answer's consent passes the
 * site's checks. The app signs no owner bind but its own Solana key's, for a burn made from the wallet's own Solana
 * address (__tests__/OwnBurnConsent.test.js).
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signWithDilithium: jest.fn().mockResolvedValue('sig'),
  signDetached: jest.fn(),
  generateRawDilithiumKeypair: jest.fn(),
}));
jest.mock('../src/services/NodeDeviceKey', () => ({
  checkDevice: jest.fn(),
  currentKey: jest.fn(async () => null),
  isThisDevice: jest.fn(async () => null),
  enrolEvidence: jest.fn(),
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

const fs = require('fs');
const path = require('path');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const messaging = require('@react-native-firebase/messaging').default;
const Dilithium = require('../src/crypto/DilithiumCrypto');
const DeviceKey = require('../src/services/NodeDeviceKey');
const { WalletManager } = require('../src/components/WalletManager');
const Push = require('../src/services/PushService');
const { LINK_PENDING_KEY, readLinkPending } = require('../src/services/LightNode');
const { buildPlaintext, plaintextProblem } = require('../src/services/QNetLink');
const { lightShardOwnerUrls } = require('../src/config/nodes');
const V = require('../../../docs/protocols/light-node.vectors.json');

const W = V.wallets[0];
const N = V.node.find((n) => n.wallet === W.name);
const M = (name) => N.messages.find((m) => m.name === name);
const T = Number(M('consent').inputs.ts);
const PUSH = M('attachV2').inputs.pushTarget;
const OWNERS = lightShardOwnerUrls(W.nodeId);
const b64u = (hex) => Buffer.from(hex, 'hex').toString('base64url');
const CAPABLE = { capable: true, platform: 'ios', flags: 'mac=0,vision=0,idiom=phone', report: null };

// Every wallet-key preimage of the vectors, signed as the vectors sign it.
const SIGNED = new Map(N.messages.filter((m) => m.signer === 'wallet').map((m) => [m.preimage, m.signature]));
let signed;
let calls;
let answers;
const reply = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

function walletManager() {
  const wm = new WalletManager();
  wm.loadWallet = async () => ({
    qnetAddress: W.address,
    qnetKeypair: { privateKey: new Uint8Array(32).fill(7), publicKey: Uint8Array.from(Buffer.from(W.publicKey, 'hex')) },
  });
  return wm;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(T * 1000);
  signed = [];
  Dilithium.signDetached.mockImplementation(async (preimage) => {
    signed.push(preimage);
    if (!SIGNED.has(preimage)) throw new Error(`unexpected preimage ${preimage.slice(0, 60)}`);
    return SIGNED.get(preimage);
  });
  Dilithium.generateRawDilithiumKeypair.mockResolvedValue({ publicKey: V.pingKey.publicKey, secretKey: 'ping-sk' });
  messaging().getToken.mockResolvedValue(PUSH);
  calls = [];
  answers = (url, body) => (url.endsWith('/light-node/bind')
    ? { success: true, bound: false, pending: true, node_id: W.nodeId, seq: body.seq }
    : { success: true });
  global.fetch = jest.fn((url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const a = answers(url, body);
    return a instanceof Error ? Promise.reject(a) : reply(a);
  });
});
afterEach(() => jest.restoreAllMocks());

const link = (over = {}) => Push.linkWithConsent({
  signer: walletManager(), credential: 'secret', nodeId: W.nodeId, burnTx: N.burnTx, device: CAPABLE,
  features: ['bind_v2', 'pending_bind', 'consent_24h'], ...over,
});

describe('the consent', () => {
  it('is the vectors\' consent for T = now, and the answer that carries it passes the site\'s checks', async () => {
    const r = await link();
    expect(signed[0]).toBe(M('consent').preimage);
    expect(r).toEqual({ consent: { ts: String(T), pk: b64u(W.publicKey), sig: b64u(M('consent').signature) }, bound: true, reason: null });
    const session = { intent: 'link', request: { burnTx: N.burnTx, walletHash: W.walletHash, check: false } };
    const text = buildPlaintext(session, { status: 'ok', qnet: W.address, nodeId: W.nodeId, consent: r.consent, bound: r.bound },
      { now: T + 60 });
    expect(plaintextProblem(text, session, { now: T + 60 })).toBeNull();
    expect(JSON.parse(text).consent).toEqual(r.consent);
  });

  it('a consent alone builds no owner bind; the one signer of a bind is the wallet\'s own Solana key, by the shared builder', async () => {
    await link();
    expect(signed.some((p) => p.startsWith('qnet_onchain_reg:'))).toBe(false);
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const holders = walk(path.join(__dirname, '../src'))
      .filter((f) => /ownerBindPreimage|qnet_onchain_reg:/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/'));
    // The shared builders, the off-chain signer, which refuses to sign anything that starts like one, and the wallet's
    // signer of its own Solana address's bind (WalletManager.signOwnBurnBind), which builds it with the shared builder.
    expect(holders.sort()).toEqual(['src/components/WalletManager.js', 'src/crypto/NodePreimages.js', 'src/crypto/OffchainMessage.js']);
    expect(fs.readFileSync(path.join(__dirname, '../src/crypto/OffchainMessage.js'), 'utf8')).not.toMatch(/ownerBindPreimage/);
    const wm = fs.readFileSync(path.join(__dirname, '../src/components/WalletManager.js'), 'utf8');
    expect(wm).not.toMatch(/qnet_onchain_reg:/);
    expect(wm.match(/ownerBindPreimage\(/g)).toHaveLength(1);
  });
});

describe('the binding with the consent', () => {
  it('signs the delegation and attach of the vectors with seq = ts = T and posts them to the owner and its backup', async () => {
    await link();
    expect(signed).toEqual([M('consent').preimage, M('delegationV2').preimage, M('attachV2').preimage]);
    const binds = calls.filter((c) => c.url.endsWith('/light-node/bind'));
    expect(binds.map((c) => c.url)).toEqual(OWNERS.slice(0, 2).map((u) => `${u}/api/v1/light-node/bind`));
    expect(binds[0].body).toEqual({
      node_id: W.nodeId, wallet_address: W.address, identity_pubkey: W.publicKey, ping_pubkey: V.pingKey.publicKey,
      delegation_cert: M('delegationV2').signature, seq: T, ts: T, attach_sig: M('attachV2').signature, push_type: 'fcm',
      device_token: PUSH,
      consent: { burn_tx: N.burnTx, registration_proof: N.proof, timestamp: T, consent_sig: M('consent').signature },
      // The unsigned platform hint the public status shows (contract 2, 04.10); Jest runs as iOS.
      platform: 'ios',
    });
    expect(binds[1].body).toEqual(binds[0].body);
  });

  it('keeps the binding on the device and the pending-link record for the re-send', async () => {
    await link();
    expect(Keychain.setGenericPassword).toHaveBeenCalledWith('ping', 'ping-sk', expect.objectContaining({ service: `qnet_ping_sk_${W.nodeId}` }));
    expect(JSON.parse(await AsyncStorage.getItem('qnet_light_node_info'))).toMatchObject({ nodeId: W.nodeId, seq: T, hw: false });
    expect(await AsyncStorage.getItem(`qnet_ping_cert_${W.nodeId}`)).toBe(`v2.${T}.${M('delegationV2').signature}`);
    const rec = JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY));
    expect(rec).toMatchObject({ nodeId: W.nodeId, wallet: W.address, T, bound: true });
    expect(rec.bindBlob).toEqual(calls.find((c) => c.url.endsWith('/light-node/bind')).body);
    expect(await readLinkPending(W.nodeId, (T + 86400 + 599) * 1000)).toMatchObject({ expired: false });
    expect(await readLinkPending(W.nodeId, (T + 86400 + 601) * 1000)).toMatchObject({ expired: true });
  });

  it('an owner that did not keep it answers bound: false, and the record still re-sends it', async () => {
    answers = (url) => (url.endsWith('/light-node/bind') ? { success: false, reason: 'rate_limited' } : { success: true });
    expect((await link()).bound).toBe(false);
    expect(JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY))).toMatchObject({ bound: false });
  });

  it('with the device layer served, the binding carries this device\'s enrolment and the key is committed', async () => {
    answers = (url, body) => {
      if (url.includes('/device-challenge')) return { nonce: 'n'.repeat(43), stamp: 'st', exp: T + 600, issuer: 'genesis_node_003' };
      return url.endsWith('/light-node/bind') ? { success: true, bound: false, pending: true, seq: body.seq } : { success: true };
    };
    const KEY = { platform: 'ios', handle: 'k', hwPub: V.device.keys.ios.publicKey, attested: true };
    DeviceKey.enrolEvidence.mockResolvedValue({
      key: KEY, device: { platform: 'ios', key_id: 'kid', attestation: 'att', flags: CAPABLE.flags }, playNonce: null,
      token: { field: 'dc_token', value: 'dc' }, tokenError: null,
    });
    const r = await link({ features: ['bind_v2', 'pending_bind', 'device_v1'] });
    expect(r.bound).toBe(true);
    const { preimage } = DeviceKey.enrolEvidence.mock.calls[0][0];
    expect(preimage).toBe(`qnet_dev_enrol:v1|1337|${W.nodeId}|${W.address}|${V.pingKey.publicKeySha3}|${T}|${'n'.repeat(43)}|${CAPABLE.flags}`);
    const bind = calls.find((c) => c.url.endsWith('/light-node/bind'));
    expect(bind.url.startsWith(OWNERS[0])).toBe(true); // the challenge's issuer first
    expect(bind.body.device).toEqual({ platform: 'ios', key_id: 'kid', attestation: 'att', flags: CAPABLE.flags, nonce: 'n'.repeat(43), stamp: 'st' });
    expect(bind.body.dc_token).toBe('dc');
    expect(DeviceKey.commitKey).toHaveBeenCalledWith(KEY);
    expect(JSON.parse(await AsyncStorage.getItem('qnet_light_node_info')).hw).toBe(true);
    // The record's copy leaves the device block and its token out: a re-send makes fresh ones.
    const rec = JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY));
    expect(rec.bindBlob).not.toHaveProperty('device');
    expect(rec.bindBlob).not.toHaveProperty('dc_token');
  });

  it('a binding the owners refuse for good keeps nothing here and gives the token back; the consent still answers', async () => {
    answers = (url) => (url.endsWith('/light-node/bind') ? { success: false, reason: 'device_not_genuine' } : { success: true });
    const r = await link();
    expect(r).toMatchObject({ bound: false, reason: 'device_not_genuine', consent: { ts: String(T) } });
    expect(Keychain.setGenericPassword).not.toHaveBeenCalledWith('ping', expect.anything(), expect.anything());
    expect(await AsyncStorage.getItem('qnet_light_node_info')).toBeNull();
    expect(await AsyncStorage.getItem(LINK_PENDING_KEY)).toBeNull();
    expect(messaging().deleteToken).toHaveBeenCalled();
  });

  it('a device check that could not be made now posts nothing; the binding waits for the re-send', async () => {
    answers = (url) => (url.includes('/device-challenge') ? new Error('offline') : { success: true });
    const r = await link({ features: ['bind_v2', 'pending_bind', 'device_v1'] });
    expect(r).toMatchObject({ bound: false, reason: null });
    expect(calls.some((c) => c.url.endsWith('/light-node/bind'))).toBe(false);
    expect(DeviceKey.enrolEvidence).not.toHaveBeenCalled();
    expect(JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY))).toMatchObject({ nodeId: W.nodeId, bound: false });
    expect(JSON.parse(await AsyncStorage.getItem('qnet_light_node_info'))).toMatchObject({ nodeId: W.nodeId, hw: false });
  });

  it('a signature that cannot be made gives the token back', async () => {
    const wm = walletManager();
    wm.loadWallet = async () => { throw new Error('locked'); };
    await expect(Push.linkWithConsent({
      signer: wm, credential: 'x', nodeId: W.nodeId, burnTx: N.burnTx, device: CAPABLE, features: ['bind_v2', 'pending_bind'],
    })).rejects.toThrow('locked');
    expect(messaging().getToken).toHaveBeenCalled();
    expect(messaging().deleteToken).toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('a device that cannot run a node gives the consent only: no ping key, no token, nothing posted', async () => {
    const r = await link({ device: { capable: false, reason: 'device_desktop' } });
    expect(r.bound).toBe(false);
    expect(signed).toEqual([M('consent').preimage]);
    expect(messaging().getToken).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(await AsyncStorage.getItem(LINK_PENDING_KEY)).toBeNull();
    expect(await AsyncStorage.getItem('qnet_light_node_info')).toBeNull();
  });
});

describe('the late delivery (U3)', () => {
  const unbound = { onChain: true, deviceBound: false, features: ['bind_v2'] };
  const binds = () => calls.filter((c) => c.url.endsWith('/light-node/bind'));

  it('sends the same binding again while the chain lists the node unbound, then forgets the record', async () => {
    await link();
    const blob = JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY)).bindBlob;
    calls = [];
    answers = (url, body) => (url.endsWith('/light-node/bind') ? { success: true, bound: true, seq: body.seq } : { success: true });
    expect(await Push.resendPendingBinding(W.nodeId, unbound)).toBe(true);
    expect(calls).toEqual([{ url: `${OWNERS[0]}/api/v1/light-node/bind`, body: blob }]);
    expect(await AsyncStorage.getItem(LINK_PENDING_KEY)).toBeNull();
  });

  it('waits while the node is not on the chain or the network is away; stops once a device is bound or the time is over', async () => {
    await link();
    await new Promise((r) => setImmediate(r)); // the self-attestation the binding starts runs out first
    calls = [];
    expect(await Push.resendPendingBinding(W.nodeId, { onChain: false, deviceBound: null, features: [] })).toBe(false);
    expect(calls).toEqual([]);
    answers = () => new Error('offline');
    expect(await Push.resendPendingBinding(W.nodeId, unbound)).toBe(false);
    expect(await AsyncStorage.getItem(LINK_PENDING_KEY)).not.toBeNull();
    expect(await Push.resendPendingBinding(W.nodeId, { ...unbound, deviceBound: true })).toBe(false);
    expect(await AsyncStorage.getItem(LINK_PENDING_KEY)).toBeNull();

    await link();
    await new Promise((r) => setImmediate(r));
    Date.now.mockReturnValue((T + 86400 + 601) * 1000);
    calls = [];
    expect(await Push.resendPendingBinding(W.nodeId, unbound)).toBe(false);
    expect(calls).toEqual([]);
    expect(await AsyncStorage.getItem(LINK_PENDING_KEY)).toBeNull();
  });

  it('a try that failed for now comes again 1, 2, 4, then every 2.5 to 5 minutes, never 10 minutes to 4 hours, and as late as the node asks', async () => {
    await link();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    answers = (url) => (url.endsWith('/light-node/bind') ? new Error('offline') : { success: true });
    let now = T * 1000;
    const waits = [];
    for (let i = 1; i <= 5; i++) {
      calls = [];
      expect(await Push.resendPendingBinding(W.nodeId, unbound)).toBe(false);
      expect(binds().length).toBeGreaterThan(0);
      const rec = JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY));
      expect(rec.tries).toBe(i);
      waits.push(rec.nextTryAt - now);
      // The Node tab's 30 s refresh and the wakes send nothing before then.
      calls = [];
      Date.now.mockReturnValue(rec.nextTryAt - 1000);
      expect(await Push.resendPendingBinding(W.nodeId, unbound)).toBe(false);
      expect(binds()).toEqual([]);
      now = rec.nextTryAt;
      Date.now.mockReturnValue(now);
    }
    expect(waits).toEqual([60000, 120000, 240000, 300000, 300000]);
    // The first three waits up to a fifth sooner, later ones up to half, drawn per device and try.
    Math.random.mockReturnValue(1);
    answers = (url) => (url.endsWith('/light-node/bind') ? { success: false, reason: 'rate_limited' } : { success: true });
    expect(await Push.resendPendingBinding(W.nodeId, unbound)).toBe(false);
    let rec = JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY));
    expect(rec.nextTryAt - now).toBe(150000);
    now = rec.nextTryAt;
    Date.now.mockReturnValue(now);
    answers = (url) => (url.endsWith('/light-node/bind') ? { success: false, reason: 'rate_limited', retry_after_seconds: 7200 } : { success: true });
    expect(await Push.resendPendingBinding(W.nodeId, unbound)).toBe(false);
    rec = JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY));
    expect(rec).toMatchObject({ tries: 7, nextTryAt: now + 7200000 });
    expect(rec.keyTries).toBeUndefined(); // no device key was made for any of them
    // Once the wait is over, the same binding goes again.
    answers = (url, body) => (url.endsWith('/light-node/bind') ? { success: true, bound: true, seq: body.seq } : { success: true });
    Date.now.mockReturnValue(now + 7200000);
    expect(await Push.resendPendingBinding(W.nodeId, unbound)).toBe(true);
    expect(await AsyncStorage.getItem(LINK_PENDING_KEY)).toBeNull();
  });

  it('with the device layer served, a try that made no new device key comes again in minutes; one that did waits hours', async () => {
    await link();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    DeviceKey.checkDevice.mockResolvedValue(CAPABLE);
    const served = { ...unbound, features: ['bind_v2', 'device_v1'] };
    const challenge = { nonce: 'A'.repeat(43), stamp: 'st', exp: 1, issuer: 'genesis_node_004' };
    const IOS_KEY = { platform: 'ios', handle: 'kid', hwPub: V.device.keys.ios.publicKey, attested: true };
    // No owner gave a challenge: nothing was attested.
    answers = (url) => (url.includes('/device-challenge') ? new Error('offline') : { success: true });
    expect(await Push.resendPendingBinding(W.nodeId, served)).toBe(false);
    let rec = JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY));
    expect(rec).toMatchObject({ tries: 1, nextTryAt: T * 1000 + 60000 });
    // This install's current key proved itself (an assertion: no new key), and the POST got no answer.
    Date.now.mockReturnValue(rec.nextTryAt);
    DeviceKey.enrolEvidence.mockResolvedValue({ key: IOS_KEY, device: { assertion: 'as' }, token: { field: 'dc_token', value: 'd' } });
    answers = (url) => (url.includes('/device-challenge') ? challenge : (url.endsWith('/light-node/bind') ? new Error('timeout') : { success: true }));
    expect(await Push.resendPendingBinding(W.nodeId, served)).toBe(false);
    rec = JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY));
    expect(rec).toMatchObject({ tries: 2, nextTryAt: T * 1000 + 60000 + 120000 });
    // A new key was attested for the try: the platforms count those, so hours, as before.
    Date.now.mockReturnValue(rec.nextTryAt);
    DeviceKey.enrolEvidence.mockResolvedValue({ key: IOS_KEY, device: { attestation: 'at' }, token: { field: 'dc_token', value: 'd' } });
    expect(await Push.resendPendingBinding(W.nodeId, served)).toBe(false);
    const at3 = rec.nextTryAt;
    rec = JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY));
    expect(rec).toMatchObject({ tries: 3, keyTries: 1, nextTryAt: at3 + 4 * 3600 * 1000 });
  });

  it('with the device layer served, a device check that fails for now posts nothing and waits', async () => {
    await link();
    DeviceKey.checkDevice.mockResolvedValue(CAPABLE);
    answers = (url) => (url.includes('/device-challenge') ? new Error('offline') : { success: true });
    calls = [];
    expect(await Push.resendPendingBinding(W.nodeId, { ...unbound, features: ['bind_v2', 'device_v1'] })).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/light-node/bind'))).toBe(false);
    expect(JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY))).toMatchObject({ tries: 1 });
  });

  it('a binding the owners refuse for good is not sent again', async () => {
    await link();
    answers = () => ({ success: false, reason: 'stale_seq' });
    expect(await Push.resendPendingBinding(W.nodeId, unbound)).toBe(false);
    expect(await AsyncStorage.getItem(LINK_PENDING_KEY)).toBeNull();
  });

  it('the end of the binding here (the confirmed unlink, a deleted wallet) ends the pending binding too', async () => {
    await link();
    await Push.stopLightNode();
    expect(await AsyncStorage.getItem(LINK_PENDING_KEY)).toBeNull();
  });
});

describe('the answers and the Stop of a node that holds this device\'s key', () => {
  const P = V.device.ping;
  const KEY = { platform: 'android', handle: 'qnet_dev_x', hwPub: V.device.keys.android.publicKey, attested: true };
  const SEQ = 1790000000;
  const linkedHere = async ({ hw = true, features = ['device_v1', 'hwping_v2'] } = {}) => {
    Keychain.getGenericPassword.mockResolvedValue({ password: 'ping-sk' });
    await AsyncStorage.multiSet([
      ['qnet_light_node_info', JSON.stringify({ nodeId: W.nodeId, walletAddress: W.address, pushType: 'fcm', seq: SEQ, hw })],
      ['qnet_ping_node_id', W.nodeId],
      [`qnet_ping_dilithium_pk_${W.nodeId}`, V.pingKey.publicKey],
      ['qnet_node_device_schedule', JSON.stringify({ nodeId: W.nodeId, features })],
    ]);
  };
  beforeEach(() => {
    Dilithium.signDetached.mockImplementation(async (preimage) => {
      if (preimage === P.challenge) return P.sigma;
      if (preimage.startsWith('q1337|light_unbind:')) return 'ub'.repeat(8);
      throw new Error(`unexpected preimage ${preimage.slice(0, 40)}`);
    });
    DeviceKey.currentKey.mockResolvedValue(KEY);
    DeviceKey.sign.mockImplementation(async (key, preimage) => (preimage === P.android.preimage ? P.android.signatureDer : 'AAAA'));
  });
  afterEach(() => Keychain.getGenericPassword.mockResolvedValue(false));

  it('an epoch push is answered with both signatures over its anchor, as the vectors wire them', async () => {
    await linkedHere();
    Date.now.mockReturnValue(Number(P.android.hwSeq));
    expect(await Push.handlePushMessage({ action: 'epoch', anchor: `${P.height}:${P.hash}` })).toBe(true);
    const post = calls.find((c) => c.url.endsWith('/api/v1/light-node/ping-response'));
    expect(post.url.startsWith(OWNERS[0])).toBe(true);
    expect(post.body).toMatchObject({ node_id: W.nodeId, challenge: P.challenge, signature: P.android.wire });
  });

  it('without the node taking the key, or two genesis serving the form, or a key that signs, the reply goes without it', async () => {
    for (const setup of [{ hw: false }, { features: ['device_v1'] }]) {
      await AsyncStorage.clear();
      await linkedHere(setup);
      calls = [];
      await Push.handlePushMessage({ action: 'wake', anchor: `${P.height}:${P.hash}` });
      expect(calls.find((c) => c.url.endsWith('/ping-response')).body.signature).toBe('ping_dilithium:sig');
    }
    await AsyncStorage.clear();
    await linkedHere();
    DeviceKey.sign.mockRejectedValue(Object.assign(new Error('gone'), { code: 'KEY_GONE' }));
    calls = [];
    await Push.handlePushMessage({ action: 'wake', anchor: `${P.height}:${P.hash}` });
    expect(calls.find((c) => c.url.endsWith('/ping-response')).body.signature).toBe('ping_dilithium:sig');
  });

  it('a wake after a rotation that got no answer reads the signed status and settles the key by its tag', async () => {
    await linkedHere();
    DeviceKey.hasUnansweredKey.mockResolvedValueOnce(true);
    Dilithium.signDetached.mockImplementation(async (preimage) => {
      if (preimage === P.challenge) return P.sigma;
      if (preimage.includes('light_status:')) return 'st'.repeat(8);
      throw new Error(`unexpected preimage ${preimage.slice(0, 40)}`);
    });
    // Only the signed form, by the ping key, names the device (ND-7).
    answers = (url, body) => (url.includes('/light-node/status')
      ? { onchain_registered: true, device_bound: true, features: ['status_signed'], ...(body ? { device_tag_h: 'ab12ab12ab12ab12' } : {}) }
      : { success: true });
    await Push.handlePushMessage({ action: 'epoch', anchor: `${P.height}:${P.hash}` });
    expect(calls.filter((c) => c.url.endsWith('/light-node/status')).map((c) => c.body.signer)).toEqual(['ping', 'ping', 'ping']);
    // Every owner's tag goes to the settle, which needs two of them to drop a key (MN-R1-01).
    expect(DeviceKey.settleByTag).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{32}$/), ['ab12ab12ab12ab12', 'ab12ab12ab12ab12', 'ab12ab12ab12ab12']);
  });

  it('a wake with no ping key here settles nothing: no signed status, no tag', async () => {
    await linkedHere();
    Keychain.getGenericPassword.mockResolvedValue(false);
    DeviceKey.hasUnansweredKey.mockResolvedValueOnce(true);
    answers = (url) => (url.includes('/light-node/status')
      ? { onchain_registered: true, device_bound: true, features: ['status_signed'], device_tag_h: 'ab12ab12ab12ab12' } : { success: true });
    await Push.handlePushMessage({ action: 'epoch', anchor: `${P.height}:${P.hash}` });
    expect(calls.filter((c) => c.url.endsWith('/light-node/status'))).toEqual([]);
    expect(DeviceKey.settleByTag).not.toHaveBeenCalled();
  });

  it('Stop sends the release with the unbind, to the owner that issued the release\'s challenge', async () => {
    await linkedHere();
    const issuer = OWNERS[1];
    answers = (url) => {
      if (url.includes('/device-challenge')) {
        if (!url.startsWith(issuer)) return new Error('down');
        return { nonce: 'r'.repeat(43), stamp: 'rs', exp: T + 600, issuer: 'genesis_node_004' };
      }
      return { success: true };
    };
    expect(await Push.stopLightNode()).toEqual({ unbound: true });
    const unbind = calls.find((c) => c.url.endsWith('/api/v1/light-node/unbind'));
    expect(unbind.url.startsWith(issuer)).toBe(true);
    expect(unbind.body).toMatchObject({ node_id: W.nodeId, seq: SEQ, signer: 'ping', device_release: { nonce: 'r'.repeat(43), stamp: 'rs', sig: 'AAAA' } });
    expect(DeviceKey.sign.mock.calls.map((c) => c[1])).toContain(`qnet_dev_release:v1|1337|${W.nodeId}|${SEQ}|${'r'.repeat(43)}`);
    expect(await AsyncStorage.getItem('qnet_node_device_schedule')).toBeNull();
  });
});
