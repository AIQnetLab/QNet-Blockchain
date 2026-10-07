/**
 * The device's model every binding names (owner, 06.10: the site's Device tab and the Node tab show the linked device
 * itself, not only its platform): a short marketing name built on the device from what the system gives without any
 * permission, never an identifier, sent beside the platform with Use this device, the QNet Link sheet's binding and every
 * re-send; and the model the network names shown on the Node tab. Device names here are made up.
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

import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { NativeModules, Text } from 'react-native';

const AsyncStorage = require('@react-native-async-storage/async-storage');
const DeviceKey = require('../src/services/NodeDeviceKey');
const M = require('../src/services/DeviceModel');
const Push = require('../src/services/PushService');
const { LINK_PENDING_KEY, readNodeStatus } = require('../src/services/LightNode');
const { default: NodeTab, linkedModel } = require('../src/screens/NodeTab');
const { makeT } = require('../src/i18n');
const V = require('../../../docs/protocols/light-node.vectors.json');

const NODE = V.wallets[0].nodeId;
const WALLET = V.wallets[0].address;
const PP = V.pingKey.publicKey;
const SEQ = 1790000000;
const IOS_ID = 'iPhone15,4';
const t = makeT('en');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Jest runs as iOS: this install's hardware identifier, with fields the builder must never pass on.
const native = { deviceModel: jest.fn(async () => ({ machine: IOS_ID, idiom: 'phone', serial: 'F2LXQ0ABC', name: 'Ann' })) };
NativeModules.QNetSecurity = native;

let calls;
let answers;
const reply = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  DeviceKey.checkDevice.mockResolvedValue({ capable: true, platform: 'ios', flags: 'mac=0,vision=0,idiom=phone', report: null });
  calls = [];
  answers = () => ({ success: true });
  global.fetch = jest.fn((url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const a = answers(url, body);
    return a instanceof Error ? Promise.reject(a) : reply(a);
  });
});
afterEach(() => jest.restoreAllMocks());

describe('the model builder', () => {
  it('a model is 1 to 40 ASCII letters, digits, spaces and . , + ( ) / -, the node\'s rule', () => {
    expect(M.MODEL_MAX).toBe(40);
    for (const ok of ['Acme Phone 7', 'Acme X-2 (5G), 128/8+', 'a'.repeat(40)]) expect([ok, M.isModel(ok)]).toEqual([ok, true]);
    for (const bad of ['', ' Acme 7', 'Acme 7 ', 'a'.repeat(41), "Ann's Phone 7", 'Phoneé 7', 'a\nb', '<b>7</b>', 'a;b', 7, null]) {
      expect([bad, M.isModel(bad)]).toEqual([bad, false]);
    }
    // Text from the system: spaces collapsed, nothing dropped to make it fit, cut at a space near the 40th character.
    expect(M.cleanModel('  Acme   Phone\t7 ')).toBe('Acme Phone 7');
    expect(M.cleanModel("Ann's Phone 7")).toBe(null);
    expect(M.cleanModel('Acme Phone Seven Ultra Max Extreme Edition 2026')).toBe('Acme Phone Seven Ultra Max Extreme');
    expect(M.cleanModel('A'.repeat(50))).toBe('A'.repeat(40));
  });

  it('Android: the maker and the model, the maker once; never the device name of the settings', () => {
    // A name the user gave the device is never sent, however much it looks like a model.
    for (const name of ['Acme Phone 7', 'Ivan Petrov 2', 'Max +7 916 1234567', 'Ann Smith (555) 010-0100', 'Ann', '', null]) {
      expect([name, M.androidModel({ name, manufacturer: 'acme', model: 'AP-7' })]).toEqual([name, 'Acme AP-7']);
    }
    expect(M.androidModel({ manufacturer: 'ACMECORP', model: 'ACMECORP X5' })).toBe('Acmecorp X5');
    expect(M.androidModel({ manufacturer: 'acme', model: 'acme_tab_3' })).toBe('Acme tab 3');
    expect(M.androidModel({ manufacturer: 'ACM', model: 'Z1' })).toBe('ACM Z1');
    expect(M.androidModel({ manufacturer: 'AcmeWorks', model: 'Q 9' })).toBe('AcmeWorks Q 9');
    expect(M.androidModel({ manufacturer: 'acme', model: 'AP-7™' })).toBe('Acme');
    expect(M.androidModel({ manufacturer: '', model: '' })).toBe(null);
    expect(M.androidModel({})).toBe(null);
  });

  it('iOS: the table\'s marketing name of the hardware identifier, else iPhone or iPad; every name fits the rule', () => {
    expect(M.IOS_MODEL_NAMES.size).toBeGreaterThan(60);
    for (const [id, name] of M.IOS_MODEL_NAMES) {
      expect([id, M.isModel(name), M.iosModel({ machine: id })]).toEqual([id, true, name]);
      expect(name.startsWith(id.startsWith('iPad') ? 'iPad' : 'iPhone')).toBe(true);
    }
    expect(M.iosModel({ machine: 'iPhone99,1', idiom: 'pad' })).toBe('iPhone');
    expect(M.iosModel({ machine: 'iPad99,1' })).toBe('iPad');
    expect(M.iosModel({ machine: 'arm64', idiom: 'pad' })).toBe('iPad');
    expect(M.iosModel({ machine: 'arm64', idiom: 'phone' })).toBe('iPhone');
    expect(M.iosModel({ machine: 'x86_64', idiom: 'other' })).toBe(null);
    expect(M.iosModel({})).toBe(null);
  });

  it('read once from the native module; never an identifier it also gave; null without one or on its failure', async () => {
    expect(await M.deviceModel()).toBe(M.IOS_MODEL_NAMES.get(IOS_ID));
    expect(await M.deviceModel()).toBe(M.IOS_MODEL_NAMES.get(IOS_ID));
    let android;
    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({
        Platform: { OS: 'android' },
        NativeModules: { QNetSecurity: { deviceModel: async () => ({ name: null, manufacturer: 'acme', model: 'AP-7', serial: 'R58N1234' }) } },
      }));
      android = require('../src/services/DeviceModel').deviceModel();
    });
    expect(await android).toBe('Acme AP-7');
    for (const mod of [undefined, {}, { deviceModel: async () => { throw new Error('no'); } }, { deviceModel: async () => 'x' }]) {
      let got;
      jest.isolateModules(() => {
        jest.doMock('react-native', () => ({ Platform: { OS: 'ios' }, NativeModules: { QNetSecurity: mod } }));
        got = require('../src/services/DeviceModel').deviceModel();
      });
      expect(await got).toBe(null);
    }
    // A body always names this device's model: one a test build kept (possibly a device name) is replaced.
    expect(await M.withDeviceModel({ seq: 1, model: 'Ivan Petrov 2' })).toEqual({ seq: 1, model: M.IOS_MODEL_NAMES.get(IOS_ID) });
    expect(await M.withDeviceModel({ seq: 1 })).toEqual({ seq: 1, model: M.IOS_MODEL_NAMES.get(IOS_ID) });
  });

  it('the native side reads no identifier and needs no permission', () => {
    const kt = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');
    const body = kt.slice(kt.indexOf('fun deviceModel('), kt.indexOf('// ── Device integrity'));
    expect(body).not.toMatch(/DEVICE_NAME|device_name|getString/);
    expect(body).toMatch(/Build\.MANUFACTURER/);
    expect(body).toMatch(/Build\.MODEL/);
    expect(body).not.toMatch(/SERIAL|getSerial|IMEI|getImei|ANDROID_ID|getDeviceId|BLUETOOTH|bluetooth_name/);
    const m = read('ios/QNetMobile/QNetSecurityModule.m');
    const ios = m.slice(m.indexOf('RCT_EXPORT_METHOD(deviceModel:'));
    expect(ios).toMatch(/uname\(&info\)/);
    expect(ios.slice(0, ios.indexOf('\n}\n'))).not.toMatch(/identifierForVendor|\.name\b|serial/i);
    expect(read('android/app/src/main/AndroidManifest.xml')).not.toMatch(/READ_PHONE_STATE|READ_PRIVILEGED_PHONE_STATE/);
  });
});

// Use this device with a signer that signs anything (the preimages have their own tests).
const signer = () => ({
  signNodeStatus: async () => ({ signer: 'wallet', sig: 'ws', identityPublicKey: 'id' }),
  prepareLightNodeBinding: async (cred, { seq }) => ({
    nodeId: NODE, wallet: WALLET, identityPublicKey: 'id', pingPublicKey: PP, delegation: 'del', attachSig: `att${seq}`,
    keep: async () => {}, wipe: () => {},
  }),
  prepareLinkConsent: async (cred, { ts }) => ({
    nodeId: NODE, wallet: WALLET, identityPublicKey: 'abcd', consentSig: 'cd', proof: 'pf',
    binding: { pingPublicKey: PP, delegation: 'del', attachSig: `att${ts}`, keep: async () => {}, wipe: () => {} },
  }),
});
const pub = (over = {}) => ({ onchain_registered: true, device_bound: true, answered_this_epoch: true, features: ['status_signed', 'bind_v2'], ...over });
const binds = () => calls.filter((c) => c.url.endsWith('/light-node/bind'));

describe('every binding names the model beside the platform', () => {
  const MODEL = () => M.IOS_MODEL_NAMES.get(IOS_ID);

  it('Use this device', async () => {
    answers = (url, body) => {
      if (url.includes('/light-node/status') && !body) return pub();
      if (url.endsWith('/light-node/status')) return { ...pub(), binding_seq: SEQ - 1 };
      if (url.endsWith('/light-node/bind')) return { success: true, bound: true, seq: body.seq };
      return { success: true };
    };
    const r = await Push.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, interactive: true });
    expect(r.ok).toBe(true);
    expect(binds().length).toBeGreaterThan(0);
    for (const b of binds()) expect(b.body).toMatchObject({ platform: 'ios', model: MODEL(), seq: r.seq, attach_sig: `att${r.seq}` });
  });

  it('the QNet Link sheet\'s binding, the record it keeps, and the re-send of a record an earlier version kept', async () => {
    const T = 1790000000;
    jest.spyOn(Date, 'now').mockReturnValue(T * 1000);
    answers = (url, body) => (url.endsWith('/light-node/bind') ? { success: true, bound: false, pending: true, seq: body.seq } : { success: true });
    const r = await Push.linkWithConsent({
      signer: signer(), credential: 'c', nodeId: NODE, burnTx: 'b'.repeat(88), device: await DeviceKey.checkDevice(),
      features: ['bind_v2', 'pending_bind'],
    });
    expect(r.bound).toBe(true);
    for (const b of binds()) expect(b.body).toMatchObject({ platform: 'ios', model: MODEL(), seq: T, ts: T });
    expect(JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY)).bindBlob.model).toBe(MODEL());
    // A record an earlier version kept names no model: its re-send adds this device's, the signed fields unchanged.
    const rec = JSON.parse(await AsyncStorage.getItem(LINK_PENDING_KEY));
    delete rec.bindBlob.model;
    await AsyncStorage.setItem(LINK_PENDING_KEY, JSON.stringify({ ...rec, bound: false }));
    calls = [];
    answers = (url, body) => (url.endsWith('/light-node/bind') ? { success: true, bound: true, seq: body.seq } : { success: true });
    expect(await Push.resendPendingBinding(NODE, { onChain: true, deviceBound: false, features: ['bind_v2'] })).toBe(true);
    expect(binds()[0].body).toEqual({ ...rec.bindBlob, model: MODEL() });
  });

  it('the re-enrolment re-send of a binding an earlier version kept', async () => {
    const T = 1790000000;
    jest.spyOn(Date, 'now').mockReturnValue(T * 1000);
    const blob = { node_id: NODE, seq: SEQ, ts: SEQ, platform: 'ios', ping_pubkey: PP, attach_sig: 'a' };
    await AsyncStorage.multiSet([
      ['qnet_light_node_info', JSON.stringify({ nodeId: NODE, walletAddress: WALLET, pushType: 'fcm', seq: SEQ, hw: true })],
      ['qnet_ping_node_id', NODE],
      [Push.ENROL_AGAIN_KEY, JSON.stringify({ nodeId: NODE, seq: SEQ, wallet: WALLET, bindBlob: blob, tries: 0, nextTryAt: 0 })],
    ]);
    DeviceKey.enrolEvidence.mockResolvedValue({ key: { platform: 'ios', handle: 'k', hwPub: V.device.keys.ios.publicKey, attested: true },
      device: { platform: 'ios', key_id: 'k', attestation: 'a' }, token: { field: 'dc_token', value: 'dc' } });
    answers = (url, body) => {
      if (url.includes('/device-challenge')) return { nonce: 'n'.repeat(43), stamp: 'st', exp: T + 600, issuer: 'genesis_node_004' };
      if (url.endsWith('/light-node/bind')) return { success: true, bound: true, seq: body.seq };
      return { success: true };
    };
    const status = { onChain: true, features: ['device_v1', 'bind_v2'], nonce: 'ab'.repeat(16), deviceTags: [],
      signed: { deviceState: 'check_pending', refreshWindow: null, bindingSeq: SEQ } };
    expect(await Push.enrolAgainIfUnleased(NODE, status)).toBe(true);
    expect(binds()[0].body).toMatchObject({ ...blob, model: MODEL(), dc_token: 'dc' });
  });

  it('a device without a model sends the binding as before', async () => {
    // A fresh module graph, whose native modules have no QNetSecurity: no model to name.
    let P;
    jest.isolateModules(() => { P = require('../src/services/PushService'); });
    answers = (url, body) => {
      if (url.includes('/light-node/status') && !body) return pub();
      if (url.endsWith('/light-node/status')) return { ...pub(), binding_seq: SEQ - 1 };
      if (url.endsWith('/light-node/bind')) return { success: true, bound: true, seq: body.seq };
      return { success: true };
    };
    const r = await P.bindThisDevice({ signer: signer(), credential: {}, nodeId: NODE, interactive: true });
    expect(r.ok).toBe(true);
    expect(binds()[0].body.platform).toBe('ios');
    expect(binds()[0].body).not.toHaveProperty('model');
  });
});

describe('the model the network names', () => {
  it('is read strictly from the public status; none for a model the node\'s rule would not keep', async () => {
    const owners = require('../src/config/nodes').lightShardOwnerUrls(NODE);
    const device = { platform: 'android', model: 'Acme Phone 7', linked_since: 1790035200, last_answer_epoch: 1240, state: 'online' };
    answers = (url) => (owners.some((o) => url.startsWith(o)) && url.includes('/light-node/status') ? pub({ device }) : { success: true });
    expect((await readNodeStatus(NODE)).device).toEqual({ platform: 'android', model: 'Acme Phone 7', linkedSince: 1790035200, lastAnswerEpoch: 1240, state: 'online' });
    for (const model of ['<b>x</b>', 'a'.repeat(41), 7, undefined]) {
      answers = (url) => (url.includes('/light-node/status') ? pub({ device: { ...device, model } }) : { success: true });
      expect((await readNodeStatus(NODE)).device.model).toBe(null);
    }
  });

  it('the Node tab names the linked device by its model, this one or another; never its platform', () => {
    const status = (device, over = {}) => ({
      reachable: true, onChain: true, registrationPending: false, deviceBound: true, deviceBoundAgreed: true, answered: null,
      needsReactivation: false, counted: null, device, deviceTags: [], features: [], signed: null, keyOurs: null,
      bindingSeqAgreed: null, ...over,
    });
    const dev = { platform: 'android', model: 'Acme Phone 7', linkedSince: 1790035200, lastAnswerEpoch: 7, state: 'online' };
    expect(linkedModel(status(dev))).toBe('Acme Phone 7');
    expect(linkedModel(status({ ...dev, model: null }))).toBe(null);
    expect(linkedModel(status({ ...dev, state: 'unlinked' }))).toBe(null);
    expect(linkedModel(null)).toBe(null);
    const render = (light) => {
      let tree;
      act(() => {
        tree = renderer.create(<NodeTab t={t} light={{ nodeId: NODE, local: null, pending: null, answeredAt: null, balanceNano: 0, ...light }}
          onMove={() => {}} onUse={() => {}} onCopy={() => {}} nodeTitle={() => ''} height={2241840} />);
      });
      return tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('\n');
    };
    const elsewhere = render({ status: status(dev) });
    expect(elsewhere).toContain(t('node_other_device'));
    expect(elsewhere).toContain(`${t('node_device')}\nAcme Phone 7`);
    const here = render({ status: status(dev, { bindingSeqAgreed: SEQ }), local: { nodeId: NODE, seq: SEQ, pushType: 'fcm', hw: true } });
    expect(here).toContain(`${t('node_device')}\nAcme Phone 7`);
    expect(here).not.toMatch(/Android/);
    expect(render({ status: status({ ...dev, model: null }) })).not.toContain(t('node_device'));
    expect(render({ status: status(null, { deviceBound: false, deviceBoundAgreed: false }) })).not.toContain(t('node_device'));
  });

  it('the label is in every language of the app', () => {
    for (const loc of ['ar', 'de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'zh-CN']) {
      expect([loc, /^ {2}node_device: ['"][^'"]+['"],$/m.test(read(`src/i18n/locales/${loc}.js`))]).toEqual([loc, true]);
    }
  });
});
