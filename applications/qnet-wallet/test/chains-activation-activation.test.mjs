// activation.js, offline: the node price (no fallback, phase 1 only, integers only), the one-code-per-
// wallet refusals in their contract order, the burn from price to stored code, the pending burn, and
// Recover (oldest valid burn, never a second code). Solana and the nodes are simulated; nothing is signed
// on any chain.
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./helpers/chains-activation-loader.mjs', import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
const core = await import('../dist/lib/qnet-core.js');
const { QNET, SOLANA } = await import('../dist/background/config.js');
const { WalletError } = await import('../dist/background/errors.js');
const { setViewBroadcaster } = await import('../dist/background/events.js');
const {
  WALLET, installEnv, installFetch, emptyState, solanaRoute, routes, fakeSignature, flush,
} = await import('./helpers/chains-activation-env.mjs');
const activation = await import('../dist/background/activation.js');
const { createCabinet, proofValid, reservationProofValid } = await import('./helpers/cabinet-server.mjs');
// An independent verifier of the burn record's proof (decision 35): the audited libraries the bundle is built from.
const NOBLE = new URL('../tools/crypto-bundle/node_modules/@noble/', import.meta.url);
const noble = existsSync(new URL('post-quantum/ml-dsa.js', NOBLE)) ? await import(new URL('post-quantum/ml-dsa.js', NOBLE).href) : null;
const curves = noble ? await import(new URL('curves/ed25519.js', NOBLE).href) : null;

const MINT = SOLANA.ONE_DEV_MINT;
const OWNER = WALLET.solanaAddress;
const ATA = core.associatedTokenAddress(OWNER, MINT);
// Somebody else's Solana address (the key of another public recovery-phrase test vector): the signer of poisoned mentions.
const STRANGER = core.deriveSolanaKeypair(core.mnemonicToSeed(
  'legal winner thank year wave sausage worth useful legal winner thank yellow')).address;
// The same phrase's QNet address: another wallet.
const STRANGER_QNET = core.deriveQnetKeypair(core.mnemonicToSeed(
  'legal winner thank year wave sausage worth useful legal winner thank yellow')).address;
const BURN = fixture('devnet_burn_tx_nqh74h.json').result;
const BLOCKHASH = 'DxsSCVwmXLXPmozkiERhuCEtEkMYpL6391F6GexS2yYM';
const clone = (v) => JSON.parse(JSON.stringify(v));
const MEMO_OF = { light: 'QNET_NODE_TYPE:LIGHT', super: 'QNET_NODE_TYPE:SUPER' };

const viewEvents = [];
setViewBroadcaster((event) => viewEvents.push(event));

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WalletError || error?.name === 'CoreError', `${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

// What the router lets out (CONTRACTS.md section 1, Results): JSON data, no secret key names but `code`
// where the type allows it.
const SECRET_KEYS = ['mnemonic', 'phrase', 'entropy', 'seed', 'xi', 'secretKey', 'privateKey', 'key', 'vaultKey', 'sitesKey', 'password', 'newPassword', 'code'];
function assertSafeResult(value, allowed = []) {
  const walk = (node, depth) => {
    assert.ok(depth <= 8, 'too deep');
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return;
    if (typeof node === 'number') return assert.ok(Number.isFinite(node));
    assert.equal(typeof node, 'object', `not JSON data: ${typeof node}`);
    if (Array.isArray(node)) return node.forEach((v) => walk(v, depth + 1));
    assert.equal(Object.getPrototypeOf(node), Object.prototype);
    for (const [k, v] of Object.entries(node)) {
      assert.ok(!SECRET_KEYS.includes(k) || allowed.includes(k), `secret key ${k}`);
      walk(v, depth + 1);
    }
  };
  walk(value, 0);
}

// A jsonParsed finalized burn of `owner`, built from the recorded devnet burn.
function burnJson({ signature, owner = OWNER, amount = '1500000000', memo = MEMO_OF.light, slot = 510_000_000, blockTime = 1790000000 }) {
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

const listed = (tx, memo = MEMO_OF.light, confirmationStatus = 'finalized') => ({
  signature: tx.transaction.signatures[0], slot: tx.slot, err: null, memo: `[${memo.length}] ${memo}`, blockTime: tx.blockTime, transactionIndex: 0,
  confirmationStatus,
});

const priceBody = (type, { phase = 1, cost = 1500, currency = phase === 1 ? '1DEV' : 'QNC' } = {}) => (
  `{"base_cost":1500,"burn_percentage":0.0,"cost":${cost},"currency":"${currency}","mechanism":"burn","min_cost":300,"node_type":"${type}","phase":${phase},"savings":0,"universal_price":true}`);

/**
 * A simulated network around the KAT wallet. Options change one fact each; `seen` records what the code
 * did (simulations, sends, requests per endpoint).
 */
function world(options = {}) {
  const {
    lamports = 1_000_000, oneDevRaw = '2000000000', history = [], txs = {}, price = () => ({}), verify = () => ({ verified: false, authoritative: true }),
    statuses = () => 'finalized', simulateErr = null, sendError = null, listing = null, blockHeight = 0,
    otherAccounts = {}, otherHistories = {}, signedHistory = {}, signedListing = null, registered = () => null,
    lightStatus = () => ({}),
    cabinet = null,
  } = options;
  const seen = {
    simulated: [], sent: [], priceCalls: 0, verifyCalls: [], statusCalls: 0, listings: 0, heightCalls: 0, accountQueries: [], otherListings: 0,
    signedListings: 0, statusRequests: [], lightStatusCalls: [],
  };
  // The history of an owner's own address (the transactions it signed or that mention it: R5-ESA-01): every burn of
  // its 1DEV associated account is one it signed, so that account's entries list there too, with signedHistory's
  // (burns from its other token accounts, or anything else naming the owner), newest first.
  const signedEntries = (owner) => [...(owner === OWNER ? history : []), ...(signedHistory[owner] ?? [])]
    .map((entry, index) => ({ entry, index })).sort((a, b) => (b.entry.slot - a.entry.slot) || (a.index - b.index)).map(({ entry }) => entry);
  const page = (entries, query) => {
    if (query.commitment === 'confirmed') {
      const from = query.before ? entries.findIndex((e) => e.signature === query.before) + 1 : 0;
      return query.before && from === 0 ? [] : entries.slice(from, from + query.limit);
    }
    const final = entries.filter((entry) => (entry.confirmationStatus ?? 'finalized') === 'finalized');
    let start = query.before ? final.findIndex((e) => e.signature === query.before) + 1 : 0;
    if (query.before && start === 0) return [];
    const stop = query.until ? final.findIndex((e) => e.signature === query.until) : -1;
    const end = stop >= 0 ? stop : final.length;
    start = Math.min(start, end);
    return final.slice(start, Math.min(end, start + query.limit));
  };
  const node = async (request) => {
    const url = new URL(request.url);
    if (!QNET.NODES.includes(url.origin)) return undefined;
    if (url.pathname === '/api/v1/activation/price') {
      seen.priceCalls++;
      const type = url.searchParams.get('type');
      const answer = price(type, url.origin);
      if (answer === null) throw new TypeError('node down');
      return { body: typeof answer === 'string' ? answer : priceBody(type, answer) };
    }
    if (url.pathname === '/api/v1/verify-activation') {
      seen.verifyCalls.push({ node: url.origin, wallet: request.headers['x-qnet-wallet'], url: request.url });
      const answer = verify(url.origin);
      if (answer === null) throw new TypeError('node down');
      return { body: answer };
    }
    // the public status of the wallet's light node (lightStatus(node) → fields over "not on chain, nothing pending", or
    // null for a node that does not answer), the last check before a burn (EXT-R1-01)
    if (url.pathname === '/api/v1/light-node/status' && request.method === 'GET') {
      const nodeId = url.searchParams.get('node_id');
      seen.lightStatusCalls.push({ node: url.origin, nodeId });
      const answer = lightStatus(url.origin, nodeId);
      if (answer === null) throw new TypeError('node down');
      return { body: { success: true, node_id: nodeId, onchain_registered: false, registration_pending: false, ...answer } };
    }
    // the signed status of the wallet's light node: the registration record with the burn that registered it
    // (registered(node) → that burn's signature, or null for a node the chain does not list)
    if (url.pathname === '/api/v1/light-node/status' && request.method === 'POST') {
      const body = JSON.parse(request.body);
      seen.statusRequests.push({ node: url.origin, body });
      const burnTx = registered(url.origin);
      return {
        body: burnTx === null ? { success: false, reason: 'not_registered' }
          : { success: true, node_id: body.node_id, onchain_registered: true, registered_height: 100, burn_tx: burnTx },
      };
    }
    return undefined;
  };
  const methods = {
    getTokenSupply: () => ({ context: { slot: 1 }, value: { amount: '1', decimals: 6 } }),
    // the history of the wallet's 1DEV account, newest first: at 'finalized' only what Solana finalized
    // (before/until exclusive, limit), at 'confirmed' the newest page with its young entries too
    // the 1DEV token accounts of an owner (otherAccounts: owner → accounts besides its associated one: R4-ESA-01)
    getTokenAccountsByOwner: ([owner, filter, config]) => {
      assert.equal(filter.mint, MINT);
      seen.accountQueries.push({ owner, commitment: config.commitment });
      const own = owner === OWNER && oneDevRaw !== null ? [ATA] : [];
      return { context: { slot: 1 }, value: [...own, ...(otherAccounts[owner] ?? [])].map((pubkey) => ({ pubkey, account: {} })) };
    },
    getSignaturesForAddress: ([address, query]) => {
      if (Object.hasOwn(otherHistories, address)) {
        seen.otherListings++;
        return query.before ? [] : otherHistories[address].slice(0, query.limit);
      }
      if (address === OWNER) {
        seen.signedListings++;
        if (signedListing) return signedListing(query, address);
        return page(signedEntries(address), query);
      }
      assert.ok(address === ATA, 'the burn search lists the 1DEV account or the owner');
      seen.listings++;
      if (listing) return listing(query, address);
      return page(history, query);
    },
    getTransaction: ([signature]) => {
      if (Object.hasOwn(txs, signature)) return txs[signature];
      const sent = seen.sent.find((s) => s.signature === signature);
      return sent ? burnJson({ signature, amount: sent.amount, memo: sent.memo }) : null;
    },
    getBalance: () => ({ context: { slot: 1 }, value: lamports }),
    getAccountInfo: ([address]) => ({
      context: { slot: 1 },
      value: address === ATA && oneDevRaw !== null ? {
        owner: core.SOLANA_PROGRAMS.TOKEN, lamports: 2039280,
        data: { program: 'spl-token', parsed: { type: 'account', info: { mint: MINT, owner: OWNER, state: 'initialized', tokenAmount: { amount: oneDevRaw, decimals: 6 } } } },
      } : null,
    }),
    getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 99 } }),
    getBlockHeight: ([query]) => {
      assert.equal(query.commitment, 'finalized');
      seen.heightCalls++;
      return typeof blockHeight === 'function' ? blockHeight() : blockHeight;
    },
    getFeeForMessage: () => ({ context: { slot: 1 }, value: 5000 }),
    simulateTransaction: ([b64, opts]) => {
      seen.simulated.push({ b64, opts });
      return { context: { slot: 1 }, value: { err: simulateErr, logs: [] } };
    },
    sendTransaction: ([b64]) => {
      const bytes = core.base64Decode(b64);
      const signature = core.base58Encode(bytes.slice(1, 65));
      // the burn amount and memo as the transaction carries them
      const message = bytes.slice(65);
      const keyCount = message[3];
      let o = 4 + 32 * keyCount + 32 + 1;
      o += 1;
      const accounts = message[o];
      o += 1 + accounts;
      const dataLength = message[o];
      const data = message.slice(o + 1, o + 1 + dataLength);
      const amount = new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true).toString();
      const memo = new TextDecoder().decode(message.slice(message.length - 20));
      seen.sent.push({ b64, signature, amount, memo, burnOpcode: data[0] });
      if (sendError) return { rpcError: sendError };
      return signature;
    },
    getSignatureStatuses: ([[signature]]) => {
      seen.statusCalls++;
      const status = statuses(signature, seen.statusCalls);
      if (status === null) return { context: { slot: 1 }, value: [null] };
      if (status === 'failed') return { context: { slot: 1 }, value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] };
      return { context: { slot: 1 }, value: [{ err: null, confirmationStatus: status }] };
    },
  };
  // aiqnet.io's record of the wallet's burns (decision 35): a burn this world sent or holds is final there
  const site = cabinet ?? createCabinet({
    landed: (burnTx) => (seen.sent.some((sent) => sent.signature === burnTx) || Object.hasOwn(txs, burnTx) ? 'final' : 'unknown'),
  });
  const requests = installFetch(routes(node, (request) => site.route(request), solanaRoute(methods)));
  return { seen, requests, methods, cabinet: site };
}

const solanaCalls = (requests) => requests.filter((r) => SOLANA.RPC_URLS.includes(r.url)).map((r) => JSON.parse(r.body).method);

describe('chains-activation activation: code helpers', () => {
  // aiqnet.io's answer about a wallet (decision 35), with the states decision 36 left: a payment address's burn is on its
  // way or recorded for good, and no record waits for a consent any more
  it('reads aiqnet.io\'s record key by key; a state it does not know, the retired "burned" among them, is no answer', () => {
    const W = WALLET.qnetAddress;
    const burnTx = fakeSignature(4000);
    const body = (fields) => ({
      wallet: W, state: 'none', nodeType: null, way: null, burner: null, burnTx: null, burnAmount: null, code: null, until: null,
      recordedAt: null, scan: null, ...fields,
    });
    assert.deepEqual(activation.parseRecord(body({}), W), { state: 'none' });
    const payment = { nodeType: 'light', way: 'payment', burner: STRANGER, burnTx, burnAmount: 1500 };
    assert.equal(activation.parseRecord(body({ ...payment, state: 'sending', until: 1 }), W)?.state, 'sending');
    assert.equal(activation.parseRecord(body({ ...payment, state: 'recorded', code: 'x', recordedAt: 2 }), W)?.state, 'recorded');
    assert.equal(activation.parseRecord(body({ ...payment, state: 'burned', until: 1 }), W), null, 'burned is no state any more');
    assert.equal(activation.parseRecord(body({ ...payment, nodeType: 'super', state: 'sending', until: 1 }), W), null, 'a payment burn is light');
    assert.equal(activation.parseRecord(body({ state: 'reserved', nodeType: 'light', way: 'extension', burnAmount: 1500, until: 1 }), W)?.state,
      'reserved');
    assert.equal(activation.parseRecord(body({}), STRANGER_QNET), null, 'another wallet');
  });

  it('masks all but the type letter and the last two characters', () => {
    assert.equal(activation.maskCode('QNET-LFEFD9-706058-537636'), 'QNET-L•••••-••••••-••••36');
    assert.equal(activation.maskCode('short'), '');
    const view = activation.publicActivation({
      code: 'QNET-LFEFD9-706058-537636', nodeType: 'light', burnTx: 'x', burnAmount: 1500, solanaAddress: OWNER, cluster: 'devnet', createdAt: 1,
    });
    assert.equal(view.codeMasked, 'QNET-L•••••-••••••-••••36');
    assert.equal('code' in view, false);
  });
});

describe('chains-activation activation: price', () => {
  beforeEach(() => installEnv());

  it('reads both node types from the node, phase 1 in whole 1DEV', async () => {
    const { seen } = world();
    const quote = await activation.getPrice();
    assert.equal(quote.phase, 1);
    assert.deepEqual(quote.light, { cost: 1500 });
    assert.deepEqual(quote.super, { cost: 1500 });
    assert.ok(Number.isSafeInteger(quote.fetchedAt));
    assert.equal(seen.priceCalls, 2);
    assertSafeResult(quote);
  });

  it('reports phase 2 as such (the burn refuses it)', async () => {
    world({ price: () => ({ phase: 2, cost: 5000 }) });
    assert.equal((await activation.getPrice()).phase, 2);
  });

  const refusals = {
    'a non-integer cost': () => ({ cost: '1500.5' }),
    'a zero cost': () => ({ cost: 0 }),
    'a huge cost': () => ({ cost: 10_000_000_000 }),
    'the node\'s error answer': () => '{"error":"Activation price unavailable: supply read failed","retryable":true}',
    'phase 1 priced in another currency': () => ({ currency: 'QNC' }),
    'an unknown phase': () => ({ phase: 3 }),
    'another node type echoed': (type) => priceBody(type === 'light' ? 'super' : 'light'),
    'different phases per type': (type) => ({ phase: type === 'light' ? 1 : 2 }),
    'no node answering': () => null,
    'not JSON': () => '<html>',
  };
  for (const [name, price] of Object.entries(refusals)) {
    it(`refuses ${name}: no fallback number`, async () => {
      world({ price });
      await rejectsWith(activation.getPrice(), 'PRICE_UNAVAILABLE');
    });
  }
});

describe('chains-activation activation: burn', () => {
  beforeEach(() => {
    viewEvents.length = 0;
  });

  it('burns the node price from the wallet and stores exactly one code', async () => {
    const env = installEnv();
    const { seen, requests } = world();
    const result = await activation.burn({ nodeType: 'light', expectedPrice: 1500 });

    assert.equal(seen.sent.length, 1);
    const [sent] = seen.sent;
    assert.equal(seen.simulated.length, 1);
    assert.equal(seen.simulated[0].b64, sent.b64, 'the simulated bytes are the sent bytes');
    assert.equal(seen.simulated[0].opts.sigVerify, true);
    assert.equal(sent.burnOpcode, 8, 'SPL Burn, not BurnChecked');
    assert.equal(sent.amount, '1500000000');
    assert.equal(sent.memo, 'QNET_NODE_TYPE:LIGHT');

    const code = core.generateActivationCode('light', OWNER, sent.signature, 1500);
    assert.deepEqual(result, {
      status: 'finalized',
      code,
      activation: {
        nodeType: 'light', burnTx: sent.signature, burnAmount: 1500, solanaAddress: OWNER, cluster: SOLANA.CLUSTER,
        createdAt: result.activation.createdAt, codeMasked: activation.maskCode(code), paidOnSite: false,
      },
      superseded: null,
    });
    assertSafeResult(result, ['code']);
    const state = env.state();
    assert.deepEqual(state.activation, {
      code, nodeType: 'light', burnTx: sent.signature, burnAmount: 1500, solanaAddress: OWNER, cluster: SOLANA.CLUSTER, createdAt: result.activation.createdAt,
    });
    assert.equal(state.pendingBurn, null);
    // stored with its registration on the QNet network queued, in the same vault update (nodes.js records it)
    assert.deepEqual({ ...state.registration, nextAt: 0, updatedAt: 0 }, {
      nodeId: core.lightNodeId(WALLET.qnetAddress), burnTx: sent.signature, burner: OWNER, state: 'queued', attempts: 0, nextAt: 0,
      txHash: null, admittedAt: null, lastError: null, updatedAt: 0,
    });
    assert.equal(env.stateHistory.find((s) => s.activation !== null).registration.burnTx, sent.signature);
    // the pending record existed before the send
    assert.equal(env.stateHistory[0].pendingBurn.burnTx, sent.signature);
    assert.equal(env.stateHistory[0].activation, null);
    assert.equal(env.calls.verifyPassword, 0, 'no password: the unlocked session and the popup’s acknowledged press (decision 33)');
    assert.equal(env.calls.touch, 1);
    assert.ok(viewEvents.filter((e) => e === 'activation').length >= 2);
    // price from two different nodes, the node check with the wallet in the header only
    assert.ok(seen.priceCalls >= 2);
    assert.equal(seen.verifyCalls[0].wallet, WALLET.qnetAddress);
    assert.equal(new URL(seen.verifyCalls[0].url).search, '');
    const calls = solanaCalls(requests);
    assert.ok(calls.indexOf('getSignaturesForAddress') < calls.indexOf('simulateTransaction'));
    assert.ok(calls.indexOf('simulateTransaction') < calls.indexOf('sendTransaction'));
  });

  it('a super burn carries the super memo and a super code', async () => {
    const env = installEnv();
    const { seen } = world();
    const result = await activation.burn({ nodeType: 'super', expectedPrice: 1500 });
    assert.equal(seen.sent[0].memo, 'QNET_NODE_TYPE:SUPER');
    assert.match(result.code, /^QNET-S/);
    assert.equal(env.state().activation.nodeType, 'super');
  });

  it('checks the node type and the price before anything else, and refuses while locked', async () => {
    const env = installEnv();
    const { requests } = world();
    await rejectsWith(activation.burn({ nodeType: 'full', expectedPrice: 1500 }), 'INVALID_NODE_TYPE');
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500.5 }), 'INVALID_PARAMS');
    env.locked = true;
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'LOCKED');
    assert.equal(requests.length, 0);
    assert.equal(env.calls.signSolanaMessage, 0);
    assert.equal(env.calls.verifyPassword, 0);
  });

  it('one code per wallet: an activation or a pending burn in the vault refuses before any network', async () => {
    const code = core.generateActivationCode('light', OWNER, fakeSignature(1), 1500);
    installEnv({
      state: { ...emptyState(), activation: { code, nodeType: 'light', burnTx: fakeSignature(1), burnAmount: 1500, solanaAddress: OWNER, cluster: 'devnet', createdAt: 1 } },
    });
    let { requests } = world();
    await rejectsWith(activation.burn({ nodeType: 'super', expectedPrice: 1500 }), 'ALREADY_ACTIVATED');
    assert.equal(requests.length, 0);
    installEnv({
      state: {
        ...emptyState(),
        pendingBurn: { burnTx: fakeSignature(2), nodeType: 'light', burnAmount: 1500, solanaAddress: OWNER, cluster: 'devnet', createdAt: Date.now(), lastValidBlockHeight: 1 },
      },
    });
    ({ requests } = world());
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'BURN_IN_PROGRESS');
    assert.equal(requests.length, 0);
  });

  it('one code per wallet: a valid burn already on chain refuses and points to Recover', async () => {
    const env = installEnv();
    const earlier = burnJson({ signature: fakeSignature(3), memo: MEMO_OF.super, amount: '300000000' });
    const { seen } = world({ history: [listed(earlier, MEMO_OF.super)], txs: { [fakeSignature(3)]: earlier } });
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'BURN_EXISTS');
    assert.equal(seen.sent.length, 0);
    assert.equal(env.calls.signSolanaMessage, 0);
  });

  it('one code per wallet: a history that cannot be fully read refuses', async () => {
    const env = installEnv();
    let page = 0;
    const listing = () => {
      page++;
      return Array.from({ length: 1000 }, (_, i) => ({ signature: `plain-${page}-${i}`, slot: 1, err: null, memo: null }));
    };
    const { seen } = world({ listing });
    // a history too long for one search: its own code, and what was listed is kept for the next try
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'HISTORY_TOO_LONG');
    // the budget's pages, then the in-flight check's (at most 20; this listing never reaches the kept head)
    assert.ok(seen.listings >= 400 && seen.listings <= 421, String(seen.listings));
    assert.equal(seen.sent.length, 0);
    assert.ok(env.burnScans[OWNER].tail, 'the search is kept (R2-ESA-02)');
    installEnv();
    const unreadable = world({ history: [listed(burnJson({ signature: fakeSignature(4) }))] });
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'SOLANA_UNAVAILABLE');
    assert.equal(unreadable.seen.sent.length, 0);
  });

  it('one code per wallet: a node that knows a node for this wallet refuses; a lagging "no" alone is no proof', async () => {
    installEnv();
    let { seen } = world({ verify: () => ({ verified: true, source: 'storage_index', node_id: 'light_x', wallet_address: WALLET.qnetAddress }) });
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'NODE_EXISTS');
    assert.equal(seen.sent.length, 0);
    // every node behind the network: nothing vouches that the wallet has no node, so nothing is burned (EXT-R1-01)
    installEnv();
    ({ seen } = world({ verify: () => ({ verified: false, authoritative: false }) }));
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'NETWORK');
    assert.equal(seen.sent.length + seen.simulated.length, 0);
    assert.equal(seen.verifyCalls.length, QNET.NODES.length, 'every pinned node is asked before it gives up');
    // one node behind, the others at the network's height: their authoritative "no" lets the burn go on
    installEnv();
    const [lagging] = QNET.NODES;
    ({ seen } = world({ verify: (node) => ({ verified: false, authoritative: node !== lagging }) }));
    assert.equal((await activation.burn({ nodeType: 'light', expectedPrice: 1500 })).status, 'finalized');
    assert.ok(seen.lightStatusCalls.length >= 2, 'the light node itself was asked about');
    assert.ok(seen.lightStatusCalls.every((call) => call.nodeId === core.lightNodeId(WALLET.qnetAddress)));
  });

  const priceCases = {
    PHASE_UNSUPPORTED: { price: () => ({ phase: 2, cost: 1500 }) },
    PRICE_UNAVAILABLE: { price: () => ({ cost: '1500.0' }) },
    PRICE_CHANGED: { price: () => ({ cost: 1400 }) },
  };
  for (const [code, options] of Object.entries(priceCases)) {
    it(`re-fetches the price and refuses: ${code}`, async () => {
      installEnv();
      const { seen } = world(options);
      await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), code);
      assert.equal(seen.sent.length, 0);
    });
  }

  it('two nodes quoting different prices is PRICE_UNAVAILABLE', async () => {
    installEnv();
    const costs = new Map(QNET.NODES.map((n, i) => [n, 1500 - i * 100]));
    const { seen } = world({ price: (type, node) => ({ cost: costs.get(node) }) });
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'PRICE_UNAVAILABLE');
    assert.equal(seen.sent.length, 0);
  });

  it('checks SOL for the fee buffer plus the fee, and 1DEV for the price', async () => {
    installEnv();
    let { seen } = world({ lamports: SOLANA.FEE_BUFFER_LAMPORTS + 4999 });
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'INSUFFICIENT_SOL');
    installEnv();
    ({ seen } = world({ oneDevRaw: '1499999999' }));
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'INSUFFICIENT_TOKENS');
    installEnv();
    ({ seen } = world({ oneDevRaw: null }));
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'INSUFFICIENT_TOKENS');
    assert.equal(seen.simulated.length, 0);
  });

  it('a failed simulation stores nothing and sends nothing', async () => {
    const env = installEnv();
    const { seen } = world({ simulateErr: { InstructionError: [0, { Custom: 1 }] } });
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'SIMULATION_FAILED');
    assert.equal(seen.sent.length, 0);
    assert.deepEqual(env.state(), emptyState());
  });

  it('a burn that fails on chain yields no code and clears its pending record', async () => {
    const env = installEnv();
    world({ statuses: () => 'failed' });
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'TX_FAILED');
    assert.deepEqual(env.state(), emptyState());
    const refused = installEnv();
    world({ sendError: { code: -32002, message: 'Transaction simulation failed' }, statuses: () => null });
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'SIMULATION_FAILED');
    assert.deepEqual(refused.state(), emptyState());
  });

  it('single flight: a second burn or a Recover while one runs is BURN_IN_PROGRESS', async () => {
    installEnv();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { seen } = world({ listing: async () => {
      await gate;
      return [];
    } });
    const first = activation.burn({ nodeType: 'light', expectedPrice: 1500 });
    await flush();
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'BURN_IN_PROGRESS');
    await rejectsWith(activation.recover(), 'BURN_IN_PROGRESS');
    assert.equal((await activation.getStatus()).busy, true);
    release();
    assert.equal((await first).status, 'finalized');
    assert.equal(seen.sent.length, 1);
    assert.equal((await activation.getStatus()).busy, false);
  });

  it('refuses while locked', async () => {
    installEnv({ locked: true });
    world();
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'LOCKED');
  });

  it('a burn not final by the deadline stays pending, and activation.status settles it later', async () => {
    const env = installEnv();
    let final = false;
    const { seen } = world({ statuses: () => (final ? 'finalized' : 'confirmed') });
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    let result;
    try {
      const running = activation.burn({ nodeType: 'light', expectedPrice: 1500 }).then((r) => {
        result = r;
      }, (e) => {
        result = e;
      });
      for (let i = 0; i < 200 && result === undefined; i++) {
        await flush(3);
        mock.timers.tick(2000);
      }
      await running;
    } finally {
      mock.timers.reset();
    }
    const signature = seen.sent[0].signature;
    assert.deepEqual(result, { status: 'pending', burnTx: signature });
    assert.equal(env.state().activation, null);
    assert.equal(env.state().pendingBurn.burnTx, signature);

    const pendingView = await activation.getStatus();
    assert.equal(pendingView.activation, null);
    const { lastValidBlockHeight, ...shown } = env.state().pendingBurn;
    assert.equal(lastValidBlockHeight, 99, 'the expiry of its blockhash is kept with the record (EXT-CHAINS-03)');
    assert.deepEqual(pendingView.pending, shown);
    assert.equal(pendingView.busy, false);
    assertSafeResult(pendingView);

    final = true;
    const settled = await activation.getStatus();
    assert.equal(settled.pending, null);
    assert.equal(settled.activation.burnTx, signature);
    assert.equal(env.state().activation.code, core.generateActivationCode('light', OWNER, signature, 1500));
    assertSafeResult(settled);
    assert.equal('code' in settled.activation, false);
  });
});

describe('chains-activation activation: pending burn check', () => {
  const pendingState = (createdAt, lastValidBlockHeight = 1000) => ({
    ...emptyState(),
    pendingBurn: {
      burnTx: fakeSignature(40), nodeType: 'light', burnAmount: 1500, solanaAddress: OWNER, cluster: 'devnet', createdAt, lastValidBlockHeight,
    },
  });

  it('failed on chain: cleared', async () => {
    const env = installEnv({ state: pendingState(Date.now()) });
    world({ statuses: () => 'failed' });
    const view = await activation.getStatus();
    assert.equal(view.pending, null);
    assert.equal(env.state().pendingBurn, null);
  });

  it('never seen: kept until the finalized height passes its lastValidBlockHeight, whatever the clock says (EXT-CHAINS-03)', async () => {
    // a slow cluster: ten minutes on, the blockhash can still land
    let env = installEnv({ state: pendingState(Date.now() - 10 * 60_000) });
    let net = world({ statuses: () => null, blockHeight: 1000 });
    assert.notEqual((await activation.getStatus()).pending, null);
    assert.equal(net.seen.heightCalls, 1);
    // past it and still unseen after the height was read: it can never land
    env = installEnv({ state: pendingState(Date.now() - 30_000) });
    net = world({ statuses: () => null, blockHeight: 1001 });
    assert.equal((await activation.getStatus()).pending, null);
    assert.equal(env.state().pendingBurn, null);
    assert.equal(net.seen.statusCalls, 2, 'the status is asked again after the height');
    // it landed just in time: the second look finds it, and the code is stored
    env = installEnv({ state: pendingState(Date.now()) });
    world({
      statuses: (signature, call) => (call === 1 ? null : 'finalized'),
      blockHeight: 1001,
      txs: { [fakeSignature(40)]: burnJson({ signature: fakeSignature(40) }) },
    });
    const view = await activation.getStatus();
    assert.equal(view.pending, null);
    assert.equal(view.activation.burnTx, fakeSignature(40));
  });

  it('a record written before the height was kept falls back to a long wall-clock bound', async () => {
    let env = installEnv({ state: pendingState(Date.now() - 10 * 60_000, null) });
    let net = world({ statuses: () => null });
    assert.notEqual((await activation.getStatus()).pending, null);
    assert.equal(net.seen.heightCalls, 0);
    env = installEnv({ state: pendingState(Date.now() - 2 * 60 * 60_000, null) });
    net = world({ statuses: () => null });
    assert.equal((await activation.getStatus()).pending, null);
    assert.equal(env.state().pendingBurn, null);
  });

  it('a Solana outage leaves it as it is and still answers', async () => {
    const env = installEnv({ state: pendingState(Date.now() - 10 * 60_000) });
    installFetch(() => {
      throw new TypeError('offline');
    });
    const view = await activation.getStatus();
    assert.notEqual(view.pending, null);
    assert.notEqual(env.state().pendingBurn, null);
  });

  it('finalized but not the burn it claims to be: no code, and the record keeps blocking a second burn', async () => {
    const env = installEnv({ state: pendingState(Date.now()) });
    const wrong = burnJson({ signature: fakeSignature(40), amount: '300000000' });
    world({ statuses: () => 'finalized', txs: { [fakeSignature(40)]: wrong } });
    const view = await activation.getStatus();
    assert.equal(view.activation, null);
    assert.notEqual(env.state().pendingBurn, null);
  });
});

describe('chains-activation activation: recover and copy', () => {
  it('re-derives the code of the OLDEST valid burn and stores it once', async () => {
    const env = installEnv();
    const oldest = burnJson({ signature: fakeSignature(50), slot: 500_000_000, blockTime: 1780000000, memo: MEMO_OF.super, amount: '7500000000' });
    const newer = burnJson({ signature: fakeSignature(51), slot: 505_000_000 });
    const foreign = burnJson({ signature: fakeSignature(52), slot: 499_000_000, owner: WALLET.solanaAddress });
    foreign.transaction.message.accountKeys[0].signer = false;
    world({
      history: [listed(newer), listed(oldest, MEMO_OF.super), listed(foreign)],
      txs: { [fakeSignature(50)]: oldest, [fakeSignature(51)]: newer, [fakeSignature(52)]: foreign },
    });
    const result = await activation.recover();
    const code = core.generateActivationCode('super', OWNER, fakeSignature(50), 7500);
    assert.deepEqual(result, {
      found: true,
      complete: true,
      activation: {
        nodeType: 'super', burnTx: fakeSignature(50), burnAmount: 7500, solanaAddress: OWNER, cluster: SOLANA.CLUSTER, createdAt: 1780000000000,
        codeMasked: activation.maskCode(code), paidOnSite: false,
      },
    });
    assertSafeResult(result);
    assert.equal(env.state().activation.code, code);
    assert.deepEqual(await activation.copyCode(), { code });

    // run again: the stored record stays as it is
    const again = await activation.recover();
    assert.equal(again.activation.burnTx, fakeSignature(50));
    assert.equal(env.calls.updateState, 1);
  });

  it('never replaces an existing activation, even with an older burn on chain', async () => {
    const mine = { code: core.generateActivationCode('light', OWNER, fakeSignature(60), 1500), nodeType: 'light', burnTx: fakeSignature(60), burnAmount: 1500, solanaAddress: OWNER, cluster: 'devnet', createdAt: 5 };
    const env = installEnv({ state: { ...emptyState(), activation: mine } });
    const older = burnJson({ signature: fakeSignature(61), slot: 400_000_000 });
    world({ history: [listed(older)], txs: { [fakeSignature(61)]: older } });
    const result = await activation.recover();
    assert.equal(result.found, true);
    assert.equal(result.activation.burnTx, fakeSignature(60));
    assert.deepEqual(env.state().activation, mine);
    assert.equal(env.calls.updateState, 0);
  });

  it('no burn: nothing found, nothing stored; an unreadable history is an error, not "no burn"', async () => {
    const env = installEnv();
    world();
    assert.deepEqual(await activation.recover(), { found: false, complete: true, activation: null });
    assert.equal(env.calls.updateState, 0);
    world({ history: [listed(burnJson({ signature: fakeSignature(70) }))] });
    await rejectsWith(activation.recover(), 'SOLANA_UNAVAILABLE');
  });

  it('a history longer than the scan cap stores nothing, and says the answer is incomplete', async () => {
    const env = installEnv();
    const burnTx = burnJson({ signature: fakeSignature(80) });
    let page = 0;
    world({
      txs: { [fakeSignature(80)]: burnTx },
      listing: () => {
        page++;
        return Array.from({ length: 1000 }, (_, i) => (page === 1 && i === 0 ? listed(burnTx) : { signature: `plain-${page}-${i}`, slot: 1, err: null, memo: null }));
      },
    });
    const result = await activation.recover();
    assert.deepEqual(result, { found: true, complete: false, activation: null });
    assert.equal(env.state().activation, null);
  });

  // A light burn aiqnet.io's one-time payment key made for this wallet: no search of the phrase's addresses finds it;
  // the node's registration record of the wallet's light node names it (burn_tx → wallet), and its code names the wallet.
  const PAYMENT_KEY = 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR';
  const N = core.lightNodeId(WALLET.qnetAddress);

  it('a burn aiqnet.io paid for this wallet: found through the registration record, kept with the wallet\'s code', async () => {
    const env = installEnv();
    const paid = burnJson({ signature: fakeSignature(95), owner: PAYMENT_KEY, blockTime: 1790000100 });
    const w = world({ txs: { [fakeSignature(95)]: paid }, registered: () => fakeSignature(95) });
    // the status reads are signed during recover: their timestamp lies within it
    const startedAt = Math.floor(Date.now() / 1000);
    const result = await activation.recover();
    const endedAt = Math.floor(Date.now() / 1000);
    const code = core.walletActivationCode(WALLET.qnetAddress, fakeSignature(95), 1500);
    assert.deepEqual(result, {
      found: true,
      complete: true,
      activation: {
        nodeType: 'light', burnTx: fakeSignature(95), burnAmount: 1500, solanaAddress: PAYMENT_KEY, cluster: SOLANA.CLUSTER,
        createdAt: 1790000100000, codeMasked: activation.maskCode(code), paidOnSite: true,
      },
    });
    assertSafeResult(result);
    assert.notEqual(code, core.generateActivationCode('light', PAYMENT_KEY, fakeSignature(95), 1500), 'never the payment key\'s code');
    assert.deepEqual(await activation.copyCode(), { code });
    // recorded already: the registration is on chain, nothing is submitted again
    assert.deepEqual(env.state().registration, {
      nodeId: N, burnTx: fakeSignature(95), burner: PAYMENT_KEY, state: 'onchain', attempts: 0, nextAt: env.state().registration.nextAt,
      txHash: null, admittedAt: null, lastError: null, updatedAt: env.state().registration.updatedAt,
    });
    // the record was read with the wallet key: the signed status, as two nodes report it alike
    assert.equal(w.seen.statusRequests.length, 2);
    for (const { body } of w.seen.statusRequests) {
      assert.deepEqual(Object.keys(body), ['node_id', 'ts', 'signer', 'sig', 'identity_pubkey']);
      assert.deepEqual([body.node_id, body.signer], [N, 'wallet']);
      assert.equal(body.identity_pubkey, core.bytesToHex(WALLET.qnetPublicKey));
      assert.ok(body.ts >= startedAt && body.ts <= endedAt, `a fresh timestamp: ${body.ts} in [${startedAt}, ${endedAt}]`);
      assert.equal(await core.verifyConsensusSignature(core.statusPreimage(N, body.ts), body.sig, body.identity_pubkey), true);
    }
    assert.equal(env.calls.signNodeStatus, 1, 'one signature for every node asked');

    // the site learns the node exists; nothing burns on top of it
    await rejectsWith(activation.activateForSite({ nodeType: 'light', expectedPrice: null }), 'NODE_EXISTS');
    const view = await activation.siteView('light');
    assert.deepEqual([view.mode, view.reason], ['unavailable', 'NODE_EXISTS']);
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'ALREADY_ACTIVATED');
    assert.equal(w.seen.sent.length, 0);
  });

  it('the registration record is used only for a finalized light 1DEV burn that two nodes name alike', async () => {
    const superBurn = burnJson({ signature: fakeSignature(96), owner: PAYMENT_KEY, memo: MEMO_OF.super });
    const light = burnJson({ signature: fakeSignature(97), owner: PAYMENT_KEY });
    const cases = [
      ['a Super burn', { txs: { [fakeSignature(96)]: superBurn }, registered: () => fakeSignature(96) }],
      ['a burn Solana does not serve', { registered: () => fakeSignature(98) }],
      ['every node naming another burn', { txs: { [fakeSignature(97)]: light }, registered: (() => { let n = 0; return () => fakeSignature(100 + n++); })() }],
      ['no node listing the light node', {}],
    ];
    for (const [what, options] of cases) {
      const env = installEnv();
      world(options);
      assert.deepEqual(await activation.recover(), { found: false, complete: true, activation: null }, what);
      assert.equal(env.state().activation, null, what);
    }
    // a pending burn of this wallet: the record is not read
    const env = installEnv({ state: { ...emptyState(), pendingBurn: { burnTx: fakeSignature(99), nodeType: 'light', burnAmount: 1500, solanaAddress: OWNER, cluster: 'devnet', createdAt: 1, lastValidBlockHeight: null } } });
    const w = world({ txs: { [fakeSignature(97)]: light }, registered: () => fakeSignature(97) });
    await activation.recover();
    assert.equal(w.seen.statusRequests.length, 0);
    assert.equal(env.state().activation, null);
  });

  it('copy needs the unlocked session and an activation, no password (decision 33)', async () => {
    const env = installEnv();
    await rejectsWith(activation.copyCode(), 'NOT_FOUND');
    installEnv({ locked: true });
    await rejectsWith(activation.copyCode(), 'LOCKED');
    assert.equal(env.calls.verifyPassword, 0);
  });
});

describe('chains-activation activation: qnet_activateNode path (activateForSite, siteView)', () => {
  const existing = (nodeType = 'super', amount = 7500) => ({
    code: core.generateActivationCode(nodeType, OWNER, fakeSignature(90), amount), nodeType, burnTx: fakeSignature(90),
    burnAmount: amount, solanaAddress: OWNER, cluster: 'devnet', createdAt: 5,
  });
  // no password: the unlocked session and the approval window's armed confirm authorize a site's activation
  const site = (params = {}) => activation.activateForSite({ nodeType: 'light', expectedPrice: 1500, ...params });

  it('burns on the same path as the Activate tab and answers ok with the stored record', async () => {
    const env = installEnv();
    const { seen } = world();
    const outcome = await site();
    assert.equal(outcome.status, 'ok');
    assert.equal(seen.sent.length, 1);
    assert.equal(seen.sent[0].burnOpcode, 8);
    assert.equal(seen.sent[0].amount, '1500000000');
    assert.deepEqual(outcome.activation, env.state().activation);
    assert.equal(outcome.activation.code, core.generateActivationCode('light', OWNER, seen.sent[0].signature, 1500));
    assert.equal(env.calls.verifyPassword, 0, 'the unlocked session authorizes it, no password check');
  });

  it('answers what exists instead of refusing it, and never burns for it', async () => {
    const record = existing();
    let env = installEnv({ state: { ...emptyState(), activation: record } });
    let { requests } = world();
    assert.deepEqual(await site(), { status: 'exists', activation: record });
    assert.equal(requests.length, 0);
    assert.equal(env.calls.verifyPassword, 0, 'nor for the code');

    // an earlier burn on chain: the oldest valid one becomes the record
    env = installEnv();
    const earlier = burnJson({ signature: fakeSignature(91), memo: MEMO_OF.super, amount: '7500000000' });
    const scanned = world({ history: [listed(earlier, MEMO_OF.super)], txs: { [fakeSignature(91)]: earlier } });
    const outcome = await site();
    assert.equal(outcome.status, 'exists');
    assert.equal(outcome.activation.nodeType, 'super');
    assert.equal(outcome.activation.code, core.generateActivationCode('super', OWNER, fakeSignature(91), 7500));
    assert.deepEqual(env.state().activation, outcome.activation);
    assert.equal(scanned.seen.sent.length, 0);

    // a recorded burn still waiting for Solana is answered as pending (checked once first)
    const pendingBurn = { burnTx: fakeSignature(92), nodeType: 'light', burnAmount: 1500, solanaAddress: OWNER, cluster: 'devnet', createdAt: Date.now() };
    env = installEnv({ state: { ...emptyState(), pendingBurn: { ...pendingBurn, lastValidBlockHeight: 1000 } } });
    ({ requests } = world({ statuses: () => 'confirmed' }));
    assert.deepEqual(await site(), { status: 'pending', pending: pendingBurn });
    assert.equal(solanaCalls(requests).filter((m) => m === 'sendTransaction').length, 0);
  });

  it('never burns without a confirmed price, and refuses what the Activate tab refuses', async () => {
    installEnv();
    let { seen } = world();
    await rejectsWith(site({ expectedPrice: null }), 'PRICE_CHANGED');
    assert.equal(seen.sent.length, 0);
    installEnv();
    ({ seen } = world({ price: () => ({ cost: 1400 }) }));
    await rejectsWith(site(), 'PRICE_CHANGED');
    installEnv();
    ({ seen } = world({ verify: () => ({ verified: true }) }));
    await rejectsWith(site(), 'NODE_EXISTS');
    installEnv();
    ({ seen } = world({ oneDevRaw: '1' }));
    await rejectsWith(site(), 'INSUFFICIENT_TOKENS');
    installEnv();
    ({ seen } = world({ statuses: () => 'failed' }));
    await rejectsWith(site(), 'TX_FAILED');
    installEnv({ locked: true });
    await rejectsWith(site(), 'LOCKED');
    installEnv();
    await rejectsWith(site({ nodeType: 'full' }), 'INVALID_NODE_TYPE');
    await rejectsWith(site({ expectedPrice: 0 }), 'INVALID_PARAMS');
    assert.equal(seen.sent.length, 1, 'only the burn that failed on chain was sent');
  });

  it('once a burn is sent, the answer is ok or pending, never another error', async () => {
    const env = installEnv();
    // finalized, but the RPC does not serve the transaction yet
    const { seen, methods } = world();
    const original = methods.getTransaction;
    methods.getTransaction = ([signature], ...rest) => (seen.sent.some((s) => s.signature === signature) ? null : original([signature], ...rest));
    const outcome = await site();
    assert.equal(outcome.status, 'pending');
    assert.equal(outcome.pending.burnTx, seen.sent[0].signature);
    assert.equal(env.state().pendingBurn.burnTx, seen.sent[0].signature);
  });

  it('shares the single-flight lock with the Activate tab', async () => {
    installEnv();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    world({ listing: async () => {
      await gate;
      return [];
    } });
    const first = activation.burn({ nodeType: 'light', expectedPrice: 1500 });
    await flush();
    await rejectsWith(site(), 'BURN_IN_PROGRESS');
    release();
    assert.equal((await first).status, 'finalized');
  });

  it('siteView: the view the approval window shows, without burning or storing anything', async () => {
    let env = installEnv({ state: { ...emptyState(), activation: existing() } });
    world();
    const shown = await activation.siteView('light');
    assert.equal(shown.mode, 'exists');
    assert.equal(shown.activation.codeMasked, activation.maskCode(existing().code));
    assert.equal('code' in shown.activation, false);
    assertSafeResult(shown);

    env = installEnv();
    let { seen } = world();
    let view = await activation.siteView('super');
    assert.deepEqual(view, {
      mode: 'burn', reason: null, cost: 1500, activation: null, pending: null,
      balances: { lamports: '1000000', oneDevRaw: '2000000000' }, nodeChecked: true, registration: null,
    });
    assert.equal(seen.sent.length + seen.simulated.length, 0);
    assert.equal(env.calls.updateState, 0);

    // a price the window already showed is kept, and a node check already done is not repeated
    ({ seen } = world({ price: () => ({ cost: 900 }) }));
    view = await activation.siteView('light', { cost: 1500, nodeChecked: true });
    assert.equal(view.cost, 1500);
    assert.equal(seen.priceCalls, 0);
    assert.equal(seen.verifyCalls.length, 0);

    const reasons = [
      [{ price: () => null }, 'PRICE_UNAVAILABLE'],
      [{ price: () => ({ phase: 2 }) }, 'PHASE_UNSUPPORTED'],
      [{ verify: () => ({ verified: true }) }, 'NODE_EXISTS'],
      [{ oneDevRaw: '1499999999' }, 'INSUFFICIENT_TOKENS'],
      [{ oneDevRaw: null }, 'INSUFFICIENT_TOKENS'],
      [{ lamports: SOLANA.FEE_BUFFER_LAMPORTS - 1 }, 'INSUFFICIENT_SOL'],
    ];
    for (const [options, reason] of reasons) {
      installEnv();
      world(options);
      view = await activation.siteView('light');
      assert.equal(view.mode, 'unavailable', reason);
      assert.equal(view.reason, reason);
    }

    const pendingBurn = { burnTx: fakeSignature(93), nodeType: 'light', burnAmount: 1500, solanaAddress: OWNER, cluster: 'devnet', createdAt: Date.now() };
    installEnv({ state: { ...emptyState(), pendingBurn: { ...pendingBurn, lastValidBlockHeight: 1000 } } });
    world({ statuses: () => null, blockHeight: 900 });
    view = await activation.siteView('light');
    assert.equal(view.mode, 'pending');
    assert.deepEqual(view.pending, pendingBurn);

    installEnv({ locked: true });
    world();
    await rejectsWith(activation.siteView('light'), 'LOCKED');
    await rejectsWith(activation.siteView('full'), 'INVALID_NODE_TYPE');
  });
});

// EXT-R1-01: a phone-only activation on aiqnet.io leaves no burn any search of the phrase's addresses finds (the
// cabinet's one-time payment key burned for this wallet, and the node is registered for it). Before a burn the QNet
// network must vouch that the wallet has no node: its light node listed or pending on any node refuses, and only two
// nodes that both say neither let the burn go on; the answers of verify-activation fail closed too.
describe('chains-activation activation: the network vouches for no node before any burn (EXT-R1-01)', () => {
  const light = (params = {}) => ({ nodeType: 'light', expectedPrice: 1500, ...params });
  const N = core.lightNodeId(WALLET.qnetAddress);
  const unreachable = () => null;
  const behind = () => ({ verified: false, authoritative: false });

  it('registered through the payment key, verify-activation unreachable or behind: no burn, no site burn, no burn view', async () => {
    for (const verify of [unreachable, behind]) {
      const env = installEnv();
      const { seen } = world({ verify, lightStatus: () => ({ onchain_registered: true }) });
      await rejectsWith(activation.burn(light()), 'NETWORK');
      await rejectsWith(activation.activateForSite({ nodeType: 'light', expectedPrice: 1500 }), 'NETWORK');
      const view = await activation.siteView('light');
      assert.deepEqual([view.mode, view.reason, view.nodeChecked], ['unavailable', 'NETWORK', false]);
      assert.equal(seen.sent.length + seen.simulated.length, 0);
      assert.equal(env.state().pendingBurn, null);
      assert.equal(env.calls.signSolanaMessage, 0, 'nothing was signed');
    }
  });

  it('the light node listed, or its registration pending, on any node refuses with NODE_EXISTS; Recover then reads it', async () => {
    const cases = [
      ['listed on every node', () => ({ onchain_registered: true })],
      ['a registration the pool holds', () => ({ registration_pending: true })],
      ['listed on one node only (the others behind)', (node) => ({ onchain_registered: node === QNET.NODES[3] })],
    ];
    for (const [what, lightStatus] of cases) {
      installEnv();
      const { seen } = world({ lightStatus });
      await rejectsWith(activation.burn(light()), 'NODE_EXISTS');
      await rejectsWith(activation.activateForSite({ nodeType: 'light', expectedPrice: 1500 }), 'NODE_EXISTS');
      assert.deepEqual([(await activation.siteView('super')).reason], ['NODE_EXISTS'], what);
      assert.equal(seen.sent.length + seen.simulated.length, 0, what);
      assert.ok(seen.lightStatusCalls.every((call) => call.nodeId === N), what);
    }
  });

  it('the light node\'s status unknown (no node, or one alone saying "not listed"): NETWORK, nothing burned', async () => {
    const lone = QNET.NODES[2];
    for (const lightStatus of [unreachable, (node) => (node === lone ? {} : null)]) {
      installEnv();
      const { seen } = world({ lightStatus });
      await rejectsWith(activation.burn(light()), 'NETWORK');
      await rejectsWith(activation.activateForSite({ nodeType: 'light', expectedPrice: 1500 }), 'NETWORK');
      assert.equal((await activation.siteView('light')).reason, 'NETWORK');
      assert.equal(seen.sent.length + seen.simulated.length, 0);
    }
    // two nodes saying "not listed, nothing pending" are enough, whatever the others do
    installEnv();
    const { seen } = world({ lightStatus: (node) => (node === QNET.NODES[0] || node === QNET.NODES[1] ? {} : null) });
    assert.equal((await activation.burn(light())).status, 'finalized');
    assert.equal(seen.sent.length, 1);
  });
});

describe('chains-activation activation: a long or poisoned 1DEV history (R2-ESA-01, R2-ESA-02)', () => {
  // A mention of the wallet's 1DEV account with a node-type memo that is no burn of the wallet: what anyone
  // can add for a fraction of a cent.
  const spamOf = (n) => {
    const tx = burnJson({ signature: fakeSignature(2000 + n), owner: STRANGER, slot: 400_000_000 + n });
    return { tx, entry: listed(tx) };
  };

  it('50 poisoned mentions before the burn: the burn settles and its code is stored, never pending forever', async () => {
    const env = installEnv();
    const spam = Array.from({ length: 50 }, (_, i) => spamOf(i));
    const txs = Object.fromEntries(spam.map((s) => [s.entry.signature, s.tx]));
    const { seen } = world({
      txs,
      // the history as Solana lists it: this device's burn, once sent, above the 50 older mentions
      listing: (query) => {
        const own = seen.sent.map((s) => listed(burnJson({ signature: s.signature, amount: s.amount, memo: s.memo, slot: 510_000_000 })));
        const entries = [...own, ...spam.map((s) => s.entry).reverse()];
        if (query.commitment === 'confirmed') return entries.slice(0, query.limit);
        let start = query.before ? entries.findIndex((e) => e.signature === query.before) + 1 : 0;
        const stop = query.until ? entries.findIndex((e) => e.signature === query.until) : -1;
        const end = stop >= 0 ? stop : entries.length;
        start = Math.min(start, end);
        return entries.slice(start, Math.min(end, start + query.limit));
      },
    });
    const result = await activation.burn({ nodeType: 'light', expectedPrice: 1500 });
    assert.equal(result.status, 'finalized');
    assert.equal(result.code, core.generateActivationCode('light', OWNER, seen.sent[0].signature, 1500));
    assert.equal(env.state().pendingBurn, null);
    assert.equal(env.state().activation.burnTx, seen.sent[0].signature);
    assert.equal(env.burnScans[OWNER].unchecked.length, 0, 'the settle resumed the kept search: only its own burn was new');
  });

  it('a search its budget cut short is HISTORY_TOO_LONG, never "no burn", and resumes on the next try', async () => {
    const env = installEnv();
    let page = 0;
    const { seen } = world({
      listing: (query) => {
        if (query.commitment === 'confirmed') return [];
        page++;
        // 450 full pages, then the start of the history
        return page > 450 ? [] : Array.from({ length: 1000 }, (_, i) => ({ signature: `plain-${page}-${i}`, slot: 1, err: null, memo: null }));
      },
    });
    await rejectsWith(activation.activateForSite({ nodeType: 'light', expectedPrice: 1500 }), 'HISTORY_TOO_LONG');
    assert.equal(seen.sent.length, 0);
    const kept = env.burnScans[OWNER];
    assert.equal(kept.reachedStart, false);
    // the next try lists on below the kept tail and reaches the start
    const result = await activation.burn({ nodeType: 'light', expectedPrice: 1500 });
    assert.equal(result.status, 'finalized');
  });
});

describe('chains-activation activation: burns no code derives from (R4-ESA-01)', () => {
  const light = (params = {}) => ({ nodeType: 'light', expectedPrice: 1500, ...params });
  // A Full-node burn: a real 1DEV burn of the wallet with 'QNET_NODE_TYPE:FULL'. The node counts it for an
  // activation (it reads neither the memo nor the source account); no Light or Super code derives from it.
  const fullBurn = (confirmationStatus = 'finalized') => {
    const tx = burnJson({ signature: fakeSignature(4000), memo: 'QNET_NODE_TYPE:FULL', slot: 300_000_000 });
    return { tx, entry: listed(tx, 'QNET_NODE_TYPE:FULL', confirmationStatus) };
  };

  it('a Full-node burn of the wallet refuses a new burn, the site\'s burn and Recover with BURN_UNUSABLE', async () => {
    const full = fullBurn();
    const env = installEnv();
    const { seen } = world({ history: [full.entry], txs: { [full.entry.signature]: full.tx } });
    await rejectsWith(activation.burn(light()), 'BURN_UNUSABLE');
    await rejectsWith(activation.activateForSite({ nodeType: 'light', expectedPrice: 1500 }), 'BURN_UNUSABLE');
    await rejectsWith(activation.recover(), 'BURN_UNUSABLE');
    assert.equal(seen.sent.length + seen.simulated.length, 0);
    assert.equal(env.state().activation, null);
    assert.deepEqual(env.burnScans[OWNER].unusable.map((b) => b.signature), [full.entry.signature], 'kept with the search');
    assert.deepEqual(env.burnScans[OWNER].found, []);
    // one still in flight (confirmed, not final) refuses too
    installEnv();
    const young = fullBurn('confirmed');
    const again = world({ history: [young.entry], txs: { [young.entry.signature]: young.tx } });
    await rejectsWith(activation.burn(light()), 'BURN_UNUSABLE');
    assert.equal(again.seen.sent.length, 0);
    // a Full memo on a burn that is not the wallet's (it neither pays nor signs) is no burn of it
    installEnv();
    const foreign = fullBurn();
    foreign.tx.transaction.message.accountKeys[0].signer = false;
    const clean = world({ history: [foreign.entry], txs: { [foreign.entry.signature]: foreign.tx } });
    assert.equal((await activation.burn(light())).status, 'finalized');
    assert.equal(clean.seen.sent.length, 1);
  });

  // R5-ESA-01: a burn from another token account of the wallet is a transaction the wallet signed, so it lists in the
  // history of its own address; nothing a third party creates (token accounts naming it as owner, mentions) can make
  // that search give up for good.
  it('a burn from another 1DEV account of the wallet refuses too, found through what the wallet signed (R5-ESA-01)', async () => {
    const other = core.base58Encode(new Uint8Array(32).fill(8));
    const tx = burnJson({ signature: fakeSignature(4001), slot: 300_000_000 });
    tx.transaction.message.instructions[0].parsed.info.account = other;
    let env = installEnv();
    let { seen } = world({ signedHistory: { [OWNER]: [listed(tx)] }, txs: { [fakeSignature(4001)]: tx } });
    await rejectsWith(activation.burn(light()), 'BURN_UNUSABLE');
    await rejectsWith(activation.activateForSite({ nodeType: 'light', expectedPrice: 1500 }), 'BURN_UNUSABLE');
    await rejectsWith(activation.recover(), 'BURN_UNUSABLE');
    assert.equal(seen.sent.length, 0);
    assert.equal(env.state().activation, null);
    assert.ok(seen.signedListings >= 1);
    assert.deepEqual(seen.accountQueries, [], 'no token account list: a closed account\'s burn is found as well');
    assert.deepEqual(env.burnScans[`${OWNER}:signed`].unusable.map((b) => b.signature), [fakeSignature(4001)], 'kept with its search');
    // the history of the wallet's own address cannot be read: the burn refuses, Recover says its answer is incomplete
    env = installEnv();
    let methods;
    ({ seen, methods } = world());
    const listing = methods.getSignaturesForAddress;
    methods.getSignaturesForAddress = (params) => (params[0] === OWNER ? { rpcError: { code: -32602, message: 'invalid params' } } : listing(params));
    await rejectsWith(activation.burn(light()), 'SOLANA_UNAVAILABLE');
    assert.deepEqual(await activation.recover(), { found: false, complete: false, activation: null });
    assert.equal(seen.sent.length, 0);
  });

  // R5-ESA-01, XP-R5-02: 33 token accounts an attacker made with the wallet as owner, or thousands of transactions that
  // merely mention one, once gave HISTORY_TOO_LONG on every try, for good. Accounts nobody signed for are not read.
  it('token accounts an attacker made for the wallet never block its first burn (R5-ESA-01, XP-R5-02)', async () => {
    installEnv();
    const many = Array.from({ length: 33 }, (_, i) => core.base58Encode(new Uint8Array(32).fill(20 + i)));
    const flood = Object.fromEntries(many.map((account, i) => [account, Array.from({ length: 1000 }, (_, k) => ({
      signature: `mention-${i}-${k}`, slot: 2, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT',
    }))]));
    const { seen } = world({ otherAccounts: { [OWNER]: many }, otherHistories: flood });
    assert.equal((await activation.burn(light())).status, 'finalized');
    assert.equal(seen.sent.length, 1);
    assert.equal(seen.otherListings, 0);
    assert.deepEqual(seen.accountQueries, []);
  });

  it('a flood of mentions of the wallet\'s own address slows the search but never stops it: each try goes on (R5-ESA-01)', async () => {
    const env = installEnv();
    let page = 0;
    const { seen } = world({
      signedListing: (query) => {
        if (query.commitment === 'confirmed') return [];
        page++;
        // 450 full pages of plain mentions (no memo: skipped at no cost), then the start of the history
        return page > 450 ? [] : Array.from({ length: 1000 }, (_, i) => ({ signature: `dust-${page}-${i}`, slot: 1, err: null, memo: null }));
      },
    });
    await rejectsWith(activation.burn(light()), 'HISTORY_TOO_LONG');
    assert.equal(seen.sent.length, 0);
    const kept = env.burnScans[`${OWNER}:signed`];
    assert.equal(kept.reachedStart, false, 'kept where it stopped');
    // the next try goes on below the kept tail, reaches the start, and burns
    assert.equal((await activation.burn(light())).status, 'finalized');
    assert.equal(seen.sent.length, 1);
    assert.equal(env.burnScans[`${OWNER}:signed`].reachedStart, true);
  });
});

describe('chains-activation activation: a long search goes on by itself (R4-ESA-03)', () => {
  const plainPages = (total) => {
    let page = 0;
    return (query) => {
      if (query.commitment === 'confirmed') return [];
      page++;
      return page > total ? [] : Array.from({ length: 1000 }, (_, i) => ({ signature: `plain-${page}-${i}`, slot: 1, err: null, memo: null }));
    };
  };

  it('after an unlock the worker resumes a search a budget cut short; the next burn starts from its end', async () => {
    const env = installEnv();
    const { seen } = world({ listing: plainPages(450) });
    await rejectsWith(activation.activateForSite({ nodeType: 'light', expectedPrice: 1500 }), 'HISTORY_TOO_LONG');
    assert.equal(env.burnScans[OWNER].reachedStart, false);
    assert.deepEqual(await activation.resumeBurnSearches(), { resumed: 1 });
    assert.equal(env.burnScans[OWNER].reachedStart, true, 'worked through without the user starting it again');
    const listings = seen.listings;
    assert.equal((await activation.burn({ nodeType: 'light', expectedPrice: 1500 })).status, 'finalized');
    assert.ok(seen.listings - listings < 10, `the burn listed only the new part: ${seen.listings - listings}`);
    // nothing to resume: a finished search, or a wallet with an activation
    assert.deepEqual(await activation.resumeBurnSearches(), { resumed: 0 });
    installEnv();
    world();
    assert.deepEqual(await activation.resumeBurnSearches(), { resumed: 0 }, 'no search was ever started');
  });

  it('a burn during the resume waits for it and goes on from where it got, never BURN_IN_PROGRESS', async () => {
    const env = installEnv();
    const pages = plainPages(450);
    let release = null;
    let hold = false;
    let held = 0;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    world({
      listing: async (query) => {
        // the resume is held on its first page until the burn is asked for
        if (hold && held === 0) {
          held++;
          await gate;
        }
        return pages(query);
      },
    });
    await rejectsWith(activation.recover(), 'HISTORY_TOO_LONG');
    assert.equal(env.burnScans[OWNER].reachedStart, false);
    hold = true;
    const resume = activation.resumeBurnSearches();
    for (let i = 0; i < 1000 && held === 0; i++) await flush(1);
    assert.equal(held, 1);
    const burn = activation.burn({ nodeType: 'light', expectedPrice: 1500 });
    await flush();
    release();
    assert.deepEqual(await resume, { resumed: 1 });
    assert.equal((await burn).status, 'finalized');
  });

  it('checks the candidates two at a time', async () => {
    installEnv();
    const spam = Array.from({ length: 7 }, (_, i) => burnJson({ signature: fakeSignature(5000 + i), owner: STRANGER, slot: 400_000_000 + i }));
    const { methods } = world({ history: spam.map((tx) => listed(tx)), txs: Object.fromEntries(spam.map((tx) => [tx.transaction.signatures[0], tx])) });
    const original = methods.getTransaction;
    let active = 0;
    let peak = 0;
    methods.getTransaction = async (params) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return original(params);
    };
    assert.deepEqual(await activation.recover(), { found: false, complete: true, activation: null });
    assert.equal(peak, 2);
  });
});

describe('chains-activation activation: one code across devices of the same phrase (EXT-CHAINS-03)', () => {
  const site = (params = {}) => activation.activateForSite({ nodeType: 'light', expectedPrice: 1500, ...params });

  it('the refusal scan lists at confirmed commitment, so a burn sent from another device is seen before it finalizes', async () => {
    const env = installEnv();
    const young = burnJson({ signature: fakeSignature(70) });
    const queries = [];
    const { seen } = world({
      listing: (query) => {
        queries.push(query.commitment);
        return query.commitment === 'confirmed' ? [listed(young, MEMO_OF.light, 'confirmed')] : [];
      },
      txs: { [fakeSignature(70)]: young },
    });
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'BURN_EXISTS');
    assert.deepEqual(queries, ['finalized', 'confirmed'], 'the finalized history, then the newest confirmed page');
    assert.equal(seen.sent.length, 0);
    assert.equal(env.state().pendingBurn, null);

    // for a site: pending with that burn's data (QNet Link v1 section 7, as the app answers: XP-R2-05); its
    // code is never stored before it is final, and it is kept as the pending burn, which settles it then
    const kept = installEnv();
    const online = world({
      history: [listed(young, MEMO_OF.light, 'confirmed')], txs: { [fakeSignature(70)]: young }, statuses: () => 'confirmed',
    });
    const outcome = await site();
    assert.equal(outcome.status, 'pending');
    assert.equal(outcome.pending.burnTx, fakeSignature(70));
    assert.equal(outcome.pending.solanaAddress, OWNER);
    assert.equal(outcome.pending.nodeType, 'light');
    assert.equal(outcome.pending.burnAmount, 1500);
    assert.equal(kept.state().activation, null);
    assert.equal(kept.state().pendingBurn.burnTx, fakeSignature(70));
    assert.equal(kept.state().pendingBurn.lastValidBlockHeight, null);
    assert.equal(online.seen.sent.length, 0);
    // asked again: the kept pending burn is answered before any search, and no burn starts here meanwhile
    assert.equal((await site()).pending.burnTx, fakeSignature(70));
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'BURN_IN_PROGRESS');
    assert.equal(online.seen.sent.length, 0);
    // once final, activation.status settles it as it settles a burn sent here
    world({ history: [listed(young, MEMO_OF.light)], txs: { [fakeSignature(70)]: young } });
    const status = await activation.getStatus();
    assert.equal(status.pending, null);
    assert.equal(kept.state().activation.code, core.generateActivationCode('light', OWNER, fakeSignature(70), 1500));
  });

  it('a settled burn stores the oldest burn of the wallet, when another device burned first', async () => {
    const env = installEnv();
    const older = burnJson({ signature: fakeSignature(71), slot: 500_000_000, memo: MEMO_OF.super, amount: '7500000000' });
    // nothing before the burn is sent (neither the finalized history nor the confirmed listing shows it); the
    // other device's older burn is listed once it is final
    const { seen } = world({
      listing: () => (seen.listings <= 2 ? [] : [listed(older, MEMO_OF.super)]),
      txs: { [fakeSignature(71)]: older },
    });
    const result = await activation.burn({ nodeType: 'light', expectedPrice: 1500 });
    assert.equal(seen.sent.length, 1, 'this device burned too');
    const code = core.generateActivationCode('super', OWNER, fakeSignature(71), 7500);
    assert.equal(result.code, code, 'the code every Recover derives');
    assert.equal(env.state().activation.burnTx, fakeSignature(71));
    assert.equal(env.state().pendingBurn, null);
    // XP-R5-03: this device's own burn went through too; it is named, and kept, never recorded nowhere
    const [sent] = seen.sent;
    assert.deepEqual(result.superseded, {
      burnTx: sent.signature, nodeType: 'light', burnAmount: 1500, solanaAddress: OWNER, cluster: SOLANA.CLUSTER,
      createdAt: result.superseded.createdAt,
    });
    assert.equal(env.state().supersededBurn.burnTx, sent.signature);
    assert.equal((await activation.getStatus()).superseded.burnTx, sent.signature, 'the Activate tab names it');
  });

  // XP-R5-03: the site's burn lost the race to another device's older burn of the phrase, of another node type: the
  // answer is 'exists' with that activation, never INTERNAL once a burn went out, and this burn is named.
  it('a site burn beaten by another device\'s older burn answers exists with it, whatever its type (XP-R5-03)', async () => {
    const env = installEnv();
    const older = burnJson({ signature: fakeSignature(72), slot: 500_000_000, memo: MEMO_OF.super, amount: '7500000000' });
    const { seen } = world({
      listing: () => (seen.listings <= 2 ? [] : [listed(older, MEMO_OF.super)]),
      txs: { [fakeSignature(72)]: older },
    });
    const outcome = await activation.activateForSite({ nodeType: 'light', expectedPrice: 1500 });
    assert.equal(seen.sent.length, 1, 'this request burned too');
    assert.equal(outcome.status, 'exists');
    assert.equal(outcome.activation.burnTx, fakeSignature(72));
    assert.equal(outcome.activation.nodeType, 'super');
    assert.equal(outcome.superseded.burnTx, seen.sent[0].signature);
    assert.equal(env.state().supersededBurn.burnTx, seen.sent[0].signature);
  });

  // QNet Link v1 section 7.1 (SHOULD): the burn an earlier request sent was still on its way; it settles while this
  // request is answered, and another device's older burn is the activation: this answer names it too, once.
  it('an earlier request\'s burn that settles now, beaten by an older burn, is named in this answer', async () => {
    const own = fakeSignature(93);
    const pendingBurn = {
      burnTx: own, nodeType: 'light', burnAmount: 1500, solanaAddress: OWNER, cluster: SOLANA.CLUSTER, createdAt: Date.now(), lastValidBlockHeight: 999,
    };
    const env = installEnv({ state: { ...emptyState(), pendingBurn } });
    const older = burnJson({ signature: fakeSignature(94), slot: 500_000_000, memo: MEMO_OF.super, amount: '7500000000' });
    world({
      listing: () => [listed(older, MEMO_OF.super)], txs: { [own]: burnJson({ signature: own }), [fakeSignature(94)]: older }, statuses: () => 'finalized',
    });
    const outcome = await site({ expectedPrice: null });
    assert.equal(outcome.status, 'exists');
    assert.equal(outcome.activation.burnTx, fakeSignature(94));
    assert.equal(outcome.superseded.burnTx, own);
    assert.equal(outcome.superseded.solanaAddress, OWNER);
    assert.equal(env.state().supersededBurn.burnTx, own);
    // asked again: the activation exists and nothing settled meanwhile, so nothing is named again
    assert.equal(Object.hasOwn(await site({ expectedPrice: null }), 'superseded'), false);
  });

  // R3-ESA-02: the kept search has a range above its head that is not listed to its end; an older burn of another
  // device may lie in its unlisted part, so a settle stores nothing yet, even though nothing below the head is unchecked.
  it('a settle waits while the range above the kept head is not listed to its end (R3-ESA-02)', async () => {
    const own = fakeSignature(88);
    const pendingBurn = {
      burnTx: own, nodeType: 'light', burnAmount: 1500, solanaAddress: OWNER, cluster: SOLANA.CLUSTER, createdAt: Date.now(), lastValidBlockHeight: 999,
    };
    const env = installEnv({ state: { ...emptyState(), pendingBurn } });
    // what an earlier search kept: the whole history below the head read, a range above it started
    env.burnScans[OWNER] = {
      v: 2, owner: OWNER, mint: MINT, ata: ATA, head: 'head-signature', tail: 'tail-signature', reachedStart: true, headSeq: 0, tailSeq: 3,
      range: { top: 'top-signature', before: 'cursor-signature', base: -1_000_000_000, count: 0 }, unchecked: [], found: [],
    };
    // a range longer than one call's budget: full pages below the cursor, never reaching the head
    const page = Array.from({ length: 1000 }, (_, i) => ({ signature: `flood-${i}`, slot: 1, err: null, memo: null }));
    world({ listing: () => page, txs: { [own]: burnJson({ signature: own }) }, statuses: () => 'finalized' });
    const status = await activation.getStatus();
    assert.equal(status.activation, null, 'no code stored while an older burn may still be unlisted');
    assert.equal(env.state().pendingBurn.burnTx, own, 'the burn stays pending');
  });

  it('a settled burn with an unreadable history stays pending rather than store a code that may not be the oldest', async () => {
    const env = installEnv();
    const { seen } = world({
      listing: () => {
        // the refusal scan (finalized history, confirmed page) reads fine; the settle scan does not
        if (seen.listings <= 2) return [];
        throw new TypeError('rpc down');
      },
    });
    const result = await activation.burn({ nodeType: 'light', expectedPrice: 1500 });
    assert.deepEqual(result, { status: 'pending', burnTx: seen.sent[0].signature });
    assert.equal(env.state().activation, null);
    assert.equal(env.state().pendingBurn.burnTx, seen.sent[0].signature);
  });

  it('no blockhash expiry from the RPC, no burn', async () => {
    installEnv();
    const net = world();
    net.methods.getLatestBlockhash = () => ({ context: { slot: 1 }, value: { blockhash: BLOCKHASH } });
    await rejectsWith(activation.burn({ nodeType: 'light', expectedPrice: 1500 }), 'SOLANA_UNAVAILABLE');
    assert.equal(net.seen.sent.length, 0);
  });
});

// Decision 35 (owner, 29.09): one wallet, one code, for a Light or a Super node. aiqnet.io keeps a verified record of
// every burn and one reservation per wallet; the extension burns only when the QNet network, the kept search, the vault
// and that record all say "none", only under the reservation, and announces the burn with the wallet's proof before it
// is sent. Each test runs a worker of its own (a fresh module), so no search verdict, sync or shown record carries over.
describe('chains-activation activation: aiqnet.io\'s record and reservation (decision 35)', () => {
  const W = WALLET.qnetAddress;
  const light = (params = {}) => ({ nodeType: 'light', expectedPrice: 1500, ...params });
  let instance = 0;
  const fresh = () => import(`../dist/background/activation.js?record=${++instance}`);
  const row = (fields) => ({ wallet: W, nodeType: 'light', way: 'extension', burner: OWNER, burnAmount: 1500, ...fields });
  const eventually = async (predicate, what) => {
    for (let i = 0; i < 400 && !predicate(); i += 1) await flush();
    assert.ok(predicate(), what);
  };
  // What each request asked: a route of aiqnet.io's record, or a Solana method.
  const labelOf = (request) => {
    const url = new URL(request.url);
    if (url.origin === QNET.EXPLORER_API) return request.method === 'GET' ? 'get' : url.pathname.split('/').pop();
    return SOLANA.RPC_URLS.includes(request.url) ? JSON.parse(request.body).method : url.pathname;
  };

  it('refuses a burn while aiqnet.io holds a record, a reservation, a burn on its way or a payment burn: nothing reserved, signed or sent', async () => {
    const cases = [
      [{ state: 'recorded', burnTx: fakeSignature(5001) }, 'ACTIVATION_RECORDED'],
      [{ state: 'recorded', nodeType: 'super', burnTx: fakeSignature(5004) }, 'ACTIVATION_RECORDED'],
      [{ state: 'reserved', until: Date.now() + 300000 }, 'ACTIVATION_RESERVED'],
      [{ state: 'sending', burnTx: fakeSignature(5002), until: Date.now() + 300000 }, 'ACTIVATION_RESERVED'],
      // a payment address's burn: on its way, then the wallet's record for good (decision 36)
      [{ state: 'sending', way: 'payment', burner: STRANGER, burnTx: fakeSignature(5003), until: Date.now() + 300000 }, 'ACTIVATION_RESERVED'],
      [{ state: 'recorded', way: 'payment', burner: STRANGER, burnTx: fakeSignature(5005) }, 'ACTIVATION_RECORDED'],
    ];
    for (const [fields, code] of cases) {
      const env = installEnv();
      const a = await fresh();
      const { seen, cabinet } = world();
      cabinet.put(row(fields));
      // a light burn and a super burn alike: the node type is chosen once
      await rejectsWith(a.burn(light()), code);
      await rejectsWith(a.burn(light({ nodeType: 'super' })), code);
      await rejectsWith(a.activateForSite({ nodeType: 'super', expectedPrice: 1500 }), code);
      const view = await a.siteView('light');
      assert.deepEqual([view.mode, view.reason], ['unavailable', code], fields.state);
      assert.equal(seen.sent.length + seen.simulated.length, 0, fields.state);
      assert.equal(env.calls.signSolanaMessage + env.calls.signBurnRecord + env.calls.signReservation, 0, `${fields.state}: nothing signed`);
      assert.equal(cabinet.of('reserve').length, 0, fields.state);
      assert.equal(env.state().pendingBurn, null);
    }
    // aiqnet.io's own check of the network at the reservation: a node of this wallet, or no answer from the network
    for (const [hasNode, code] of [[() => true, 'NODE_EXISTS'], [() => null, 'NETWORK']]) {
      const env = installEnv();
      const a = await fresh();
      const { seen, cabinet } = world({ cabinet: createCabinet({ hasNode }) });
      await rejectsWith(a.burn(light()), code);
      assert.equal(cabinet.of('reserve').length, 1);
      assert.equal(seen.simulated.length + seen.sent.length, 0);
      // the reservation was asked with the wallet's signature, and nothing else was signed
      assert.deepEqual([env.calls.signReservation, env.calls.signSolanaMessage, env.calls.signBurnRecord], [1, 0, 0]);
    }
  });

  // Decision 36: only the wallet itself holds a reservation. The extension signs its request silently inside the burn the
  // user confirmed; aiqnet.io refuses one nobody signed, one another key signed, one for other fields and one too old.
  it('asks the reservation with the wallet\'s own signature, and aiqnet.io refuses an unsigned, forged, stale or other-wallet request', async () => {
    let env = installEnv();
    let a = await fresh();
    let { cabinet } = world();
    assert.equal((await a.burn(light({ nodeType: 'super' }))).status, 'finalized');
    const [asked] = cabinet.of('reserve');
    const { proof, ...fields } = asked.body;
    assert.deepEqual(Object.keys(asked.body), ['wallet', 'nodeType', 'way', 'burner', 'burnAmount', 'solana', 'proof']);
    assert.deepEqual(Object.keys(proof), ['pk', 'sig', 'time']);
    assert.equal(env.calls.signReservation, 1);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Number.isSafeInteger(proof.time) && Math.abs(proof.time - now) <= 5, 'signed now, in Unix seconds');
    assert.ok(!/[+/=]/.test(proof.pk + proof.sig), 'base64url without padding');
    const request = { wallet: W, nodeType: 'super', way: 'extension', burner: OWNER };
    assert.equal(reservationProofValid(request, proof), true);
    // one request, one proof: another node type, way, burner or wallet is no proof of it
    for (const other of [{ nodeType: 'light' }, { way: 'payment' }, { burner: STRANGER }, { wallet: STRANGER_QNET }]) {
      assert.equal(reservationProofValid({ ...request, ...other }, proof), false, JSON.stringify(other));
    }
    assert.equal(reservationProofValid(request, { ...proof, time: proof.time + 1 }), false, 'the time is signed');

    // aiqnet.io's answers to a request the wallet did not make: nothing reserved, and the extension reads a 400 as INTERNAL
    const site = createCabinet();
    const post = async (body) => site.route({
      url: `${QNET.EXPLORER_API}/api/cabinet/activation/reserve`, method: 'POST', body: JSON.stringify(body), init: {},
    });
    const base = { ...fields, wallet: W };
    for (const [body, error] of [
      [base, 'invalid_request'],
      [{ ...base, proof: { pk: proof.pk, sig: proof.sig } }, 'invalid_proof'],
      [{ ...base, proof: { ...proof, sig: proof.sig.slice(0, -4) + 'AAAA' } }, 'invalid_proof'],
      [{ ...base, nodeType: 'light', proof }, 'invalid_proof'],
      [{ ...base, proof: { ...proof, time: now - 601 } }, 'invalid_proof'],
    ]) {
      const answer = await post(body);
      assert.deepEqual([answer.status, answer.body.error], [400, error], JSON.stringify(Object.keys(body)));
    }
    assert.equal(site.rows.size, 0);

    // signed too long ago, or too far ahead: stale (the signature itself is good)
    const reserveAt = (time) => {
      const env2 = globalThis.__qnetChainsEnv;
      return env2.keys.signReservation({ ...request, time });
    };
    for (const time of [now - 620, now + 320]) {
      const signed = await reserveAt(time);
      const answer = await post({ ...base, proof: signed });
      assert.deepEqual([answer.status, answer.body.error], [400, 'stale_proof'], String(time - now));
    }
    const fresh600 = await reserveAt(now - 590);
    assert.equal((await post({ ...base, proof: fresh600 })).status, 200, 'ten minutes old at most');

    // the wallet's request refused as aiqnet.io refuses it: INTERNAL, nothing burned or signed but the request
    env = installEnv();
    a = await fresh();
    let seen;
    ({ seen, cabinet } = world());
    cabinet.fail.reserve = { status: 400, body: { error: 'stale_proof' } };
    await rejectsWith(a.burn(light()), 'INTERNAL');
    assert.deepEqual([env.calls.signReservation, env.calls.signBurnRecord, env.calls.signSolanaMessage], [1, 0, 0]);
    assert.equal(seen.simulated.length + seen.sent.length, 0);
    // a locked wallet signs no request: nothing is asked of aiqnet.io
    env = installEnv();
    a = await fresh();
    ({ cabinet } = world());
    const signReservation = env.keys.signReservation;
    env.keys.signReservation = async (...args) => {
      env.locked = true;
      return signReservation(...args);
    };
    await rejectsWith(a.burn(light()), 'LOCKED');
    assert.equal(cabinet.of('reserve').length, 0);
  });

  it('refuses a burn while a source cannot answer: aiqnet.io down, busy or answering nonsense, Solana, the QNet network', async () => {
    for (const failure of ['down', { status: 503, body: { error: 'unavailable' } }, { status: 429, body: { error: 'rate_limited' } },
      { status: 200, body: { wallet: W, state: 'none' } }, { status: 200, body: { error: 'x' } }, { status: 404, body: {} }]) {
      const env = installEnv();
      const a = await fresh();
      const { seen, cabinet } = world();
      cabinet.fail.get = failure;
      await rejectsWith(a.burn(light()), 'RECORD_UNAVAILABLE');
      await rejectsWith(a.activateForSite({ nodeType: 'light', expectedPrice: 1500 }), 'RECORD_UNAVAILABLE');
      assert.equal((await a.siteView('light')).reason, 'RECORD_UNAVAILABLE');
      assert.equal(seen.sent.length + seen.simulated.length, 0);
      assert.equal(cabinet.of('reserve').length, 0);
      assert.equal(env.calls.signSolanaMessage, 0);
    }
    // Solana: the search of the wallet's own address cannot read the history
    let env = installEnv();
    let a = await fresh();
    let { seen, cabinet } = world({ listing: () => { throw new Error('rpc down'); } });
    await rejectsWith(a.burn(light()), 'SOLANA_UNAVAILABLE');
    assert.deepEqual([(await a.siteView('light')).reason, (await a.siteActivation()).status], ['SOLANA_UNAVAILABLE', 'unknown']);
    assert.equal(cabinet.of('reserve').length + seen.sent.length, 0);
    // the QNet network cannot vouch that the wallet has no node
    env = installEnv();
    a = await fresh();
    ({ seen, cabinet } = world({ verify: () => null }));
    await rejectsWith(a.burn(light()), 'NETWORK');
    assert.equal(cabinet.of('reserve').length + seen.sent.length + env.calls.signSolanaMessage, 0);
  });

  it('two browsers of one wallet: one reservation, one burn; the other burn is ACTIVATION_RESERVED and sends nothing', async () => {
    installEnv();
    let sentBy = null;
    const cabinet = createCabinet({ landed: (burnTx) => (sentBy?.sent.some((sent) => sent.signature === burnTx) ? 'final' : 'unknown') });
    // both browsers read "none" before either reserves
    const route = cabinet.route;
    let open = null;
    const bothRead = new Promise((resolve) => {
      open = resolve;
    });
    let reads = 0;
    cabinet.route = async (request) => {
      if (request.method === 'GET' && new URL(request.url).pathname.startsWith('/api/cabinet/activation/')) {
        reads += 1;
        if (reads === 2) open();
        await bothRead;
      }
      return route(request);
    };
    const { seen } = world({ cabinet });
    sentBy = seen;
    const [first, second] = [await fresh(), await fresh()];
    const outcomes = await Promise.allSettled([first.burn(light()), second.burn(light({ nodeType: 'super' }))]);
    const done = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(done.length, 1, 'exactly one burn went out');
    assert.equal(done[0].value.status, 'finalized');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason.code, 'ACTIVATION_RESERVED');
    assert.equal(seen.sent.length, 1);
    assert.equal(cabinet.of('reserve').length, 2, 'both asked; aiqnet.io granted one');
    assert.equal(cabinet.of('announce').length, 1);
    assert.equal(cabinet.of('release').length, 0, 'the loser holds no reservation to give back');
    await eventually(() => cabinet.rows.get(W)?.state === 'recorded', 'the winner\'s burn is recorded');
    assert.equal(cabinet.rows.get(W).burnTx, seen.sent[0].signature);
  });

  it('signs only under a reservation and sends only after its announce; a refused or unanswered announce sends nothing and gives the reservation back', async () => {
    let env = installEnv();
    let a = await fresh();
    let { seen, cabinet, requests } = world();
    assert.equal((await a.burn(light())).status, 'finalized');
    const order = requests.map(labelOf);
    const at = (label) => order.indexOf(label);
    assert.ok(at('get') < at('reserve') && at('reserve') < at('getLatestBlockhash') && at('getLatestBlockhash') < at('simulateTransaction')
      && at('simulateTransaction') < at('announce') && at('announce') < at('sendTransaction'), order.join());
    const reserve = cabinet.of('reserve')[0].body;
    const { proof: reserveProof, ...reserveFields } = reserve;
    assert.deepEqual(reserveFields, { wallet: W, nodeType: 'light', way: 'extension', burner: OWNER, burnAmount: 1500, solana: OWNER });
    assert.deepEqual(Object.keys(reserve), ['wallet', 'nodeType', 'way', 'burner', 'burnAmount', 'solana', 'proof']);
    assert.equal(reservationProofValid({ wallet: W, nodeType: 'light', way: 'extension', burner: OWNER }, reserveProof), true);
    assert.equal(cabinet.of('announce')[0].body.burnTx, seen.sent[0].signature);
    for (const request of cabinet.requests) {
      assert.equal(request.init.credentials, 'omit');
      assert.equal(request.init.redirect, 'error');
    }

    for (const [answer, code] of [[{ status: 409, body: { error: 'reservation' } }, 'ACTIVATION_RESERVED'],
      [{ status: 503, body: { error: 'unavailable' } }, 'RECORD_UNAVAILABLE'], ['down', 'RECORD_UNAVAILABLE'],
      [{ status: 400, body: { error: 'invalid_proof' } }, 'INTERNAL'], [{ status: 200, body: { ok: false } }, 'RECORD_UNAVAILABLE']]) {
      env = installEnv();
      a = await fresh();
      ({ seen, cabinet } = world());
      cabinet.fail.announce = answer;
      await rejectsWith(a.burn(light()), code);
      assert.equal(seen.sent.length, 0, `${code}: nothing sent`);
      assert.equal(seen.simulated.length, 1, 'built and simulated, never sent');
      assert.equal(env.state().pendingBurn, null);
      await eventually(() => cabinet.of('release').length === 1, 'the reservation goes back');
      assert.equal(cabinet.of('release')[0].body.wallet, W);
      assert.match(cabinet.of('release')[0].body.reservation, /^[0-9a-f]{32}$/);
      assert.equal(cabinet.rows.has(W), false, 'nothing held for this wallet any more');
    }

    // too little of the reservation left to announce and send under it: nothing is signed, and it goes back
    env = installEnv();
    a = await fresh();
    ({ seen, cabinet } = world());
    cabinet.fail.reserve = { status: 200, body: { reservation: 'ab'.repeat(16), until: Date.now() + 60000 } };
    await rejectsWith(a.burn(light()), 'RECORD_UNAVAILABLE');
    // the reservation's request was signed; the burn and its record never were
    assert.deepEqual([env.calls.signReservation, env.calls.signSolanaMessage + env.calls.signBurnRecord], [1, 0]);
    assert.equal(seen.simulated.length, 0);
    await eventually(() => cabinet.of('release').length === 1, 'released');
    assert.equal(cabinet.of('release')[0].body.reservation, 'ab'.repeat(16));
    // an answer that holds no reservation is none: nothing is signed
    for (const body of [{ reservation: 'AB'.repeat(16), until: Date.now() + 600000 }, { reservation: 'ab'.repeat(16) }, {}]) {
      env = installEnv();
      a = await fresh();
      ({ seen, cabinet } = world());
      cabinet.fail.reserve = { status: 200, body };
      await rejectsWith(a.burn(light()), 'RECORD_UNAVAILABLE');
      assert.equal(env.calls.signSolanaMessage, 0, JSON.stringify(body));
    }
  });

  it('the announce carries the burn record\'s proof: an independent verifier accepts both signatures over the contract\'s bytes', async (t) => {
    if (!noble) {
      t.skip('run npm run bundle:install');
      return;
    }
    installEnv();
    const a = await fresh();
    const { seen, cabinet } = world();
    await a.burn(light({ nodeType: 'super' }));
    const { burnTx, proof } = cabinet.of('announce')[0].body;
    assert.equal(burnTx, seen.sent[0].signature);
    assert.deepEqual(Object.keys(proof).sort(), ['pk', 'sig', 'solanaSig']);
    const utf8 = (text) => new TextEncoder().encode(text);
    const envelopeOf = (amount, nodeType = 'super') => {
      const text = ['QNet burn record v1', `wallet: ${W}`, `node: ${nodeType}`, `burner: ${OWNER}`, `burn: ${burnTx}`, `amount: ${amount}`,
        'cluster: devnet'].join('\n');
      return utf8(`QNet Signed Message:\nhttps://aiqnet.io\n${utf8(text).length}\n${text}`);
    };
    assert.ok(!/[+/=]/.test(proof.pk + proof.sig), 'base64url without padding');
    const pk = new Uint8Array(Buffer.from(proof.pk, 'base64url'));
    const sig = new Uint8Array(Buffer.from(proof.sig, 'base64url'));
    const solanaSig = core.base58Decode(proof.solanaSig);
    assert.deepEqual([pk.length, sig.length, solanaSig.length], [1952, 3309, 64]);
    const context = { context: utf8('QNET_OFFCHAIN_MSG_v1') };
    assert.equal(noble.ml_dsa65.verify(sig, envelopeOf(1500), pk, context), true, 'ML-DSA-65 by the wallet key, the off-chain context');
    assert.equal(noble.ml_dsa65.verify(sig, envelopeOf(1500), pk), false, 'never valid without the context');
    assert.equal(curves.ed25519.verify(solanaSig, envelopeOf(1500), core.solanaAddressToBytes(OWNER)), true, 'Ed25519 by the burner');
    assert.equal(core.qnetAddressFromPublicKey(pk), W, 'the key is the wallet\'s');
    // one proof, one burn: another amount or node type is no proof of it
    assert.equal(noble.ml_dsa65.verify(sig, envelopeOf(1501), pk, context), false);
    assert.equal(curves.ed25519.verify(solanaSig, envelopeOf(1500, 'light'), core.solanaAddressToBytes(OWNER)), false);
    assert.equal(proofValid({ wallet: W, nodeType: 'super', burner: OWNER, burnTx, burnAmount: 1500 }, proof), true);
  });

  it('after a reset and a restore of the same phrase the old burn is found again and no second burn starts', async () => {
    installEnv();
    let a = await fresh();
    let { seen, cabinet } = world();
    const first = await a.burn(light());
    const { burnTx } = first.activation;
    await eventually(() => cabinet.rows.get(W)?.state === 'recorded', 'the burn is recorded on aiqnet.io');
    const code = core.generateActivationCode('light', OWNER, burnTx, 1500);

    // the vault and its kept searches are gone, a new worker runs, and this search does not reach the burn yet
    const txs = { [burnTx]: burnJson({ signature: burnTx }) };
    let env = installEnv();
    a = await fresh();
    ({ seen } = world({ cabinet, txs }));
    for (const nodeType of ['light', 'super']) {
      await rejectsWith(a.burn(light({ nodeType })), 'ACTIVATION_RECORDED');
      await rejectsWith(a.activateForSite({ nodeType, expectedPrice: 1500 }), 'ACTIVATION_RECORDED');
    }
    assert.equal(seen.sent.length + seen.simulated.length, 0);
    // the Activate tab finds the code at once: the record of the wallet's own burn, read back from Solana, is stored
    const view = await a.lookup();
    assert.equal(view.view, 'activation');
    assert.equal(view.activation.burnTx, burnTx);
    assert.equal(env.state().activation.code, code);
    assertSafeResult(view);
    assert.deepEqual(await a.copyCode(), { code });

    // aiqnet.io down, a second install with the same phrase: the search of the wallet's own address finds the burn
    env = installEnv();
    a = await fresh();
    let site;
    ({ seen, cabinet: site } = world({ history: [listed(txs[burnTx])], txs }));
    site.fail.get = 'down';
    await rejectsWith(a.burn(light({ nodeType: 'super' })), 'BURN_EXISTS');
    assert.equal(seen.sent.length, 0);
    assert.deepEqual(await a.siteActivation(), {
      status: 'exists', qnet: W, solana: OWNER, nodeType: 'light', burnTx, burnAmount: 1500, code, paidOnSite: false,
    });
    assert.equal(env.state().activation.burnTx, burnTx);
  });

  it('records on aiqnet.io a vault activation it does not hold yet, and keeps its record of another burn as the wallet\'s code', async () => {
    const ownTx = burnJson({ signature: fakeSignature(5100) });
    const burnTx = fakeSignature(5100);
    const code = core.generateActivationCode('light', OWNER, burnTx, 1500);
    const stored = { code, nodeType: 'light', burnTx, burnAmount: 1500, solanaAddress: OWNER, cluster: 'devnet', createdAt: 1 };
    installEnv({ state: { ...emptyState(), activation: stored } });
    let a = await fresh();
    let { cabinet } = world({ txs: { [burnTx]: ownTx } });
    await a.syncRecord();
    const kept = cabinet.rows.get(W);
    assert.deepEqual([kept.state, kept.way, kept.burnTx, kept.burner, kept.nodeType], ['recorded', 'extension', burnTx, OWNER, 'light']);
    assert.equal(proofValid({ wallet: W, nodeType: 'light', burner: OWNER, burnTx, burnAmount: 1500 }, kept.proof), true);
    await a.syncRecord();
    assert.deepEqual([cabinet.of('get').length, cabinet.of('record').length], [1, 1], 'once per burn');
    // the site's read and the Activate tab start it too, and never wait for it
    assert.equal((await a.siteActivation()).code, code);

    // aiqnet.io keeps a payment burn for good: that is the wallet's code, and the vault's burn gives none (decision 36)
    const paidTx = fakeSignature(5101);
    installEnv({ state: { ...emptyState(), activation: stored } });
    a = await fresh();
    ({ cabinet } = world({ txs: { [burnTx]: ownTx, [paidTx]: burnJson({ signature: paidTx, owner: STRANGER }) } }));
    cabinet.put(row({ state: 'recorded', way: 'payment', burner: STRANGER, burnTx: paidTx }));
    await a.syncRecord();
    assert.equal(cabinet.of('record').length, 0, 'a payment burn is never replaced');
    const view = await a.lookup();
    assert.equal(view.view, 'record');
    assert.deepEqual([view.record.paidOnSite, view.record.burnTx, view.keptBurn.burnTx], [true, paidTx, burnTx]);
    const walletCode = core.walletActivationCode(W, paidTx, 1500);
    assert.equal(view.record.codeMasked, a.maskCode(walletCode));
    assert.deepEqual(await a.copyCode(), { code: walletCode });
    assertSafeResult(view);

    // an older burn of the same address replaces a younger one aiqnet.io holds (the extension's oldest-burn rule)
    installEnv({ state: { ...emptyState(), activation: stored } });
    a = await fresh();
    const slots = { [burnTx]: 1, [fakeSignature(5102)]: 2 };
    ({ cabinet } = world({ txs: { [burnTx]: ownTx }, cabinet: createCabinet({ slotOf: (tx) => slots[tx] }) }));
    cabinet.put(row({ state: 'recorded', burnTx: fakeSignature(5102) }));
    await a.syncRecord();
    assert.equal(cabinet.rows.get(W).burnTx, burnTx);
    assert.equal((await a.lookup()).view, 'activation');
  });

  it('the approval window offers no burn while the search of the wallet runs, and none of what the search finds', async () => {
    installEnv();
    const a = await fresh();
    let open = null;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    world({ listing: async () => { await gate; return []; } });
    const [view, site] = await Promise.all([a.siteView('light'), a.siteActivation()]);
    assert.deepEqual([view.mode, view.reason, view.cost], ['checking', null, null]);
    assert.deepEqual(site, { status: 'searching', qnet: W, solana: OWNER });
    open();
    await eventually(() => true);
    let after;
    for (let i = 0; i < 20 && after?.mode !== 'burn'; i += 1) after = await a.siteView('light');
    assert.equal(after.mode, 'burn');
    assert.equal((await a.siteActivation()).status, 'none');

    // a burn the search finds is stored and shown, never offered again
    const env = installEnv();
    const b = await fresh();
    const found = burnJson({ signature: fakeSignature(5200), memo: MEMO_OF.super });
    world({ history: [listed(found, MEMO_OF.super)], txs: { [fakeSignature(5200)]: found } });
    const shown = await b.siteView('light');
    assert.equal(shown.mode, 'exists');
    assert.equal(shown.activation.nodeType, 'super');
    assert.equal(env.state().activation.burnTx, fakeSignature(5200));
  });

  it('qnet_getActivation\'s reads: exists (own or paid on aiqnet.io), pending, unknown, unusable, none', async () => {
    const burnTx = fakeSignature(5300);
    const own = { code: core.generateActivationCode('super', OWNER, burnTx, 1500), nodeType: 'super', burnTx, burnAmount: 1500, solanaAddress: OWNER, cluster: 'devnet', createdAt: 1 };
    installEnv({ state: { ...emptyState(), activation: own } });
    let a = await fresh();
    world();
    assert.deepEqual(await a.siteActivation(), {
      status: 'exists', qnet: W, solana: OWNER, nodeType: 'super', burnTx, burnAmount: 1500, code: own.code, paidOnSite: false,
    });
    const paid = {
      code: core.walletActivationCode(W, burnTx, 1500), nodeType: 'light', burnTx, burnAmount: 1500, solanaAddress: STRANGER, cluster: 'devnet', createdAt: 1,
    };
    const registration = {
      nodeId: core.lightNodeId(W), burnTx, burner: STRANGER, state: 'onchain', attempts: 0, nextAt: 0, txHash: null, admittedAt: null,
      lastError: null, updatedAt: 1,
    };
    installEnv({ state: { ...emptyState(), activation: paid, registration } });
    a = await fresh();
    world();
    assert.deepEqual(await a.siteActivation(), {
      status: 'exists', qnet: W, solana: OWNER, nodeType: 'light', burnTx, burnAmount: 1500, code: paid.code, paidOnSite: true,
    });
    const pendingBurn = { burnTx, nodeType: 'light', burnAmount: 1500, solanaAddress: OWNER, cluster: 'devnet', createdAt: Date.now(), lastValidBlockHeight: 1000 };
    installEnv({ state: { ...emptyState(), pendingBurn } });
    a = await fresh();
    world({ statuses: () => null, blockHeight: 900 });
    assert.deepEqual(await a.siteActivation(), { status: 'pending', qnet: W, solana: OWNER, nodeType: 'light', burnTx, burnAmount: 1500 });
    installEnv();
    a = await fresh();
    world({ listing: () => { throw new Error('down'); } });
    assert.deepEqual(await a.siteActivation(), { status: 'unknown', qnet: W, solana: OWNER, reason: 'SOLANA_UNAVAILABLE' });
    installEnv();
    a = await fresh();
    const full = burnJson({ signature: fakeSignature(5301), memo: 'QNET_NODE_TYPE:FULL' });
    world({ history: [listed(full, 'QNET_NODE_TYPE:FULL')], txs: { [fakeSignature(5301)]: full } });
    assert.deepEqual(await a.siteActivation(), { status: 'unusable', qnet: W, solana: OWNER });
    installEnv();
    a = await fresh();
    const { seen, cabinet } = world();
    assert.deepEqual(await a.siteActivation(), { status: 'none', qnet: W, solana: OWNER });
    assert.equal(seen.sent.length + seen.simulated.length + cabinet.requests.length, 0, 'a read burns, reserves and records nothing');
    installEnv({ locked: true });
    a = await fresh();
    world();
    await rejectsWith(a.siteActivation(), 'LOCKED');
  });

  it('the Activate tab\'s view: every source\'s "none", a payment record, an activation elsewhere, a node, a source that cannot answer', async () => {
    let env = installEnv();
    let a = await fresh();
    world();
    let view = await a.lookup();
    assert.deepEqual([view.view, view.network, view.search, view.reason, view.record], ['none', 'none', 'none', null, null]);

    // a light burn aiqnet.io's payment key made, recorded once final: shown with the wallet's code, never stored
    const paidTx = fakeSignature(5400);
    env = installEnv();
    a = await fresh();
    let cabinet;
    ({ cabinet } = world({ txs: { [paidTx]: burnJson({ signature: paidTx, owner: STRANGER }) } }));
    cabinet.put(row({ state: 'recorded', way: 'payment', burner: STRANGER, burnTx: paidTx }));
    view = await a.lookup();
    assert.equal(view.view, 'record');
    assert.equal(view.record.codeMasked, a.maskCode(core.walletActivationCode(W, paidTx, 1500)));
    assert.equal(env.state().activation, null, 'never stored or registered here');
    assert.deepEqual(await a.copyCode(), { code: core.walletActivationCode(W, paidTx, 1500) });
    await rejectsWith(a.burn(light()), 'ACTIVATION_RECORDED');
    assertSafeResult(view);
    // one whose burn is not the burn it names is no code: the wallet has a node, and no burn is offered
    installEnv();
    a = await fresh();
    ({ cabinet } = world({ txs: { [paidTx]: burnJson({ signature: paidTx, owner: STRANGER, amount: '1400000000' }) } }));
    cabinet.put(row({ state: 'recorded', way: 'payment', burner: STRANGER, burnTx: paidTx }));
    assert.equal((await a.lookup()).view, 'node');

    for (const [fields, state] of [[{ state: 'reserved', until: Date.now() + 300000 }, 'reserved'],
      [{ state: 'reserved', way: 'payment', burner: STRANGER, until: Date.now() + 300000 }, 'reserved'],
      [{ state: 'sending', way: 'payment', burner: STRANGER, burnTx: paidTx, until: Date.now() + 300000 }, 'sending']]) {
      installEnv();
      a = await fresh();
      ({ cabinet } = world());
      cabinet.put(row(fields));
      view = await a.lookup();
      assert.deepEqual([view.view, view.record.state], ['elsewhere', state]);
    }
    // the payment burn is final: recorded for good, and shown with the wallet's code
    installEnv();
    a = await fresh();
    ({ cabinet } = world({ txs: { [paidTx]: burnJson({ signature: paidTx, owner: STRANGER }) } }));
    cabinet.put(row({ state: 'sending', way: 'payment', burner: STRANGER, burnTx: paidTx, until: Date.now() + 300000 }));
    view = await a.lookup();
    assert.deepEqual([view.view, view.record.state, view.record.paidOnSite], ['record', 'recorded', true]);
    assert.equal(cabinet.rows.get(W).state, 'recorded');
    installEnv();
    a = await fresh();
    world({ lightStatus: () => ({ onchain_registered: true }) });
    assert.equal((await a.lookup()).view, 'node');
    installEnv();
    a = await fresh();
    ({ cabinet } = world());
    cabinet.fail.get = 'down';
    assert.deepEqual([(view = await a.lookup()).view, view.reason], ['unavailable', 'RECORD_UNAVAILABLE']);
    installEnv();
    a = await fresh();
    world({ verify: () => null });
    assert.deepEqual([(view = await a.lookup()).view, view.reason], ['unavailable', 'NETWORK']);
  });

  it('a search verdict the vault no longer holds (a reset and a restore in the same worker) is no "none": the tab checks again', async () => {
    const burnTx = fakeSignature(5500);
    const found = burnJson({ signature: burnTx });
    installEnv();
    const a = await fresh();
    world({ history: [listed(found)], txs: { [burnTx]: found } });
    assert.equal((await a.lookup()).view, 'activation');
    await a.syncRecord();
    // the vault is empty again, the same worker runs, aiqnet.io and the network know nothing yet
    const env = installEnv();
    const { seen } = world({ history: [listed(found)], txs: { [burnTx]: found } });
    const views = [(await a.lookup()).view];
    assert.notEqual(views[0], 'none', 'the Light and Super cards are never drawn on a verdict the vault does not hold');
    for (let i = 0; i < 5 && views.at(-1) !== 'activation'; i += 1) views.push((await a.lookup()).view);
    assert.equal(views.at(-1), 'activation', views.join());
    assert.ok(!views.includes('none'), views.join());
    assert.equal(env.state().activation.burnTx, burnTx);
    assert.equal(seen.sent.length + seen.simulated.length, 0);
  });
});
