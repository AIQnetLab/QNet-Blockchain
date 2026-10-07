/**
 * The shared light node vectors (docs/protocols/light-node.vectors.json), the app's side: the file is what its
 * generator writes; the identity the app derives from a phrase; every wallet-key, ping-key and device message the app
 * builds (src/crypto/NodePreimages.js) and the signatures over them; and QNet Link revision 2 with the app's own
 * X25519 / HKDF / AES-GCM. P-256 checks run on node:crypto, independent of the app's libraries.
 */
const { spawnSync } = require('child_process');
const nodeCrypto = require('crypto');
const path = require('path');
const bip39 = require('bip39');
const nacl = require('tweetnacl');
const { sha3_256, shake256 } = require('js-sha3');
const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');
const { sha256 } = require('@noble/hashes/sha2.js');
const { hkdf } = require('@noble/hashes/hkdf.js');
const { gcm } = require('@noble/ciphers/aes.js');
const { x25519 } = require('@noble/curves/ed25519');
const P = require('../src/crypto/NodePreimages');
const { walletSeedString, eonFromPublicKeyBytes } = require('../src/crypto/WalletIdentity');
const { WalletManager } = require('../src/components/WalletManager');
const kat = require('./fixtures/wallet_kat.json');

const REPO = path.join(__dirname, '../../..');
const V = require('../../../docs/protocols/light-node.vectors.json');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const hexOf = (b) => Buffer.from(b).toString('hex');
const utf8 = (s) => new TextEncoder().encode(s);
const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Uint8Array.from(Buffer.from(s, 'base64url'));
const walletOf = (name) => V.wallets.find((w) => w.name === name);

describe('the vector file', () => {
  it('is exactly what its generator writes', () => {
    const run = spawnSync(process.execPath, [path.join(REPO, 'docs/protocols/tools/light-node-vectors.mjs'), '--check'],
      { encoding: 'utf8', timeout: 120000 });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
  });
});

describe('identity', () => {
  it('the KAT wallet is the one the node pins', () => {
    const w = walletOf('kat-12');
    expect([w.seedString, w.xi, w.publicKey, w.address]).toEqual([kat.seed_string, kat.xi_shake256, kat.pk_hex, kat.eon_address]);
  });

  it.each(V.wallets.map((w) => [w.name, w]))('%s: seed, key, address, node id and wallet hash', (_, w) => {
    const seed = bip39.mnemonicToSeedSync(w.mnemonic);
    expect(hexOf(seed)).toBe(w.phraseSeedHex);
    expect(walletSeedString(seed)).toBe(w.seedString);
    expect(shake256(w.seedString, 256)).toBe(w.xi);
    const { publicKey } = ml_dsa65.keygen(bytes(w.xi));
    expect(hexOf(publicKey)).toBe(w.publicKey);
    expect(sha3_256(publicKey)).toBe(w.publicKeySha3);
    expect(P.publicKeySha3(w.publicKey)).toBe(w.publicKeySha3);
    expect(eonFromPublicKeyBytes(publicKey)).toBe(w.address);
    expect(P.lightNodeId(w.address)).toBe(w.nodeId);
    expect(WalletManager.prototype.generateLightNodePseudonym(w.address)).toBe(w.nodeId);
    expect(sha3_256(`${V.constants.link.walletHashPrefix}${w.address}`).slice(0, 16)).toBe(w.walletHash);
  });
});

// The builder of each vector message, from its inputs.
const nodeBuilders = {
  consent: (i) => P.consentPreimage(i.nodeId, i.wallet, i.proof, i.ts),
  ownerBind: (i, w) => P.ownerBindPreimage(i.nodeId, i.wallet, i.proof, i.ts, w.publicKey, i.burnTx),
  // The payment key's timeless owner bind (a Light registration from the gate on): only the site signs it, the app never
  // builds one, so its form is written out here from the protocol.
  ownerBindV2: (i, w) => `qnet_burn_owner_v2:${i.nodeId}:${i.wallet}:${P.registrationProof(i.burnTx, i.nodeId, i.wallet)}:`
    + `${P.publicKeySha3(w.publicKey)}:${i.burnTx}`,
  delegationV2: (i) => P.delegationPreimage(i.pingPublicKey, i.nodeId, i.seq),
  attachV2: (i) => P.attachPreimage(i.nodeId, V.pingKey.publicKey, i.pushTarget, i.seq, i.ts),
  attachV2NoPushTarget: (i) => P.attachPreimage(i.nodeId, V.pingKey.publicKey, i.pushTarget, i.seq, i.ts),
  tokenRefreshV2: (i) => P.tokenRefreshPreimage(i.nodeId, i.pushTarget, i.seq, i.ts),
  unbind: (i) => P.unbindPreimage(i.nodeId, i.seq, i.ts),
  // The wallet key's unbind (contract 1.1, 04.10).
  walletUnbind: (i) => P.walletUnbindPreimage(i.nodeId, i.seq, i.ts),
  selfAttest: (i) => P.answerChallenge(i.height, i.hash),
  claimRewards: (i) => P.claimQuotePreimage(i.nodeId, i.wallet),
  claimPayload: (i) => P.claimPayloadPreimage(i.wallet, i.ts, i.claimsData),
  statusByPingKey: (i) => P.statusPreimage(i.nodeId, i.ts),
  statusByWalletKey: (i) => P.statusPreimage(i.nodeId, i.ts),
};

describe('wallet-key and ping-key messages', () => {
  for (const n of V.node) {
    const w = walletOf(n.wallet);
    it(`${n.wallet}: the proof, as the node and the app compute it`, () => {
      expect(P.registrationProof(n.burnTx, n.nodeId, w.address)).toBe(n.proof);
    });
    it(`${n.wallet}: every preimage is rebuilt from its inputs and its signature verifies`, () => {
      // Every message of the vectors has its builder here, and every builder its message.
      const names = n.messages.map((m) => m.name);
      expect(Object.keys(nodeBuilders).sort()).toEqual(names.sort());
      for (const m of n.messages) {
        expect([m.name, nodeBuilders[m.name](m.inputs, w)]).toEqual([m.name, m.preimage]);
        expect([m.name, sha3_256(m.preimage)]).toEqual([m.name, m.preimageSha3]);
        const message = utf8(m.preimage);
        let ok;
        if (m.signer === 'burner') ok = nacl.sign.detached.verify(message, bytes(m.signature), bytes(V.burner.publicKey));
        else ok = ml_dsa65.verify(bytes(m.signature), message, bytes(m.signer === 'wallet' ? w.publicKey : V.pingKey.publicKey));
        expect([m.name, ok]).toEqual([m.name, true]);
      }
    });
  }

  it('the wallet signs in the node\'s form: deterministic, empty context', () => {
    const w = walletOf('kat-12');
    const consent = V.node[0].messages.find((m) => m.name === 'consent');
    const { secretKey } = ml_dsa65.keygen(bytes(w.xi));
    expect(hexOf(ml_dsa65.sign(utf8(consent.preimage), secretKey, { extraEntropy: false }))).toBe(consent.signature);
    const withContext = { context: utf8('QNET_OFFCHAIN_MSG_v1') };
    expect(ml_dsa65.verify(bytes(consent.signature), utf8(consent.preimage), bytes(w.publicKey), withContext)).toBe(false);
  });

  // Contract 1.1 (04.10): the wallet key's unbind, its own token beside the ping key's, on one chain.
  it('the wallet key\'s unbind: chain-tagged, its own token, canonical decimals only', () => {
    const { nodeId } = walletOf('kat-12');
    expect(P.walletUnbindPreimage(nodeId, 1790000500, 1790003600)).toBe(`q1337|light_unbind_wallet:${nodeId}:1790000500:1790003600`);
    expect(P.walletUnbindPreimage(nodeId, '7', '9')).toBe(`q1337|light_unbind_wallet:${nodeId}:7:9`);
    // It can never pass for the ping key's form, which has the colon straight after light_unbind.
    expect(P.unbindPreimage(nodeId, 7, 9)).toBe(`q1337|light_unbind:${nodeId}:7:9`);
    expect(P.walletUnbindPreimage(nodeId, 7, 9).startsWith(P.unbindPreimage(nodeId, 7, 9).split(nodeId)[0])).toBe(false);
    for (const [seq, ts] of [['07', 9], [7, -1], [1.5, 9], [7, '9a']]) {
      expect(() => P.walletUnbindPreimage(nodeId, seq, ts)).toThrow(TypeError);
    }
    expect(() => P.walletUnbindPreimage(`${nodeId}:x`, 7, 9)).toThrow(TypeError);
  });

  it('refuses fields that are not what the message names', () => {
    const w = walletOf('kat-12');
    const { nodeId } = w;
    const proof = V.node[0].proof;
    expect(() => P.consentPreimage(`${nodeId}:x`, w.address, proof, 1)).toThrow(TypeError);
    expect(() => P.consentPreimage(nodeId, `${w.address.slice(0, -1)}0`, proof, 1)).toThrow(TypeError);
    expect(() => P.consentPreimage(nodeId, w.address, proof, -1)).toThrow(TypeError);
    expect(() => P.consentPreimage(nodeId, w.address, proof, '01')).toThrow(TypeError);
    expect(() => P.consentPreimage(nodeId, w.address, proof, 1.5)).toThrow(TypeError);
    expect(() => P.delegationPreimage(V.pingKey.publicKey.slice(2), nodeId, 1)).toThrow(TypeError);
    expect(() => P.answerChallenge(1, 'ab')).toThrow(TypeError);
    expect(() => P.answerChallenge('9007199254740992', V.anchor.hash)).toThrow(TypeError);
    expect(() => P.claimPayloadPreimage(w.address, 1, '')).toThrow(TypeError);
    expect(P.consentPreimage(nodeId, w.address, proof, '18446744073709551615')).toMatch(/:18446744073709551615$/);
    expect(() => P.consentPreimage(nodeId, w.address, proof, '18446744073709551616')).toThrow(TypeError);
  });
});

// node:crypto's check of a DER ECDSA-SHA256 signature under a 65-byte P-256 point.
function p256Verify(pubHex, message, derB64u) {
  const pub = Buffer.from(pubHex, 'hex');
  const key = nodeCrypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk',
  });
  return nodeCrypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }, Buffer.from(derB64u, 'base64url'));
}

describe('device messages', () => {
  const D = V.device;
  const N = walletOf('kat-12').nodeId;
  const W = walletOf('kat-12').address;
  const pp = V.pingKey.publicKey;
  const keyOf = (name) => D.keys[name].publicKey;
  const byName = (name, platform) => D.messages.find((m) => m.name === name && m.platform === platform);

  // iOS: an assertion over clientDataHash = SHA-256(preimage); Android: ECDSA-SHA256 over the preimage.
  const deviceSignatureOk = (platform, key, s, preimage) => {
    if (platform === 'android') return p256Verify(keyOf(key), utf8(preimage), s.signatureDer);
    const cdh = P.deviceChallengeHash(preimage);
    const auth = bytes(s.authenticatorData);
    const nonce = sha256(new Uint8Array([...auth, ...cdh]));
    return hexOf(cdh) === s.clientDataHash && hexOf(auth.subarray(0, 32)) === D.rpIdHash
      && Buffer.from(auth).readUInt32BE(33) === s.counter && p256Verify(keyOf(key), nonce, s.signatureDer);
  };

  it('the Android report: canonical JSON, its flags and its signature', () => {
    const report = P.androidReport({ arc: false, automotive: false, embedded: false, feature_pc: false, hsum: false,
      leanback: false, system_user: true, touchscreen: true, watch: false });
    expect(report).toBe(D.report.text);
    expect(P.androidFlags(report)).toBe(`r=${D.report.sha3}`);
    expect(p256Verify(keyOf('android'), utf8(report), D.report.signatureDer)).toBe(true);
    expect(() => P.androidReport({ arc: false })).toThrow(TypeError);
  });

  it('enrolment on both platforms: preimage, challenge hash and Play nonce', () => {
    const ios = byName('enrol', 'ios');
    expect(P.iosFlags('phone')).toBe(ios.flags);
    expect(P.enrolPreimage({ nodeId: N, wallet: W, pingPublicKey: pp, seq: 1790000000, nonce: ios.nonce, flags: ios.flags })).toBe(ios.preimage);
    expect(hexOf(P.deviceChallengeHash(ios.preimage))).toBe(ios.clientDataHash);
    expect(deviceSignatureOk('ios', 'ios', ios.reenrolAssertion, ios.preimage)).toBe(true);
    const android = byName('enrol', 'android');
    expect(P.enrolPreimage({ nodeId: N, wallet: W, pingPublicKey: pp, seq: '1790000000', nonce: android.nonce, flags: android.flags })).toBe(android.preimage);
    expect(hexOf(P.deviceChallengeHash(android.preimage))).toBe(android.attestationChallenge);
    expect(P.playNonceForEnrol(android.preimage, keyOf('android'), D.report.text)).toBe(android.playNonce);
    expect(() => P.enrolPreimage({ nodeId: N, wallet: W, pingPublicKey: pp, seq: 1, nonce: ios.nonce, flags: 'mac=1' })).toThrow(TypeError);
    expect(() => P.iosFlags('desktop')).toThrow(TypeError);
  });

  it('rotation: preimage, the new key\'s challenge and the old key\'s signature', () => {
    for (const platform of ['ios', 'android']) {
      const m = byName('rotate', platform);
      expect(P.rotatePreimage({ nodeId: N, oldHwPublicKey: keyOf(platform), pingPublicKey: pp, seq: 1790000000, nonce: m.nonce })).toBe(m.preimage);
      expect(hexOf(P.deviceChallengeHash(m.preimage))).toBe(platform === 'ios' ? m.newKeyClientDataHash : m.newKeyAttestationChallenge);
      expect(deviceSignatureOk(platform, platform, m.oldKey, m.preimage)).toBe(true);
    }
    const android = byName('rotate', 'android');
    expect(P.playNonce(android.preimage)).toBe(android.playNonce);
    expect(p256Verify(keyOf('androidRotated'), utf8(D.report.text), android.newKeyReportSignatureDer)).toBe(true);
  });

  it('rebind, refresh and release on both platforms', () => {
    const to = walletOf('phrase-24');
    for (const platform of ['ios', 'android']) {
      const rebind = byName('rebind', platform);
      expect(P.rebindPreimage({ fromNodeId: N, toNodeId: to.nodeId, seq: 1790086400, nonce: rebind.nonce })).toBe(rebind.preimage);
      expect(deviceSignatureOk(platform, platform, rebind.device, rebind.preimage)).toBe(true);
      expect(ml_dsa65.verify(bytes(rebind.walletSignature), utf8(rebind.preimage), bytes(to.publicKey))).toBe(true);
      const refresh = byName('refresh', platform);
      expect(P.refreshPreimage(N, refresh.nonce)).toBe(refresh.preimage);
      expect(deviceSignatureOk(platform, platform, refresh.device, refresh.preimage)).toBe(true);
      if (platform === 'android') expect(P.playNonce(refresh.preimage)).toBe(refresh.playNonce);
      const release = byName('release', platform);
      expect(P.releasePreimage(N, 1790000000, release.nonce)).toBe(release.preimage);
      expect(deviceSignatureOk(platform, platform, release.device, release.preimage)).toBe(true);
    }
  });

  it('the ping reply: the ping key\'s signature, the device preimage and the wire form', () => {
    const p = D.ping;
    expect(P.answerChallenge(p.height, p.hash)).toBe(p.challenge);
    expect(P.epochOf(p.height)).toBe(Number(p.epoch));
    expect(ml_dsa65.verify(bytes(p.sigma), utf8(p.challenge), bytes(pp))).toBe(true);
    expect(sha3_256(bytes(p.sigma))).toBe(p.sigmaSha3);
    for (const platform of ['ios', 'android']) {
      const r = p[platform];
      expect(P.hwPingPreimage({ nodeId: N, height: p.height, hash: p.hash, sigma: p.sigma, hwSeq: r.hwSeq })).toBe(r.preimage);
      expect(deviceSignatureOk(platform, platform, r, r.preimage)).toBe(true);
      expect(P.pingWire(p.sigma, platform === 'ios' ? r.assertion : r.signatureDer, r.hwSeq)).toBe(r.wire);
    }
    expect(() => P.pingWire(p.sigma, 'a+b', 0)).toThrow(TypeError);
  });

  it('encodes base64url as the platform does and decodes only its canonical form', () => {
    for (let n = 0; n <= 12; n++) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) % 256);
      expect([n, P.b64url(data)]).toEqual([n, b64u(data)]);
      if (n > 0) expect(P.pingWire(D.ping.sigma, b64u(data), 0)).toBe(`ping_hw2:${D.ping.sigma}.${b64u(data)}.0`);
    }
    expect(() => P.pingWire(D.ping.sigma, 'AB', 0)).toThrow(TypeError); // non-zero padding bits
    expect(() => P.pingWire(D.ping.sigma, 'ABCDE', 0)).toThrow(TypeError); // length 1 mod 4
  });

  it('device tags, the public tag hash and the support reference', () => {
    for (const platform of ['ios', 'android']) {
      expect(P.deviceTag(platform, keyOf(platform))).toBe(D.deviceTags[platform]);
      expect(P.deviceTagH(D.status.nonce, D.deviceTags[platform])).toBe(D.status.deviceTagH[platform]);
    }
    expect(P.resetRef(D.status.refNonce, D.deviceTags.android)).toBe(D.status.ref.android);
    expect(P.hwPublicKeySha3(keyOf('ios'))).toBe(D.keys.ios.publicKeySha3);
    expect(() => P.deviceTag('desktop', keyOf('ios'))).toThrow(TypeError);
  });
});

describe('QNet Link revision 2 with the app\'s cryptography', () => {
  const L = V.link;
  const C = V.constants.link;
  const aad = (id, intent, reqHash) => `${C.aadPrefix}${id}|${intent}${reqHash ? `|${reqHash}` : ''}`;
  const requestText = (intent, r) => JSON.stringify(Object.fromEntries(C.requestKeys[intent].map((k) => [k, r[k]])));

  it.each(L.cases.map((c) => [c.name, c]))('%s', (_, c) => {
    expect(hexOf(x25519.getPublicKey(bytes(c.sitePrivateKey)))).toBe(c.sitePublicKey);
    const shared = x25519.getSharedSecret(bytes(c.appPrivateKey), bytes(c.sitePublicKey));
    expect(hexOf(shared)).toBe(c.sharedSecret);
    const key = hkdf(sha256, shared, bytes(c.sessionId), utf8(C.hkdfInfo), 32);
    expect(hexOf(key)).toBe(c.key);
    const n = Buffer.from(hkdf(sha256, shared, bytes(c.sessionId), utf8(C.sasInfo), 4)).readUInt32BE(0) % 1000000;
    expect(String(n).padStart(6, '0')).toBe(c.checkNumber);
    if (c.request) {
      expect(requestText(c.intent, c.request)).toBe(c.requestText);
      expect(b64u(sha256(utf8(c.requestText)))).toBe(c.reqHash);
    }
    expect(aad(c.sessionId, c.intent, c.reqHash)).toBe(c.aad);
    expect(c.link).toBe(`${C.prefix}${c.sessionId}.${b64u(bytes(c.sitePublicKey))}.${c.intent}${c.reqHash ? `.${c.reqHash}` : ''}`);
    const pt = gcm(key, bytes(c.iv), utf8(c.aad)).decrypt(bytes(c.ciphertext));
    expect(Buffer.from(pt).toString('utf8')).toBe(c.plaintext);
    const answer = JSON.parse(c.plaintext);
    if (c.intent === 'link' && answer.status === 'ok') {
      const proof = P.registrationProof(c.request.burnTx, answer.nodeId, answer.qnet);
      const preimage = P.consentPreimage(answer.nodeId, answer.qnet, proof, answer.consent.ts);
      expect(eonFromPublicKeyBytes(fromB64u(answer.consent.pk))).toBe(answer.qnet);
      expect(ml_dsa65.verify(fromB64u(answer.consent.sig), utf8(preimage), fromB64u(answer.consent.pk))).toBe(true);
    }
  });

  it('refuses every answer the vectors say must not decrypt', () => {
    const opened = L.cryptoMustFail.filter((f) => {
      try {
        const shared = x25519.getSharedSecret(bytes(f.sitePrivateKey), fromB64u(f.appPub));
        const key = hkdf(sha256, shared, bytes(f.sessionId), utf8(C.hkdfInfo), 32);
        gcm(key, fromB64u(f.iv), utf8(aad(f.sessionId, f.intent, f.reqHash))).decrypt(fromB64u(f.ct));
        return true;
      } catch (_) {
        return false;
      }
    });
    expect(opened.map((f) => f.name)).toEqual([]);
    expect(L.cryptoMustFail.length).toBeGreaterThan(0);
  });
});
