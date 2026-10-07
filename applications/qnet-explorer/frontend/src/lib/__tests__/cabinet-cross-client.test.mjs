// The QNet extension's activation (applications/qnet-wallet/dist/background/activation.js, the shipped module) against
// this site's real activation routes (src/server/cabinet/activation-api.ts over the registry's rules, the burn check and
// the search of burn-scan.ts), through one simulated Solana and QNet network (unified plan R1 and R6; shared contracts
// C1, C3, C5 and C6). The extension's burn is held by the site's reservation, its proof is verified by the site's own
// check, its burn becomes the wallet's record with the code the extension stored, and from then on no client gets a
// second burn: the site's payment address, another install of the extension, a reset and restore. A reservation the
// site's payment address holds, a site that cannot answer and a node the network knows refuse the extension's burn with
// nothing signed; the extension's answers pass the site's checks of them, and nobody plants a record with a proof made
// for another wallet or burn. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import {
  OFFCHAIN_CONTEXT, burnRecordEnvelope, burnRecordMessage, parseActivationRecord, reservationMessage, verifyBurnRecordProof, verifyReservationProof,
} from '../cabinet/burn-record.ts';
import { encodeB64url } from '../qnet-link.ts';
import { validateGetActivation } from '../qnet-link.ts';
import { StoreUnavailable, createActivationRegistry, createMemoryStore } from '../../server/cabinet/activation-registry.ts';
import { createActivationApi } from '../../server/cabinet/activation-api.ts';
import { checkBurn, createBurnScanner } from '../../server/cabinet/burn-scan.ts';

// The extension's own modules; its test loader stands in for its vault, session and keys (the wallet of the public
// recovery-phrase test vector).
const EXT = new URL('../../../../../qnet-wallet/', import.meta.url);
register(new URL('test/helpers/chains-activation-loader.mjs', EXT).href);
const core = await import(new URL('dist/lib/qnet-core.js', EXT).href);
const { QNET, SOLANA, RECORD_ORIGIN } = await import(new URL('dist/background/config.js', EXT).href);
const keysModule = await import(new URL('dist/background/keys.js', EXT).href);
const { WALLET, installEnv, installFetch, solanaRoute, routes, flush } = await import(new URL('test/helpers/chains-activation-env.mjs', EXT).href);
let instance = 0;
// A fresh worker of the extension (no search verdict, sync or shown record carries over).
const extension = () => import(new URL(`dist/background/activation.js?cross=${++instance}`, EXT).href);

const W = WALLET.qnetAddress;
const OWNER = WALLET.solanaAddress;
const MINT = SOLANA.ONE_DEV_MINT;
const ATA = core.associatedTokenAddress(OWNER, MINT);
const BURN = JSON.parse(readFileSync(new URL('test/fixtures/devnet_burn_tx_nqh74h.json', EXT), 'utf8')).result;
const clone = (v) => JSON.parse(JSON.stringify(v));
// What the browser sends with a request of an extension that holds the host's permission.
const EXTENSION_HEADERS = { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'sec-fetch-site': 'none' };
// A payment address of the site (another Solana key: the public test vector's other phrase).
const PAYMENT = core.deriveSolanaKeypair(core.mnemonicToSeed('legal winner thank year wave sausage worth useful legal winner thank yellow')).address;

// A finalized burn of `owner` as getTransaction (jsonParsed) gives it, built from a recorded devnet burn.
function burnJson({ signature, owner = OWNER, amount = '1500000000', memo = 'QNET_NODE_TYPE:LIGHT', slot = 510_000_000, blockTime = 1_790_000_000 }) {
  const tx = clone(BURN);
  const ata = core.associatedTokenAddress(owner, MINT);
  tx.slot = slot;
  tx.blockTime = blockTime;
  tx.transaction.signatures = [signature];
  tx.transaction.message.accountKeys[0].pubkey = owner;
  tx.transaction.message.accountKeys[2].pubkey = ata;
  Object.assign(tx.transaction.message.instructions[0].parsed.info, { account: ata, authority: owner, amount });
  tx.transaction.message.instructions[1].parsed = memo;
  return tx;
}
const listed = (tx, memo) => ({
  signature: tx.transaction.signatures[0], slot: tx.slot, err: null, memo: `[${memo.length}] ${memo}`, blockTime: tx.blockTime, transactionIndex: 0,
  confirmationStatus: 'finalized',
});
const priceBody = (type) => `{"base_cost":1500,"burn_percentage":0.0,"cost":1500,"currency":"1DEV","mechanism":"burn","min_cost":300,"node_type":"${type}","phase":1,"savings":0,"universal_price":true}`;

// One Solana and one QNet network both clients read, and the site's real routes: `history` lists burns on the wallet's
// own addresses; `node` is the network's word at the site's reservation; `siteDown` makes aiqnet.io unreachable and
// `storeDown` its database.
function world({ history = [], txs = {}, node = { state: 'none' }, verified = false } = {}) {
  const seen = { sent: [], simulated: [], site: [] };
  const state = { history, node, siteDown: false, storeDown: false };
  const listing = (entries, query) => {
    if (query.commitment === 'confirmed') {
      const from = query.before ? entries.findIndex((e) => e.signature === query.before) + 1 : 0;
      return query.before && from === 0 ? [] : entries.slice(from, from + query.limit);
    }
    let start = query.before ? entries.findIndex((e) => e.signature === query.before) + 1 : 0;
    if (query.before && start === 0) return [];
    const stop = query.until ? entries.findIndex((e) => e.signature === query.until) : -1;
    const end = stop >= 0 ? stop : entries.length;
    start = Math.min(start, end);
    return entries.slice(start, Math.min(end, start + query.limit));
  };
  const methods = {
    getTokenSupply: () => ({ context: { slot: 1 }, value: { amount: '1', decimals: 6 } }),
    getTokenAccountsByOwner: ([owner]) => ({ context: { slot: 1 }, value: (owner === OWNER ? [ATA] : []).map((pubkey) => ({ pubkey, account: {} })) }),
    getSignaturesForAddress: ([address, query]) => (address === OWNER || address === ATA ? listing(state.history, query) : []),
    getTransaction: ([signature]) => {
      if (Object.hasOwn(txs, signature)) return txs[signature];
      const sent = seen.sent.find((s) => s.signature === signature);
      return sent ? burnJson({ signature, amount: sent.amount, memo: sent.memo }) : null;
    },
    getBalance: () => ({ context: { slot: 1 }, value: 1_000_000 }),
    getAccountInfo: ([address]) => ({
      context: { slot: 1 },
      value: address === ATA ? {
        owner: core.SOLANA_PROGRAMS.TOKEN, lamports: 2039280,
        data: { program: 'spl-token', parsed: { type: 'account', info: { mint: MINT, owner: OWNER, state: 'initialized', tokenAmount: { amount: '2000000000', decimals: 6 } } } },
      } : null,
    }),
    getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: 'DxsSCVwmXLXPmozkiERhuCEtEkMYpL6391F6GexS2yYM', lastValidBlockHeight: 99 } }),
    getBlockHeight: () => 0,
    getFeeForMessage: () => ({ context: { slot: 1 }, value: 5000 }),
    simulateTransaction: ([b64]) => {
      seen.simulated.push(b64);
      return { context: { slot: 1 }, value: { err: null, logs: [] } };
    },
    sendTransaction: ([b64]) => {
      const bytes = core.base64Decode(b64);
      const signature = core.base58Encode(bytes.slice(1, 65));
      const message = bytes.slice(65);
      let o = 4 + 32 * message[3] + 32 + 1 + 1;
      o += 1 + message[o];
      const data = message.slice(o + 1, o + 1 + message[o]);
      const amount = new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true).toString();
      seen.sent.push({ signature, amount, memo: new TextDecoder().decode(message.slice(message.length - 20)) });
      return signature;
    },
    getSignatureStatuses: ([[signature]]) => ({
      context: { slot: 1 },
      value: [seen.sent.some((s) => s.signature === signature) || Object.hasOwn(txs, signature) ? { err: null, confirmationStatus: 'finalized' } : null],
    }),
  };
  // The site's Solana client over the same chain.
  const rpc = async (method, params) => {
    if (!Object.hasOwn(methods, method)) throw new Error(`unexpected ${method}`);
    return methods[method](params);
  };
  const store = createMemoryStore();
  const guarded = new Proxy(store, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (state.storeDown) return Promise.reject(new StoreUnavailable(new Error('ECONNREFUSED')));
        return value.apply(target, args);
      };
    },
  });
  const registry = createActivationRegistry({ store: guarded, check: (burnTx, expect) => checkBurn(rpc, burnTx, expect) });
  const api = createActivationApi({
    registry, scope: `cross${Math.random()}`, devOrigins: false, clientKey: () => ({ ok: true, ip: '203.0.113.9' }),
    walletNode: async () => state.node, scan: createBurnScanner({ rpc }),
  });
  const site = async (request) => {
    const url = new URL(request.url);
    if (url.origin !== QNET.EXPLORER_API || !url.pathname.startsWith('/api/cabinet/activation/')) return undefined;
    if (state.siteDown) throw new TypeError('aiqnet.io down');
    const rest = url.pathname.slice('/api/cabinet/activation/'.length);
    seen.site.push(request.method === 'GET' ? 'get' : rest);
    const init = { method: request.method, headers: { ...request.headers, ...EXTENSION_HEADERS, host: 'aiqnet.io' } };
    if (request.method === 'POST') init.body = request.body;
    const req = new Request(request.url, init);
    if (request.method === 'GET') return api.get(req, decodeURIComponent(rest));
    return ['reserve', 'announce', 'release', 'record'].includes(rest) ? api[rest](req) : new Response('{}', { status: 404 });
  };
  const nodes = async (request) => {
    const url = new URL(request.url);
    if (!QNET.NODES.includes(url.origin)) return undefined;
    if (url.pathname === '/api/v1/activation/price') return { body: priceBody(url.searchParams.get('type')) };
    if (url.pathname === '/api/v1/verify-activation') return { body: { verified, authoritative: true } };
    if (url.pathname === '/api/v1/light-node/status' && request.method === 'GET') {
      return { body: { success: true, node_id: url.searchParams.get('node_id'), onchain_registered: false, registration_pending: false } };
    }
    return undefined;
  };
  installFetch(routes(nodes, site, solanaRoute(methods)));
  // A request of this site's own pages (the payment address, a typed address).
  const page = (path, body) => new Request(`https://aiqnet.io/api/cabinet/activation/${path}`, {
    method: 'POST', headers: { host: 'aiqnet.io', 'content-type': 'application/json', origin: 'https://aiqnet.io', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  });
  const read = async (wallet = W) => JSON.parse(await (await api.get(new Request(`https://aiqnet.io/api/cabinet/activation/${wallet}`, { headers: { host: 'aiqnet.io' } }), wallet)).text());
  const answer = async (res) => ({ status: res.status, body: JSON.parse(await res.text()) });
  return { seen, state, api, store, page, read, answer };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, String(error));
    return true;
  });
}
const light = (over = {}) => ({ nodeType: 'light', expectedPrice: 1500, ...over });
// The wallet's own keys (the public recovery-phrase test vector the extension's test environment holds).
const PAIR = core.deriveQnetKeypair(core.mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'));
// A reservation body of the site's payment address, with the wallet's signed reservation of its final fields (QNet
// Wallet signs it before the address exists, shared contract C1).
function paymentReserve(over = {}) {
  const body = { wallet: W, nodeType: 'light', way: 'payment', burner: PAYMENT, burnAmount: 1500, solana: null, ...over };
  const time = Math.floor(Date.now() / 1000);
  const envelope = burnRecordEnvelope(reservationMessage(body.wallet, body.nodeType, body.way, body.burner, time));
  const sig = ml_dsa65.sign(envelope, PAIR.secretKey, { context: new TextEncoder().encode(OFFCHAIN_CONTEXT) });
  return { ...body, proof: { pk: encodeB64url(PAIR.publicKey), sig: encodeB64url(sig), time } };
}

test('C1: the extension\'s own burn record text and proof are what the site verifies', () => {
  const fields = { wallet: W, nodeType: 'super', burner: OWNER, burnTx: core.KAT.activation.burnTx, burnAmount: 3000 };
  assert.equal(keysModule.burnRecordMessage(fields), burnRecordMessage(W, 'super', OWNER, fields.burnTx, 3000));
  assert.equal(RECORD_ORIGIN, 'https://aiqnet.io');
  // exactly the steps of keys.signBurnRecord, with the phrase's two keys: the dedicated site-record signer, which a
  // page's signMessage cannot reach (its prefix is refused there)
  const seed = core.mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const pair = core.deriveQnetKeypair(seed);
  const burner = core.deriveSolanaKeypair(seed);
  const message = keysModule.burnRecordMessage(fields);
  const signed = core.signSiteRecord(RECORD_ORIGIN, message, pair.secretKey, pair.publicKey);
  assert.throws(() => core.signOffchainMessage(RECORD_ORIGIN, message, pair.secretKey, pair.publicKey));
  const b64url = (bytes) => core.base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const proof = {
    pk: b64url(pair.publicKey), sig: b64url(signed.signature),
    solanaSig: core.base58Encode(core.signSolanaMessage(core.buildSiteRecord(RECORD_ORIGIN, message), burner.privateKey)),
  };
  assert.equal(verifyBurnRecordProof(fields, proof), true);
  const stranger = core.deriveQnetKeypair(core.mnemonicToSeed('legal winner thank year wave sausage worth useful legal winner thank yellow'));
  for (const [what, facts] of [['another wallet', { ...fields, wallet: stranger.address }], ['another node type', { ...fields, nodeType: 'light' }],
    ['another amount', { ...fields, burnAmount: 3001 }], ['another burner', { ...fields, burner: PAYMENT }]]) {
    assert.equal(verifyBurnRecordProof(facts, proof), false, what);
  }
  // The reservation the extension signs with the same signer (A1): what the site's reserve route verifies.
  const time = Math.floor(Date.now() / 1000);
  const held = { wallet: W, nodeType: 'super', way: 'extension', burner: OWNER };
  // The extension's own text of it (keys.signReservation signs keysModule.reservationMessage) is the site's.
  assert.equal(keysModule.reservationMessage({ ...held, time }), reservationMessage(W, 'super', 'extension', OWNER, time));
  const reservation = core.signSiteRecord(RECORD_ORIGIN, keysModule.reservationMessage({ ...held, time }), pair.secretKey, pair.publicKey);
  const reservationProof = { pk: b64url(pair.publicKey), sig: b64url(reservation.signature), time };
  assert.equal(verifyReservationProof(held, reservationProof, time), 'ok');
  assert.equal(verifyReservationProof({ ...held, nodeType: 'light' }, reservationProof, time), 'invalid');
  assert.throws(() => core.signOffchainMessage(RECORD_ORIGIN, reservationMessage(W, 'super', 'extension', OWNER, time), pair.secretKey, pair.publicKey));
});

test('R1, R6: the extension burns under the site\'s reservation; the site records it with the extension\'s code, and no client burns again', async () => {
  installEnv();
  const a = await extension();
  const w = world();
  const result = await a.burn(light());
  assert.equal(result.status, 'finalized');
  assert.equal(w.seen.sent.length, 1);
  const burnTx = w.seen.sent[0].signature;
  // reserve, announce with the proof the site verified, then the send; the record follows
  assert.deepEqual(w.seen.site.filter((r) => r !== 'get').slice(0, 2), ['reserve', 'announce']);
  await a.syncRecord();
  await flush();
  const body = await w.read();
  const record = parseActivationRecord(body, W);
  assert.ok(record, JSON.stringify(body));
  assert.deepEqual([record.state, record.nodeType, record.way, record.burner, record.burnTx, record.burnAmount], ['recorded', 'light', 'extension', OWNER, burnTx, 1500]);
  assert.equal(record.code, result.code, 'the site shows the code the extension stored');
  assert.equal(record.code, core.generateActivationCode('light', OWNER, burnTx, 1500));
  assert.notEqual(a.parseRecord(body, W), null, 'the extension reads the site\'s answer');

  // The site's payment address, and an extension burn for either node type, are refused by the site.
  assert.deepEqual((await w.answer(await w.api.reserve(w.page('reserve', paymentReserve())))).body.error, 'has_burn');
  for (const nodeType of ['light', 'super']) {
    const got = await w.answer(await w.api.reserve(w.page('reserve', paymentReserve({ nodeType, way: 'extension', burner: OWNER, solana: OWNER }))));
    assert.deepEqual([got.status, got.body.error], [409, 'has_burn'], nodeType);
  }

  // A reset and restore (an empty vault, a fresh worker) before Solana lists the burn on the wallet's address: the site's
  // record refuses a new burn of either type, nothing is signed; the popup's view adopts the recorded burn as the code.
  const env = installEnv();
  const b = await extension();
  await rejectsWith(b.burn(light()), 'ACTIVATION_RECORDED');
  await rejectsWith(b.burn(light({ nodeType: 'super' })), 'ACTIVATION_RECORDED');
  assert.equal(env.calls.signSolanaMessage + env.calls.signBurnRecord, 0);
  assert.equal(w.seen.sent.length, 1);
  const view = await b.lookup();
  assert.equal(view.view, 'activation');
  assert.equal(env.state().activation.code, result.code);

  // Once Solana lists it: a second install finds the burn itself, and answers the site without a window with the code
  // the site's check accepts.
  w.state.history = [listed(burnJson({ signature: burnTx }), 'QNET_NODE_TYPE:LIGHT')];
  const env2 = installEnv();
  const c = await extension();
  await rejectsWith(c.burn(light({ nodeType: 'super' })), 'BURN_EXISTS');
  let told = await c.siteActivation();
  for (let i = 0; i < 20 && told.status === 'searching'; i += 1) {
    await flush();
    told = await c.siteActivation();
  }
  assert.equal(told.status, 'exists');
  assert.deepEqual(validateGetActivation(told), told);
  assert.deepEqual([told.code, told.paidOnSite], [result.code, false]);
  assert.equal(env2.calls.signSolanaMessage, 0);
  assert.equal(w.seen.sent.length, 1, 'one burn in all');
});

test('R6: the site\'s payment address holds the wallet: the extension refuses both node types and signs nothing', async () => {
  const env = installEnv();
  const a = await extension();
  const w = world();
  const held = await w.answer(await w.api.reserve(w.page('reserve', paymentReserve())));
  assert.equal(held.status, 200);
  await rejectsWith(a.burn(light()), 'ACTIVATION_RESERVED');
  await rejectsWith(a.burn(light({ nodeType: 'super' })), 'ACTIVATION_RESERVED');
  await rejectsWith(a.activateForSite({ nodeType: 'super', expectedPrice: 1500 }), 'ACTIVATION_RESERVED');
  const shown = await a.siteView('light');
  assert.deepEqual([shown.mode, shown.reason], ['unavailable', 'ACTIVATION_RESERVED']);
  assert.equal(env.calls.signSolanaMessage + env.calls.signBurnRecord, 0);
  assert.equal(w.seen.sent.length + w.seen.simulated.length, 0);
  assert.equal(w.seen.site.includes('reserve'), false, 'refused on the record, before any reservation');
  assert.equal((await w.read()).state, 'reserved');
});

test('R6: the extension and the site\'s payment address at once: exactly one of them holds the wallet', async () => {
  for (let round = 0; round < 3; round += 1) {
    installEnv();
    const a = await extension();
    const w = world();
    // the payment address asks while the extension is in the middle of its checks
    const burning = a.burn(light()).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code }));
    for (let i = 0; i < round * 40; i += 1) await flush();
    const paid = await w.answer(await w.api.reserve(w.page('reserve', paymentReserve())));
    const ext = await burning;
    assert.equal(Number(ext.ok) + Number(paid.status === 200), 1, JSON.stringify({ ext, paid }));
    assert.equal(w.seen.sent.length, ext.ok ? 1 : 0);
    if (!ext.ok) assert.ok(['ACTIVATION_RESERVED', 'ACTIVATION_RECORDED'].includes(ext.code), ext.code);
    else assert.ok(['reserved', 'burn_pending', 'has_burn'].includes(paid.body.error), paid.body.error);
  }
});

test('R6: a site or a database that cannot answer, or a node the network knows, refuses the extension\'s burn before anything is signed', async () => {
  for (const [what, set, code] of [
    ['aiqnet.io unreachable', (w) => { w.state.siteDown = true; }, 'RECORD_UNAVAILABLE'],
    ['its database down', (w) => { w.state.storeDown = true; }, 'RECORD_UNAVAILABLE'],
    ['the network cannot say', (w) => { w.state.node = null; }, 'NETWORK'],
    ['a super node of the wallet', (w) => { w.state.node = { state: 'registered', nodeId: 'super_node_0123456789abcdef', nodeType: 'super' }; }, 'NODE_EXISTS'],
  ]) {
    const env = installEnv();
    const a = await extension();
    const w = world();
    set(w);
    await rejectsWith(a.burn(light()), code);
    assert.equal(env.calls.signSolanaMessage + env.calls.signBurnRecord, 0, what);
    assert.equal(w.seen.sent.length + w.seen.simulated.length, 0, what);
    w.state.storeDown = false;
    assert.equal((await w.read()).state, 'none', `${what}: no reservation left behind`);
  }
});

test('C1, C3.5: nobody plants a record with a proof made for another wallet or another burn', async () => {
  installEnv();
  const a = await extension();
  const w = world();
  await a.burn(light());
  const burnTx = w.seen.sent[0].signature;
  const env = globalThis.__qnetChainsEnv;
  const proof = await env.keys.signBurnRecord({ wallet: W, nodeType: 'light', burner: OWNER, burnTx, burnAmount: 1500 });
  const stranger = core.deriveQnetKeypair(core.mnemonicToSeed('legal winner thank year wave sausage worth useful legal winner thank yellow')).address;
  const post = (body) => new Request('https://aiqnet.io/api/cabinet/activation/record', {
    method: 'POST', headers: { host: 'aiqnet.io', 'content-type': 'application/json', ...EXTENSION_HEADERS }, body: JSON.stringify(body),
  });
  const base = { wallet: W, nodeType: 'light', burner: OWNER, burnTx, burnAmount: 1500, proof };
  for (const [what, body] of [['another wallet', { ...base, wallet: stranger }], ['another node type', { ...base, nodeType: 'super' }],
    ['another amount', { ...base, burnAmount: 1501 }], ['another burner', { ...base, burner: PAYMENT }]]) {
    const got = await w.answer(await w.api.record(post(body)));
    assert.deepEqual([got.status, got.body.error], [400, 'invalid_proof'], what);
  }
  assert.equal((await w.read(stranger)).state, 'none', 'nothing recorded for the other wallet');
  // The wallet's own proof again: the same record, idempotent.
  const again = await w.answer(await w.api.record(post(base)));
  assert.deepEqual([again.status, again.body.state, again.body.burnTx], [200, 'recorded', burnTx]);
});

test('C5: the extension\'s answer for a light node the site\'s payment address paid for passes the site\'s check, and the site records nothing for it', async () => {
  const burnTx = core.KAT.activation.burnTx;
  const code = core.walletActivationCode(W, burnTx, 1500);
  const activation = { code, nodeType: 'light', burnTx, burnAmount: 1500, solanaAddress: PAYMENT, cluster: SOLANA.CLUSTER, createdAt: 1_790_000_000_000 };
  const registration = {
    nodeId: core.lightNodeId(W), burnTx, burner: PAYMENT, state: 'onchain', attempts: 0, nextAt: 0, txHash: null, admittedAt: null, lastError: null, updatedAt: 1,
  };
  const env = installEnv();
  env.setState({ ...env.state(), activation, registration });
  const a = await extension();
  const w = world();
  const told = await a.siteActivation();
  assert.deepEqual(validateGetActivation(told), told);
  assert.deepEqual([told.status, told.paidOnSite, told.code], ['exists', true, code]);
  await a.syncRecord();
  await flush();
  assert.equal(w.seen.site.includes('record'), false, 'a payment burn is recorded by the site itself, with its owner bind');
  assert.equal(env.calls.signBurnRecord, 0);
});
