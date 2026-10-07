// The activation registry (src/server/cabinet/activation-registry.ts, activation-api.ts, burn-scan.ts; the reservation
// and record proofs of src/lib/cabinet/burn-record.ts): one wallet, one burn and one code, for a light or a super node,
// whichever browser, device or client starts it (unified plan R1 and R6; shared contracts C1-C5). A reservation needs
// the wallet's own signed reservation, fresh for its way: a stranger can neither hold a wallet nor burn in its name. Two
// reservations racing for one wallet: one wins. A reservation expires and can be taken again, a burn on its way cannot. A
// payment address's burn leaves only with the payment key's v2 owner bind of the reserved wallet and is the wallet's
// record for good once final. A burn is recorded only with a proof and only once Solana holds it final and valid; nobody
// can plant one for another wallet. The same burner's older burn replaces a newer one; another burn never does. The
// sweep. The PostgreSQL statements, and against a real database when TEST_DATABASE_URL names one. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {
  OFFCHAIN_CONTEXT, RECORD_STATES, RESERVATION_TTL_MS, RESERVE_PROOF_FUTURE_S, RESERVE_PROOF_PAST_S, SETTLE_AFTER_MS, burnRecordEnvelope,
  burnRecordMessage, parseActivationRecord, recordCode, reservationMessage, verifyBurnRecordProof, verifyReservationProof,
} from '../cabinet/burn-record.ts';
import { ownerBindMessageV2 } from '../cabinet/registration.ts';
import { activationCode, bytesToHex, consentProof, encodeB64url, eonOfPublicKey, lightNodeId } from '../qnet-link.ts';
import { ONE_DEV_MINT } from '../one-dev.ts';
import { SQL, SWEEP_EVERY_MS, createActivationRegistry, createMemoryStore, createPgStore, rowFrom } from '../../server/cabinet/activation-registry.ts';
import { PROOF_BODY_MAX_BYTES, RESERVE_SCAN_MAX_AGE_MS, createActivationApi } from '../../server/cabinet/activation-api.ts';
import {
  CLIENT_FULL_SCANS_PER_MINUTE, CLIENT_SCANS_PER_MINUTE, LIST_PER_MINUTE, SCANS_PER_MINUTE, SCAN_READS_MAX, SIGNATURES_MAX, SIGNATURE_PAGES_MAX, checkBurn,
  createBurnScanner, scanAddress,
} from '../../server/cabinet/burn-scan.ts';
import { CABINET_LIMITS, KEYED_LIMITS } from '../../server/cabinet/limits.ts';
import { activationOriginAllowed } from '../../server/request-guard.ts';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const seed = (label) => createHash('sha256').update(label).digest();
const utf8 = (s) => new TextEncoder().encode(s);
const T0 = 1_790_000_000_000;
const S0 = T0 / 1000;

// A wallet of the test: its QNet key (ML-DSA-65) and the Solana key of the same phrase (the burner).
function walletOf(label) {
  const { secretKey, publicKey } = ml_dsa65.keygen(seed(`qnet:${label}`));
  const edSeed = seed(`solana:${label}`);
  return { sk: secretKey, pk: publicKey, qnet: eonOfPublicKey(publicKey), edSeed, solana: bs58.encode(ed25519.getPublicKey(edSeed)) };
}
const A = walletOf('a');
const B = walletOf('b');
// A one-time payment address of the test (its Ed25519 key, as the page's payment key).
const PAY = walletOf('pay');
// A Solana signature of the test: 64 bytes, base58.
const sig = (label) => bs58.encode(Buffer.concat([seed(`tx1:${label}`), seed(`tx2:${label}`)]));

function proofFor(w, facts, { context = OFFCHAIN_CONTEXT, sk = w.sk, pk = w.pk, edSeed = w.edSeed } = {}) {
  const env = burnRecordEnvelope(burnRecordMessage(facts.wallet, facts.nodeType, facts.burner, facts.burnTx, facts.burnAmount));
  return {
    pk: encodeB64url(pk),
    sig: encodeB64url(ml_dsa65.sign(env, sk, { context: utf8(context) })),
    solanaSig: bs58.encode(ed25519.sign(env, edSeed)),
  };
}

// The wallet's signed reservation (C1) of these fields at `time` (Unix seconds).
function holdFor(w, fields, time = S0, { context = OFFCHAIN_CONTEXT, sk = w.sk, pk = w.pk } = {}) {
  const env = burnRecordEnvelope(reservationMessage(fields.wallet, fields.nodeType, fields.way, fields.burner, time));
  return { pk: encodeB64url(pk), sig: encodeB64url(ml_dsa65.sign(env, sk, { context: utf8(context) })), time };
}

// The payment key's v2 owner bind (C4) of `burnTx` for `w`'s light node, by the burner's Ed25519 seed, as hex.
function ownerBind(w, burnTx, edSeed = PAY.edSeed, pk = w.pk) {
  const nodeId = lightNodeId(w.qnet);
  return bytesToHex(ed25519.sign(utf8(ownerBindMessageV2(nodeId, w.qnet, consentProof(burnTx, nodeId, w.qnet), pk, burnTx)), edSeed));
}

// A fake Solana: burns land by their signature (status, then the parsed transaction), and an address's signatures.
function fakeSolana() {
  const txs = new Map();
  const listed = new Map();
  let down = false;
  const rpc = async (method, params) => {
    if (down) throw new Error('rpc_http_503');
    if (method === 'getSignatureStatuses') return { value: [txs.get(params[0][0])?.status ?? null] };
    if (method === 'getTransaction') {
      const e = txs.get(params[0]);
      return e && e.status.confirmationStatus === 'finalized' ? e.tx : null;
    }
    if (method === 'getSignaturesForAddress') return listed.get(params[0]) ?? [];
    throw new Error(`unexpected ${method}`);
  };
  const land = (burnTx, { payer, amount = 1500, memo = 'QNET_NODE_TYPE:LIGHT', slot = 100, blockTime = 1_790_000_000, final = true, err = null, burnMint = ONE_DEV_MINT }) => {
    txs.set(burnTx, {
      status: { err, confirmationStatus: final ? 'finalized' : 'confirmed' },
      tx: {
        slot, blockTime, meta: { err },
        transaction: { message: { accountKeys: [{ pubkey: payer, signer: true, writable: true }], instructions: [
          { program: 'spl-token', parsed: { type: 'burn', info: { mint: burnMint, authority: payer, account: 'x', amount: `${amount}000000` } } },
          { program: 'spl-memo', parsed: memo },
        ] } },
      },
    });
  };
  return { rpc, land, txs, listed, setDown: (v) => { down = v; } };
}

function setup({ now = () => T0, node = { state: 'none' }, scan = { complete: true, unusable: false, burns: [] } } = {}) {
  const solana = fakeSolana();
  const store = createMemoryStore({ now, ttlMs: RESERVATION_TTL_MS });
  let n = 0;
  const registry = createActivationRegistry({
    store, now, check: (burnTx, expect) => checkBurn(solana.rpc, burnTx, expect), newReservation: () => (n += 1).toString(16).padStart(32, '0'),
  });
  const state = { node, scan };
  const api = createActivationApi({
    registry, now, scope: `act${Math.random()}`, devOrigins: false, clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.5' }),
    walletNode: async () => (typeof state.node === 'function' ? state.node() : state.node),
    scan: async () => (typeof state.scan === 'function' ? state.scan() : state.scan),
  });
  return { solana, store, registry, api, state };
}

const post = (path, body, headers = {}) => new Request(`https://aiqnet.io/api/cabinet/activation/${path}`, {
  method: 'POST', headers: { host: 'aiqnet.io', 'content-type': 'application/json', origin: 'https://aiqnet.io', ...headers }, body: JSON.stringify(body),
});
const get = (wallet, solana, headers = {}) => new Request(`https://aiqnet.io/api/cabinet/activation/${wallet}${solana ? `?solana=${solana}` : ''}`, { headers: { host: 'aiqnet.io', ...headers } });
const json = async (res) => ({ status: res.status, body: JSON.parse(await res.text()) });
// A reservation body with the wallet's signed reservation of its final fields (`signer` signs it, at `time`).
function reserveBody(w, over = {}, { signer = w, time = S0, context } = {}) {
  const body = { wallet: w.qnet, nodeType: 'light', way: 'extension', burner: w.solana, burnAmount: 1500, solana: w.solana, ...over };
  return { ...body, proof: holdFor(signer, body, time, { context }) };
}
// The registry's own reservation input for a payment address's light burn of `w`.
const payReserve = (w, burner = PAY.solana, time = S0) => {
  const fields = { wallet: w.qnet, nodeType: 'light', way: 'payment', burner };
  return { ...fields, burnAmount: 1500, proof: holdFor(w, fields, time) };
};

test('C1: the record message and its envelope are exact, and the proof needs both keys of the wallet', () => {
  const burnTx = sig('c1');
  const facts = { wallet: A.qnet, nodeType: 'super', burner: A.solana, burnTx, burnAmount: 1500 };
  const m = burnRecordMessage(A.qnet, 'super', A.solana, burnTx, 1500);
  assert.equal(m, `QNet burn record v1\nwallet: ${A.qnet}\nnode: super\nburner: ${A.solana}\nburn: ${burnTx}\namount: 1500\ncluster: devnet`);
  assert.ok(!m.endsWith('\n'));
  const env = new TextDecoder().decode(burnRecordEnvelope(m));
  assert.equal(env, `QNet Signed Message:\nhttps://aiqnet.io\n${utf8(m).length}\n${m}`);
  assert.equal(verifyBurnRecordProof(facts, proofFor(A, facts)), true);
  // Another wallet's key, the dApp context missing, the other Solana key, another fact: refused.
  assert.equal(verifyBurnRecordProof(facts, proofFor(A, facts, { sk: B.sk, pk: B.pk })), false, 'not the wallet\'s key');
  assert.equal(verifyBurnRecordProof(facts, proofFor(A, facts, { context: 'OTHER' })), false, 'wrong ML-DSA context');
  assert.equal(verifyBurnRecordProof(facts, proofFor(A, facts, { edSeed: B.edSeed })), false, 'wrong Solana signature');
  assert.equal(verifyBurnRecordProof({ ...facts, burnAmount: 1501 }, proofFor(A, facts)), false, 'another amount');
  assert.equal(verifyBurnRecordProof({ ...facts, nodeType: 'light' }, proofFor(A, facts)), false, 'another node type');
  assert.equal(verifyBurnRecordProof({ ...facts, wallet: B.qnet }, proofFor(A, facts)), false, 'planted for another wallet');
  assert.equal(verifyBurnRecordProof(facts, { ...proofFor(A, facts), extra: 1 }), false, 'exact keys');
});

// A1 (owner, 29.09): only the wallet itself holds itself: the extension signs with the wallet's keys, QNet Wallet signs
// a payment address's reservation before the address exists.
test('C1: the reservation message is exact; only the wallet\'s own fresh signature over these very fields holds it', () => {
  const fields = { wallet: A.qnet, nodeType: 'light', way: 'payment', burner: PAY.solana };
  const m = reservationMessage(A.qnet, 'light', 'payment', PAY.solana, 1_790_000_000);
  assert.equal(m, `QNet node reservation v1\nwallet: ${A.qnet}\nnode: light\nway: payment\nburner: ${PAY.solana}\ntime: 1790000000\ncluster: devnet`);
  assert.ok(!m.endsWith('\n'));
  assert.equal(new TextDecoder().decode(burnRecordEnvelope(m)), `QNet Signed Message:\nhttps://aiqnet.io\n${utf8(m).length}\n${m}`);
  assert.deepEqual(RESERVE_PROOF_PAST_S, { extension: 600, payment: 87_000 });
  assert.equal(RESERVE_PROOF_FUTURE_S, 300);
  assert.equal(verifyReservationProof(fields, holdFor(A, fields), S0), 'ok');
  // Another wallet's key, the wrong context, another field, a forged or reshaped proof: invalid.
  assert.equal(verifyReservationProof(fields, holdFor(A, fields, S0, { sk: B.sk, pk: B.pk }), S0), 'invalid', 'another wallet\'s key');
  assert.equal(verifyReservationProof(fields, holdFor(A, fields, S0, { sk: B.sk }), S0), 'invalid', 'forged signature');
  assert.equal(verifyReservationProof(fields, holdFor(A, fields, S0, { context: 'OTHER' }), S0), 'invalid', 'wrong context');
  for (const other of [{ burner: B.solana }, { way: 'extension' }, { nodeType: 'super' }, { wallet: B.qnet }]) {
    assert.equal(verifyReservationProof({ ...fields, ...other }, holdFor(A, fields), S0), 'invalid', JSON.stringify(other));
  }
  const good = holdFor(A, fields);
  assert.equal(verifyReservationProof(fields, { ...good, time: S0 + 1 }, S0), 'invalid', 'another time than it signed');
  assert.equal(verifyReservationProof(fields, { ...good, extra: 1 }, S0), 'invalid', 'exact keys');
  assert.equal(verifyReservationProof(fields, { ...good, time: String(S0) }, S0), 'invalid', 'the time is a number');
  assert.equal(verifyReservationProof(fields, null, S0), 'invalid');
  // Freshness per way: a payment address waits up to 24 hours for its burn; the extension signs right before it burns.
  assert.equal(verifyReservationProof(fields, holdFor(A, fields, S0 - 87_000), S0), 'ok', 'a payment reservation of 24 h 10 min');
  assert.equal(verifyReservationProof(fields, holdFor(A, fields, S0 - 87_001), S0), 'stale');
  assert.equal(verifyReservationProof(fields, holdFor(A, fields, S0 + 300), S0), 'ok');
  assert.equal(verifyReservationProof(fields, holdFor(A, fields, S0 + 301), S0), 'stale', 'too far ahead');
  const ext = { ...fields, way: 'extension', burner: A.solana };
  assert.equal(verifyReservationProof(ext, holdFor(A, ext, S0 - 600), S0), 'ok');
  assert.equal(verifyReservationProof(ext, holdFor(A, ext, S0 - 601), S0), 'stale');
  // A stale forgery is invalid, not stale: the signature is checked first.
  assert.equal(verifyReservationProof(ext, holdFor(A, ext, S0 - 9_999, { sk: B.sk }), S0), 'invalid');
});

test('C1: the reserve route refuses an unsigned, forged, other wallet\'s or stale reservation, and keeps the proof it took', async () => {
  const s = setup();
  const reserve = (body) => s.api.reserve(post('reserve', body)).then(json);
  const { proof, ...unsigned } = reserveBody(A);
  assert.deepEqual(await reserve(unsigned), { status: 400, body: { error: 'invalid_request' } }, 'no proof');
  assert.deepEqual(await reserve({ ...unsigned, proof: null }), { status: 400, body: { error: 'invalid_proof' } });
  assert.deepEqual(await reserve(reserveBody(A, {}, { signer: B })), { status: 400, body: { error: 'invalid_proof' } }, 'B signs for A');
  assert.deepEqual(await reserve({ ...unsigned, proof: { ...proof, pk: encodeB64url(B.pk) } }), { status: 400, body: { error: 'invalid_proof' } }, 'another wallet\'s key');
  assert.deepEqual(await reserve(reserveBody(A, {}, { context: 'OTHER' })), { status: 400, body: { error: 'invalid_proof' } });
  // Signed for another burner or node type than the body names.
  assert.deepEqual(await reserve({ ...reserveBody(A, { nodeType: 'super' }), proof }), { status: 400, body: { error: 'invalid_proof' } });
  assert.deepEqual(await reserve(reserveBody(A, {}, { time: S0 - 601 })), { status: 400, body: { error: 'stale_proof' } }, 'the extension\'s 10 minutes');
  const pay = { way: 'payment', burner: PAY.solana };
  assert.deepEqual(await reserve(reserveBody(A, pay, { time: S0 - 87_001 })), { status: 400, body: { error: 'stale_proof' } });
  assert.equal(s.store.rows.size, 0, 'nothing held');
  // A payment reservation QNet Wallet signed a day ago, before the address was funded: held, with its proof kept.
  const dayOld = reserveBody(A, pay, { time: S0 - 86_400 });
  const held = await reserve(dayOld);
  assert.equal(held.status, 200);
  const row = s.store.rows.get(A.qnet);
  assert.deepEqual(row.proof, dayOld.proof);
  assert.equal(row.way, 'payment');
  // The extension's, fresh: held too (after the payment reservation is released).
  await s.api.release(post('release', { wallet: A.qnet, reservation: held.body.reservation }));
  const ext = reserveBody(A);
  assert.equal((await reserve(ext)).status, 200);
  assert.deepEqual(s.store.rows.get(A.qnet).proof, ext.proof);
  // The body cap takes a proof (two base64url ML-DSA-65 values) and no more.
  assert.equal(PROOF_BODY_MAX_BYTES, 12 * 1024);
  assert.ok(JSON.stringify(ext).length < PROOF_BODY_MAX_BYTES);
});

test('C3.2 + C4: two browsers reserve one wallet at once: exactly one wins, and the other is told it is held', async () => {
  const s = setup();
  const answers = await Promise.all([
    s.api.reserve(post('reserve', reserveBody(A), { 'x-test-ip': '198.51.100.1' })),
    s.api.reserve(post('reserve', reserveBody(A, { nodeType: 'super' }), { 'x-test-ip': '198.51.100.2' })),
    s.api.reserve(post('reserve', reserveBody(A, { way: 'payment', burner: B.solana }), { 'x-test-ip': '198.51.100.3' })),
  ].map((p) => p.then(json)));
  assert.deepEqual(answers.map((a) => a.status).sort(), [200, 409, 409]);
  const lost = answers.filter((a) => a.status === 409);
  for (const a of lost) {
    assert.equal(a.body.error, 'reserved');
    assert.equal(a.body.activation.state, 'reserved');
    assert.equal(a.body.activation.burner, null);
  }
  const won = answers.find((a) => a.status === 200).body;
  assert.match(won.reservation, /^[0-9a-f]{32}$/);
  assert.equal(won.until, T0 + RESERVATION_TTL_MS);
  assert.equal(s.store.rows.size, 1);
});

test('C3.2: every source is asked first; any that cannot answer holds nothing', async () => {
  const s = setup({ node: null });
  assert.deepEqual((await json(await s.api.reserve(post('reserve', reserveBody(A))))).body, { error: 'network_unavailable' });
  // A node of either type holds the wallet (one wallet, one node).
  for (const nodeType of ['super', 'light']) {
    const nodeId = nodeType === 'super' ? 'super_node_0123456789abcdef' : lightNodeId(A.qnet);
    s.state.node = { state: 'registered', nodeId, nodeType };
    for (const body of [reserveBody(A), reserveBody(A, { nodeType: 'super' }), reserveBody(A, { way: 'payment', burner: B.solana })]) {
      assert.deepEqual((await json(await s.api.reserve(post('reserve', body)))), { status: 409, body: { error: 'has_node', nodeId, nodeType } });
    }
  }
  s.state.node = { state: 'none' };
  // The payment way: the wallet's own Solana address is searched afresh.
  const pay = reserveBody(A, { way: 'payment', burner: B.solana });
  s.state.scan = { complete: false, unusable: false, burns: [] };
  assert.deepEqual((await json(await s.api.reserve(post('reserve', pay)))), { status: 503, body: { error: 'scan_incomplete' } });
  s.state.scan = { complete: true, unusable: true, burns: [] };
  assert.deepEqual((await json(await s.api.reserve(post('reserve', pay)))), { status: 409, body: { error: 'burn_unusable' } });
  const found = [{ burnTx: sig('old'), nodeType: 'super', burnAmount: 1500 }];
  s.state.scan = { complete: true, unusable: false, burns: found };
  assert.deepEqual((await json(await s.api.reserve(post('reserve', pay)))), { status: 409, body: { error: 'burn_found', burns: found } });
  assert.equal(s.store.rows.size, 0, 'nothing held');
  // The database itself not answering: unavailable, nothing burns.
  const broken = createActivationApi({
    registry: createActivationRegistry({ store: createPgStore(async () => { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; }), check: async () => null }),
    walletNode: async () => ({ state: 'none' }), scan: async () => ({ complete: true, unusable: false, burns: [] }),
    now: () => T0, scope: `x${Math.random()}`, devOrigins: false, clientKey: () => ({ ok: true, ip: '203.0.113.9' }),
  });
  assert.deepEqual(await json(await broken.reserve(post('reserve', reserveBody(A)))), { status: 503, body: { error: 'unavailable' } });
  assert.deepEqual(await json(await broken.get(get(A.qnet), A.qnet)), { status: 503, body: { error: 'unavailable' } });
  // Shapes: the payment way is light only; the extension burns from the wallet's own address.
  for (const bad of [reserveBody(A, { way: 'payment', nodeType: 'super' }), reserveBody(A, { solana: B.solana }), reserveBody(A, { burnAmount: 0 }), { ...reserveBody(A), x: 1 }]) {
    assert.deepEqual((await json(await s.api.reserve(post('reserve', bad)))).status, 400, JSON.stringify(bad));
  }
});

test('C3.0: the site and the extension may call; another site\'s page may not; a 429 names when to come back', async () => {
  const req = (headers) => new Request('https://aiqnet.io/api/cabinet/activation/x', { headers: { host: 'aiqnet.io', ...headers } });
  assert.equal(activationOriginAllowed(req({}), false), true);
  assert.equal(activationOriginAllowed(req({ origin: 'https://aiqnet.io', 'sec-fetch-site': 'same-origin' }), false), true);
  assert.equal(activationOriginAllowed(req({ origin: `chrome-extension://${'a'.repeat(32)}`, 'sec-fetch-site': 'none' }), false), true);
  assert.equal(activationOriginAllowed(req({ origin: `chrome-extension://${'q'.repeat(32)}` }), false), false);
  assert.equal(activationOriginAllowed(req({ origin: 'https://evil.example' }), false), false);
  assert.equal(activationOriginAllowed(req({ 'sec-fetch-site': 'cross-site' }), false), false);
  const s = setup();
  assert.deepEqual(await json(await s.api.get(get(A.qnet, null, { 'sec-fetch-site': 'cross-site' }), A.qnet)), { status: 403, body: { error: 'forbidden_origin' } });
  assert.deepEqual(CABINET_LIMITS.activation, { max: 60, windowMs: 60_000 });
  assert.deepEqual(CABINET_LIMITS.activationScan, { max: 10, windowMs: 600_000 });
  assert.deepEqual(CABINET_LIMITS.activationWrite, { max: 20, windowMs: 600_000 });
  assert.deepEqual(KEYED_LIMITS.activationRecord, { max: 10, windowMs: 600_000 });
  for (let i = 0; i < 10; i += 1) assert.equal((await s.api.get(get(A.qnet, A.solana), A.qnet)).status, 200);
  const limited = await s.api.get(get(A.qnet, A.solana), A.qnet);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(limited.headers.get('cache-control'), 'no-store');
});

test('an expired reservation can be taken again; a burn on its way cannot; an announce after expiry is refused', async () => {
  let t = T0;
  const s = setup({ now: () => t });
  const first = (await json(await s.api.reserve(post('reserve', reserveBody(A))))).body;
  const burnTx = sig('late');
  const facts = { wallet: A.qnet, nodeType: 'light', burner: A.solana, burnTx, burnAmount: 1500 };
  t += RESERVATION_TTL_MS + 1;
  assert.deepEqual(await json(await s.api.announce(post('announce', { wallet: A.qnet, reservation: first.reservation, burnTx, proof: proofFor(A, facts) }))), { status: 409, body: { error: 'reservation' } });
  const second = await json(await s.api.reserve(post('reserve', reserveBody(A, {}, { time: Math.floor(t / 1000) }))));
  assert.equal(second.status, 200, 'the expired reservation is replaced');
  assert.notEqual(second.body.reservation, first.reservation);
  // The winner announces its burn (with the wallet's proof), and then nothing else can hold the wallet.
  assert.deepEqual(await json(await s.api.announce(post('announce', { wallet: A.qnet, reservation: second.body.reservation, burnTx, proof: proofFor(A, { ...facts, burnTx: sig('other') }) }))), { status: 400, body: { error: 'invalid_proof' } });
  t += RESERVATION_TTL_MS / 2;
  const ok = await json(await s.api.announce(post('announce', { wallet: A.qnet, reservation: second.body.reservation, burnTx, proof: proofFor(A, facts) })));
  assert.deepEqual(ok, { status: 200, body: { ok: true, until: t + SETTLE_AFTER_MS } });
  assert.deepEqual((await json(await s.api.announce(post('announce', { wallet: A.qnet, reservation: second.body.reservation, burnTx, proof: proofFor(A, facts) })))).body, { ok: true, until: t + SETTLE_AFTER_MS }, 'the same burn again');
  // Past the reservation's end, not yet SETTLE_AFTER_MS after the announce: the burn on its way still holds the wallet.
  t += RESERVATION_TTL_MS / 2 + 60_000;
  const blocked = await json(await s.api.reserve(post('reserve', reserveBody(A, { nodeType: 'super' }, { time: Math.floor(t / 1000) }))));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'burn_pending');
  assert.equal(blocked.body.activation.state, 'sending');
  // A release does not end a burn on its way.
  assert.deepEqual((await json(await s.api.release(post('release', { wallet: A.qnet, reservation: second.body.reservation })))).body, { ok: true });
  assert.equal(s.store.rows.get(A.qnet).state, 'sending');
});

// A2 (owner, 29.09): a payment address's burn is the wallet's for good: announced with the payment key's v2 owner bind
// of the reserved wallet, recorded once final exactly like an extension burn, never released after a day.
test('C4: a payment burn leaves only with the v2 owner bind of the reserved wallet, and once final it is the wallet\'s record', async () => {
  let t = T0;
  const s = setup({ now: () => t });
  const input = payReserve(B);
  const r = await s.registry.reserve(input);
  assert.ok(r.ok);
  const tx = sig('pay-landed');
  // Without a bind that verifies for the wallet, the key its reservation signed with, this burn and this burner: refused.
  assert.deepEqual(await s.registry.announcePayment(r.reservation, PAY.solana, 1500, tx, '0'.repeat(128)), { ok: false, error: 'invalid_proof' });
  assert.deepEqual(await s.registry.announcePayment(r.reservation, PAY.solana, 1500, tx, ownerBind(B, sig('another'))), { ok: false, error: 'invalid_proof' }, 'another burn');
  assert.deepEqual(await s.registry.announcePayment(r.reservation, PAY.solana, 1500, tx, ownerBind(A, tx)), { ok: false, error: 'invalid_proof' }, 'another wallet');
  assert.deepEqual(await s.registry.announcePayment(r.reservation, PAY.solana, 1500, tx, ownerBind(B, tx, B.edSeed)), { ok: false, error: 'invalid_proof' }, 'another key');
  assert.deepEqual(await s.registry.announcePayment(r.reservation, PAY.solana, 1500, tx, ownerBind(B, tx, PAY.edSeed, A.pk)), { ok: false, error: 'invalid_proof' }, 'another wallet key');
  // Another reservation, burner or amount: not this reservation's burn.
  assert.deepEqual(await s.registry.announcePayment('f'.repeat(32), PAY.solana, 1500, tx, ownerBind(B, tx)), { ok: false, error: 'reservation' });
  assert.deepEqual(await s.registry.announcePayment(r.reservation, B.solana, 1500, tx, ownerBind(B, tx, B.edSeed)), { ok: false, error: 'reservation' });
  assert.deepEqual(await s.registry.announcePayment(r.reservation, PAY.solana, 1501, tx, ownerBind(B, tx)), { ok: false, error: 'reservation' });
  assert.equal(s.store.rows.get(B.qnet).state, 'reserved');
  // The real one: sending, with the signed reservation and the bind kept together.
  const bind = ownerBind(B, tx);
  assert.deepEqual(await s.registry.announcePayment(r.reservation, PAY.solana, 1500, tx, bind), { ok: true, wallet: B.qnet });
  assert.deepEqual(s.store.rows.get(B.qnet).proof, { ...input.proof, ownerSig: bind });
  assert.deepEqual(await s.registry.announcePayment(r.reservation, PAY.solana, 1500, sig('second'), ownerBind(B, sig('second'))), { ok: false, error: 'reservation' }, 'one burn per reservation');
  assert.equal((await json(await s.api.get(get(B.qnet), B.qnet))).body.state, 'sending');
  // Final: recorded at once, with the code of the wallet.
  s.solana.land(tx, { payer: PAY.solana, blockTime: 1_790_000_100, slot: 321 });
  let view = (await json(await s.api.get(get(B.qnet), B.qnet))).body;
  assert.equal(view.state, 'recorded');
  assert.equal(view.way, 'payment');
  assert.equal(view.code, activationCode('light', B.qnet, tx, 1500), 'a payment burn\'s code names the wallet');
  assert.deepEqual(parseActivationRecord(view, B.qnet), view);
  // A day and more later it is still the wallet's: no release, no sweep, no second reservation of either type or way.
  t += 3 * 86_400_000;
  await s.registry.release(B.qnet, r.reservation);
  await s.store.sweep();
  view = (await json(await s.api.get(get(B.qnet), B.qnet))).body;
  assert.equal(view.state, 'recorded');
  for (const body of [reserveBody(B, {}, { time: t / 1000 }), reserveBody(B, { nodeType: 'super' }, { time: t / 1000 }), reserveBody(B, { way: 'payment', burner: A.solana }, { time: t / 1000 })]) {
    const got = await json(await s.api.reserve(post('reserve', body)));
    assert.equal(got.status, 409);
    assert.equal(got.body.error, 'has_burn');
  }
  // The registration reads the row, in any browser: this burn, its burner and the bind.
  const row = await s.registry.paymentRecord(B.qnet);
  assert.deepEqual([row.state, row.way, row.burnTx, row.burner, row.proof.ownerSig], ['recorded', 'payment', tx, PAY.solana, bind]);
  assert.equal(await s.registry.paymentRecord(A.qnet), null);
  assert.equal(await s.api.paymentRecord(A.qnet), null);
  assert.equal((await s.api.paymentRecord(B.qnet)).burnTx, tx);
  // The api's answer for the send route.
  const r2 = await s.registry.reserve(payReserve(A, PAY.solana, t / 1000));
  const tx2 = sig('pay-api');
  assert.equal(await s.api.announcePayment(r2.reservation, PAY.solana, 1500, tx2, '1'.repeat(128)), 'invalid_proof');
  assert.equal(await s.api.announcePayment('e'.repeat(32), PAY.solana, 1500, tx2, ownerBind(A, tx2)), null);
  assert.equal(await s.api.announcePayment(r2.reservation, PAY.solana, 1500, tx2, ownerBind(A, tx2)), A.qnet);
});

test('settle: a landed burn is recorded whichever way; one never found, or failed, goes', async () => {
  let t = T0;
  const s = setup({ now: () => t });
  // The extension's burn: announced, landed, final: recorded, with its code.
  const r1 = (await json(await s.api.reserve(post('reserve', reserveBody(A, { nodeType: 'super' }))))).body;
  const tx1 = sig('ext-landed');
  const f1 = { wallet: A.qnet, nodeType: 'super', burner: A.solana, burnTx: tx1, burnAmount: 1500 };
  await s.api.announce(post('announce', { wallet: A.qnet, reservation: r1.reservation, burnTx: tx1, proof: proofFor(A, f1) }));
  let view = (await json(await s.api.get(get(A.qnet), A.qnet))).body;
  assert.equal(view.state, 'sending', 'Solana knows nothing yet');
  s.solana.land(tx1, { payer: A.solana, memo: 'QNET_NODE_TYPE:SUPER', final: false });
  assert.equal((await json(await s.api.get(get(A.qnet), A.qnet))).body.state, 'sending', 'seen, not final');
  s.solana.land(tx1, { payer: A.solana, memo: 'QNET_NODE_TYPE:SUPER', slot: 555 });
  view = (await json(await s.api.get(get(A.qnet), A.qnet))).body;
  assert.equal(view.state, 'recorded');
  assert.equal(view.code, activationCode('super', A.solana, tx1, 1500));
  assert.deepEqual(parseActivationRecord(view, A.qnet), view);
  assert.equal(s.store.rows.get(A.qnet).burnSlot, 555);

  // A burn announced and never found: the wallet is free again SETTLE_AFTER_MS after the announce.
  const C = walletOf('c');
  const r3 = (await json(await s.api.reserve(post('reserve', reserveBody(C))))).body;
  const tx3 = sig('never');
  const f3 = { wallet: C.qnet, nodeType: 'light', burner: C.solana, burnTx: tx3, burnAmount: 1500 };
  await s.api.announce(post('announce', { wallet: C.qnet, reservation: r3.reservation, burnTx: tx3, proof: proofFor(C, f3) }));
  t += SETTLE_AFTER_MS - 1;
  assert.equal((await json(await s.api.get(get(C.qnet), C.qnet))).body.state, 'sending');
  s.solana.setDown(true);
  t += 2;
  assert.equal((await json(await s.api.get(get(C.qnet), C.qnet))).body.state, 'sending', 'Solana unreachable: the row stays');
  s.solana.setDown(false);
  assert.equal((await json(await s.api.get(get(C.qnet), C.qnet))).body.state, 'none');
  // A burn that failed on chain frees the wallet at once; a payment burn too.
  const r4 = (await json(await s.api.reserve(post('reserve', reserveBody(C, {}, { time: Math.floor(t / 1000) }))))).body;
  const tx4 = sig('failed');
  await s.api.announce(post('announce', { wallet: C.qnet, reservation: r4.reservation, burnTx: tx4, proof: proofFor(C, { ...f3, burnTx: tx4 }) }));
  s.solana.land(tx4, { payer: C.solana, err: { InstructionError: [0, 'x'] } });
  assert.equal((await json(await s.api.get(get(C.qnet), C.qnet))).body.state, 'none');
  const r5 = await s.registry.reserve(payReserve(C, PAY.solana, Math.floor(t / 1000)));
  const tx5 = sig('pay-failed');
  assert.equal((await s.registry.announcePayment(r5.reservation, PAY.solana, 1500, tx5, ownerBind(C, tx5))).ok, true);
  s.solana.land(tx5, { payer: PAY.solana, err: { InstructionError: [0, 'x'] } });
  assert.equal((await json(await s.api.get(get(C.qnet), C.qnet))).body.state, 'none');
  // No state but these: nothing waits for a consent any more.
  assert.deepEqual(RECORD_STATES, ['none', 'reserved', 'sending', 'recorded']);
});

test('C3.5: a record needs the wallet\'s proof and a final, valid burn of its burner; nothing can be planted', async () => {
  const s = setup();
  const burnTx = sig('rec');
  const facts = { wallet: A.qnet, nodeType: 'light', burner: A.solana, burnTx, burnAmount: 1500 };
  const record = (f, proof) => s.api.record(post('record', { ...f, proof })).then(json);
  s.solana.land(burnTx, { payer: A.solana });
  // Planted for A with B's keys, the wrong context, the wrong Solana key: refused before Solana is asked.
  assert.deepEqual(await record(facts, proofFor(A, facts, { sk: B.sk, pk: B.pk })), { status: 400, body: { error: 'invalid_proof' } });
  assert.deepEqual(await record(facts, proofFor(A, facts, { context: 'QNET_OTHER' })), { status: 400, body: { error: 'invalid_proof' } });
  assert.deepEqual(await record(facts, proofFor(A, facts, { edSeed: B.edSeed })), { status: 400, body: { error: 'invalid_proof' } });
  // B's own proof over a burn A's address paid for: the burner is not the payer.
  const stolen = { ...facts, wallet: B.qnet, burner: B.solana };
  assert.deepEqual(await record(stolen, proofFor(B, stolen)), { status: 400, body: { error: 'invalid_burn' } });
  // The memo's node type, the amount, and a burn not final yet.
  const superFacts = { ...facts, nodeType: 'super' };
  assert.deepEqual(await record(superFacts, proofFor(A, superFacts)), { status: 400, body: { error: 'invalid_burn' } });
  const more = { ...facts, burnAmount: 2000 };
  assert.deepEqual(await record(more, proofFor(A, more)), { status: 400, body: { error: 'invalid_burn' } });
  const pendingTx = sig('rec-pending');
  s.solana.land(pendingTx, { payer: A.solana, final: false });
  const pending = { ...facts, burnTx: pendingTx };
  assert.deepEqual(await record(pending, proofFor(A, pending)), { status: 409, body: { error: 'not_final' } });
  assert.equal(s.store.rows.size, 0);
  // The real one.
  const ok = await record(facts, proofFor(A, facts));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.state, 'recorded');
  assert.equal(ok.body.code, recordCode('extension', 'light', A.qnet, A.solana, burnTx, 1500));
  assert.equal((await record(facts, proofFor(A, facts))).status, 200, 'idempotent');
  // The wallet is held for good: no reservation of either type or way (the extension after a reset and restore finds
  // it here too).
  for (const body of [reserveBody(A), reserveBody(A, { nodeType: 'super' }), reserveBody(A, { way: 'payment', burner: B.solana })]) {
    const got = await json(await s.api.reserve(post('reserve', body)));
    assert.equal(got.status, 409);
    assert.equal(got.body.error, 'has_burn');
    assert.equal(got.body.activation.code, ok.body.code);
  }
});

test('C3.5: the same burner\'s older burn replaces a newer record; another burn never does', async () => {
  const s = setup();
  const newer = sig('newer');
  const older = sig('older');
  const f = (burnTx, nodeType = 'light') => ({ wallet: A.qnet, nodeType, burner: A.solana, burnTx, burnAmount: 1500 });
  s.solana.land(newer, { payer: A.solana, slot: 900 });
  s.solana.land(older, { payer: A.solana, slot: 100, memo: 'QNET_NODE_TYPE:SUPER' });
  assert.equal((await json(await s.api.record(post('record', { ...f(newer), proof: proofFor(A, f(newer)) })))).status, 200);
  const replaced = await json(await s.api.record(post('record', { ...f(older, 'super'), proof: proofFor(A, f(older, 'super')) })));
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.burnTx, older);
  assert.equal(replaced.body.nodeType, 'super');
  // The newer one is refused now: the oldest burn is the code.
  const back = await json(await s.api.record(post('record', { ...f(newer), proof: proofFor(A, f(newer)) })));
  assert.equal(back.status, 409);
  assert.equal(back.body.error, 'other_burn');
  assert.equal(back.body.activation.burnTx, older);
});

// The extension-overrides-payment branch is gone (C4): a payment burn on its way or recorded is the wallet's, like the
// extension's.
test('C4: a payment burn on its way or recorded is the wallet\'s: the extension\'s own burn does not take its place', async () => {
  const s = setup();
  const r = await s.registry.reserve(payReserve(A));
  const payTx = sig('pay-first');
  assert.equal((await s.registry.announcePayment(r.reservation, PAY.solana, 1500, payTx, ownerBind(A, payTx))).ok, true);
  const own = sig('own-burn');
  s.solana.land(own, { payer: A.solana });
  const facts = { wallet: A.qnet, nodeType: 'light', burner: A.solana, burnTx: own, burnAmount: 1500 };
  const whileSending = await json(await s.api.record(post('record', { ...facts, proof: proofFor(A, facts) })));
  assert.equal(whileSending.status, 409);
  assert.equal(whileSending.body.error, 'other_burn');
  s.solana.land(payTx, { payer: PAY.solana });
  const afterFinal = await json(await s.api.record(post('record', { ...facts, proof: proofFor(A, facts) })));
  assert.equal(afterFinal.status, 409);
  assert.equal(afterFinal.body.activation.burnTx, payTx);
  assert.equal(afterFinal.body.activation.way, 'payment');
});

test('release frees only a reservation without a burn; the sweep ends only reservations the clock ended', async () => {
  let t = T0;
  const s = setup({ now: () => t });
  const r = (await json(await s.api.reserve(post('reserve', reserveBody(A))))).body;
  await s.api.release(post('release', { wallet: A.qnet, reservation: 'f'.repeat(32) }));
  assert.equal(s.store.rows.size, 1, 'another reservation id releases nothing');
  await s.api.release(post('release', { wallet: A.qnet, reservation: r.reservation }));
  assert.equal(s.store.rows.size, 0);
  // A payment burn on its way, then final: its reservation id releases nothing.
  const p = await s.registry.reserve(payReserve(B));
  const tx = sig('kept');
  await s.registry.announcePayment(p.reservation, PAY.solana, 1500, tx, ownerBind(B, tx));
  await s.registry.release(B.qnet, p.reservation);
  assert.equal(s.store.rows.get(B.qnet).state, 'sending');
  s.solana.land(tx, { payer: PAY.solana, blockTime: Math.floor(t / 1000) });
  await s.registry.current(B.qnet);
  await s.registry.release(B.qnet, p.reservation);
  assert.equal(s.store.rows.get(B.qnet).state, 'recorded');
  // The sweep: a reservation an hour past its end goes; the record stays, however old.
  const q = await s.registry.reserve({ ...payReserve(A), way: 'extension', burner: A.solana, proof: reserveBody(A).proof });
  assert.ok(q.ok);
  t += RESERVATION_TTL_MS + 3_600_000 + 1;
  await s.store.sweep();
  assert.equal(s.store.rows.has(A.qnet), false);
  assert.equal(s.store.rows.get(B.qnet).state, 'recorded');
  assert.equal(SWEEP_EVERY_MS, 600_000);
});

test('the search of a wallet\'s Solana address: only its own burns count, oldest first; the budget and the cache', async () => {
  const solana = fakeSolana();
  const own = sig('scan-own');
  const later = sig('scan-later');
  const foreign = sig('scan-foreign');
  const odd = sig('scan-odd');
  solana.land(own, { payer: A.solana, memo: 'QNET_NODE_TYPE:SUPER' });
  solana.land(later, { payer: A.solana });
  solana.land(foreign, { payer: B.solana });
  solana.listed.set(A.solana, [
    { signature: later, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT' },
    { signature: foreign, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT' },
    { signature: sig('scan-transfer'), err: null, memo: null },
    { signature: own, err: null, memo: '[20] QNET_NODE_TYPE:SUPER' },
  ]);
  assert.deepEqual(await scanAddress(solana.rpc, A.solana), {
    complete: true, unusable: false, burns: [{ burnTx: own, nodeType: 'super', burnAmount: 1500 }, { burnTx: later, nodeType: 'light', burnAmount: 1500 }],
  });
  // A burn of its own with no Light or Super memo: unusable, and no code.
  solana.land(odd, { payer: A.solana, memo: 'QNET_NODE_TYPE:FULL' });
  solana.listed.set(A.solana, [{ signature: odd, err: null, memo: '[19] QNET_NODE_TYPE:FULL' }]);
  assert.deepEqual(await scanAddress(solana.rpc, A.solana), { complete: true, unusable: true, burns: [] });
  // A transfer it paid for that only carries the memo (a payment request can give one any memo) burned no 1DEV: no burn,
  // and it stops nothing, as in the extension's search. A 1DEV burn of its own in another form (inside another program's
  // call) is unusable.
  const memoOnly = sig('scan-memo-only');
  solana.txs.set(memoOnly, {
    status: { err: null, confirmationStatus: 'finalized' },
    tx: {
      slot: 101, blockTime: 1_790_000_001, meta: { err: null, innerInstructions: [] },
      transaction: { message: { accountKeys: [{ pubkey: A.solana, signer: true, writable: true }], instructions: [
        { program: 'system', parsed: { type: 'transfer', info: { source: A.solana, destination: B.solana, lamports: 5000 } } },
        { program: 'spl-memo', parsed: 'QNET_NODE_TYPE:LIGHT' },
      ] } },
    },
  });
  solana.listed.set(A.solana, [{ signature: memoOnly, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT' }]);
  assert.deepEqual(await scanAddress(solana.rpc, A.solana), { complete: true, unusable: false, burns: [] });
  const inner = sig('scan-inner');
  solana.land(inner, { payer: A.solana });
  const innerTx = solana.txs.get(inner).tx;
  innerTx.meta.innerInstructions = [{ index: 0, instructions: [innerTx.transaction.message.instructions[0]] }];
  innerTx.transaction.message.instructions = [{ program: 'spl-memo', parsed: 'QNET_NODE_TYPE:LIGHT' }];
  solana.listed.set(A.solana, [{ signature: memoOnly, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT' }, { signature: inner, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT' }]);
  assert.deepEqual(await scanAddress(solana.rpc, A.solana), { complete: true, unusable: true, burns: [] }, 'a 1DEV burn of its own inside another program');
  solana.setDown(true);
  assert.equal((await scanAddress(solana.rpc, A.solana)).complete, false);
  solana.setDown(false);
  // Kept per address; the server's budget, past which a search is not complete. Only a search that reads the marked
  // transactions (A's) or further pages takes one of the scarce budget; an address with no such history (B's) costs one
  // listing, counted against the larger list budget (SITE H-5).
  let t = 0;
  let asked = 0;
  const counting = async (method, params) => { if (method === 'getSignaturesForAddress') asked += 1; return solana.rpc(method, params); };
  const scanner = createBurnScanner({ rpc: counting, now: () => t, perMinute: 2 });
  await scanner(A.solana);
  await scanner(A.solana);
  assert.equal(asked, 1);
  await scanner(A.solana, 0);
  assert.equal(asked, 2, 'a fresh one when asked for');
  assert.deepEqual(await scanner(A.solana, 0), { complete: false, unusable: false, burns: [] }, 'past the budget');
  assert.equal((await scanner(B.solana)).complete, true, 'a search with no marked transaction takes nothing scarce');
  t += 60_000;
  assert.equal((await scanner(A.solana, 0)).complete, true);
  const listing = createBurnScanner({ rpc: solana.rpc, now: () => t, listPerMinute: 2 });
  await listing(B.solana, 0);
  await listing(B.solana, 0);
  assert.deepEqual(await listing(B.solana, 0), { complete: false, unusable: false, burns: [] }, 'past the list budget');
  // Audit M6: a reservation's search has a budget of its own; anonymous reads that spent theirs leave it whole, and its
  // finished search answers the page from the shared cache.
  const lanes = createBurnScanner({ rpc: solana.rpc, now: () => t, perMinute: 1 });
  await lanes(A.solana, 0, 'public');
  assert.equal((await lanes(A.solana, 0, 'public')).complete, false, 'the public lane is spent');
  assert.equal((await lanes(A.solana, 0, 'reserve')).complete, true, 'the reservation still searches');
  assert.equal((await lanes(A.solana, undefined, 'public')).complete, true, 'from the cache');
});

// SITE H-5: a QNet wallet costs nothing, so a signed request is no scarce thing. Each client the route names has its own
// share of each lane before a search takes anything of the server's, and only a search past the first listing takes a
// scarce place: many throwaway wallets from a few IP addresses leave the lane to everyone else.
test('a drain from many fresh wallets on a few IPs: each IP its share, nothing scarce for empty addresses, the lane stays open', async () => {
  const solana = fakeSolana();
  // A real wallet's own address with its burn, and busy addresses the attacker names (each with a marked transaction).
  const own = sig('h5-own');
  solana.land(own, { payer: A.solana });
  solana.listed.set(A.solana, [{ signature: own, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT' }]);
  const busy = Array.from({ length: 200 }, (_, i) => walletOf(`h5-busy-${i}`).solana);
  for (const [i, address] of busy.entries()) {
    const tx = sig(`h5-busy-tx-${i}`);
    solana.land(tx, { payer: B.solana });
    solana.listed.set(address, [{ signature: tx, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT' }]);
  }
  let t = 0;
  let calls = 0;
  const rpc = async (method, params) => { calls += 1; return solana.rpc(method, params); };
  const scanner = createBurnScanner({ rpc, now: () => t });
  assert.equal(CLIENT_SCANS_PER_MINUTE, 3);
  assert.equal(CLIENT_FULL_SCANS_PER_MINUTE, 1);
  assert.equal(SCANS_PER_MINUTE, 30);
  assert.equal(LIST_PER_MINUTE, 120);
  // Six IPs, each firing a hundred searches of fresh empty addresses and a hundred of busy ones in one minute.
  const ips = Array.from({ length: 6 }, (_, i) => `ip:198.51.100.${i + 1}`);
  let complete = 0;
  for (const ip of ips) {
    for (let i = 0; i < 100; i += 1) {
      if ((await scanner(walletOf(`h5-fresh-${ip}-${i}`).solana, 0, 'reserve', [ip])).complete) complete += 1;
      await scanner(busy[i % busy.length], 0, 'reserve', [ip]);
    }
  }
  assert.ok(complete <= ips.length * CLIENT_SCANS_PER_MINUTE, `${complete}`);
  // At most each IP's own share went to Solana: three listings and one full search per IP.
  assert.ok(calls <= ips.length * (CLIENT_SCANS_PER_MINUTE + CLIENT_FULL_SCANS_PER_MINUTE), `${calls}`);
  // A real user from another address in the same minute still searches its own address to the end.
  assert.deepEqual(await scanner(A.solana, 0, 'reserve', ['ip:203.0.113.77']), {
    complete: true, unusable: false, burns: [{ burnTx: own, nodeType: 'light', burnAmount: 1500 }],
  });
  // A client past its share is refused before any read; so is one key of several (the register client and its node).
  const before = calls;
  assert.equal((await scanner(walletOf('h5-late').solana, 0, 'reserve', [ips[0]])).complete, false);
  assert.equal(calls, before, 'no Solana read for a client past its share');
  for (let i = 0; i < 3; i += 1) await scanner(walletOf(`h5-node-${i}`).solana, 0, 'reserve', [`ip:203.0.113.${100 + i}`, 'node:light_mobile_0123456789abcdef']);
  assert.equal((await scanner(walletOf('h5-node-x').solana, 0, 'reserve', ['ip:203.0.113.200', 'node:light_mobile_0123456789abcdef'])).complete, false,
    'one node from many IPs: its own share');
  // The lanes stay apart: the page's lane is untouched by the signed lane's drain, and a minute later each share is back.
  assert.equal((await scanner(walletOf('h5-public').solana, 0, 'public', [ips[0]])).complete, true);
  t += 60_000;
  assert.equal((await scanner(walletOf('h5-next').solana, 0, 'reserve', [ips[0]])).complete, true);
});

// SITE H-5, the routes: the reservation does not sign the Solana address it names, so the page's own finished search of
// it (kept 5 minutes) answers the reservation; a new search is charged to the client. The register route charges the
// burner's search to its client and to the node.
test('the routes charge each search to its client; a reservation reuses the page\'s recent finished search', async () => {
  const solana = fakeSolana();
  let t = T0;
  const now = () => t;
  let listings = 0;
  const rpc = async (method, params) => { if (method === 'getSignaturesForAddress') listings += 1; return solana.rpc(method, params); };
  const scanner = createBurnScanner({ rpc, now });
  const store = createMemoryStore({ now, ttlMs: RESERVATION_TTL_MS });
  const registry = createActivationRegistry({ store, now, check: (burnTx, expect) => checkBurn(solana.rpc, burnTx, expect) });
  const api = createActivationApi({
    registry, now, scope: `h5${Math.random()}`, devOrigins: false, clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.5' }),
    walletNode: async () => ({ state: 'none' }), scan: scanner,
  });
  assert.equal(RESERVE_SCAN_MAX_AGE_MS, 300_000);
  // The page reads the wallet's record with its Solana address: one search, kept.
  const page = await json(await api.get(get(A.qnet, A.solana, { 'x-test-ip': '203.0.113.20' }), A.qnet));
  assert.equal(page.body.scan.complete, true);
  assert.equal(listings, 1);
  // Four minutes later the wallet reserves its payment address naming that address: no new search.
  t += 240_000;
  const pay = { way: 'payment', burner: PAY.solana, solana: A.solana };
  const held = await json(await api.reserve(post('reserve', reserveBody(A, pay, { time: Math.floor(t / 1000) }), { 'x-test-ip': '203.0.113.20' })));
  assert.equal(held.status, 200);
  assert.equal(listings, 1, 'the page\'s finished search answered the reservation');
  // Throwaway wallets from one IP naming fresh addresses: its share of the signed lane, then "not complete", nothing
  // more read; another client's reservation is not touched.
  const answers = [];
  for (let i = 0; i < 6; i += 1) {
    const w = walletOf(`h5-throwaway-${i}`);
    const body = reserveBody(w, { way: 'payment', burner: walletOf(`h5-pay-${i}`).solana, solana: walletOf(`h5-sol-${i}`).solana }, { time: Math.floor(t / 1000) });
    answers.push((await json(await api.reserve(post('reserve', body, { 'x-test-ip': '198.51.100.9' })))).status);
  }
  assert.deepEqual(answers, [200, 200, 200, 503, 503, 503]);
  assert.equal(listings, 1 + CLIENT_SCANS_PER_MINUTE);
  const other = await json(await api.reserve(post('reserve', reserveBody(B, { way: 'payment', burner: walletOf('h5-pay-b').solana, solana: B.solana }, { time: Math.floor(t / 1000) }), { 'x-test-ip': '203.0.113.21' })));
  assert.equal(other.status, 200);
  // The register route names its client and the node to the search.
  const register = read('server/cabinet/register.ts');
  assert.match(register, /return cabinetJson\(200, await ownBurn\(checked\.body as SubmitBody, \[\.\.\.\(client === null \? \[\] : \[client\]\), `node:\$\{id\}`\]\)\);/);
  assert.match(register, /await options\.scan\(body\.burn_wallet, clients\)/);
  assert.match(read('app/api/cabinet/register/route.ts'), /const scan: OwnBurnScan = \(address, clients\) => api\(\)\.scan\(address, undefined, 'reserve', clients\);/);
});

// Audit M5: a third party's memo transactions to the address no longer fill the cap of the address's own (the fee payer is
// checked first), older signatures are read page by page with `before`, and a search past its bounds says it is not
// complete instead of offering a burn.
test('the search pages with before, and only the address\'s own transactions count toward the cap', async () => {
  const solana = fakeSolana();
  const pages = [];
  const rpc = async (method, params) => {
    if (method === 'getSignaturesForAddress') {
      pages.push(params[1].before ?? null);
      const all = solana.listed.get(params[0]) ?? [];
      const from = params[1].before ? all.findIndex((s) => s.signature === params[1].before) + 1 : 0;
      return all.slice(from, from + params[1].limit);
    }
    return solana.rpc(method, params);
  };
  const filler = (n, tag) => Array.from({ length: n }, (_, i) => ({ signature: sig(`${tag}-${i}`), err: null, memo: null }));
  // Twelve memo transactions someone else paid for, then the address's own burn, oldest: found, and complete.
  const foreign = Array.from({ length: 12 }, (_, i) => sig(`m5-foreign-${i}`));
  for (const f of foreign) solana.land(f, { payer: B.solana });
  const own = sig('m5-own');
  solana.land(own, { payer: A.solana });
  solana.listed.set(A.solana, [...foreign.map((signature) => ({ signature, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT' })), { signature: own, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT' }]);
  assert.deepEqual(await scanAddress(rpc, A.solana), { complete: true, unusable: false, burns: [{ burnTx: own, nodeType: 'light', burnAmount: 1500 }] });
  // A history longer than one page: the next page is asked with `before`, and the burn on it is found.
  pages.length = 0;
  solana.listed.set(A.solana, [...filler(SIGNATURES_MAX, 'm5-page'), { signature: own, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT' }]);
  assert.deepEqual(await scanAddress(rpc, A.solana), { complete: true, unusable: false, burns: [{ burnTx: own, nodeType: 'light', burnAmount: 1500 }] });
  assert.deepEqual(pages, [null, sig(`m5-page-${SIGNATURES_MAX - 1}`)]);
  // Past the page bound: not complete.
  solana.listed.set(A.solana, filler(SIGNATURES_MAX * SIGNATURE_PAGES_MAX, 'm5-long'));
  assert.equal((await scanAddress(rpc, A.solana)).complete, false);
  // Past the read bound of marked transactions: not complete, whoever paid for them.
  const many = Array.from({ length: SCAN_READS_MAX + 1 }, (_, i) => sig(`m5-many-${i}`));
  for (const f of many) solana.land(f, { payer: B.solana });
  solana.listed.set(A.solana, many.map((signature) => ({ signature, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT' })));
  assert.equal((await scanAddress(rpc, A.solana)).complete, false);
  assert.equal(SIGNATURES_MAX, 1000);
  assert.equal(SIGNATURE_PAGES_MAX, 4);
  assert.equal(SCAN_READS_MAX, 30);
});

test('the PostgreSQL statements are the contract\'s single compare-and-set steps, and a row reads back', () => {
  const flat = (s) => s.replace(/\s+/g, ' ');
  assert.match(flat(SQL.reserve), /INSERT INTO cabinet_activations .* VALUES \(\$1, 'reserved', \$2, \$3, \$4, \$5, \$6, now\(\), now\(\) \+ interval '10 minutes', \$7\) ON CONFLICT \(wallet\) DO UPDATE SET/);
  assert.match(flat(SQL.reserve), /burn_tx = NULL, announced_at = NULL, proof = EXCLUDED\.proof/);
  assert.match(flat(SQL.reserve), /WHERE cabinet_activations\.state = 'reserved' AND cabinet_activations\.burn_tx IS NULL AND cabinet_activations\.expires_at < now\(\) RETURNING reservation, expires_at$/);
  assert.match(flat(SQL.byReservation), /^SELECT .* FROM cabinet_activations WHERE reservation = \$1$/);
  assert.match(flat(SQL.announce), /^UPDATE cabinet_activations SET state = 'sending', burn_tx = \$2, announced_at = now\(\), proof = \$3 WHERE reservation = \$1 AND state = 'reserved' AND burn_tx IS NULL AND expires_at > now\(\) AND way = \$4 AND burner = \$5 AND burn_amount = \$6$/);
  assert.match(flat(SQL.replace), /WHERE wallet = \$1 AND state = \$16 AND burn_tx IS NOT DISTINCT FROM \$17 AND reservation IS NOT DISTINCT FROM \$18 RETURNING wallet$/);
  assert.equal(flat(SQL.release), 'DELETE FROM cabinet_activations WHERE wallet = $1 AND reservation = $2 AND state = \'reserved\' AND burn_tx IS NULL');
  assert.equal(flat(SQL.sweep), 'DELETE FROM cabinet_activations WHERE state = \'reserved\' AND burn_tx IS NULL AND expires_at < now() - interval \'1 hour\'');
  for (const statement of Object.values(SQL)) assert.doesNotMatch(statement, /'burned'/);
  // Audit M7: every send and announce finds its row by the reservation alone; a unique partial index serves it.
  const index = readFileSync(new URL('../../../migrations/006_cabinet_activations_reservation.sql', import.meta.url), 'utf8');
  assert.match(index, /CREATE UNIQUE INDEX IF NOT EXISTS idx_cabinet_activations_reservation ON cabinet_activations \(reservation\) WHERE reservation IS NOT NULL;/);
  assert.match(index, /SET LOCAL lock_timeout = '5s';/);
  const migration = readFileSync(new URL('../../../migrations/005_cabinet_activations.sql', import.meta.url), 'utf8');
  for (const part of [/wallet TEXT PRIMARY KEY/, /state TEXT NOT NULL CHECK \(state IN \('reserved', 'sending', 'recorded'\)\)/, /burn_tx TEXT UNIQUE/,
    /burn_amount BIGINT NOT NULL CHECK \(burn_amount > 0\)/, /ON cabinet_activations \(expires_at\) WHERE state <> 'recorded'/,
    /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'explorer_reader'\) THEN\s+GRANT SELECT, INSERT, UPDATE, DELETE ON cabinet_activations TO explorer_reader;/,
    /reserved: the wallet's signed reservation \{pk, sig, time\}; extension burn: \{pk, sig, solanaSig\};/, /payment burn: \{pk, sig, time, ownerSig\}/]) {
    assert.match(migration, part);
  }
  assert.doesNotMatch(migration.replace(/--.*$/gm, ''), /\bip\b|_ip\b|\binet\b/i, 'no IP address is stored');
  const row = rowFrom({ wallet: A.qnet, state: 'recorded', node_type: 'light', way: 'extension', burner: A.solana, burn_amount: '1500', reservation: null,
    reserved_at: null, expires_at: null, burn_tx: 'x', announced_at: new Date(5), burn_slot: '77', burned_at: new Date(6), recorded_at: new Date(7), proof: { pk: 'p' } });
  assert.deepEqual(row, { wallet: A.qnet, state: 'recorded', nodeType: 'light', way: 'extension', burner: A.solana, burnAmount: 1500, reservation: null,
    reservedAt: null, expiresAt: null, burnTx: 'x', announcedAt: 5, burnSlot: 77, burnedAt: 6, recordedAt: 7, proof: { pk: 'p' } });
});

// Against a real database (a PostgreSQL the developer names): the same race through PgStore's one statement.
test('PgStore against TEST_DATABASE_URL: two reservations at once, one wins; every statement on a real database', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = (await import('pg')).default;
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `act_test_${Date.now()}`;
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    const sql = ['005_cabinet_activations.sql', '006_cabinet_activations_reservation.sql']
      .map((name) => readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8').replace(/SET LOCAL[^;]*;/g, '')).join('\n');
    const client = await pool.connect();
    await client.query(`SET search_path TO ${schema}`);
    await client.query(sql);
    client.release();
    const query = async (text, params) => {
      const c = await pool.connect();
      try {
        await c.query(`SET search_path TO ${schema}`);
        return await c.query(text, params);
      } finally {
        c.release();
      }
    };
    const store = createPgStore(query);
    const signed = reserveBody(A).proof;
    const input = (reservation) => ({ wallet: A.qnet, nodeType: 'light', way: 'extension', burner: A.solana, burnAmount: 1500, reservation, proof: signed });
    const got = await Promise.all([store.reserve(input('1'.repeat(32))), store.reserve(input('2'.repeat(32))), store.reserve(input('3'.repeat(32)))]);
    assert.equal(got.filter(Boolean).length, 1);
    const held = got.find(Boolean);
    assert.deepEqual((await store.get(A.qnet)).proof, signed);
    assert.equal((await store.byReservation(held.reservation)).wallet, A.qnet);
    const moved = await store.announce({ wallet: A.qnet, reservation: held.reservation, way: 'extension', burner: A.solana, burnAmount: 1500, burnTx: 'tx', proof: { pk: 'p' } });
    assert.equal(moved.wallet, A.qnet);
    assert.equal(await store.reserve(input('4'.repeat(32))), null, 'a burn on its way holds the wallet');
    assert.equal((await store.get(A.qnet)).state, 'sending');

    // Every other statement through the registry's rules on the real database: settle, insert, replace, release and
    // sweep, the unique burn, and the rows read back with their times.
    const t = Date.now();
    const nowS = Math.floor(t / 1000);
    const solana = fakeSolana();
    const registry = createActivationRegistry({ store, now: () => t, check: (burnTx, expect) => checkBurn(solana.rpc, burnTx, expect) });
    const view = async (w) => registry.view(w, await registry.current(w));
    await query('DELETE FROM cabinet_activations', []);
    // The extension's burn: reserved, announced with its proof, landed and final: recorded, with its slot and times.
    const r1 = await registry.reserve({ wallet: A.qnet, nodeType: 'super', way: 'extension', burner: A.solana, burnAmount: 1500, proof: reserveBody(A, { nodeType: 'super' }).proof });
    assert.ok(r1.ok);
    assert.equal(r1.until > Date.now(), true);
    const tx1 = sig('pg-ext');
    const f1 = { wallet: A.qnet, nodeType: 'super', burner: A.solana, burnTx: tx1, burnAmount: 1500 };
    const p1 = proofFor(A, f1);
    assert.equal((await registry.announceExtension(A.qnet, r1.reservation, tx1, p1)).ok, true);
    solana.land(tx1, { payer: A.solana, memo: 'QNET_NODE_TYPE:SUPER', slot: 4242, blockTime: 1_790_000_000 });
    const recorded = await view(A.qnet);
    assert.equal(recorded.state, 'recorded');
    assert.equal(recorded.code, activationCode('super', A.solana, tx1, 1500));
    const row1 = await store.get(A.qnet);
    assert.deepEqual([row1.burnSlot, row1.burnedAt, row1.expiresAt, typeof row1.recordedAt], [4242, 1_790_000_000_000, null, 'number']);
    assert.deepEqual(row1.proof, p1);
    // The same burner's older burn replaces it (one statement that compares the row first).
    const older = sig('pg-older');
    const fo = { ...f1, nodeType: 'light', burnTx: older };
    solana.land(older, { payer: A.solana, slot: 100 });
    const replaced = await registry.recordExtension(fo, proofFor(A, fo));
    assert.equal(replaced.ok, true);
    assert.equal((await store.get(A.qnet)).burnTx, older);
    assert.equal((await registry.recordExtension(f1, proofFor(A, f1))).error, 'other_burn');
    // A record with no row before it (an insert), and the unique burn: another wallet cannot take the same burn.
    const fb = { wallet: B.qnet, nodeType: 'light', burner: B.solana, burnTx: sig('pg-b'), burnAmount: 1500 };
    solana.land(fb.burnTx, { payer: B.solana, slot: 7, blockTime: null });
    assert.equal((await registry.recordExtension(fb, proofFor(B, fb))).ok, true);
    assert.equal((await store.get(B.qnet)).burnedAt, null);
    await query('DELETE FROM cabinet_activations WHERE wallet = $1', [B.qnet]);
    const stolen = { ...fo, wallet: B.qnet, burner: A.solana };
    assert.equal((await registry.recordExtension(stolen, proofFor(B, stolen, { edSeed: A.edSeed }))).error, 'other_burn', 'the burn is A\'s row already');
    // A payment burn: announced under its reservation with its owner bind, recorded once final, never released.
    const p = await registry.reserve(payReserve(B, PAY.solana, nowS));
    assert.ok(p.ok);
    const payTx = sig('pg-pay');
    assert.equal((await registry.announcePayment(p.reservation, PAY.solana, 1500, payTx, ownerBind(B, payTx))).ok, true);
    assert.equal((await registry.announcePayment(p.reservation, PAY.solana, 1500, sig('pg-pay-2'), ownerBind(B, sig('pg-pay-2')))).ok, false, 'one burn per reservation');
    solana.land(payTx, { payer: PAY.solana, blockTime: nowS });
    assert.equal((await view(B.qnet)).state, 'recorded');
    await registry.release(B.qnet, p.reservation);
    assert.equal((await store.get(B.qnet)).state, 'recorded');
    assert.equal((await store.get(B.qnet)).proof.ownerSig, ownerBind(B, payTx));
    // A reservation that ended an hour ago goes with the sweep; a record stays.
    const C = walletOf('pg-c');
    const q = await registry.reserve({ wallet: C.qnet, nodeType: 'light', way: 'extension', burner: C.solana, burnAmount: 1500, proof: reserveBody(C).proof });
    assert.ok(q.ok);
    await query("UPDATE cabinet_activations SET expires_at = now() - interval '2 hours' WHERE wallet = $1", [C.qnet]);
    await store.sweep();
    assert.equal(await store.get(C.qnet), null);
    assert.equal((await store.get(A.qnet)).state, 'recorded');
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  }
});
