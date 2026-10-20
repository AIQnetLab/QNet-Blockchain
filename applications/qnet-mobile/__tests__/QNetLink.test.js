// QNet Link v1 revision 2 on the device (docs/protocols/qnet-link-v1.md section 14): the strict link parser, the request
// and its hash, the X25519 / HKDF / AES-GCM answer and the check number against the vectors the site and the extension
// share (docs/protocols/light-node.vectors.json, key `link`; the `claim` exchanges, whose request names the node, from
// docs/protocols/node-claim.vectors.json), the answer schema, the relay client that refuses any session that does not
// match its link and request, what each intent offers and answers, and the platform wiring that lets only a verified link
// in. An `activate` link is not a link to this app.
const fs = require('fs');
const path = require('path');
const { x25519 } = require('@noble/curves/ed25519');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const {
  LINK, parseLink, decodeB64url, encodeB64url, contributoryKey, sealAnswer, openAnswer, sessionKey, checkNumber,
  groupCheckNumber, requestText, reqHashOf, walletHashOf, buildPlaintext, plaintextProblem, openSession, deliverAnswer,
  markHandled, wasHandled, LinkRefusal, prepareOffer, performIntent,
} = require('../src/services/QNetLink');
const { superNodeId } = require('../src/crypto/NodePreimages');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LN = JSON.parse(fs.readFileSync(path.join(ROOT, '../../docs/protocols/light-node.vectors.json'), 'utf8'));
const V = LN.link;
const C0 = LN.constants.link;
// Revision 1's file keeps what revision 2 did not repeat: its activate links and the low-order points.
const R1 = JSON.parse(fs.readFileSync(path.join(ROOT, '../../docs/protocols/qnet-link-v1.vectors.json'), 'utf8'));
// A `claim` request names the node, the wallet's light or super node (12.10): its exchanges are node-claim.vectors.json's.
// The claim cases of light-node.vectors.json keep the earlier request, which named no node: the app refuses it.
const NC = JSON.parse(fs.readFileSync(path.join(ROOT, '../../docs/protocols/node-claim.vectors.json'), 'utf8'));
const LEGACY_CLAIM = V.cases.filter((c) => c.intent === 'claim');
const CASES = [...V.cases.filter((c) => c.intent !== 'claim'), ...NC.cases];
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
const byName = (n) => CASES.find((c) => c.name === n);

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
    expect(LINK.REQUEST_KEYS).toEqual({ ...C0.requestKeys, claim: NC.constants.requestKeys });
    expect([...LINK.ERRORS].sort()).toEqual([...new Set(Object.values(C0.errors).flat())].sort());
    expect([LINK.CONSENT_PAST_S, LINK.CONSENT_FUTURE_S]).toEqual([C0.consentWindow.pastSeconds, C0.consentWindow.futureSeconds]);
    expect([LINK.RESERVE_PAST_S, LINK.RESERVE_FUTURE_S]).toEqual([C0.reserveWindow.pastSeconds, C0.reserveWindow.futureSeconds]);
    expect(String(LINK.CLAIM_MIN_NANO)).toBe(C0.claimMinNano);
    expect(String(LINK.CLAIM_MIN_NANO)).toBe(NC.constants.claimMinNano);
    expect(LINK.RELAY).toBe('https://aiqnet.io');
  });
});

describe('the link', () => {
  it('parses every vector link to its session and request hash', () => {
    for (const c of [...V.cases, ...NC.cases]) {
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
    for (const c of CASES.filter((x) => x.intent !== 'connect')) {
      expect([c.name, requestText(c.intent, c.request)]).toEqual([c.name, c.requestText]);
      expect([c.name, reqHashOf(c.requestText)]).toEqual([c.name, c.reqHash]);
    }
  });

  it('a claim names the wallet and its light or super node; the earlier request, which named no node, is refused', () => {
    expect(LEGACY_CLAIM.length).toBe(6);
    for (const c of LEGACY_CLAIM) expect([c.name, requestText('claim', c.request)]).toEqual([c.name, null]);
    expect(NC.invalidSessionRequests.length).toBeGreaterThanOrEqual(8);
    for (const { why, body } of NC.invalidSessionRequests) expect([why, requestText('claim', JSON.parse(body).request)]).toEqual([why, null]);
    const r = { walletHash: W.walletHash, nodeId: superNodeId(W.address) };
    expect(requestText('claim', r)).toBe(`{"walletHash":"${W.walletHash}","nodeId":"${r.nodeId}"}`);
    // The protocol's order, whatever order the object has.
    expect(requestText('claim', { nodeId: W.nodeId, walletHash: W.walletHash })).toBe(`{"walletHash":"${W.walletHash}","nodeId":"${W.nodeId}"}`);
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
  it.each(CASES.map((c) => [c.name, c]))('%s: the app key and IV of the vector give its exact body and check number', (name, c) => {
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
    for (const c of CASES) {
      expect([c.name, buildPlaintext(viewOf(c), answerOf(c), windowOf(c.context))]).toEqual([c.name, c.plaintext]);
      expect([c.name, plaintextProblem(c.plaintext, viewOf(c), windowOf(c.context))]).toEqual([c.name, null]);
    }
  });

  it('refuses every invalid answer for the reason the vectors give (the consent signature is the app\'s own)', () => {
    expect(V.invalidPlaintexts.length).toBeGreaterThanOrEqual(25);
    // The checks before the node's: the earlier claim request names no node, so a claim answer that gets past these is
    // refused at the node check, whatever the vectors' reason after it.
    const beforeNode = ['size', 'json', 'v', 'intent', 'status', 'keys', 'error', 'qnet', 'solana'];
    for (const p of V.invalidPlaintexts) {
      const { intent } = V.cases.find((c) => c.name === p.session);
      const session = { intent, request: p.context.request };
      const got = plaintextProblem(p.plaintext, session, windowOf(p.context));
      // The app does not verify the ML-DSA signature it made itself; the site does.
      const want = intent === 'claim' && !beforeNode.includes(p.reason) ? 'nodeId' : (p.reason === 'sig' ? null : p.reason);
      expect([p.session, p.reason, got]).toEqual([p.session, p.reason, want]);
    }
    expect(NC.invalidPlaintexts.length).toBeGreaterThanOrEqual(10);
    for (const p of NC.invalidPlaintexts) {
      expect([p.why, plaintextProblem(p.plaintext, { intent: 'claim', request: p.context.request }, windowOf(p.context))])
        .toEqual([p.why, p.fail]);
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
    for (const c of CASES) {
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

  it('refuses the session of an earlier claim request, which named no node, as one that does not match its link', async () => {
    for (const c of LEGACY_CLAIM) {
      relay = () => reply(200, viewFor(c));
      await expect(openSession(linkOf(c))).rejects.toMatchObject({ reason: 'mismatch' });
    }
    // A request naming another node than the one the link's hash binds.
    const c = byName('claim-super-ok');
    relay = () => reply(200, viewFor(c, { request: { ...c.request, nodeId: W.nodeId } }));
    await expect(openSession(linkOf(c))).rejects.toMatchObject({ reason: 'mismatch' });
  });

  it('refuses an answered, expiring, unknown or unreachable session', async () => {
    const c = byName('claim-light-ok');
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
    const c = byName('claim-super-rejected');
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
  const claim = linkOf(byName('claim-light-ok'));
  const burnTx = byName('link-ok-check').request.burnTx;
  const S = superNodeId(W.address);
  const lightClaim = session({ walletHash: W.walletHash, nodeId: W.nodeId });
  const superClaim = session({ walletHash: W.walletHash, nodeId: S });

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
    expect(await prepareOffer(claim, { wallet: WALLET, session: lightClaim, node: node({ status: async () => ({ onChain: false, features: [] }) }) }))
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

  // A move request opened on the phone that already runs the node said "moves to this device", bound it again with a
  // new key and spent one of the node's moves. The network naming this device's binding (its ping-key status), with
  // nothing the Node tab offers Use this device for, offers only to tell the website: nothing is signed or sent.
  it('link: the node already runs here (the network names this device\'s binding): nothing moves', async () => {
    const LOCAL = { nodeId: W.nodeId, seq: 1790000000 };
    const ask = (n) => prepareOffer(link, { wallet: WALLET, session: session({ burnTx: null, walletHash: W.walletHash, check: false }), node: n });
    const here = node({ binding: jest.fn(async () => LOCAL), pingStatus: jest.fn(async () => ({ bindingSeqAgreed: LOCAL.seq, keyOurs: true })) });
    const offer = await ask(here);
    expect(offer).toEqual({ kind: 'link', mode: 'here', nodeId: W.nodeId, qnet: W.address, seq: LOCAL.seq });
    expect(here.binding).toHaveBeenCalledWith(W.nodeId);
    const answer = await performIntent(link, offer, { node: here });
    expect(answer).toEqual({ status: 'linked', qnet: W.address, nodeId: W.nodeId, seq: String(LOCAL.seq), already: true });
    expect(here.useDevice).not.toHaveBeenCalled();
    // The screen's mark never reaches the wire: the row's keys alone.
    const v = byName('link-ok-check');
    expect(JSON.parse(buildPlaintext(viewOf(v), answer))).toEqual({
      v: 1, intent: 'link', status: 'linked', qnet: W.address, nodeId: W.nodeId, seq: String(LOCAL.seq),
    });
    // Another binding named, a refused key, or no word on it: the move as before.
    for (const signed of [{ bindingSeqAgreed: LOCAL.seq + 9 }, { bindingSeqAgreed: null, keyOurs: false }, null]) {
      expect(await ask(node({ binding: async () => LOCAL, pingStatus: async () => signed }))).toMatchObject({ kind: 'link', mode: 'device' });
    }
    expect(await ask(node({ binding: async () => null, pingStatus: jest.fn() }))).toMatchObject({ kind: 'link', mode: 'device' });
    // Held here, but in a state the Node tab offers Use this device for (no device key, revoked, overdue, a check that
    // ended), or one that cannot be told: the request binds again, which mends it, rather than saying nothing changed.
    const signedHere = { bindingSeqAgreed: LOCAL.seq, keyOurs: true };
    for (const offersUse of [async () => true, async () => { throw new Error('down'); }]) {
      expect(await ask(node({ binding: async () => LOCAL, pingStatus: async () => signedHere, offersUse })))
        .toMatchObject({ kind: 'link', mode: 'device' });
    }
    const counted = jest.fn(async () => false);
    expect(await ask(node({ binding: async () => LOCAL, pingStatus: async () => signedHere, offersUse: counted })))
      .toMatchObject({ kind: 'link', mode: 'here' });
    expect(counted).toHaveBeenCalledWith(W.nodeId, signedHere, LOCAL);
  });

  // The Node tab's own view decides it (NodeTab nodeView offerUse), with the device check this device knows.
  it('the actions\' offersUse is the Node tab\'s Use this device offer for that status', async () => {
    const { nodeLinkActions } = require('../src/services/NodeLinkActions');
    const actions = nodeLinkActions({ walletManager: {}, credential: 'c', height: () => 0 });
    const base = {
      onChain: true, features: ['device_v1', 'status_signed'], deviceBoundAgreed: true, bindingSeqAgreed: 7, deviceTags: [],
      nonce: null, signed: { deviceState: 'active' }, needsReactivation: false, lastMiss: null, counted: null, device: null,
    };
    const hw = { nodeId: W.nodeId, seq: 7, hw: true, boundAt: null };
    expect(await actions.offersUse(W.nodeId, base, hw)).toBe(false);
    // No device key with the binding: Use this device gives it one.
    expect(await actions.offersUse(W.nodeId, base, { ...hw, hw: false })).toBe(true);
    // A pause with no end (the device's certificate chain revoked).
    expect(await actions.offersUse(W.nodeId, { ...base, signed: { deviceState: 'paused', pausedUntil: null } }, hw)).toBe(true);
    // A check-pending key with a rotation due, judged by the height the screen reads (the Node tab's), never a missing
    // one: past the grace it is overdue, within it the running check is waited for, and with no height read a new
    // binding mends it either way (the tab, once it reads the height, could offer Use this device).
    const { ROTATION_GRACE_EPOCHS } = require('../src/screens/NodeTab');
    const { EPOCH_BLOCKS } = require('../src/crypto/NodePreimages');
    const rotating = { ...base, signed: { deviceState: 'check_pending', rotationDue: 10, refreshWindow: { from: 1, to: 2 } } };
    const at = (epoch) => nodeLinkActions({ walletManager: {}, credential: 'c', height: async () => epoch * EPOCH_BLOCKS });
    expect(await at(10 + ROTATION_GRACE_EPOCHS + 1).offersUse(W.nodeId, rotating, hw)).toBe(true);
    expect(await at(10 + ROTATION_GRACE_EPOCHS).offersUse(W.nodeId, rotating, hw)).toBe(false);
    expect(await at(0).offersUse(W.nodeId, rotating, hw)).toBe(true);
    const failing = nodeLinkActions({ walletManager: {}, credential: 'c', height: async () => { throw new Error('down'); } });
    expect(await failing.offersUse(W.nodeId, rotating, hw)).toBe(true);
    // No rotation due: the height does not enter into it.
    const { rotationDue, ...unrotated } = rotating.signed; // eslint-disable-line no-unused-vars
    expect(await at(0).offersUse(W.nodeId, { ...rotating, signed: unrotated }, hw)).toBe(false);
    // The wallet screen reads the height the Node tab reads, not a figure only that tab sets.
    expect(read('src/screens/WalletScreen.js')).toMatch(/height: \(\) => fetchCachedBlockHeight\(\)\.then\(\(\) => estimatedHeight\(heightRead\(\)\)\),/);
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
    const n = node();
    expect(await prepareOffer(claim, { wallet: WALLET, session: lightClaim, node: n }))
      .toEqual({ kind: 'claim', nodeId: W.nodeId, nodeType: 'light', qnet: W.address, amountNano: 12500000000 });
    expect(n.status).toHaveBeenCalledWith(W.nodeId);
    expect(n.balance).toHaveBeenCalledWith(W.nodeId);
    expect(await prepareOffer(claim, { wallet: WALLET, session: lightClaim, node: node({ balance: async () => 999999999 }) }))
      .toEqual({ kind: 'claim_empty', nodeId: W.nodeId, nodeType: 'light', qnet: W.address });
    expect(await prepareOffer(claim, { wallet: WALLET, session: lightClaim, node: node({ balance: async () => null }) }))
      .toMatchObject({ error: 'NETWORK' });
    expect(await prepareOffer(claim, { wallet: WALLET, session: lightClaim, node: node({ claimBusy: () => true }) }))
      .toMatchObject({ error: 'CLAIM_BUSY' });
    expect(await prepareOffer(claim, { wallet: WALLET, session: lightClaim, node: node({ status: async () => ({ onChain: null, features: [] }) }) }))
      .toMatchObject({ error: 'NETWORK' });
  });

  it('claim: the wallet\'s super node, which two genesis nodes list alike, and its balance', async () => {
    const n = node({ serverListed: jest.fn(async () => true) });
    expect(await prepareOffer(claim, { wallet: WALLET, session: superClaim, node: n }))
      .toEqual({ kind: 'claim', nodeId: S, nodeType: 'super', qnet: W.address, amountNano: 12500000000 });
    expect(n.serverListed).toHaveBeenCalledWith(S);
    expect(n.status).not.toHaveBeenCalled();
    expect(n.balance).toHaveBeenCalledWith(S);
    expect(await prepareOffer(claim, { wallet: WALLET, session: superClaim, node: node({ serverListed: async () => true, balance: async () => 5 }) }))
      .toEqual({ kind: 'claim_empty', nodeId: S, nodeType: 'super', qnet: W.address });
    expect(await prepareOffer(claim, { wallet: WALLET, session: superClaim, node: node({ serverListed: async () => false }) }))
      .toEqual({ kind: 'unavailable', error: 'NO_NODE' });
    expect(await prepareOffer(claim, { wallet: WALLET, session: superClaim, node: node({ serverListed: async () => null }) }))
      .toEqual({ kind: 'unavailable', error: 'NETWORK' });
    // A node side that cannot read the super node's status reads nothing as listed.
    expect(await prepareOffer(claim, { wallet: WALLET, session: superClaim, node: node() })).toEqual({ kind: 'unavailable', error: 'NETWORK' });
    expect(await prepareOffer(claim, { wallet: WALLET, session: superClaim, node: node({ serverListed: async () => true, claimBusy: () => true }) }))
      .toEqual({ kind: 'unavailable', error: 'CLAIM_BUSY' });
  });

  it('claim: another wallet\'s super or light node, or a genesis node, is WALLET_MISMATCH before anything is read', async () => {
    const other = LN.wallets[1];
    for (const nodeId of [superNodeId(other.address), other.nodeId, 'genesis_node_001']) {
      const n = node({ serverListed: jest.fn(async () => true) });
      expect([nodeId, await prepareOffer(claim, { wallet: WALLET, session: session({ walletHash: W.walletHash, nodeId }), node: n })])
        .toEqual([nodeId, { kind: 'unavailable', error: 'WALLET_MISMATCH' }]);
      expect(n.status).not.toHaveBeenCalled();
      expect(n.serverListed).not.toHaveBeenCalled();
      expect(n.balance).not.toHaveBeenCalled();
    }
    // The other wallet's own request, its super node named: this wallet is not the one it names.
    const n = node({ serverListed: jest.fn(async () => true) });
    expect(await prepareOffer(claim, { wallet: WALLET, session: session({ walletHash: other.walletHash, nodeId: superNodeId(other.address) }), node: n }))
      .toEqual({ kind: 'unavailable', error: 'WALLET_MISMATCH' });
    expect(n.serverListed).not.toHaveBeenCalled();
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
    const offer = { kind: 'claim', nodeId: W.nodeId, nodeType: 'light', qnet: W.address, amountNano: 12500000000 };
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

  it('claim: a move of the super node\'s balance answers with the super node\'s id, which the answer check takes', async () => {
    const S = superNodeId(W.address);
    const offer = { kind: 'claim', nodeId: S, nodeType: 'super', qnet: W.address, amountNano: 48000000000 };
    const n = node({ claim: jest.fn(async () => ({ status: 'ok', amountNano: '48000000000', txHash: 'ab'.repeat(32), stoppedAtEpoch: null })) });
    const a = await performIntent({ intent: 'claim' }, offer, { node: n });
    expect(a).toEqual({ status: 'ok', qnet: W.address, nodeId: S, amountNano: '48000000000', txHash: 'ab'.repeat(32), stoppedAtEpoch: null });
    expect(n.claim).toHaveBeenCalledWith({ nodeId: S, qnet: W.address, amountNano: 48000000000 });
    const view = { intent: 'claim', request: { walletHash: W.walletHash, nodeId: S } };
    expect(plaintextProblem(buildPlaintext(view, a), view)).toBe(null);
    // The same answer for a request that named the light node is not sent.
    expect(() => buildPlaintext({ intent: 'claim', request: { walletHash: W.walletHash, nodeId: W.nodeId } }, a)).toThrow(/nodeId/);
    expect(await performIntent({ intent: 'claim' }, { ...offer, kind: 'claim_empty' }, { node: n })).toEqual({ status: 'empty', qnet: W.address, nodeId: S });
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

  // On the phone the node moved away from, two owners refuse its ping key and name no binding to it. Its sheet said
  // "this device" while the wallet-key fallback withdrew the other phone's binding: it is the wallet form, whose sheet
  // speaks of the device the node runs on.
  it('on the device that runs the node: its own unbind, unless two owners name another binding or refuse its ping key (contract 1.9b)', async () => {
    const here = { kind: 'unlink', mode: 'here', qnet: W.address, nodeId: W.nodeId, since: BOUND_AT };
    // The network names this binding, or gives no verdict on it (no key to sign with, one refusal): this device's own
    // unbind, the network's view not read.
    for (const signed of [
      { bindingSeqAgreed: BOUND_AT }, { bindingSeqAgreed: BOUND_AT, keyOurs: true }, { bindingSeqAgreed: null },
      { bindingSeqAgreed: null, keyOurs: null }, null,
    ]) {
      const n = node({ binding: jest.fn(async () => LOCAL), pingStatus: jest.fn(async () => signed), status: jest.fn() });
      expect([signed, await offerWith(n)]).toEqual([signed, here]);
      expect(n.binding).toHaveBeenCalledWith(W.nodeId);
      expect(n.status).not.toHaveBeenCalled();
    }
    // Two owners name a newer binding, or refuse this device's ping key and name none: the one here is stale or
    // replaced, and the wallet key unlinks the device that holds the node.
    for (const signed of [{ bindingSeqAgreed: BOUND_AT + 9 }, { bindingSeqAgreed: null, keyOurs: false }]) {
      const n = node({
        binding: async () => LOCAL, pingStatus: async () => signed, status: jest.fn(async () => linkedView()), unlinkByWallet: jest.fn(),
      });
      expect([signed, await offerWith(n)]).toEqual([signed, {
        kind: 'unlink', mode: 'wallet', qnet: W.address, nodeId: W.nodeId, platform: 'ios', since: 1790035200,
      }]);
    }
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

  it('the Node side: the unbind of PushService.stopLightNode, the wallet key only for this device\'s own bindings, then the tab reads again', async () => {
    jest.resetModules();
    let waiting = null;
    const push = {
      localBinding: jest.fn(async () => ({ nodeId: W.nodeId, seq: 7 })), stopLightNode: jest.fn(async () => ({ unbound: true })),
      readUnconfirmedBinding: jest.fn(async () => waiting),
    };
    const statuses = [];
    const light = {
      readNodeStatus: jest.fn(async () => statuses.shift()),
      postUnbind: jest.fn(async () => ({ ok: true, answer: { success: true, unbound: true } })),
    };
    jest.doMock('../src/services/PushService', () => push);
    jest.doMock('../src/services/LightNode', () => light);
    jest.doMock('../src/services/NodeDeviceKey', () => ({ checkDevice: jest.fn() }));
    jest.doMock('../src/services/NodeRecordRead', () => ({ readNodeRecordState: jest.fn() }));
    const { nodeLinkActions } = require('../src/services/NodeLinkActions');
    const wm = {
      signNodeStatus: jest.fn(async () => ({ signer: 'wallet', sig: 'ab', identityPublicKey: 'pk' })),
      signNodeUnbind: jest.fn(async () => ({ sig: 'cd', identityPublicKey: 'ef' })),
    };
    const onUnlinked = jest.fn();
    const actions = nodeLinkActions({ walletManager: wm, credential: 'c', onUnlinked });
    expect(await actions.binding(W.nodeId)).toEqual({ nodeId: W.nodeId, seq: 7 });
    expect(await actions.unlink(W.nodeId)).toEqual({ unbound: true });
    expect(push.stopLightNode).toHaveBeenCalledTimes(1);
    expect(onUnlinked).toHaveBeenCalledTimes(1);
    expect(light.readNodeStatus).not.toHaveBeenCalled();
    push.localBinding.mockResolvedValueOnce(null);
    expect(await actions.unlink(W.nodeId)).toEqual({ unbound: false });
    expect(push.stopLightNode).toHaveBeenCalledTimes(1);
    // The ping-key unbind not taken (no ping key here any more, a refusal): the wallet form, for this device's own only.
    push.stopLightNode.mockResolvedValue({ unbound: false });
    const view = { onChain: true, features: ['unbind_wallet'], deviceBoundAgreed: true };
    // Another device's binding is the network's (seq 9): nothing is signed, and the answer says the network did not take it.
    statuses.push(view, { ...view, bindingSeqAgreed: 9 });
    expect(await actions.unlink(W.nodeId)).toEqual({ unbound: false });
    expect(wm.signNodeUnbind).not.toHaveBeenCalled();
    expect(light.postUnbind).not.toHaveBeenCalled();
    // This device's own (seq 7), its ping key gone: the wallet key withdraws it.
    statuses.push(view, { ...view, bindingSeqAgreed: 7 });
    expect(await actions.unlink(W.nodeId)).toEqual({ unbound: true });
    expect(wm.signNodeUnbind).toHaveBeenCalledWith('c', W.nodeId, 7, expect.any(Number));
    // A binding sent from here with no answer that the network holds (seq 11) is this device's too: it is withdrawn.
    waiting = { nodeId: W.nodeId, seq: 11 };
    wm.signNodeUnbind.mockClear();
    statuses.push(view, { ...view, bindingSeqAgreed: 11 });
    expect(await actions.unlink(W.nodeId)).toEqual({ unbound: true });
    expect(wm.signNodeUnbind).toHaveBeenCalledWith('c', W.nodeId, 11, expect.any(Number));
    expect(push.readUnconfirmedBinding).toHaveBeenCalledWith(W.nodeId);
    expect(onUnlinked).toHaveBeenCalledTimes(4);
    jest.dontMock('../src/services/PushService');
    jest.dontMock('../src/services/LightNode');
    jest.dontMock('../src/services/NodeDeviceKey');
    jest.dontMock('../src/services/NodeRecordRead');
  });

  it('the sheet: its title, what stops and what stays, since when it ran here, and the outcome', () => {
    const t = require('../src/i18n').makeT('en');
    const screen = read('src/screens/QNetLinkScreen.js');
    expect(screen).toMatch(/unlink: 'link_title_unlink',/);
    expect(screen).toMatch(/\{Number\.isSafeInteger\(o\.since\) \? <InfoRow label=\{t\('link_unlink_since'\)\} value=\{day\(o\.since \* 1000\)\} ltr \/> : null\}/);
    expect(screen).toMatch(/t\(a\.unbound === true \? 'link_result_unlinked' : 'link_result_unlinked_unconfirmed'\)/);
    expect(t('link_title_unlink')).toBe("Unlink this wallet's node from this device");
    // The sheet names no website and no other place: it says what happens on this device.
    for (const k of ['link_unlink_body', 'link_result_unlinked', 'link_result_unlinked_unconfirmed', 'link_err_NOT_LINKED']) {
      expect([k, /aiqnet|website|http/i.test(t(k))]).toEqual([k, false]);
    }
  });
});

describe('only a verified link reaches the app', () => {
  it('Android: one App Link filter, verified, https://link.aiqnet.io with the paths /l and /send exactly; no custom scheme', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    const filters = [...manifest.matchAll(/<intent-filter([^>]*)>([\s\S]*?)<\/intent-filter>/g)];
    const views = filters.filter((f) => f[2].includes('android.intent.action.VIEW'));
    expect(views).toHaveLength(1);
    const [, attrs, body] = views[0];
    expect(attrs).toMatch(/android:autoVerify="true"/);
    // The <data> elements of one filter combine: every scheme, host and path they name, together.
    const values = (name) => [...body.matchAll(new RegExp(`android:${name}="([^"]*)"`, 'g'))].map((m) => m[1]);
    expect([...new Set(values('scheme'))]).toEqual(['https']);
    expect([...new Set(values('host'))]).toEqual(['link.aiqnet.io']);
    expect(values('path').sort()).toEqual(['/l', '/send']);
    expect([...body.matchAll(/<category android:name="([^"]*)"/g)].map((m) => m[1]).sort())
      .toEqual(['android.intent.category.BROWSABLE', 'android.intent.category.DEFAULT']);
    // A devnet build claims no scheme: another site's mainnet payment request never lands in its devnet Send.
    expect(manifest).not.toMatch(/pathPrefix|pathPattern|android:port|android:scheme="(?!https")|solana"/);
    // singleTask hands a link to the running activity (Linking's 'url' event); the restored-intent reset stays.
    expect(manifest).toMatch(/android:launchMode="singleTask"/);
  });

  it('Android: an activity restored or relaunched from recents does not hand its old link over again', () => {
    const activity = read('android/app/src/main/java/com/qnetmobile/MainActivity.kt');
    expect(activity).toMatch(/FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY/);
    expect(activity).toMatch(/intent\.data = null\s*\}\s*super\.onCreate/);
  });

  it('iOS: Universal Links for link.aiqnet.io only, forwarded by the scene to Linking, at launch too; no custom URL scheme', () => {
    const entitlements = read('ios/QNetMobile/QNetMobile.entitlements');
    const domains = /<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(entitlements)[1];
    expect([...domains.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])).toEqual(['applinks:link.aiqnet.io']);
    // A devnet build claims no scheme: another site's mainnet payment request never lands in its devnet Send.
    expect(read('ios/QNetMobile/Info.plist')).not.toMatch(/CFBundleURLTypes/);
    // Under the scene life cycle the app delegate gets no link: the scene forwards Universal Links, nothing else.
    const app = read('ios/QNetMobile/AppDelegate.swift');
    expect(app).not.toMatch(/continue userActivity|open url|RCTLinkingManager/);
    const scene = read('ios/QNetMobile/SceneDelegate.swift');
    expect(scene).toMatch(/func scene\(_ scene: UIScene, continue userActivity: NSUserActivity\) \{\s*continueLink\(userActivity\)/);
    expect(scene).toMatch(/private func continueLink\(_ activity: NSUserActivity\) \{\s*guard activity\.activityType == NSUserActivityTypeBrowsingWeb else \{ return \}\s*_ = RCTLinkingManager\.application\(UIApplication\.shared, continue: activity,/);
    expect(scene).not.toMatch(/openURLContexts|urlContexts|solana/i);
    expect(scene.match(/RCTLinkingManager\.application\(/g)).toHaveLength(1);
    // The link that launches the app goes where Linking's getInitialURL reads it: the activity dictionary under the
    // keys React Native reads.
    const linking = read('node_modules/react-native/Libraries/LinkingIOS/RCTLinkingManager.mm');
    expect(linking).toMatch(/userActivityDictionary\[@"UIApplicationLaunchOptionsUserActivityKey"\]/);
    expect(scene).toMatch(/UIApplication\.LaunchOptionsKey\.userActivityType\.rawValue: NSUserActivityTypeBrowsingWeb,\s*"UIApplicationLaunchOptionsUserActivityKey": activity,/);
    expect(scene).toMatch(/return \[\.userActivityDictionary: entry\]/);
    // A scene connecting while React Native already runs hands its link over as one that comes while the app runs.
    expect(scene).toMatch(/self\.window = running\s*connectionOptions\.userActivities\.forEach \{ continueLink\(\$0\) \}\s*return/);
  });

  it('the screen takes links only from the OS, through the parser', () => {
    const screen = read('src/screens/WalletScreen.js');
    expect([...screen.matchAll(/setLinkRequest\(/g)].length).toBe(5);
    // A link the in-app browser handed over is refused first; then a transfer link (services/transferLink), then QNet Link.
    expect(screen).toMatch(/LINK_FROM_OUTSIDE_MS\)\) \{[^}]*\}\s*if \(openTransferLink\(url\)\) return;\s*const link = parseLink\(url\);\s*if \(!link\) \{/);
    expect(screen).toMatch(/takeInitialUrl\(Linking\)\.then\(receive\)/);
  });
});
