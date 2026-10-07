// The registration the node cabinet submits (src/lib/cabinet/registration.ts, src/server/cabinet/register.ts; shared
// contract C4): the v2 owner bind and the consent strings against the shared vectors
// (docs/protocols/light-node.vectors.json), the consent body the page posts, the site's checks before it forwards one,
// the body completed from the wallet's record with the payment key's bind (any browser, no payment key), the one submit
// per node, and the node's answers mapped to what the page does next. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import {
  CONSENT_KEYS, SUBMIT_KEYS, buildConsentBody, checkConsentBody, completeSubmitBody, ownerBindMessageV2, parseSubmitOutcome, submitOutcome,
  verifyOwnerBindV2,
} from '../cabinet/registration.ts';
import { verifyConsent } from '../cabinet/consent-verify.ts';
import { consentMessage, consentProof, encodeB64url, lightNodeId } from '../qnet-link.ts';
import { createRegister, fromRecord } from '../../server/cabinet/register.ts';
import { CABINET_LIMITS, KEYED_LIMITS } from '../../server/cabinet/limits.ts';
import { UPSTREAM_BUDGETS, createUpstreamBudget } from '../../server/cabinet/upstream.ts';

const V = JSON.parse(readFileSync(new URL('../../../../../../docs/protocols/light-node.vectors.json', import.meta.url), 'utf8'));
const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const fromB64u = (s) => Uint8Array.from(Buffer.from(s, 'base64url'));
const utf8 = (s) => new TextEncoder().encode(s);
const wallet = (name) => V.wallets.find((w) => w.name === name);
const BURNER_SEED = bytes(V.burner.seedHex);

test('the v2 owner bind and the consent are the vectors\' preimages, and the burner\'s signature is the vector\'s', () => {
  assert.equal(hex(ed25519.getPublicKey(BURNER_SEED)), V.burner.publicKey);
  for (const n of V.node) {
    const w = wallet(n.wallet);
    assert.equal(lightNodeId(w.address), n.nodeId);
    assert.equal(consentProof(n.burnTx, n.nodeId, w.address), n.proof);
    const consent = n.messages.find((m) => m.name === 'consent');
    assert.equal(consentMessage(n.nodeId, w.address, n.proof, consent.inputs.ts), consent.preimage);
    assert.equal(verifyConsent(bytes(w.publicKey), utf8(consent.preimage), bytes(consent.signature)), true);
    const bind = n.messages.find((m) => m.name === 'ownerBindV2');
    const message = ownerBindMessageV2(n.nodeId, w.address, n.proof, bytes(w.publicKey), n.burnTx);
    assert.equal(message, bind.preimage);
    assert.equal(message, `qnet_burn_owner_v2:${n.nodeId}:${w.address}:${n.proof}:${w.publicKeySha3}:${n.burnTx}`);
    assert.deepEqual(bind.inputs, { nodeId: n.nodeId, wallet: w.address, proof: n.proof, walletPublicKeySha3: w.publicKeySha3, burnTx: n.burnTx });
    assert.equal(hex(ed25519.sign(utf8(message), BURNER_SEED)), bind.signature);
    assert.equal(verifyOwnerBindV2(w.address, bytes(w.publicKey), n.burnTx, V.burner.address, bind.signature), true);
    // Another burn, another wallet key, another burner, a v1 bind: never.
    assert.equal(verifyOwnerBindV2(w.address, bytes(w.publicKey), V.node.find((x) => x !== n).burnTx, V.burner.address, bind.signature), false);
    assert.equal(verifyOwnerBindV2(w.address, bytes(V.wallets.find((x) => x !== w).publicKey), n.burnTx, V.burner.address, bind.signature), false);
    assert.equal(verifyOwnerBindV2(w.address, bytes(w.publicKey), n.burnTx, '11111111111111111111111111111111', bind.signature), false);
    assert.equal(verifyOwnerBindV2(w.address, bytes(w.publicKey), n.burnTx, V.burner.address, n.messages.find((m) => m.name === 'ownerBind').signature), false);
    assert.equal(verifyOwnerBindV2(w.address, bytes(w.publicKey), n.burnTx, V.burner.address, bind.signature.toUpperCase()), false, 'lowercase hex');
  }
});

const okCases = V.link.cases.filter((c) => c.intent === 'link' && JSON.parse(c.plaintext).status === 'ok');

// The consent body of a `link` `ok` answer of the vectors: what the page posts, nothing of the payment key.
function bodyOf(c, over = {}) {
  const a = JSON.parse(c.plaintext);
  return {
    ...buildConsentBody({
      qnet: a.qnet, consentTs: Number(a.consent.ts), consentPk: fromB64u(a.consent.pk), consentSig: fromB64u(a.consent.sig), burnTx: c.request.burnTx,
      burnAmount: 1500,
    }),
    ...over,
  };
}

// The payment key's v2 bind of the case's burn, by the vectors' burner.
function bindOf(c) {
  const a = JSON.parse(c.plaintext);
  return hex(ed25519.sign(utf8(ownerBindMessageV2(a.nodeId, a.qnet, consentProof(c.request.burnTx, a.nodeId, a.qnet), fromB64u(a.consent.pk), c.request.burnTx)), BURNER_SEED));
}

// The wallet's record of a payment burn, as the registry keeps it (activation-registry.ts).
function rowOf(c, over = {}) {
  const a = JSON.parse(c.plaintext);
  return {
    wallet: a.qnet, state: 'recorded', nodeType: 'light', way: 'payment', burner: V.burner.address, burnAmount: 1500, reservation: 'a'.repeat(32),
    reservedAt: 1, expiresAt: null, burnTx: c.request.burnTx, announcedAt: 2, burnSlot: 3, burnedAt: 4, recordedAt: 5,
    proof: { pk: a.consent.pk, sig: encodeB64url(new Uint8Array(3309)), time: 1_790_000_000, ownerSig: bindOf(c) },
    ...over,
  };
}

test('the consent body: its fields, and every check the site makes before it completes and forwards one', () => {
  assert.ok(okCases.length >= 2);
  assert.deepEqual([...CONSENT_KEYS], ['from', 'node_id', 'node_type', 'wallet_address', 'registration_proof', 'timestamp', 'burn_tx_hash', 'burn_amount', 'dilithium_signature', 'dilithium_public_key']);
  for (const c of okCases) {
    const body = bodyOf(c);
    const a = JSON.parse(c.plaintext);
    assert.deepEqual(Object.keys(body), [...CONSENT_KEYS]);
    assert.equal(body.from, a.qnet);
    assert.equal(body.node_id, a.nodeId);
    assert.equal(body.node_type, 'light');
    assert.equal(body.timestamp, Number(a.consent.ts));
    assert.equal(body.dilithium_public_key.length, 1952 * 2);
    assert.equal(body.dilithium_signature.length, 3309 * 2);
    assert.deepEqual(checkConsentBody(body, verifyConsent), { ok: true, body });
  }
  const c = okCases[0];
  const other = V.wallets.find((w) => w.address !== JSON.parse(c.plaintext).qnet);
  const flip = (h) => `${h.slice(0, -2)}${((Number.parseInt(h.slice(-2), 16) ^ 1) & 0xff).toString(16).padStart(2, '0')}`;
  const bad = {
    // The payment key's fields never come from the page.
    keys: [{ extra: 1 }, { burn_wallet: V.burner.address }, { owner_signature: bindOf(c) }, null],
    node_type: [{ node_type: 'super' }],
    wallet: [{ from: other.address }, { wallet_address: 'x', from: 'x' }],
    // Another wallet throughout still names this node, or names its own node with this wallet's key.
    node_id: [{ node_id: other.nodeId }, { wallet_address: other.address, from: other.address }],
    burn_tx_hash: [{ burn_tx_hash: 'x' }],
    burn_amount: [{ burn_amount: 0 }, { burn_amount: 1.5 }, { burn_amount: '1500' }],
    registration_proof: [{ registration_proof: '0'.repeat(32) }],
    timestamp: [{ timestamp: '1790000000' }, { timestamp: -1 }],
    dilithium_public_key: [{ dilithium_public_key: other.publicKey }],
    dilithium_signature: [{ dilithium_signature: flip(bodyOf(c).dilithium_signature) }, { timestamp: Number(JSON.parse(c.plaintext).consent.ts) + 1 }],
  };
  for (const [reason, variants] of Object.entries(bad)) {
    for (const over of variants) {
      const body = over === null ? null : reason === 'keys' ? { ...bodyOf(c), ...over } : bodyOf(c, over);
      const checked = checkConsentBody(body, verifyConsent);
      assert.equal(checked.ok, false, `${reason} ${JSON.stringify(over)?.slice(0, 60)}`);
      assert.equal(checked.reason, reason, JSON.stringify(over)?.slice(0, 60));
    }
  }
  // A verifier that throws refuses too.
  assert.equal(checkConsentBody(bodyOf(c), () => { throw new Error('x'); }).reason, 'dilithium_signature');
  // Completed with the record's burner and bind, in the node's order; never with a bind that does not verify.
  const full = completeSubmitBody(bodyOf(c), V.burner.address, bindOf(c));
  assert.deepEqual(Object.keys(full), [...SUBMIT_KEYS]);
  assert.deepEqual(full, { ...bodyOf(c), burn_wallet: V.burner.address, owner_signature: bindOf(c) });
  assert.equal(completeSubmitBody(bodyOf(c), '11111111111111111111111111111111', bindOf(c)), null, 'another burner');
  assert.equal(completeSubmitBody(bodyOf(okCases[1] ?? c, { burn_tx_hash: V.node[0].burnTx }), V.burner.address, bindOf(c)), null, 'another burn');
  assert.equal(completeSubmitBody(bodyOf(c), V.burner.address, '0'.repeat(128)), null);
});

test('the node\'s answers: admitted, on the chain already, a retry, a stale consent, or a refusal; its code first, else its text', () => {
  const tx = 'ab'.repeat(32);
  assert.deepEqual(submitOutcome(200, { success: true, tx_hash: tx }), { result: 'admitted', txHash: tx });
  assert.deepEqual(submitOutcome(200, { success: true, tx_hash: 'x' }), { result: 'retry', code: 'unreadable' });
  assert.deepEqual(submitOutcome(200, { success: false, error: 'Node already registered' }), { result: 'registered' });
  assert.deepEqual(submitOutcome(200, { success: false, code: 'already_registered', error: 'whatever' }), { result: 'registered' });
  assert.deepEqual(submitOutcome(200, { success: false, error: 'Request timestamp too old or too far in future (max 5 min)' }), { result: 'stale' });
  for (const [error, code] of [
    ['node is behind the chain; retry shortly', 'behind_chain'],
    ['burn-attestation committee unavailable (node syncing); retry shortly', 'committee_unavailable'],
    ['burn-attestation quorum not yet reached; retry shortly', 'quorum_pending'],
    ['Failed to add TX to mempool', 'mempool_rejected'],
    ['Rate limit exceeded', 'rate_limited'],
  ]) assert.deepEqual(submitOutcome(200, { success: false, error }), { result: 'retry', code }, error);
  assert.deepEqual(submitOutcome(200, { success: false, code: 'quorum_pending' }), { result: 'retry', code: 'quorum_pending' });
  assert.deepEqual(submitOutcome(200, { success: false, code: 'bad_request', error: 'x' }), { result: 'refused', code: 'bad_request' });
  // The network's one-node rule (one wallet, one node of either type): refused for good, by its code or its text, and
  // its text is never taken for this node's own registration.
  const text = 'This wallet already has a node on the QNet network: one wallet, one node';
  assert.deepEqual(submitOutcome(200, { success: false, code: 'wallet_has_node', error: text, node_id: 'super_node_0123456789abcdef' }), { result: 'refused', code: 'wallet_has_node' });
  assert.deepEqual(submitOutcome(200, { success: false, error: text }), { result: 'refused', code: 'wallet_has_node' });
  assert.doesNotMatch(text, /node already registered/i);
  assert.deepEqual(submitOutcome(200, { success: false, error: 'owner_signature invalid' }), { result: 'refused', code: 'refused' });
  assert.deepEqual(submitOutcome(200, { success: false, code: 'made_up', error: 'x' }), { result: 'refused', code: 'refused' });
  assert.deepEqual(submitOutcome(503, null), { result: 'retry', code: 'http_503' });
  assert.deepEqual(submitOutcome(429, null), { result: 'retry', code: 'rate_limited' });
  assert.deepEqual(submitOutcome(200, 'x'), { result: 'retry', code: 'unreadable' });
  // The page reads the route's answer again, exactly.
  for (const ok of [{ result: 'admitted', txHash: tx }, { result: 'registered' }, { result: 'retry', code: 'network' }, { result: 'stale' }, { result: 'refused', code: 'bad_request' }, { result: 'refused', code: 'no_record' }, { result: 'refused', code: 'wallet_has_node' }]) {
    assert.deepEqual(parseSubmitOutcome(ok), ok);
  }
  for (const bad of [{ result: 'admitted' }, { result: 'registered', x: 1 }, { result: 'retry', code: 'Bad Code' }, { result: 'done' }, null, []]) {
    assert.equal(parseSubmitOutcome(bad), null, JSON.stringify(bad));
  }
});

let scopes = 0;
function route(nodeAnswer, options = {}) {
  const calls = [];
  const rows = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: init.body });
    const a = typeof nodeAnswer === 'function' ? await nodeAnswer() : nodeAnswer;
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a), { status: 200 });
  };
  const r = createRegister({
    fetchFn, nodes: ['https://node1.aiqnet.io', 'https://node2.aiqnet.io'], random: () => 0.9, verifyConsent,
    clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.9' }), scope: `reg${(scopes += 1)}`, devOrigins: false,
    paymentRecord: async (w) => {
      rows.push(w);
      return rowOf(okCases.find((c) => JSON.parse(c.plaintext).qnet === w) ?? okCases[0]);
    },
    ...options,
  });
  return { r, calls, rows };
}
const post = (body, headers = {}) => new Request('https://aiqnet.io/api/cabinet/register', {
  method: 'POST', headers: { host: 'aiqnet.io', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const json = async (res) => JSON.parse(await res.text());

test('/register: checks, then one genesis node gets the body completed from the record, and the answer maps; one submit in flight per node', async () => {
  const c = okCases[0];
  const body = bodyOf(c);
  const tx = 'cd'.repeat(32);
  const { r, calls, rows } = route({ success: true, tx_hash: tx });
  const res = await r.submit(post(body));
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { result: 'admitted', txHash: tx });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://node2.aiqnet.io/api/v1/node-registration/submit');
  // The node gets the consent with the record's burner and bind, in its order.
  const sent = JSON.parse(calls[0].body);
  assert.deepEqual(Object.keys(sent), [...SUBMIT_KEYS]);
  assert.deepEqual(sent, { ...body, burn_wallet: V.burner.address, owner_signature: bindOf(c) });
  assert.deepEqual(rows, [body.wallet_address]);

  const bad = await r.submit(post({ ...body, burn_amount: 0 }));
  assert.equal(bad.status, 400);
  assert.deepEqual(await json(bad), { error: 'invalid_request', reason: 'burn_amount' });
  assert.equal(calls.length, 1, 'a refused body reaches no node');
  assert.equal((await r.submit(post(body, { origin: 'https://evil.example' }))).status, 403);

  // While one submit for the node waits, another is a retry, not a second submit.
  let release;
  const held = route(() => new Promise((resolve) => { release = resolve; }));
  const first = held.r.submit(post(body));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await json(await held.r.submit(post(body))), { result: 'retry', code: 'in_flight' });
  release({ success: false, error: 'burn-attestation quorum not yet reached; retry shortly' });
  assert.deepEqual(await json(await first), { result: 'retry', code: 'quorum_pending' });
  assert.equal(held.calls.length, 1);

  const down = route(new TypeError('fetch failed'));
  assert.deepEqual(await json(await down.r.submit(post(body))), { result: 'retry', code: 'network' });

  // The network's one-node rule: refused for good.
  const one = route({ success: false, code: 'wallet_has_node', error: 'This wallet already has a node on the QNet network: one wallet, one node' });
  assert.deepEqual(await json(await one.r.submit(post(body))), { result: 'refused', code: 'wallet_has_node' });

  // Six per node in ten minutes, whichever client sends them.
  const { r: limited } = route({ success: false, error: 'Node already registered' });
  for (let i = 0; i < 6; i += 1) assert.equal((await limited.submit(post(body, { 'x-test-ip': `198.51.100.${i}` }))).status, 200);
  assert.equal((await limited.submit(post(body, { 'x-test-ip': '198.51.100.77' }))).status, 429);

  // SITE-2: bodies naming the node whose signatures do not verify spend nothing of that node's budget, from however
  // many clients: the real registration still gets its six submits.
  const { r: victim, calls: victimCalls } = route({ success: false, error: 'Node already registered' });
  const junk = { ...body, dilithium_signature: `${body.dilithium_signature.slice(0, -2)}${body.dilithium_signature.endsWith('00') ? '01' : '00'}` };
  for (let i = 0; i < 12; i += 1) assert.equal((await victim.submit(post(junk, { 'x-test-ip': `192.0.2.${i}` }))).status, 400);
  assert.equal(victimCalls.length, 0);
  for (let i = 0; i < 6; i += 1) assert.equal((await victim.submit(post(body, { 'x-test-ip': `198.51.100.${i}` }))).status, 200, `submit ${i}`);
  // SITE-8: one carrier NAT address carries several activations' submits; each node keeps its own budget.
  assert.deepEqual(CABINET_LIMITS.register, { max: 30, windowMs: 600_000 });
  assert.deepEqual(KEYED_LIMITS.register, { max: 6, windowMs: 600_000 });
});

// A2 (owner, 29.09): the registration of a payment address's burn is finished from any browser or device with a fresh
// consent; the site takes the burner and the owner bind from the wallet's record, never from the page. Anything else
// than the wallet's own final payment burn of this very burn and amount, whose reservation this wallet key signed, is
// refused, and no node hears of it.
test('/register: completed from the wallet\'s record in any browser; not final, another burn, no record, another key: nothing relayed', async () => {
  const c = okCases[0];
  const body = bodyOf(c);
  const cases = [
    ['unavailable', 'unavailable', { result: 'retry', code: 'unavailable' }],
    ['no record', null, { result: 'refused', code: 'no_record' }],
    ['a reservation only', rowOf(c, { state: 'reserved', burnTx: null }), { result: 'refused', code: 'no_record' }],
    ['another burn', rowOf(c, { burnTx: V.node[0].burnTx }), { result: 'refused', code: 'other_burn' }],
    ['the extension\'s burn', rowOf(c, { way: 'extension' }), { result: 'refused', code: 'no_record' }],
    ['not final yet', rowOf(c, { state: 'sending' }), { result: 'retry', code: 'not_final' }],
    ['another amount', rowOf(c, { burnAmount: 1400 }), { result: 'refused', code: 'invalid_burn' }],
    ['another wallet key', rowOf(c, { proof: { ...rowOf(c).proof, pk: encodeB64url(bytes(V.wallets.find((w) => w.address !== body.wallet_address).publicKey)) } }), { result: 'refused', code: 'owner_bind' }],
    ['no bind', rowOf(c, { proof: { ...rowOf(c).proof, ownerSig: undefined } }), { result: 'refused', code: 'owner_bind' }],
    ['a bind of another burner', rowOf(c, { burner: '11111111111111111111111111111111' }), { result: 'refused', code: 'owner_bind' }],
  ];
  for (const [what, row, outcome] of cases) {
    const { r, calls } = route({ success: true, tx_hash: 'cd'.repeat(32) }, { paymentRecord: async () => row });
    assert.deepEqual(await json(await r.submit(post(body))), outcome, what);
    assert.equal(calls.length, 0, `${what}: nothing relayed`);
    assert.deepEqual(fromRecord(body, row), outcome, what);
  }
  // Without a registry, nothing is relayed either.
  const { r: bare, calls } = route({ success: true, tx_hash: 'cd'.repeat(32) }, { paymentRecord: undefined });
  assert.deepEqual(await json(await bare.submit(post(body))), { result: 'retry', code: 'unavailable' });
  assert.equal(calls.length, 0);
  assert.deepEqual(parseSubmitOutcome({ result: 'refused', code: 'other_burn' }), { result: 'refused', code: 'other_burn' });
  // "Another browser": the consent alone, no payment key anywhere, and the node gets the full body.
  assert.deepEqual(fromRecord(body, rowOf(c)), { ...body, burn_wallet: V.burner.address, owner_signature: bindOf(c) });
});

// SITE-R2-09: the site sends each genesis node at most UPSTREAM_BUDGETS.submit registrations a second; past it the next
// node takes the submit, and with none left the page submits again later.
test('/register: each genesis node takes a bounded number of submits a second, then the next one, then none', async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const c = okCases[0];
  const body = bodyOf(c);
  const { r, calls } = route({ success: true, tx_hash: 'cd'.repeat(32) }, { now, budget: createUpstreamBudget({ now }) });
  const outcomes = [];
  for (let i = 0; i < 5; i += 1) outcomes.push(await json(await r.submit(post(body, { 'x-test-ip': `198.51.100.${i + 10}` }))));
  assert.deepEqual(calls.map((x) => new URL(x.url).host), ['node2.aiqnet.io', 'node2.aiqnet.io', 'node1.aiqnet.io', 'node1.aiqnet.io']);
  assert.deepEqual(outcomes.at(-1), { result: 'retry', code: 'busy' });
  assert.deepEqual(parseSubmitOutcome(outcomes.at(-1)), { result: 'retry', code: 'busy' });
  t += UPSTREAM_BUDGETS.submit.windowMs;
  assert.equal((await json(await r.submit(post(body, { 'x-test-ip': '198.51.100.30' })))).result, 'admitted');
  assert.equal(calls.length, 5);
});
