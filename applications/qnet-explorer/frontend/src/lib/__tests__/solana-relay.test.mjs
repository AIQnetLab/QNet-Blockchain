// The wallets' Solana relay (src/server/cabinet/solana-relay.ts, src/lib/wallet-solana-tx.ts, POST /api/cabinet/solana):
// QNet Wallet and the QNet extension send it the very JSON-RPC call their Solana endpoint did not answer. Every
// transaction shape the wallets build goes on exactly as signed, the extension's activation burn only once the
// registry announced it; any other transaction, method, param or envelope is refused without a Solana call; reads
// are cached and batched for every client, in caches of a fixed bound; each client gets under half of each of the
// server's lanes; the origins are the activation routes'; the endpoint's refusals and its exact integers come back as
// the endpoint gave them.
// Run: npm run test:wallet

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {
  MEMO_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, compileLegacyMessage, createAssociatedTokenAccountIdempotent, memo,
  parseLegacyMessage, parseLegacyTransaction, setComputeUnitPrice, signaturesValid, systemTransfer, tokenBurn,
} from '../solana-message.ts';
import { NODE_TYPE_MEMO, burnInstructions, oneDevAccountOf, refundInstructions } from '../cabinet/burn-tx.ts';
import { ONE_DEV_MINT } from '../one-dev.ts';
import { REFERENCES_MAX, REQUEST_MEMO_MAX_BYTES, classifyWalletTx } from '../wallet-solana-tx.ts';
import { BLOCKHASH_CACHE_MS, FINAL_TX_CACHE_MS, PAYMENT_CACHE_MS, TX_CACHE_MS, createSolanaProxy } from '../../server/cabinet/solana-proxy.ts';
import {
  ACCOUNT_DATA_MAX, ACCOUNT_SLICE_BYTES, FAILED_SHARED_MS, KEEP_MAX_CHARS, LARGE_ENTRIES, RELAY_BODY_MAX_BYTES, RELAY_TX_ENTRIES, RENT_CACHE_MS,
  SHORT_LISTING_MAX, SIGNATURES_LIMIT_MAX, SUPPLY_CACHE_MS,
} from '../../server/cabinet/solana-relay.ts';
import { memo as cacheMemo } from '../../server/cabinet/cache.ts';
import { CABINET_LIMITS, CLIENT_BUDGETS, KEYED_LIMITS } from '../../server/cabinet/limits.ts';
import { UPSTREAM_BUDGETS, createUpstreamBudget, unbudgeted } from '../../server/cabinet/upstream.ts';
import { RpcError, solanaRpc } from '../../server/solana-rpc.ts';
import { withBackoff } from '../../server/solana-endpoint.ts';
import { b64, fakeRpc, keyOf, seed, signedWith } from './solana-helpers.mjs';
import { code, read, repo } from './source.mjs';

const PAYER = keyOf('relay-payer');
const TO = keyOf('relay-to');
const SECOND = keyOf('relay-second');
const OTHER_MINT = bs58.encode(seed('relay-mint'));
// Another 1DEV account of the payer (the app spends from its fullest one when the associated one lacks the amount).
const SOURCE = bs58.encode(seed('relay-source'));
const REFS = Array.from({ length: REFERENCES_MAX + 1 }, (_, i) => keyOf(`relay-ref-${i}`).pub);
const BLOCKHASH = bs58.encode(seed('relay-blockhash'));
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// ---------------------------------------------------------------- the wallets' instructions

const ro = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const u64 = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return [...b];
};
// A payment request's memo, no account listed (both wallets).
const requestMemo = (text) => ({ programId: MEMO_PROGRAM_ID, keys: [], data: typeof text === 'string' ? new TextEncoder().encode(text) : text });
// System Transfer from the payer, then the request's references read-only.
const solTo = (to, lamports, refs = []) => {
  const ix = systemTransfer(PAYER.pub, to, lamports);
  ix.keys.push(...refs.map(ro));
  return ix;
};
// TransferChecked: [source (w), mint, destination (w), the payer (signer)], then the references.
const checked = ({ source = oneDevAccountOf(PAYER.pub), to = TO.pub, destination = oneDevAccountOf(to), amount = 1_500_000n, refs = [], mint = ONE_DEV_MINT, decimals = 6, program = TOKEN_PROGRAM_ID } = {}) => ({
  programId: program,
  keys: [{ pubkey: source, isSigner: false, isWritable: true }, ro(mint), { pubkey: destination, isSigner: false, isWritable: true }, { pubkey: PAYER.pub, isSigner: true, isWritable: false }, ...refs.map(ro)],
  data: Uint8Array.from([12, ...u64(amount), decimals]),
});
const createFor = (owner, account = oneDevAccountOf(owner)) => createAssociatedTokenAccountIdempotent(PAYER.pub, account, owner, ONE_DEV_MINT);
// The extension's activation burn: Burn from the payer's 1DEV account, then the node type's memo the payer signs.
const burnOf = (whole, nodeType) => [tokenBurn(oneDevAccountOf(PAYER.pub), ONE_DEV_MINT, PAYER.pub, BigInt(whole) * 1_000_000n), memo(NODE_TYPE_MEMO[nodeType], PAYER.pub)];

const signed = (instructions, signers = [PAYER]) => signedWith(BLOCKHASH, instructions, signers);
const messageOf = (instructions) => compileLegacyMessage(instructions, PAYER.pub, BLOCKHASH);
const sigOf = (wire) => bs58.encode(parseLegacyTransaction(wire).signatures[0]);

const SHAPES = {
  sol: [solTo(TO.pub, 1_500_000n)],
  'sol with a memo and four references': [requestMemo('Order 42 ✓'), solTo(TO.pub, 1n, REFS.slice(0, REFERENCES_MAX))],
  'sol to itself': [solTo(PAYER.pub, 5_000n)],
  '1dev with the create': [createFor(TO.pub), checked()],
  '1dev to an existing account': [checked()],
  '1dev with the create, a memo and two references': [createFor(TO.pub), requestMemo('m'.repeat(REQUEST_MEMO_MAX_BYTES)), checked({ refs: REFS.slice(0, 2) })],
  '1dev from another account of the payer': [checked({ source: SOURCE })],
  // A request may name the payer's own address: both wallets take it, and the message merges its two roles.
  'sol with the payer as a reference': [solTo(TO.pub, 1n, [PAYER.pub])],
  '1dev with the payer as a reference': [checked({ refs: [PAYER.pub] })],
};
const BURNS = { light: { ixs: burnOf(1500, 'light'), whole: 1500 }, super: { ixs: burnOf(9000, 'super'), whole: 9000 } };

const REFUSED = {
  'the cabinet\'s burn': burnInstructions(PAYER.pub, 1500),
  'the cabinet\'s refund': refundInstructions(PAYER.pub, TO.pub, { oneDevRaw: 5n, accountExists: true, lamports: 5_000_000n, destAccountExists: false }),
  'a compute budget before a transfer': [setComputeUnitPrice(1n), solTo(TO.pub, 1n)],
  'a token program of another kind': [checked({ program: TOKEN_2022 })],
  'another mint': [checked({ mint: OTHER_MINT })],
  'other decimals': [checked({ decimals: 9 })],
  'no 1DEV': [checked({ amount: 0n })],
  'no lamports': [solTo(TO.pub, 0n)],
  'a memo that lists a key': [memo('note', PAYER.pub), solTo(TO.pub, 1n)],
  'a memo over 200 bytes': [requestMemo('m'.repeat(REQUEST_MEMO_MAX_BYTES + 1)), solTo(TO.pub, 1n)],
  'a memo that is not UTF-8': [requestMemo(Uint8Array.of(0x6f, 0xff, 0xfe)), solTo(TO.pub, 1n)],
  'an empty memo': [requestMemo(''), solTo(TO.pub, 1n)],
  'five references': [solTo(TO.pub, 1n, REFS)],
  'a reference twice': [solTo(TO.pub, 1n, [REFS[0], REFS[0]])],
  'a writable reference': [{ ...solTo(TO.pub, 1n), keys: [...solTo(TO.pub, 1n).keys, { pubkey: REFS[0], isSigner: false, isWritable: true }] }],
  'a create for another owner': [createFor(SECOND.pub), checked()],
  'a create of another account': [createFor(TO.pub, oneDevAccountOf(SECOND.pub)), checked()],
  'a create alone': [createFor(TO.pub)],
  'a memo after the transfer': [solTo(TO.pub, 1n), requestMemo('late')],
  'a memo before the create': [requestMemo('early'), createFor(TO.pub), checked()],
  'two transfers': [solTo(TO.pub, 1n), solTo(TO.pub, 2n)],
  'a SOL and a 1DEV transfer': [solTo(TO.pub, 1n), checked()],
  'a System assign': [{ programId: SYSTEM_PROGRAM_ID, keys: [{ pubkey: PAYER.pub, isSigner: true, isWritable: true }], data: Uint8Array.from([1, 0, 0, 0, ...seed('owner')]) }],
  'a transfer from the mint': [checked({ source: ONE_DEV_MINT })],
  'a burn of part of a 1DEV': [tokenBurn(oneDevAccountOf(PAYER.pub), ONE_DEV_MINT, PAYER.pub, 1_500_000_001n), memo(NODE_TYPE_MEMO.light, PAYER.pub)],
  'a burn with another memo': [tokenBurn(oneDevAccountOf(PAYER.pub), ONE_DEV_MINT, PAYER.pub, 1_500_000_000n), memo('QNET_NODE_TYPE:FULL', PAYER.pub)],
  'a burn from another account': [tokenBurn(SOURCE, ONE_DEV_MINT, PAYER.pub, 1_500_000_000n), memo(NODE_TYPE_MEMO.light, PAYER.pub)],
  'a burn with a memo nobody signs': [tokenBurn(oneDevAccountOf(PAYER.pub), ONE_DEV_MINT, PAYER.pub, 1_500_000_000n), requestMemo(NODE_TYPE_MEMO.light)],
  'a burn and a transfer': [...BURNS.light.ixs, solTo(TO.pub, 1n)],
};

// ---------------------------------------------------------------- the relay

const APP_SEND = { encoding: 'base64', preflightCommitment: 'confirmed' };
const EXTENSION_SEND = { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 };
const SIMULATE = { encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false, commitment: 'confirmed' };
const EMPTY = keyOf('relay-empty').pub;
const LARGE = keyOf('relay-large').pub;
const RICH = keyOf('relay-rich').pub;
const STATUS = { slot: 5, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: 'finalized' };

// A Solana that answers every method of the wallets: an account of 165 bytes, none at EMPTY, a larger one at LARGE.
function solana() {
  return {
    getMultipleAccounts: (params) => ({
      context: { slot: 7 },
      value: params[0].map((k) => {
        if (k === EMPTY) return null;
        if (params[1].encoding === 'base64') {
          const size = k === LARGE ? ACCOUNT_SLICE_BYTES : ACCOUNT_DATA_MAX;
          return { lamports: 2_039_280, data: [Buffer.alloc(size).toString('base64'), 'base64'], owner: TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0, space: size };
        }
        return { lamports: 2_039_280, data: { parsed: { type: 'account', info: { mint: ONE_DEV_MINT, owner: PAYER.pub } }, program: 'spl-token', space: 165 }, owner: TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0, space: 165 };
      }),
    }),
    getTokenAccountsByOwner: { context: { slot: 7 }, value: [] },
    getTokenSupply: { context: { slot: 7 }, value: { amount: '1000', decimals: 6, uiAmount: 0.001, uiAmountString: '0.001' } },
    getSupply: { context: { slot: 7 }, value: { total: 5, circulating: 4, nonCirculating: 1, nonCirculatingAccounts: [] } },
    getMinimumBalanceForRentExemption: (params) => (params[0] === 0 ? 890_880 : 2_039_280),
    getLatestBlockhash: { context: { slot: 7 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 99 } },
    getBlockHeight: (params) => (params[0].commitment === 'finalized' ? 90 : 95),
    getFeeForMessage: { context: { slot: 7 }, value: 5000 },
    simulateTransaction: { context: { slot: 7 }, value: { err: null, logs: [] } },
    sendTransaction: 'whatever the endpoint echoes',
    getSignatureStatuses: (params) => ({ context: { slot: 7 }, value: params[0].map(() => STATUS) }),
    getSignaturesForAddress: [],
    getTransaction: { slot: 5, meta: { err: null }, transaction: { message: { accountKeys: [], instructions: [] } } },
  };
}

let scopes = 0;
function relayProxy(answers = solana(), options = {}) {
  let t = 1_000_000;
  const now = () => t;
  const net = typeof answers === 'function' ? { rpc: answers, calls: [] } : fakeRpc(answers);
  const lines = [];
  scopes += 1;
  const p = createSolanaProxy({
    rpc: net.rpc, now, clientKey: (req) => ({ ok: true, ip: req.headers.get('x-test-ip') ?? '203.0.113.7' }), scope: `relay${scopes}`,
    devOrigins: false, batchWindowMs: 5, budget: createUpstreamBudget({ now }), log: (line) => lines.push(line), ...options,
  });
  return { p, calls: net.calls, lines, advance: (ms) => { t += ms; } };
}

let ips = 0;
// A fresh client address each, unless the test names one.
const fresh = () => {
  ips += 1;
  return `198.18.${Math.floor(ips / 250) % 250}.${ips % 250}`;
};
const post = (body, headers = {}) => new Request('https://aiqnet.io/api/cabinet/solana', {
  method: 'POST', headers: { host: 'aiqnet.io', 'content-type': 'application/json', 'x-test-ip': fresh(), ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const call = (method, params, headers = {}, id = 1) => post({ jsonrpc: '2.0', id, method, params }, headers);
const json = async (res) => JSON.parse(await res.text());
const ask = async (p, method, params, headers) => {
  const res = await p.relay(call(method, params, headers));
  return { status: res.status, body: await json(res), res };
};

test('(a) every shape the wallets build goes on exactly as signed; the extension\'s burn only once the registry announced it', async () => {
  for (const [name, ixs] of Object.entries(SHAPES)) {
    const wire = signed(ixs);
    assert.deepEqual(classifyWalletTx(parseLegacyTransaction(wire)), { kind: name.startsWith('sol') ? 'sol' : 'token', payer: PAYER.pub }, name);
    for (const config of [APP_SEND, EXTENSION_SEND]) {
      const { p, calls } = relayProxy();
      const got = await ask(p, 'sendTransaction', [b64(wire), config]);
      assert.deepEqual([got.status, got.body], [200, { jsonrpc: '2.0', id: 1, result: sigOf(wire) }], name);
      assert.deepEqual(calls.map((c) => [c.method, c.params[0]]), [['sendTransaction', b64(wire)]], name);
    }
  }
  for (const [nodeType, { ixs, whole }] of Object.entries(BURNS)) {
    const wire = signed(ixs);
    assert.deepEqual(classifyWalletTx(parseLegacyTransaction(wire)), { kind: 'burn', payer: PAYER.pub, whole, nodeType });
    const other = nodeType === 'light' ? 'super' : 'light';
    const asked = [];
    const registry = (held) => async (burnTx) => {
      asked.push(burnTx);
      return held;
    };
    // Not announced, or announced for another amount, burner or node type: refused, nothing sent.
    for (const held of [null, { burner: PAYER.pub, burnAmount: whole + 1, nodeType }, { burner: TO.pub, burnAmount: whole, nodeType }, { burner: PAYER.pub, burnAmount: whole, nodeType: other }]) {
      const { p, calls } = relayProxy(solana(), { announcedBurn: registry(held) });
      const got = await ask(p, 'sendTransaction', [b64(wire), EXTENSION_SEND]);
      assert.deepEqual(got.body.error, { code: -32602, message: 'burn not announced' }, JSON.stringify(held));
      assert.equal(calls.length, 0);
    }
    assert.deepEqual(asked, Array(4).fill(sigOf(wire)), 'the registry is asked by the burn\'s signature');
    // The registry cannot answer: unavailable, nothing sent; without a registry, no burn goes on.
    const down = relayProxy(solana(), { announcedBurn: async () => 'unavailable' });
    assert.equal((await ask(down.p, 'sendTransaction', [b64(wire), EXTENSION_SEND])).status, 503);
    const bare = relayProxy();
    assert.equal((await ask(bare.p, 'sendTransaction', [b64(wire), EXTENSION_SEND])).body.error.code, -32602);
    assert.equal(down.calls.length + bare.calls.length, 0);
    // Announced as this very burn: it goes on.
    const { p, calls } = relayProxy(solana(), { announcedBurn: registry({ burner: PAYER.pub, burnAmount: whole, nodeType }) });
    assert.deepEqual((await ask(p, 'sendTransaction', [b64(wire), EXTENSION_SEND])).body.result, sigOf(wire));
    assert.deepEqual(calls.map((c) => [c.method, c.params[0]]), [['sendTransaction', b64(wire)]]);
    // The route passes the relay the registry's own answer for each signature.
    const relayed = relayProxy();
    assert.deepEqual((await (await relayed.p.relay(call('sendTransaction', [b64(wire), EXTENSION_SEND]), registry({ burner: PAYER.pub, burnAmount: whole, nodeType }))).json()).result, sigOf(wire));
  }
  assert.match(code('app/api/cabinet/solana/route.ts'), /return solanaProxy\(\)\.relay\(request, \(burnTx\) => api\.announcedBurn\(burnTx\)\);/);

  // The shared vectors: each transaction exactly as the wallets' own builders give it (the app's and the extension's
  // tests build the same bytes), read as its shape, its fee asked, and sent on with the params of each wallet that builds it.
  const generator = fileURLToPath(new URL('../../../../../../docs/protocols/tools/solana-relay-vectors.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const vectors = JSON.parse(readFileSync(new URL('../../../../../../docs/protocols/solana-relay.vectors.json', import.meta.url), 'utf8'));
  assert.equal(vectors.constants.relayPath, '/api/cabinet/solana');
  assert.equal(vectors.constants.oneDevMint, ONE_DEV_MINT);
  for (const c of vectors.cases) {
    const message = Uint8Array.from(Buffer.from(c.message, 'hex'));
    const tx = parseLegacyTransaction(Uint8Array.from(Buffer.from(c.transaction, 'base64')));
    assert.deepEqual(classifyWalletTx(parseLegacyMessage(message)), c.shape, c.name);
    assert.deepEqual(classifyWalletTx(tx), c.shape, c.name);
    assert.ok(signaturesValid(tx) && bs58.encode(tx.signatures[0]) === c.signature, c.name);
    const announced = c.shape.kind === 'burn' ? { announcedBurn: async () => ({ burner: c.shape.payer, burnAmount: c.shape.whole, nodeType: c.shape.nodeType }) } : {};
    for (const builder of c.builders) {
      const { p, calls } = relayProxy(solana(), announced);
      assert.deepEqual((await ask(p, 'getFeeForMessage', [b64(message), { commitment: 'confirmed' }])).body.result, { context: { slot: 7 }, value: 5000 }, c.name);
      const sent = await ask(p, 'sendTransaction', [c.transaction, builder === 'app' ? APP_SEND : EXTENSION_SEND]);
      assert.deepEqual(sent.body, { jsonrpc: '2.0', id: 1, result: c.signature }, `${c.name}: ${builder}`);
      assert.deepEqual(calls.map((x) => [x.method, x.params[0]]), [['getFeeForMessage', b64(message)], ['sendTransaction', c.transaction]], `${c.name}: ${builder}`);
    }
  }
  assert.deepEqual(new Set(vectors.cases.flatMap((c) => c.builders)), new Set(['app', 'extension']));
});

test('(b) any other transaction is refused before Solana: the cabinet\'s own, another program, signer, memo, reference, order or size', async () => {
  const { p, calls } = relayProxy(solana(), { announcedBurn: async () => ({ burner: PAYER.pub, burnAmount: 1500, nodeType: 'light' }) });
  const refused = async (wire, name) => {
    for (const [method, config] of [['sendTransaction', APP_SEND], ['sendTransaction', EXTENSION_SEND], ['simulateTransaction', SIMULATE]]) {
      const got = await ask(p, method, [b64(wire), config]);
      assert.deepEqual([got.status, got.body.error], [200, { code: -32602, message: 'transaction not accepted' }], `${name}: ${method}`);
    }
  };
  for (const [name, ixs] of Object.entries(REFUSED)) {
    assert.equal(classifyWalletTx(parseLegacyTransaction(signed(ixs))), null, name);
    await refused(signed(ixs), name);
  }
  // A second signer, even beside a wallet's own transfer.
  await refused(signed([solTo(TO.pub, 1n), memo('x', SECOND.pub)], [PAYER, SECOND]), 'a second signer');
  // A signature that does not verify, the payer's or anyone's.
  const forged = signed(SHAPES.sol);
  forged[5] ^= 1;
  await refused(forged, 'a forged signature');
  // A table with an account no instruction names, a versioned message, trailing bytes, too long.
  const tx = parseLegacyTransaction(signed(SHAPES.sol));
  assert.equal(classifyWalletTx({ ...tx, accounts: [...tx.accounts, ro(REFS[0])] }), null, 'an account no instruction names');
  assert.equal(classifyWalletTx({ ...tx, accounts: tx.accounts.map((a, i) => (i === 1 ? { ...a, isWritable: false } : a)) }), null, 'a role changed');
  const versioned = signed(SHAPES.sol);
  versioned[65] |= 0x80;
  await refused(versioned, 'a versioned message');
  await refused(Uint8Array.of(...signed(SHAPES.sol), 0), 'trailing bytes');
  await refused(new Uint8Array(1233), 'over 1232 bytes');
  // Not base64 at all: the params are not the wallets'.
  assert.equal((await ask(p, 'sendTransaction', ['not base64!', APP_SEND])).body.error.code, -32602);
  assert.equal(calls.length, 0, 'nothing reached Solana');
});

test('(c) the fee of a wallet\'s own message is asked, of any other refused; a burn is simulated before it is announced', async () => {
  const { p, calls } = relayProxy();
  const shapes = [...Object.values(SHAPES), BURNS.light.ixs, BURNS.super.ixs];
  for (const ixs of shapes) {
    const message = b64(messageOf(ixs));
    assert.ok(classifyWalletTx(parseLegacyMessage(messageOf(ixs))));
    assert.deepEqual((await ask(p, 'getFeeForMessage', [message, { commitment: 'confirmed' }])).body.result, { context: { slot: 7 }, value: 5000 });
    assert.deepEqual(calls.at(-1), { method: 'getFeeForMessage', params: [message, { commitment: 'confirmed' }] });
  }
  assert.equal(calls.length, shapes.length);
  for (const [name, ixs] of Object.entries(REFUSED)) {
    assert.deepEqual((await ask(p, 'getFeeForMessage', [b64(messageOf(ixs)), { commitment: 'confirmed' }])).body.error, { code: -32602, message: 'message not accepted' }, name);
  }
  assert.equal(calls.length, shapes.length, 'no refused message reached Solana');
  // The extension simulates its burn before it announces it: no registry is asked for a simulation.
  const wire = signed(BURNS.super.ixs);
  const sim = relayProxy(solana(), { announcedBurn: async () => { throw new Error('not asked'); } });
  assert.deepEqual((await ask(sim.p, 'simulateTransaction', [b64(wire), SIMULATE])).body.result, { context: { slot: 7 }, value: { err: null, logs: [] } });
  assert.deepEqual(sim.calls, [{ method: 'simulateTransaction', params: [b64(wire), SIMULATE] }]);
});

// The wallets' 14 methods with exactly their params (the app's services/SolanaSend.js, TokenFacts.js, WalletManager.js;
// the extension's background/solana.js and activation.js).
function exactCalls() {
  const wire = signed(SHAPES['1dev with the create']);
  const sig = sigOf(wire);
  const older = sigOf(signed(SHAPES.sol));
  return {
    getBalance: [[PAYER.pub, { commitment: 'confirmed' }], [PAYER.pub, { commitment: 'finalized' }]],
    getAccountInfo: [[ONE_DEV_MINT, { encoding: 'jsonParsed', commitment: 'confirmed' }], [oneDevAccountOf(PAYER.pub), { encoding: 'jsonParsed', commitment: 'finalized' }]],
    getTokenAccountsByOwner: [[PAYER.pub, { mint: ONE_DEV_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }]],
    getTokenSupply: [[ONE_DEV_MINT, { commitment: 'finalized' }]],
    getSupply: [[{ commitment: 'confirmed', excludeNonCirculatingAccountsList: true }]],
    getMinimumBalanceForRentExemption: [[0, { commitment: 'confirmed' }], [165, { commitment: 'confirmed' }]],
    getLatestBlockhash: [[{ commitment: 'confirmed' }]],
    getBlockHeight: [[{ commitment: 'confirmed' }], [{ commitment: 'finalized' }]],
    getFeeForMessage: [[b64(messageOf(SHAPES.sol)), { commitment: 'confirmed' }]],
    simulateTransaction: [[b64(wire), SIMULATE]],
    sendTransaction: [[b64(wire), APP_SEND], [b64(wire), EXTENSION_SEND]],
    getSignatureStatuses: [[[sig], { searchTransactionHistory: false }], [[sig], { searchTransactionHistory: true }]],
    getSignaturesForAddress: [
      [PAYER.pub, { limit: 10, commitment: 'confirmed' }], [PAYER.pub, { limit: 25, commitment: 'confirmed', before: sig }],
      [PAYER.pub, { limit: 1000, commitment: 'finalized', until: older }], [PAYER.pub, { limit: 1000, commitment: 'finalized', until: older, before: sig }],
    ],
    getTransaction: [[sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }], [sig, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]],
  };
}

// Each one-field change of a call: a param more or less, a key more or less (an optional one only added wrong), a
// value of another kind.
function oneFieldChanges(params) {
  const out = [[...params, {}], params.slice(0, -1)];
  params.forEach((param, i) => {
    const at = (v) => params.map((x, j) => (j === i ? v : x));
    if (typeof param === 'string') out.push(at('x'), at(''));
    if (typeof param === 'number') out.push(at(param + 1), at(String(param)));
    if (Array.isArray(param)) out.push(at([...param, param[0]]), at([]), at(['x']));
    if (param !== null && typeof param === 'object' && !Array.isArray(param)) {
      out.push(at({ ...param, extra: 1 }));
      for (const key of Object.keys(param)) {
        const { [key]: _, ...rest } = param;
        if (key !== 'before' && key !== 'until') out.push(at(rest));
        out.push(at({ ...param, [key]: 'processed' }));
      }
    }
  });
  return out;
}

test('(d) the 14 methods with the wallets\' exact params are answered; any other method, param or envelope is refused unasked', async () => {
  const { p, calls } = relayProxy(solana(), { announcedBurn: async () => null, budget: unbudgeted });
  const exact = exactCalls();
  assert.equal(Object.keys(exact).length, 14);
  for (const [method, list] of Object.entries(exact)) {
    for (const params of list) {
      const got = await ask(p, method, params);
      assert.equal(got.status, 200, `${method} ${JSON.stringify(params[1] ?? params[0])}`);
      assert.ok('result' in got.body && !('error' in got.body), `${method}: ${JSON.stringify(got.body)}`);
    }
  }
  const asked = calls.length;
  for (const [method, list] of Object.entries(exact)) {
    for (const params of list) {
      for (const changed of oneFieldChanges(params)) {
        const got = await ask(p, method, changed);
        assert.deepEqual([got.status, got.body.error?.code], [200, -32602], `${method} ${JSON.stringify(changed).slice(0, 160)}`);
      }
    }
  }
  // Another mint than 1DEV's, wherever a param names the mint.
  assert.equal((await ask(p, 'getTokenSupply', [OTHER_MINT, { commitment: 'finalized' }])).body.error.code, -32602);
  assert.equal((await ask(p, 'getTokenAccountsByOwner', [PAYER.pub, { mint: OTHER_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }])).body.error.code, -32602);
  for (const method of ['getProgramAccounts', 'requestAirdrop', 'getAccountInfoX', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.deepEqual((await ask(p, method, [])).body, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }, method);
  }
  const good = { jsonrpc: '2.0', id: 1, method: 'getBlockHeight', params: [{ commitment: 'confirmed' }] };
  for (const bad of [[good], [], { ...good, jsonrpc: '1.0' }, { ...good, id: null }, { ...good, id: -1 }, { ...good, id: 1.5 }, { ...good, id: 2 ** 31 },
    { ...good, id: 'x'.repeat(65) }, { ...good, method: 7 }, { ...good, params: {} }, { ...good, extra: 1 }, { jsonrpc: '2.0', method: 'getBlockHeight', params: [] }, 'x', 7, null]) {
    const res = await p.relay(post(JSON.stringify(bad)));
    assert.deepEqual([res.status, await json(res)], [200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }], JSON.stringify(bad));
  }
  assert.equal((await p.relay(post({ ...good, id: 'abc' }))).status, 200, 'a string id');
  assert.equal((await p.relay(post('{not json'))).status, 400);
  assert.equal((await p.relay(new Request('https://aiqnet.io/api/cabinet/solana', { method: 'POST', headers: { host: 'aiqnet.io', 'content-type': 'text/plain' }, body: '{}' }))).status, 415);
  assert.equal((await p.relay(post({ ...good, pad: 'x'.repeat(RELAY_BODY_MAX_BYTES) }))).status, 413);
  assert.equal(calls.length, asked, 'no refusal reached Solana');
  // The answers the wallets read: {value} of an account read, a bare height, the endpoint's own result otherwise.
  assert.deepEqual((await ask(p, 'getBalance', [EMPTY, { commitment: 'confirmed' }])).body.result, { value: 0 });
  assert.deepEqual((await ask(p, 'getBalance', [RICH, { commitment: 'confirmed' }])).body.result, { value: 2_039_280 });
  assert.deepEqual((await ask(p, 'getAccountInfo', [EMPTY, { encoding: 'jsonParsed', commitment: 'confirmed' }])).body.result, { value: null });
  assert.equal((await ask(p, 'getBlockHeight', [{ commitment: 'finalized' }])).body.result, 90);
  assert.deepEqual((await ask(p, 'getLatestBlockhash', [{ commitment: 'confirmed' }])).body.result, { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 99 } });
  assert.deepEqual((await ask(p, 'getSignatureStatuses', [[sigOf(signed(SHAPES.sol))], { searchTransactionHistory: false }])).body.result, { value: [STATUS] });
  assert.deepEqual((await ask(p, 'getTokenSupply', [ONE_DEV_MINT, { commitment: 'finalized' }])).body.result, solana().getTokenSupply);
  const res = await p.relay(call('getBlockHeight', [{ commitment: 'confirmed' }], {}, 'id-7'));
  assert.deepEqual(await json(res), { jsonrpc: '2.0', id: 'id-7', result: 95 });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-type'), 'application/json');
});

test('(e) reads are shared: accounts 100 and statuses 256 to a call, one blockhash, height, rent and owner\'s list for all', async () => {
  const { p, calls, advance } = relayProxy(solana(), { budget: unbudgeted });
  const of = (m) => calls.filter((c) => c.method === m);
  const addresses = Array.from({ length: 150 }, (_, i) => keyOf(`relay-batch-${i}`).pub);
  const balances = await Promise.all(addresses.map((a) => ask(p, 'getBalance', [a, { commitment: 'confirmed' }])));
  assert.ok(balances.every((b) => b.body.result.value === 2_039_280));
  assert.deepEqual(of('getMultipleAccounts').map((c) => c.params[0].length), [100, 50]);
  assert.deepEqual(of('getMultipleAccounts')[0].params[1], { encoding: 'base64', dataSlice: { offset: 0, length: ACCOUNT_SLICE_BYTES }, commitment: 'confirmed' });
  assert.deepEqual(of('getMultipleAccounts').flatMap((c) => c.params[0]).sort(), [...addresses].sort());
  // Kept PAYMENT_CACHE_MS per address and commitment.
  await ask(p, 'getBalance', [addresses[0], { commitment: 'confirmed' }]);
  assert.equal(of('getMultipleAccounts').length, 2);
  await ask(p, 'getBalance', [addresses[0], { commitment: 'finalized' }]);
  assert.equal(of('getMultipleAccounts').length, 3);
  advance(PAYMENT_CACHE_MS);
  await ask(p, 'getBalance', [addresses[0], { commitment: 'confirmed' }]);
  assert.equal(of('getMultipleAccounts').length, 4);

  const signatures = Array.from({ length: 300 }, (_, i) => bs58.encode(Buffer.concat([seed(`relay-sig-${i}`), seed(`relay-sig2-${i}`)])));
  const statuses = await Promise.all(signatures.map((s, i) => ask(p, 'getSignatureStatuses', [[s], { searchTransactionHistory: i % 2 === 0 }])));
  assert.ok(statuses.every((s) => s.body.result.value[0].confirmationStatus === 'finalized'));
  assert.deepEqual(of('getSignatureStatuses').map((c) => c.params[0].length), [256, 44]);
  assert.deepEqual(of('getSignatureStatuses')[0].params[1], { searchTransactionHistory: true });

  await Promise.all(Array.from({ length: 20 }, () => ask(p, 'getLatestBlockhash', [{ commitment: 'confirmed' }])));
  assert.equal(of('getLatestBlockhash').length, 1);
  advance(BLOCKHASH_CACHE_MS - 1);
  await ask(p, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  assert.equal(of('getLatestBlockhash').length, 1, 'none again within 2 s');
  // The activation page's /blockhash reads the same one.
  await p.blockhash(new Request('https://aiqnet.io/api/cabinet/blockhash', { headers: { host: 'aiqnet.io' } }));
  assert.equal(of('getLatestBlockhash').length, 1);
  advance(1);
  await ask(p, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  assert.equal(of('getLatestBlockhash').length, 2);

  for (let i = 0; i < 5; i += 1) await ask(p, 'getBlockHeight', [{ commitment: i % 2 ? 'confirmed' : 'finalized' }]);
  assert.deepEqual(of('getBlockHeight').map((c) => c.params[0].commitment).sort(), ['confirmed', 'finalized']);

  for (let i = 0; i < 3; i += 1) await ask(p, 'getMinimumBalanceForRentExemption', [165, { commitment: 'confirmed' }]);
  advance(RENT_CACHE_MS - 1);
  await ask(p, 'getMinimumBalanceForRentExemption', [165, { commitment: 'confirmed' }]);
  assert.equal(of('getMinimumBalanceForRentExemption').length, 1, 'one an hour');
  advance(1);
  await ask(p, 'getMinimumBalanceForRentExemption', [165, { commitment: 'confirmed' }]);
  assert.equal(of('getMinimumBalanceForRentExemption').length, 2);

  const owner = [PAYER.pub, { mint: ONE_DEV_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }];
  for (let i = 0; i < 3; i += 1) await ask(p, 'getTokenAccountsByOwner', owner);
  assert.equal(of('getTokenAccountsByOwner').length, 1);
  advance(PAYMENT_CACHE_MS);
  await ask(p, 'getTokenAccountsByOwner', owner);
  assert.equal(of('getTokenAccountsByOwner').length, 2, 'one per owner every 3 s');

  for (let i = 0; i < 3; i += 1) {
    await ask(p, 'getSupply', [{ commitment: 'confirmed', excludeNonCirculatingAccountsList: true }]);
    await ask(p, 'getTokenSupply', [ONE_DEV_MINT, { commitment: 'finalized' }]);
  }
  advance(SUPPLY_CACHE_MS);
  await ask(p, 'getSupply', [{ commitment: 'confirmed', excludeNonCirculatingAccountsList: true }]);
  await ask(p, 'getTokenSupply', [ONE_DEV_MINT, { commitment: 'finalized' }]);
  assert.deepEqual([of('getSupply').length, of('getTokenSupply').length], [2, 2], 'each one a minute');

  // A finalized transaction is kept a day, a confirmed one a moment, one not found yet not at all.
  const txSig = signatures[0];
  const getTx = (commitment) => ask(p, 'getTransaction', [txSig, { encoding: 'jsonParsed', commitment, maxSupportedTransactionVersion: 0 }]);
  await getTx('finalized');
  advance(FINAL_TX_CACHE_MS - 1);
  await getTx('finalized');
  assert.equal(of('getTransaction').length, 1);
  await getTx('confirmed');
  advance(TX_CACHE_MS);
  await getTx('confirmed');
  assert.equal(of('getTransaction').length, 3);
  const none = relayProxy({ ...solana(), getTransaction: null });
  for (let i = 0; i < 2; i += 1) assert.deepEqual((await ask(none.p, 'getTransaction', [txSig, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])).body.result, null);
  assert.equal(none.calls.length, 2);
  assert.equal(RELAY_TX_ENTRIES, 500);
  // The /tx route and the relay read one status per signature.
  const shared = relayProxy();
  const sig = signatures[1];
  await ask(shared.p, 'getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
  await shared.p.tx(new Request(`https://aiqnet.io/api/cabinet/tx/${sig}`, { headers: { host: 'aiqnet.io' } }), sig, null);
  assert.equal(shared.calls.filter((c) => c.method === 'getSignatureStatuses').length, 1);
});

test('(f) an account is read parsed only when it holds at most 165 bytes', async () => {
  const { p, calls } = relayProxy();
  const large = await ask(p, 'getAccountInfo', [LARGE, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  assert.deepEqual(large.body.error, { code: -32602, message: 'account data too large' });
  assert.deepEqual(calls.map((c) => c.params[1].encoding), ['base64'], 'no parsed read of it');
  const token = await ask(p, 'getAccountInfo', [RICH, { encoding: 'jsonParsed', commitment: 'finalized' }]);
  assert.equal(token.body.result.value.data.parsed.type, 'account');
  assert.deepEqual(calls.slice(1).map((c) => [c.params[1].encoding, c.params[1].commitment]), [['base64', 'finalized'], ['jsonParsed', 'finalized']]);
  // At confirmed the cabinet's own parsed batch serves it.
  await ask(p, 'getAccountInfo', [RICH, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  assert.deepEqual(calls.at(-1).params, [[RICH], { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  assert.equal(ACCOUNT_DATA_MAX, 165);
  assert.equal(ACCOUNT_SLICE_BYTES, 166);
});

const LANES = ['solanaRead', 'solanaScan', 'solanaSend'];
const ownerList = (owner) => [owner, { mint: ONE_DEV_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }];
const transferOf = (label, lamports = 1n) => {
  const payer = keyOf(label);
  return b64(signedWith(BLOCKHASH, [systemTransfer(payer.pub, TO.pub, lamports)], [payer]));
};

test('(g) each client gets under half of each lane, so another client is served in the same window, across the seam of its own windows too', async () => {
  // A client's 241st relay request in a minute.
  const one = relayProxy();
  const ip = { 'x-test-ip': '203.0.113.60' };
  for (let i = 0; i < CABINET_LIMITS.solana.max; i += 1) assert.equal((await ask(one.p, 'getLatestBlockhash', [{ commitment: 'confirmed' }], ip)).status, 200, `${i}`);
  const limited = await ask(one.p, 'getLatestBlockhash', [{ commitment: 'confirmed' }], ip);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.res.headers.get('retry-after')) >= 1);
  assert.deepEqual(CABINET_LIMITS.solana, { max: 240, windowMs: 60_000 });

  // The lanes, and each client's share of them in the lane's own window: under half, and enough for a wallet's largest
  // step: the extension's history page (two listings and ten transactions), the app's 1DEV quote with the Assets
  // reads beside it (three accounts, each its slice and its parsed read, the payer's balance, its token accounts and
  // the fee, then the Assets figures' two), the extension's activation check, a simulation and its send.
  assert.deepEqual(LANES.map((l) => UPSTREAM_BUDGETS[l]), [{ max: 25, windowMs: 10_000 }, { max: 9, windowMs: 10_000 }, { max: 5, windowMs: 10_000 }]);
  assert.deepEqual(LANES.map((l) => CLIENT_BUDGETS[l]), [{ max: 12, windowMs: 10_000 }, { max: 4, windowMs: 10_000 }, { max: 2, windowMs: 10_000 }]);
  for (const l of LANES) assert.ok(2 * CLIENT_BUDGETS[l].max < UPSTREAM_BUDGETS[l].max && CLIENT_BUDGETS[l].windowMs === UPSTREAM_BUDGETS[l].windowMs, l);
  assert.ok(CLIENT_BUDGETS.solanaRead.max >= Math.max(2 + 10, 3 * 2 + 3 + 2));
  assert.ok(CLIENT_BUDGETS.solanaScan.max >= 4 && CLIENT_BUDGETS.solanaSend.max >= 2);
  // Together 39 of the public endpoint's 100 calls per 10 s; of one method (getSignaturesForAddress, on the read and
  // the scan lanes) under its 40.
  assert.equal(LANES.reduce((n, l) => n + UPSTREAM_BUDGETS[l].max, 0), 39);
  assert.ok(UPSTREAM_BUDGETS.solanaRead.max + UPSTREAM_BUDGETS.solanaScan.max < 40);
  assert.ok(!('solanaSend' in CABINET_LIMITS) && !('solanaMiss' in CLIENT_BUDGETS), 'the shares are the only per-client bound on what reaches Solana');

  // Reads: A spends its share at the end of one of its windows and again at the start of the next, both within one window
  // of the lane, and B is still served in it; past both, the lane is unavailable without asking Solana, logged once.
  const reads = relayProxy();
  let owners = 0;
  const list = (headers) => ask(reads.p, 'getTokenAccountsByOwner', ownerList(keyOf(`relay-share-owner-${owners++}`).pub), headers);
  const [A, B] = [{ 'x-test-ip': '203.0.113.63' }, { 'x-test-ip': '203.0.113.64' }];
  const share = CLIENT_BUDGETS.solanaRead.max;
  assert.equal((await list(B)).status, 200);
  reads.advance(5_000);
  assert.equal((await list(A)).status, 200, 'A\'s window opens 5 s into the lane\'s');
  reads.advance(9_999);
  for (let i = 1; i < share; i += 1) assert.equal((await list(A)).status, 200, `A ${i}`);
  assert.equal((await list(A)).status, 429, 'past its share in this window of its own');
  reads.advance(1);
  for (let i = 0; i < share; i += 1) assert.equal((await list(A)).status, 200, `A's next window ${i}`);
  assert.equal((await list(A)).status, 429);
  assert.equal((await list(B)).status, 200, 'A took twice its share, under the lane, in this window of it');
  assert.equal((await list({ 'x-test-ip': '203.0.113.65' })).status, 200);
  assert.equal((await list({ 'x-test-ip': '203.0.113.66' })).status, 503);
  assert.equal(reads.calls.length, 2 + UPSTREAM_BUDGETS.solanaRead.max);
  assert.deepEqual(reads.lines, ['[WARN][SOLANA] relay_lane_spent lane=read']);

  // Long listings: an extension's activation check lists four (its 1DEV account's and its own, finalized and confirmed),
  // its client no fifth in the window; a second client's check goes out in the same window of the lane, a third's
  // first listing too, and then the lane is spent; a short listing still reads.
  const scans = relayProxy();
  const check = async (wallet, headers) => {
    const out = [];
    for (const address of [oneDevAccountOf(wallet), wallet]) {
      for (const commitment of ['finalized', 'confirmed']) {
        out.push((await ask(scans.p, 'getSignaturesForAddress', [address, { limit: SIGNATURES_LIMIT_MAX, commitment }], headers)).status);
      }
    }
    return out;
  };
  const first = { 'x-test-ip': '203.0.113.67' };
  assert.deepEqual(await check(PAYER.pub, first), [200, 200, 200, 200]);
  assert.equal((await ask(scans.p, 'getSignaturesForAddress', [TO.pub, { limit: SIGNATURES_LIMIT_MAX, commitment: 'finalized' }], first)).status, 429);
  assert.deepEqual(await check(SECOND.pub, { 'x-test-ip': '203.0.113.68' }), [200, 200, 200, 200]);
  assert.deepEqual(await check(TO.pub, { 'x-test-ip': '203.0.113.69' }), [200, 503, 503, 503]);
  assert.equal((await ask(scans.p, 'getSignaturesForAddress', [EMPTY, { limit: SHORT_LISTING_MAX, commitment: 'confirmed' }])).status, 200);
  assert.deepEqual(scans.lines, ['[WARN][SOLANA] relay_lane_spent lane=scan']);
  assert.equal(SIGNATURES_LIMIT_MAX, 1000);

  // Simulations and sends: a client's simulation and its send, then 429; another client's pair in the same window of
  // the lane; a third's simulation, and then the lane is spent.
  const sends = relayProxy();
  const go = (method, label, headers) => ask(sends.p, method, [transferOf(label), method === 'sendTransaction' ? APP_SEND : SIMULATE], headers);
  const [s1, s2, s3] = [71, 72, 73].map((n) => ({ 'x-test-ip': `203.0.113.${n}` }));
  assert.deepEqual([(await go('simulateTransaction', 'relay-s1', s1)).status, (await go('sendTransaction', 'relay-s1', s1)).status], [200, 200]);
  assert.equal((await go('sendTransaction', 'relay-s1-again', s1)).status, 429);
  assert.deepEqual([(await go('simulateTransaction', 'relay-s2', s2)).status, (await go('sendTransaction', 'relay-s2', s2)).status], [200, 200]);
  assert.deepEqual([(await go('simulateTransaction', 'relay-s3', s3)).status, (await go('sendTransaction', 'relay-s3', s3)).status], [200, 503]);
  assert.equal(sends.calls.length, UPSTREAM_BUDGETS.solanaSend.max);
  assert.deepEqual(sends.lines, ['[WARN][SOLANA] relay_lane_spent lane=send']);
});

test('(h) the activation routes\' origins: the app, the extension and the site; another page is refused before any limit', async () => {
  const { p } = relayProxy();
  const ext = `chrome-extension://${'abcdefghijklmnop'.repeat(2)}`;
  const block = [{ commitment: 'confirmed' }];
  assert.equal((await ask(p, 'getBlockHeight', block)).status, 200, 'no Origin: the app');
  assert.equal((await ask(p, 'getBlockHeight', block, { origin: ext, 'sec-fetch-site': 'none' })).status, 200, 'the extension');
  assert.equal((await ask(p, 'getBlockHeight', block, { origin: 'https://aiqnet.io', 'sec-fetch-site': 'same-origin' })).status, 200, 'the site');
  for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: `chrome-extension://${'q'.repeat(32)}`, 'sec-fetch-site': 'none' }]) {
    const got = await ask(p, 'getBlockHeight', block, headers);
    assert.deepEqual([got.status, got.body], [403, { error: 'forbidden_origin' }], JSON.stringify(headers));
  }
  // 300 refused requests from one address leave its next own request unlimited.
  const same = { 'x-test-ip': '203.0.113.70' };
  for (let i = 0; i < 300; i += 1) assert.equal((await ask(p, 'getBlockHeight', block, { ...same, origin: 'https://evil.example' })).status, 403);
  assert.equal((await ask(p, 'getBlockHeight', block, same)).status, 200);
  // The extension's simulation and send, of a transfer and of its announced burn, pass the same rule and reach Solana.
  const announced = relayProxy(solana(), { announcedBurn: async () => ({ burner: PAYER.pub, burnAmount: BURNS.light.whole, nodeType: 'light' }) });
  const fromExtension = { origin: ext, 'sec-fetch-site': 'none' };
  for (const wire of [signed(SHAPES.sol), signed(BURNS.light.ixs)]) {
    const simulated = await ask(announced.p, 'simulateTransaction', [b64(wire), SIMULATE], fromExtension);
    assert.deepEqual([simulated.status, 'result' in simulated.body], [200, true]);
    assert.equal((await ask(announced.p, 'sendTransaction', [b64(wire), EXTENSION_SEND], fromExtension)).body.result, sigOf(wire));
  }
  assert.deepEqual(announced.calls.map((c) => c.method), ['simulateTransaction', 'sendTransaction', 'simulateTransaction', 'sendTransaction']);
});

test('(i) the endpoint\'s refusal comes back as it gave it, a lost send as no answer, and integers past 2^53 exactly', async () => {
  const wire = signed(SHAPES.sol);
  const refusing = relayProxy({ sendTransaction: new RpcError(-32002, 'Transaction simulation failed: Blockhash not found') });
  const refusal = await ask(refusing.p, 'sendTransaction', [b64(wire), APP_SEND]);
  assert.deepEqual([refusal.status, refusal.body], [200, { jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Transaction simulation failed: Blockhash not found' } }]);
  // A send the endpoint did not answer: no answer, and its reason logged once a minute.
  const lost = relayProxy({ sendTransaction: new TypeError('fetch failed') });
  for (let i = 0; i < 2; i += 1) assert.equal((await ask(lost.p, 'sendTransaction', [b64(wire), APP_SEND])).status, 503);
  assert.deepEqual(lost.lines, ['[WARN][SOLANA] relay_upstream_failed method=sendTransaction reason=transport']);
  // A read the endpoint refused comes back as its refusal and is not kept.
  const reading = relayProxy({ getTransaction: new RpcError(-32004, 'Block not available for slot 5') });
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual((await ask(reading.p, 'getTransaction', [sigOf(wire), { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])).body.error, { code: -32004, message: 'Block not available for slot 5' });
  }
  assert.equal(reading.calls.length, 2);
  // Through the real client: the endpoint's digits, byte for byte.
  const text = {
    getSupply: '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":{"total":580000000000000001,"circulating":570000000000000001,"nonCirculating":10000000000000000,"nonCirculatingAccounts":[]}}}',
    getMultipleAccounts: `{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":[{"lamports":18446744073709551615,"data":["","base64"],"owner":"${SYSTEM_PROGRAM_ID}","executable":false,"rentEpoch":18446744073709551615,"space":0}]}}`,
  };
  const exact = solanaRpc('https://rpc.example', { fetchFn: async (_url, init) => new Response(text[JSON.parse(init.body).method], { status: 200 }) });
  const { p, lines } = relayProxy(exact);
  const supply = await p.relay(call('getSupply', [{ commitment: 'confirmed', excludeNonCirculatingAccountsList: true }]));
  assert.equal(await supply.text(), `{"jsonrpc":"2.0","id":1,"result":${text.getSupply.slice(text.getSupply.indexOf('"result":') + 9, -1)}}`);
  const balance = await p.relay(call('getBalance', [RICH, { commitment: 'confirmed' }]));
  assert.equal(await balance.text(), '{"jsonrpc":"2.0","id":1,"result":{"value":18446744073709551615}}');
  assert.deepEqual(lines, []);
});

test('(j) while the reads back off after a 429, a wallet\'s simulation and send still go out', async () => {
  const inner = fakeRpc({ ...solana(), getMultipleAccounts: new Error('rpc_http_429') });
  const lines = [];
  const backed = withBackoff(inner.rpc, { now: () => 1_000_000, log: (l) => lines.push(l) });
  const { p, lines: relayLines } = relayProxy(backed);
  assert.equal((await ask(p, 'getBalance', [RICH, { commitment: 'confirmed' }])).status, 503);
  assert.equal((await ask(p, 'getBalance', [TO.pub, { commitment: 'confirmed' }])).status, 503, 'the reads are backed off');
  assert.equal(inner.calls.length, 1);
  const wire = signed(SHAPES.sol);
  assert.equal((await ask(p, 'simulateTransaction', [b64(wire), SIMULATE])).status, 200);
  assert.equal((await ask(p, 'sendTransaction', [b64(wire), APP_SEND])).body.result, sigOf(wire));
  assert.deepEqual(inner.calls.map((c) => c.method), ['getMultipleAccounts', 'simulateTransaction', 'sendTransaction']);
  assert.deepEqual(lines, ['[WARN][SOLANA] rpc_rate_limited lane=read backoff_ms=2000']);
  // What the relay logs names a method and a reason, never an address, a signature, a body or an address of a client.
  assert.deepEqual(relayLines, ['[WARN][SOLANA] relay_upstream_failed method=getMultipleAccounts reason=http_429']);
  const src = code('server/cabinet/solana-relay.ts');
  assert.deepEqual(src.match(/`\[(?:WARN|INFO|ERROR)\]\[SOLANA\][^`]*`/g), [
    '`[WARN][SOLANA] relay_lane_spent lane=${LANE_NAMES[lane]}`',
    '`[WARN][SOLANA] relay_upstream_failed method=${method} reason=${reason}`',
  ]);
  assert.doesNotMatch(src, /console\./);
});

test('(k) each call that reaches Solana costs its client one share of its lane, an account read parsed two; a kept or shared answer costs nothing', async () => {
  const { p, calls, advance } = relayProxy();
  const share = CLIENT_BUDGETS.solanaRead.max;
  const sig = (i) => bs58.encode(Buffer.concat([seed(`relay-k-sig-${i}`), seed(`relay-k-sig2-${i}`)]));
  const reads = {
    getBalance: (i) => [keyOf(`relay-k-balance-${i}`).pub, { commitment: 'finalized' }],
    getTokenAccountsByOwner: (i) => ownerList(keyOf(`relay-k-owner-${i}`).pub),
    getSignaturesForAddress: (i) => [keyOf(`relay-k-list-${i}`).pub, { limit: SHORT_LISTING_MAX, commitment: 'confirmed' }],
    getTransaction: (i) => [sig(i), { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }],
    getSignatureStatuses: (i) => [[sig(i)], { searchTransactionHistory: false }],
    getFeeForMessage: (i) => [b64(messageOf([solTo(TO.pub, BigInt(i + 1))])), { commitment: 'confirmed' }],
  };
  let n = 80;
  for (const [method, params] of Object.entries(reads)) {
    const client = { 'x-test-ip': `203.0.113.${n++}` };
    const before = calls.length;
    for (let i = 0; i < share; i += 1) assert.equal((await ask(p, method, params(i), client)).status, 200, `${method} ${i}`);
    assert.equal((await ask(p, method, params(share), client)).status, 429, method);
    assert.equal(calls.length - before, share, `${method}: one call each, none past the share`);
    // A kept answer costs nothing (a fee is never kept).
    if (method !== 'getFeeForMessage') assert.equal((await ask(p, method, params(0), client)).status, 200, `${method} kept`);
    advance(UPSTREAM_BUDGETS.solanaRead.windowMs);
  }
  // A long listing costs a share of the scan lane, apart from the reads.
  const scanner = { 'x-test-ip': '203.0.113.90' };
  const listing = (label, limit) => ask(p, 'getSignaturesForAddress', [keyOf(label).pub, { limit, commitment: 'finalized' }], scanner);
  for (let i = 0; i < CLIENT_BUDGETS.solanaScan.max; i += 1) assert.equal((await listing(`relay-k-scan-${i}`, SHORT_LISTING_MAX + 1)).status, 200);
  assert.equal((await listing('relay-k-scan-x', SHORT_LISTING_MAX + 1)).status, 429);
  assert.equal((await listing('relay-k-scan-x', SHORT_LISTING_MAX)).status, 200);
  advance(UPSTREAM_BUDGETS.solanaRead.windowMs);
  // An account read parsed costs its slice and its parsed read: with all but one share spent, the next one's slice goes
  // out and its parsed read is refused.
  const reader = { 'x-test-ip': '203.0.113.91' };
  const account = (i) => [keyOf(`relay-k-account-${i}`).pub, { encoding: 'jsonParsed', commitment: 'confirmed' }];
  const pairs = Math.floor((share - 1) / 2);
  const before = calls.length;
  for (let i = 0; i < pairs; i += 1) assert.equal((await ask(p, 'getAccountInfo', account(i), reader)).status, 200);
  for (let i = 2 * pairs; i < share - 1; i += 1) assert.equal((await ask(p, 'getBalance', reads.getBalance(100 + i), reader)).status, 200);
  assert.equal((await ask(p, 'getAccountInfo', account(pairs), reader)).status, 429);
  assert.equal(calls.length - before, share, 'two calls an account, one a balance, the last slice');
  // Past its share, the client still reads what is kept and what every client shares, each shared answer one call.
  assert.equal((await ask(p, 'getAccountInfo', account(0), reader)).status, 200);
  for (const [method, params] of [['getLatestBlockhash', [{ commitment: 'confirmed' }]], ['getBlockHeight', [{ commitment: 'finalized' }]],
    ['getTokenSupply', [ONE_DEV_MINT, { commitment: 'finalized' }]], ['getSupply', [{ commitment: 'confirmed', excludeNonCirculatingAccountsList: true }]],
    ['getMinimumBalanceForRentExemption', [ACCOUNT_DATA_MAX, { commitment: 'confirmed' }]]]) {
    assert.equal((await ask(p, method, params, reader)).status, 200, method);
  }
  assert.equal(calls.length - before, share + 5);

  // With the read lane spent, an account whose slice is kept answers 503 and is not read parsed.
  const spent = relayProxy();
  assert.equal((await ask(spent.p, 'getBalance', [RICH, { commitment: 'confirmed' }])).status, 200);
  for (let i = 1; i < UPSTREAM_BUDGETS.solanaRead.max; i += 1) assert.equal((await ask(spent.p, 'getTokenAccountsByOwner', ownerList(keyOf(`relay-k-spend-${i}`).pub))).status, 200);
  assert.equal((await ask(spent.p, 'getAccountInfo', [RICH, { encoding: 'jsonParsed', commitment: 'confirmed' }])).status, 503);
  assert.deepEqual(spent.calls.filter((c) => c.method === 'getMultipleAccounts').map((c) => c.params[1].encoding), ['base64']);
});

test('(l) a payer\'s landed transaction posted again spends nothing of the payer\'s: only the client that posts it pays, from its own share', async () => {
  const processed = new RpcError(-32002, 'Transaction simulation failed: This transaction has already been processed');
  const sent = new Set();
  const { p, calls, advance } = relayProxy({
    ...solana(),
    sendTransaction: (params) => {
      if (sent.has(params[0])) throw processed;
      sent.add(params[0]);
      return 'accepted';
    },
  });
  const payer = { 'x-test-ip': '203.0.113.95' };
  const landed = signed(SHAPES.sol);
  assert.equal((await ask(p, 'sendTransaction', [b64(landed), APP_SEND], payer)).body.result, sigOf(landed));
  // Anyone can read it from the chain and post it again, from as many addresses as they have.
  for (let i = 0; i < 30; i += 1) {
    assert.deepEqual((await ask(p, 'sendTransaction', [b64(landed), EXTENSION_SEND])).body.error, { code: -32002, message: processed.message }, `${i}`);
    advance(2_500);
  }
  const next = signed([solTo(TO.pub, 2n)]);
  assert.equal((await ask(p, 'sendTransaction', [b64(next), APP_SEND], payer)).body.result, sigOf(next));
  assert.equal(calls.filter((c) => c.method === 'sendTransaction').length, 32);
  assert.ok(!('solanaSend' in KEYED_LIMITS), 'no limit is keyed by a payer');
  // A forged signature is refused before any share counts: that client's own simulation and send still go.
  const forger = { 'x-test-ip': '203.0.113.96' };
  const forged = landed.slice();
  forged[5] ^= 1;
  for (let i = 0; i < 30; i += 1) assert.equal((await ask(p, 'sendTransaction', [b64(forged), APP_SEND], forger)).body.error.code, -32602);
  const theirs = signed([solTo(TO.pub, 3n)]);
  assert.equal((await ask(p, 'simulateTransaction', [b64(theirs), SIMULATE], forger)).status, 200);
  assert.equal((await ask(p, 'sendTransaction', [b64(theirs), APP_SEND], forger)).body.result, sigOf(theirs));
});

test('(m) a look in the history at a status not found reads it again, so a transfer that landed in its last blocks is not taken as expired', async () => {
  let landed = false;
  const { p, calls, advance } = relayProxy({
    ...solana(),
    getSignatureStatuses: (params) => ({ context: { slot: 7 }, value: params[0].map(() => (landed ? STATUS : null)) }),
  });
  const reads = () => calls.filter((c) => c.method === 'getSignatureStatuses').length;
  const look = async (sig, history) => (await ask(p, 'getSignatureStatuses', [[sig], { searchTransactionHistory: history }])).body.result.value[0];
  // The app's look at a send: the recent statuses (not found, shared), the block height past its last valid block, then
  // the history once more, within the time a status is kept.
  const sig = sigOf(signed(SHAPES.sol));
  assert.deepEqual([await look(sig, false), await look(sig, false), reads()], [null, null, 1]);
  landed = true;
  advance(400);
  assert.deepEqual(await look(sig, true), STATUS, 'read again, never the "not found" of 0.4 s before');
  assert.equal(reads(), 2);
  // Found, it is shared again: anyone's recent or history read takes it unasked.
  assert.deepEqual([await look(sig, false), await look(sig, true), reads()], [STATUS, STATUS, 2]);
  // The extension looks in the history on both sides of its height read: the second look is read anew too.
  landed = false;
  const other = sigOf(signed([solTo(TO.pub, 9n)]));
  assert.equal(await look(other, true), null);
  landed = true;
  assert.deepEqual([await look(other, true), reads()], [STATUS, 4]);
  assert.ok(TX_CACHE_MS > 400);
});

test('(n) the large caches keep an answer only up to 16 KiB of JSON, so what they hold has a fixed bound', async () => {
  // JSON of { pad } is 10 characters more than pad.
  const sized = (chars) => ({ pad: 'x'.repeat(chars - 10) });
  const sig = sigOf(signed(SHAPES.sol));
  for (const [chars, kept] of [[KEEP_MAX_CHARS, true], [KEEP_MAX_CHARS + 1, false]]) {
    const answers = { ...solana(), getTransaction: sized(chars), getTokenAccountsByOwner: sized(chars), getSignaturesForAddress: [sized(chars - 2)] };
    for (const m of ['getTransaction', 'getTokenAccountsByOwner', 'getSignaturesForAddress']) assert.equal(JSON.stringify(answers[m]).length, chars, m);
    const { p, calls } = relayProxy(answers);
    for (let i = 0; i < 2; i += 1) {
      assert.deepEqual((await ask(p, 'getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }])).body.result, answers.getTransaction);
      assert.deepEqual((await ask(p, 'getTokenAccountsByOwner', ownerList(PAYER.pub))).body.result, answers.getTokenAccountsByOwner);
      assert.deepEqual((await ask(p, 'getSignaturesForAddress', [PAYER.pub, { limit: 10, commitment: 'confirmed' }])).body.result, answers.getSignaturesForAddress);
    }
    assert.equal(calls.length, kept ? 3 : 6, `${chars} characters`);
  }
  assert.equal(KEEP_MAX_CHARS, 16 * 1024);
  assert.deepEqual([RELAY_TX_ENTRIES, LARGE_ENTRIES], [500, 32]);
  // The finalized transactions, the confirmed ones, the listings and the owners' token accounts: under 10 Mi characters.
  assert.ok((RELAY_TX_ENTRIES + 3 * LARGE_ENTRIES) * KEEP_MAX_CHARS < 10 * 1024 * 1024);
});

test('(o) an answer every client shares that the endpoint did not give is asked for again only after 2 s, however many ask; why is logged', async () => {
  const { p, calls, advance, lines } = relayProxy({
    ...solana(),
    getSupply: new RpcError(-32601, 'Method not found'),
    getTokenSupply: new Error('rpc_http_500'),
    getMinimumBalanceForRentExemption: new RpcError(-32603, 'Internal error'),
    getLatestBlockhash: new Error('rpc_http_503'),
    getBlockHeight: new TypeError('fetch failed'),
  });
  const SHARED = [
    ['getSupply', [{ commitment: 'confirmed', excludeNonCirculatingAccountsList: true }], 200],
    ['getTokenSupply', [ONE_DEV_MINT, { commitment: 'finalized' }], 503],
    ['getMinimumBalanceForRentExemption', [0, { commitment: 'confirmed' }], 200],
    ['getLatestBlockhash', [{ commitment: 'confirmed' }], 503],
    ['getBlockHeight', [{ commitment: 'finalized' }], 503],
  ];
  const round = async () => {
    for (const [method, params, status] of SHARED) {
      const together = await Promise.all(Array.from({ length: 10 }, () => ask(p, method, params)));
      assert.ok(together.every((a) => a.status === status), method);
      for (let i = 0; i < 10; i += 1) assert.equal((await ask(p, method, params)).status, status, method);
    }
  };
  await round();
  assert.equal(calls.length, SHARED.length, 'one call each for twenty clients');
  advance(FAILED_SHARED_MS - 1);
  await round();
  assert.equal(calls.length, SHARED.length);
  advance(1);
  await round();
  assert.equal(calls.length, 2 * SHARED.length);
  // A refusal comes back as the endpoint gave it; a call it did not answer is logged once a minute, with its reason.
  assert.deepEqual((await ask(p, 'getSupply', SHARED[0][1])).body.error, { code: -32601, message: 'Method not found' });
  assert.deepEqual(lines, [
    '[WARN][SOLANA] relay_upstream_failed method=getTokenSupply reason=http_500',
    '[WARN][SOLANA] relay_upstream_failed method=getLatestBlockhash reason=http_503',
    '[WARN][SOLANA] relay_upstream_failed method=getBlockHeight reason=transport',
  ]);
  assert.equal(FAILED_SHARED_MS, 2_000);
});

test('(p) a refreshed read takes the kept answer\'s place, and an older round that ends after it never takes the newer one\'s', async () => {
  let t = 0;
  const m = cacheMemo(1_000, () => t);
  const keep = () => true;
  assert.equal(await m('k', async () => 'old', keep), 'old');
  assert.equal(await m('k', async () => 'unasked', keep), 'old');
  assert.equal(await m.refresh('k', async () => 'new', keep), 'new');
  assert.equal(await m('k', async () => 'unasked', keep), 'new');
  t = 5_000;
  let release;
  const slow = m('k', () => new Promise((resolve) => { release = resolve; }), keep);
  t += 1;
  assert.equal(await m.refresh('k', async () => 'newest', keep), 'newest');
  release('stale');
  assert.equal(await slow, 'stale');
  assert.equal(await m('k', async () => 'unasked', keep), 'newest');
});

test('(q) the payment request limits are the wallets\' own', () => {
  const app = repo('applications/qnet-mobile/src/utils/solanaRequest.js');
  assert.match(app, new RegExp(`^export const MAX_REFERENCES = ${REFERENCES_MAX};$`, 'm'));
  assert.match(app, new RegExp(`^export const MAX_MEMO_BYTES = ${REQUEST_MEMO_MAX_BYTES};$`, 'm'));
  const extension = repo('applications/qnet-wallet/dist/background/config.js');
  assert.match(extension, new RegExp(`PAYMENT_REQUEST = Object\\.freeze\\(\\{ REFERENCES_MAX: ${REFERENCES_MAX}, MEMO_MAX_BYTES: ${REQUEST_MEMO_MAX_BYTES} \\}\\);`));
});
