// The node cabinet's door to Solana (src/server/cabinet/solana-proxy.ts, src/lib/cabinet/burn-tx.ts): /send
// forwards the cabinet's burn and refund signed by their payment address and refuses every other program, a second
// signer, a transfer from another account, a burn of another mint and another memo; a burn only under the wallet's
// reservation with the payment key's owner bind, announced in the activation registry before it leaves (R6, C4); the
// price is two nodes' agreed quote; the
// payment, blockhash and tx reads answer exact shapes. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {
  compileLegacyMessage, memo, parseLegacyTransaction, setComputeUnitLimit, setComputeUnitPrice, singleSignerWire, systemTransfer,
  tokenBurn, tokenCloseAccount, tokenTransfer, createAssociatedTokenAccountIdempotent,
} from '../solana-message.ts';
import { LIGHT_MEMO, burnInstructions, classifyCabinetTx, oneDevAccountOf, refundInstructions } from '../cabinet/burn-tx.ts';
import { ONE_DEV_MINT } from '../one-dev.ts';
import { activationCode } from '../qnet-link.ts';
import { agreedQuote } from '../activation-price.ts';
import {
  FINAL_TX_CACHE_MS, HEIGHT_CACHE_MS, OTHER_TX_READS, OWN_TX_READS, TX_CACHE_MS, createSolanaProxy, parseBurn, parsePaymentAccounts, readPassKey,
} from '../../server/cabinet/solana-proxy.ts';
import { CABINET_LIMITS } from '../../server/cabinet/limits.ts';
import { READ_PASS_RE } from '../cabinet/burn-tx.ts';
import { RpcError } from '../../server/solana-rpc.ts';
import { BACKOFF_MAX_MS, BACKOFF_START_MS, PUBLIC_RPC_URL, RpcBackoff, SEND_METHODS, accountBatcher, laneOf, solanaRpcUrl, withBackoff } from '../../server/solana-endpoint.ts';

const seed = (label) => createHash('sha256').update(label).digest();
const keyOf = (label) => ({ seed: seed(label), pub: bs58.encode(ed25519.getPublicKey(seed(label))) });
const PAYER = keyOf('guard-payer');
const OTHER = keyOf('guard-other');
const DEST = keyOf('guard-dest');
const BLOCKHASH = bs58.encode(seed('guard-blockhash'));
const OTHER_MINT = bs58.encode(seed('guard-mint'));

function signed(instructions, signers = [PAYER]) {
  const message = compileLegacyMessage(instructions, signers[0].pub, BLOCKHASH);
  const sigs = signers.map((s) => ed25519.sign(message, s.seed));
  if (sigs.length === 1) return singleSignerWire(sigs[0], message);
  return Uint8Array.from([sigs.length, ...sigs.flatMap((s) => [...s]), ...message]);
}
const shapeOf = (instructions, signers) => classifyCabinetTx(parseLegacyTransaction(signed(instructions, signers)));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

test('the burn shape: exactly the cabinet\'s burn, with or without the compute budget', () => {
  assert.deepEqual(shapeOf(burnInstructions(PAYER.pub, 1500)), { kind: 'burn', payer: PAYER.pub, whole: 1500 });
  assert.deepEqual(shapeOf(burnInstructions(PAYER.pub, 300).slice(2)), { kind: 'burn', payer: PAYER.pub, whole: 300 });
  const burn = (amount, account = oneDevAccountOf(PAYER.pub), mint = ONE_DEV_MINT, authority = PAYER.pub) => tokenBurn(account, mint, authority, amount);
  const note = memo(LIGHT_MEMO, PAYER.pub);
  const refused = {
    'another program': [burn(1_500_000_000n), note, { programId: OTHER_MINT, keys: [], data: Uint8Array.of(1) }],
    'a burn with a SOL transfer': [burn(1_500_000_000n), note, systemTransfer(PAYER.pub, OTHER.pub, 1_000n)],
    'another mint': [burn(1_500_000_000n, oneDevAccountOf(PAYER.pub), OTHER_MINT), note],
    'another account': [burn(1_500_000_000n, oneDevAccountOf(OTHER.pub)), note],
    'another memo': [burn(1_500_000_000n), memo('QNET_NODE_TYPE:SUPER', PAYER.pub)],
    'a memo text beside': [burn(1_500_000_000n), memo(`${LIGHT_MEMO} `, PAYER.pub)],
    'no memo': [burn(1_500_000_000n)],
    'two memos': [burn(1_500_000_000n), note, note],
    'not a whole 1DEV': [burn(1_500_000_001n), note],
    'above the bound': [burn(1_000_000_001_000_000n), note],
    'memo before the burn': [note, burn(1_500_000_000n)],
    'two prices': [setComputeUnitPrice(1n), setComputeUnitPrice(2n), burn(1_500_000_000n), note],
    'a huge price': [setComputeUnitPrice(1_000_001n), burn(1_500_000_000n), note],
    'too many units': [setComputeUnitLimit(200_001), burn(1_500_000_000n), note],
    'a budget in the middle': [burn(1_500_000_000n), setComputeUnitLimit(1000), note],
    'a token transfer out': [tokenTransfer(oneDevAccountOf(PAYER.pub), oneDevAccountOf(OTHER.pub), PAYER.pub, 1n)],
  };
  for (const [name, ixs] of Object.entries(refused)) assert.equal(shapeOf(ixs), null, name);
  // A second signer, even with the cabinet's own instructions.
  assert.equal(shapeOf([...burnInstructions(PAYER.pub, 1500), memo('x', OTHER.pub)], [PAYER, OTHER]), null);
});

test('the refund shape: one destination for everything, from the payment address\'s own accounts', () => {
  const plan = { oneDevRaw: 5n, accountExists: true, lamports: 5_000_000n, destAccountExists: false };
  const shape = shapeOf(refundInstructions(PAYER.pub, DEST.pub, plan));
  assert.equal(shape.kind, 'refund');
  assert.equal(shape.dest, DEST.pub);
  // The SOL alone is a refund too: the payment address's own SOL, to one address.
  assert.deepEqual(shapeOf([systemTransfer(PAYER.pub, DEST.pub, 1_000n)]), { kind: 'refund', payer: PAYER.pub, dest: DEST.pub, oneDevRaw: 0n, lamports: 1_000n });
  const src = oneDevAccountOf(PAYER.pub);
  const refused = {
    'two destinations': [tokenCloseAccount(src, DEST.pub, PAYER.pub), systemTransfer(PAYER.pub, OTHER.pub, 1_000n)],
    'a transfer from another account': [tokenTransfer(oneDevAccountOf(OTHER.pub), oneDevAccountOf(DEST.pub), PAYER.pub, 1n), tokenCloseAccount(src, DEST.pub, PAYER.pub)],
    'a transfer to an account that is not the destination\'s': [tokenTransfer(src, oneDevAccountOf(OTHER.pub), PAYER.pub, 1n), tokenCloseAccount(src, DEST.pub, PAYER.pub)],
    'a close of another account': [tokenCloseAccount(oneDevAccountOf(OTHER.pub), DEST.pub, PAYER.pub)],
    'to itself': [systemTransfer(PAYER.pub, PAYER.pub, 1_000n)],
    'an account created for someone else': [createAssociatedTokenAccountIdempotent(PAYER.pub, oneDevAccountOf(OTHER.pub), OTHER.pub, ONE_DEV_MINT), tokenTransfer(src, oneDevAccountOf(DEST.pub), PAYER.pub, 1n), tokenCloseAccount(src, DEST.pub, PAYER.pub)],
    'a create without a transfer': [createAssociatedTokenAccountIdempotent(PAYER.pub, oneDevAccountOf(DEST.pub), DEST.pub, ONE_DEV_MINT), tokenCloseAccount(src, DEST.pub, PAYER.pub)],
    'a zero transfer': [tokenTransfer(src, oneDevAccountOf(DEST.pub), PAYER.pub, 0n), tokenCloseAccount(src, DEST.pub, PAYER.pub)],
    'a transfer alone names no destination': [tokenTransfer(src, oneDevAccountOf(DEST.pub), PAYER.pub, 1n)],
    'a burn after it': [tokenCloseAccount(src, DEST.pub, PAYER.pub), tokenBurn(src, ONE_DEV_MINT, PAYER.pub, 1_000_000n)],
  };
  for (const [name, ixs] of Object.entries(refused)) assert.equal(shapeOf(ixs), null, name);
});

// ---------------------------------------------------------------- the routes

function fakeRpc(answers = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    const a = answers[method];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(params) : a;
  };
  return { rpc, calls };
}

let scopes = 0;
// The wallet's reservation a burn is sent under, the payment key's owner bind it carries, and the registry's announce,
// which checks the bind and holds it.
const R = 'a'.repeat(32);
const OS = 'c'.repeat(128);
const WALLET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
function proxy(answers, options = {}) {
  let t = 1_000_000;
  const net = fakeRpc(answers);
  const p = createSolanaProxy({
    rpc: net.rpc,
    now: () => t,
    clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.7' }),
    scope: `guard${(scopes += 1)}`,
    devOrigins: false,
    quote: async () => ({ phase: 1, cost: 1500 }),
    announce: async (reservation) => (reservation === R ? WALLET : null),
    ...options,
  });
  return { p, calls: net.calls, advance: (ms) => { t += ms; } };
}

const post = (body, headers = {}) => new Request('https://aiqnet.io/api/cabinet/send', {
  method: 'POST', headers: { host: 'aiqnet.io', 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (path, headers = {}) => new Request(`https://aiqnet.io${path}`, { headers: { host: 'aiqnet.io', ...headers } });
const json = async (res) => JSON.parse(await res.text());

test('/send forwards the cabinet\'s shapes only, validly signed, and meters the client and the payment address', async () => {
  const { p, calls } = proxy({ sendTransaction: 'sig' });
  const good = signed(burnInstructions(PAYER.pub, 1500));
  const res = await p.send(post({ tx: b64(good), reservation: R, ownerSig: OS }));
  assert.equal(res.status, 200);
  const answer = await json(res);
  assert.deepEqual(Object.keys(answer), ['state', 'pass']);
  assert.equal(answer.state, 'sent');
  assert.match(answer.pass, READ_PASS_RE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendTransaction');
  assert.equal(calls[0].params[0], b64(good));

  const forged = good.slice();
  forged[10] ^= 1;
  for (const [i, body] of [{ tx: b64(forged), reservation: R, ownerSig: OS }, { tx: b64(signed([tokenTransfer(oneDevAccountOf(OTHER.pub), oneDevAccountOf(DEST.pub), PAYER.pub, 1n), systemTransfer(PAYER.pub, DEST.pub, 1_000n)])) }, { tx: 'not base64!' }, { tx: b64(good), x: 1 }, { wire: b64(good) }, [b64(good)], { tx: b64(good), reservation: 'A'.repeat(32), ownerSig: OS },
    { tx: b64(good), reservation: R, ownerSig: OS.toUpperCase() }, { tx: b64(good), reservation: R, ownerSig: OS.slice(1) }, { tx: b64(good), reservation: R, ownerSig: OS, x: 1 }].entries()) {
    const r = await p.send(post(body, { 'x-test-ip': `203.0.113.${100 + i}` }));
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal(calls.length, 1, 'nothing else reached Solana');
  assert.equal((await p.send(post({ tx: b64(good), reservation: R, ownerSig: OS }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await p.send(new Request('https://aiqnet.io/api/cabinet/send', { method: 'POST', headers: { host: 'aiqnet.io', 'content-type': 'text/plain' }, body: '{}' }))).status, 415);

  // A refusal of the node (preflight) is reported as such; an unanswered send as unknown.
  const refusing = proxy({ sendTransaction: new RpcError(-32002, 'simulation failed') });
  assert.deepEqual(await json(await refusing.p.send(post({ tx: b64(good), reservation: R, ownerSig: OS }))), { state: 'refused' });
  const silent = proxy({ sendTransaction: new TypeError('fetch failed') });
  assert.equal((await json(await silent.p.send(post({ tx: b64(good), reservation: R, ownerSig: OS })))).state, 'unknown');

  // Five sends per payment address in ten minutes, whichever client sends them.
  const { p: q } = proxy({ sendTransaction: 'sig' });
  for (let i = 0; i < 5; i += 1) assert.equal((await q.send(post({ tx: b64(good), reservation: R, ownerSig: OS }, { 'x-test-ip': `198.51.100.${i}` }))).status, 200);
  assert.equal((await q.send(post({ tx: b64(good), reservation: R, ownerSig: OS }, { 'x-test-ip': '198.51.100.99' }))).status, 429);

  // SITE-2: junk naming a payment address (its burn's shape, a signature that is not its key's) spends nothing of
  // that address's budget, from however many clients: its own signed sends still go through.
  const { p: v } = proxy({ sendTransaction: 'sig' });
  for (let i = 0; i < 12; i += 1) assert.equal((await v.send(post({ tx: b64(forged), reservation: R, ownerSig: OS }, { 'x-test-ip': `192.0.2.${i}` }))).status, 400);
  for (let i = 0; i < 5; i += 1) assert.equal((await v.send(post({ tx: b64(good), reservation: R, ownerSig: OS }, { 'x-test-ip': `198.51.100.${i}` }))).status, 200, `send ${i}`);
});

// R6 and A2 (shared contracts C3.3 and C4): a burn is forwarded only after the registry announced it under the wallet's
// reservation, with the payer and whole amount of the burn itself and the payment key's v2 owner bind of the reserved
// wallet; a burn without the bind is refused; a refund needs neither, and carries neither.
test('/send refuses a burn without an announced reservation or its owner bind, and forwards a refund without them', async () => {
  const good = signed(burnInstructions(PAYER.pub, 1500));
  const announced = [];
  const { p, calls } = proxy({ sendTransaction: 'sig' }, {
    announce: async (reservation, burner, amount, burnTx, ownerSig) => {
      announced.push({ reservation, burner, amount, burnTx, ownerSig });
      if (ownerSig !== OS) return 'invalid_proof';
      return reservation === R ? WALLET : null;
    },
  });
  assert.deepEqual(await json(await p.send(post({ tx: b64(good) }))), { error: 'invalid_request' }, 'no reservation, no bind');
  assert.deepEqual(await json(await p.send(post({ tx: b64(good), reservation: R }))), { error: 'invalid_request' }, 'no bind');
  assert.deepEqual(await json(await p.send(post({ tx: b64(good), ownerSig: OS }))), { error: 'invalid_request' }, 'no reservation');
  assert.equal(announced.length, 0, 'the registry is not even asked');
  assert.equal((await p.send(post({ tx: b64(good), reservation: 'b'.repeat(32), ownerSig: OS }))).status, 409, 'a reservation the registry refuses');
  assert.deepEqual(await json(await p.send(post({ tx: b64(good), reservation: R, ownerSig: 'd'.repeat(128) }))), { error: 'invalid_proof' }, 'a bind that does not verify');
  assert.equal(calls.length, 0, 'nothing forwarded');
  assert.equal((await p.send(post({ tx: b64(good), reservation: R, ownerSig: OS }))).status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(announced.at(-1), { reservation: R, burner: PAYER.pub, amount: 1500, burnTx: bs58.encode(parseLegacyTransaction(good).signatures[0]), ownerSig: OS });
  // The registry cannot answer: unavailable, nothing forwarded; without an announcer at all, no burn leaves.
  const { p: down, calls: downCalls } = proxy({ sendTransaction: 'sig' }, { announce: async () => 'unavailable' });
  assert.deepEqual(await json(await down.send(post({ tx: b64(good), reservation: R, ownerSig: OS }))), { error: 'unavailable' });
  const { p: bare, calls: bareCalls } = proxy({ sendTransaction: 'sig' }, { announce: undefined });
  assert.equal((await bare.send(post({ tx: b64(good), reservation: R, ownerSig: OS }))).status, 409);
  assert.equal(downCalls.length + bareCalls.length, 0);
  // A refund goes without one, and with one it is refused.
  const refund = signed(refundInstructions(PAYER.pub, DEST.pub, { oneDevRaw: 5n, accountExists: true, lamports: 5_000_000n, destAccountExists: false }));
  assert.equal((await p.send(post({ tx: b64(refund) }))).status, 200);
  assert.equal((await p.send(post({ tx: b64(refund), reservation: R, ownerSig: OS }))).status, 400);
  assert.equal((await p.send(post({ tx: b64(refund), reservation: R }))).status, 400);
  assert.equal((await p.send(post({ tx: b64(refund), ownerSig: OS }))).status, 400);
  assert.equal(calls.length, 2);
});

test('/price is the quote two nodes agree on; one node alone, or two that differ, give none', async () => {
  const answer = (cost) => new Response(JSON.stringify({ phase: 1, node_type: 'light', cost, currency: '1DEV' }), { status: 200 });
  const nodes = ['https://a', 'https://b', 'https://c'];
  const by = (table) => async (url) => {
    const a = table[new URL(url).origin];
    if (a === undefined) throw new TypeError('down');
    return answer(a);
  };
  assert.deepEqual(await agreedQuote('light', by({ 'https://a': 1500, 'https://b': 1500, 'https://c': 900 }), nodes, () => 0), { phase: 1, cost: 1500 });
  assert.deepEqual(await agreedQuote('light', by({ 'https://a': 900, 'https://b': 1500, 'https://c': 1500 }), nodes, () => 0), { phase: 1, cost: 1500 });
  assert.equal(await agreedQuote('light', by({ 'https://a': 900, 'https://b': 1500, 'https://c': 700 }), nodes, () => 0), null);
  assert.equal(await agreedQuote('light', by({ 'https://a': 1500 }), nodes, () => 0), null);

  const { p } = proxy({});
  const res = await p.price(get('/api/cabinet/price'));
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { type: 'light', phase: 1, cost: 1500, currency: '1DEV' });
  const { p: none } = proxy({}, { quote: async () => null });
  assert.equal((await none.price(get('/api/cabinet/price'))).status, 503);
});

test('/payment reads the address and its own 1DEV account, exactly', async () => {
  const token = (owner, amount, mint = ONE_DEV_MINT) => ({ data: { parsed: { info: { mint, owner, tokenAmount: { amount } } } }, lamports: 2_039_280 });
  assert.deepEqual(parsePaymentAccounts({ value: [{ lamports: 2_000_000 }, token(PAYER.pub, '1500000000')] }, PAYER.pub), { sol: '2000000', oneDev: '1500000000', accountExists: true });
  assert.deepEqual(parsePaymentAccounts({ value: [null, null] }, PAYER.pub), { sol: '0', oneDev: '0', accountExists: false });
  for (const bad of [{ value: [] }, { value: [{ lamports: -1 }, null] }, { value: [null, token(OTHER.pub, '1')] }, { value: [null, token(PAYER.pub, '1', OTHER_MINT)] }, { value: [null, token(PAYER.pub, '01')] }, null]) {
    assert.equal(parsePaymentAccounts(bad, PAYER.pub), null);
  }
  const { p, calls } = proxy({ getMultipleAccounts: { value: [{ lamports: 5 }, null] } });
  const res = await p.payment(get(`/api/cabinet/payment/${PAYER.pub}`), PAYER.pub);
  assert.deepEqual(await json(res), { sol: '5', oneDev: '0', accountExists: false });
  assert.deepEqual(calls[0].params[0], [PAYER.pub, oneDevAccountOf(PAYER.pub)]);
  // Cached for three seconds per address.
  await p.payment(get(`/api/cabinet/payment/${PAYER.pub}`), PAYER.pub);
  assert.equal(calls.length, 1);
  assert.equal((await p.payment(get('/api/cabinet/payment/x'), 'x')).status, 400);
});

// A real devnet light burn (the mobile app's fixture): its code is known.
const DEVNET_BURN = {
  meta: { err: null },
  transaction: {
    message: {
      accountKeys: [{ pubkey: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR', signer: true, writable: true }],
      instructions: [
        { parsed: { info: { account: '9CZ6SkAcW7iAp3WVgwi1TVtm9qnF7gYKzeE2Z6NdXqD1', amount: '1500000000', authority: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR', mint: ONE_DEV_MINT }, type: 'burn' }, program: 'spl-token' },
        { parsed: 'QNET_NODE_TYPE:LIGHT', program: 'spl-memo' },
      ],
    },
  },
};
const DEVNET_SIG = 'nqh74heddHDKQbzTqJAmu6o8VZEyBbdsfJcDJTtfPCYgTmGagX2xsrdZhkKFKBGFHyEq6tyNFrgZWrbTatq8Ywx';

test('a finalized burn is read as its burner, amount and node type, and gives the code its wallet gave', () => {
  const burn = parseBurn(DEVNET_BURN);
  assert.deepEqual(burn, { payer: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR', amount: 1500, nodeType: 'light', slot: null, blockTime: null });
  assert.equal(activationCode('light', burn.payer, DEVNET_SIG, burn.amount), 'QNET-LFEFD9-706058-537636');
  const change = (f, expected = null) => { const c = structuredClone(DEVNET_BURN); f(c); return parseBurn(c, expected); };
  assert.equal(change((c) => { c.meta.err = { InstructionError: [0, 'x'] }; }), null);
  // A super node's burn, and the light-only read of /tx that refuses it.
  assert.equal(change((c) => { c.transaction.message.instructions[1].parsed = 'QNET_NODE_TYPE:SUPER'; }).nodeType, 'super');
  assert.equal(change((c) => { c.transaction.message.instructions[1].parsed = 'QNET_NODE_TYPE:SUPER'; }, 'light'), null);
  assert.equal(change((c) => { c.transaction.message.instructions[1].parsed = 'QNET_NODE_TYPE:FULL'; }), null);
  assert.equal(change((c) => { c.transaction.message.accountKeys[0].signer = false; }), null, 'the fee payer signed');
  assert.deepEqual(change((c) => { c.slot = 99; c.blockTime = 1_790_000_000; }), { ...burn, slot: 99, blockTime: 1_790_000_000_000 });
  assert.equal(change((c) => { c.transaction.message.instructions.pop(); }), null);
  assert.equal(change((c) => { c.transaction.message.instructions[0].parsed.info.mint = OTHER_MINT; }), null);
  assert.equal(change((c) => { c.transaction.message.instructions[0].parsed.info.authority = OTHER.pub; }), null);
  assert.equal(change((c) => { c.transaction.message.instructions[0].parsed.info.amount = '1500000001'; }), null);
  assert.deepEqual(change((c) => { c.transaction.message.instructions[0].parsed = { type: 'burnChecked', info: { ...c.transaction.message.instructions[0].parsed.info, amount: undefined, tokenAmount: { amount: '300000000' } } }; }), { ...burn, amount: 300 });
});

test('/tx: pending, expired past its blockhash (looked at twice), failed, finalized with the burn it holds', async () => {
  const sig = DEVNET_SIG;
  let status = null;
  let height = 100;
  const { p, calls, advance } = proxy({
    getSignatureStatuses: () => ({ value: [status] }),
    getBlockHeight: () => height,
    getTransaction: () => DEVNET_BURN,
  });
  const read = async (lvh = '150') => json(await p.tx(get(`/api/cabinet/tx/${sig}?lvh=${lvh}`), sig, lvh));
  assert.deepEqual(await read(), { state: 'pending' });
  advance(3000);
  height = 151;
  assert.deepEqual(await read(), { state: 'expired' });
  assert.equal(calls.filter((c) => c.method === 'getSignatureStatuses').length, 3);
  advance(3000);
  status = { err: { x: 1 }, confirmationStatus: 'confirmed' };
  assert.deepEqual(await read(), { state: 'failed' });
  advance(3000);
  status = { err: null, confirmationStatus: 'confirmed' };
  assert.deepEqual(await read(), { state: 'confirmed' });
  advance(3000);
  status = { err: null, confirmationStatus: 'finalized' };
  assert.deepEqual(await read(), { state: 'finalized', burn: { payer: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR', amount: 1500 } });
  for (const [s, lvh] of [['x', null], [sig, '-1'], [sig, '1.5'], [sig, '01x']]) {
    assert.equal((await p.tx(get('/api/cabinet/tx/x'), s, lvh)).status, 400, `${s} ${lvh}`);
  }
});

// SITE-6: every activating page reads Solana through the one site server. The endpoint is a server setting, balance
// reads of many pages go out as one call, and a 429 makes the server back off instead of adding to the count.
test('the Solana endpoint: a server setting, one call for many balance reads, a back-off after 429', async () => {
  assert.equal(solanaRpcUrl({}), PUBLIC_RPC_URL);
  assert.equal(solanaRpcUrl({ SOLANA_RPC_URL: ' https://devnet.rpc.example/k3y ' }), 'https://devnet.rpc.example/k3y');
  assert.equal(solanaRpcUrl({ SOLANA_RPC_URL: 'http://127.0.0.1:8899' }), 'http://127.0.0.1:8899/');
  for (const bad of ['http://rpc.example', 'https://user:pw@rpc.example', 'not a url', 'ftp://rpc.example']) assert.equal(solanaRpcUrl({ SOLANA_RPC_URL: bad }), PUBLIC_RPC_URL, bad);

  // Two pages' reads within the window: one getMultipleAccounts, each page its own two accounts.
  const net = fakeRpc({ getMultipleAccounts: (params) => ({ value: params[0].map((k) => ({ lamports: k.length })) }) });
  const read = accountBatcher(net.rpc, { windowMs: 5 });
  const [a, b] = await Promise.all([read(['a1', 'a22']), read(['b333', 'b4444'])]);
  assert.deepEqual([a, b], [[{ lamports: 2 }, { lamports: 3 }], [{ lamports: 4 }, { lamports: 5 }]]);
  assert.equal(net.calls.length, 1);
  assert.deepEqual(net.calls[0].params[0], ['a1', 'a22', 'b333', 'b4444']);
  // More accounts than one call takes: split between callers, never within one.
  const many = accountBatcher(net.rpc, { windowMs: 5, maxAccounts: 4 });
  await Promise.all([many(['c1', 'c2']), many(['d1', 'd2']), many(['e1', 'e2'])]);
  assert.deepEqual(net.calls.slice(1).map((c) => c.params[0]), [['c1', 'c2', 'd1', 'd2'], ['e1', 'e2']]);
  // A malformed answer fails every caller of that call.
  const short = accountBatcher(fakeRpc({ getMultipleAccounts: { value: [null] } }).rpc, { windowMs: 5 });
  await assert.rejects(short(['x', 'y']), /rpc_malformed_accounts/);

  // A 429: the next calls fail at once for the back-off, which doubles, and a success resets it; one line each time.
  let t = 0;
  const lines = [];
  let answer = new Error('rpc_http_429');
  let asked = 0;
  const backed = withBackoff(async () => { asked += 1; if (answer instanceof Error) throw answer; return answer; }, { now: () => t, log: (l) => lines.push(l) });
  await assert.rejects(backed('getBlockHeight', []), /rpc_http_429/);
  await assert.rejects(backed('getBlockHeight', []), RpcBackoff);
  assert.equal(asked, 1);
  t += BACKOFF_START_MS;
  await assert.rejects(backed('getBlockHeight', []), /rpc_http_429/);
  t += BACKOFF_START_MS;
  await assert.rejects(backed('getBlockHeight', []), RpcBackoff, 'the second back-off is twice as long');
  t += BACKOFF_START_MS;
  answer = 7;
  assert.equal(await backed('getBlockHeight', []), 7);
  assert.deepEqual(lines, [`[WARN][SOLANA] rpc_rate_limited lane=read backoff_ms=${BACKOFF_START_MS}`, `[WARN][SOLANA] rpc_rate_limited lane=read backoff_ms=${BACKOFF_START_MS * 2}`]);
  assert.ok(BACKOFF_MAX_MS <= 30_000);

  // The cabinet's routes and the faucet use the shared client; no page carries the endpoint.
  const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  assert.match(src('server/cabinet/solana-proxy.ts'), /const rpc = options\.rpc \?\? sharedSolanaRpc\(\);/);
  assert.match(src('app/api/faucet/claim/route.ts'), /const rpc = sharedSolanaRpc\(\);/);
  assert.doesNotMatch(src('lib/one-dev.ts'), /api\.devnet\.solana\.com|RPC_URL/);
  // The activation page polls the funding no faster than every 5 s, and at once when shown again.
  const page = src('components/cabinet/NodeActivate.tsx');
  const funding = Number(/funding: (\d[\d_]*),/.exec(page)[1].replace(/_/g, ''));
  assert.ok(funding >= 5_000, `${funding}`);
  assert.match(page, /if \(document\.visibilityState === 'visible'\) run\(\);/);
});

// SITE-R2-08: one process-wide client backed off for everyone after any 429, and reads of made-up signatures cost one to
// three calls each, so a script reading random signatures from many addresses could make the endpoint answer 429 and
// stop every visitor's sends and reads. Sends now back off apart from reads, and reads of signatures this server did
// not forward share a small budget a second; a page's reads of its own transactions are never held back.
test('reads cannot stop sends, and reads of signatures the site never sent share a small budget', async () => {
  // A 429 on a read backs off the reads only; a send still goes, and a 429 on a send backs off the sends only.
  let t = 0;
  const lines = [];
  const failing = new Set(['getSignatureStatuses']);
  const asked = [];
  const backed = withBackoff(async (method) => {
    asked.push(method);
    if (failing.has(method)) throw new Error('rpc_http_429');
    return 'ok';
  }, { now: () => t, log: (l) => lines.push(l) });
  await assert.rejects(backed('getSignatureStatuses', []), /rpc_http_429/);
  await assert.rejects(backed('getMultipleAccounts', []), RpcBackoff, 'every read backs off');
  assert.equal(await backed('sendTransaction', []), 'ok');
  assert.equal(await backed('getLatestBlockhash', []), 'ok');
  failing.add('sendTransaction');
  await assert.rejects(backed('sendTransaction', []), /rpc_http_429/);
  await assert.rejects(backed('getLatestBlockhash', []), RpcBackoff);
  t += BACKOFF_START_MS;
  failing.clear();
  assert.equal(await backed('getBlockHeight', []), 'ok');
  assert.deepEqual(lines, [`[WARN][SOLANA] rpc_rate_limited lane=read backoff_ms=${BACKOFF_START_MS}`, `[WARN][SOLANA] rpc_rate_limited lane=send backoff_ms=${BACKOFF_START_MS}`]);
  assert.deepEqual([...SEND_METHODS], ['sendTransaction', 'getLatestBlockhash']);
  assert.equal(laneOf('getTransaction'), 'read');

  // Made-up signatures from many clients within one second: OTHER_TX_READS.max of them reach Solana, the rest are
  // answered unavailable without a call.
  const { p, calls, advance } = proxy({ sendTransaction: 'sig', getSignatureStatuses: { value: [null] } });
  const made = Array.from({ length: 10 }, (_, i) => bs58.encode(Buffer.concat([seed(`made-up-${i}`), seed(`more-${i}`)])));
  const statuses = [];
  for (const [i, s] of made.entries()) statuses.push((await p.tx(get(`/api/cabinet/tx/${s}`, { 'x-test-ip': `198.51.100.${i}` }), s, null)).status);
  assert.deepEqual(statuses, [200, 200, ...Array(8).fill(503)]);
  assert.equal(calls.filter((c) => c.method === 'getSignatureStatuses').length, OTHER_TX_READS.max);
  // The page's own burn, forwarded by this server, is read all the same within that second, with its read pass.
  const good = signed(burnInstructions(PAYER.pub, 1500));
  const { pass } = await json(await p.send(post({ tx: b64(good), reservation: R, ownerSig: OS })));
  const own = bs58.encode(parseLegacyTransaction(good).signatures[0]);
  assert.deepEqual(await json(await p.tx(get(`/api/cabinet/tx/${own}`), own, null, pass)), { state: 'pending' });
  // The next second the budget is back.
  advance(OTHER_TX_READS.windowMs);
  assert.equal((await p.tx(get(`/api/cabinet/tx/${made[9]}`, { 'x-test-ip': '198.51.100.77' }), made[9], null)).status, 200);
  assert.deepEqual(OTHER_TX_READS, { max: 2, windowMs: 1_000 });
});

// SITE-R3-01: the reads exempt from that budget were those of signatures in a list in the server's memory, which every
// restart emptied, which anyone could fill with 50,000 fresh keys' burns before they were even sent, and one client could
// use up the whole budget. A page's own reads now carry a read pass, an HMAC of the signature under the server's key,
// which outlives a restart and needs no list; a refused send earns none; and each client gets its own share of the rest.
test('SITE-R3-01: the read pass outlives a restart and no list; one client cannot use up the budget of other signatures', async () => {
  const key = readPassKey('11'.repeat(32));
  assert.deepEqual([...key], Array(32).fill(0x11));
  assert.equal(readPassKey('11'.repeat(31)).length, 32, 'too short: a key of the process');
  assert.notDeepEqual([...readPassKey(undefined)], [...readPassKey(undefined)]);
  const good = signed(burnInstructions(PAYER.pub, 1500));
  const own = bs58.encode(parseLegacyTransaction(good).signatures[0]);
  const net = { sendTransaction: 'sig', getSignatureStatuses: { value: [null] } };
  const before = proxy(net, { readKey: key });
  const { pass } = await json(await before.p.send(post({ tx: b64(good), reservation: R, ownerSig: OS })));
  assert.match(pass, READ_PASS_RE);
  // A restart: a new process with the same key. The budget of other signatures is spent; the pass still reads.
  const after = proxy(net, { readKey: key });
  const made = Array.from({ length: OTHER_TX_READS.max }, (_, i) => bs58.encode(Buffer.concat([seed(`spent-${i}`), seed(`spent2-${i}`)])));
  for (const [i, s] of made.entries()) assert.equal((await after.p.tx(get('/x', { 'x-test-ip': `198.51.100.${i}` }), s, null)).status, 200);
  assert.equal((await after.p.tx(get('/x', { 'x-test-ip': '198.51.100.99' }), own, null)).status, 503, 'without its pass it waits like any other');
  assert.equal((await after.p.tx(get('/x'), own, null, pass)).status, 200, 'with it: read at once');
  // A pass is good for its own signature under this key only; a malformed one is refused.
  const third = bs58.encode(Buffer.concat([seed('third'), seed('third2')]));
  assert.equal((await after.p.tx(get('/x', { 'x-test-ip': '198.51.100.98' }), third, null, pass)).status, 503, 'another signature');
  const other = proxy(net, { readKey: readPassKey('22'.repeat(32)) });
  for (const [i, s] of made.entries()) await other.p.tx(get('/x', { 'x-test-ip': `198.51.100.${40 + i}` }), s, null);
  assert.equal((await other.p.tx(get('/x', { 'x-test-ip': '198.51.100.96' }), own, null, pass)).status, 503, 'another key');
  assert.equal((await after.p.tx(get('/x'), own, null, 'not a pass')).status, 400);
  // A send the endpoint refused cost nothing, and earns no pass.
  const refusing = proxy({ sendTransaction: () => { throw new RpcError(-32002, 'x'); } }, { readKey: key });
  assert.deepEqual(await json(await refusing.p.send(post({ tx: b64(good), reservation: R, ownerSig: OS }))), { state: 'refused' });
  // The server keeps no list of what it sent.
  const src = readFileSync(new URL('../../server/cabinet/solana-proxy.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /forwarded|FORWARDED_KEPT|new Map/);

  // One client reading made-up signatures gets its share a minute, never the whole budget: another client still reads.
  const one = proxy({ getSignatureStatuses: { value: [null] } });
  const statuses = [];
  for (let i = 0; i < CABINET_LIMITS.txOther.max + 3; i += 1) {
    const s = bs58.encode(Buffer.concat([seed(`one-${i}`), seed(`one2-${i}`)]));
    statuses.push((await one.p.tx(get('/x', { 'x-test-ip': '203.0.113.50' }), s, null)).status);
    one.advance(OTHER_TX_READS.windowMs);
  }
  assert.deepEqual(statuses, [...Array(CABINET_LIMITS.txOther.max).fill(200), 503, 503, 503]);
  const next = bs58.encode(Buffer.concat([seed('two'), seed('two2')]));
  assert.equal((await one.p.tx(get('/x', { 'x-test-ip': '203.0.113.51' }), next, null)).status, 200);
  // A client past its share spent nothing of the server's budget: only the reads within shares reached Solana.
  assert.equal(one.calls.filter((c) => c.method === 'getSignatureStatuses').length, CABINET_LIMITS.txOther.max + 1);
  assert.ok(CABINET_LIMITS.txOther.max * 5 <= OTHER_TX_READS.max * 60, 'a share is at most a fifth of the budget a minute');
  assert.deepEqual(CABINET_LIMITS.txOther, { max: 12, windowMs: 60_000 });
});

// SITE M-14: a pass holder asking with a new `lvh` each time missed the cache and skipped every budget. The status by
// signature, the block height and a finalized transaction are kept apart, the lvh-dependent state is worked out here,
// reads with a pass share OWN_TX_READS, and a refund earns a pass only from a payment address a reservation named.
test('M-14: a new lvh costs no Solana read, pass holders share a budget, and a refund earns a pass only from a known payment address', async () => {
  const methods = (calls, m) => calls.filter((c) => c.method === m).length;
  // Each read from a client of its own (one client's route limit is not what is tested here).
  const at = (lvh) => get(`/x?lvh=${lvh}`, { 'x-test-ip': `10.${Math.floor(lvh / 250)}.${lvh % 250}.1` });
  // A pending burn, read with its pass and 100 different lvh values: one status read and one height read in all.
  let status = null;
  const { p, calls, advance } = proxy({ sendTransaction: 'sig', getSignatureStatuses: () => ({ value: [status] }), getBlockHeight: () => 100, getTransaction: () => DEVNET_BURN });
  const good = signed(burnInstructions(PAYER.pub, 1500));
  const own = bs58.encode(parseLegacyTransaction(good).signatures[0]);
  const { pass } = await json(await p.send(post({ tx: b64(good), reservation: R, ownerSig: OS })));
  for (let lvh = 1000; lvh < 1100; lvh += 1) {
    assert.deepEqual(await json(await p.tx(at(lvh), own, String(lvh), pass)), { state: 'pending' });
  }
  assert.equal(methods(calls, 'getSignatureStatuses'), 1);
  assert.equal(methods(calls, 'getBlockHeight'), 1);
  // Past its last valid block for some lvh values: still worked out from the kept height, one second look per signature.
  for (let lvh = 0; lvh < 100; lvh += 1) await p.tx(at(lvh), own, String(lvh), pass);
  assert.equal(methods(calls, 'getBlockHeight'), 1);
  assert.equal(methods(calls, 'getSignatureStatuses'), 2);
  // Finalized: 100 more lvh values read the transaction once, and it is kept long after the status moved on.
  advance(TX_CACHE_MS);
  status = { err: null, confirmationStatus: 'finalized' };
  for (let lvh = 2000; lvh < 2100; lvh += 1) {
    assert.deepEqual(await json(await p.tx(at(lvh), own, String(lvh), pass)), { state: 'finalized', burn: { payer: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR', amount: 1500 } });
  }
  assert.equal(methods(calls, 'getSignatureStatuses'), 3);
  assert.equal(methods(calls, 'getTransaction'), 1);
  advance(FINAL_TX_CACHE_MS / 2);
  await p.tx(get('/x'), own, '7', pass);
  assert.equal(methods(calls, 'getTransaction'), 1, 'a finalized transaction never changes');
  assert.ok(FINAL_TX_CACHE_MS >= 3_600_000 && TX_CACHE_MS === 2_000 && HEIGHT_CACHE_MS === 2_000);

  // Many pass holders in one second: only OWN_TX_READS.max of their reads reach Solana, the rest wait like any other.
  const many = proxy({ sendTransaction: 'sig', getSignatureStatuses: { value: [null] } });
  const passes = [];
  for (let i = 0; i < OWN_TX_READS.max + 5; i += 1) {
    const payer = keyOf(`m14-payer-${i}`);
    const tx = signed(burnInstructions(payer.pub, 1500), [payer]);
    const sent = await json(await many.p.send(post({ tx: b64(tx), reservation: R, ownerSig: OS }, { 'x-test-ip': `198.51.100.${i}` })));
    passes.push([bs58.encode(parseLegacyTransaction(tx).signatures[0]), sent.pass]);
  }
  const answers = [];
  for (const [s, ps] of passes) answers.push((await many.p.tx(get('/x'), s, null, ps)).status);
  assert.deepEqual(answers, [...Array(OWN_TX_READS.max).fill(200), ...Array(5).fill(503)]);
  assert.equal(methods(many.calls, 'getSignatureStatuses'), OWN_TX_READS.max);
  many.advance(OWN_TX_READS.windowMs);
  assert.equal((await many.p.tx(get('/x'), passes.at(-1)[0], null, passes.at(-1)[1])).status, 200, 'the next second the budget is back');
  assert.ok(OWN_TX_READS.max > OTHER_TX_READS.max);

  // A refund: a pass only when a reservation of this site named its payer as a payment address.
  const refund = signed(refundInstructions(PAYER.pub, DEST.pub, { oneDevRaw: 5n, accountExists: true, lamports: 5_000_000n, destAccountExists: false }));
  const named = [];
  const known = proxy({ sendTransaction: 'sig' }, { knownPayer: async (payer) => { named.push(payer); return payer === PAYER.pub; } });
  assert.match((await json(await known.p.send(post({ tx: b64(refund) })))).pass, READ_PASS_RE);
  assert.deepEqual(named, [PAYER.pub]);
  const unknown = proxy({ sendTransaction: 'sig' }, { knownPayer: async () => false });
  assert.deepEqual(await json(await unknown.p.send(post({ tx: b64(refund) }))), { state: 'sent' });
  const down = proxy({ sendTransaction: 'sig' }, { knownPayer: async () => { throw new Error('db down'); } });
  assert.deepEqual(await json(await down.p.send(post({ tx: b64(refund) }))), { state: 'sent' }, 'a registry that cannot answer gives none');
  const bare = proxy({ sendTransaction: 'sig' });
  assert.deepEqual(await json(await bare.p.send(post({ tx: b64(refund) }))), { state: 'sent' }, 'without the registry, none');
  const route = readFileSync(new URL('../../app/api/cabinet/send/route.ts', import.meta.url), 'utf8');
  assert.match(route, /\(payer\) => api\.knowsPaymentBurner\(payer\),/);
});

test('/blockhash is the latest, cached two seconds', async () => {
  const { p, calls, advance } = proxy({ getLatestBlockhash: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 42 } } });
  assert.deepEqual(await json(await p.blockhash(get('/api/cabinet/blockhash'))), { blockhash: BLOCKHASH, lastValidBlockHeight: 42 });
  await p.blockhash(get('/api/cabinet/blockhash'));
  assert.equal(calls.length, 1);
  advance(2001);
  await p.blockhash(get('/api/cabinet/blockhash'));
  assert.equal(calls.length, 2);
});
