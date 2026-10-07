// QNet Link v1, the site's side: revision 2 against the shared vectors (docs/protocols/light-node.vectors.json,
// the file the app's and the extension's tests read) and an independent node:crypto implementation of the app's
// side; the extension's qnet_activateNode answers against qnet-link-v1.vectors.json. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3';
import { LIGHT, LINK, LINK_CONSTANTS as K, VECTORS, appSeal, bodyOf, x25519Pkcs8 } from './link-helpers.mjs';
import {
  AAD_PREFIX,
  ANDROID_PACKAGE,
  BURN_AMOUNT_MAX,
  CAPS,
  CHAIN_TAG,
  CLAIM_MIN_NANO,
  CONSENT_FUTURE_S,
  CONSENT_PAST_S,
  CONSENT_PAST_S_BEFORE_24H,
  RESERVE_ANSWER_FUTURE_S,
  RESERVE_ANSWER_PAST_S,
  CT_MIN_BYTES,
  ERROR_CODES,
  HKDF_INFO,
  INTENTS,
  LINK_ERRORS,
  LINK_HOST,
  LINK_PREFIX,
  LINK_RE,
  POLL_INTERVAL_MS,
  SAS_INFO,
  SESSION_BODY_MAX_BYTES,
  SESSION_TTL_S,
  SITE_ORIGIN,
  WALLET_HASH_PREFIX,
  WALLET_PAGE,
  activateWithExtension,
  activationCode,
  androidIntentUrl,
  buildLink,
  checkRequest,
  consentMessage,
  consentProof,
  decodeB64url,
  encodeB64url,
  eonOfPublicKey,
  extensionAnswerText,
  formatCheckNumber,
  isSolanaSignature,
  isU64String,
  lightNodeId,
  parseLink,
  requestHash,
  requestText,
  validateActivation,
  validateAnswer,
  validateResponseRequest,
  validateSessionRequest,
  walletHash,
} from '../qnet-link.ts';
import { closeSiteSession, newSiteSession, openAnswer, sessionRequestBody, sessionWithKey, siteSession } from '../qnet-link-crypto.ts';
import { verifyReserveAnswer } from '../cabinet/burn-record.ts';

const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const b64u = (hex) => Buffer.from(hex, 'hex').toString('base64url');
const hex = (b) => Buffer.from(b).toString('hex');
const utf8 = (s) => new TextEncoder().encode(s);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const bytesSession = (c) => siteSession(c.sessionId, c.intent, c.request, unhex(c.sitePrivateKey));
async function webCryptoSession(c) {
  const privateKey = await crypto.subtle.importKey('pkcs8', x25519Pkcs8(unhex(c.sitePrivateKey)), { name: 'X25519' }, false, ['deriveBits']);
  return sessionWithKey(c.sessionId, c.intent, c.request, b64u(c.sitePublicKey), { kind: 'webcrypto', privateKey });
}
// A `reserve` answer's signature is checked by the site's own verifier (burn-record.ts), as the activation page does.
const contextOf = (ctx, verify, verifyReservation = verifyReserveAnswer) => ({ request: ctx.request, nowS: Number(ctx.now), consent24h: ctx.consent24h, verify, verifyReservation });

// A verifier for the vectors that knows the consent of each `link` answer: it builds the message on its own
// (BLAKE3 proof, chain tag) and accepts exactly that message with that answer's key and signature.
const consents = LINK.cases.filter((c) => c.intent === 'link' && JSON.parse(c.plaintext).status === 'ok').map((c) => {
  const a = JSON.parse(c.plaintext);
  const proof = hex(blake3(utf8(`${c.request.burnTx}:${a.nodeId}:${a.qnet}`))).slice(0, 32);
  return {
    message: utf8(`q1337|client_node_reg:${a.nodeId}:${a.qnet}:${proof}:${a.consent.ts}`),
    pk: Buffer.from(a.consent.pk, 'base64url'),
    sig: Buffer.from(a.consent.sig, 'base64url'),
  };
});
const vectorVerify = (pk, message, sig) => consents.some((k) => same(k.pk, pk) && same(k.message, message) && same(k.sig, sig));

test('constants are the vectors\' constants', () => {
  assert.equal(LINK_PREFIX, K.prefix);
  assert.equal(LINK_RE.source, K.pattern);
  assert.equal(ANDROID_PACKAGE, K.androidPackage);
  assert.equal(HKDF_INFO, K.hkdfInfo);
  assert.equal(SAS_INFO, K.sasInfo);
  assert.equal(AAD_PREFIX, K.aadPrefix);
  assert.equal(WALLET_HASH_PREFIX, K.walletHashPrefix);
  assert.equal(SESSION_TTL_S, K.sessionTtlSeconds);
  assert.equal(SESSION_BODY_MAX_BYTES, K.sessionBodyMaxBytes);
  assert.deepEqual(CAPS, K.caps);
  assert.equal(CT_MIN_BYTES, K.ciphertextMinBytes);
  assert.deepEqual([...INTENTS], K.intents);
  assert.deepEqual(LINK_ERRORS, K.errors);
  assert.equal(CONSENT_PAST_S, K.consentWindow.pastSeconds);
  assert.equal(CONSENT_PAST_S_BEFORE_24H, K.consentWindow.pastSecondsBeforeConsent24h);
  assert.equal(CONSENT_FUTURE_S, K.consentWindow.futureSeconds);
  assert.equal(RESERVE_ANSWER_PAST_S, K.reserveWindow.pastSeconds);
  assert.equal(RESERVE_ANSWER_FUTURE_S, K.reserveWindow.futureSeconds);
  assert.deepEqual([...INTENTS], ['connect', 'link', 'claim', 'reserve', 'unlink']);
  assert.equal(CLAIM_MIN_NANO, BigInt(K.claimMinNano));
  assert.equal(CHAIN_TAG, LIGHT.constants.chainTag);
  assert.equal(POLL_INTERVAL_MS, 2000);
  // The link has its own host; the site and the relay do not move.
  assert.equal(LINK_PREFIX, `https://${LINK_HOST}/l#v1.`);
  assert.equal(SITE_ORIGIN, 'https://aiqnet.io');
  assert.equal(WALLET_PAGE, 'https://aiqnet.io/wallet');
  assert.equal(BURN_AMOUNT_MAX, VECTORS.constants.burnAmountMax);
});

// Android's Intent.parseUri(url, URI_INTENT_SCHEME) as the system browser calls it (Intent.parseUriInternal): the
// fields start at the LAST '#', and the data is the text before it with `intent:` replaced by the scheme.
function parseUri(url) {
  const i = url.lastIndexOf('#');
  assert.ok(url.startsWith('intent:') && url.startsWith('#Intent;', i) && url.endsWith(';end'), url);
  const fields = Object.fromEntries(url.slice(i + 8, -4).split(';').map((f) => {
    const eq = f.indexOf('=');
    return [f.slice(0, eq), decodeURIComponent(f.slice(eq + 1))];
  }));
  return { data: `${fields.scheme}:${url.slice('intent:'.length, i)}`, package: fields.package, fallback: fields['S.browser_fallback_url'] };
}

test('android: the site button\'s intent: URL, whose data is the link itself', () => {
  const a = LINK.androidIntent;
  assert.equal(androidIntentUrl(a.link, a.browserFallbackUrl), a.intentUrl);
  assert.deepEqual(parseUri(a.intentUrl), { data: a.link, package: a.package, fallback: a.browserFallbackUrl });
  assert.equal(parseLink(a.intentUrl), null, 'an intent: URL is not a link');
  for (const c of LINK.cases) assert.equal(parseUri(androidIntentUrl(c.link, WALLET_PAGE)).data, c.link, c.name);
  for (const n of LINK.invalidLinks) assert.equal(androidIntentUrl(n.link, WALLET_PAGE), null, n.reason);
  const link = LINK.cases[0].link;
  assert.equal(androidIntentUrl(link, 'http://aiqnet.io/wallet'), null);
  assert.equal(androidIntentUrl(link, 'javascript:alert(1)'), null);
  // A fallback with its own '#' and ';' is encoded, so the fields still start at "#Intent;".
  const odd = parseUri(androidIntentUrl(link, 'https://aiqnet.io/wallet?a=1;b=2#x'));
  assert.deepEqual(odd, { data: link, package: 'io.aiqnet.wallet', fallback: 'https://aiqnet.io/wallet?a=1;b=2#x' });
});

test('activation code: the node KAT and every revision 1 answer', () => {
  const kat = VECTORS.activationCodeKat;
  assert.equal(activationCode(kat.nodeType, kat.solanaAddress, kat.burnTx, kat.burnAmount), kat.code);
  // A burn of the cabinet's payment key: the code names the wallet's QNet address (section 3).
  const w = VECTORS.walletActivationCodeKat;
  assert.equal(activationCode(w.nodeType, w.qnetAddress, w.burnTx, w.burnAmount), w.code);
  let checked = 0;
  for (const c of VECTORS.cases) {
    const a = JSON.parse(c.plaintext);
    if (a.code) {
      assert.equal(activationCode(a.nodeType, a.solana, a.burnTx, a.burnAmount), a.code, c.name);
      checked += 1;
    }
  }
  assert.ok(checked >= 4);
});

test('base64url: canonical only', () => {
  for (const len of [0, 1, 2, 3, 12, 31, 32, 33]) {
    const bytes = new Uint8Array(randomBytes(len));
    const text = encodeB64url(bytes);
    assert.equal(text, Buffer.from(bytes).toString('base64url'));
    if (len > 0) assert.deepEqual(decodeB64url(text), bytes);
  }
  const key = LINK.cases[0].sessionRequest.sitePub;
  assert.equal(decodeB64url(key, 32).length, 32);
  assert.equal(decodeB64url(key, 31), null);
  assert.equal(decodeB64url(`${key}=`), null);
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const lowBitFlipped = key.slice(0, -1) + ALPHABET[ALPHABET.indexOf(key.at(-1)) ^ 1];
  assert.equal(decodeB64url(lowBitFlipped), null, 'non-zero padding bits');
  assert.equal(decodeB64url(`+${key.slice(1)}`), null);
  assert.equal(decodeB64url('A'), null);
  assert.equal(decodeB64url(''), null);
  assert.equal(decodeB64url(42), null);
});

test('link: build and parse every case, refuse every invalid link, activate among them', () => {
  for (const c of LINK.cases) {
    const parsed = parseLink(c.link);
    assert.deepEqual(parsed, { id: c.sessionId, sitePub: b64u(c.sitePublicKey), intent: c.intent, ...(c.reqHash ? { reqHash: c.reqHash } : {}) }, c.name);
    assert.equal(buildLink(parsed), c.link, c.name);
  }
  for (const n of LINK.invalidLinks) assert.equal(parseLink(n.link), null, n.reason);
  assert.ok(LINK.invalidLinks.some((n) => n.reason.startsWith('activate')));
  // A revision 1 activate link is not a link any more.
  for (const c of VECTORS.cases.filter((x) => x.intent === 'activate')) assert.equal(parseLink(c.link), null, c.name);
  assert.equal(parseLink(null), null);
});

test('requests: exact keys and forms, the request bytes and their hash', () => {
  for (const c of LINK.cases.filter((x) => x.request)) {
    assert.deepEqual(checkRequest(c.intent, c.request), c.request, c.name);
    assert.equal(requestText(c.intent, c.request), c.requestText, c.name);
    assert.equal(requestHash(c.requestText), c.reqHash, c.name);
  }
  const link = LINK.cases.find((c) => c.name === 'link-ok-check').request;
  for (const bad of [
    { ...link, extra: 1 }, { burnTx: link.burnTx, walletHash: null }, { ...link, check: 'true' }, { ...link, burnTx: 'x' },
    { ...link, walletHash: '74940B0126365748' }, { ...link, walletHash: '4940b0126365748' }, null, [link],
  ]) assert.equal(checkRequest('link', bad), null, JSON.stringify(bad));
  assert.equal(checkRequest('claim', link), null);
  assert.equal(checkRequest('connect', {}), null);
  // Key order in the input does not matter; the bytes are always in the protocol's order.
  const reordered = { check: false, walletHash: null, burnTx: null };
  assert.equal(requestText('link', checkRequest('link', reordered)), '{"burnTx":null,"walletHash":null,"check":false}');
});

test('identity: wallet hash, node id, proof, consent message and EON address, as the vectors have them', () => {
  for (const w of LIGHT.wallets) {
    assert.equal(walletHash(w.address), w.walletHash, w.name);
    assert.equal(lightNodeId(w.address), w.nodeId, w.name);
    assert.equal(eonOfPublicKey(unhex(w.publicKey)), w.address, w.name);
  }
  for (const n of LIGHT.node) {
    const w = LIGHT.wallets.find((x) => x.name === n.wallet);
    assert.equal(consentProof(n.burnTx, n.nodeId, w.address), n.proof);
    const consent = n.messages.find((m) => m.name === 'consent');
    const i = consent.inputs;
    assert.equal(consentMessage(i.nodeId, i.wallet, i.proof, i.ts), consent.preimage);
  }
});

test('relay bodies: every case passes with its request and hash, every invalid body fails', () => {
  for (const c of LINK.cases) {
    assert.deepEqual(validateSessionRequest(JSON.stringify(c.sessionRequest)), c.sessionView, c.name);
    assert.deepEqual(validateResponseRequest(JSON.stringify(c.responseRequest), c.intent), c.responseRequest, c.name);
  }
  for (const n of LINK.invalidSessionRequests) assert.equal(validateSessionRequest(n.body), null, n.reason);
  for (const n of LINK.invalidResponseRequests) assert.equal(validateResponseRequest(n.body, n.intent), null, n.reason);
  // A `link` answer is too big for a `connect` or `claim` session.
  const link = LINK.cases.find((c) => c.name === 'link-ok-check').responseRequest;
  assert.equal(validateResponseRequest(JSON.stringify(link), 'connect'), null);
  assert.equal(validateResponseRequest(JSON.stringify(link), 'claim'), null);
  // A key named __proto__ is an own key of the parsed object, so it is an extra key.
  const c = LINK.cases[0];
  assert.equal(validateSessionRequest(JSON.stringify(c.sessionRequest).replace('{', '{"__proto__":{"x":1},')), null);
});

test('answers: every case is accepted in its context, every invalid plaintext fails at its check', () => {
  for (const c of LINK.cases) {
    const checked = validateAnswer(c.plaintext, { intent: c.intent, ...contextOf(c.context, vectorVerify) });
    assert.deepEqual(checked, { ok: true, answer: JSON.parse(c.plaintext) }, c.name);
  }
  for (const n of LINK.invalidPlaintexts) {
    const intent = LINK.cases.find((c) => c.name === n.session).intent;
    const checked = validateAnswer(n.plaintext, { intent, ...contextOf(n.context, vectorVerify) });
    assert.deepEqual(checked, { ok: false, reason: n.reason }, `${n.session} ${n.reason}: ${n.plaintext.slice(0, 80)}`);
  }
  assert.ok(LINK.invalidPlaintexts.length >= 30);
});

// SITE-R2-03, owner decision 27.09 (EXT-R1-03 option (a)): a claim whose quote stopped at an epoch may move less than
// 1 QNC, so a balance spread over many small epochs can always be moved; a full claim still moves at least 1 QNC, and
// no claim moves nothing.
test('answers: a capped claim below 1 QNC is read; a full one below 1 QNC and a zero one are not', () => {
  const c = LINK.cases.find((x) => x.name === 'claim-ok-partial');
  const answer = JSON.parse(c.plaintext);
  assert.equal(answer.stoppedAtEpoch, '155');
  const check = (over) => validateAnswer(JSON.stringify({ ...answer, ...over }), { intent: 'claim', ...contextOf(c.context, vectorVerify) });
  assert.deepEqual(check({ amountNano: '400000000' }), { ok: true, answer: { ...answer, amountNano: '400000000' } });
  assert.equal(check({ amountNano: '1' }).ok, true);
  assert.deepEqual(check({ amountNano: '999999999', stoppedAtEpoch: null }), { ok: false, reason: 'amountNano' });
  assert.deepEqual(check({ amountNano: '0' }), { ok: false, reason: 'amountNano' });
  assert.deepEqual(check({ amountNano: '0', stoppedAtEpoch: null }), { ok: false, reason: 'amountNano' });
  assert.equal(check({ amountNano: '1000000000', stoppedAtEpoch: null }).ok, true);
  // A malformed stoppedAtEpoch is still refused at its own check.
  assert.deepEqual(check({ amountNano: '400000000', stoppedAtEpoch: 155 }), { ok: false, reason: 'stoppedAtEpoch' });
});

test('answers: a consent is refused without a verifier, when it throws, and outside the window', () => {
  const c = LINK.cases.find((x) => x.name === 'link-ok-check');
  const base = { intent: 'link', ...contextOf(c.context) };
  assert.deepEqual(validateAnswer(c.plaintext, base), { ok: false, reason: 'sig' });
  assert.deepEqual(validateAnswer(c.plaintext, { ...base, verify: () => { throw new Error('x'); } }), { ok: false, reason: 'sig' });
  assert.deepEqual(validateAnswer(c.plaintext, { ...base, verify: () => 1 }), { ok: false, reason: 'sig' });
  const ts = Number(JSON.parse(c.plaintext).consent.ts);
  const at = (nowS, consent24h) => validateAnswer(c.plaintext, { ...base, nowS, consent24h, verify: vectorVerify });
  assert.equal(at(ts + 86_400, true).ok, true);
  assert.deepEqual(at(ts + 86_401, true), { ok: false, reason: 'ts' });
  assert.equal(at(ts + 300, false).ok, true);
  assert.deepEqual(at(ts + 301, false), { ok: false, reason: 'ts' });
  assert.equal(at(ts - 300, true).ok, true);
  assert.deepEqual(at(ts - 301, true), { ok: false, reason: 'ts' });
  // `link` ok only for a request with a burn.
  assert.deepEqual(validateAnswer(c.plaintext, { ...base, request: { burnTx: null, walletHash: null, check: false }, verify: vectorVerify }), { ok: false, reason: 'status' });
});

// A1: QNet Wallet's `reserve` answer is the wallet's own signature over its reservation of a light node paid from the
// request's payment address; the request always names the wallet, and the site takes the answer within its window.
test('reserve: the request names the wallet and the payment address; the answer is the wallet\'s signed reservation', () => {
  const c = LINK.cases.find((x) => x.name === 'reserve-ok');
  assert.deepEqual(Object.keys(c.request), ['walletHash', 'burner']);
  assert.deepEqual(checkRequest('reserve', c.request), c.request);
  assert.equal(requestText('reserve', c.request), c.requestText);
  assert.equal(checkRequest('reserve', { ...c.request, walletHash: null }), null, 'always names a wallet');
  assert.equal(checkRequest('reserve', { ...c.request, burner: 'not-an-address' }), null);
  assert.equal(checkRequest('reserve', { ...c.request, burner: c.request.burner.slice(0, 20) }), null);
  assert.equal(checkRequest('reserve', { walletHash: c.request.walletHash }), null);
  assert.equal(checkRequest('reserve', { ...c.request, check: false }), null);
  assert.ok(parseLink(c.link));
  assert.equal(parseLink(c.link.slice(0, c.link.lastIndexOf('.'))), null, 'a reqHash is required');
  assert.deepEqual(CAPS.reserve, { plaintext: 8192, ct: 8208, body: 12_288 });
  assert.deepEqual([...LINK_ERRORS.reserve], ['NO_WALLET', 'WALLET_MISMATCH', 'NODE_OTHER', 'NETWORK', 'INTERNAL']);
  const base = { intent: 'reserve', ...contextOf(c.context, vectorVerify) };
  assert.equal(validateAnswer(c.plaintext, base).ok, true);
  // Without the site's verifier, or with one that throws, nothing is taken.
  assert.deepEqual(validateAnswer(c.plaintext, { ...base, verifyReservation: undefined }), { ok: false, reason: 'sig' });
  assert.deepEqual(validateAnswer(c.plaintext, { ...base, verifyReservation: () => { throw new Error('x'); } }), { ok: false, reason: 'sig' });
  // The window: 15 minutes back, 5 minutes ahead.
  const time = Number(JSON.parse(c.plaintext).time);
  const at = (nowS) => validateAnswer(c.plaintext, { ...base, nowS });
  assert.equal(at(time + 900).ok, true);
  assert.deepEqual(at(time + 901), { ok: false, reason: 'time' });
  assert.equal(at(time - 300).ok, true);
  assert.deepEqual(at(time - 301), { ok: false, reason: 'time' });
  // For another payment address than the request's, the same signature does not verify.
  assert.deepEqual(validateAnswer(c.plaintext, { ...base, request: { ...c.request, burner: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' } }), { ok: false, reason: 'sig' });
  // The request names another wallet: the answer is not for it.
  assert.deepEqual(validateAnswer(c.plaintext, { ...base, request: { ...c.request, walletHash: LIGHT.wallets[1].walletHash } }), { ok: false, reason: 'walletHash' });
});

test('unlink: the request names the wallet; the answer names its node and whether the network took the unbind', () => {
  const c = LINK.cases.find((x) => x.name === 'unlink-ok');
  assert.deepEqual(c.request, { walletHash: LIGHT.wallets[0].walletHash });
  assert.deepEqual(checkRequest('unlink', c.request), c.request);
  assert.equal(requestText('unlink', c.request), c.requestText);
  assert.equal(checkRequest('unlink', { walletHash: null }), null, 'always names a wallet');
  assert.equal(checkRequest('unlink', { ...c.request, check: false }), null);
  assert.equal(c.link.length, 155);
  assert.equal(parseLink(c.link.slice(0, c.link.lastIndexOf('.'))), null, 'a reqHash is required');
  assert.deepEqual(CAPS.unlink, { plaintext: 1024, ct: 1040, body: 4096 });
  assert.deepEqual([...LINK_ERRORS.unlink], ['NO_WALLET', 'WALLET_MISMATCH', 'NOT_LINKED', 'NETWORK', 'UNLINK_REFUSED', 'INTERNAL']);
  const base = { intent: 'unlink', ...contextOf(c.context, vectorVerify) };
  const ok = validateAnswer(c.plaintext, base);
  assert.equal(ok.ok, true);
  assert.equal(ok.answer.unbound, true);
  const unconfirmed = LINK.cases.find((x) => x.name === 'unlink-ok-unconfirmed');
  assert.equal(validateAnswer(unconfirmed.plaintext, base).answer.unbound, false);
  // The request names another wallet: the answer is not for it.
  assert.deepEqual(validateAnswer(c.plaintext, { ...base, request: { walletHash: LIGHT.wallets[1].walletHash } }), { ok: false, reason: 'walletHash' });
  const answer = JSON.parse(c.plaintext);
  assert.deepEqual(validateAnswer(JSON.stringify({ ...answer, unbound: 1 }), base), { ok: false, reason: 'unbound' });
  assert.deepEqual(validateAnswer(JSON.stringify({ ...answer, seq: '1' }), base), { ok: false, reason: 'keys' });
});

const PQ = new URL('../../../../../qnet-mobile/node_modules/@noble/post-quantum/ml-dsa.js', import.meta.url);
test('answers: the consents and reservations verify under ML-DSA-65 (the app\'s library, when installed)', existsSync(PQ) ? {} : { skip: 'the app\'s dependencies are not installed' }, async () => {
  const { ml_dsa65 } = await import(PQ.href);
  const verify = (pk, message, sig) => ml_dsa65.verify(sig, message, pk);
  for (const c of LINK.cases.filter((x) => x.intent === 'link' || x.intent === 'reserve')) {
    assert.equal(validateAnswer(c.plaintext, { intent: c.intent, ...contextOf(c.context, verify) }).ok, true, c.name);
  }
  for (const n of LINK.invalidPlaintexts.filter((x) => x.reason === 'sig')) {
    const intent = LINK.cases.find((c) => c.name === n.session).intent;
    assert.deepEqual(validateAnswer(n.plaintext, { intent, ...contextOf(n.context, verify) }), { ok: false, reason: 'sig' }, n.session);
  }
});

test('u64 strings and the check number\'s form', () => {
  for (const ok of ['0', '1', '18446744073709551615']) assert.equal(isU64String(ok), true, ok);
  for (const bad of ['01', '-1', '18446744073709551616', '1.0', ' 1', 1, '']) assert.equal(isU64String(bad), false, String(bad));
  for (const c of LINK.cases) assert.equal(formatCheckNumber(Number(c.checkNumber)), c.checkNumberDisplay, c.name);
  assert.equal(formatCheckNumber(7), '000 007');
});

test('signatures must decode to 64 bytes', () => {
  const tx = VECTORS.activationCodeKat.burnTx;
  assert.equal(isSolanaSignature(tx), true);
  assert.equal(isSolanaSignature(tx.slice(0, 60)), false);
  assert.equal(isSolanaSignature(`${tx} `), false);
  assert.equal(isSolanaSignature(VECTORS.wallet.solana), false);
  assert.equal(isSolanaSignature(null), false);
});

test('crypto: the site key, the link, the decryption and the check number of every case, with either kind of key', async () => {
  for (const c of LINK.cases) {
    for (const s of [bytesSession(c), await webCryptoSession(c)]) {
      assert.equal(s.sitePub, b64u(c.sitePublicKey), c.name);
      assert.equal(s.link, c.link, c.name);
      assert.equal(s.reqHash, c.reqHash, c.name);
      assert.deepEqual(JSON.parse(sessionRequestBody(s)), c.sessionRequest, c.name);
      assert.equal(sessionRequestBody(s), JSON.stringify(c.sessionRequest), c.name);
      assert.deepEqual(await openAnswer(s, c.responseRequest), { plaintext: c.plaintext, checkNumber: Number(c.checkNumber) }, `${c.name} ${s.key.kind}`);
    }
  }
});

test('crypto: every must-fail input fails, low-order keys included, with either kind of key', async () => {
  for (const f of LINK.cryptoMustFail) {
    const c = LINK.cases.find((x) => x.sessionId === f.sessionId && x.sitePrivateKey === f.sitePrivateKey);
    for (const s of [bytesSession(c), await webCryptoSession(c)]) {
      const forged = { ...s, intent: f.intent, reqHash: f.reqHash };
      await assert.rejects(openAnswer(forged, { appPub: f.appPub, iv: f.iv, ct: f.ct }), undefined, `${f.name} ${s.key.kind}`);
    }
  }
  const c = LINK.cases[0];
  for (const k of VECTORS.lowOrderPublicKeys) {
    for (const s of [bytesSession(c), await webCryptoSession(c)]) {
      await assert.rejects(openAnswer(s, { ...c.responseRequest, appPub: b64u(k) }), /key/, `${k} ${s.key.kind}`);
    }
  }
  assert.ok(LINK.cryptoMustFail.length >= 6);
});

test('crypto: a fresh session round-trips with the app side done by node:crypto, and its check number matches', async () => {
  const requests = [
    ['connect', null],
    ['link', { burnTx: null, walletHash: '74940b0126365748', check: true }],
    ['claim', { walletHash: null }],
  ];
  for (const [intent, request] of requests) {
    for (const subtle of [crypto.subtle, undefined]) {
      const s = await newSiteSession(intent, request, subtle ? {} : { subtle: null });
      assert.equal(s.key.kind, subtle ? 'webcrypto' : 'bytes');
      assert.deepEqual(parseLink(s.link), { id: s.id, sitePub: s.sitePub, intent, ...(s.reqHash ? { reqHash: s.reqHash } : {}) });
      assert.deepEqual(validateSessionRequest(sessionRequestBody(s)), { id: s.id, sitePub: s.sitePub, intent, ...(request ? { request, reqHash: s.reqHash } : {}) });
      const plaintext = JSON.stringify({ v: 1, intent, status: 'rejected' });
      const sealed = appSeal({ id: s.id, intent, sitePub: s.sitePub, plaintext, reqHash: s.reqHash });
      assert.deepEqual(await openAnswer(s, bodyOf(sealed)), { plaintext, checkNumber: sealed.checkNumber });
      // Bound to its own session and request: another session's key, or another request's hash, reads nothing.
      await assert.rejects(openAnswer(await newSiteSession(intent, request), bodyOf(sealed)));
      if (request) await assert.rejects(openAnswer({ ...s, reqHash: requestHash('{}') }, bodyOf(sealed)));
      closeSiteSession(s);
      if (s.key.kind === 'bytes') assert.ok(s.key.secret.every((b) => b === 0));
      await assert.rejects(openAnswer(s, bodyOf(sealed)), /closed/);
    }
  }
});

test('crypto: fresh sessions draw fresh ids and non-extractable keys; a request must fit the intent', async () => {
  const a = await newSiteSession('connect', null);
  const b = await newSiteSession('connect', null);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.sitePub, b.sitePub);
  assert.match(a.id, /^[0-9a-f]{32}$/);
  assert.equal(a.key.kind, 'webcrypto');
  assert.equal(a.key.privateKey.extractable, false);
  await assert.rejects(newSiteSession('connect', { walletHash: null }), /request/);
  await assert.rejects(newSiteSession('link', null), /request/);
  await assert.rejects(newSiteSession('link', { walletHash: null }), /request/);
});

function mockProvider(handler) {
  const calls = [];
  return {
    calls,
    request(args) {
      calls.push(args);
      return handler(args);
    },
  };
}

// The extension's answers (section 10): its own window, never the relay.
test('extension: every revision 1 answer checks as the extension\'s; the invalid ones fail at their check', async () => {
  for (const c of VECTORS.cases.filter((x) => x.intent === 'activate')) {
    assert.deepEqual(validateActivation(c.plaintext, c.nodeType), { ok: true, answer: JSON.parse(c.plaintext) }, c.name);
  }
  for (const n of VECTORS.invalidPlaintexts.filter((x) => x.session.intent === 'activate')) {
    assert.deepEqual(validateActivation(n.plaintext, n.session.nodeType), { ok: false, reason: n.reason }, `${n.reason}: ${n.plaintext.slice(0, 60)}`);
  }
  const superseded = JSON.parse(VECTORS.cases.find((c) => c.name === 'activate-super-exists-superseded').plaintext);
  const { v, intent, ...supersededResult } = superseded;
  assert.deepEqual(await activateWithExtension(mockProvider(async () => supersededResult), 'super'), { ok: true, answer: superseded });
  const { v: _v, intent: _intent, ...exists } = JSON.parse(VECTORS.cases.find((c) => c.name === 'activate-super-exists-light').plaintext);
  // A key the protocol does not have makes the answer unreadable.
  assert.deepEqual(await activateWithExtension(mockProvider(async () => ({ ...exists, note: true })), 'super'), { ok: false, failure: 'unverifiable' });
  assert.deepEqual(await activateWithExtension(mockProvider(async () => ({ ...exists, supersededBurnTx: exists.burnTx })), 'super'), { ok: false, failure: 'unverifiable' });
});

test('extension: qnet_activateNode sends only {nodeType} and checks the result like an answer', async () => {
  const ok = JSON.parse(VECTORS.cases.find((c) => c.name === 'activate-light-ok').plaintext);
  const { v, intent, ...result } = ok;
  const p = mockProvider(async () => result);
  assert.deepEqual(await activateWithExtension(p, 'light'), { ok: true, answer: ok });
  assert.deepEqual(p.calls, [{ method: 'qnet_activateNode', params: { nodeType: 'light' } }]);

  const exists = JSON.parse(VECTORS.cases.find((c) => c.name === 'activate-super-exists-light').plaintext);
  const { v: v2, intent: i2, ...existsResult } = exists;
  assert.equal((await activateWithExtension(mockProvider(async () => existsResult), 'super')).ok, true);

  const errorResult = { status: 'error', error: 'INSUFFICIENT_TOKENS' };
  assert.deepEqual((await activateWithExtension(mockProvider(async () => errorResult), 'light')).answer, { v: 1, intent: 'activate', ...errorResult });
  assert.ok(ERROR_CODES.includes('INSUFFICIENT_TOKENS'));
});

test('extension: forged or odd results are unverifiable, protocol errors are mapped', async () => {
  const ok = JSON.parse(VECTORS.cases.find((c) => c.name === 'activate-light-ok').plaintext);
  const { v, intent, ...result } = ok;
  const unverifiable = { ok: false, failure: 'unverifiable' };
  const run = (value, type = 'light') => activateWithExtension(mockProvider(async () => value), type);
  assert.deepEqual(await run({ ...result, code: 'QNET-L00000-000000-000000' }), unverifiable);
  assert.deepEqual(await run({ ...result, note: '<b>x</b>' }), unverifiable);
  assert.deepEqual(await run({ ...result, v: 1 }), unverifiable);
  assert.deepEqual(await run({ ...result, intent: 'connect' }), unverifiable);
  assert.deepEqual(await run(result, 'super'), unverifiable, 'ok for another node type');
  assert.deepEqual(await run([result]), unverifiable);
  assert.deepEqual(await run(null), unverifiable);
  const hostile = {};
  Object.defineProperty(hostile, 'status', { enumerable: true, get() { throw new Error('boom'); } });
  assert.deepEqual(await run(hostile), unverifiable);

  const failing = (code) => activateWithExtension(mockProvider(() => Promise.reject({ code, message: '<i>spoof</i>' })), 'light');
  assert.deepEqual(await failing(4001), { ok: false, failure: 'rejected' });
  // The extension's approval cooldown is a 4001 with its one fixed text; any other text is a decline.
  const cooldown = (message) => activateWithExtension(mockProvider(() => Promise.reject({ code: 4001, message })), 'light');
  assert.deepEqual(await cooldown('Too many rejected requests from this site, try again later'), { ok: false, failure: 'cooldown' });
  assert.deepEqual(await cooldown('User rejected the request'), { ok: false, failure: 'rejected' });
  assert.deepEqual(await cooldown('too many rejected requests from this site, try again later'), { ok: false, failure: 'rejected' });
  assert.deepEqual(
    await activateWithExtension(mockProvider(() => Promise.reject({ code: 4100, message: 'Too many rejected requests from this site, try again later' })), 'light'),
    { ok: false, failure: 'unauthorized' },
  );
  assert.deepEqual(await failing(4100), { ok: false, failure: 'unauthorized' });
  assert.deepEqual(await failing(4200), { ok: false, failure: 'unsupported' });
  assert.deepEqual(await failing(4900), { ok: false, failure: 'disconnected' });
  assert.deepEqual(await failing(-32603), { ok: false, failure: 'failed' });
  assert.deepEqual(await activateWithExtension({ request() { throw new Error('sync'); } }, 'light'), { ok: false, failure: 'failed' });
});

test('extensionAnswerText wraps the result without letting it name v or intent', () => {
  assert.equal(extensionAnswerText({ status: 'rejected' }), '{"v":1,"intent":"activate","status":"rejected"}');
  assert.equal(extensionAnswerText({ status: 'ok', v: 2 }), null);
  assert.equal(extensionAnswerText('ok'), null);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(extensionAnswerText(cyclic), null);
});
