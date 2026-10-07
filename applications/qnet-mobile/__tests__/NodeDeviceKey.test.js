/**
 * The node's device key over the native module (src/services/NodeDeviceKey.js), on both platforms, against fakes of
 * QNetDeviceAttest that hold real P-256 keys (node:crypto): what a device may try, the evidence of an enrolment and a
 * rotation byte for byte as light-node-messages section 5 builds it, signatures that verify, tokens bound to the
 * right nonce, the pending/current record in the Keychain, and every failure under its code. No OS version is asked.
 */
const nodeCrypto = require('crypto');
const { NativeModules, Platform } = require('react-native');
const Keychain = require('react-native-keychain');
const { sha256 } = require('@noble/hashes/sha2.js');
const P = require('../src/crypto/NodePreimages');
const K = require('../src/services/NodeDeviceKey');

const V = require('../../../docs/protocols/light-node.vectors.json');
const W = V.wallets[0];
const OS = Platform.OS;
const b64u = (b) => Buffer.from(b).toString('base64url');
const hexOf = (b) => Buffer.from(b).toString('hex');
const nonceOf = (n) => b64u(Buffer.alloc(32, n));

// ---- a Keychain in memory ----
const items = new Map();
Keychain.setGenericPassword.mockImplementation(async (username, password, o) => {
  items.set(o.service, { username, password, accessible: o.accessible });
  return true;
});
Keychain.getGenericPassword.mockImplementation(async (o) => (items.has(o.service) ? { ...items.get(o.service) } : false));
Keychain.resetGenericPassword.mockImplementation(async (o) => items.delete(o.service));
const record = () => (items.has(K.NODE_DEVICE_KEY_SERVICE) ? JSON.parse(items.get(K.NODE_DEVICE_KEY_SERVICE).password) : null);

// ---- P-256 keys, and the DER and CBOR the fakes hand back ----
function newKey() {
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
  return { privateKey, publicKey, point, spki: publicKey.export({ type: 'spki', format: 'der' }) };
}
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
  const len = body.length < 128 ? [body.length] : body.length < 256 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 255];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
};
const ECDSA_SHA256 = der(0x30, der(0x06, [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
// A certificate of the shape X.509 has, for `spki`; its signature is not a real one (nothing here checks it).
const certOf = (spki) => der(0x30,
  der(0x30, der(0xa0, der(0x02, [2])), der(0x02, [1]), ECDSA_SHA256, der(0x30), der(0x30), der(0x30), spki),
  ECDSA_SHA256, der(0x03, [0]));
const cborHead = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n])
  : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
const cbor = (v) => {
  if (typeof v === 'string') return Buffer.concat([cborHead(3, v.length), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([cborHead(4, v.length), ...v.map(cbor)]);
  const entries = Object.entries(v);
  return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
};
const attestationOf = (spki) => cbor({ fmt: 'apple-appattest', attStmt: { x5c: [certOf(spki), certOf(spki)], receipt: Buffer.alloc(8) }, authData: Buffer.alloc(37) });
const verify = (point, message, derSigB64u) => nodeCrypto.verify('sha256', Buffer.from(message),
  { key: nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(Buffer.from(point, 'hex').subarray(1, 33)), y: b64u(Buffer.from(point, 'hex').subarray(33)) }, format: 'jwk' }), dsaEncoding: 'der' },
  Buffer.from(derSigB64u, 'base64url'));
const nativeError = (code) => Object.assign(new Error(code), { code });

// ---- the fakes of QNetDeviceAttest ----
const REPORT = { arc: false, automotive: false, embedded: false, feature_pc: false, hsum: false, leanback: false, system_user: true, touchscreen: true, watch: false };
let fake;
function iosFake(env = {}) {
  const keys = new Map(); // key id -> key
  const f = {
    keys,
    environment: jest.fn(async () => ({ attest: true, deviceCheck: true, mac: false, catalyst: false, vision: false, simulator: false, idiom: 'phone', ...env })),
    generateKey: jest.fn(async () => {
      const k = newKey();
      const id = Buffer.from(sha256(Buffer.from(k.point, 'hex'))).toString('base64');
      keys.set(id, k);
      return id;
    }),
    attestKey: jest.fn(async (id) => {
      if (!keys.has(id)) throw nativeError('INVALID_KEY');
      return attestationOf(keys.get(id).spki).toString('base64');
    }),
    generateAssertion: jest.fn(async (id, hashB64) => {
      if (!keys.has(id)) throw nativeError('INVALID_KEY');
      return Buffer.concat([Buffer.from('assert:'), Buffer.from(hashB64, 'base64')]).toString('base64');
    }),
    deviceCheckToken: jest.fn(async () => Buffer.from('device-check-token').toString('base64')),
  };
  return f;
}
function androidFake(report = REPORT) {
  const keys = new Map(); // alias -> key
  return {
    keys,
    environment: jest.fn(async () => ({ report, strongBox: true })),
    createKey: jest.fn(async (alias, challengeB64) => {
      if (keys.has(alias)) throw nativeError('KEYSTORE');
      const k = { ...newKey(), challenge: challengeB64 };
      keys.set(alias, k);
      return { chain: [certOf(k.spki).toString('base64'), certOf(newKey().spki).toString('base64')], strongBox: true };
    }),
    sign: jest.fn(async (alias, dataB64) => {
      if (!keys.has(alias)) throw nativeError('KEY_MISSING');
      return nodeCrypto.sign('sha256', Buffer.from(dataB64, 'base64'), { key: keys.get(alias).privateKey, dsaEncoding: 'der' }).toString('base64');
    }),
    hasKey: jest.fn(async (alias) => keys.has(alias)),
    deleteKey: jest.fn(async (alias) => { keys.delete(alias); return null; }),
    integrityToken: jest.fn(async (nonce) => `play-token.${nonce}`),
    showPlayDialog: jest.fn(async () => 'ok'),
  };
}
function use(os, f) {
  Platform.OS = os;
  fake = f;
  NativeModules.QNetDeviceAttest = f;
}

beforeEach(() => items.clear());
afterAll(() => {
  Platform.OS = OS;
  delete NativeModules.QNetDeviceAttest;
});

const enrolText = (flags, n = 1) => P.enrolPreimage({ nodeId: W.nodeId, wallet: W.address, pingPublicKey: V.pingKey.publicKey, seq: 1790000000, nonce: nonceOf(n), flags });
const rotateText = (oldPoint, n = 2) => P.rotatePreimage({ nodeId: W.nodeId, oldHwPublicKey: oldPoint, pingPublicKey: V.pingKey.publicKey, seq: 1790000000, nonce: nonceOf(n) });

describe('what this device may try', () => {
  it('iOS: an iPhone or iPad app on an iPhone or iPad with App Attest, whatever its system version', async () => {
    use('ios', iosFake());
    expect(await K.checkDevice()).toEqual({ capable: true, platform: 'ios', flags: 'mac=0,vision=0,idiom=phone', report: null });
    use('ios', iosFake({ idiom: 'pad', systemVersion: '14.0' }));
    expect(await K.checkDevice()).toEqual({ capable: true, platform: 'ios', flags: 'mac=0,vision=0,idiom=pad', report: null });
    for (const env of [{ mac: true }, { catalyst: true }, { vision: true }, { idiom: 'other' }]) {
      use('ios', iosFake(env));
      expect([env, await K.checkDevice()]).toEqual([env, { capable: false, reason: 'device_desktop' }]);
    }
    for (const env of [{ attest: false }, { simulator: true }]) {
      use('ios', iosFake(env));
      expect([env, await K.checkDevice()]).toEqual([env, { capable: false, reason: 'device_unsupported' }]);
    }
  });

  it('Android: a touchscreen phone or tablet in its main user; the report and its flags as the spec writes them', async () => {
    use('android', androidFake());
    const ok = await K.checkDevice();
    expect(ok).toEqual({ capable: true, platform: 'android', report: V.device.report.text, flags: `r=${V.device.report.sha3}` });
    for (const [change, reason] of [
      [{ system_user: false }, 'device_secondary_user'], [{ hsum: true }, 'device_secondary_user'],
      [{ feature_pc: true }, 'device_desktop'], [{ arc: true }, 'device_desktop'], [{ leanback: true }, 'device_desktop'],
      [{ watch: true }, 'device_desktop'], [{ automotive: true }, 'device_desktop'], [{ embedded: true }, 'device_desktop'],
      [{ touchscreen: false }, 'device_desktop'], [{ watch: 'no' }, 'device_unsupported'],
    ]) {
      use('android', androidFake({ ...REPORT, ...change }));
      expect([change, await K.checkDevice()]).toEqual([change, { capable: false, reason }]);
    }
  });

  it('a build without the module, or another platform, cannot try', async () => {
    use('ios', null);
    expect(await K.checkDevice()).toEqual({ capable: false, reason: 'device_unsupported' });
    await expect(K.enrolEvidence({ preimage: enrolText('mac=0,vision=0,idiom=phone'), flags: 'mac=0,vision=0,idiom=phone' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED' });
    use('web', iosFake());
    expect(await K.checkDevice()).toEqual({ capable: false, reason: 'device_unsupported' });
    expect(K.platform()).toBe(null);
  });
});

describe('iOS', () => {
  const flags = 'mac=0,vision=0,idiom=phone';

  it('an enrolment: Apple attests a new key over SHA-256(E); the block, the DeviceCheck token, the key pending', async () => {
    use('ios', iosFake());
    const E = enrolText(flags);
    const ev = await K.enrolEvidence({ preimage: E, flags });
    const [keyId, hashB64] = fake.attestKey.mock.calls[0];
    expect(hexOf(Buffer.from(hashB64, 'base64'))).toBe(hexOf(P.deviceChallengeHash(E)));
    const k = fake.keys.get(keyId);
    expect(ev.key).toEqual({ platform: 'ios', handle: keyId, hwPub: k.point, attested: true });
    expect(ev.device).toEqual({ platform: 'ios', key_id: b64u(Buffer.from(keyId, 'base64')), attestation: b64u(attestationOf(k.spki)), flags });
    expect(Buffer.from(ev.device.key_id, 'base64url')).toEqual(Buffer.from(sha256(Buffer.from(k.point, 'hex'))));
    expect(ev.token).toEqual({ field: 'dc_token', value: b64u(Buffer.from('device-check-token')) });
    expect([ev.tokenError, ev.playNonce]).toEqual([null, null]);
    expect(await K.currentKey()).toBe(null);
    expect(await K.pendingKey()).toEqual(ev.key);
    expect(items.get(K.NODE_DEVICE_KEY_SERVICE).accessible).toBe('afterFirstUnlockThisDeviceOnly');
    expect(await K.commitKey(ev.key)).toEqual(ev.key);
    expect(await K.currentKey()).toEqual(ev.key);
    expect(await K.pendingKey()).toBe(null);
  });

  it('Apple\'s server unavailable: the same key is attested on the next try, so the key count does not grow', async () => {
    use('ios', iosFake());
    fake.attestKey.mockRejectedValueOnce(nativeError('SERVER_UNAVAILABLE'));
    await expect(K.enrolEvidence({ preimage: enrolText(flags), flags })).rejects.toMatchObject({ code: 'BUSY' });
    expect(record().pending).toMatchObject({ attested: false, hwPub: null });
    const ev = await K.enrolEvidence({ preimage: enrolText(flags, 3), flags });
    expect(fake.generateKey).toHaveBeenCalledTimes(1);
    expect(fake.attestKey.mock.calls.map((c) => c[0])).toEqual([ev.key.handle, ev.key.handle]);
    // any other failure drops the key: the next try makes a new one
    fake.attestKey.mockRejectedValueOnce(nativeError('INVALID_INPUT'));
    await expect(K.enrolEvidence({ preimage: enrolText(flags, 4), flags })).rejects.toMatchObject({ code: 'INVALID' });
    expect(record()).toBe(null);
  });

  it('an attestation that certifies another key is never sent', async () => {
    use('ios', iosFake());
    fake.attestKey.mockImplementationOnce(async () => attestationOf(newKey().spki).toString('base64'));
    await expect(K.enrolEvidence({ preimage: enrolText(flags), flags })).rejects.toMatchObject({ code: 'FAILED' });
    fake.attestKey.mockImplementationOnce(async () => Buffer.from('not cbor').toString('base64'));
    await expect(K.enrolEvidence({ preimage: enrolText(flags), flags })).rejects.toMatchObject({ code: 'FAILED' });
    expect(record()).toBe(null);
  });

  it('signs as assertions over SHA-256(P); a key iOS no longer has is KEY_GONE', async () => {
    use('ios', iosFake());
    const ev = await K.enrolEvidence({ preimage: enrolText(flags), flags });
    const key = await K.commitKey(ev.key);
    const text = P.refreshPreimage(W.nodeId, nonceOf(9));
    const sig = await K.sign(key, text);
    expect(Buffer.from(sig, 'base64url')).toEqual(Buffer.concat([Buffer.from('assert:'), Buffer.from(P.deviceChallengeHash(text))]));
    fake.keys.clear();
    await expect(K.sign(key, text)).rejects.toMatchObject({ code: 'KEY_GONE' });
    await expect(K.sign({ ...key, platform: 'android' }, text)).rejects.toMatchObject({ code: 'INVALID' });
    await expect(K.sign(key, '')).rejects.toThrow();
  });

  it('a rotation: the old key asserts the preimage naming it, a new key is attested over it', async () => {
    use('ios', iosFake());
    const old = await K.commitKey((await K.enrolEvidence({ preimage: enrolText(flags), flags })).key);
    const R = rotateText(old.hwPub);
    const ev = await K.rotationEvidence({ preimage: R, flags });
    expect(Buffer.from(ev.oldSig, 'base64url')).toEqual(Buffer.concat([Buffer.from('assert:'), Buffer.from(P.deviceChallengeHash(R))]));
    expect(fake.generateAssertion.mock.calls[0][0]).toBe(old.handle);
    expect(ev.key.handle).not.toBe(old.handle);
    expect(ev.device).toMatchObject({ platform: 'ios', flags });
    expect(ev.token.field).toBe('dc_token');
    expect(await K.currentKey()).toEqual(old);
    await K.commitKey(ev.key);
    expect(await K.currentKey()).toEqual(ev.key);
    await expect(K.rotationEvidence({ preimage: rotateText(old.hwPub, 5) })).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('a re-enrolment with reuse: the current key asserts SHA-256(E), no new key is attested', async () => {
    use('ios', iosFake());
    const old = await K.commitKey((await K.enrolEvidence({ preimage: enrolText(flags), flags })).key);
    const E = enrolText(flags, 6);
    const ev = await K.enrolEvidence({ preimage: E, flags, reuse: true });
    expect([fake.generateKey.mock.calls.length, fake.attestKey.mock.calls.length]).toEqual([1, 1]);
    expect(fake.generateAssertion.mock.calls[0][0]).toBe(old.handle);
    expect(ev.key).toEqual(old);
    expect(ev.device).toEqual({
      platform: 'ios', key_id: b64u(Buffer.from(old.handle, 'base64')), flags,
      assertion: b64u(Buffer.concat([Buffer.from('assert:'), Buffer.from(P.deviceChallengeHash(E))])),
    });
    expect([ev.token.field, ev.playNonce]).toEqual(['dc_token', null]);
    expect(await K.pendingKey()).toEqual(old);
    expect(await K.commitKey(ev.key)).toEqual(old);
    expect([await K.currentKey(), await K.pendingKey()]).toEqual([old, null]);
    // a re-enrolment the node did not take keeps the current key
    const again = await K.enrolEvidence({ preimage: enrolText(flags, 7), flags, reuse: true });
    await K.dropPendingKey(again.key);
    expect([await K.currentKey(), await K.pendingKey()]).toEqual([old, null]);
  });

  it('reuse without a current key, or with one iOS no longer has, attests a new key; other failures are thrown', async () => {
    use('ios', iosFake());
    const first = await K.enrolEvidence({ preimage: enrolText(flags), flags, reuse: true });
    expect(Object.keys(first.device).sort()).toEqual(['attestation', 'flags', 'key_id', 'platform']);
    const old = await K.commitKey(first.key);
    fake.keys.delete(old.handle);
    const ev = await K.enrolEvidence({ preimage: enrolText(flags, 8), flags, reuse: true });
    expect(ev.key.handle).not.toBe(old.handle);
    expect(Object.keys(ev.device).sort()).toEqual(['attestation', 'flags', 'key_id', 'platform']);
    await K.commitKey(ev.key);
    expect(await K.currentKey()).toEqual(ev.key);
    fake.generateAssertion.mockRejectedValueOnce(nativeError('UNKNOWN'));
    await expect(K.enrolEvidence({ preimage: enrolText(flags, 9), flags, reuse: true })).rejects.toMatchObject({ code: 'FAILED' });
    expect([await K.currentKey(), await K.pendingKey()]).toEqual([ev.key, null]);
    expect(fake.generateKey).toHaveBeenCalledTimes(2);
  });

  it('without DeviceCheck the key is still made; the token error says why', async () => {
    use('ios', iosFake());
    fake.deviceCheckToken.mockRejectedValueOnce(nativeError('UNSUPPORTED'));
    const ev = await K.enrolEvidence({ preimage: enrolText(flags), flags });
    expect([ev.token, ev.tokenError]).toEqual([null, 'UNSUPPORTED']);
    expect(await K.pendingKey()).toEqual(ev.key);
    expect(await K.showPlayDialog('licence')).toBe('unavailable');
  });
});

describe('Android', () => {
  const report = V.device.report.text;
  const flags = P.androidFlags(report);

  it('an enrolment: a Keystore key made with SHA-256(E) as its challenge, the chain, the signed report, the Play token', async () => {
    use('android', androidFake());
    const E = enrolText(flags);
    const ev = await K.enrolEvidence({ preimage: E, flags, report });
    const [alias, challengeB64] = fake.createKey.mock.calls[0];
    expect(alias).toMatch(/^qnet_dev_[0-9a-f]{32}$/);
    expect(hexOf(Buffer.from(challengeB64, 'base64'))).toBe(hexOf(P.deviceChallengeHash(E)));
    const k = fake.keys.get(alias);
    expect(ev.key).toEqual({ platform: 'android', handle: alias, hwPub: k.point, attested: true });
    expect(ev.device.platform).toBe('android');
    expect(ev.device.chain).toHaveLength(2);
    expect(ev.device.chain[0]).toBe(b64u(certOf(k.spki)));
    expect(ev.device.report).toBe(report);
    expect(verify(k.point, report, ev.device.report_sig)).toBe(true);
    expect(ev.playNonce).toBe(P.playNonceForEnrol(E, k.point, report));
    expect(fake.integrityToken).toHaveBeenCalledWith(ev.playNonce);
    expect(ev.token).toEqual({ field: 'pi_token', value: `play-token.${ev.playNonce}` });
    expect(await K.pendingKey()).toEqual(ev.key);
  });

  it('a Play failure its dialog can fix leaves the key pending; the token is asked for again after the dialog', async () => {
    use('android', androidFake());
    fake.integrityToken.mockRejectedValueOnce(nativeError('PLAY_FIXABLE'));
    const ev = await K.enrolEvidence({ preimage: enrolText(flags), flags, report });
    expect([ev.token, ev.tokenError]).toEqual([null, 'PLAY_FIXABLE']);
    expect(await K.showPlayDialog('integrity')).toBe('ok');
    expect(fake.showPlayDialog).toHaveBeenCalledWith('integrity');
    expect(await K.vendorToken(ev.playNonce)).toEqual({ field: 'pi_token', value: `play-token.${ev.playNonce}` });
    for (const [code, want] of [['PLAY_UNAVAILABLE', 'PLAY_UNAVAILABLE'], ['PLAY_BUSY', 'BUSY'], ['PLAY_FAILED', 'FAILED']]) {
      fake.integrityToken.mockRejectedValueOnce(nativeError(code));
      await expect(K.vendorToken(ev.playNonce)).rejects.toMatchObject({ code: want });
    }
    await expect(K.vendorToken('short')).rejects.toMatchObject({ code: 'INVALID' });
    fake.showPlayDialog.mockRejectedValueOnce(nativeError('INVALID_INPUT'));
    expect(await K.showPlayDialog('strong')).toBe('failed');
  });

  it('the report must be canonical and match the flags inside E', async () => {
    use('android', androidFake());
    const other = P.androidReport({ ...REPORT, touchscreen: false });
    await expect(K.enrolEvidence({ preimage: enrolText(flags), flags, report: other })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(K.enrolEvidence({ preimage: enrolText(flags), flags, report: report.replace(',', ', ') })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(K.enrolEvidence({ preimage: enrolText(flags), flags: P.androidFlags(other), report: other })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(K.enrolEvidence({ preimage: rotateText(V.device.keys.android.publicKey), flags, report })).rejects.toMatchObject({ code: 'INVALID' });
    expect(fake.createKey).not.toHaveBeenCalled();
  });

  it('a chain that certifies no P-256 key: the key is deleted and nothing is kept', async () => {
    use('android', androidFake());
    fake.createKey.mockImplementationOnce(async (alias) => {
      fake.keys.set(alias, newKey());
      return { chain: [Buffer.from('garbage').toString('base64')], strongBox: false };
    });
    await expect(K.enrolEvidence({ preimage: enrolText(flags), flags, report })).rejects.toMatchObject({ code: 'FAILED' });
    expect(fake.keys.size).toBe(0);
    expect(record()).toBe(null);
    fake.createKey.mockRejectedValueOnce(nativeError('KEYSTORE_BUSY'));
    await expect(K.enrolEvidence({ preimage: enrolText(flags), flags, report })).rejects.toMatchObject({ code: 'BUSY' });
  });

  it('reuse makes a new key all the same: the attestation challenge is the preimage', async () => {
    use('android', androidFake());
    const old = await K.commitKey((await K.enrolEvidence({ preimage: enrolText(flags), flags, report })).key);
    const ev = await K.enrolEvidence({ preimage: enrolText(flags, 2), flags, report, reuse: true });
    expect(fake.createKey).toHaveBeenCalledTimes(2);
    expect(ev.key.handle).not.toBe(old.handle);
    expect(ev.device).toHaveProperty('chain');
    expect(await K.currentKey()).toEqual(old);
  });

  it('a new enrolment replaces a pending key and deletes it; a dropped key is deleted too', async () => {
    use('android', androidFake());
    const first = await K.enrolEvidence({ preimage: enrolText(flags), flags, report });
    const second = await K.enrolEvidence({ preimage: enrolText(flags, 2), flags, report });
    expect(fake.deleteKey).toHaveBeenCalledWith(first.key.handle);
    expect([...fake.keys.keys()]).toEqual([second.key.handle]);
    await expect(K.commitKey(first.key)).rejects.toMatchObject({ code: 'INVALID' });
    await K.dropPendingKey(first.key); // no longer the pending key: nothing is dropped (MN-R3-02)
    expect([...fake.keys.keys()]).toEqual([second.key.handle]);
    await K.dropPendingKey(second.key);
    expect(fake.keys.size).toBe(0);
    expect(record()).toBe(null);
  });

  it('signs DER ECDSA-SHA256 over the preimage; a deleted key is KEY_GONE', async () => {
    use('android', androidFake());
    const key = await K.commitKey((await K.enrolEvidence({ preimage: enrolText(flags), flags, report })).key);
    const H = P.hwPingPreimage({ nodeId: W.nodeId, height: V.anchor.height, hash: V.anchor.hash, sigma: 'ab'.repeat(3309), hwSeq: 1790000000123 });
    expect(verify(key.hwPub, H, await K.sign(key, H))).toBe(true);
    fake.keys.clear();
    await expect(K.sign(key, H)).rejects.toMatchObject({ code: 'KEY_GONE' });
  });

  it('a rotation: the old key signs, a new key with a fresh report; commit makes it current and deletes the old one', async () => {
    use('android', androidFake());
    const old = await K.commitKey((await K.enrolEvidence({ preimage: enrolText(flags), flags, report })).key);
    const R = rotateText(old.hwPub);
    const ev = await K.rotationEvidence({ preimage: R, report });
    expect(verify(old.hwPub, R, ev.oldSig)).toBe(true);
    expect(hexOf(Buffer.from(fake.createKey.mock.calls[1][1], 'base64'))).toBe(hexOf(P.deviceChallengeHash(R)));
    expect(verify(ev.key.hwPub, report, ev.device.report_sig)).toBe(true);
    expect(ev.playNonce).toBe(P.playNonce(R));
    expect(ev.token).toEqual({ field: 'pi_token', value: `play-token.${P.playNonce(R)}` });
    expect(await K.currentKey()).toEqual(old);
    await K.commitKey(ev.key);
    expect(await K.currentKey()).toEqual(ev.key);
    expect(fake.deleteKey).toHaveBeenCalledWith(old.handle);
    expect([...fake.keys.keys()]).toEqual([ev.key.handle]);
    await expect(K.rotationEvidence({ preimage: rotateText(old.hwPub, 3), report })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(K.rotationEvidence({ preimage: rotateText(ev.key.hwPub, 3), report: '{}' })).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('forgetting removes every key of the install and the record', async () => {
    use('android', androidFake());
    await K.commitKey((await K.enrolEvidence({ preimage: enrolText(flags), flags, report })).key);
    await K.enrolEvidence({ preimage: enrolText(flags, 2), flags, report });
    expect(fake.keys.size).toBe(2);
    await K.forgetKeys();
    expect(fake.keys.size).toBe(0);
    expect(record()).toBe(null);
    await expect(K.rotationEvidence({ preimage: rotateText(V.device.keys.android.publicKey), report })).rejects.toMatchObject({ code: 'KEY_GONE' });
  });
});

describe('the stored record', () => {
  it('another platform\'s key, a foreign alias or a malformed record reads as none', async () => {
    use('android', androidFake());
    const good = { platform: 'android', handle: 'qnet_dev_ab', hwPub: V.device.keys.android.publicKey, attested: true };
    const put = (r) => items.set(K.NODE_DEVICE_KEY_SERVICE, { username: 'device_key', password: typeof r === 'string' ? r : JSON.stringify(r) });
    put({ current: good, pending: null });
    expect(await K.currentKey()).toEqual(good);
    for (const bad of [
      { current: { ...good, platform: 'ios' } }, { current: { ...good, handle: 'qnet_vault_seal_v2' } },
      { current: { ...good, hwPub: '04ab' } }, { current: { ...good, handle: 'qnet_dev_'.padEnd(65, 'a') } }, '{not json',
    ]) {
      put(bad);
      expect(await K.currentKey()).toBe(null);
    }
    use('ios', iosFake());
    put({ current: { platform: 'ios', handle: 'id', hwPub: null, attested: true } });
    expect(await K.currentKey()).toBe(null);
  });

  it('the public status\'s tag names this install\'s current key, for the read\'s nonce (section 5.9)', async () => {
    const S = V.device.status;
    const put = (r) => items.set(K.NODE_DEVICE_KEY_SERVICE, { username: 'device_key', password: JSON.stringify(r) });
    for (const [platform, other] of [['ios', 'android'], ['android', 'ios']]) {
      use(platform, platform === 'ios' ? iosFake() : androidFake());
      put({ current: { platform, handle: platform === 'ios' ? 'aWQ=' : 'qnet_dev_ab', hwPub: V.device.keys[platform].publicKey, attested: true } });
      expect(await K.isThisDevice(S.nonce, [S.deviceTagH[platform]])).toBe(true);
      // One owner naming another key tells nothing (it may not have the last rotation yet); two do, unless one names ours.
      expect(await K.isThisDevice(S.nonce, [S.deviceTagH[other]])).toBe(null);
      expect(await K.isThisDevice(S.nonce, [S.deviceTagH[other], S.deviceTagH[other]])).toBe(false);
      expect(await K.isThisDevice(S.nonce, [S.deviceTagH[other], S.deviceTagH[platform]])).toBe(true);
      expect(await K.isThisDevice(S.nonce, [])).toBe(null);
    }
    items.clear();
    expect(await K.isThisDevice(S.nonce, [S.deviceTagH.android])).toBe(null);
  });

  it('a rotation that got no answer is settled by the tag the node shows: the new key becomes current, or goes', async () => {
    use('android', androidFake());
    const S = V.device.status;
    const put = (r) => items.set(K.NODE_DEVICE_KEY_SERVICE, { username: 'device_key', password: JSON.stringify(r) });
    const OLD = { platform: 'android', handle: 'qnet_dev_old', hwPub: V.device.keys.android.publicKey, attested: true };
    const NEW = { platform: 'android', handle: 'qnet_dev_new', hwPub: V.device.keys.androidRotated.publicKey, attested: true };
    const tagNew = P.deviceTagH(S.nonce, P.deviceTag('android', NEW.hwPub));
    fake.keys.set(OLD.handle, {});
    fake.keys.set(NEW.handle, {});
    put({ current: OLD, pending: NEW });
    // The pending key of an enrolment still under way is never settled by a status.
    expect(await K.settleByTag(S.nonce, [tagNew])).toBe(null);
    const sent = Date.now();
    await K.keepUnanswered(NEW, sent);
    expect(await K.hasUnansweredKey()).toBe(true);
    expect(await K.settleByTag(S.nonce, ['ffffffffffffffff'])).toBe(null);
    expect(await K.settleByTag(S.nonce, [S.deviceTagH.android, tagNew])).toBe('pending');
    expect(record()).toEqual({ current: NEW, pending: null });
    expect(fake.keys.has(OLD.handle)).toBe(false);
    // The node still names the old key, once the new key had its time: the new one goes.
    put({ current: OLD, pending: { ...NEW, unanswered: true, sentAt: sent } });
    fake.keys.set(NEW.handle, {});
    const later = sent + K.UNANSWERED_SETTLE_MS;
    expect(await K.settleByTag(S.nonce, [S.deviceTagH.android, S.deviceTagH.android], later)).toBe('current');
    expect(record()).toEqual({ current: OLD, pending: null });
    expect(fake.keys.has(NEW.handle)).toBe(false);
    expect(await K.hasUnansweredKey()).toBe(false);
  });

  // MN-R1-01: the node may take a rotation for up to 95 s after the app's 8 s gave up, and its statement reaches the other
  // owners later still: no read made meanwhile, and no single owner, drops a key the node then holds.
  it('an unanswered key survives reads that still name the current key until its time is over and two owners agree', async () => {
    use('android', androidFake());
    const S = V.device.status;
    const put = (r) => items.set(K.NODE_DEVICE_KEY_SERVICE, { username: 'device_key', password: JSON.stringify(r) });
    const OLD = { platform: 'android', handle: 'qnet_dev_old', hwPub: V.device.keys.android.publicKey, attested: true };
    const NEW = { platform: 'android', handle: 'qnet_dev_new', hwPub: V.device.keys.androidRotated.publicKey, attested: true };
    const tagOld = S.deviceTagH.android;
    const tagNew = P.deviceTagH(S.nonce, P.deviceTag('android', NEW.hwPub));
    fake.keys.set(OLD.handle, {});
    fake.keys.set(NEW.handle, {});
    put({ current: OLD, pending: NEW });
    const sent = 1_790_000_000_000;
    await K.keepUnanswered(NEW, sent);
    expect(record().pending).toEqual({ ...NEW, unanswered: true, sentAt: sent });
    // The Node tab 30 s later: every owner still names the old key. Nothing is dropped, the Keystore key stays.
    expect(await K.settleByTag(S.nonce, [tagOld, tagOld, tagOld], sent + 30_000)).toBe(null);
    expect(await K.settleByTag(S.nonce, [tagOld, tagOld], sent + K.UNANSWERED_SETTLE_MS - 1)).toBe(null);
    expect(fake.keys.has(NEW.handle)).toBe(true);
    expect(await K.hasUnansweredKey()).toBe(true);
    // Past its time, one owner alone still decides nothing.
    expect(await K.settleByTag(S.nonce, [tagOld], sent + K.UNANSWERED_SETTLE_MS)).toBe(null);
    expect(fake.keys.has(NEW.handle)).toBe(true);
    // The node finished the rotation: one owner naming the new key makes it current at once, whatever the others say.
    expect(await K.settleByTag(S.nonce, [tagOld, tagNew], sent + 60_000)).toBe('pending');
    expect(record()).toEqual({ current: NEW, pending: null });
    expect(fake.keys.has(OLD.handle)).toBe(false);
    // A clock set back past the send counts as time passed: the key never holds rotations back for ever.
    fake.keys.set(OLD.handle, {});
    put({ current: NEW, pending: { ...OLD, unanswered: true, sentAt: sent } });
    expect(await K.settleByTag(S.nonce, [tagNew, tagNew], sent - 86_400_000)).toBe('current');
    expect(fake.keys.has(OLD.handle)).toBe(false);
  });

  // MN-R4-07: the node re-sends a statement to the other owners after 15 s, 2 min, 10 min and 1 h (node batch R6). Owners
  // that missed the first three and still name the old key at minute 16 drop nothing: the key waits past the last re-send.
  it('an unanswered key outlives the statement\'s last re-send, an hour after it went', async () => {
    use('android', androidFake());
    const S = V.device.status;
    const put = (r) => items.set(K.NODE_DEVICE_KEY_SERVICE, { username: 'device_key', password: JSON.stringify(r) });
    const OLD = { platform: 'android', handle: 'qnet_dev_old', hwPub: V.device.keys.android.publicKey, attested: true };
    const NEW = { platform: 'android', handle: 'qnet_dev_new', hwPub: V.device.keys.androidRotated.publicKey, attested: true };
    const tagOld = S.deviceTagH.android;
    fake.keys.set(OLD.handle, {});
    fake.keys.set(NEW.handle, {});
    put({ current: OLD, pending: NEW });
    const sent = 1_790_000_000_000;
    await K.keepUnanswered(NEW, sent);
    expect(K.UNANSWERED_SETTLE_MS).toBeGreaterThan(60 * 60_000);
    for (const minutes of [16, 30, 61, 70]) {
      expect(await K.settleByTag(S.nonce, [tagOld, tagOld, tagOld], sent + minutes * 60_000)).toBe(null);
    }
    expect(fake.keys.has(NEW.handle)).toBe(true);
    expect(await K.hasUnansweredKey()).toBe(true);
    // Once the last re-send had its time, two owners naming the old key settle it.
    expect(await K.settleByTag(S.nonce, [tagOld, tagOld], sent + K.UNANSWERED_SETTLE_MS)).toBe('current');
    expect(fake.keys.has(NEW.handle)).toBe(false);
  });

  it('changes of the record run one at a time', async () => {
    use('android', androidFake());
    const report = V.device.report.text;
    const flags = P.androidFlags(report);
    const [a, b] = await Promise.all([
      K.enrolEvidence({ preimage: enrolText(flags), flags, report }),
      K.enrolEvidence({ preimage: enrolText(flags, 2), flags, report }),
    ]);
    expect(await K.pendingKey()).toEqual(b.key);
    expect(fake.keys.has(a.key.handle)).toBe(false);
  });
});

// Final audit round 2 (MN2-04, MN2-10): a rotation makes no key it cannot use, and a key that is gone is named, so only
// that key is forgotten.
describe('round 2: the rotation\'s token first, and the key a failure names', () => {
  const report = V.device.report.text;
  const flags = P.androidFlags(report);
  const iosFlags = 'mac=0,vision=0,idiom=phone';

  it('Android: without a Play token no key is made; the token is asked for with the preimage\'s nonce first', async () => {
    use('android', androidFake());
    const old = await K.commitKey((await K.enrolEvidence({ preimage: enrolText(flags), flags, report })).key);
    fake.integrityToken.mockRejectedValueOnce(nativeError('PLAY_BUSY'));
    await expect(K.rotationEvidence({ preimage: rotateText(old.hwPub), report })).rejects.toMatchObject({ code: 'BUSY' });
    expect(fake.createKey).toHaveBeenCalledTimes(1); // the enrolment's only
    expect([await K.currentKey(), await K.pendingKey()]).toEqual([old, null]);
    fake.integrityToken.mockRejectedValueOnce(nativeError('PLAY_UNAVAILABLE'));
    await expect(K.rotationEvidence({ preimage: rotateText(old.hwPub, 4), report })).rejects.toMatchObject({ code: 'PLAY_UNAVAILABLE' });
    expect(fake.createKey).toHaveBeenCalledTimes(1);
    const R = rotateText(old.hwPub, 5);
    const ev = await K.rotationEvidence({ preimage: R, report });
    expect(fake.integrityToken).toHaveBeenLastCalledWith(P.playNonce(R));
    expect(ev).toMatchObject({ token: { field: 'pi_token', value: `play-token.${P.playNonce(R)}` }, tokenError: null });
    expect(fake.createKey).toHaveBeenCalledTimes(2);
  });

  it('iOS: without a DeviceCheck token Apple attests no key', async () => {
    use('ios', iosFake());
    const old = await K.commitKey((await K.enrolEvidence({ preimage: enrolText(iosFlags), flags: iosFlags })).key);
    fake.deviceCheckToken.mockRejectedValueOnce(nativeError('SERVER_UNAVAILABLE'));
    await expect(K.rotationEvidence({ preimage: rotateText(old.hwPub), flags: iosFlags })).rejects.toMatchObject({ code: 'BUSY' });
    expect([fake.generateKey.mock.calls.length, fake.attestKey.mock.calls.length]).toEqual([1, 1]);
    expect(await K.pendingKey()).toBe(null);
  });

  it('with too little of the deadline left once the token came, no key is made (BUSY)', async () => {
    use('android', androidFake());
    const old = await K.commitKey((await K.enrolEvidence({ preimage: enrolText(flags), flags, report })).key);
    await expect(K.rotationEvidence({ preimage: rotateText(old.hwPub), report, deadline: Date.now() + 1000, minLeftMs: 7500 }))
      .rejects.toMatchObject({ code: 'BUSY' });
    expect(fake.createKey).toHaveBeenCalledTimes(1);
    const ev = await K.rotationEvidence({ preimage: rotateText(old.hwPub, 6), report, deadline: Date.now() + 20000, minLeftMs: 7500 });
    expect(ev.key.handle).not.toBe(old.handle);
  });

  it('a signature that finds its key gone names that key', async () => {
    use('android', androidFake());
    const key = await K.commitKey((await K.enrolEvidence({ preimage: enrolText(flags), flags, report })).key);
    fake.keys.clear();
    await expect(K.sign(key, 'x')).rejects.toMatchObject({ code: 'KEY_GONE', key });
  });

  it('forgetKey forgets that key only, and says whether it was the current one', async () => {
    use('android', androidFake());
    const old = await K.commitKey((await K.enrolEvidence({ preimage: enrolText(flags), flags, report })).key);
    const ev = await K.rotationEvidence({ preimage: rotateText(old.hwPub), report });
    const fresh = await K.commitKey(ev.key); // the rotation finished: `old` is gone, `fresh` is current
    expect(await K.forgetKey(old)).toBe(false);
    expect(await K.currentKey()).toEqual(fresh);
    expect(fake.keys.has(fresh.handle)).toBe(true);
    expect(await K.forgetKey(fresh)).toBe(true);
    expect([await K.currentKey(), await K.pendingKey()]).toEqual([null, null]);
    expect(fake.keys.has(fresh.handle)).toBe(false);
  });

  // M2: an error about the key being made never reads as the current key being gone, which callers forget.
  it('a new key that fails while it is made is FAILED, never KEY_GONE; the current key stays', async () => {
    use('ios', iosFake());
    const old = await K.commitKey((await K.enrolEvidence({ preimage: enrolText(iosFlags), flags: iosFlags })).key);
    fake.attestKey.mockImplementationOnce(async () => { throw nativeError('INVALID_KEY'); });
    await expect(K.rotationEvidence({ preimage: rotateText(old.hwPub), flags: iosFlags })).rejects.toMatchObject({ code: 'FAILED' });
    expect(await K.currentKey()).toEqual(old);
    use('android', androidFake());
    const cur = await K.commitKey((await K.enrolEvidence({ preimage: enrolText(flags), flags, report })).key);
    const sign = fake.sign.getMockImplementation();
    fake.sign.mockImplementation(async (alias, data) => {
      if (alias !== cur.handle) throw nativeError('KEY_MISSING');
      return sign(alias, data);
    });
    await expect(K.rotationEvidence({ preimage: rotateText(cur.hwPub), report })).rejects.toMatchObject({ code: 'FAILED' });
    expect(await K.currentKey()).toEqual(cur);
    // A Keystore that did not answer is BUSY, not a key that is gone.
    fake.sign.mockImplementation(async () => { throw nativeError('KEYSTORE_BUSY'); });
    await expect(K.sign(cur, 'x')).rejects.toMatchObject({ code: 'BUSY' });
  });
});
