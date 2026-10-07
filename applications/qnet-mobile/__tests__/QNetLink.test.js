// QNet Link v1 revision 2 on the device (docs/protocols/qnet-link-v1.md section 14): the strict link parser, the request
// and its hash, the X25519 / HKDF / AES-GCM answer and the check number against the vectors the site and the extension
// share (docs/protocols/light-node.vectors.json, key `link`), the answer schema, the relay client that refuses any
// session that does not match its link and request, what each intent offers and answers, and the platform wiring that
// lets only a verified link in. An `activate` link is not a link to this app.
const fs = require('fs');
const path = require('path');
const { x25519 } = require('@noble/curves/ed25519');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const {
  LINK, parseLink, decodeB64url, encodeB64url, contributoryKey, sealAnswer, openAnswer, sessionKey, checkNumber,
  groupCheckNumber, requestText, reqHashOf, walletHashOf, buildPlaintext, plaintextProblem, openSession, deliverAnswer,
  markHandled, wasHandled, LinkRefusal, prepareOffer, performIntent,
} = require('../src/services/QNetLink');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LN = JSON.parse(fs.readFileSync(path.join(ROOT, '../../docs/protocols/light-node.vectors.json'), 'utf8'));
const V = LN.link;
const C0 = LN.constants.link;
// Revision 1's file keeps what revision 2 did not repeat: its activate links and the low-order points.
const R1 = JSON.parse(fs.readFileSync(path.join(ROOT, '../../docs/protocols/qnet-link-v1.vectors.json'), 'utf8'));
const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const linkOf = (c) => parseLink(c.link);
const viewOf = (c) => ({ intent: c.intent, request: c.request });
const windowOf = (ctx) => ({ now: Number(ctx.now), consent24h: ctx.consent24h });
const answerOf = (c) => {
  const answer = JSON.parse(c.plaintext);
  delete answer.v;
  delete answer.intent;
  return answer;
};
const byName = (n) => V.cases.find((c) => c.name === n);

describe('the constants', () => {
  it('are the protocol\'s', () => {
    expect(LINK.PREFIX).toBe(C0.prefix);
    expect(LINK.RE.source).toBe(C0.pattern);
    expect(LINK.HKDF_INFO).toBe(C0.hkdfInfo);
    expect(LINK.SAS_INFO).toBe(C0.sasInfo);
    expect(LINK.AAD_PREFIX).toBe(C0.aadPrefix);
    expect(LINK.WALLET_HASH_PREFIX).toBe(C0.walletHashPrefix);
    expect(LINK.SESSION_TTL_S).toBe(C0.sessionTtlSeconds);
    expect(LINK.CT_MIN_BYTES).toBe(C0.ciphertextMinBytes);
    for (const intent of C0.intents) {
      expect(LINK.CAPS[intent]).toEqual({ plaintext: C0.caps[intent].plaintext, ct: C0.caps[intent].ct });
      expect(LINK.STATUSES[intent]).toEqual(C0.statuses[intent]);
      expect(LINK.INTENT_ERRORS[intent]).toEqual(C0.errors[intent]);
    }
    expect(Object.keys(LINK.STATUSES)).toEqual(C0.intents);
    expect(LINK.REQUEST_KEYS).toEqual(C0.requestKeys);
    expect([...LINK.ERRORS].sort()).toEqual([...new Set(Object.values(C0.errors).flat())].sort());
    expect([LINK.CONSENT_PAST_S, LINK.CONSENT_FUTURE_S]).toEqual([C0.consentWindow.pastSeconds, C0.consentWindow.futureSeconds]);
    expect([LINK.RESERVE_PAST_S, LINK.RESERVE_FUTURE_S]).toEqual([C0.reserveWindow.pastSeconds, C0.reserveWindow.futureSeconds]);
    expect(String(LINK.CLAIM_MIN_NANO)).toBe(C0.claimMinNano);
    expect(LINK.RELAY).toBe('https://aiqnet.io');
  });
});

describe('the link', () => {
  it('parses every vector link to its session and request hash', () => {
    for (const c of V.cases) {
      const want = c.intent === 'connect'
        ? { id: c.sessionId, sitePub: c.sessionRequest.sitePub, intent: 'connect' }
        : { id: c.sessionId, sitePub: c.sessionRequest.sitePub, intent: c.intent, reqHash: c.reqHash };
      expect([c.name, parseLink(c.link)]).toEqual([c.name, want]);
      expect(c.link.length).toBe({ connect: 112, link: 153, claim: 154, reserve: 156, unlink: 155 }[c.intent]);
    }
  });

  it('refuses every string the vectors say a revision 2 parser must refuse, and every revision 1 activate link', () => {
    expect(V.invalidLinks.length).toBeGreaterThanOrEqual(8);
    for (const { link, reason } of V.invalidLinks) expect([reason, parseLink(link)]).toEqual([reason, null]);
    const activate = R1.cases.filter((c) => c.intent === 'activate');
    expect(activate.length).toBeGreaterThan(0);
    for (const c of activate) expect([c.name, parseLink(c.link)]).toEqual([c.name, null]);
    for (const bad of [null, undefined, 42, {}, '', `${V.cases[0].link}${'a'.repeat(200)}`]) expect(parseLink(bad)).toBeNull();
  });

  it('the site\'s Android intent: URL arrives as the link itself, naming the one package', () => {
    const a = V.androidIntent;
    expect(a.package).toBe('io.aiqnet.wallet');
    const i = a.intentUrl.lastIndexOf('#');
    const scheme = /(?:^|;)scheme=([^;]*);/.exec(a.intentUrl.slice(i + 7))[1];
    const data = `${scheme}:${a.intentUrl.slice('intent:'.length, i)}`;
    expect(data).toBe(a.link);
    expect(parseLink(data)).toEqual(parseLink(a.link));
    expect(parseLink(a.intentUrl)).toBeNull();
  });

  it('refuses a link whose site key is a low-order point', () => {
    const c = byName('link-ok-check');
    for (const low of R1.lowOrderPublicKeys) {
      expect(contributoryKey(hex(low))).toBe(false);
      expect(parseLink(c.link.replace(c.sessionRequest.sitePub, encodeB64url(hex(low))))).toBeNull();
    }
  });

  it('decodes base64url only in its canonical form', () => {
    const pub = V.cases[0].sessionRequest.sitePub;
    expect(decodeB64url(pub, 32)).not.toBeNull();
    expect(decodeB64url(`${pub}=`)).toBeNull();
    expect(decodeB64url(`${pub.slice(0, -1)}V`)).toBeNull();
    expect(decodeB64url('A')).toBeNull();
  });
});

describe('the request', () => {
  it('rebuilds each request to its exact bytes and hash', () => {
    for (const c of V.cases.filter((x) => x.intent !== 'connect')) {
      expect([c.name, requestText(c.intent, c.request)]).toEqual([c.name, c.requestText]);
      expect([c.name, reqHashOf(c.requestText)]).toEqual([c.name, c.reqHash]);
    }
  });

  it('refuses a request of another shape', () => {
    const r = byName('link-ok-check').request;
    for (const bad of [{ ...r, extra: 1 }, { burnTx: r.burnTx, walletHash: null }, { ...r, check: 'yes' },
      { ...r, walletHash: 'ABCDEF0123456789' }, { ...r, burnTx: 'not-base58!' }, { ...r, burnTx: 'x'.repeat(10) }, null, []]) {
      expect(requestText('link', bad)).toBeNull();
    }
    expect(requestText('claim', { walletHash: null, burnTx: null })).toBeNull();
    expect(requestText('connect', {})).toBeNull();
  });

  it('names a wallet by the hash both sides compute', () => {
    for (const w of LN.wallets) expect([w.name, walletHashOf(w.address)]).toEqual([w.name, w.walletHash]);
  });
});

describe('the answer crypto, against the shared vectors', () => {
  it.each(V.cases.map((c) => [c.name, c]))('%s: the app key and IV of the vector give its exact body and check number', (name, c) => {
    const shared = x25519.getSharedSecret(hex(c.appPrivateKey), hex(c.sitePublicKey));
    expect(Buffer.from(shared).toString('hex')).toBe(c.sharedSecret);
    expect(Buffer.from(sessionKey(shared, c.sessionId)).toString('hex')).toBe(c.key);
    expect(checkNumber(shared, c.sessionId)).toBe(c.checkNumber);
    expect(groupCheckNumber(c.checkNumber)).toBe(c.checkNumberDisplay);
    const body = sealAnswer({
      id: c.sessionId, intent: c.intent, reqHash: c.reqHash, sitePub: c.sessionRequest.sitePub, plaintext: c.plaintext,
      appPrivateKey: hex(c.appPrivateKey), iv: hex(c.iv),
    });
    expect(body).toEqual(c.responseRequest);
    expect(openAnswer({ id: c.sessionId, intent: c.intent, reqHash: c.reqHash, sitePrivateKey: hex(c.sitePrivateKey), ...body }))
      .toBe(c.plaintext);
  });

  it('every decryption the vectors say must fail, fails', () => {
    expect(V.cryptoMustFail.length).toBeGreaterThanOrEqual(5);
    for (const m of V.cryptoMustFail) {
      expect(() => openAnswer({ ...m, id: m.sessionId, sitePrivateKey: hex(m.sitePrivateKey) })).toThrow();
    }
  });
});

describe('the answer plaintext', () => {
  it('builds every answer of the vectors byte for byte', () => {
    for (const c of V.cases) {
      expect([c.name, buildPlaintext(viewOf(c), answerOf(c), windowOf(c.context))]).toEqual([c.name, c.plaintext]);
      expect([c.name, plaintextProblem(c.plaintext, viewOf(c), windowOf(c.context))]).toEqual([c.name, null]);
    }
  });

  it('refuses every invalid answer for the reason the vectors give (the consent signature is the app\'s own)', () => {
    expect(V.invalidPlaintexts.length).toBeGreaterThanOrEqual(25);
    for (const p of V.invalidPlaintexts) {
      const session = { intent: byName(p.session).intent, request: p.context.request };
      const got = plaintextProblem(p.plaintext, session, windowOf(p.context));
      // The app does not verify the ML-DSA signature it made itself; the site does.
      expect([p.session, p.reason, got]).toEqual([p.session, p.reason, p.reason === 'sig' ? null : p.reason]);
    }
  });

  it('refuses to send an answer the site would refuse, and leaves out what is not in its row', () => {
    const c = byName('link-linked');
    const ok = answerOf(c);
    expect(() => buildPlaintext(viewOf(c), { status: 'error', error: 'CLAIM_BUSY' })).toThrow(/error/);
    expect(() => buildPlaintext(viewOf(c), { ...ok, status: 'ok' })).toThrow(/status/); // no burn in the request
    expect(() => buildPlaintext(viewOf(c), { ...ok, nodeId: 'light_mobile_0000000000000000' })).toThrow(/nodeId/);
    expect(() => buildPlaintext(viewOf(c), { ...ok, seq: 7 })).toThrow(/seq/);
    expect(buildPlaintext(viewOf(c), { ...ok, reason: 'x', here: true }, windowOf(c.context))).toBe(c.plaintext);
    expect(buildPlaintext(viewOf(c), { status: 'error', error: 'BIND_REFUSED', reason: 'device_desktop' }))
      .toBe('{"v":1,"intent":"link","status":"error","error":"BIND_REFUSED"}');
  });
});

// ---------------------------------------------------------------- relay

let calls;
let relay;
const reply = (status, body, url) => Promise.resolve({
  status, ok: status < 400, url,
  text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => body,
});
const viewFor = (c, over = {}) => ({ ...c.sessionView, answered: false, expiresIn: 512, ...over });

beforeEach(async () => {
  await AsyncStorage.clear();
  calls = [];
  relay = () => reply(200, viewFor(byName('connect-ok')));
  global.fetch = jest.fn((url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body, headers: opts.headers || {} });
    return relay(opts.method || 'GET', url, opts.body);
  });
});

describe('the relay session', () => {
  it('GETs exactly the session on aiqnet.io and accepts one that matches the link, its request included', async () => {
    for (const c of V.cases) {
      relay = () => reply(200, viewFor(c));
      calls.length = 0;
      const s = await openSession(linkOf(c));
      expect(calls).toEqual([expect.objectContaining({ url: `https://aiqnet.io/api/link/sessions/${c.sessionId}`, method: 'GET', body: null })]);
      // A header, not fetch's cache option: React Native turns that option into a query on the URL.
      expect(calls[0].headers).toEqual({ Accept: 'application/json', 'Cache-Control': 'no-store' });
      expect([c.name, s.request]).toEqual([c.name, c.request]);
    }
  });

  it('refuses a session whose request or hash differ from the link, or that has another shape', async () => {
    const c = byName('link-ok-check');
    const other = byName('link-ok-known-wallet');
    for (const body of [
      viewFor(c, { request: { ...c.request, check: false } }),
      viewFor(c, { request: other.request }),
      viewFor(c, { reqHash: other.reqHash }),
      viewFor(c, { request: other.request, reqHash: other.reqHash }),
      viewFor(c, { request: { ...c.request, extra: 1 } }),
      viewFor(c, { intent: 'activate' }), viewFor(c, { extra: 1 }),
      (() => { const s = viewFor(c); delete s.request; return s; })(),
      viewFor(byName('connect-ok'), { request: null, reqHash: null }),
      viewFor(c, { expiresIn: 601 }), 'not json', null,
    ]) {
      relay = () => reply(200, body);
      await expect(openSession(linkOf(c))).rejects.toMatchObject({ reason: 'mismatch' });
    }
  });

  it('refuses an answered, expiring, unknown or unreachable session', async () => {
    const c = byName('claim-ok');
    for (const [make, reason] of [
      [() => reply(200, viewFor(c, { answered: true })), 'answered'],
      [() => reply(200, viewFor(c, { expiresIn: 29 })), 'expiring'],
      [() => reply(404, { error: 'not_found' }), 'not_found'],
      [() => reply(500, ''), 'network'],
      [() => Promise.reject(new TypeError('Network request failed')), 'network'],
      [() => reply(200, viewFor(c), 'https://evil.example/api/link/sessions/x'), 'network'],
    ]) {
      relay = make;
      const e = await openSession(linkOf(c)).catch((x) => x);
      expect(e).toBeInstanceOf(LinkRefusal);
      expect(e.reason).toBe(reason);
    }
  });

  it('a session this device already decided on is refused without asking the relay; the id itself is not stored', async () => {
    const c = byName('connect-ok');
    await markHandled(c.sessionId);
    await expect(openSession(linkOf(c))).rejects.toMatchObject({ reason: 'handled' });
    expect(calls).toEqual([]);
    expect(await AsyncStorage.getItem('qnet_link_handled')).not.toContain(c.sessionId);
    expect(await wasHandled(c.sessionId, Date.now() + 601000)).toBe(false);
  });
});

describe('the answer delivery', () => {
  const live = (request = null) => ({ expiresAt: Date.now() + 600000, request });

  it('POSTs {appPub, iv, ct} sealed to the session and its request, which the site opens to the exact answer', async () => {
    const c = byName('claim-rejected');
    relay = () => reply(201, { ok: true });
    expect(await deliverAnswer(linkOf(c), live(c.request), { status: 'rejected' })).toBe('delivered');
    const sent = JSON.parse(calls[0].body);
    expect(Object.keys(sent).sort()).toEqual(['appPub', 'ct', 'iv']);
    expect(openAnswer({ id: c.sessionId, intent: 'claim', reqHash: c.reqHash, sitePrivateKey: hex(c.sitePrivateKey), ...sent }))
      .toBe('{"v":1,"intent":"claim","status":"rejected"}');
    // Without the request hash the answer does not open.
    expect(() => openAnswer({ id: c.sessionId, intent: 'claim', sitePrivateKey: hex(c.sitePrivateKey), ...sent })).toThrow();
  });

  it('shows the check number only after the relay took an answer that names the wallet, and only when asked', async () => {
    const c = byName('link-linked');
    const answer = answerOf(c);
    relay = () => reply(201, { ok: true });
    for (const [request, status, want] of [
      [{ ...c.request, check: true }, 201, true], [c.request, 201, false], [{ ...c.request, check: true }, 409, false],
    ]) {
      relay = () => reply(status, {});
      const onCheck = jest.fn();
      await deliverAnswer(linkOf(c), live(request), answer, { onCheck });
      expect(onCheck.mock.calls.length).toBe(want ? 1 : 0);
      if (want) expect(onCheck.mock.calls[0][0]).toMatch(/^\d{6}$/);
    }
    const onCheck = jest.fn();
    relay = () => reply(201, {});
    await deliverAnswer(linkOf(c), live({ ...c.request, check: true }), { status: 'rejected' }, { onCheck });
    expect(onCheck).not.toHaveBeenCalled();
  });

  it('reports another device\'s answer, an expired session and a refused body, without retrying them', async () => {
    const c = byName('connect-ok');
    for (const [status, outcome] of [[409, 'conflict'], [404, 'expired'], [400, 'failed'], [413, 'failed'], [200, 'delivered']]) {
      relay = () => reply(status, {});
      calls.length = 0;
      expect(await deliverAnswer(linkOf(c), live(), { status: 'rejected' })).toBe(outcome);
      expect(calls).toHaveLength(1);
    }
  });

  it('retries the identical body after a network failure while the session lives, then stops', async () => {
    const c = byName('connect-ok');
    let n = 0;
    relay = () => (++n < 3 ? Promise.reject(new TypeError('Network request failed')) : reply(201, { ok: true }));
    expect(await deliverAnswer(linkOf(c), live(), { status: 'rejected' }, { sleep: async () => {} })).toBe('delivered');
    expect(new Set(calls.map((x) => x.body)).size).toBe(1);
  });

  it('an answer the wallet could not build goes out as INTERNAL, never malformed', async () => {
    const c = byName('link-ok-check');
    relay = () => reply(201, { ok: true });
    await deliverAnswer(linkOf(c), live(c.request), { status: 'ok', qnet: 'nope' });
    const sent = JSON.parse(calls[0].body);
    expect(openAnswer({ id: c.sessionId, intent: 'link', reqHash: c.reqHash, sitePrivateKey: hex(c.sitePrivateKey), ...sent }))
      .toBe('{"v":1,"intent":"link","status":"error","error":"INTERNAL"}');
  });
});

// ---------------------------------------------------------------- the intents

const W = LN.wallets[0];
const WALLET = { qnetAddress: W.address, solanaAddress: LN.burner.address };
const CAPABLE = { capable: true, platform: 'ios', flags: 'mac=0,vision=0,idiom=phone', report: null };
const node = (over = {}) => ({
  serverNode: false,
  status: jest.fn(async () => ({ onChain: true, features: ['bind_v2', 'pending_bind', 'consent_24h'] })),
  device: jest.fn(async () => CAPABLE),
  localNode: jest.fn(async () => null),
  balance: jest.fn(async () => 12500000000),
  claimBusy: () => false,
  // Two genesis nodes say the wallet has no server node, and aiqnet.io holds no burn for it.
  otherNode: jest.fn(async () => false),
  record: jest.fn(async () => ({ state: 'none', nodeType: null })),
  consent: jest.fn(async () => ({ consent: { ts: '1790000000', pk: 'pk', sig: 'sig' }, bound: true })),
  useDevice: jest.fn(async () => ({ ok: true, seq: 1790086400 })),
  claim: jest.fn(async () => ({ status: 'ok', amountNano: '12500000000', txHash: 'ab'.repeat(32), stoppedAtEpoch: null })),
  ...over,
});
const session = (request) => ({ expiresAt: Date.now() + 500000, request });

describe('what each intent offers before anything is signed', () => {
  const link = linkOf(byName('link-ok-check'));
  const claim = linkOf(byName('claim-ok'));
  const burnTx = byName('link-ok-check').request.burnTx;

  it('connect offers the addresses, or NO_WALLET', async () => {
    const c = linkOf(byName('connect-ok'));
    expect(await prepareOffer(c, { wallet: WALLET })).toEqual({ kind: 'connect', addresses: { qnet: WALLET.qnetAddress, solana: WALLET.solanaAddress } });
    expect(await prepareOffer(c, { wallet: null })).toEqual({ kind: 'unavailable', error: 'NO_WALLET' });
  });

  it('a request for another wallet, a server node, an unreachable network or no node is refused before the sheet', async () => {
    const n = node();
    expect(await prepareOffer(link, { wallet: WALLET, session: session({ burnTx, walletHash: '0'.repeat(16), check: false }), node: n }))
      .toMatchObject({ kind: 'unavailable', error: 'WALLET_MISMATCH' });
    expect(n.status).not.toHaveBeenCalled();
    expect(await prepareOffer(link, { wallet: WALLET, session: session({ burnTx, walletHash: null, check: true }), node: node({ serverNode: true }) }))
      .toMatchObject({ error: 'NODE_OTHER' });
    expect(await prepareOffer(link, { wallet: WALLET, session: session({ burnTx, walletHash: null, check: true }), node: node({ status: async () => ({ onChain: null, features: [] }) }) }))
      .toMatchObject({ error: 'NETWORK' });
    expect(await prepareOffer(link, { wallet: WALLET, session: session({ burnTx: null, walletHash: null, check: false }), node: node({ status: async () => ({ onChain: false, features: [] }) }) }))
      .toMatchObject({ error: 'NO_NODE' });
    expect(await prepareOffer(claim, { wallet: WALLET, session: session({ walletHash: null }), node: node({ status: async () => ({ onChain: false, features: [] }) }) }))
      .toMatchObject({ error: 'NO_NODE' });
    expect(await prepareOffer(link, { wallet: null, session: session({ burnTx, walletHash: null, check: false }), node: node() }))
      .toMatchObject({ error: 'NO_WALLET' });
  });

  it('link: a node on the chain is linked to this device; a new one takes the consent, with this device when it can run one', async () => {
    const onChain = await prepareOffer(link, { wallet: WALLET, session: session({ burnTx: null, walletHash: W.walletHash, check: false }), node: node() });
    expect(onChain).toMatchObject({ kind: 'link', mode: 'device', nodeId: W.nodeId, qnet: W.address, device: CAPABLE, switchFrom: null });
    const fresh = node({ status: async () => ({ onChain: false, features: ['bind_v2', 'pending_bind'] }) });
    expect(await prepareOffer(link, { wallet: WALLET, session: session({ burnTx, walletHash: null, check: true }), node: fresh }))
      .toMatchObject({ kind: 'link', mode: 'consent', nodeId: W.nodeId, burnTx, device: CAPABLE });
    // A device that cannot run a node gives the consent only; with the node on the chain it has nothing to confirm.
    const cant = { capable: false, reason: 'device_desktop' };
    expect(await prepareOffer(link, { wallet: WALLET, session: session({ burnTx, walletHash: null, check: true }), node: { ...fresh, device: async () => cant } }))
      .toMatchObject({ kind: 'link', mode: 'consent', device: cant });
    expect(await prepareOffer(link, { wallet: WALLET, session: session({ burnTx: null, walletHash: null, check: false }), node: node({ device: async () => cant }) }))
      .toEqual({ kind: 'unavailable', error: 'BIND_REFUSED', reason: 'device_desktop' });
    // Another wallet's node on this device is named on the sheet.
    const other = node({ localNode: async () => ({ nodeId: 'light_mobile_0123456789abcdef', walletAddress: 'someone' }) });
    expect(await prepareOffer(link, { wallet: WALLET, session: session({ burnTx: null, walletHash: null, check: false }), node: other }))
      .toMatchObject({ switchFrom: 'someone' });
    // A network that does not serve the binding yet cannot take the sheet's binding.
    expect(await prepareOffer(link, { wallet: WALLET, session: session({ burnTx, walletHash: null, check: false }), node: node({ status: async () => ({ onChain: false, features: [] }) }) }))
      .toMatchObject({ error: 'NETWORK' });
  });

  // R6, one wallet one node: the consent to a light registration is never given for a wallet the network holds a super
  // or genesis node for, even one no device of this install linked; without two genesis nodes' answer, none either.
  it('link: no consent while the network holds a super node for the wallet, or cannot say', async () => {
    const fresh = (otherNode) => node({ status: async () => ({ onChain: false, features: ['bind_v2', 'pending_bind'] }), otherNode });
    const ask = (n) => prepareOffer(link, { wallet: WALLET, session: session({ burnTx, walletHash: null, check: true }), node: n });
    const other = jest.fn(async () => true);
    expect(await ask(fresh(other))).toEqual({ kind: 'unavailable', error: 'NODE_OTHER' });
    expect(other).toHaveBeenCalledWith(W.address);
    expect(await ask(fresh(async () => null))).toEqual({ kind: 'unavailable', error: 'NETWORK' });
    expect(await ask(fresh(async () => false))).toMatchObject({ kind: 'link', mode: 'consent', burnTx });
    // A node already on the chain is this wallet's light node: linking it asks nothing more.
    const onChain = node({ otherNode: jest.fn(async () => true) });
    expect(await prepareOffer(link, { wallet: WALLET, session: session({ burnTx: null, walletHash: null, check: false }), node: onChain }))
      .toMatchObject({ kind: 'link', mode: 'device' });
    expect(onChain.otherNode).not.toHaveBeenCalled();
    // The actions ask two genesis nodes by the wallet (verify-activation), a super node counting.
    const { nodeLinkActions } = require('../src/services/NodeLinkActions');
    const wm = { confirmServerNode: jest.fn(async () => true) };
    expect(await nodeLinkActions({ walletManager: wm, credential: 'c' }).otherNode(W.address)).toBe(true);
    expect(wm.confirmServerNode).toHaveBeenCalledWith(W.address, { nodeType: 'super' });
    wm.confirmServerNode = jest.fn(async () => { throw new Error('down'); });
    expect(await nodeLinkActions({ walletManager: wm, credential: 'c' }).otherNode(W.address)).toBe(null);
  });

  // R6, one node type per wallet, chosen once: aiqnet.io's record of a super node's burn the network does not list yet
  // refuses the light consent too, in every state it can hold one; a record it cannot read gives no consent.
  it('link: no consent while aiqnet.io holds a super node\'s burn for the wallet, or its record cannot be read', async () => {
    const fresh = (over) => node({ status: async () => ({ onChain: false, features: ['bind_v2', 'pending_bind'] }), ...over });
    const ask = (n) => prepareOffer(link, { wallet: WALLET, session: session({ burnTx, walletHash: null, check: true }), node: n });
    for (const state of ['reserved', 'sending', 'recorded']) {
      const record = jest.fn(async () => ({ state, nodeType: 'super' }));
      expect([state, await ask(fresh({ record }))]).toEqual([state, { kind: 'unavailable', error: 'NODE_OTHER' }]);
      expect(record).toHaveBeenCalledWith(W.address);
    }
    // A super burn on record is said as such even while the genesis nodes cannot answer.
    expect(await ask(fresh({ otherNode: async () => null, record: async () => ({ state: 'recorded', nodeType: 'super' }) })))
      .toEqual({ kind: 'unavailable', error: 'NODE_OTHER' });
    expect(await ask(fresh({ record: async () => null }))).toEqual({ kind: 'unavailable', error: 'NETWORK' });
    // The light burn the site holds for the wallet is the one this consent is for.
    for (const state of ['none', 'reserved', 'sending', 'recorded']) {
      const record = async () => ({ state, nodeType: state === 'none' ? null : 'light' });
      expect([state, await ask(fresh({ record }))]).toEqual([state, expect.objectContaining({ kind: 'link', mode: 'consent', burnTx })]);
    }
    // Without both checks there is no consent at all.
    expect(await ask(fresh({ record: undefined }))).toEqual({ kind: 'unavailable', error: 'INTERNAL' });
    expect(await ask(fresh({ otherNode: undefined }))).toEqual({ kind: 'unavailable', error: 'INTERNAL' });
  });

  it('the actions read aiqnet.io\'s record of the wallet with no credentials; a failed read is null', async () => {
    const { nodeLinkActions } = require('../src/services/NodeLinkActions');
    const actions = nodeLinkActions({ walletManager: {}, credential: 'c' });
    const saved = global.fetch;
    try {
      global.fetch = jest.fn(async () => ({ status: 200, json: async () => ({ wallet: W.address, state: 'recorded', nodeType: 'super' }) }));
      expect(await actions.record(W.address)).toEqual({ state: 'recorded', nodeType: 'super' });
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe(`https://aiqnet.io/api/cabinet/activation/${W.address}`);
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit' });
      global.fetch = jest.fn(async () => ({ status: 503, json: async () => ({ error: 'unavailable' }) }));
      expect(await actions.record(W.address)).toBe(null);
      global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); });
      expect(await actions.record(W.address)).toBe(null);
    } finally {
      global.fetch = saved;
    }
  });

  it('claim: the amount from the app\'s own quorum, nothing to move below 1 QNC, and one move at a time', async () => {
    expect(await prepareOffer(claim, { wallet: WALLET, session: session({ walletHash: null }), node: node() }))
      .toEqual({ kind: 'claim', nodeId: W.nodeId, qnet: W.address, amountNano: 12500000000 });
    expect(await prepareOffer(claim, { wallet: WALLET, session: session({ walletHash: null }), node: node({ balance: async () => 999999999 }) }))
      .toEqual({ kind: 'claim_empty', nodeId: W.nodeId, qnet: W.address });
    expect(await prepareOffer(claim, { wallet: WALLET, session: session({ walletHash: null }), node: node({ balance: async () => null }) }))
      .toMatchObject({ error: 'NETWORK' });
    expect(await prepareOffer(claim, { wallet: WALLET, session: session({ walletHash: null }), node: node({ claimBusy: () => true }) }))
      .toMatchObject({ error: 'CLAIM_BUSY' });
  });
});

describe('what a confirmed request answers', () => {
  const offerLink = { kind: 'link', mode: 'consent', nodeId: W.nodeId, qnet: W.address, burnTx: 'b', device: CAPABLE, features: ['device_v1'] };

  it('link: the consent and whether the owner took the binding; a device switch its sequence; a refusal as BIND_REFUSED', async () => {
    const n = node();
    expect(await performIntent({ intent: 'link' }, offerLink, { node: n }))
      .toEqual({ status: 'ok', qnet: W.address, nodeId: W.nodeId, consent: { ts: '1790000000', pk: 'pk', sig: 'sig' }, bound: true, here: true, reason: null });
    expect(n.consent).toHaveBeenCalledWith({ nodeId: W.nodeId, burnTx: 'b', burner: null, device: CAPABLE, features: ['device_v1'] });
    // A binding refused for good: the consent still answers `ok`, and the refusal is for this device's screen only.
    const refused = await performIntent({ intent: 'link' }, offerLink, {
      node: node({ consent: async () => ({ consent: { ts: '1790000000', pk: 'pk', sig: 'sig' }, bound: false, reason: 'device_unlicensed' }) }),
    });
    expect(refused).toMatchObject({ status: 'ok', bound: false, reason: 'device_unlicensed' });
    const device = { ...offerLink, mode: 'device' };
    expect(await performIntent({ intent: 'link' }, device, { node: n }))
      .toEqual({ status: 'linked', qnet: W.address, nodeId: W.nodeId, seq: '1790086400' });
    expect(await performIntent({ intent: 'link' }, device, { node: node({ useDevice: async () => ({ ok: false, reason: 'device_unlicensed' }) }) }))
      .toEqual({ status: 'error', error: 'BIND_REFUSED', reason: 'device_unlicensed' });
    expect(await performIntent({ intent: 'link' }, device, { node: node({ useDevice: async () => ({ ok: false, reason: 'network' }) }) }))
      .toMatchObject({ status: 'error', error: 'NETWORK' });
  });

  it('claim: the moved amount as a decimal string, empty, or the network\'s refusal', async () => {
    const offer = { kind: 'claim', nodeId: W.nodeId, qnet: W.address, amountNano: 12500000000 };
    const n = node();
    expect(await performIntent({ intent: 'claim' }, offer, { node: n }))
      .toEqual({ status: 'ok', qnet: W.address, nodeId: W.nodeId, amountNano: '12500000000', txHash: 'ab'.repeat(32), stoppedAtEpoch: null });
    expect(n.claim).toHaveBeenCalledWith({ nodeId: W.nodeId, qnet: W.address, amountNano: 12500000000 });
    expect(await performIntent({ intent: 'claim' }, offer, { node: node({ claim: async () => ({ status: 'ok', amountNano: '5', txHash: 'x', stoppedAtEpoch: 160 }) }) }))
      .toMatchObject({ stoppedAtEpoch: '160' });
    expect(await performIntent({ intent: 'claim' }, offer, { node: node({ claim: async () => ({ status: 'error', error: 'CLAIM_REFUSED' }) }) }))
      .toEqual({ status: 'error', error: 'CLAIM_REFUSED' });
    expect(await performIntent({ intent: 'claim' }, { ...offer, kind: 'claim_empty' }, { node: n }))
      .toEqual({ status: 'empty', qnet: W.address, nodeId: W.nodeId });
  });
});

// A1: the page makes a one-time payment address for a wallet's light node only after that wallet signed that it may. The
// request names the wallet and the address; the answer is the wallet key's signature of aiqnet.io's node reservation.
describe('the reserve request', () => {
  const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');
  const { WalletManager } = require('../src/components/WalletManager');
  const { EXPLORER_API, SOLANA_CLUSTER } = require('../src/config/nodes');
  const KAT = require('./fixtures/wallet_kat.json');
  const KEYS = ml_dsa65.keygen(hex(KAT.xi_shake256));
  const CONTEXT = new TextEncoder().encode('QNET_OFFCHAIN_MSG_v1');
  const PAYER = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
  const KWALLET = { qnetAddress: KAT.eon_address, solanaAddress: LN.burner.address };
  const REQUEST = { walletHash: walletHashOf(KAT.eon_address), burner: PAYER };
  const ID = '0123456789abcdef0123456789abcdef';
  const SITE_PUB = byName('connect-ok').sessionRequest.sitePub;
  const reserveLink = (request = REQUEST) => `${LINK.PREFIX}${ID}.${SITE_PUB}.reserve.${reqHashOf(requestText('reserve', request))}`;
  const T = 1790000000;
  // The site's check of the answer (C2): the envelope of the request's facts at `time`, for its own origin.
  const siteVerifies = (answer, request = REQUEST) => {
    const message = `QNet node reservation v1\nwallet: ${answer.qnet}\nnode: light\nway: payment\nburner: ${request.burner}\n`
      + `time: ${answer.time}\ncluster: devnet`;
    const envelope = Buffer.concat([Buffer.from(`QNet Signed Message:\nhttps://aiqnet.io\n${Buffer.byteLength(message)}\n`),
      Buffer.from(message)]);
    return ml_dsa65.verify(decodeB64url(answer.sig, 3309), envelope, decodeB64url(answer.pk, 1952), { context: CONTEXT });
  };
  const signer = () => {
    const wm = new WalletManager();
    wm.loadWallet = jest.fn(async () => ({
      qnetAddress: KAT.eon_address,
      qnetKeypair: { publicKey: Array.from(KEYS.publicKey), privateKey: Array.from(KEYS.secretKey), path: 'QNET_WALLET_MLDSA65_fips204' },
    }));
    return wm;
  };

  it('its link, request and caps: the wallet and the one-time address, always both', () => {
    const link = reserveLink();
    expect(link).toHaveLength(156);
    expect(parseLink(link)).toEqual({ id: ID, sitePub: SITE_PUB, intent: 'reserve', reqHash: reqHashOf(requestText('reserve', REQUEST)) });
    expect(parseLink(link.slice(0, link.lastIndexOf('.')))).toBeNull(); // a reservation always carries its request hash
    expect(requestText('reserve', { burner: PAYER, walletHash: REQUEST.walletHash }))
      .toBe(`{"walletHash":"${REQUEST.walletHash}","burner":"${PAYER}"}`);
    for (const bad of [{ ...REQUEST, walletHash: null }, { ...REQUEST, burner: 'not-base58!' }, { ...REQUEST, burner: byName('link-ok-check').request.burnTx },
      { ...REQUEST, burner: null }, { ...REQUEST, extra: 1 }, { walletHash: REQUEST.walletHash }, { ...REQUEST, walletHash: 'ABCDEF0123456789' }]) {
      expect(requestText('reserve', bad)).toBeNull();
    }
    expect(LINK.CAPS.reserve).toEqual({ plaintext: 8192, ct: 8208 });
    expect(LINK.STATUSES.reserve).toEqual(['ok', 'rejected', 'error']);
    expect(LINK.INTENT_ERRORS.reserve).toEqual(['NO_WALLET', 'WALLET_MISMATCH', 'NODE_OTHER', 'NETWORK', 'INTERNAL']);
    expect([LINK.RESERVE_PAST_S, LINK.RESERVE_FUTURE_S, LINK.RESERVE_SKEW_S]).toEqual([900, 300, 300]);
  });

  it('the relay session must carry exactly the request the link hashes', async () => {
    const link = parseLink(reserveLink());
    const view = { id: ID, sitePub: SITE_PUB, intent: 'reserve', request: REQUEST, reqHash: link.reqHash, answered: false, expiresIn: 500 };
    relay = () => reply(200, view);
    expect((await openSession(link)).request).toEqual(REQUEST);
    for (const body of [{ ...view, request: { ...REQUEST, burner: LN.burner.address } }, { ...view, request: { walletHash: REQUEST.walletHash } }]) {
      relay = () => reply(200, body);
      await expect(openSession(link)).rejects.toMatchObject({ reason: 'mismatch' });
    }
  });

  it('offers the sheet only for the open wallet, and never for a wallet with a server node or a super node\'s burn', async () => {
    const link = parseLink(reserveLink());
    const ask = (n, request = REQUEST, wallet = KWALLET) => prepareOffer(link, { wallet, session: session(request), node: n });
    const n = node({ reserve: jest.fn() });
    expect(await ask(n)).toEqual({ kind: 'reserve', qnet: KAT.eon_address, nodeId: LN.wallets[0].nodeId, burner: PAYER });
    expect(n.status).not.toHaveBeenCalled(); // the network's view of the light node is the site's to check
    expect(n.reserve).not.toHaveBeenCalled(); // nothing is signed before Confirm
    expect(await ask(n, REQUEST, null)).toEqual({ kind: 'unavailable', error: 'NO_WALLET' });
    expect(await ask(n, { ...REQUEST, walletHash: walletHashOf(LN.wallets[1].address) })).toEqual({ kind: 'unavailable', error: 'WALLET_MISMATCH' });
    expect(await ask(node({ reserve: jest.fn(), serverNode: true }))).toEqual({ kind: 'unavailable', error: 'NODE_OTHER' });
    expect(await ask(node({ reserve: jest.fn(), otherNode: async () => true }))).toEqual({ kind: 'unavailable', error: 'NODE_OTHER' });
    for (const state of ['reserved', 'sending', 'recorded']) {
      expect([state, await ask(node({ reserve: jest.fn(), record: async () => ({ state, nodeType: 'super' }) }))])
        .toEqual([state, { kind: 'unavailable', error: 'NODE_OTHER' }]);
    }
    expect(await ask(node({ reserve: jest.fn(), otherNode: async () => null }))).toEqual({ kind: 'unavailable', error: 'NETWORK' });
    expect(await ask(node({ reserve: jest.fn(), record: async () => null }))).toEqual({ kind: 'unavailable', error: 'NETWORK' });
    expect(await ask(node())).toEqual({ kind: 'unavailable', error: 'INTERNAL' }); // no signer for it
    expect(await prepareOffer(link, { wallet: KWALLET, session: session(REQUEST), node: null })).toEqual({ kind: 'unavailable', error: 'INTERNAL' });
  });

  it('Confirm: the wallet key signs the reservation at T = now, which the site verifies for its origin', async () => {
    const wm = signer();
    const { nodeLinkActions } = require('../src/services/NodeLinkActions');
    const actions = nodeLinkActions({ walletManager: wm, credential: 'qnet-session:t' });
    const offer = { kind: 'reserve', qnet: KAT.eon_address, nodeId: LN.wallets[0].nodeId, burner: PAYER };
    const answer = await performIntent({ intent: 'reserve' }, offer, { node: actions, now: () => T * 1000 + 999 });
    expect(Object.keys(answer)).toEqual(['status', 'qnet', 'time', 'pk', 'sig']);
    expect(answer).toMatchObject({ status: 'ok', qnet: KAT.eon_address, time: String(T) });
    expect(wm.loadWallet).toHaveBeenCalledWith('qnet-session:t');
    expect(siteVerifies(answer)).toBe(true);
    expect(siteVerifies(answer, { ...REQUEST, burner: LN.burner.address })).toBe(false); // bound to the payment address
    expect(siteVerifies({ ...answer, time: String(T + 1) })).toBe(false);
    const view = { intent: 'reserve', request: REQUEST };
    const text = buildPlaintext(view, answer, { now: T });
    expect(JSON.parse(text)).toEqual({ v: 1, intent: 'reserve', ...answer });
    expect(Object.keys(JSON.parse(text))).toEqual(['v', 'intent', 'status', 'qnet', 'time', 'pk', 'sig']);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LINK.CAPS.reserve.plaintext);
    // The record origin is the build's site, the same one the relay has (the sandbox build moves both together).
    expect(EXPLORER_API).toBe(LINK.RELAY);
    expect(SOLANA_CLUSTER).toBe('devnet');
  });

  it('Confirm refuses to send what it did not sign for this wallet, now', async () => {
    const offer = { kind: 'reserve', qnet: KAT.eon_address, nodeId: LN.wallets[0].nodeId, burner: PAYER };
    const good = await signer().signNodeReservation('t', { burner: PAYER, time: T });
    const run = (r, now = () => T * 1000) => performIntent({ intent: 'reserve' }, offer, { node: { reserve: async () => r }, now });
    expect(await run(good)).toMatchObject({ status: 'ok' });
    expect(await run({ ...good, pk: encodeB64url(ml_dsa65.keygen(new Uint8Array(32).fill(7)).publicKey) })).toEqual({ status: 'error', error: 'INTERNAL' });
    expect(await run({ ...good, sig: good.sig.slice(0, 100) })).toEqual({ status: 'error', error: 'INTERNAL' });
    expect(await run(null)).toEqual({ status: 'error', error: 'INTERNAL' });
    let reads = 0; // the clock moved more than the skew while it signed
    expect(await run(good, () => (reads++ === 0 ? T * 1000 : (T + 301) * 1000))).toEqual({ status: 'error', error: 'INTERNAL' });
  });

  it('its answer is checked as the site checks it: every key, the wallet, its key, the signature\'s size and the time', async () => {
    const good = await signer().signNodeReservation('t', { burner: PAYER, time: T });
    const view = { intent: 'reserve', request: REQUEST };
    const text = (over = {}, drop = null) => {
      const obj = { v: 1, intent: 'reserve', status: 'ok', qnet: KAT.eon_address, time: String(T), pk: good.pk, sig: good.sig, ...over };
      if (drop) delete obj[drop];
      return JSON.stringify(obj);
    };
    expect(plaintextProblem(text(), view, { now: T })).toBeNull();
    expect(plaintextProblem(text(), view, { now: T + 900 })).toBeNull();
    expect(plaintextProblem(text(), view, { now: T + 901 })).toBe('time');
    expect(plaintextProblem(text(), view, { now: T - 301 })).toBe('time');
    expect(plaintextProblem(text({ time: T }), view, { now: T })).toBe('time');
    expect(plaintextProblem(text({ time: '01790000000' }), view, { now: T })).toBe('time');
    expect(plaintextProblem(text({}, 'time'), view, { now: T })).toBe('keys');
    expect(plaintextProblem(text({ nodeId: LN.wallets[0].nodeId }), view, { now: T })).toBe('keys');
    expect(plaintextProblem(text({ qnet: LN.wallets[1].address }), view, { now: T })).toBe('walletHash');
    expect(plaintextProblem(text({ pk: encodeB64url(new Uint8Array(1952)) }), view, { now: T })).toBe('pk');
    expect(plaintextProblem(text({ sig: good.sig.slice(0, -4) }), view, { now: T })).toBe('sig');
    expect(plaintextProblem(text({ status: 'linked' }), view, { now: T })).toBe('status');
    expect(plaintextProblem('{"v":1,"intent":"reserve","status":"error","error":"NO_NODE"}', view)).toBe('error');
    expect(plaintextProblem('{"v":1,"intent":"reserve","status":"error","error":"NODE_OTHER"}', view)).toBeNull();
    expect(plaintextProblem('{"v":1,"intent":"reserve","status":"rejected"}', view)).toBeNull();
  });

  it('the answer goes sealed to the session and its request, and asks for no check number', async () => {
    const link = parseLink(reserveLink());
    const answer = await performIntent({ intent: 'reserve' }, { kind: 'reserve', qnet: KAT.eon_address, burner: PAYER },
      { node: { reserve: async ({ burner, time }) => signer().signNodeReservation('t', { burner, time }) } });
    relay = () => reply(201, { ok: true });
    const onCheck = jest.fn();
    expect(await deliverAnswer(link, { expiresAt: Date.now() + 500000, request: REQUEST }, answer, { onCheck })).toBe('delivered');
    expect(onCheck).not.toHaveBeenCalled();
    expect(JSON.parse(calls[0].body).ct.length).toBeGreaterThan(7000);
  });

  // The site's reservation cases (docs/protocols/light-node.vectors.json): the site's signed answer verifies over the
  // reservation the app builds itself from the request, for aiqnet.io's origin, so both write the same message.
  it('every reserve case of the shared vectors, and the signed one verifies over the app\'s own reservation', () => {
    const { buildSiteRecord, nodeReservationMessage } = require('../src/crypto/OffchainMessage');
    const cases = V.cases.filter((c) => c.intent === 'reserve');
    expect(cases.map((c) => JSON.parse(c.plaintext).status).sort()).toEqual(['error', 'ok', 'rejected']);
    for (const c of cases) {
      expect([c.name, requestText('reserve', c.request)]).toEqual([c.name, c.requestText]);
      expect([c.name, parseLink(c.link)]).toEqual([c.name, expect.objectContaining({ intent: 'reserve', reqHash: c.reqHash })]);
      const a = JSON.parse(c.plaintext);
      if (a.status !== 'ok') continue;
      const message = nodeReservationMessage({
        wallet: a.qnet, nodeType: 'light', way: 'payment', burner: c.request.burner, time: Number(a.time), cluster: SOLANA_CLUSTER,
      });
      const ok = ml_dsa65.verify(decodeB64url(a.sig, 3309), buildSiteRecord(LINK.RELAY, message), decodeB64url(a.pk, 1952), { context: CONTEXT });
      expect([c.name, ok]).toEqual([c.name, true]);
      expect([c.name, siteVerifies(a, c.request)]).toEqual([c.name, true]);
    }
  });
});

// Owner, 30.09: the Node tab has no off switch; aiqnet.io's Device tab sends an `unlink` request, which QNet Wallet on the
// device that runs the node confirms, and that device's own ping key signs the unbind (light-node-messages section 4).
describe('the unlink request', () => {
  const c = byName('unlink-ok');
  const unlinkLink = linkOf(c);
  const BOUND_AT = 1790000000;

  it('its link, request and caps: always the wallet the page shows', () => {
    expect(unlinkLink).toMatchObject({ intent: 'unlink', reqHash: c.reqHash });
    expect(c.request).toEqual({ walletHash: walletHashOf(W.address) });
    expect(requestText('unlink', c.request)).toBe(c.requestText);
    expect(requestText('unlink', { walletHash: null })).toBeNull();
    expect(requestText('unlink', { ...c.request, check: false })).toBeNull();
    expect(LINK.CAPS.unlink).toEqual({ plaintext: 1024, ct: 1040 });
    expect(LINK.INTENT_ERRORS.unlink).toEqual(['NO_WALLET', 'WALLET_MISMATCH', 'NOT_LINKED', 'NETWORK', 'UNLINK_REFUSED', 'INTERNAL']);
    expect(parseLink(c.link.slice(0, c.link.lastIndexOf('.')))).toBeNull();
  });

  const offerWith = (n, request = c.request, wallet = WALLET) => prepareOffer(unlinkLink, { wallet, session: session(request), node: n });
  const LOCAL = { nodeId: W.nodeId, seq: BOUND_AT, boundAt: BOUND_AT };
  const linkedView = (over = {}) => ({
    onChain: true, features: ['unbind_wallet'], deviceBoundAgreed: true,
    device: { platform: 'ios', linkedSince: 1790035200, lastAnswerEpoch: 7, state: 'offline' }, ...over,
  });

  it('on the device that runs the node: its own unbind, unless two owners name another binding (contract 1.9b)', async () => {
    const here = { kind: 'unlink', mode: 'here', qnet: W.address, nodeId: W.nodeId, since: BOUND_AT };
    // The network names this binding, or gives no verdict on it: this device's own unbind, the network's view not read.
    for (const signed of [{ bindingSeqAgreed: BOUND_AT }, { bindingSeqAgreed: null }, null]) {
      const n = node({ binding: jest.fn(async () => LOCAL), pingStatus: jest.fn(async () => signed), status: jest.fn() });
      expect(await offerWith(n)).toEqual(here);
      expect(n.binding).toHaveBeenCalledWith(W.nodeId);
      expect(n.status).not.toHaveBeenCalled();
    }
    // Two owners name a newer binding: the one here is stale, and the wallet key unlinks the device that holds it.
    const stale = node({
      binding: async () => LOCAL, pingStatus: async () => ({ bindingSeqAgreed: BOUND_AT + 9 }),
      status: jest.fn(async () => linkedView()), unlinkByWallet: jest.fn(),
    });
    expect(await offerWith(stale)).toMatchObject({ kind: 'unlink', mode: 'wallet' });
  });

  it('on any other device that holds the wallet: the wallet key, once two genesis nodes serve it', async () => {
    const n = (over) => node({ binding: async () => null, status: jest.fn(async () => linkedView(over)), unlinkByWallet: jest.fn() });
    expect(await offerWith(n({}))).toEqual({
      kind: 'unlink', mode: 'wallet', qnet: W.address, nodeId: W.nodeId, platform: 'ios', since: 1790035200,
    });
    expect(await offerWith(n({ device: null }))).toMatchObject({ platform: null, since: null });
    // No verdict on the chain or on the device: NETWORK; not on the chain, no device bound or the form not served: NOT_LINKED.
    expect(await offerWith(n({ onChain: null }))).toEqual({ kind: 'unavailable', error: 'NETWORK' });
    expect(await offerWith(n({ deviceBoundAgreed: null }))).toEqual({ kind: 'unavailable', error: 'NETWORK' });
    for (const over of [{ onChain: false }, { features: ['bind_v2'] }, { deviceBoundAgreed: false }]) {
      expect([over, await offerWith(n(over))]).toEqual([over, { kind: 'unavailable', error: 'NOT_LINKED' }]);
    }
    // Another wallet's request, no wallet, or a build whose Node side cannot tell: nothing to confirm.
    expect(await offerWith(n({}), { walletHash: '0'.repeat(16) })).toMatchObject({ error: 'WALLET_MISMATCH' });
    expect(await offerWith(n({}), c.request, null)).toMatchObject({ error: 'NO_WALLET' });
    expect(await offerWith(node({ status: undefined, binding: async () => null }))).toMatchObject({ error: 'INTERNAL' });
    expect(await offerWith(node())).toMatchObject({ error: 'INTERNAL' });
  });

  it('Confirm in wallet mode: ok only when the network took the unbind; a refusal as the wire names it', async () => {
    const offer = { kind: 'unlink', mode: 'wallet', qnet: W.address, nodeId: W.nodeId, platform: 'android', since: null };
    const n = node({ unlinkByWallet: jest.fn(async () => ({ status: 'ok', unbound: true })), unlink: jest.fn() });
    const ok = await performIntent(unlinkLink, offer, { node: n });
    expect(ok).toEqual({ status: 'ok', qnet: W.address, nodeId: W.nodeId, unbound: true, byWallet: true });
    expect(n.unlinkByWallet).toHaveBeenCalledWith(W.nodeId);
    expect(n.unlink).not.toHaveBeenCalled();
    // The screen's own mark never reaches the wire: the row's keys alone.
    expect(JSON.parse(buildPlaintext(viewOf(c), ok))).toEqual({ v: 1, intent: 'unlink', status: 'ok', qnet: W.address, nodeId: W.nodeId, unbound: true });
    for (const error of ['NOT_LINKED', 'NETWORK', 'UNLINK_REFUSED', 'INTERNAL']) {
      expect(await performIntent(unlinkLink, offer, { node: node({ unlinkByWallet: async () => ({ status: 'error', error }) }) }))
        .toEqual({ status: 'error', error });
    }
    expect(await performIntent(unlinkLink, offer, { node: node({ unlinkByWallet: async () => ({ status: 'error', error: 'BIND_REFUSED' }) }) }))
      .toEqual({ status: 'error', error: 'INTERNAL' });
  });

  it('the Node side of the wallet form: the binding two owners name, the wallet key\'s unbind, a stale_seq read again', async () => {
    jest.resetModules();
    const statuses = [];
    const light = {
      readNodeStatus: jest.fn(async (id, opts) => {
        expect(opts.signStatus).toEqual(expect.any(Function));
        return statuses.shift();
      }),
      postUnbind: jest.fn(async () => ({ ok: true, answer: { success: true, unbound: true, binding_seq: 1790000500 } })),
    };
    jest.doMock('../src/services/LightNode', () => light);
    jest.doMock('../src/services/PushService', () => ({}));
    jest.doMock('../src/services/NodeDeviceKey', () => ({ checkDevice: jest.fn() }));
    jest.doMock('../src/services/NodeRecordRead', () => ({ readNodeRecordState: jest.fn() }));
    const { nodeLinkActions } = require('../src/services/NodeLinkActions');
    const wm = {
      signNodeStatus: jest.fn(async () => ({ signer: 'wallet', sig: 'ab', identityPublicKey: 'pk' })),
      signNodeUnbind: jest.fn(async () => ({ sig: 'cd'.repeat(3309), identityPublicKey: 'ef'.repeat(1952) })),
    };
    const onUnlinked = jest.fn();
    const actions = nodeLinkActions({ walletManager: wm, credential: 'cred', onUnlinked });
    const bound = { onChain: true, deviceBoundAgreed: true, bindingSeqAgreed: 1790000500, features: ['unbind_wallet'] };
    statuses.push(bound);
    expect(await actions.unlinkByWallet(W.nodeId)).toEqual({ status: 'ok', unbound: true });
    expect(wm.signNodeUnbind).toHaveBeenCalledWith('cred', W.nodeId, 1790000500, expect.any(Number));
    expect(light.postUnbind.mock.calls[0][1]).toEqual({
      node_id: W.nodeId, seq: 1790000500, ts: expect.any(Number), signer: 'wallet', sig: 'cd'.repeat(3309), identity_pubkey: 'ef'.repeat(1952),
    });
    expect(onUnlinked).toHaveBeenCalledTimes(1);
    // A newer binding meanwhile: read again; none bound now is done, one bound is a refusal.
    light.postUnbind.mockResolvedValue({ ok: false, reason: 'stale_seq' });
    statuses.push(bound, { ...bound, deviceBoundAgreed: false });
    expect(await actions.unlinkByWallet(W.nodeId)).toEqual({ status: 'ok', unbound: true });
    statuses.push(bound, bound);
    expect(await actions.unlinkByWallet(W.nodeId)).toEqual({ status: 'error', error: 'UNLINK_REFUSED' });
    light.postUnbind.mockResolvedValue({ ok: false, reason: 'network' });
    statuses.push(bound);
    expect(await actions.unlinkByWallet(W.nodeId)).toEqual({ status: 'error', error: 'NETWORK' });
    light.postUnbind.mockResolvedValue({ ok: false, reason: 'bad_signature' });
    statuses.push(bound);
    expect(await actions.unlinkByWallet(W.nodeId)).toEqual({ status: 'error', error: 'UNLINK_REFUSED' });
    // Nothing bound, or no verdict: nothing is signed.
    wm.signNodeUnbind.mockClear();
    statuses.push({ ...bound, deviceBoundAgreed: false });
    expect(await actions.unlinkByWallet(W.nodeId)).toEqual({ status: 'error', error: 'NOT_LINKED' });
    statuses.push({ ...bound, onChain: null });
    expect(await actions.unlinkByWallet(W.nodeId)).toEqual({ status: 'error', error: 'NETWORK' });
    statuses.push({ ...bound, bindingSeqAgreed: null });
    expect(await actions.unlinkByWallet(W.nodeId)).toEqual({ status: 'error', error: 'NETWORK' });
    expect(wm.signNodeUnbind).not.toHaveBeenCalled();
    jest.dontMock('../src/services/PushService');
    jest.dontMock('../src/services/LightNode');
    jest.dontMock('../src/services/NodeDeviceKey');
    jest.dontMock('../src/services/NodeRecordRead');
  });

  it('Confirm: this device\'s unbind goes out and the device stops; the answer says whether the network took it', async () => {
    const offer = { kind: 'unlink', qnet: W.address, nodeId: W.nodeId, since: BOUND_AT };
    const n = node({ unlink: jest.fn(async () => ({ unbound: true })) });
    expect(await performIntent(unlinkLink, offer, { node: n })).toEqual({ status: 'ok', qnet: W.address, nodeId: W.nodeId, unbound: true });
    expect(n.unlink).toHaveBeenCalledWith(W.nodeId);
    expect(await performIntent(unlinkLink, offer, { node: node({ unlink: async () => ({ unbound: false }) }) }))
      .toEqual({ status: 'ok', qnet: W.address, nodeId: W.nodeId, unbound: false });
    // Built as the site checks it, byte for byte the vectors' answers.
    for (const name of ['unlink-ok', 'unlink-ok-unconfirmed', 'unlink-rejected', 'unlink-error']) {
      const v = byName(name);
      expect(buildPlaintext(viewOf(v), answerOf(v))).toBe(v.plaintext);
    }
    expect(plaintextProblem('{"v":1,"intent":"unlink","status":"ok","qnet":"' + W.address + '","nodeId":"' + W.nodeId + '","unbound":"yes"}',
      viewOf(c))).toBe('unbound');
  });

  it('the Node side: the unbind of PushService.stopLightNode, only for this device\'s own binding, then the tab reads again', async () => {
    jest.resetModules();
    const push = { localBinding: jest.fn(async () => ({ nodeId: W.nodeId, seq: 7 })), stopLightNode: jest.fn(async () => ({ unbound: true })) };
    jest.doMock('../src/services/PushService', () => push);
    jest.doMock('../src/services/LightNode', () => ({ readNodeStatus: jest.fn() }));
    jest.doMock('../src/services/NodeDeviceKey', () => ({ checkDevice: jest.fn() }));
    jest.doMock('../src/services/NodeRecordRead', () => ({ readNodeRecordState: jest.fn() }));
    const { nodeLinkActions } = require('../src/services/NodeLinkActions');
    const onUnlinked = jest.fn();
    const actions = nodeLinkActions({ walletManager: {}, credential: 'x', onUnlinked });
    expect(await actions.binding(W.nodeId)).toEqual({ nodeId: W.nodeId, seq: 7 });
    expect(await actions.unlink(W.nodeId)).toEqual({ unbound: true });
    expect(push.stopLightNode).toHaveBeenCalledTimes(1);
    expect(onUnlinked).toHaveBeenCalledTimes(1);
    push.localBinding.mockResolvedValueOnce(null);
    expect(await actions.unlink(W.nodeId)).toEqual({ unbound: false });
    expect(push.stopLightNode).toHaveBeenCalledTimes(1);
    jest.dontMock('../src/services/PushService');
    jest.dontMock('../src/services/LightNode');
    jest.dontMock('../src/services/NodeDeviceKey');
    jest.dontMock('../src/services/NodeRecordRead');
  });

  it('the sheet: its title, what stops and what stays, since when it ran here, and the outcome', () => {
    const t = require('../src/i18n').makeT('en');
    const screen = read('src/screens/QNetLinkScreen.js');
    expect(screen).toMatch(/unlink: 'link_title_unlink',/);
    expect(screen).toMatch(/\{Number\.isSafeInteger\(o\.since\) \? row\(t\('link_unlink_since'\), dayText\(o\.since\)\) : null\}/);
    expect(screen).toMatch(/t\(a\.unbound === true \? 'link_result_unlinked' : 'link_result_unlinked_unconfirmed'\)/);
    expect(t('link_title_unlink')).toBe("Unlink this wallet's node from this device");
    // The sheet names no website and no other place: it says what happens on this device.
    for (const k of ['link_unlink_body', 'link_result_unlinked', 'link_result_unlinked_unconfirmed', 'link_err_NOT_LINKED']) {
      expect([k, /aiqnet|website|http/i.test(t(k))]).toEqual([k, false]);
    }
  });
});

describe('only a verified link reaches the app', () => {
  it('Android: one App Link filter, https://link.aiqnet.io/l exactly, verified, and no custom scheme', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    const filters = [...manifest.matchAll(/<intent-filter([^>]*)>([\s\S]*?)<\/intent-filter>/g)];
    const views = filters.filter((f) => f[2].includes('android.intent.action.VIEW'));
    expect(views).toHaveLength(1);
    const [, attrs, body] = views[0];
    expect(attrs).toMatch(/android:autoVerify="true"/);
    const data = [...body.matchAll(/<data ([^>]*)\/>/g)].map((m) => m[1]);
    expect(data).toEqual(['android:scheme="https" android:host="link.aiqnet.io" android:path="/l" ']);
    expect(manifest).not.toMatch(/pathPrefix|pathPattern|android:scheme="(?!https")/);
  });

  it('Android: an activity restored or relaunched from recents does not hand its old link over again', () => {
    const activity = read('android/app/src/main/java/com/qnetmobile/MainActivity.kt');
    expect(activity).toMatch(/FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY/);
    expect(activity).toMatch(/intent\.data = null\s*\}\s*super\.onCreate/);
  });

  it('iOS: Universal Links for link.aiqnet.io only, forwarded to Linking; no custom URL scheme', () => {
    const entitlements = read('ios/QNetMobile/QNetMobile.entitlements');
    const domains = /<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(entitlements)[1];
    expect([...domains.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])).toEqual(['applinks:link.aiqnet.io']);
    const app = read('ios/QNetMobile/AppDelegate.swift');
    expect(app).toMatch(/RCTLinkingManager\.application\(application, continue: userActivity/);
    expect(read('ios/QNetMobile/Info.plist')).not.toMatch(/CFBundleURLTypes/);
  });

  it('the screen takes links only from the OS, through the parser', () => {
    const screen = read('src/screens/WalletScreen.js');
    expect([...screen.matchAll(/setLinkRequest\(/g)].length).toBe(5);
    expect(screen).toMatch(/const link = parseLink\(url\);\s*if \(!link\) \{/);
    expect(screen).toMatch(/takeInitialUrl\(Linking\)\.then\(receive\)/);
  });
});
