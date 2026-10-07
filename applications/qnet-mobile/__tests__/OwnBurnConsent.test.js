/**
 * A light burn made from the wallet's own Solana address (by the extension or an older app), registered from aiqnet.io
 * with this app (qnet-link-v1 section 14; owner, 06.10: an activation started on a phone finishes on that phone). The
 * `link` request names the burner; only when it is the open wallet's own Solana address does the wallet's Solana key,
 * the one its recovery phrase makes on m/44'/501'/0'/0', sign the burn's owner bind v1 for the wallet's own light node
 * at the consent's T, and the answer carries it as `consent.ownerSig`, byte for byte as
 * docs/protocols/light-node-own-burn.vectors.json has it (the node admits that body unchanged: its own test, and the
 * site's cabinet-own-burn.test.mjs). The sheet stays the consent to the wallet's own light node: no burn, code or price.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signWithDilithium: jest.fn().mockResolvedValue('sig'),
  signDetached: jest.fn(),
  verifyDilithium: jest.fn(async () => true),
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
const nacl = require('tweetnacl');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const messaging = require('@react-native-firebase/messaging').default;
const Dilithium = require('../src/crypto/DilithiumCrypto');
const { WalletManager } = require('../src/components/WalletManager');
const Push = require('../src/services/PushService');
const {
  LINK, buildPlaintext, parseLink, performIntent, plaintextProblem, prepareOffer, reqHashOf, requestText,
} = require('../src/services/QNetLink');

const OWN = require('../../../docs/protocols/light-node-own-burn.vectors.json');
const V = require('../../../docs/protocols/light-node.vectors.json');

const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const b64u = (h) => Buffer.from(h, 'hex').toString('base64url');
const utf8 = (s) => new TextEncoder().encode(s);
const CAPABLE = { capable: true, platform: 'ios', flags: 'mac=0,vision=0,idiom=phone', report: null };
const T = Number(OWN.cases[0].ts);
const nodeOf = (c) => V.node.find((n) => n.burnTx === c.burnTx);
const message = (c, name) => nodeOf(c).messages.find((m) => m.name === name);

// The wallet as its vault opens it: the ML-DSA-65 key pair (the secret is never used: signing is mocked to the vectors'
// signatures) and the Solana key pair the recovery phrase makes, as the app stores it (64 bytes: seed, then public key).
const solanaSecret = (c) => [...bytes(c.solana.seedHex), ...bytes(c.solana.publicKey)];
let opened;
function walletManager(c, over = {}) {
  const wm = new WalletManager();
  opened = [];
  wm.loadWallet = async () => {
    const wd = {
      qnetAddress: c.wallet.address,
      solanaAddress: c.solana.address,
      secretKey: solanaSecret(c),
      qnetKeypair: { privateKey: new Uint8Array(32).fill(7), publicKey: bytes(c.wallet.publicKey) },
      ...over,
    };
    opened.push(wd);
    return wd;
  };
  return wm;
}

let signed;
let calls;
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(T * 1000);
  signed = [];
  const known = new Map(V.node.flatMap((n) => n.messages.filter((m) => m.signer === 'wallet').map((m) => [m.preimage, m.signature])));
  Dilithium.signDetached.mockImplementation(async (preimage) => {
    signed.push(preimage);
    if (!known.has(preimage)) throw new Error(`unexpected preimage ${preimage.slice(0, 60)}`);
    return known.get(preimage);
  });
  Dilithium.generateRawDilithiumKeypair.mockResolvedValue({ publicKey: V.pingKey.publicKey, secretKey: 'ping-sk' });
  messaging().getToken.mockResolvedValue(message(OWN.cases[0], 'attachV2').inputs.pushTarget);
  calls = [];
  global.fetch = jest.fn((url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const answer = url.endsWith('/light-node/bind') ? { success: true, bound: false, pending: true, seq: body.seq } : { success: true };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) });
  });
});
afterEach(() => jest.restoreAllMocks());

describe('the owner bind of the wallet\'s own Solana key', () => {
  it.each(OWN.cases.map((c) => [c.name, c]))('%s: the vectors\' signature over exactly the node\'s v1 bytes, beside the consent', async (_, c) => {
    const r = await walletManager(c).prepareLinkConsent('secret', { burnTx: c.burnTx, ts: T, burner: c.solana.address });
    expect(r.consentSig).toBe(c.consent.signature);
    expect(r.ownerSig).toBe(c.ownerBind.signature);
    expect(r.binding).toBeNull();
    // The exact bytes the node rebuilds (qnet-state burn_owner_bind_message), the same the extension's burner signs.
    expect(c.ownerBind.preimage).toBe(`qnet_onchain_reg:${c.nodeId}:${c.wallet.address}:${c.proof}:${c.ts}:${c.wallet.publicKeySha3}:${c.burnTx}`);
    expect(c.ownerBind.preimage).toBe(message(c, 'ownerBind').preimage);
    expect(nacl.sign.detached.verify(utf8(c.ownerBind.preimage), bytes(r.ownerSig), bytes(c.solana.publicKey))).toBe(true);
    expect(nacl.sign.detached.verify(utf8(c.ownerBind.preimage), bytes(r.ownerSig), bytes(V.burner.publicKey))).toBe(false);
    // The wallet opened for the bind: its Solana key used for this one signature and wiped, its QNet key wiped unused.
    expect(opened).toHaveLength(2);
    expect(opened[1].secretKey.every((b) => b === 0)).toBe(true);
    expect(opened[1].qnetKeypair.privateKey.every((b) => b === 0)).toBe(true);
    // The ML-DSA-65 key signed the consent only: never a string that starts like an owner bind.
    expect(signed).toEqual([c.consent.preimage]);
  });

  it('only for the open wallet\'s own address, its own node and a Solana key that gives that address', async () => {
    const [c, d] = OWN.cases;
    const ask = (wm, over = {}) => wm.prepareLinkConsent('secret', { burnTx: c.burnTx, ts: T, burner: c.solana.address, ...over });
    await expect(ask(walletManager(c), { burner: d.solana.address })).rejects.toThrow('Not this wallet\'s Solana address');
    await expect(ask(walletManager(c), { burner: V.burner.address })).rejects.toThrow('Not this wallet\'s Solana address');
    await expect(ask(walletManager(c, { secretKey: undefined }))).rejects.toThrow('No Solana key in wallet');
    await expect(ask(walletManager(c, { secretKey: solanaSecret(d) }))).rejects.toThrow('does not match its address');
    const wm = walletManager(c);
    await expect(wm.signOwnBurnBind('secret', {
      nodeId: d.nodeId, wallet: d.wallet.address, proof: d.proof, ts: T, publicKey: d.wallet.publicKey, burnTx: d.burnTx, burner: c.solana.address,
    })).rejects.toThrow('Not this wallet\'s node');
    // Without a burner nothing but the consent is signed, as before.
    const plain = await walletManager(c).prepareLinkConsent('secret', { burnTx: c.burnTx, ts: T });
    expect(plain.ownerSig).toBeNull();
    expect(opened).toHaveLength(1);
  });
});

describe('the link sheet\'s consent with the burner', () => {
  const link = (c, over = {}) => Push.linkWithConsent({
    signer: walletManager(c), credential: 'secret', nodeId: c.nodeId, burnTx: c.burnTx, burner: c.solana.address, device: CAPABLE,
    features: ['bind_v2', 'pending_bind', 'consent_24h'], ...over,
  });

  it.each(OWN.cases.map((c) => [c.name, c]))('%s: the answer is the vectors\' plaintext and passes the site\'s checks', async (_, c) => {
    const r = await link(c);
    expect(r.consent).toEqual(JSON.parse(c.plaintext).consent);
    expect(r.consent.ownerSig).toBe(b64u(c.ownerBind.signature));
    const session = { intent: 'link', request: c.request };
    const text = buildPlaintext(session, { status: 'ok', qnet: c.wallet.address, nodeId: c.nodeId, consent: r.consent, bound: r.bound }, { now: T + 60 });
    expect(text).toBe(c.plaintext);
    expect(plaintextProblem(text, session, { now: T + 60 })).toBeNull();
    // The binding goes to the shard owners as for any consent: the owner bind is the site's, never theirs.
    const binds = calls.filter((x) => x.url.endsWith('/light-node/bind'));
    expect(binds.length).toBeGreaterThan(0);
    expect(JSON.stringify(binds[0].body)).not.toContain(c.ownerBind.signature);
  });

  it('a burner that is not the wallet\'s own: nothing is signed or posted, and the push token goes back', async () => {
    const [c, d] = OWN.cases;
    await expect(link(c, { burner: d.solana.address })).rejects.toThrow();
    expect(calls.filter((x) => x.url.endsWith('/light-node/bind'))).toHaveLength(0);
    expect(messaging().deleteToken).toHaveBeenCalled();
  });

  it('without a burner the consent keeps its three fields', async () => {
    const c = OWN.cases[0];
    const r = await link(c, { burner: null });
    expect(Object.keys(r.consent)).toEqual(['ts', 'pk', 'sig']);
  });
});

describe('the request and the answer on the wire', () => {
  it('the request with the burner: its bytes and hash; never without a burn and a named wallet', () => {
    expect([...LINK.OWN_BURN_REQUEST_KEYS]).toEqual(OWN.requestKeys);
    expect(LINK.REQUEST_KEYS.link).toEqual(['burnTx', 'walletHash', 'check']);
    for (const c of OWN.cases) {
      expect(requestText('link', c.request)).toBe(c.requestText);
      expect(reqHashOf(c.requestText)).toBe(c.reqHash);
    }
    const r = OWN.cases[0].request;
    for (const bad of [
      { ...r, burnTx: null }, { ...r, walletHash: null }, { ...r, burner: 'x' }, { ...r, burner: null }, { ...r, extra: 1 },
      { burnTx: r.burnTx, walletHash: r.walletHash, burner: r.burner },
    ]) expect(requestText('link', bad)).toBeNull();
    for (const intent of ['claim', 'reserve', 'unlink']) expect(requestText(intent, r)).toBeNull();
  });

  it('the answer: the owner bind with a burner, never without one; a bind that is not 64 bytes is unreadable', () => {
    const c = OWN.cases[0];
    const session = { intent: 'link', request: c.request };
    const at = (consent, s = session) => plaintextProblem(JSON.stringify({ ...JSON.parse(c.plaintext), consent }), s, { now: T + 60 });
    const { ownerSig, ...plain } = JSON.parse(c.plaintext).consent;
    expect(at({ ...plain, ownerSig })).toBeNull();
    expect(at(plain)).toBe('keys');
    expect(at({ ...plain, ownerSig }, { intent: 'link', request: { burnTx: c.burnTx, walletHash: c.request.walletHash, check: false } })).toBe('keys');
    expect(at({ ...plain, ownerSig: ownerSig.slice(0, 40) })).toBe('ownerSig');
    expect(at({ ...plain, ownerSig: 'not base64url!' })).toBe('ownerSig');
    expect(() => buildPlaintext(session, { status: 'ok', qnet: c.wallet.address, nodeId: c.nodeId, consent: plain, bound: true }, { now: T + 60 }))
      .toThrow('malformed');
  });
});

describe('the sheet: only the wallet whose own address made the burn consents with its bind', () => {
  const c = OWN.cases[0];
  const linkUrl = `https://link.aiqnet.io/l#v1.${'a'.repeat(32)}.${Buffer.from(new Uint8Array(32).fill(9)).toString('base64url')}.link.${c.reqHash}`;
  const node = (over = {}) => ({
    serverNode: false,
    status: jest.fn(async () => ({ onChain: false, features: ['bind_v2', 'pending_bind', 'consent_24h'] })),
    device: jest.fn(async () => CAPABLE),
    localNode: jest.fn(async () => null),
    otherNode: jest.fn(async () => false),
    record: jest.fn(async () => ({ state: 'recorded', nodeType: 'light' })),
    consent: jest.fn(async () => ({ consent: JSON.parse(c.plaintext).consent, bound: true })),
    ...over,
  });
  const session = { expiresAt: Date.now() + 500000, request: c.request };
  const wallet = (solanaAddress) => ({ qnetAddress: c.wallet.address, solanaAddress });

  it('the offer carries the burner for the wallet\'s own address; another address is WALLET_MISMATCH before anything is read', async () => {
    const link = parseLink(linkUrl);
    expect(link).toMatchObject({ intent: 'link', reqHash: c.reqHash });
    const offer = await prepareOffer(link, { wallet: wallet(c.solana.address), session, node: node() });
    expect(offer).toMatchObject({ kind: 'link', mode: 'consent', nodeId: c.nodeId, qnet: c.wallet.address, burnTx: c.burnTx, burner: c.solana.address });
    const other = node();
    expect(await prepareOffer(link, { wallet: wallet(OWN.cases[1].solana.address), session, node: other }))
      .toEqual({ kind: 'unavailable', error: 'WALLET_MISMATCH' });
    expect(other.otherNode).not.toHaveBeenCalled();
    // A node already on the chain is linked to this device; the burner is not used.
    const onChain = node({ status: jest.fn(async () => ({ onChain: true, features: ['bind_v2', 'pending_bind'] })) });
    expect(await prepareOffer(link, { wallet: wallet(c.solana.address), session, node: onChain })).toMatchObject({ kind: 'link', mode: 'device' });
  });

  it('a confirmed consent answers with the bind, and without one nothing goes', async () => {
    const offer = { kind: 'link', mode: 'consent', nodeId: c.nodeId, qnet: c.wallet.address, burnTx: c.burnTx, burner: c.solana.address, device: CAPABLE, features: [] };
    const n = node();
    const answer = await performIntent({ intent: 'link' }, offer, { node: n });
    expect(n.consent).toHaveBeenCalledWith({ nodeId: c.nodeId, burnTx: c.burnTx, burner: c.solana.address, device: CAPABLE, features: [] });
    expect(answer).toMatchObject({ status: 'ok', consent: JSON.parse(c.plaintext).consent, bound: true });
    const { ownerSig: _o, ...plain } = JSON.parse(c.plaintext).consent;
    expect(await performIntent({ intent: 'link' }, offer, { node: node({ consent: async () => ({ consent: plain, bound: true }) }) }))
      .toEqual({ status: 'error', error: 'INTERNAL' });
  });

  it('the Node side hands the burner to the consent', async () => {
    const { nodeLinkActions } = require('../src/services/NodeLinkActions');
    const spy = jest.spyOn(Push, 'linkWithConsent').mockResolvedValue({ consent: {}, bound: true, reason: null });
    const actions = nodeLinkActions({ walletManager: {}, credential: 'cred' });
    await actions.consent({ nodeId: c.nodeId, burnTx: c.burnTx, burner: c.solana.address, device: CAPABLE, features: [] });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ burnTx: c.burnTx, burner: c.solana.address, credential: 'cred' }));
    await actions.consent({ nodeId: c.nodeId, burnTx: c.burnTx, device: CAPABLE, features: [] });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ burner: null }));
  });

  it('the sheet\'s texts stay a consent to the wallet\'s own light node: no burn, code or price in any language', () => {
    const screen = fs.readFileSync(path.join(__dirname, '../src/screens/QNetLinkScreen.js'), 'utf8');
    expect(screen).not.toMatch(/burner|ownerSig|ownerBind/);
  });
});
