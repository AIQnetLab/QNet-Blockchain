/**
 * The shared vectors of a site's move of a node balance (docs/protocols/node-claim.vectors.json), the app's side: the
 * light and super node ids the app derives for each wallet, the claim quote it builds for either and the wallet key's
 * deterministic ML-DSA-65 signature over it, and every QNet Link exchange of the `claim` request naming either node, run
 * through the app's own link parser, request check, relay session check, seal and answer check. The session requests a
 * relay refuses (the earlier request, which named no node, among them) and the answers a site refuses are refused by the
 * app too.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');
const { x25519 } = require('@noble/curves/ed25519');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const P = require('../src/crypto/NodePreimages');
const Q = require('../src/services/QNetLink');
const { WalletManager } = require('../src/components/WalletManager');

const REPO = path.join(__dirname, '../../..');
const V = require('../../../docs/protocols/node-claim.vectors.json');
const L = require('../../../docs/protocols/light-node.vectors.json');

const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const hexOf = (b) => Buffer.from(b).toString('hex');
const utf8 = (s) => new TextEncoder().encode(s);
const windowOf = (ctx) => ({ now: Number(ctx.now), consent24h: ctx.consent24h });
const answerOf = (c) => {
  const a = JSON.parse(c.plaintext);
  delete a.v;
  delete a.intent;
  return a;
};
const relayView = (c, over = {}) => ({ ...c.sessionView, answered: false, expiresIn: 500, ...over });

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('the vector file', () => {
  it('is exactly what its generator writes', () => {
    const run = spawnSync(process.execPath, [path.join(REPO, 'docs/protocols/tools/node-claim-vectors.mjs'), '--check'],
      { encoding: 'utf8', timeout: 120000 });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
  });

  it('names the request\'s keys and node ids as the app checks them', () => {
    expect(Q.LINK.REQUEST_KEYS.claim).toEqual(V.constants.requestKeys);
    expect(V.constants.chainTag).toBe('q1337|');
    expect(String(Q.LINK.CLAIM_MIN_NANO)).toBe(V.constants.claimMinNano);
  });
});

describe('the wallets\' nodes', () => {
  it.each(V.wallets.map((w) => [w.name, w]))('%s: its light and super node ids, as the app derives them', (_, w) => {
    expect(P.lightNodeId(w.address)).toBe(w.lightNodeId);
    expect(P.superNodeId(w.address)).toBe(w.superNodeId);
    expect(WalletManager.prototype.generateLightNodePseudonym(w.address)).toBe(w.lightNodeId);
    expect(WalletManager.prototype.generateSuperNodePseudonym(w.address)).toBe(w.superNodeId);
    expect(w.lightNodeId).toMatch(new RegExp(V.constants.nodeIdPatterns.light));
    expect(w.superNodeId).toMatch(new RegExp(V.constants.nodeIdPatterns.super));
    expect(Q.walletHashOf(w.address)).toBe(w.walletHash);
    expect([P.ownNodeType(w.lightNodeId, w.address), P.ownNodeType(w.superNodeId, w.address)]).toEqual(['light', 'super']);
  });

  it('a node of another wallet, a genesis node or a malformed id is none of the wallet\'s', () => {
    const [w, other] = V.wallets;
    for (const id of [other.lightNodeId, other.superNodeId, 'genesis_node_001', w.superNodeId.toUpperCase(), `${w.superNodeId}0`, null, 7]) {
      expect([id, P.ownNodeType(id, w.address)]).toEqual([id, null]);
    }
    expect(P.ownNodeType(w.lightNodeId, 'not an address')).toBe(null);
    expect(() => P.superNodeId('not an address')).toThrow(TypeError);
  });

  it.each(V.wallets.map((w) => [w.name, w]))('%s: the claim quote of each node and the wallet key\'s signature over it', (_, w) => {
    const { secretKey, publicKey } = ml_dsa65.keygen(bytes(L.wallets.find((x) => x.name === w.name).xi));
    expect(hexOf(publicKey)).toBe(w.publicKey);
    expect(w.claimQuotes.map((q) => q.nodeId)).toEqual([w.lightNodeId, w.superNodeId]);
    for (const q of w.claimQuotes) {
      expect(P.claimQuotePreimage(q.nodeId, w.address)).toBe(q.preimage);
      expect(q.preimage).toBe(`${V.constants.chainTag}claim_rewards:${q.nodeId}:${w.address}`);
      // The node's form: deterministic, empty context.
      expect(hexOf(ml_dsa65.sign(utf8(q.preimage), secretKey, { extraEntropy: false }))).toBe(q.signature);
      expect(ml_dsa65.verify(bytes(q.signature), utf8(q.preimage), publicKey)).toBe(true);
    }
  });

  it('the shared builder takes a light or a super node id only', () => {
    const w = V.wallets[0];
    for (const bad of ['genesis_node_001', `${w.superNodeId}0`, w.superNodeId.toUpperCase(), 'super_node_', 'light_node_6526ab8fd00ff8ca', 7]) {
      expect(() => P.claimQuotePreimage(bad, w.address)).toThrow(TypeError);
    }
    expect(() => P.claimQuotePreimage(w.superNodeId, `${w.address.slice(0, -1)}0`)).toThrow(TypeError);
  });
});

describe('every exchange of the vectors, with the app\'s own checks and crypto', () => {
  it.each(V.cases.map((c) => [c.name, c]))('%s', async (_, c) => {
    const link = Q.parseLink(c.link);
    expect(link).toEqual({ id: c.sessionId, sitePub: c.sessionView.sitePub, intent: 'claim', reqHash: c.reqHash });
    expect(Q.requestText('claim', c.request)).toBe(c.requestText);
    expect(Q.reqHashOf(c.requestText)).toBe(c.reqHash);
    // The relay's session view passes the app's checks: it matches the link, its request included.
    global.fetch = jest.fn(async () => ({ status: 200, ok: true, url: '', text: async () => JSON.stringify(relayView(c)) }));
    const session = await Q.openSession(link);
    expect(session.request).toEqual(c.request);
    expect(global.fetch.mock.calls[0][0]).toBe(`https://aiqnet.io/api/link/sessions/${c.sessionId}`);
    // The answer: built byte for byte, taken by the app's answer check, sealed to the vector's exact body.
    expect(Q.plaintextProblem(c.plaintext, { intent: 'claim', request: c.context.request }, windowOf(c.context))).toBe(null);
    expect(Q.buildPlaintext({ intent: 'claim', request: c.context.request }, answerOf(c), windowOf(c.context))).toBe(c.plaintext);
    const shared = x25519.getSharedSecret(bytes(c.appPrivateKey), bytes(c.sitePublicKey));
    expect(hexOf(shared)).toBe(c.sharedSecret);
    expect(hexOf(Q.sessionKey(shared, c.sessionId))).toBe(c.key);
    expect(Q.checkNumber(shared, c.sessionId)).toBe(c.checkNumber);
    const body = Q.sealAnswer({
      id: c.sessionId, intent: 'claim', reqHash: c.reqHash, sitePub: c.sessionView.sitePub, plaintext: c.plaintext,
      appPrivateKey: bytes(c.appPrivateKey), iv: bytes(c.iv),
    });
    expect(body).toEqual(c.responseRequest);
    expect(hexOf(Q.decodeB64url(body.ct))).toBe(c.ciphertext);
    expect(Q.openAnswer({ id: c.sessionId, intent: 'claim', reqHash: c.reqHash, sitePrivateKey: bytes(c.sitePrivateKey), ...body }))
      .toBe(c.plaintext);
  });
});

describe('what the app refuses', () => {
  it('every session request a relay refuses, the earlier one that named no node among them', async () => {
    expect(V.invalidSessionRequests.length).toBeGreaterThanOrEqual(8);
    const c = V.cases.find((x) => x.name === 'claim-super-ok');
    for (const { why, body } of V.invalidSessionRequests) {
      const { request } = JSON.parse(body);
      expect([why, Q.requestText('claim', request)]).toEqual([why, null]);
      // Under the link's own hash, a session that carries it does not match the link.
      global.fetch = jest.fn(async () => ({ status: 200, ok: true, url: '', text: async () => JSON.stringify(relayView(c, { request })) }));
      await expect(Q.openSession(Q.parseLink(c.link))).rejects.toMatchObject({ reason: 'mismatch' });
    }
  });

  it('every answer a site refuses, for the check the vectors name', () => {
    expect(V.invalidPlaintexts.length).toBeGreaterThanOrEqual(10);
    for (const p of V.invalidPlaintexts) {
      expect([p.why, Q.plaintextProblem(p.plaintext, { intent: 'claim', request: p.context.request }, windowOf(p.context))])
        .toEqual([p.why, p.fail]);
    }
  });
});
