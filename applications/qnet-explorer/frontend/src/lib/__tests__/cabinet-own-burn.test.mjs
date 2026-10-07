// A light burn made from the wallet's own Solana address, finished from any browser with QNet Wallet (owner, 06.10: the
// phone showed the code and "Open the Activate tab of the QNet extension", with nothing to press). Every light burn of a
// wallet with no node goes on with "Continue in QNet Wallet" (src/lib/cabinet/burn-next.ts, NextSteps.tsx Burned and
// FinishLight); for this one the `link` request names the burner and QNet Wallet's consent carries that Solana key's owner
// bind v1 (src/lib/qnet-link.ts), the page posts the whole body (consent-submit.ts) and the register route checks the
// bind, that the burner made this light burn, and the one-node rule before one genesis node gets exactly the body of the
// shared vectors (docs/protocols/light-node-own-burn.vectors.json, which the node's own test admits unchanged).
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import { burnNext } from '../cabinet/burn-next.ts';
import { ownBurnBodyOf, consentBodyOf } from '../cabinet/consent-submit.ts';
import { verifyConsent } from '../cabinet/consent-verify.ts';
import { SUBMIT_KEYS, checkConsentBody, checkOwnBurnBody } from '../cabinet/registration.ts';
import { activationView } from '../cabinet/wallet-activation.ts';
import {
  OWN_BURN_REQUEST_KEYS, checkRequest, consentProof, lightNodeId, ownerBindMessage, requestHash, requestText, validateAnswer, validateSessionRequest,
  verifyOwnerBind, walletHash,
} from '../qnet-link.ts';
import { createRegister, oneNodeOutcome, ownBurnProof } from '../../server/cabinet/register.ts';

const OWN = JSON.parse(readFileSync(new URL('../../../../../../docs/protocols/light-node-own-burn.vectors.json', import.meta.url), 'utf8'));
const LN = JSON.parse(readFileSync(new URL('../../../../../../docs/protocols/light-node.vectors.json', import.meta.url), 'utf8'));
const SRC = new URL('../../', import.meta.url);
const code = (path) => readFileSync(new URL(path, SRC), 'utf8').replace(/\r\n/g, '\n');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const hex = (b) => Buffer.from(b).toString('hex');
const utf8 = (s) => new TextEncoder().encode(s);
const b64u = (b) => Buffer.from(b).toString('base64url');
const C = OWN.cases[0];
const D = OWN.cases[1];
const SOL = C.solana.address;
const W = C.wallet.address;
const PAYER = 'Fp7WkhzJvSfPa4mG2r5gZb3nQx9hYc8dLt6eUq1sRk4V';

// ---------------------------------------------------------------- the next step of every known burn

const burnOf = (over = {}) => ({ nodeType: 'light', burnTx: C.burnTx, burnAmount: 1500, code: 'QNET-L00000-000000-000000', way: 'extension', burner: SOL, source: 'record', ...over });
const ctx = (over = {}) => ({ here: false, solana: SOL, extensionRecords: false, ...over });

test('every light burn of a wallet with no node goes on with QNet Wallet, whatever source and way; a super burn with its server', () => {
  // A super node's burn: its server, whatever else is known.
  for (const way of ['extension', 'payment', null]) assert.deepEqual(burnNext(burnOf({ nodeType: 'super', way }), ctx({ here: true, extensionRecords: true })), { step: 'server' }, String(way));
  // A payment address's burn: the browser holding its record goes on there, any other finishes it from the site's record.
  assert.deepEqual(burnNext(burnOf({ way: 'payment', burner: PAYER, source: 'browser' }), ctx({ here: true })), { step: 'resume' });
  for (const source of ['record', 'extension', 'browser']) {
    assert.deepEqual(burnNext(burnOf({ way: 'payment', burner: source === 'extension' ? null : PAYER, source }), ctx()), { step: 'finish', burner: null }, source);
  }
  // A burn of the wallet's own Solana address, from every source that knows one: QNet Wallet with that address.
  assert.deepEqual(burnNext(burnOf({ source: 'record' }), ctx()), { step: 'finish', burner: SOL });
  assert.deepEqual(burnNext(burnOf({ source: 'extension' }), ctx()), { step: 'finish', burner: SOL });
  assert.deepEqual(burnNext(burnOf({ source: 'scan' }), ctx()), { step: 'finish', burner: SOL });
  // The record names the burner; the page's own idea of the address does not replace it.
  assert.deepEqual(burnNext(burnOf({ source: 'record' }), ctx({ solana: D.solana.address })), { step: 'finish', burner: SOL });
  // An answer kept from the extension names no burner: the wallet's address the page knows.
  assert.deepEqual(burnNext(burnOf({ source: 'kept', way: null, burner: null }), ctx()), { step: 'finish', burner: SOL });
  assert.deepEqual(burnNext(burnOf({ source: 'kept', way: null, burner: null }), ctx({ solana: null })), { step: 'recording' });
  // Only the burn the extension in this browser made and records itself waits for it.
  assert.deepEqual(burnNext(burnOf({ source: 'extension' }), ctx({ extensionRecords: true })), { step: 'recording' });
  assert.deepEqual(burnNext(burnOf({ source: 'scan' }), ctx({ here: true })), { step: 'finish', burner: SOL }, 'a payment record elsewhere changes nothing');
});

test('the Overview: the code first, then Continue in QNet Wallet; the extension text is gone from the phone\'s path', () => {
  const steps = code('components/cabinet/NextSteps.tsx');
  const burned = steps.slice(steps.indexOf('function Burned('), steps.indexOf('// A state that could not be read:'));
  assert.match(burned, /const next = burnNext\(burn, \{/);
  assert.match(burned, /extensionRecords: extension && activation\?\.burnTx === burn\.burnTx/);
  assert.match(burned, /<CodeCard burn=\{burn\} \/>\s*\{next\.step === 'server' \?/);
  assert.equal(burned.match(/<CodeCard /g).length, 1, 'one code card, before every step');
  assert.doesNotMatch(steps, /burned_scan_open|ext_light_not_listed/);
  // FinishLight is the one QNet Wallet button for both kinds: its label on a phone is Continue in QNet Wallet.
  const finish = steps.slice(steps.indexOf('export function FinishLight('), steps.indexOf('// A burn the wallet has'));
  assert.match(finish, /\{t\(device\?\.phone \? 'act_link_open' : 'act_link_show_qr'\)\}/);
  const texts = code('lib/texts.ts');
  assert.match(texts, /act_link_open: 'Continue in QNet Wallet',/);
  assert.doesNotMatch(texts, /burned_scan_open|ext_light_not_listed/);
});

// ---------------------------------------------------------------- the request and the answer

test('the request names the burner: exact keys, bytes and hash as the vectors have them; never without a burn and a wallet', () => {
  assert.deepEqual([...OWN_BURN_REQUEST_KEYS], OWN.requestKeys);
  for (const c of OWN.cases) {
    assert.deepEqual(checkRequest('link', c.request), c.request, c.name);
    assert.equal(requestText('link', c.request), c.requestText, c.name);
    assert.equal(requestHash(c.requestText), c.reqHash, c.name);
    assert.equal(c.request.walletHash, walletHash(c.wallet.address));
  }
  const r = C.request;
  for (const bad of [
    { ...r, burnTx: null }, { ...r, walletHash: null }, { ...r, burner: 'not-an-address' }, { ...r, burner: null }, { ...r, burner: C.burnTx },
    { ...r, extra: 1 }, { burnTx: r.burnTx, walletHash: r.walletHash, burner: r.burner },
  ]) assert.equal(checkRequest('link', bad), null, JSON.stringify(bad).slice(0, 80));
  for (const intent of ['claim', 'reserve', 'unlink', 'connect']) assert.equal(checkRequest(intent, r), null, intent);
  // The relay keeps it with its hash, as for any `link` request.
  const sitePub = b64u(new Uint8Array(32).fill(9));
  const session = validateSessionRequest(JSON.stringify({ id: 'a'.repeat(32), sitePub, intent: 'link', request: r }));
  assert.deepEqual(session, { id: 'a'.repeat(32), sitePub, intent: 'link', request: r, reqHash: C.reqHash });
  assert.equal(validateSessionRequest(JSON.stringify({ id: 'a'.repeat(32), sitePub, intent: 'link', request: { ...r, walletHash: null } })), null);
  // A request without a burner keeps its three keys and bytes.
  const plain = { burnTx: r.burnTx, walletHash: r.walletHash, check: false };
  assert.equal(requestText('link', checkRequest('link', plain)), JSON.stringify(plain));
});

test('the answer: the consent with the burner\'s owner bind v1, verified over the node\'s string; anything else is unreadable', () => {
  const nowS = Number(C.ts) + 60;
  const at = (plaintext, request = C.request, over = {}) => validateAnswer(plaintext, { intent: 'link', request, nowS, consent24h: true, verify: verifyConsent, ...over });
  for (const c of OWN.cases) {
    const checked = validateAnswer(c.plaintext, { intent: 'link', request: c.request, nowS: Number(c.ts) + 60, consent24h: true, verify: verifyConsent });
    assert.equal(checked.ok, true, c.name);
    const a = JSON.parse(c.plaintext);
    // The bind's bytes are the node's v1 string and the vectors' preimage (light-node.vectors.json's ownerBind).
    const message = ownerBindMessage(a.nodeId, a.qnet, consentProof(c.burnTx, a.nodeId, a.qnet), a.consent.ts, bytes(c.wallet.publicKey), c.burnTx);
    assert.equal(message, c.ownerBind.preimage);
    assert.equal(message, LN.node.find((n) => n.burnTx === c.burnTx).messages.find((m) => m.name === 'ownerBind').preimage);
    assert.equal(hex(ed25519.sign(utf8(message), bytes(c.solana.seedHex))), c.ownerBind.signature, 'Ed25519 is deterministic');
    assert.equal(hex(ed25519.getPublicKey(bytes(c.solana.seedHex))), c.solana.publicKey);
  }
  const a = JSON.parse(C.plaintext);
  const with_ = (consent) => JSON.stringify({ ...a, consent });
  const { ownerSig, ...plain } = a.consent;
  assert.deepEqual(at(with_(plain)), { ok: false, reason: 'keys' }, 'the bind is required with a burner');
  assert.deepEqual(at(C.plaintext, { burnTx: C.burnTx, walletHash: C.request.walletHash, check: false }), { ok: false, reason: 'keys' }, 'and refused without one');
  assert.deepEqual(at(with_({ ...a.consent, extra: 'x' })), { ok: false, reason: 'keys' });
  // Another burner's key, the vectors' payment burner, a flipped bit, the other wallet's bind, a short value.
  assert.deepEqual(at(C.plaintext, { ...C.request, burner: D.solana.address }), { ok: false, reason: 'ownerSig' });
  assert.deepEqual(at(C.plaintext, { ...C.request, burner: LN.burner.address }), { ok: false, reason: 'ownerSig' });
  const sig = Buffer.from(ownerSig, 'base64url');
  sig[5] ^= 1;
  assert.deepEqual(at(with_({ ...a.consent, ownerSig: b64u(sig) })), { ok: false, reason: 'ownerSig' });
  assert.deepEqual(at(with_({ ...a.consent, ownerSig: JSON.parse(D.plaintext).consent.ownerSig })), { ok: false, reason: 'ownerSig' });
  assert.deepEqual(at(with_({ ...a.consent, ownerSig: ownerSig.slice(0, 40) })), { ok: false, reason: 'ownerSig' });
  // The vectors' payment burner's v1 bind of this burn is a valid bind, but not by the request's burner.
  const payment = LN.node.find((n) => n.burnTx === C.burnTx).messages.find((m) => m.name === 'ownerBind').signature;
  assert.deepEqual(at(with_({ ...a.consent, ownerSig: b64u(bytes(payment)) })), { ok: false, reason: 'ownerSig' });
  assert.equal(verifyOwnerBind(W, bytes(C.wallet.publicKey), C.burnTx, C.ts, LN.burner.address, bytes(payment)), true);
  // The consent itself is checked first, as before.
  assert.deepEqual(at(C.plaintext, C.request, { verify: () => false }), { ok: false, reason: 'sig' });
});

// ---------------------------------------------------------------- the body and the route

test('the own-burn body: the page builds the vectors\' body byte for byte; the site checks the consent, the burner and its bind', () => {
  for (const c of OWN.cases) {
    const a = JSON.parse(c.plaintext);
    const body = ownBurnBodyOf(a.qnet, a.consent, c.burnTx, c.burnAmount, c.solana.address);
    assert.deepEqual(Object.keys(body), [...SUBMIT_KEYS]);
    assert.deepEqual(OWN.submitKeys, [...SUBMIT_KEYS]);
    assert.equal(JSON.stringify(body), JSON.stringify(c.submitBody), c.name);
    assert.deepEqual(checkOwnBurnBody(body, verifyConsent), { ok: true, body: c.submitBody });
    // The consent body inside it is the payment way's, unchanged.
    const consent = consentBodyOf(a.qnet, a.consent, c.burnTx, c.burnAmount);
    assert.equal(checkConsentBody(consent, verifyConsent).ok, true);
    assert.equal(checkConsentBody(body, verifyConsent).reason, 'keys', 'the consent route never takes a burner from the page');
  }
  assert.throws(() => ownBurnBodyOf(W, { ...JSON.parse(C.plaintext).consent, ownerSig: undefined }, C.burnTx, 1500, SOL));
  const b = C.submitBody;
  const bad = {
    keys: [{ extra: 1 }],
    burn_wallet: [{ burn_wallet: 'x' }],
    owner_signature: [
      { owner_signature: b.owner_signature.toUpperCase() }, { owner_signature: b.owner_signature.slice(2) }, { burn_wallet: D.solana.address },
      { owner_signature: D.submitBody.owner_signature }, { owner_signature: LN.node[0].messages.find((m) => m.name === 'ownerBind').signature },
    ],
    dilithium_signature: [{ timestamp: b.timestamp + 1 }],
    node_type: [{ node_type: 'super' }],
  };
  for (const [reason, variants] of Object.entries(bad)) {
    for (const over of variants) {
      const checked = checkOwnBurnBody({ ...b, ...over }, verifyConsent);
      assert.equal(checked.ok, false, `${reason} ${JSON.stringify(over).slice(0, 60)}`);
      assert.equal(checked.reason, reason, JSON.stringify(over).slice(0, 60));
    }
  }
  const { owner_signature: _o, ...eleven } = b;
  assert.equal(checkOwnBurnBody(eleven, verifyConsent).reason, 'keys');
});

const scanOf = (burns, complete = true) => ({ complete, unusable: false, burns });
const lightBurn = (burnTx = C.burnTx, over = {}) => ({ burnTx, nodeType: 'light', burnAmount: 1500, ...over });
const rowOf = (over = {}) => ({
  wallet: W, state: 'recorded', nodeType: 'light', way: 'extension', burner: SOL, burnAmount: 1500, reservation: null, reservedAt: null, expiresAt: null,
  burnTx: C.burnTx, announcedAt: 2, burnSlot: 3, burnedAt: 4, recordedAt: 5, proof: null, ...over,
});

test('the burner made this light burn: the wallet\'s record when it has one, else the first burn of the burner\'s search', () => {
  const body = C.submitBody;
  const cases = [
    ['record unavailable', 'unavailable', null, { result: 'retry', code: 'unavailable' }],
    ['the extension\'s record of this burn', rowOf(), null, null],
    ['not final yet', rowOf({ state: 'sending' }), null, { result: 'retry', code: 'not_final' }],
    ['the record names another burn', rowOf({ burnTx: D.burnTx }), null, { result: 'refused', code: 'other_burn' }],
    ['a payment address\'s burn is finished from its record', rowOf({ way: 'payment', burner: PAYER }), null, { result: 'refused', code: 'owner_bind' }],
    ['another burner on record', rowOf({ burner: D.solana.address }), null, { result: 'refused', code: 'owner_bind' }],
    ['a super burn on record', rowOf({ nodeType: 'super' }), null, { result: 'refused', code: 'invalid_burn' }],
    ['another amount on record', rowOf({ burnAmount: 1400 }), null, { result: 'refused', code: 'invalid_burn' }],
    ['no record, the burner\'s first burn', null, scanOf([lightBurn()]), null],
    ['a reservation only, the burner\'s first burn', rowOf({ state: 'reserved', burnTx: null }), scanOf([lightBurn(), lightBurn(D.burnTx)]), null],
    ['found, the search unfinished', null, scanOf([lightBurn()], false), null],
    ['no search', null, null, { result: 'retry', code: 'unavailable' }],
    ['nothing found, the search unfinished', null, scanOf([], false), { result: 'retry', code: 'scan_incomplete' }],
    ['nothing found', null, scanOf([]), { result: 'refused', code: 'no_record' }],
    ['another burn first', null, scanOf([lightBurn(D.burnTx), lightBurn()]), { result: 'refused', code: 'other_burn' }],
    ['other burns only', null, scanOf([lightBurn(D.burnTx)]), { result: 'refused', code: 'no_record' }],
    ['a super burn', null, scanOf([lightBurn(C.burnTx, { nodeType: 'super' })]), { result: 'refused', code: 'invalid_burn' }],
    ['another amount', null, scanOf([lightBurn(C.burnTx, { burnAmount: 1400 })]), { result: 'refused', code: 'invalid_burn' }],
  ];
  for (const [what, row, scan, outcome] of cases) assert.deepEqual(ownBurnProof(body, row, scan), outcome, what);
  // The one-node rule: none goes on; the wallet's own light node is this registration done; any other node refuses it.
  assert.equal(oneNodeOutcome(body, { state: 'none' }), null);
  assert.deepEqual(oneNodeOutcome(body, null), { result: 'retry', code: 'network' });
  assert.deepEqual(oneNodeOutcome(body, { state: 'registered', nodeId: lightNodeId(W), nodeType: 'light' }), { result: 'registered' });
  assert.deepEqual(oneNodeOutcome(body, { state: 'registered', nodeId: 'super_node_0123456789abcdef', nodeType: 'super' }), { result: 'refused', code: 'wallet_has_node' });
});

let scopes = 0;
function route(nodeAnswer, options = {}) {
  const calls = [];
  const seen = { rows: [], scans: [], nodes: [] };
  const fetchFn = async (url, init) => {
    calls.push({ url, body: init.body });
    return new Response(JSON.stringify(nodeAnswer), { status: 200 });
  };
  const r = createRegister({
    fetchFn, nodes: ['https://node1.aiqnet.io', 'https://node2.aiqnet.io'], random: () => 0.1, verifyConsent,
    clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.9' }), scope: `own${(scopes += 1)}`, devOrigins: false,
    paymentRecord: async (w) => { seen.rows.push(w); return null; },
    scan: async (address) => { seen.scans.push(address); return scanOf([lightBurn(OWN.cases.find((c) => c.solana.address === address)?.burnTx ?? C.burnTx)]); },
    walletNode: async (w) => { seen.nodes.push(w); return { state: 'none' }; },
    ...options,
  });
  return { r, calls, seen };
}
const post = (body) => new Request('https://aiqnet.io/api/cabinet/register', {
  method: 'POST', headers: { host: 'aiqnet.io', 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const json = async (res) => JSON.parse(await res.text());

test('/register: the own-burn body reaches one genesis node exactly as the vectors have it, after the record, the search and the one-node rule', async () => {
  const tx = 'ef'.repeat(32);
  for (const c of OWN.cases) {
    const { r, calls, seen } = route({ success: true, tx_hash: tx });
    const res = await r.submit(post(c.submitBody));
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { result: 'admitted', txHash: tx }, c.name);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://node1.aiqnet.io/api/v1/node-registration/submit');
    assert.equal(calls[0].body, JSON.stringify(c.submitBody), 'byte for byte');
    assert.deepEqual(seen, { rows: [c.wallet.address], scans: [c.solana.address], nodes: [c.wallet.address] });
  }
  // The extension's own record of the burn decides without a search.
  const recorded = route({ success: true, tx_hash: tx }, { paymentRecord: async () => rowOf() });
  assert.equal((await json(await recorded.r.submit(post(C.submitBody)))).result, 'admitted');
  assert.deepEqual(recorded.seen.scans, []);
  // Every stop relays nothing.
  const stops = [
    ['record unavailable', { paymentRecord: async () => 'unavailable' }, { result: 'retry', code: 'unavailable' }],
    ['another burn on record', { paymentRecord: async () => rowOf({ burnTx: D.burnTx }) }, { result: 'refused', code: 'other_burn' }],
    ['the burner made none', { scan: async () => scanOf([]) }, { result: 'refused', code: 'no_record' }],
    ['the search did not finish', { scan: async () => scanOf([], false) }, { result: 'retry', code: 'scan_incomplete' }],
    ['the search failed', { scan: async () => { throw new Error('x'); } }, { result: 'retry', code: 'unavailable' }],
    ['a super burn', { scan: async () => scanOf([lightBurn(C.burnTx, { nodeType: 'super' })]) }, { result: 'refused', code: 'invalid_burn' }],
    ['the network cannot answer', { walletNode: async () => null }, { result: 'retry', code: 'network' }],
    ['the node is on the network', { walletNode: async () => ({ state: 'registered', nodeId: lightNodeId(W), nodeType: 'light' }) }, { result: 'registered' }],
    ['the wallet has a super node', { walletNode: async () => ({ state: 'registered', nodeId: 'super_node_0123456789abcdef', nodeType: 'super' }) }, { result: 'refused', code: 'wallet_has_node' }],
    ['no search wired', { scan: undefined }, { result: 'retry', code: 'unavailable' }],
    ['no network check wired', { walletNode: undefined }, { result: 'retry', code: 'unavailable' }],
  ];
  for (const [what, options, outcome] of stops) {
    const { r, calls } = route({ success: true, tx_hash: tx }, options);
    assert.deepEqual(await json(await r.submit(post(C.submitBody))), outcome, what);
    assert.equal(calls.length, 0, `${what}: nothing relayed`);
  }
  // A bind that does not verify is a 400, before any read.
  const { r, calls, seen } = route({ success: true, tx_hash: tx });
  const bad = await r.submit(post({ ...C.submitBody, burn_wallet: D.solana.address }));
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error: 'invalid_request', reason: 'owner_signature' });
  assert.equal(calls.length, 0);
  assert.deepEqual(seen, { rows: [], scans: [], nodes: [] });
  // The node's answers map as for any registration.
  const one = route({ success: false, code: 'wallet_has_node', error: 'This wallet already has a node on the QNet network: one wallet, one node' });
  assert.deepEqual(await json(await one.r.submit(post(C.submitBody))), { result: 'refused', code: 'wallet_has_node' });
  const done = route({ success: false, code: 'already_registered', error: 'Node already registered' });
  assert.deepEqual(await json(await done.r.submit(post(C.submitBody))), { result: 'registered' });
});

// The whole path on a phone: the wallet connected with QNet Wallet (its Solana address shared), the burn found by the
// search of that address, Continue in QNet Wallet, the answer, the body, the node.
test('end to end: a burn found on the wallet\'s Solana address is registered from the phone with QNet Wallet\'s answer', async () => {
  const choice = { qnet: W, source: 'app', solana: SOL };
  const view = activationView({
    choice, network: { phase: 'ok', value: { state: 'none' } },
    light: { phase: 'ok', value: { registered: false, pending: false, deviceBound: false, answeredThisEpoch: false, needsReactivation: false, counted: { sinceRegistration: 0, counted: 0, lastCountedEpoch: null }, features: [], balanceNano: null } },
    superStatus: { phase: 'ok', value: { registered: false, online: false, lastSeenAt: null, heartbeats: null, banned: false, balanceNano: null } },
    server: { phase: 'ok', value: { wallet: W, state: 'none', nodeType: null, way: null, burner: null, burnTx: null, burnAmount: null, code: null, until: null, recordedAt: null, scan: null } },
    scan: scanOf([lightBurn()]), extension: { phase: 'na' }, kept: null, records: [],
  });
  assert.equal(view.state, 'burned');
  assert.equal(view.burn.source, 'scan');
  assert.ok(view.burn.code, 'the code is shown');
  const next = burnNext(view.burn, { here: false, solana: choice.solana, extensionRecords: false });
  assert.deepEqual(next, { step: 'finish', burner: SOL });
  // FinishLight's request: the wallet named, no check number, the burner.
  const request = { burnTx: view.burn.burnTx, walletHash: walletHash(W), check: false, burner: next.burner };
  assert.equal(requestText('link', request), C.requestText);
  const checked = validateAnswer(C.plaintext, { intent: 'link', request, nowS: Number(C.ts) + 30, consent24h: true, verify: verifyConsent });
  assert.equal(checked.ok, true);
  const body = ownBurnBodyOf(W, checked.answer.consent, view.burn.burnTx, view.burn.burnAmount, next.burner);
  const { r, calls } = route({ success: true, tx_hash: 'ab'.repeat(32) });
  assert.equal((await json(await r.submit(post(body)))).result, 'admitted');
  assert.equal(calls[0].body, JSON.stringify(C.submitBody));
});
