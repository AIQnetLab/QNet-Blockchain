/**
 * The push token and the wakes (plan-mobile section 5, unified plan APP-3): the app asks for no notification permission
 * anywhere, takes a push token only when this wallet's node is linked to this device, gives it back on Stop, on a
 * takeover and when the wallet goes, and answers the network's per-epoch and "I'm back" pushes, which name no node.
 */
import fs from 'fs';
import path from 'path';

jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signWithDilithium: jest.fn().mockResolvedValue('sig'),
  signDetached: jest.fn().mockResolvedValue('ab'.repeat(8)),
}));

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const Keychain = require('react-native-keychain');
const BackgroundFetch = require('react-native-background-fetch').default;
const messaging = require('@react-native-firebase/messaging').default;
const { signDetached } = require('../src/crypto/DilithiumCrypto');
const { unbindPreimage, tokenRefreshPreimage } = require('../src/crypto/NodePreimages');
const { lightShardOwnerUrls } = require('../src/config/nodes');
const Push = require('../src/services/PushService');

const NODE = 'light_mobile_83afab763b9058fd';
const SEQ = 1790000000;
const reply = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
let calls;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  Keychain.getGenericPassword.mockResolvedValue(false);
  calls = [];
  global.fetch = jest.fn((url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return reply({ success: true });
  });
});

const linked = async (seq = SEQ) => {
  Keychain.getGenericPassword.mockResolvedValue({ password: 'sk' });
  await AsyncStorage.multiSet([
    ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, walletAddress: 'w', pushType: 'fcm', seq })],
    ['qnet_ping_node_id', NODE],
    [`qnet_ping_dilithium_pk_${NODE}`, 'pk'],
    [`qnet_ping_cert_${NODE}`, `v2.${seq}.cert`],
  ]);
};

describe('no permission prompt, no notification', () => {
  it('nothing in the app asks for a notification permission or shows a notification', () => {
    for (const f of ['App.tsx', 'index.js', 'src/services/PushService.js', 'ios/QNetMobile/AppDelegate.swift']) {
      expect([f, /requestPermission|requestAuthorization|willPresent|POST_NOTIFICATIONS/.test(read(f))]).toEqual([f, false]);
    }
    // No library may bring the permission in.
    expect(read('android/app/src/main/AndroidManifest.xml'))
      .toMatch(/<uses-permission android:name="android\.permission\.POST_NOTIFICATIONS" tools:node="remove" \/>/);
  });

  it('Firebase issues no token by itself on either platform', () => {
    expect(JSON.parse(read('firebase.json'))['react-native']).toEqual({
      messaging_auto_init_enabled: false,
      messaging_ios_auto_register_for_remote_messages: false,
    });
  });

  it('iOS permits only the periodic wake, and the privacy manifest calls the token linked', () => {
    expect(read('ios/QNetMobile/Info.plist')).not.toContain('customtask');
    const manifest = read('ios/QNetMobile/PrivacyInfo.xcprivacy');
    expect(manifest).toMatch(/NSPrivacyCollectedDataTypeDeviceID<\/string>\s*<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*<true\/>/);
    expect(manifest).not.toMatch(/issued at launch/);
  });
});

describe('a token only while linked', () => {
  it('a launch takes no token, with or without a node linked here', async () => {
    await Push.initializePushService();
    await linked();
    await Push.initializePushService();
    await new Promise((r) => setTimeout(r, 30));
    expect(messaging().getToken).not.toHaveBeenCalled();
    expect(messaging().registerDeviceForRemoteMessages).not.toHaveBeenCalled();
  });

  it('a token refresh with nothing linked sends nothing and asks Firebase for nothing', async () => {
    await Push.backgroundRefreshFcmToken();
    expect(await Push.isTokenRefreshNeeded()).toBe(false);
    expect(messaging().getToken).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('a linked node sends its new token signed over the token itself', async () => {
    await linked();
    await Push.backgroundRefreshFcmToken();
    const post = calls.find((c) => c.url.endsWith('/api/v1/light-node/token-refresh'));
    expect(post.url.startsWith(lightShardOwnerUrls(NODE)[0])).toBe(true);
    expect(post.body).toMatchObject({ node_id: NODE, push_type: 'fcm', device_token: 'test-fcm-token', seq: SEQ });
    expect(signDetached).toHaveBeenCalledWith(tokenRefreshPreimage(NODE, 'test-fcm-token', SEQ, post.body.timestamp), 'sk');
    expect(await AsyncStorage.getItem('qnet_needs_token_refresh')).toBe('false');
  });
});

describe('Use this device', () => {
  const signer = (over = {}) => {
    const b = {
      nodeId: NODE, wallet: 'w', identityPublicKey: 'ik', pingPublicKey: 'pp', delegation: 'dg', attachSig: 'as',
      keep: jest.fn(async () => {}), wipe: jest.fn(), ...over,
    };
    return {
      binding: b,
      signNodeStatus: jest.fn(async () => ({ signer: 'wallet', sig: 'ws', identityPublicKey: 'ik' })),
      prepareLightNodeBinding: jest.fn(async () => b),
    };
  };
  const network = (bindAnswer) => {
    global.fetch = jest.fn((url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      calls.push({ url, body });
      if (url.includes('/light-node/status') && !body) {
        return reply({ onchain_registered: true, device_bound: true, needs_reactivation: false, features: ['bind_v2', 'status_signed'] });
      }
      if (url.endsWith('/light-node/status')) return reply({ onchain_registered: true, binding_seq: 5 });
      if (url.endsWith('/light-node/bind')) return reply(bindAnswer(body));
      return reply({ success: true });
    });
  };

  it('takes the token only for the binding, and binds with a newer sequence', async () => {
    const s = signer();
    network((body) => ({ success: true, bound: true, seq: body.seq }));
    const r = await Push.bindThisDevice({ signer: s, credential: 'c', nodeId: NODE });
    expect(messaging().getToken).toHaveBeenCalledTimes(1);
    const bind = calls.find((c) => c.url.endsWith('/light-node/bind'));
    expect(r).toEqual({ ok: true, seq: bind.body.seq });
    // The wallet form of the signed status carries the wallet key (a node never bound knows it only from here).
    const status = calls.find((c) => c.url.endsWith('/light-node/status') && c.body);
    // With the read's nonce, for the device tag only the signed form carries (ND-7).
    expect(status.body).toEqual({
      node_id: NODE, ts: status.body.ts, signer: 'wallet', sig: 'ws', identity_pubkey: 'ik', nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(bind.body.seq).toBeGreaterThanOrEqual(6);
    // Before two genesis nodes serve the device layer, the binding carries no device block.
    expect(bind.body).not.toHaveProperty('device');
    expect(bind.url.startsWith(lightShardOwnerUrls(NODE)[0])).toBe(true);
    expect(bind.body).toMatchObject({ node_id: NODE, push_type: 'fcm', device_token: 'test-fcm-token', attach_sig: 'as', ping_pubkey: 'pp' });
    expect(bind.body.seq).toBeGreaterThanOrEqual(bind.body.ts);
    expect(s.prepareLightNodeBinding).toHaveBeenCalledWith('c', { seq: bind.body.seq, ts: bind.body.ts, pushTarget: 'test-fcm-token' });
    expect(s.binding.keep).toHaveBeenCalled();
    expect(s.binding.wipe).toHaveBeenCalled();
    expect(JSON.parse(await AsyncStorage.getItem('qnet_light_node_info'))).toMatchObject({ nodeId: NODE, seq: bind.body.seq });
    expect(await AsyncStorage.getItem(`qnet_ping_cert_${NODE}`)).toBe(`v2.${bind.body.seq}.dg`);
    expect(messaging().deleteToken).not.toHaveBeenCalled();
    expect(BackgroundFetch.configure).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50)); // the first answer it sends at once
  });

  it('a refused binding keeps no key and gives the token back', async () => {
    const s = signer();
    network(() => ({ success: false, reason: 'device_unsupported' }));
    expect(await Push.bindThisDevice({ signer: s, credential: 'c', nodeId: NODE }))
      .toEqual({ ok: false, reason: 'device_unsupported', retryAfterSeconds: null });
    expect(s.binding.keep).not.toHaveBeenCalled();
    expect(s.binding.wipe).toHaveBeenCalled();
    expect(messaging().deleteToken).toHaveBeenCalled();
    expect(await AsyncStorage.getItem('qnet_light_node_info')).toBe(null);
  });

  it('a binding the wallet could not sign, or signed for another node, gives the token back', async () => {
    const s = signer();
    network((body) => ({ success: true, bound: true, seq: body.seq }));
    s.prepareLightNodeBinding.mockRejectedValueOnce(new Error('locked'));
    await expect(Push.bindThisDevice({ signer: s, credential: 'c', nodeId: NODE })).rejects.toThrow('locked');
    expect(messaging().deleteToken).toHaveBeenCalledTimes(1);
    const other = signer({ nodeId: 'light_mobile_0123456789abcdef' });
    network((body) => ({ success: true, bound: true, seq: body.seq }));
    expect(await Push.bindThisDevice({ signer: other, credential: 'c', nodeId: NODE })).toEqual({ ok: false, reason: 'identity_mismatch' });
    expect(messaging().deleteToken).toHaveBeenCalledTimes(2);
    expect(calls.some((c) => c.url.endsWith('/light-node/bind'))).toBe(false);
  });

  it('an answer that does not name this binding binds nothing', async () => {
    const s = signer();
    network(() => ({ success: true, bound: false }));
    const r = await Push.bindThisDevice({ signer: s, credential: 'c', nodeId: NODE });
    expect(r.ok).toBe(false);
    expect(s.binding.keep).not.toHaveBeenCalled();
  });
});

describe('the unlink this device confirms, and every other end of the binding', () => {
  it('tells the network with the ping key, then the token and the keys go', async () => {
    await linked();
    expect(await Push.stopLightNode()).toEqual({ unbound: true });
    const post = calls.find((c) => c.url.endsWith('/api/v1/light-node/unbind'));
    expect(post.body).toMatchObject({ node_id: NODE, seq: SEQ, signer: 'ping', sig: 'ab'.repeat(8) });
    expect(signDetached).toHaveBeenCalledWith(unbindPreimage(NODE, SEQ, post.body.ts), 'sk');
    expect(messaging().deleteToken).toHaveBeenCalled();
    expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({ service: `qnet_ping_sk_${NODE}` });
    expect(await AsyncStorage.getItem('qnet_light_node_info')).toBe(null);
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(null);
  });

  it('a binding older builds made has nothing to sign: only the device forgets it', async () => {
    await linked(0);
    expect(await Push.stopLightNode()).toEqual({ unbound: false });
    expect(calls.some((c) => c.url.endsWith('/unbind'))).toBe(false);
    expect(messaging().deleteToken).toHaveBeenCalled();
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(null);
  });

  it('does not wait for a network that hangs', async () => {
    jest.useFakeTimers();
    try {
      await linked();
      global.fetch = jest.fn((url, opts) => new Promise((_, reject) => {
        if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      let done = false;
      const stop = Push.stopLightNode().then((r) => { done = r; });
      await jest.advanceTimersByTimeAsync(9000);
      expect(done).toEqual({ unbound: false });
      await stop;
    } finally {
      jest.useRealTimers();
    }
  });

  it('a takeover keeps no token; the binding that replaces this one keeps it', async () => {
    await linked();
    await Push.teardownLightNode({ keepToken: true });
    expect(messaging().deleteToken).not.toHaveBeenCalled();
    await linked();
    await Push.teardownLightNode();
    expect(messaging().deleteToken).toHaveBeenCalledTimes(1);
  });

  // Contract 4 (04.10): by the binding two owners name (B, bindingSeqAgreed) and whether two say a device is bound (D).
  it('a device another one replaced stops waking and gives its token back, without telling the network', async () => {
    await linked();
    const newer = { bindingSeqAgreed: SEQ + 3, deviceBoundAgreed: true };
    expect(await Push.forgetIfReplaced(NODE, { keyOurs: null, deviceBound: true })).toBe(false);
    // A refused key, or owners that cannot say whether a device is bound, end nothing.
    expect(await Push.forgetIfReplaced(NODE, { keyOurs: false, deviceBound: true, deviceBoundAgreed: true })).toBe(false);
    expect(await Push.forgetIfReplaced(NODE, { bindingSeqAgreed: SEQ + 3, deviceBoundAgreed: null })).toBe(false);
    expect(messaging().deleteToken).not.toHaveBeenCalled();
    // A status read for an earlier binding does not end the one made since.
    expect(await Push.forgetIfReplaced(NODE, newer, SEQ - 1)).toBe(false);
    expect(messaging().deleteToken).not.toHaveBeenCalled();
    expect(await Push.forgetIfReplaced(NODE, newer, SEQ)).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/unbind'))).toBe(false);
    expect(messaging().deleteToken).toHaveBeenCalled();
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(null);
  });

  // A launch reads the status with the ping key only: a refused key tells nothing, and never ends the binding (the reply
  // the node refuses as `superseded` does, NodeRound4); two owners naming a newer binding with a device bound do.
  it('a launch ends the binding only when two owners name a newer one, never on a refused ping key', async () => {
    await linked();
    const serve = (signed) => {
      global.fetch = jest.fn((url, opts) => {
        const body = opts && opts.body ? JSON.parse(opts.body) : null;
        calls.push({ url, body });
        if (url.includes('/light-node/status') && !body) {
          return reply({ onchain_registered: true, device_bound: true, features: ['status_signed'] });
        }
        if (url.endsWith('/light-node/status')) return reply(signed);
        return reply({});
      });
    };
    serve({ success: false, reason: 'bad_signature' });
    // A launch in front: one in the background reads no status (it is read at the first return to the app).
    const { AppState } = require('react-native');
    const state = AppState.currentState;
    AppState.currentState = 'active';
    try {
      await Push.initializePushService();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      AppState.currentState = state;
    }
    expect(calls.find((c) => c.url.endsWith('/light-node/status')).body).toMatchObject({ node_id: NODE, signer: 'ping' });
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(NODE);
    expect(messaging().deleteToken).not.toHaveBeenCalled();
    serve({ onchain_registered: true, device_bound: true, binding_seq: SEQ + 9 });
    AppState.currentState = 'active';
    try {
      await Push.initializePushService();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      AppState.currentState = state;
    }
    expect(await AsyncStorage.getItem('qnet_ping_node_id')).toBe(null);
    expect(messaging().deleteToken).toHaveBeenCalled();
  });

  it('another wallet on the device stops this node the same way', async () => {
    await linked();
    await Push.teardownLightNodeIfForeign(['other-wallet']);
    expect(calls.some((c) => c.url.endsWith('/unbind'))).toBe(true);
    expect(messaging().deleteToken).toHaveBeenCalled();
    await linked();
    jest.clearAllMocks();
    await Push.teardownLightNodeIfForeign(['w']);
    expect(messaging().deleteToken).not.toHaveBeenCalled();
  });

  it('a device that never linked a node asks Firebase nothing when its wallet goes', async () => {
    expect(await Push.stopLightNode()).toEqual({ unbound: false });
    expect(messaging().deleteToken).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('the wallet screen stops the node when the wallet is erased', () => {
    const screen = read('src/screens/WalletScreen.js');
    const erase = screen.slice(screen.indexOf('const eraseWallet = async'), screen.indexOf('eraseAllData', screen.indexOf('const eraseWallet = async')));
    // At once and for good, the device key with it; the network's answer is awaited after the local wipe (A2, 04.10).
    expect(erase).toContain('await stopLightNode({ waitForNetwork: false, forgetDevice: true });');
  });
});

describe('the network\'s pushes', () => {
  const H = 2241840;
  const HASH = 'ab'.repeat(32);
  const EPOCH = Math.floor(H / 14400);

  it('an epoch push answers its anchor at once, once per epoch', async () => {
    await linked();
    expect(await Push.handlePushMessage({ action: 'epoch', anchor: `${H}:${HASH}` })).toBe(true);
    const post = calls.find((c) => c.url.endsWith('/api/v1/light-node/ping-response'));
    expect(post.body).toMatchObject({ node_id: NODE, challenge: `selfattest:${H}:${HASH}`, signature: 'ping_dilithium:sig' });
    expect(calls.some((c) => c.url.endsWith('/api/v1/height'))).toBe(false);
    calls = [];
    expect(await Push.handlePushMessage({ action: 'epoch', anchor: `${H}:${HASH}` })).toBe(false);
    expect(calls).toEqual([]);
  });

  it('"I\'m back" answers even when this epoch was already answered', async () => {
    await linked();
    await AsyncStorage.setItem('qnet_last_self_attest_epoch', String(EPOCH));
    expect(await Push.handlePushMessage({ action: 'wake', anchor: `${H}:${HASH}` })).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('/ping-response'))).toHaveLength(1);
  });

  it('a push with a malformed anchor is never signed as it came', async () => {
    await linked();
    global.fetch = jest.fn((url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return reply(url.endsWith('/api/v1/height') ? { height: 1000 } : {});
    });
    await Push.handlePushMessage({ action: 'epoch', anchor: `${H}:not-a-hash` });
    expect(calls.some((c) => c.body && String(c.body.challenge).includes('not-a-hash'))).toBe(false);
  });

  it('nothing answers for a device with no node linked', async () => {
    expect(await Push.handlePushMessage({ action: 'epoch', anchor: `${H}:${HASH}` })).toBe(false);
    expect(calls).toEqual([]);
  });
});
