// qnet.js, offline: raw-JSON reading of u64 fields, the pinned and hedged node client, the balance at a pinned node's live
// tip and the same balance verified against the committee's certificate in the background (a certified proof folded to
// the state root of a macroblock the light client verifies, the older node's live-root proof only when its root is a
// recent certified one, never what nodes agree on, never a default), the send rule at the live tip, the signed transfer
// (preimage, signature, submit body, pending record before the POST), resubmission of identical bytes, a sent
// transaction's status, and the explorer history. The network certifies its state for real (helpers/certified-net.mjs).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./helpers/chains-activation-loader.mjs', import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const raw = (name) => readFileSync(path.join(HERE, 'fixtures', name), 'utf8');
const core = await import('../dist/lib/qnet-core.js');
const { QNET } = await import('../dist/background/config.js');
const { WalletError } = await import('../dist/background/errors.js');
const {
  WALLET, installEnv, installFetch, emptyState, routes, flush,
} = await import('./helpers/chains-activation-env.mjs');
const { FIRST_INDEX, NOBLE_INSTALLED, certifiedNet, accountAnswer } = await import('./helpers/certified-net.mjs');

// Every test runs on a fresh worker: the proofs, nonces and heads one test read never stand in another's. What a worker
// left running (a certified check beside a live figure, a run of resubmitPending) ends before the next test replaces the
// network (qnet.backgroundReads), so none of its requests lands there.
let qnet;
let workers = 0;
const loaded = [];
const worker = async (tag) => {
  const instance = await import(`../dist/background/qnet.js?${tag}`);
  loaded.push(instance);
  return instance;
};
beforeEach(async () => {
  workers += 1;
  qnet = await worker(`worker=${workers}`);
});
afterEach(async () => {
  await Promise.all(loaded.splice(0).map((instance) => instance.backgroundReads()));
});

const ME = WALLET.qnetAddress;
const G1 = '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d';
const TO = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
const TX_HASH = 'ab'.repeat(32);
const FEE = String(core.fees.TRANSFER_FEE_NANO);

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WalletError || error?.name === 'CoreError', `${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

// Routes requests to the pinned nodes: handler({node, path, request}) → {status?, body} | undefined.
const nodeRoute = (handler) => async (request) => {
  const url = new URL(request.url);
  if (!QNET.NODES.includes(url.origin)) return undefined;
  return handler({ node: url.origin, path: url.pathname + url.search, request });
};

const accountText = (address, balance, nonce, pk = false) => (
  `{"address":"${address}","balance":${balance},"has_dilithium_pk":${pk},"is_node":false,"node_type":null,"nonce":${nonce},"reputation":0.0}`);

/**
 * The certified network (helpers/certified-net.mjs, installed: a fresh light client rooted at its anchors) with this
 * wallet's account at `balance` and `nonce` in its certified state, and every pinned node reporting the same account on
 * GET /api/v1/account/{a}, the chain's nonce now (perNode: node → {balance, nonce, pk} | null: that node's answer, null
 * for a node down). `accounts` and `tokens` add to the certified state, `logsRoot` is its checkpoint's logs_root; `net`
 * tunes the nodes (helpers/certified-net.mjs).
 */
function chain({
  balance = '5000000000000', nonce = '0', pk = false, perNode = null, onPost = null, sent = null, accounts = {}, tokens = {},
  logsRoot = undefined,
} = {}) {
  if (!NOBLE_INSTALLED) throw new Error('run npm run bundle:install: the test committee signs with the bundle\'s ML-DSA-65');
  const log = { posts: [], sentReads: 0 };
  const net = certifiedNet({ accounts: { [ME]: { balance, nonce }, ...accounts }, tokens, logsRoot }).install();
  const route = nodeRoute(async ({ node, path: p, request }) => {
    // this wallet's applied sends, each with its nonce (resubmitPending decides a passed nonce by them)
    if (p.startsWith('/api/v1/transactions/history?')) {
      log.sentReads++;
      // `sent`: the rows every node lists, or node → rows (null: that node has no history)
      const rows = typeof sent === 'function' ? sent(node) : sent;
      if (rows === null) return { status: 404, body: '{"error":"not found"}' };
      return { body: { transactions: rows } };
    }
    const account = /^\/api\/v1\/account\/([0-9a-z]+)$/.exec(p);
    if (account) {
      const fields = net.newest().fieldsOf.get(account[1]);
      const answer = perNode ? perNode(node, account[1]) : { balance: fields?.balance ?? '0', nonce: fields?.nonce ?? '0', pk };
      if (answer === null) throw new TypeError('node down');
      return { body: accountText(account[1], answer.balance, answer.nonce, answer.pk) };
    }
    if (p === '/api/v1/transaction' && request.method === 'POST') {
      log.posts.push(request);
      return onPost ? onPost(request) : { body: { success: true, tx_hash: TX_HASH, message: 'Transaction submitted successfully' } };
    }
    // no contract at any address: a transfer's recipient check (qnet.assertPayableRecipient) passes
    const token = /^\/api\/v1\/token\/([0-9a-z]+)$/.exec(p);
    if (token) return { body: { success: false, error: 'Token not found', contract_address: token[1] } };
    return undefined;
  });
  return { route: routes(route, net.route), log, net };
}

describe('chains-activation qnet: raw JSON', () => {
  it('keeps every number as its literal, so u64 values survive exactly', () => {
    const text = '{"balance":18446744073709551615,"nonce":9007199254740993,"f":-1.5e3,"a":[1,true,null,"x\\"y"],"o":{}}';
    assert.deepEqual(qnet.parseJsonLossless(text), {
      balance: '18446744073709551615', nonce: '9007199254740993', f: '-1.5e3', a: ['1', true, null, 'x"y'], o: {},
    });
    assert.equal(JSON.parse(text).nonce, 9007199254740992, 'what JSON.parse would have done');
  });

  it('parses the recorded node and explorer answers like JSON.parse, numbers aside', () => {
    for (const name of ['chains-activation-proof-g1.json', 'chains-activation-account-g1.json', 'chains-activation-history-g1.json']) {
      const text = raw(name);
      const numbersAsText = JSON.parse(text, (key, value) => (typeof value === 'number' ? String(value) : value));
      const lossless = qnet.parseJsonLossless(text);
      assert.equal(JSON.stringify(Object.keys(lossless)), JSON.stringify(Object.keys(numbersAsText)), name);
    }
    assert.equal(qnet.parseJsonLossless(raw('chains-activation-account-g1.json')).balance, '2909459674500000');
  });

  it('keeps "__proto__" an own key and refuses malformed text', () => {
    const parsed = qnet.parseJsonLossless('{"__proto__":{"polluted":1}}');
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
    assert.equal(parsed.polluted, undefined);
    assert.deepEqual(Object.keys(parsed), ['__proto__']);
    for (const bad of ['', '{', '{"a":1,}', '[1 2]', '01', '1.', 'tru', '{"a":1} x', '"\u0001"', `${'['.repeat(80)}${']'.repeat(80)}`, 5]) {
      assert.throws(() => qnet.parseJsonLossless(bad), SyntaxError, String(bad));
    }
  });
});

describe('chains-activation qnet: node client', () => {
  it('asks only the pinned HTTPS nodes, without credentials or redirects', async () => {
    const requests = installFetch(nodeRoute(() => ({ body: '{"ok":true}' })));
    const reply = await qnet.nodeRequest('/api/v1/height');
    assert.equal(reply.status, 200);
    assert.ok(QNET.NODES.includes(reply.node));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${reply.node}/api/v1/height`);
    assert.equal(requests[0].init.credentials, 'omit');
    assert.equal(requests[0].init.redirect, 'error');
    assert.ok(QNET.NODES.every((n) => n.startsWith('https://')));
  });

  it('refuses other paths, hosts and headers before any request', async () => {
    const requests = installFetch(() => ({ body: '{}' }));
    for (const p of ['/api/v2/x', 'api/v1/x', '/api/v1/../admin', '/api/v1//x', `/api/v1/x${'a'.repeat(1100)}`, '/api/v1/a b']) {
      await rejectsWith(qnet.nodeRequest(p), 'INTERNAL');
    }
    await rejectsWith(qnet.nodeRequest('/api/v1/x', { nodes: ['https://evil.example'] }), 'INTERNAL');
    await rejectsWith(qnet.nodeRequest('/api/v1/x', { headers: { authorization: 'x' } }), 'INTERNAL');
    await rejectsWith(qnet.nodeRequest('/api/v1/x', { headers: { 'x-qnet-wallet': 'a\nb' } }), 'INTERNAL');
    assert.equal(requests.length, 0);
  });

  it('hedges: a silent node is joined by the next, the first answer wins and the other is aborted', async () => {
    let silent = null;
    const requests = installFetch(nodeRoute(({ node, request }) => {
      if (silent === null) {
        silent = node;
        return new Promise((resolve, reject) => {
          request.init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return { body: '{"height":1}' };
    }));
    const reply = await qnet.nodeRequest('/api/v1/height', { hedgeMs: 20 });
    assert.notEqual(reply.node, silent);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].init.signal.aborted, true);
  });

  it('5xx and 429 hand over to the next node; no answer at all is NETWORK', async () => {
    let calls = 0;
    installFetch(nodeRoute(() => {
      calls++;
      return calls < 3 ? { status: calls === 1 ? 503 : 429, body: '' } : { body: '{"ok":1}' };
    }));
    assert.equal((await qnet.nodeRequest('/api/v1/height', { hedgeMs: 5000 })).status, 200);
    assert.equal(calls, 3);
    installFetch(() => {
      throw new TypeError('offline');
    });
    await rejectsWith(qnet.nodeRequest('/api/v1/height'), 'NETWORK');
  });

  it('a POST body given as text is sent byte for byte', async () => {
    const requests = installFetch(nodeRoute(() => ({ body: '{}' })));
    const body = '{"amount":18446744073709551615}';
    await qnet.nodeRequest('/api/v1/transaction', { method: 'POST', body });
    assert.equal(requests[0].body, body);
    assert.equal(requests[0].headers['Content-Type'], 'application/json');
  });
});

describe('chains-activation qnet: verified balance and nonce', () => {
  beforeEach(() => installEnv());

  it('a certified proof folds to the state root of the macroblock it names, which the light client verifies itself', async () => {
    const { route, net } = chain({ balance: '2909459674500000', nonce: '2' });
    const requests = installFetch(route);
    assert.deepEqual(await qnet.readAccount(ME), {
      balanceNano: '2909459674500000', nonce: '2', verified: true, verification: 'proof', blockHeight: FIRST_INDEX * 90, index: FIRST_INDEX,
    });
    assert.ok(net.requests.some((r) => r.endsWith(`/api/v1/account/${ME}/balance/proof?mb=latest`)), 'the certified form is asked for');
    assert.ok(net.requests.some((r) => r.endsWith(`/api/v1/macroblock/${FIRST_INDEX}/proof`)), 'its macroblock is walked to');
    // freshness is judged by the certified head the nodes report, never by the applied tip
    assert.ok(net.requests.some((r) => r.endsWith('/api/v1/state/certified')));
    assert.ok(!requests.some((r) => r.url.endsWith('/api/v1/height')));
  });

  it('the root a node names is never trusted: a proof that folds to another root verifies nothing, and decides no send', async () => {
    const { route } = chain({ balance: '1000' });
    const forged = certifiedNet({ accounts: { [ME]: { balance: '999999999999' } } }).newest();
    installFetch(routes(nodeRoute(({ path: p }) => (p.startsWith(`/api/v1/account/${ME}/balance/proof`)
      ? { body: accountAnswer(forged, ME) } : undefined)), route));
    const account = await qnet.readAccount(ME);
    assert.deepEqual([account.balanceNano, account.verified, account.verification], ['999999999999', false, 'none'],
      'shown as not verified: it folds only under the root its node named');
    await rejectsWith(qnet.prepareTransfer({ to: TO, amountNano: '1' }), 'BALANCE_UNCONFIRMED');
  });

  it('an absent account is a certified 0 only with its absence proof; a 0 no certificate verified is never shown', async () => {
    const { route, net } = chain();
    installFetch(route);
    assert.deepEqual(await qnet.readAccount(G1), {
      balanceNano: '0', nonce: '0', verified: true, verification: 'proof', blockHeight: FIRST_INDEX * 90, index: FIRST_INDEX,
    });
    net.headless = true;
    const fresh = await worker(`absent=${Date.now()}`);
    core.clearQcCache();
    net.install();
    await rejectsWith(fresh.readAccount(G1), 'BALANCE_UNCONFIRMED');
  });

  it('an older node\'s live-root proof counts when its root is a recent certified one; the node is marked old, and asked last', async () => {
    const realRandom = Math.random;
    Math.random = () => 0.999999; // the pinned nodes in their own order
    try {
      const { route, net } = chain({ balance: '5000000000', nonce: '3' });
      const [old] = QNET.NODES;
      net.old.add(old);
      installFetch(route);
      const account = await qnet.readAccount(ME);
      assert.deepEqual([account.balanceNano, account.nonce, account.verification, account.index], ['5000000000', '3', 'proof', FIRST_INDEX]);
      assert.equal(core.nodeMarkedOld(old), true, 'its body has the older shape: marked old');
      assert.equal(core.nodeMarkedOld(QNET.NODES[1]), false);
      // the next read asks it last
      net.requests.length = 0;
      await qnet.readAccount(ME);
      const asked = net.requests.filter((r) => r.includes('/balance/proof'));
      assert.ok(!asked[0].startsWith(old), asked[0]);
      // a live root no macroblock certifies (an account changed since) is no answer: the next node is asked
      const moved = certifiedNet({ accounts: { [ME]: { balance: '1' } } }).newest();
      installFetch(routes(nodeRoute(({ node, path: p }) => (node === old && p.startsWith(`/api/v1/account/${ME}/balance/proof`)
        ? { body: { address: ME, balance: 1, nonce: 0, block_height: FIRST_INDEX * 90 + 45, proof_valid: true, state_root: moved.root,
          merkle_proof: moved.tree.prove(core.accountKeyHash(ME)).steps } } : undefined)), route));
      core.clearQcCache();
      net.install();
      const again = await worker(`oldRoot=${Date.now()}`);
      assert.equal((await again.readAccount(ME)).balanceNano, '5000000000');
    } finally {
      Math.random = realRandom;
    }
  });

  it('an older node claiming a height far past the certified head is not walked to', async () => {
    const { route, net } = chain({ balance: '5000000000' });
    const far = net.newest();
    installFetch(routes(nodeRoute(({ path: p }) => (p.startsWith(`/api/v1/account/${ME}/balance/proof`)
      ? { body: { address: ME, balance: 5000000000, nonce: 0, block_height: (FIRST_INDEX + 500) * 90, proof_valid: true, state_root: far.root,
        merkle_proof: far.tree.prove(core.accountKeyHash(ME)).steps } } : undefined)), route));
    const account = await qnet.readAccount(ME);
    assert.deepEqual([account.verified, account.verification], [false, 'none']);
    assert.ok(!net.requests.some((r) => r.includes('/macroblock/')), net.requests.filter((r) => r.includes('/macroblock/')).join(' '));
  });

  it('the recorded older proof folds with every field it carries, but below the trust floor it is never QC-checked', async () => {
    const proofText = raw('chains-activation-proof-g1.json');
    const log = { macroblocks: 0 };
    installFetch(nodeRoute(({ path: p }) => {
      if (p.startsWith('/api/v1/macroblock/')) log.macroblocks++;
      if (p.startsWith(`/api/v1/account/${G1}/balance/proof`)) return { body: proofText };
      if (p === '/api/v1/state/certified') return { status: 404, body: '{}' };
      if (p === '/api/v1/debug/consensus-position') return { status: 404, body: '{}' };
      return undefined;
    }));
    const proof = JSON.parse(proofText);
    const leaf = { address: G1, balance: String(proof.balance), nonce: String(proof.nonce), lastClaimedEpoch: String(proof.last_claimed_epoch), isNode: true };
    assert.equal(core.verifyAccountProof(leaf, proof.merkle_proof, proof.state_root), true);
    assert.equal(core.verifyAccountProof({ ...leaf, bannedAtHeight: '1' }, proof.merkle_proof, proof.state_root), false, 'every field counts');
    assert.deepEqual(await qnet.readAccount(G1), {
      balanceNano: '2909459674500000', nonce: '2', verified: false, verification: 'none', blockHeight: proof.block_height, index: null,
    });
    assert.equal(log.macroblocks, 0);
  });

  it('a certified index stands only within two of the certified head, below or above it (R2-EXTQ-01)', () => {
    const head = 24_016;
    // a day-old certified answer (index 23 365) loses to the head
    assert.equal(qnet.certifiedIndexStands(23_365, head), false);
    assert.equal(qnet.certifiedIndexStands(head, null), false, 'no head to read, no proof');
    assert.equal(qnet.certifiedIndexStands(head, head), true);
    assert.equal(qnet.certifiedIndexStands(head - 2, head), true, 'two macroblocks behind is recent');
    assert.equal(qnet.certifiedIndexStands(head - 3, head), false);
    assert.equal(qnet.certifiedIndexStands(head + 2, head), true);
    assert.equal(qnet.certifiedIndexStands(head + 3, head), false, 'far past the head is not walked to');
  });

  it('a certified state far below the certified head is no answer: a node may replay one from before a spend', async () => {
    const { route, net } = chain({ balance: '9000000000' });
    for (const node of QNET.NODES) net.frontier.set(node, FIRST_INDEX + 10);
    installFetch(route);
    // the nodes report a frontier ten macroblocks on, but serve the old state
    const stale = await qnet.readAccount(ME);
    assert.deepEqual([stale.verified, stale.verification], [false, 'none']);
    // a send stands on the live tip, which no replayed certified state touches
    assert.deepEqual((await qnet.prepareTransfer({ to: ME, amountNano: '1' })).verification, 'live');
  });

  it('a u64 balance above 2^53 is reported exactly', async () => {
    installFetch(chain({ balance: '18446744073709551615', nonce: '7' }).route);
    assert.deepEqual(await qnet.getBalance(), {
      balanceNano: '18446744073709551615', spendableNano: '18446744073709551615', nonce: '7', verified: false,
      verification: 'live', blockHeight: FIRST_INDEX * 90 + 45,
    });
  });

  it('the nodes\' account never moves a balance: the figure a proof covers decides, whatever two nodes report', async () => {
    installFetch(chain({ balance: '100', nonce: '9', perNode: () => ({ balance: '99999999999', nonce: '9', pk: true }) }).route);
    const balance = await qnet.getBalance();
    assert.deepEqual([balance.balanceNano, balance.spendableNano, balance.verification], ['100', '100', 'live']);
    assert.deepEqual(await qnet.resolveNonce(ME), { nextNonce: '10', pkBound: true });
  });

  it('no certified state: the live figure shows and sends go from it; without one either, the certified answer shows as not verified, a send says why, nothing is defaulted', async () => {
    const { route, net } = chain({ balance: '100', nonce: '1' });
    net.headless = true;
    installFetch(route);
    const live = await qnet.getBalance();
    assert.deepEqual([live.balanceNano, live.verified, live.verification, live.spendableNano], ['100', false, 'live', '100']);
    assert.deepEqual(await qnet.resolveNonce(ME), { nextNonce: '2', pkBound: false });
    net.live = false;
    const balance = await qnet.getBalance();
    assert.deepEqual([balance.balanceNano, balance.verified, balance.verification, balance.spendableNano], ['100', false, 'none', null]);
    await rejectsWith(qnet.resolveNonce(ME), 'BALANCE_UNCONFIRMED');
    await rejectsWith(qnet.prepareTransfer({ to: ME, amountNano: '1' }), 'BALANCE_UNCONFIRMED');
    installFetch(() => {
      throw new TypeError('offline');
    });
    await rejectsWith(qnet.getBalance(), 'NETWORK');
    await rejectsWith(qnet.resolveNonce(ME), 'NETWORK');
  });

  it('a live figure of the tip shows over an older certified one; a verified state of its height or newer shows verified', async () => {
    installEnv();
    const { route, net } = chain({ balance: '5000000000', nonce: '0' });
    net.setTip({ [ME]: { balance: '7000000000', nonce: '0' } });
    installFetch(route);
    const tip = await qnet.getBalance();
    assert.deepEqual([tip.balanceNano, tip.verified, tip.verification, tip.blockHeight], ['7000000000', false, 'live', FIRST_INDEX * 90 + 60]);
    // a live answer of a state older than the certified one: the verified one shows (once its read came)
    net.setTip({ [ME]: { balance: '1', nonce: '0' } }, {}, FIRST_INDEX * 90 - 10);
    const fresh = await worker(`olderTip=${Date.now()}`);
    net.install();
    assert.deepEqual(await fresh.readAccount(ME).then((a) => a.verification), 'proof');
    // the certified read is not waited for beside a live figure: a read after it came shows it
    let shown = await fresh.getBalance();
    for (let i = 0; i < 20 && shown.verification !== 'proof'; i++) shown = await fresh.getBalance();
    assert.deepEqual([shown.balanceNano, shown.verified, shown.verification], ['5000000000', true, 'proof']);
    assert.equal(shown.spendableNano, '1', 'what is left to spend is the live figure\'s');
  });

  it('answers about another address are ignored', async () => {
    const { route, net } = chain();
    installFetch(routes(nodeRoute(({ path: p }) => (p.startsWith(`/api/v1/account/${ME}/balance/proof`)
      ? { body: accountAnswer(net.newest(), G1) } : undefined)), route));
    await rejectsWith(qnet.getBalance(), 'BALANCE_UNCONFIRMED');
  });

  it('the next nonce is the chain\'s + 1 + the wallet\'s own unconfirmed sends, whose amounts are kept back', async () => {
    const createdAt = Date.now();
    const pending = (nonce) => ({
      nonce, to: TO, amountNano: '1000', feeNano: FEE, body: `{"n":${nonce}}`, txHash: null, createdAt, lastSubmitAt: createdAt, outcome: 'pending', kind: 'transfer', call: null,
    });
    installEnv({ state: { ...emptyState(), pendingTransfers: [pending('1'), pending('2'), pending('3')] } });
    installFetch(chain({ nonce: '1' }).route);
    assert.deepEqual(await qnet.resolveNonce(ME), { nextNonce: '4', pkBound: false });
    const preview = await qnet.preview({ to: TO, amount: '1.5' });
    assert.deepEqual(preview, {
      from: ME,
      to: TO,
      amountNano: '1500000000',
      feeNano: FEE,
      totalNano: String(1500000000 + Number(FEE)),
      nonce: '4',
      balanceNano: String(5000000000000n - 2n * (1000n + BigInt(FEE))),
      verified: false,
      verification: 'live',
      // the earlier sends the chain has not taken yet: this one goes in addition to them (R2-EXTQ-03)
      outstanding: ['2', '3'].map((nonce) => ({ nonce, to: TO, amountNano: '1000', feeNano: FEE, createdAt, stale: false, refused: false, kind: 'transfer' })),
      replacesNonce: null,
      // nonces 2 and 3 are not in a block yet: the node admits only nonce 2 now, so a dApp's request waits
      inFlight: true,
      // a pending send makes TO a known recipient; the archive is not reachable here
      recipient: { known: true, lookalike: false, incomingOnly: false, historyRead: false },
    });
  });

  it('refuses while locked and for invalid input', async () => {
    installFetch(chain().route);
    await rejectsWith(qnet.prepareTransfer({ to: 'nope', amountNano: '1' }), 'INVALID_ADDRESS');
    await rejectsWith(qnet.prepareTransfer({ to: TO, amountNano: '0' }), 'INVALID_AMOUNT');
    await rejectsWith(qnet.preview({ to: TO, amount: '0.0000000001' }), 'INVALID_AMOUNT');
    installEnv({ locked: true });
    await rejectsWith(qnet.getBalance(), 'LOCKED');
  });
});

// The owner's rule (18.10), as the app: a send is decided at a pinned node's live tip, in one read. Every transaction of
// this wallet at or below the tip's nonce is in its balance already, those above it stay reserved, what arrived counts at
// once, and the network itself refuses what that figure does not cover.
describe('chains-activation qnet: the send rule at the live tip', () => {
  const sentRecord = (nonce, amountNano, extra = {}) => ({
    nonce, to: TO, amountNano, feeNano: FEE, body: `{"n":${nonce}}`, txHash: TX_HASH, createdAt: Date.now() - 60_000,
    lastSubmitAt: Date.now() - 60_000, outcome: 'pending', kind: 'transfer', call: null, ...extra,
  });

  it('right after the wallet\'s own send: the live balance less its own transactions above the live nonce; what arrived counts', async () => {
    // certified at nonce 0 with 10 QNC; the tip took the wallet's 2 QNC send at nonce 1, and 50 QNC arrived since; nonce 2
    // is still on its way
    installEnv({ state: { ...emptyState(), pendingTransfers: [sentRecord('1', '2000000000'), sentRecord('2', '1000000000')] } });
    const { route, net } = chain({ balance: '10000000000', nonce: '0' });
    net.setTip({ [ME]: { balance: '57999850000', nonce: '1' } });
    installFetch(route);
    const left = (57999850000n - 1000000000n - BigInt(FEE)).toString();
    const preview = await qnet.preview({ to: TO, amount: '1' });
    assert.deepEqual([preview.nonce, preview.balanceNano, preview.outstanding.map((p) => p.nonce), preview.verification],
      ['3', left, ['2'], 'live']);
    const balance = await qnet.getBalance();
    assert.deepEqual([balance.balanceNano, balance.spendableNano, balance.nonce, balance.verification], ['57999850000', left, '1', 'live']);
    await rejectsWith(qnet.send({ to: TO, amount: '57', expectedFeeNano: FEE }), 'INSUFFICIENT_FUNDS');
    assert.equal((await qnet.send({ to: TO, amount: '50', expectedFeeNano: FEE, expectedNonce: '3' })).nonce, '3');
  });

  it('a transaction from another device is in the live balance: the next nonce follows it, and nothing is refused for it', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [sentRecord('1', '2000000000')] } });
    const { route, net } = chain({ balance: '10000000000', nonce: '0' });
    // the tip holds nonce 2: this wallet's transfer at 1 and another device's at 2
    net.setTip({ [ME]: { balance: '5000000000', nonce: '2' } });
    installFetch(route);
    const preview = await qnet.preview({ to: TO, amount: '1' });
    assert.deepEqual([preview.nonce, preview.balanceNano, preview.outstanding], ['3', '5000000000', []]);
    const call = await qnet.prepareCall({ kind: 'contractCall', contract: core.deriveContractAddress(ME, 3), method: 'run', args: '', gasLimit: null });
    assert.equal(call.nonce, '3');
    assert.equal((await qnet.getBalance()).spendableNano, '5000000000');
    assert.equal((await qnet.send({ to: TO, amount: '1', expectedFeeNano: FEE, expectedNonce: '3' })).nonce, '3');
    assert.equal(env.calls.signQnetTransfer, 1);
  });

  // A node a block or more behind may answer first: the chain's nonce this wallet knows it reached (the agreed nonce, the
  // kept transactions decided there, the spend records settled since) is the floor, and what its own transactions took
  // after the lagging state comes off that state's balance (the mobile spendableFrom).
  it('after a confirmed send, a node behind never makes the next send reuse its nonce or count its amount again', async () => {
    const realRandom = Math.random;
    Math.random = () => 0.999999; // the pinned nodes in their own order: the lagging one is asked first
    try {
      const [lagging] = QNET.NODES;
      const sentAmount = 2_000_000_000n;
      const left = (10_000_000_000n - sentAmount - BigInt(FEE)).toString();
      installEnv({ state: { ...emptyState(), pendingTransfers: [sentRecord('5', String(sentAmount))] } });
      const { route, net } = chain({
        balance: '10000000000', nonce: '4', perNode: () => ({ balance: left, nonce: '5', pk: false }),
        sent: [{ from: ME, to: TO, amount: Number(sentAmount), nonce: 5, type: 'transfer', hash: 'ff'.repeat(32) }],
      });
      // the tip took the send at nonce 5; one node still serves the state before it
      net.setTip({ [ME]: { balance: left, nonce: '5' } }, {}, FIRST_INDEX * 90 + 70);
      net.setTip({ [ME]: { balance: '10000000000', nonce: '4' } }, {}, FIRST_INDEX * 90 + 65, lagging);
      installFetch(route);
      assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 1, replaced: 0, passed: 0 });
      // a woken worker knows the floor from the vault alone: the lagging answer does not end the read, the next node's does
      let woken = await worker(`floor=${Date.now()}`);
      net.requests.length = 0;
      const preview = await woken.preview({ to: TO, amount: '1' });
      assert.deepEqual([preview.nonce, preview.balanceNano], ['6', left]);
      const asked = net.requests.filter((r) => r.endsWith(`/api/v1/account/${ME}/balance/proof`)).map((r) => new URL(r).origin);
      assert.deepEqual(asked.slice(0, 2), [lagging, QNET.NODES[1]], 'the lagging node first, then the next');
      const shown = await woken.getBalance();
      assert.deepEqual([shown.balanceNano, shown.spendableNano, shown.blockHeight], [left, left, FIRST_INDEX * 90 + 70]);
      // only the lagging node answers: the shown figure does not go back to it, and a send counts the confirmed one off it
      const laggingOnly = routes(nodeRoute(({ node, path: p }) => (p === `/api/v1/account/${ME}/balance/proof` && node !== lagging
        ? { status: 503, body: '{}' } : undefined)), route);
      installFetch(laggingOnly);
      assert.deepEqual(await woken.getBalance().then((b) => [b.balanceNano, b.blockHeight]), [left, FIRST_INDEX * 90 + 70]);
      woken = await worker(`floorLagging=${Date.now()}`);
      const behind = await woken.preview({ to: TO, amount: '1' });
      assert.deepEqual([behind.nonce, behind.balanceNano], ['6', left], 'never nonce 5 again, never the amount sent counted as there');
      assert.deepEqual((await woken.getBalance()).spendableNano, left);
      // the confirmed record gone (the archive listed it): its settled spend record still holds the floor and the amount
      installEnv({ state: { ...emptyState(), spends: [{ nonce: '5', qncNano: (sentAmount + BigInt(FEE)).toString(), token: null, tokenAmount: null,
        tokenUnknown: false, settledAt: Date.now() }] } });
      woken = await worker(`floorSpends=${Date.now()}`);
      const settled = await woken.preview({ to: TO, amount: '1' });
      assert.deepEqual([settled.nonce, settled.balanceNano], ['6', left]);
      // a refused send the chain took, not decided yet: the agreed nonce this worker read keeps the next send off its
      // nonce (no default replace at a nonce the chain used)
      installEnv({ state: { ...emptyState(), pendingTransfers: [sentRecord('5', String(sentAmount), { outcome: 'refused' })] } });
      installFetch(routes(nodeRoute(({ path: p }) => (p.startsWith('/api/v1/transactions/history?') ? { body: { transactions: [] } } : undefined)),
        laggingOnly));
      woken = await worker(`floorRefused=${Date.now()}`);
      assert.deepEqual(await woken.sentStatus({ nonce: '5' }), { status: 'unknown' });
      const taken = await woken.preview({ to: TO, amount: '1' });
      assert.deepEqual([taken.nonce, taken.replacesNonce, taken.balanceNano], ['6', null, left]);
    } finally {
      Math.random = realRandom;
    }
  });

  it('a send check is one read at the live tip: no certified proof, no committee walk, no certified head', async () => {
    installEnv();
    const { route, net } = chain({ balance: '10000000000' });
    installFetch(route);
    const preview = await qnet.prepareTransfer({ to: ME, amountNano: '1' });
    assert.deepEqual([preview.nonce, preview.verification, preview.verified], ['1', 'live', false]);
    assert.ok(!net.requests.some((r) => r.includes('?mb=') || r.includes('/macroblock/') || r.endsWith('/api/v1/state/certified')),
      net.requests.join(' '));
    assert.deepEqual(net.requests.filter((r) => r.includes('/balance/proof')).map((r) => r.slice(r.indexOf('/api/'))),
      [`/api/v1/account/${ME}/balance/proof`]);
  });

  it('the live read marks no node old and stands for no certified figure', async () => {
    installEnv();
    const { route } = chain({ balance: '7', nonce: '4' });
    installFetch(route);
    const before = QNET.NODES.map((node) => core.nodeMarkedOld(node));
    assert.deepEqual(await qnet.liveAccountFigure(ME), { balanceNano: '7', nonce: '4', blockHeight: FIRST_INDEX * 90 + 45 });
    assert.deepEqual(QNET.NODES.map((node) => core.nodeMarkedOld(node)), before, 'its body is the live route\'s, no older node\'s');
    await rejectsWith(qnet.liveAccountFigure('x'), 'INVALID_ADDRESS');
    // a certified read afterwards is judged on its own: nothing of the live read stands as certified
    assert.equal((await qnet.readAccount(ME)).verification, 'proof');
  });

  it('a new wallet shows 0 at once: two nodes answering that they hold no such account, never one, never a body of another address', async () => {
    installEnv();
    // this wallet's account is in no state yet: every node answers the live route's absent body for it
    const { route } = chain({ accounts: {} });
    const unborn = certifiedNet({ accounts: {} });
    unborn.install();
    const fresh = routes(unborn.route, route);
    installFetch(fresh);
    assert.deepEqual(await qnet.liveAccountFigure(ME), { balanceNano: '0', nonce: '0', blockHeight: null });
    // the popup's balance does not wait for the certified absence proof: 0 at once, nothing to spend, nonce 1 next
    installFetch((request) => (new URL(request.url).search.includes('mb=')
      ? new Promise((resolve) => setTimeout(() => resolve(fresh(request)), 3000)) : fresh(request)));
    const started = Date.now();
    const balance = await qnet.getBalance();
    assert.ok(Date.now() - started < 1500, `answered after ${Date.now() - started} ms`);
    assert.deepEqual(balance, { balanceNano: '0', spendableNano: '0', nonce: '0', verified: false, verification: 'live', blockHeight: null });
    assert.deepEqual(await qnet.resolveNonce(ME), { nextNonce: '1', pkBound: false });
    // one node's word, or bodies of another address, are no absence
    const [only] = QNET.NODES;
    installFetch(routes(nodeRoute(({ node, path: p }) => (p === `/api/v1/account/${ME}/balance/proof` && node !== only
      ? { status: 503, body: '{}' } : undefined)), fresh));
    assert.equal(await qnet.liveAccountFigure(ME), null);
    installFetch(routes(nodeRoute(({ path: p }) => (p === `/api/v1/account/${ME}/balance/proof`
      ? { body: { address: TO, balance: 0, nonce: 0, merkle_proof: [], state_root: '', block_height: 0, error: 'account not found', proof_valid: false } }
      : undefined)), fresh));
    assert.equal(await qnet.liveAccountFigure(ME), null);
  });

  it('an account the chain took a nonce of never shows the absent body\'s 0: a node gives that body for an error too', async () => {
    // the vault holds a transaction the chain took at nonce 3, so the account exists whatever the live route says
    installEnv({ state: { ...emptyState(), pendingTransfers: [sentRecord('3', '1000000000', { outcome: 'confirmed' })] } });
    const { route } = chain({ balance: '5000000000', nonce: '3' });
    installFetch(routes(nodeRoute(({ path: p }) => (p === `/api/v1/account/${ME}/balance/proof`
      ? { body: { address: ME, balance: 0, nonce: 0, merkle_proof: [], state_root: '', block_height: 0, error: 'account not found', proof_valid: false } }
      : undefined)), route));
    const balance = await qnet.getBalance();
    assert.deepEqual([balance.balanceNano, balance.verification], ['5000000000', 'proof'], 'the certified read stands in');
    await rejectsWith(qnet.preview({ to: TO, amount: '1' }), 'BALANCE_UNCONFIRMED');
  });
});

// How a proof read asks the nodes (the app's rules): any answer without a verifiable proof is no answer, a node that asks
// for a wait is asked last until then, a verified macroblock in the freshness window is pinned (no new committee check),
// and after the wallet's own send the newest certified state is asked for.
describe('chains-activation qnet: certified proof reads', () => {
  beforeEach(() => installEnv());

  it('a typed rate limit is no old node, and its Retry-After is honoured: that node is asked last', async () => {
    const realRandom = Math.random;
    Math.random = () => 0.999999; // the pinned nodes in their own order: the first one is the limited one
    try {
      const { route } = chain();
      const [limited] = QNET.NODES;
      const limit = () => new Response(JSON.stringify({ proof_format: 2, error: 'rate_limited', retry_after_seconds: 30 }),
        { status: 429, headers: { 'retry-after': '30', 'content-type': 'application/json' } });
      installFetch(routes(nodeRoute(({ node, path: p }) => (node === limited && p.includes('/balance/proof') ? limit() : undefined)), route));
      assert.equal((await qnet.readAccount(ME)).verification, 'proof');
      assert.equal(core.nodeMarkedOld(limited), false, 'a rate limit says nothing about the node\'s version');
      const requests = installFetch(route);
      await qnet.readAccount(ME);
      const asked = requests.filter((r) => r.url.includes('/balance/proof')).map((r) => new URL(r.url).origin);
      assert.notEqual(asked[0], limited, 'asked last while it waits');
    } finally {
      Math.random = realRandom;
    }
  });

  it('a proof answer over 64 KB is no answer: the next node is asked', async () => {
    const realRandom = Math.random;
    Math.random = () => 0.999999;
    try {
      const { route } = chain({ balance: '77' });
      const [big] = QNET.NODES;
      installFetch(routes(nodeRoute(({ node, path: p }) => (node === big && p.includes('/balance/proof')
        ? { body: `{"pad":"${'x'.repeat(70 * 1024)}"}` } : undefined)), route));
      const account = await qnet.readAccount(ME);
      assert.deepEqual([account.balanceNano, account.verification], ['77', 'proof']);
    } finally {
      Math.random = realRandom;
    }
  });

  it('a verified macroblock in the window is pinned; one no node holds any more is followed by the newest state', async () => {
    const { route, net } = chain({ balance: '5' });
    installFetch(route);
    assert.equal((await qnet.readAccount(ME)).index, FIRST_INDEX);
    net.requests.length = 0;
    await qnet.readAccount(ME);
    assert.ok(net.requests.some((r) => r.endsWith(`/balance/proof?mb=${FIRST_INDEX}`)), 'no new committee check while it stands');
    assert.ok(!net.requests.some((r) => r.includes('/macroblock/')), net.requests.join(' '));
    // three macroblocks on, and a light client with only the kept anchors: the index it would pin is in no node's views
    net.certify({ [ME]: { balance: '6' } });
    net.certify({ [ME]: { balance: '7' } });
    net.certify({ [ME]: { balance: '8' } });
    net.install();
    net.requests.length = 0;
    const account = await qnet.readAccount(ME);
    assert.deepEqual([account.balanceNano, account.index, account.verification], ['8', FIRST_INDEX + 3, 'proof']);
    const asked = net.requests.filter((r) => r.includes('/balance/proof'));
    assert.ok(asked.some((r) => r.endsWith(`?mb=${FIRST_INDEX - 1}`)), asked.join(' '));
    assert.ok(asked.at(-1).endsWith('?mb=latest'), asked.join(' '));
  });

  it('for ten minutes after this wallet\'s own send its proofs ask for the newest certified state', async () => {
    const { route, net } = chain({ balance: '10000000000' });
    installFetch(route);
    await qnet.readAccount(ME);
    await qnet.send({ to: TO, amount: '1', expectedFeeNano: FEE, expectedNonce: '1' });
    net.requests.length = 0;
    await qnet.readAccount(ME);
    const asked = net.requests.filter((r) => r.includes('/balance/proof'));
    assert.ok(asked.length > 0 && asked.every((r) => r.endsWith('?mb=latest')), asked.join(' '));
  });
});

describe('chains-activation qnet: signed transfer', () => {
  it('transferBody writes u64 fields as bare integers in sendQNC order', () => {
    const body = qnet.transferBody({
      from: ME, to: TO, amountNano: '18446744073709551615', nonce: '3', gasPrice: '10', gasLimit: '10000',
      signature: Uint8Array.of(1, 2), publicKey: Uint8Array.of(0xab),
    });
    assert.equal(body, `{"from":"${ME}","to":"${TO}","amount":18446744073709551615,"dilithium_signature":"0102",`
      + '"gas_price":10,"gas_limit":10000,"nonce":3,"dilithium_public_key":"ab"}');
    assert.throws(() => qnet.transferBody({ from: ME, to: TO, amountNano: '1.5', nonce: '3', gasPrice: '10', gasLimit: '10000', signature: Uint8Array.of(1), publicKey: Uint8Array.of(1) }));
  });

  it('signs the node preimage with ML-DSA-65, stores the exact body before the POST, and submits it', async () => {
    const env = installEnv();
    let pendingAtPost = null;
    const { route, log } = chain({
      balance: '20000000000000000',
      onPost: (request) => {
        pendingAtPost = env.state().pendingTransfers;
        assert.equal(pendingAtPost.length, 1);
        assert.equal(pendingAtPost[0].body, request.body);
        return { body: { success: true, tx_hash: TX_HASH } };
      },
    });
    installFetch(route);
    const amount = '18000000.000000001';
    const result = await qnet.send({ to: TO, amount, expectedFeeNano: FEE, expectedNonce: '1' });
    // the transfer's identity is (from, nonce); the hash is one node's copy (R5-EXTQ-03)
    assert.deepEqual(result, { txHash: TX_HASH, status: 'submitted', nonce: '1', from: ME });
    assert.equal(log.posts.length, 1);

    const body = log.posts[0].body;
    const parsed = JSON.parse(body);
    assert.deepEqual(Object.keys(parsed), ['from', 'to', 'amount', 'dilithium_signature', 'gas_price', 'gas_limit', 'nonce', 'dilithium_public_key']);
    assert.match(body, /"amount":18000000000000001,/, 'the exact u64, not a rounded float');
    assert.equal(parsed.from, ME);
    assert.equal(parsed.to, TO);
    assert.equal(parsed.gas_price, core.fees.GAS_PRICE);
    assert.equal(parsed.gas_limit, core.fees.TRANSFER_GAS_LIMIT);
    assert.equal(parsed.nonce, 1);
    assert.equal(parsed.dilithium_public_key, core.bytesToHex(WALLET.qnetPublicKey));
    assert.equal(parsed.dilithium_signature.length, 2 * core.ML_DSA65.SIGNATURE_BYTES);

    const preimage = `q1337|transfer:${ME}:${TO}:18000000000000001:1:${core.fees.GAS_PRICE}:${core.fees.TRANSFER_GAS_LIMIT}`;
    const signature = core.hexToBytes(parsed.dilithium_signature);
    assert.equal(await core.verifyConsensusSignature(preimage, parsed.dilithium_signature, parsed.dilithium_public_key), true);
    assert.equal(core.verifyTransferSignature({
      from: ME, to: TO, amountNano: '18000000000000001', nonce: '1', gasPrice: '10', gasLimit: '10000',
    }, signature, WALLET.qnetPublicKey), true);

    const [stored] = env.state().pendingTransfers;
    assert.deepEqual(stored, { ...pendingAtPost[0], txHash: TX_HASH });
    assert.equal(stored.nonce, '1');
    assert.equal(stored.amountNano, '18000000000000001');
  });

  it('checks the reviewed fee and nonce, the balance and the pending cap before signing', async () => {
    const env = installEnv();
    installFetch(chain({ balance: '1000000' }).route);
    await rejectsWith(qnet.send({ to: TO, amount: '0.0001', expectedFeeNano: '1' }), 'FEE_CHANGED');
    await rejectsWith(qnet.send({ to: TO, amount: '0.0001', expectedFeeNano: FEE, expectedNonce: '9' }), 'NONCE_CHANGED');
    await rejectsWith(qnet.send({ to: TO, amount: '0.001', expectedFeeNano: FEE }), 'INSUFFICIENT_FUNDS');
    const pending = Array.from({ length: 16 }, (_, i) => ({
      nonce: String(i + 1), to: TO, amountNano: '1', feeNano: FEE, body: `{"n":${i}}`, txHash: null, createdAt: Date.now(),
      lastSubmitAt: Date.now(), outcome: 'pending', kind: 'transfer', call: null,
    }));
    env.setState({ ...emptyState(), pendingTransfers: pending });
    installFetch(chain({ balance: '100000000000' }).route);
    await rejectsWith(qnet.send({ to: TO, amount: '0.0001', expectedFeeNano: FEE }), 'TOO_MANY_PENDING');
    assert.equal(env.calls.signQnetTransfer, 0);
  });

  it('the pending sends are reserved: the spendable balance is what they leave', async () => {
    const env = installEnv({
      state: {
        ...emptyState(),
        pendingTransfers: [{
          nonce: '1', to: TO, amountNano: '1000000', feeNano: FEE, body: '{}', txHash: null, createdAt: Date.now(), lastSubmitAt: Date.now(), outcome: 'pending', kind: 'transfer', call: null,
        }],
      },
    });
    installFetch(chain({ balance: '2000000' }).route);
    await rejectsWith(qnet.send({ to: TO, amount: '0.000700001', expectedFeeNano: FEE }), 'INSUFFICIENT_FUNDS');
    const result = await qnet.send({ to: TO, amount: '0.0007', expectedFeeNano: FEE, expectedNonce: '2' });
    assert.equal(result.nonce, '2');
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.nonce), ['1', '2']);
  });

  it('an unanswered submit is unknown and stays pending; a refusal keeps the record as refused (R5-EXTQ-02)', async () => {
    const env = installEnv();
    installFetch(chain({ onPost: () => { throw new TypeError('connection reset'); } }).route);
    assert.deepEqual(await qnet.send({ to: TO, amount: '1', expectedFeeNano: FEE }), { txHash: null, status: 'unknown', nonce: '1', from: ME });
    const [kept] = env.state().pendingTransfers;
    assert.equal(kept.txHash, null);
    assert.equal(kept.nonce, '1');
    installFetch(chain({ onPost: () => ({ body: { success: false, error: 'Failed to add transaction to mempool', details: 'nonce' } }) }).route);
    await rejectsWith(qnet.send({ to: TO, amount: '2', expectedFeeNano: FEE, expectedNonce: '2' }), 'NODE_REJECTED');
    assert.deepEqual(env.state().pendingTransfers.map((p) => [p.nonce, p.outcome]), [['1', 'pending'], ['2', 'refused']]);
  });

  // R5-EXTQ-02: one node's refusal is its word only, and it may have passed the body on. The signed transfer stays
  // listed and reserved, is never sent again by the wallet, and the next transfer takes its nonce by default, so the
  // refused one, should it apply after all, and the new one are never both paid.
  it('a refused transfer stays reserved and is replaced by default, never paid twice (R5-EXTQ-02)', async () => {
    const env = installEnv();
    installFetch(chain({ balance: '5000000000', onPost: () => ({ body: { success: false } }) }).route);
    await rejectsWith(qnet.send({ to: TO, amount: '2', expectedFeeNano: FEE, expectedNonce: '1' }), 'NODE_REJECTED');
    const [refused] = env.state().pendingTransfers;
    assert.equal(refused.outcome, 'refused');
    assert.equal(refused.nonce, '1');
    // still reserved, listed as refused, never resent by the wallet on its own
    assert.equal((await qnet.getBalance()).spendableNano, String(5000000000n - 2000000000n - BigInt(FEE)));
    const quiet = chain({ balance: '5000000000' });
    installFetch(routes(archiveRoute([]), quiet.route));
    assert.deepEqual((await qnet.getHistory({})).pending.map((i) => [i.status, i.nonce]), [['refused', '1']]);
    await qnet.resubmitPending();
    assert.deepEqual(quiet.log.posts, [], 'a refused body is not posted again');
    // the next send, the same payment again (the dApp retry of the scenario), takes nonce 1 in its place
    const review = await qnet.preview({ to: TO, amount: '2' });
    assert.equal(review.nonce, '1');
    assert.equal(review.replacesNonce, '1');
    assert.deepEqual(review.outstanding.map((p) => [p.nonce, p.refused]), [['1', true]]);
    assert.equal(review.balanceNano, '5000000000', 'the refused one reserves nothing it replaces');
    const sent = chain({ balance: '5000000000' });
    installFetch(sent.route);
    assert.deepEqual(await qnet.send({ to: TO, amount: '2', expectedFeeNano: FEE, expectedNonce: '1' }),
      { txHash: TX_HASH, status: 'submitted', nonce: '1', from: ME });
    assert.equal(JSON.parse(sent.log.posts[0].body).nonce, 1, 'signed at the refused transfer\'s nonce: at most one of the two applies');
    assert.deepEqual(env.state().pendingTransfers.map((p) => [p.nonce, p.outcome]), [['1', 'pending']], 'the refused record went');
  });

  it('a refused transfer the chain applied after all is decided by its row, like any other (R5-EXTQ-02)', async () => {
    const env = installEnv();
    installFetch(chain({ balance: '5000000000', onPost: () => ({ body: { success: false } }) }).route);
    await rejectsWith(qnet.send({ to: TO, amount: '2', expectedFeeNano: FEE, expectedNonce: '1' }), 'NODE_REJECTED');
    // node1 passed the body on: it applied at nonce 1
    installFetch(chain({ nonce: '1', sent: [{ from: ME, to: TO, amount: 2000000000, nonce: 1, type: 'transfer', hash: 'ff'.repeat(32) }] }).route);
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 1, replaced: 0, passed: 0 });
    assert.deepEqual(env.state().pendingTransfers.map((p) => [p.nonce, p.outcome, p.txHash]), [['1', 'confirmed', 'ff'.repeat(32)]]);
  });

  it('a refusal while a hedged second node also got the body is unknown, not a failure', async () => {
    const env = installEnv();
    let posts = 0;
    installFetch(chain({
      onPost: (request) => {
        posts++;
        if (posts === 1) {
          return new Promise((resolve, reject) => {
            request.init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return { body: { success: false, error: 'Server busy: too many concurrent signature verifications' } };
      },
    }).route);
    assert.deepEqual(await qnet.send({ to: TO, amount: '1', expectedFeeNano: FEE }), { txHash: null, status: 'unknown', nonce: '1', from: ME });
    assert.equal(posts, 2);
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.nonce), ['1']);
  });

  it('concurrent sends never share a nonce', async () => {
    const env = installEnv();
    installFetch(chain().route);
    const results = await Promise.all([1, 2, 3].map((n) => qnet.send({ to: TO, amount: String(n), expectedFeeNano: FEE })));
    assert.deepEqual(results.map((r) => r.nonce).sort(), ['1', '2', '3']);
    assert.equal(new Set(env.state().pendingTransfers.map((p) => p.nonce)).size, 3);
  });

  it('refuses while locked without signing', async () => {
    const env = installEnv({ locked: true });
    installFetch(chain().route);
    await rejectsWith(qnet.send({ to: TO, amount: '1', expectedFeeNano: FEE }), 'LOCKED');
    assert.equal(env.calls.signQnetTransfer, 0);
  });
});

describe('chains-activation qnet: resubmission', () => {
  const record = (nonce, { age = 60_000, sinceSubmit = 60_000, body = `{"n":${nonce}}`, txHash = null, to = TO, outcome = 'pending' } = {}) => ({
    nonce, to, amountNano: '10', feeNano: FEE, body, txHash, createdAt: Date.now() - age, lastSubmitAt: Date.now() - sinceSubmit, outcome, kind: 'transfer', call: null,
  });
  const row = (nonce, { to = TO, amount = '10', type = 'transfer' } = {}) => ({ from: ME, to, amount: Number(amount), nonce: Number(nonce), type, hash: 'ff'.repeat(32) });

  it('resends identical bytes, decides a passed nonce by its own row, keeps a stale one listed, and waits between resends', async () => {
    const env = installEnv({
      state: {
        ...emptyState(),
        pendingTransfers: [record('3'), record('4'), record('5', { sinceSubmit: 1000 }), record('6', { age: 2 * 60 * 60 * 1000 })],
      },
    });
    const { route, log } = chain({ nonce: '3', sent: [row('3')] });
    installFetch(route);
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 1, confirmed: 1, replaced: 0, passed: 0 });
    assert.deepEqual(log.posts.map((r) => r.body), ['{"n":4}'], 'a stale transfer (no longer resent) is not posted');
    const state = env.state().pendingTransfers;
    // the one the chain took stays listed as confirmed until the archive lists it
    assert.deepEqual(state.map((p) => [p.nonce, p.outcome]), [['3', 'confirmed'], ['4', 'pending'], ['5', 'pending'], ['6', 'pending']],
      'the stale one is still listed and reserved (R2-EXTQ-02)');
    assert.equal(state[1].txHash, TX_HASH);
    assert.ok(Date.now() - state[1].lastSubmitAt < 5000);
  });

  it('another transaction at its nonce marks a transfer replaced; no row yet, or no history, keeps it (R2-EXTQ-02)', async () => {
    // the same phrase on the phone signed U at nonce 3: the row there is not this transfer
    let env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('3'), record('4', { sinceSubmit: 1000 })] } });
    installFetch(routes(archiveRoute([]), chain({ nonce: '4', sent: [row('3', { to: eonOf(77) }), row('4', { amount: '11' })] }).route));
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 0, replaced: 2, passed: 0 });
    assert.deepEqual(env.state().pendingTransfers.map((p) => [p.nonce, p.outcome]), [['3', 'replaced'], ['4', 'replaced']]);
    // replaced transfers reserve nothing: the next send takes the chain's next nonce and the whole balance
    const preview = await qnet.prepareTransfer({ to: TO, amountNano: '1' });
    assert.equal(preview.nonce, '5');
    assert.deepEqual(preview.outstanding, []);
    const listed = (await qnet.getHistory({})).pending;
    assert.deepEqual(listed.map((i) => [i.status, i.hash, i.nonce]), [['replaced', '', '4'], ['replaced', '', '3']]);

    // another wallet's scenario on a fresh worker: the chain's nonce it saw above never goes back
    qnet = await worker(`passed=${Date.now()}`);
    env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('3')] } });
    installFetch(routes(archiveRoute([]), chain({ nonce: '3', sent: [] }).route));
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 0, replaced: 0, passed: 1 });
    // its nonce is used: no longer resent or reserved, and History says the outcome is unknown (R3-EXTQ-04)
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.outcome), ['passed'], 'no row yet: outcome unknown, never guessed');
    assert.deepEqual((await qnet.getHistory({})).pending.map((i) => i.status), ['unknown']);
    assert.equal((await qnet.prepareTransfer({ to: TO, amountNano: '1' })).nonce, '4', 'it reserves no nonce');
    installFetch(chain({ nonce: '3' }).route);
    await qnet.resubmitPending();
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.outcome), ['passed'], 'no history: kept as it is');
    installFetch(chain({ nonce: '3', sent: [row('3')] }).route);
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 1, replaced: 0, passed: 0 });
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.outcome), ['confirmed'], 'decided later, once two nodes list its row');

    // a replaced transfer is listed for a day after it was seen replaced, then dropped
    env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('2', { outcome: 'replaced', sinceSubmit: 25 * 60 * 60 * 1000 })] } });
    installFetch(chain({ nonce: '3', sent: [] }).route);
    await qnet.resubmitPending();
    assert.deepEqual(env.state().pendingTransfers, []);
  });

  // R5-EXTQ-03: every node that takes the POSTed body stamps its own copy with its own hash; a body a node accepted is
  // sent again only every 10 minutes (a node that restarted lost it), not every 30 seconds.
  it('a body a node accepted is resent only after 10 minutes, one no node took after 30 seconds (R5-EXTQ-03)', async () => {
    installEnv({
      state: {
        ...emptyState(),
        pendingTransfers: [
          record('1', { txHash: TX_HASH, sinceSubmit: 5 * 60 * 1000 }),
          record('2', { txHash: TX_HASH, sinceSubmit: 11 * 60 * 1000 }),
          record('3', { sinceSubmit: 60_000 }),
        ],
      },
    });
    const { route, log } = chain({ nonce: '0' });
    installFetch(route);
    assert.equal((await qnet.resubmitPending()).resubmitted, 2);
    assert.deepEqual(log.posts.map((r) => r.body).sort(), ['{"n":2}', '{"n":3}'], 'the one accepted 5 minutes ago waits');
  });

  it('an unverified chain read drops nothing as confirmed, and resending stays safe', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('1')] } });
    const { route, log } = chain({ perNode: (node) => ({ balance: '1', nonce: String(QNET.NODES.indexOf(node) + 1), pk: false }) });
    installFetch(route);
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 1, confirmed: 0, replaced: 0, passed: 0 });
    assert.equal(log.posts.length, 1);
    assert.equal(env.state().pendingTransfers.length, 1);
  });

  it('nothing pending: no request at all', async () => {
    installEnv();
    const requests = installFetch(() => undefined);
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 0, replaced: 0, passed: 0 });
    assert.equal(requests.length, 0);
  });

  // R3-EXTQ-04: one node's row never decides; two pinned nodes must list the same row at (from, nonce).
  it('a verdict needs the same row from two pinned nodes: one node, or nodes that disagree, decide nothing (R3-EXTQ-04)', async () => {
    const [first, second] = QNET.NODES;
    // one compromised node claims another recipient at nonce 3; no other node lists the row
    let env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('3')] } });
    installFetch(chain({ nonce: '3', sent: (node) => (node === first ? [row('3', { to: eonOf(77) })] : []) }).route);
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 0, replaced: 0, passed: 1 });
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.outcome), ['passed'], 'not marked replaced on one node\'s word');
    // two nodes disagree: still undecided
    env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('3')] } });
    installFetch(chain({
      nonce: '3',
      sent: (node) => {
        if (node === first) return [row('3', { to: eonOf(77) })];
        if (node === second) return [row('3')];
        return null;
      },
    }).route);
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 0, replaced: 0, passed: 1 });
    // two agree on this transfer, one lies: confirmed
    env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('3')] } });
    installFetch(chain({ nonce: '3', sent: (node) => (node === first ? [row('3', { amount: '999' })] : [row('3')]) }).route);
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 1, replaced: 0, passed: 0 });
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.outcome), ['confirmed']);
  });

  // R5-EXTQ-01: a block may carry a transfer at a nonce already used, skipped at apply as a no-op, and every node lists
  // it; the newest row at the nonce is then that no-op, never the one that applied. Two rows at one nonce decide nothing.
  it('two transactions listed at one nonce decide nothing: the history does not say which applied (R5-EXTQ-01)', async () => {
    // X (1000 to a mistyped address) applied at nonce 3; its replacement Y, still in a producer's mempool, was
    // later included as a consumed-nonce no-op: every node lists Y (newest) and X at nonce 3
    const x = row('3', { to: eonOf(77), amount: '1000' });
    const y = row('3');
    let env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('3')] } });
    installFetch(routes(archiveRoute([]), chain({ nonce: '3', sent: [y, x] }).route));
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 0, replaced: 0, passed: 1 });
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.outcome), ['passed'], 'never "confirmed" on the no-op row');
    assert.deepEqual((await qnet.getHistory({})).pending.map((i) => i.status), ['unknown']);
    // one node listing a second row at the nonce is enough to leave it undecided
    env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('3')] } });
    installFetch(chain({ nonce: '3', sent: (node) => (node === QNET.NODES[0] ? [y, x] : [y]) }).route);
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 0, replaced: 0, passed: 1 });
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.outcome), ['passed']);
  });
});

// Owner, 18.10: the pending list and a sent transaction's status follow the nonce the pinned nodes report live; nothing
// of it waits for a certified state, and the send queue never waits behind these reads.
describe('chains-activation qnet: transactions decided at the live tip', () => {
  const at = Date.now() - 60_000;
  const kept = (nonce, extra = {}) => ({
    nonce, to: TO, amountNano: '10', feeNano: FEE, body: `{"n":${nonce}}`, txHash: TX_HASH, createdAt: at, lastSubmitAt: at, outcome: 'pending',
    kind: 'transfer', call: null, ...extra,
  });
  const sentRow = (nonce, amount = 10) => ({ from: ME, to: TO, amount, nonce: Number(nonce), type: 'transfer', hash: 'ff'.repeat(32) });

  it('resubmitPending decides by the nonce two nodes report live while the certified state lags: no proof read, no walk', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [kept('1')] } });
    const { route, net } = chain({ nonce: '0', perNode: () => ({ balance: '1', nonce: '1', pk: false }), sent: [sentRow('1')] });
    installFetch(route);
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 1, replaced: 0, passed: 0 });
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.outcome), ['confirmed']);
    assert.ok(!net.requests.some((r) => r.includes('/balance/proof') || r.includes('/macroblock/')), net.requests.join(' '));
  });

  it('a send is never held behind a run of resubmitPending: its node reads come before the send queue', async () => {
    installEnv({ state: { ...emptyState(), pendingTransfers: [kept('1', { lastSubmitAt: Date.now() })] } });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const base = chain({ nonce: '0', balance: '100000000000' });
    installFetch(async (request) => {
      const { pathname, search } = new URL(request.url);
      // every read of this wallet's own account but the live proof hangs until released
      if (pathname.startsWith(`/api/v1/account/${ME}`) && (!pathname.endsWith('/balance/proof') || search.includes('mb='))) await gate;
      return base.route(request);
    });
    const run = qnet.resubmitPending();
    const timeout = new Promise((resolve) => setTimeout(() => resolve('held'), 5000));
    const sent = await Promise.race([qnet.send({ to: TO, amount: '1', expectedFeeNano: FEE, expectedNonce: '2' }), timeout]);
    release();
    await run;
    assert.notEqual(sent, 'held', 'the send waited behind the run');
    assert.equal(sent.nonce, '2');
  });

  it('History reads the pending list after the run it starts: a transfer the chain took shows once, as the archive\'s row', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [kept('3')] } });
    const archived = { source: 'tx', hash: 'ff'.repeat(32), from: ME, to: TO, amount: '10', fee: FEE, timestamp: at, tx_type: 'transfer' };
    installFetch(routes(archiveRoute([archived]), chain({ nonce: '3', sent: [sentRow('3')] }).route));
    const page = await qnet.getHistory({});
    assert.deepEqual(page.pending, [], 'decided before the page was drawn');
    assert.deepEqual(page.items.map((item) => [item.hash, item.amountNano]), [['ff'.repeat(32), '10']]);
    assert.deepEqual(env.state().pendingTransfers, []);
  });

  it('a transaction the chain took stays in History, confirmed, until the archive lists it, then shows once as the archive\'s row', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [kept('3'), kept('4', { to: G1, txHash: null })] } });
    const archive = [];
    // the nodes list the transfer at nonce 4 under two hashes (each node that took the body stamps its own copy)
    const atFour = (node) => ({ ...sentRow('4'), to: G1, hash: node === QNET.NODES[0] ? 'ee'.repeat(32) : 'e1'.repeat(32) });
    installFetch(routes(archiveRoute(archive), chain({ nonce: '4', sent: (node) => [sentRow('3'), atFour(node)] }).route));
    assert.deepEqual(await qnet.sentStatus({ nonce: '4' }), { status: 'in_block' });
    // the sent screen's Done opens History at once, before the archive has indexed either: both stay listed
    assert.deepEqual((await qnet.getHistory({})).pending.map((i) => i.nonce), ['4', '3']);
    await qnet.backgroundReads();
    const first = await qnet.getHistory({});
    assert.deepEqual(first.items, []);
    assert.deepEqual(first.pending.map((i) => [i.status, i.hash, i.nonce]), [['included', '', '4'], ['included', 'ff'.repeat(32), '3']]);
    // the archive lists them, one by the hash two nodes listed, the other (no hash of its own) by its recipient and amount
    // (a row from before it was signed is not it): one row each, the archive's, and the records leave the vault
    archive.push({ source: 'tx', hash: 'ff'.repeat(32), from: ME, to: TO, amount: '10', fee: FEE, timestamp: at, tx_type: 'transfer' });
    archive.push({ source: 'tx', hash: 'dd'.repeat(32), from: ME, to: G1, amount: '10', fee: FEE, timestamp: at - 60 * 60 * 1000, tx_type: 'transfer' });
    const second = await qnet.getHistory({});
    assert.deepEqual(second.pending.map((i) => i.nonce), ['4'], 'an older payment of the same amount is another row');
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.nonce), ['4']);
    archive.push({ source: 'tx', hash: 'e1'.repeat(32), from: ME, to: G1, amount: '10', fee: FEE, timestamp: Math.floor(Date.now() / 1000), tx_type: 'transfer' });
    const third = await qnet.getHistory({});
    assert.deepEqual(third.pending, []);
    assert.deepEqual(third.items.map((i) => [i.hash, i.status]), [['ff'.repeat(32), 'included'], ['dd'.repeat(32), 'unverified'],
      ['e1'.repeat(32), 'included']]);
    assert.deepEqual(env.state().pendingTransfers, []);
  });

  it('two equal payments a minute apart stay two rows while the archive lists only the first: a row is one transaction\'s', async () => {
    const first = kept('3', { txHash: 'a1'.repeat(32), outcome: 'confirmed', createdAt: Date.now() - 2 * 60_000 });
    const second = kept('4', { txHash: 'b2'.repeat(32), outcome: 'confirmed', createdAt: Date.now() - 60_000 });
    let env = installEnv({ state: { ...emptyState(), pendingTransfers: [first, second] } });
    const row = (hash, timestamp) => ({ source: 'tx', hash, from: ME, to: TO, amount: '10', fee: FEE, timestamp, tx_type: 'transfer' });
    const listed = [{ ...sentRow('3'), hash: 'a1'.repeat(32) }, { ...sentRow('4'), hash: 'b2'.repeat(32) }];
    installFetch(routes(archiveRoute([row('a1'.repeat(32), first.createdAt)]), chain({ nonce: '4', sent: listed }).route));
    const page = await qnet.getHistory({});
    assert.deepEqual(page.items.map((i) => [i.hash, i.status]), [['a1'.repeat(32), 'included']]);
    assert.deepEqual(page.pending.map((i) => [i.nonce, i.status, i.hash]), [['4', 'included', 'b2'.repeat(32)]]);
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.nonce), ['4']);
    // with the first record gone, its row is still not the second's
    assert.deepEqual((await qnet.getHistory({})).pending.map((i) => i.nonce), ['4']);
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.nonce), ['4']);

    // two the nodes listed under different hashes, and one still sent whose hash a node gave: the first takes the one row
    // of its recipient and amount, the second no row, and the row of the one still sent stays its own; a row no two nodes
    // list reads Confirmed by the record that took it, which stays in the vault until the nodes list that row too
    const hashless = (nonce, ago) => kept(nonce, { txHash: null, outcome: 'confirmed', createdAt: Date.now() - ago });
    const sending = kept('7', { txHash: 'd4'.repeat(32), createdAt: Date.now() - 30_000, lastSubmitAt: Date.now() });
    env = installEnv({ state: { ...emptyState(), pendingTransfers: [hashless('5', 2 * 60_000), hashless('6', 60_000), sending] } });
    installFetch(routes(archiveRoute([row('c3'.repeat(32), Date.now() - 2 * 60_000), row('d4'.repeat(32), Date.now() - 30_000)]),
      chain({ nonce: '6', sent: [] }).route));
    const fresh = await worker(`hashless=${Date.now()}`);
    const both = await fresh.getHistory({});
    assert.deepEqual(both.items.map((i) => [i.hash, i.status]), [['c3'.repeat(32), 'included'], ['d4'.repeat(32), 'unverified']]);
    assert.deepEqual(both.pending.map((i) => i.nonce), ['7', '6']);
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.nonce), ['5', '6', '7']);
  });

  it('a confirmed record the archive never lists leaves the list an hour after it was seen confirmed', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [kept('3', { outcome: 'confirmed', lastSubmitAt: Date.now() - 61 * 60 * 1000 }),
      kept('4', { outcome: 'confirmed', lastSubmitAt: Date.now() - 59 * 60 * 1000 })] } });
    installFetch(chain({ nonce: '4', sent: [] }).route);
    await qnet.resubmitPending();
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.nonce), ['4']);
  });

  it('sentStatus: pending while the nonce is free, in a block once two nodes list this wallet\'s transaction there, replaced when another', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [kept('3')] } });
    installFetch(chain({ nonce: '2' }).route);
    assert.deepEqual(await qnet.sentStatus({ nonce: '3' }), { status: 'pending' });
    // the tip took it: in a block, and the pending list is decided at once by the run sentStatus starts, from the rows it
    // read (no history read of its own): confirmed, with the hash two nodes list, until the archive lists it
    const decided = chain({ nonce: '3', sent: [sentRow('3')] });
    installFetch(decided.route);
    assert.deepEqual(await qnet.sentStatus({ nonce: '3' }), { status: 'in_block' });
    const reads = decided.log.sentReads;
    await qnet.backgroundReads();
    assert.deepEqual(env.state().pendingTransfers.map((p) => [p.outcome, p.txHash]), [['confirmed', 'ff'.repeat(32)]]);
    assert.equal(decided.log.sentReads, reads, 'the rows sentStatus read decided the run');
    assert.deepEqual(await qnet.sentStatus({ nonce: '3' }), { status: 'in_block' });
    installEnv();
    assert.deepEqual(await qnet.sentStatus({ nonce: '3' }), { status: 'in_block' }, 'with its record gone, its row still says so');
    // another transaction of this wallet took the nonce
    installEnv({ state: { ...emptyState(), pendingTransfers: [kept('3')] } });
    installFetch(chain({ nonce: '3', sent: [sentRow('3', 11)] }).route);
    assert.deepEqual(await qnet.sentStatus({ nonce: '3' }), { status: 'replaced' });
    await qnet.resubmitPending();
    // a used nonce no two nodes list, and an account nonce no two nodes report alike: unknown, never guessed
    installEnv({ state: { ...emptyState(), pendingTransfers: [kept('3')] } });
    installFetch(chain({ nonce: '3', sent: [] }).route);
    assert.deepEqual(await qnet.sentStatus({ nonce: '3' }), { status: 'unknown' });
    installFetch(chain({ perNode: (node) => ({ balance: '1', nonce: String(QNET.NODES.indexOf(node) + 5), pk: false }) }).route);
    const fresh = await worker(`sentStatus=${Date.now()}`);
    assert.deepEqual(await fresh.sentStatus({ nonce: '3' }), { status: 'unknown' });
    await rejectsWith(qnet.sentStatus({ nonce: '0' }), 'INVALID_PARAMS');
    installEnv({ locked: true });
    await rejectsWith(qnet.sentStatus({ nonce: '3' }), 'LOCKED');
  });
});

describe('chains-activation qnet: history', () => {
  const explorerRoute = (body, seen) => async (request) => {
    if (!request.url.startsWith(`${QNET.EXPLORER_API}/api/address/`)) return undefined;
    seen.push(request.url);
    return typeof body === 'function' ? body(request) : { body };
  };

  it('maps the archive page of this wallet and lists its pending sends', async () => {
    const page = JSON.parse(raw('chains-activation-history-g1.json'));
    const rows = page.items.filter((r) => r.source === 'tx').slice(0, 3);
    const mine = rows.map((r) => ({ ...r, from: r.from === G1 ? ME : r.from, to: r.to === G1 ? ME : r.to }));
    mine.push({ ...mine[0], hash: 'cd'.repeat(32), to: ME });
    mine.push({ source: 'token', hash: 'ef'.repeat(32), idx: 0, from: ME, to: TO, amount: '5', timestamp: 1 });
    mine.push({ ...mine[0], hash: '12'.repeat(32), from: TO, to: G1 });
    mine.push({ ...mine[0], hash: '34'.repeat(32), amount: '-1' });
    const text = JSON.stringify({ success: true, address: ME, items: mine, next_cursor: page.next_cursor })
      .replace('"amount":"100000000000000"', '"amount":18446744073709551615');
    const createdAt = Date.now() - 1000;
    const env = installEnv({
      state: {
        ...emptyState(),
        pendingTransfers: [{
          nonce: '1', to: TO, amountNano: '7', feeNano: FEE, body: '{}', txHash: 'aa'.repeat(32), createdAt, lastSubmitAt: Date.now(), outcome: 'pending', kind: 'transfer', call: null,
        }],
      },
    });
    const seen = [];
    installFetch(routes(explorerRoute(text, seen), chain().route));
    const history = await qnet.getHistory({ cursor: 'abc.1', limit: 3 });
    await qnet.resubmitPending();
    assert.equal(seen[0], `${QNET.EXPLORER_API}/api/address/${ME}/history?limit=3&cursor=abc.1`);
    assert.equal(history.cursor, page.next_cursor);
    // no node lists them: the archive (the site's host) alone never makes a row confirmed (R4-EXTQ-04)
    assert.deepEqual(history.items.map((i) => [i.direction, i.status]), [['out', 'unverified'], ['in', 'unverified'], ['in', 'unverified'], ['self', 'unverified']]);
    const [out, reward, incoming, self] = history.items;
    assert.equal(out.amountNano, '18446744073709551615');
    assert.equal(out.feeNano, rows[0].fee);
    assert.equal(reward.from, 'system_rewards_pool');
    assert.equal(reward.feeNano, '0');
    assert.equal(incoming.feeNano, '0');
    assert.equal(self.feeNano, rows[0].fee);
    assert.equal(out.timestamp, rows[0].timestamp);
    // the hash a node returned is not the transaction's identity: never listed (R2-EXTQ-06)
    assert.deepEqual(history.pending, [{
      hash: '', direction: 'out', from: ME, to: TO, amountNano: '7', feeNano: FEE, timestamp: createdAt, status: 'pending', nonce: '1',
      kind: 'transfer',
    }]);
    assert.equal(env.state().pendingTransfers.length, 1);
  });

  // R4-EXTQ-04: a row is in a block only when two pinned nodes list it alike (hash, both parties, amount) in their
  // newest history; one node, or two that list another amount, leave it unverified. Listed is never "applied": a block
  // carries a transfer skipped at apply too (R5-EXTQ-01), so the status says 'included', not 'confirmed'.
  it('calls an archive row included only when two pinned nodes list it alike, never confirmed (R4-EXTQ-04, R5-EXTQ-01)', async () => {
    const at = 1_790_000_000_000;
    const archived = [
      { source: 'tx', hash: '01'.repeat(32), from: ME, to: TO, amount: '18446744073709551615', fee: '0', timestamp: at },
      { source: 'tx', hash: '02'.repeat(32), from: 'system_rewards_pool', to: ME, amount: '50', fee: '0', timestamp: at },
      { source: 'tx', hash: '03'.repeat(32), from: G1, to: ME, amount: '60', fee: '0', timestamp: at },
      { source: 'tx', hash: '04'.repeat(32), from: ME, to: ME, amount: '70', fee: '0', timestamp: at },
    ];
    installEnv();
    const listed = (row, amount = row.amount) => ({ hash: row.hash, from: row.from, to: row.to, amount, nonce: 1, type: 'transfer' });
    const [nodeA, nodeB] = QNET.NODES;
    const asked = [];
    const { route } = chain({
      sent: (node) => {
        if (node !== nodeA && node !== nodeB) return null;
        // out and reward on both; the incoming row on one node only; the self row on both, another amount
        const rows = [listed(archived[0]), listed(archived[1]), listed(archived[3], '71'), { hash: '05'.repeat(32), from: ME, to: TO, amount: '1' }];
        return node === nodeA ? [...rows, listed(archived[2])] : rows;
      },
    });
    installFetch(routes(archiveRoute(archived), async (request) => {
      if (request.url.includes('/api/v1/transactions/history?')) asked.push(new URL(request.url).search);
      return route(request);
    }));
    const history = await qnet.getHistory({ limit: 20 });
    assert.deepEqual(history.items.map((i) => [i.hash.slice(0, 2), i.status]), [['01', 'included'], ['02', 'included'], ['03', 'unverified'], ['04', 'unverified']]);
    assert.ok(asked.includes(`?address=${ME}&per_page=100`), asked.join(' '));
    // the recipient check only adds warnings from the archive, so it does not ask the nodes
    asked.length = 0;
    await qnet.recipientCheck(TO);
    assert.deepEqual(asked.filter((q) => !q.includes('direction=sent')), []);
    // a node that answers garbage is no evidence
    installFetch(routes(archiveRoute(archived), chain({ sent: (node) => (node === nodeA ? [listed(archived[1])] : { rows: 'x' }) }).route));
    assert.deepEqual((await qnet.getHistory({})).items.map((i) => i.status), ['unverified', 'unverified', 'unverified', 'unverified']);
  });

  it('a silent node does not hold History: the read ends 700 ms after the second node answered', async () => {
    const at = 1_790_000_000_000;
    const archived = [{ source: 'tx', hash: '01'.repeat(32), from: ME, to: TO, amount: '5', fee: '0', timestamp: at }];
    installEnv();
    const [nodeA, nodeB] = QNET.NODES;
    const { route } = chain({
      sent: (node) => (node === nodeA || node === nodeB ? [{ hash: archived[0].hash, from: ME, to: TO, amount: '5', nonce: 1, type: 'transfer' }] : null),
    });
    installFetch(routes(archiveRoute(archived), async (request) => {
      const { origin } = new URL(request.url);
      if (request.url.includes('/api/v1/transactions/history?') && origin !== nodeA && origin !== nodeB) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { status: 503, body: '{}' };
      }
      return route(request);
    }));
    const started = Date.now();
    const history = await qnet.getHistory({ limit: 20 });
    const took = Date.now() - started;
    assert.deepEqual(history.items.map((i) => i.status), ['included']);
    assert.ok(took < 2000, `answered after ${took} ms`);
  });

  it('an explorer outage or a malformed page is NETWORK', async () => {
    installEnv();
    installFetch(explorerRoute(() => ({ status: 503, body: '' }), []));
    await rejectsWith(qnet.getHistory({}), 'NETWORK');
    installFetch(explorerRoute({ success: false, error: 'x' }, []));
    await rejectsWith(qnet.getHistory({}), 'NETWORK');
  });
});

// A valid EON with the first and last four characters of `address`: what an address-poisoning attacker
// grinds for (the last eight characters are the SHA3 checksum, so only its tail is searched).
function lookalikeOf(address) {
  const head = address.slice(0, 4);
  const tail = address.slice(-4);
  for (let i = 0; ; i += 1) {
    const body = `${head}${i.toString(16).padStart(15, '0')}eon${'0'.repeat(15)}`;
    const candidate = body + core.bytesToHex(core.sha3_256(core.utf8Encode(body))).slice(0, 8);
    if (candidate.endsWith(tail) && candidate !== address) return candidate;
  }
}
const eonOf = (n) => core.qnetAddressFromPublicKey(new Uint8Array(1952).fill(n));
const historyRow = (n, from, to, amount = '1') => ({
  source: 'tx', hash: `${n.toString(16).padStart(4, '0')}${'ab'.repeat(30)}`, from, to, amount, fee: '0', timestamp: 1_790_000_000_000 + n,
});
const archiveRoute = (items) => async (request) => {
  if (!request.url.startsWith(`${QNET.EXPLORER_API}/api/address/`)) return undefined;
  return { body: { success: true, address: ME, items, next_cursor: null } };
};

describe('chains-activation qnet: recipient check (ES-01)', () => {
  const PAYEE = eonOf(11);

  it('a dust flood cannot hide a look-alike: known recipients come from the vault, not from a 50-row window', async () => {
    installEnv({ state: { ...emptyState(), recipients: [PAYEE] } });
    const poison = lookalikeOf(PAYEE);
    // the newest page: the look-alike's dust first, then 49 more incoming dust rows; the payee is gone from it
    const flood = [historyRow(0, poison, ME), ...Array.from({ length: 49 }, (_, i) => historyRow(i + 1, eonOf(40 + (i % 50)), ME))];
    installFetch(routes(archiveRoute(flood), chain().route));
    assert.deepEqual(await qnet.recipientCheck(poison), { known: false, lookalike: true, incomingOnly: true, historyRead: true });
    assert.deepEqual(await qnet.recipientCheck(PAYEE), { known: true, lookalike: false, incomingOnly: false, historyRead: true });
  });

  it('an incoming sender is never "known": a 1-nano transfer does not silence the first-time warning', async () => {
    installEnv();
    const scammer = eonOf(21);
    installFetch(routes(archiveRoute([historyRow(1, scammer, ME)]), chain().route));
    assert.deepEqual(await qnet.recipientCheck(scammer), { known: false, lookalike: false, incomingOnly: true, historyRead: true });
  });

  it('the archive (the site host) can only add warnings: a row claiming this wallet paid X does not make X known', async () => {
    installEnv({ state: { ...emptyState(), recipients: [PAYEE] } });
    const forged = eonOf(31);
    installFetch(routes(archiveRoute([historyRow(1, ME, forged), historyRow(2, ME, lookalikeOf(forged))]), chain().route));
    assert.equal((await qnet.recipientCheck(forged)).known, false);
    // ...but what it lists as paid still widens the look-alike search
    assert.equal((await qnet.recipientCheck(lookalikeOf(PAYEE))).lookalike, true);
    // without the archive the vault still decides (a fresh worker: a page read a moment ago is used again for 30 s)
    qnet = await worker(`noArchive=${Date.now()}`);
    installFetch(chain().route);
    assert.deepEqual(await qnet.recipientCheck(lookalikeOf(PAYEE)), { known: false, lookalike: true, incomingOnly: false, historyRead: false });
    assert.deepEqual(await qnet.recipientCheck(ME), { known: false, lookalike: false, incomingOnly: false, historyRead: false });
  });

  it('a signed send makes its recipient known, never the wallet itself', async () => {
    const env = installEnv();
    installFetch(chain({ balance: '100000000000' }).route);
    await qnet.send({ to: TO, amount: '1', expectedFeeNano: FEE, expectedNonce: '1' });
    assert.deepEqual(env.state().recipients, [TO]);
    await qnet.send({ to: ME, amount: '1', expectedFeeNano: FEE, expectedNonce: '2' });
    assert.deepEqual(env.state().recipients, [TO], 'a transfer to itself adds nothing');
    assert.equal((await qnet.recipientCheck(TO)).known, true);
  });

  // Owner, 18.10: a payment of the same amount to the same address again is a send like any other; the outstanding
  // ones are still named and offered to replace.
  it('a second payment of the same amount is reviewed like any other: no repeat notice, and nothing kept to make one', async () => {
    const env = installEnv();
    const recent = { ...historyRow(1, ME, TO, '500000000000'), timestamp: Date.now() - 60_000 };
    installFetch(routes(archiveRoute([recent]), chain({ balance: '9000000000000' }).route));
    await qnet.send({ to: TO, amount: '500', expectedFeeNano: FEE, expectedNonce: '1' });
    assert.deepEqual(env.state().recentTransfers, [], 'no record of it is kept for a warning');
    const preview = await qnet.preview({ to: TO, amount: '500' });
    assert.equal(Object.hasOwn(preview, 'duplicate'), false);
    assert.deepEqual(preview.recipient, { known: true, lookalike: false, incomingOnly: false, historyRead: true });
    assert.deepEqual(preview.outstanding.map((p) => [p.nonce, p.amountNano]), [['1', '500000000000']], 'the one on its way is named');
  });

  it('replaces an outstanding transfer at its nonce: its record goes, its amount is free again (R2-EXTQ-03)', async () => {
    const env = installEnv();
    installFetch(chain({ balance: '3000000000', onPost: () => { throw new TypeError('connection reset'); } }).route);
    const first = await qnet.send({ to: TO, amount: '2', expectedFeeNano: FEE });
    assert.deepEqual(first, { txHash: null, status: 'unknown', nonce: '1', from: ME });
    // a second payment in addition would need 4 QNC: refused; the replacement takes nonce 1 and the freed 2 QNC
    await rejectsWith(qnet.send({ to: TO, amount: '2', expectedFeeNano: FEE }), 'INSUFFICIENT_FUNDS');
    const review = await qnet.preview({ to: TO, amount: '2', replaceNonce: '1' });
    assert.equal(review.nonce, '1');
    assert.equal(review.replacesNonce, '1');
    const replaced = await qnet.send({ to: TO, amount: '2', expectedFeeNano: FEE, expectedNonce: '1', replaceNonce: '1' });
    assert.equal(replaced.nonce, '1');
    const kept = env.state().pendingTransfers;
    assert.equal(kept.length, 1, 'the replaced record went: only one transfer can apply at nonce 1');
    assert.notEqual(kept[0].body, env.stateHistory.find((s) => s.pendingTransfers.length === 1).pendingTransfers[0].body);
    await rejectsWith(qnet.send({ to: TO, amount: '1', expectedFeeNano: FEE, replaceNonce: '7' }), 'NONCE_CHANGED');
  });

  // R4-EXTQ-01: the transfer a replace targets may still apply until the replacement is taken. A definitive
  // refusal of the replacement puts it back as it was (listed, reserved, resent), so a retry is a replace again.
  it('a refused replacement leaves the transfer it was to replace pending, and a retry replaces it again (R4-EXTQ-01)', async () => {
    const env = installEnv();
    installFetch(chain({ balance: '3000000000', onPost: () => { throw new TypeError('connection reset'); } }).route);
    await qnet.send({ to: TO, amount: '2', expectedFeeNano: FEE });
    const [original] = env.state().pendingTransfers;
    assert.equal(original.outcome, 'pending');
    const written = env.stateHistory.length;
    installFetch(chain({ balance: '3000000000', onPost: () => ({ body: { success: false, error: 'Failed to add transaction to mempool' } }) }).route);
    await rejectsWith(qnet.send({ to: TO, amount: '1', expectedFeeNano: FEE, expectedNonce: '1', replaceNonce: '1' }), 'NODE_REJECTED');
    // while the replacement was submitted, both were kept: the original superseded, never dropped unseen
    const during = env.stateHistory[written];
    assert.deepEqual(during.pendingTransfers.map((p) => [p.body === original.body, p.outcome]), [[true, 'superseded'], [false, 'pending']]);
    // the original is back as it was; the refused replacement stays listed as refused at the same nonce (R5-EXTQ-02)
    const [back, refused] = env.state().pendingTransfers;
    assert.deepEqual(back, original);
    assert.equal(refused.outcome, 'refused');
    assert.equal(refused.nonce, '1');
    // one of the two may apply at nonce 1: the larger of them stays reserved, and it is still what a replace targets
    assert.equal((await qnet.getBalance()).spendableNano, String(3000000000n - 2000000000n - BigInt(FEE)));
    await rejectsWith(qnet.send({ to: TO, amount: '1', expectedFeeNano: FEE }), 'INSUFFICIENT_FUNDS');
    installFetch(chain({ balance: '3000000000' }).route);
    assert.deepEqual(await qnet.send({ to: TO, amount: '1', expectedFeeNano: FEE, expectedNonce: '1', replaceNonce: '1' }),
      { txHash: TX_HASH, status: 'submitted', nonce: '1', from: ME });
    assert.deepEqual(env.state().pendingTransfers.map((p) => [p.amountNano, p.outcome]), [['1000000000', 'pending']]);
  });

  it('a superseded transfer is reserved and listed, never resent, and back to pending when its replacement is gone (R4-EXTQ-01)', async () => {
    const now = Date.now();
    const base = { to: TO, feeNano: FEE, txHash: null, createdAt: now, lastSubmitAt: now - 60 * 60 * 1000, kind: 'transfer', call: null };
    const superseded = { ...base, nonce: '1', amountNano: '5', body: '{"a":1}', outcome: 'superseded' };
    const replacement = { ...base, nonce: '1', amountNano: '6', body: '{"a":2}', outcome: 'pending' };
    // with its replacement pending at the same nonce: reserved and listed, not resent, not a replace target
    let env = installEnv({ state: { ...emptyState(), pendingTransfers: [superseded, replacement] } });
    const first = chain({ balance: '1000000' });
    installFetch(routes(archiveRoute([]), first.route));
    // at most one of the two applies at nonce 1: the larger is reserved
    assert.equal((await qnet.getBalance()).spendableNano, String(1000000n - 6n - BigInt(FEE)));
    await qnet.resubmitPending();
    assert.deepEqual(first.log.posts.map((p) => p.body), ['{"a":2}'], 'only the replacement is sent');
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.outcome), ['superseded', 'pending']);
    assert.deepEqual((await qnet.getHistory({})).pending.map((i) => [i.amountNano, i.status]), [['6', 'pending'], ['5', 'pending']]);
    await qnet.resubmitPending(); // serialized: waits out a run getHistory may have started
    // no replacement at its nonce any more: it may still apply, so it is sent again
    env = installEnv({ state: { ...emptyState(), pendingTransfers: [superseded] } });
    const second = chain({ balance: '1000000' });
    installFetch(routes(archiveRoute([]), second.route));
    await rejectsWith(qnet.preview({ to: TO, amount: '1', replaceNonce: '1' }), 'NONCE_CHANGED');
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 0, replaced: 0, passed: 0 });
    assert.equal(second.log.posts.length, 0, 'not resent while superseded');
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.outcome), ['pending']);
    assert.equal((await qnet.preview({ to: TO, amount: '1', replaceNonce: '1' })).replacesNonce, '1');
  });
});

describe('chains-activation qnet: verified anchors (EXT-CHAINS-04)', () => {
  it('walks from a macroblock verified in an earlier session, far above the pin, instead of giving up', async () => {
    const env = installEnv();
    const proofText = raw('chains-activation-proof-g1.json');
    const proof = JSON.parse(proofText);
    // far above the pin: no walk from the pin could be that short
    const index = core.trustFloorIndex() + 1000;
    const height = index * 90 + 5;
    const lowProof = proofText.replace(`"block_height":${proof.block_height}`, `"block_height":${height}`);
    const requested = [];
    installFetch(nodeRoute(({ path: p }) => {
      const macroblock = /^\/api\/v1\/macroblock\/([0-9]+)\/proof$/.exec(p);
      if (macroblock) {
        requested.push(Number(macroblock[1]));
        return { status: 404, body: '{"error":"not found"}' };
      }
      // an older node's live-root proof: its root counts only once found certified at its height
      if (p.startsWith(`/api/v1/account/${G1}/balance/proof`)) return { body: lowProof };
      // the certified head the nodes report (without one no proof is fresh, and no walk starts)
      if (p === '/api/v1/state/certified') return { body: { proof_format: 2, views: [], newest_certified_index: index, capture: 'ok' } };
      return undefined;
    }));
    core.clearQcCache();
    // a fresh worker without kept anchors: the walk starts at the pin however far the head is (R3-EXTQ-02: it
    // resumes over the next reads from every step it verified, instead of never starting); it failed here (404),
    // so the balance is not verified
    assert.equal((await qnet.readAccount(G1)).verification, 'none');
    const pin = core.genesisConsensus.WS_CHECKPOINT.index;
    assert.ok(requested.length >= 1, 'the walk from the pin was attempted');
    assert.ok(requested[0] > pin && requested[0] <= pin + 2, `the walk starts right above the pin: ${requested[0]}`);
    // what the vault kept from an earlier session roots the walk two macroblocks below
    requested.length = 0;
    env.anchors = { [index - 2]: { eligible_ids: ['node_001'], beacon: 'ab'.repeat(32), registry_root: 'cd'.repeat(32) } };
    core.clearQcCache();
    const fresh = await worker(`anchors=${index}`);
    assert.equal((await fresh.readAccount(G1)).verification, 'none', 'the walk failed here (404): not verified');
    assert.equal(requested[0], index, 'the walk from the kept anchor starts with one step, to the index');
    assert.equal(env.anchorWrites, 0, 'nothing new was verified, nothing is written');
    core.clearQcCache();
  });
});

describe('chains-activation qnet: bounded answers (R4-EXTQ-03)', () => {
  const endless = (pulls) => new Response(new ReadableStream({
    pull(controller) {
      pulls.count += 1;
      controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('drops an endless node answer at 1 MiB and asks the next node; the archive read fails as NETWORK', async () => {
    installEnv();
    const pulls = { count: 0 };
    const requests = installFetch(nodeRoute(({ path: p }) => (p === '/api/v1/height' ? endless(pulls) : undefined)));
    await rejectsWith(qnet.nodeRequest('/api/v1/height', { hedgeMs: 60_000 }), 'NETWORK');
    const asked = requests.filter((r) => r.url.endsWith('/api/v1/height')).length;
    assert.equal(asked, QNET.NODES.length, 'each node in turn');
    assert.ok(pulls.count <= asked * 20, `read ${pulls.count} chunks of ${asked} endless bodies`);
    const archive = { count: 0 };
    installFetch((request) => (request.url.startsWith(QNET.EXPLORER_API) ? endless(archive) : undefined));
    await rejectsWith(qnet.getHistory({ limit: 5 }), 'NETWORK');
    assert.ok(archive.count > 0 && archive.count <= 20, `read ${archive.count} chunks of the archive`);
  });
});

describe('chains-activation qnet: dApp token transfers and contract calls', () => {
  const TOKEN = core.deriveContractAddress(ME, 1);
  const GAME = core.deriveContractAddress(ME, 3);
  // GAME's account in a certified state: a contract that is no token
  const GAME_ACCOUNT = { is_contract: true, contract_code_hash: 'ab'.repeat(32), storage_root: 'cd'.repeat(32) };
  // What GET /api/v1/token/{a} answers for a contract that is no token (GAME's: notToken) and for an address holding none
  const notTokenOf = (address) => ({ success: false, error: 'Contract exists but is not a QRC-20/QRC-721 token', contract_address: address });
  const noContractOf = (address) => ({ success: false, error: 'Token not found', contract_address: address });
  const notToken = notTokenOf(GAME);
  const tokenInfo = (decimals = 6, name = 'Gold Coin', symbol = 'GOLD') => ({
    success: true, source: 'blockchain_state',
    token: { contract_address: TOKEN, standard: 'qrc20', name, symbol, decimals, logo: '', total_supply: '100000000000000' },
  });
  // The chain of `chain()` plus the token and call routes: `contracts` answers GET /api/v1/token/{c} by address (node →
  // answer when a function: what a contract is stays two nodes' word), `balances` the holders of TOKEN in the certified
  // state (`tokens` any other token's), `unreadable` the tokens whose balance proofs every node fails, `onCall` the POST.
  function callChain({ contracts = {}, balances = {}, tokens = {}, unreadable = [], onCall = null, tx = {}, ...rest } = {}) {
    const base = chain({ ...rest, tokens: { [TOKEN]: { holders: balances }, ...tokens } });
    for (const token of unreadable) base.net.unreadable.add(token);
    const log = { ...base.log, calls: [], tokenReads: 0 };
    const route = routes(nodeRoute(async ({ node, path: p, request }) => {
      const info = /^\/api\/v1\/token\/([0-9a-z]+)$/.exec(p);
      if (info) {
        log.tokenReads++;
        const answer = typeof contracts[info[1]] === 'function' ? contracts[info[1]](node) : contracts[info[1]];
        return { body: answer ?? noContractOf(info[1]) };
      }
      if (p === '/api/v1/contract/call' && request.method === 'POST') {
        log.calls.push(request);
        return onCall ? onCall(request) : { body: { success: true, tx_hash: TX_HASH, message: 'Contract call submitted to mempool' } };
      }
      const byHash = /^\/api\/v1\/transaction\/([0-9a-f]+)$/.exec(p);
      if (byHash && tx[byHash[1]] !== undefined) return { body: tx[byHash[1]](node) };
      return undefined;
    }), base.route);
    return { route, log, net: base.net };
  }

  it('a silent node never holds a token read (its details, its balance): the next node joins after 700 ms', async () => {
    installEnv();
    const realRandom = Math.random;
    Math.random = () => 0.999999; // the pinned nodes in their own order: the first one is the silent one
    try {
      const [silent] = QNET.NODES;
      const { route } = callChain({ contracts: { [TOKEN]: tokenInfo() }, balances: { [ME]: '42' } });
      installFetch(async (request) => {
        if (new URL(request.url).origin === silent && request.url.includes('/api/v1/token/')) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return { status: 503, body: '{}' };
        }
        return route(request);
      });
      const fresh = await worker(`silentToken=${Date.now()}`);
      const started = Date.now();
      const [info, balance] = await Promise.all([fresh.readContract(TOKEN), fresh.readTokenBalance(TOKEN, ME)]);
      const took = Date.now() - started;
      assert.equal(info.symbol, 'GOLD');
      assert.equal(balance, '42');
      assert.ok(took < 2000, `answered after ${took} ms`);
    } finally {
      Math.random = realRandom;
    }
  });

  // M-5: a hidden or format character (a direction override, a zero-width mark) is shown as U+FFFD, the app's rule
  // (core.tokenLabel), so none can reorder or hide what a page draws, and it marks the token as named after QNet's own coin
  // (reserved); so does any spelling a reader takes for QNC or QNet.
  it('readContract: a token as two nodes read it, another contract, none; a hidden character is shown as U+FFFD and marks the token', async () => {
    installEnv();
    const { route, log } = callChain({ contracts: { [TOKEN]: tokenInfo(6, 'Gold\u202eCoin'), [GAME]: notToken } });
    installFetch(route);
    const shown = { kind: 'token', standard: 'qrc20', name: 'Gold\ufffdCoin', symbol: 'GOLD', decimals: 6, reserved: true };
    assert.deepEqual(await qnet.readContract(TOKEN), shown);
    assert.deepEqual(await qnet.readContract(GAME), { kind: 'contract' });
    assert.deepEqual(await qnet.readContract(ME), { kind: 'none' });
    const reads = log.tokenReads;
    assert.deepEqual(await qnet.readContract(TOKEN), shown);
    assert.equal(log.tokenReads, reads, 'a token is kept a minute');
    // QNet's own names in any spelling, a name past 64 characters, and an honest one
    const cases = [
      ['Gold Coin', 'GOLD', { name: 'Gold Coin', symbol: 'GOLD', reserved: false }],
      ['Totally real', 'QNC', { name: 'Totally real', symbol: 'QNC', reserved: true }],
      ['QNet Coin', 'XYZ', { name: 'QNet Coin', symbol: 'XYZ', reserved: true }],
      ['Coin', '\u202eCNQ', { name: 'Coin', symbol: '\ufffdCNQ', reserved: true }],
      ['Coin', 'Q\u202eCN\u202c', { name: 'Coin', symbol: 'Q\ufffdCN\ufffd', reserved: true }],
      ['Coin', 'QN\u0421', { name: 'Coin', symbol: 'QN\u0421', reserved: true }],
      ['x'.repeat(65), 'LONG', { name: '', symbol: 'LONG', reserved: false }],
    ];
    for (const [index, [name, symbol, expected]] of cases.entries()) {
      const contract = core.deriveContractAddress(ME, 20 + index);
      const info = { ...tokenInfo(6, name, symbol), token: { ...tokenInfo(6, name, symbol).token, contract_address: contract } };
      installFetch(callChain({ contracts: { [contract]: info } }).route);
      assert.deepEqual(await qnet.readContract(contract), { kind: 'token', standard: 'qrc20', decimals: 6, ...expected }, `${name} ${symbol}`);
    }
    // nodes that disagree on the decimals: the rest are asked; no two alike is NETWORK
    const other = core.deriveContractAddress(ME, 7);
    const answers = QNET.NODES.map((_, i) => ({ ...tokenInfo(i), token: { ...tokenInfo(i).token, contract_address: other } }));
    installFetch(callChain({ contracts: { [other]: (node) => answers[QNET.NODES.indexOf(node)] } }).route);
    await rejectsWith(qnet.readContract(other), 'NETWORK');
    await rejectsWith(qnet.readContract('x'), 'INVALID_ADDRESS');
  });

  it('prepareCall: a token transfer\'s gas from the shared builder, the deposit for a new holder, and the token balance', async () => {
    installEnv();
    const payee = eonOf(51);
    installFetch(callChain({ balance: '1000000000000', nonce: '4', balances: { [ME]: '7000000', [payee]: '0' } }).route);
    const request = { kind: 'tokenTransfer', token: TOKEN, to: payee, amountBase: '2500000' };
    const tx = core.buildTokenTransfer({ from: ME, token: TOKEN, to: payee, amount: '2500000', nonce: '5' });
    const preview = await qnet.prepareCall(request);
    assert.deepEqual(preview, {
      kind: 'tokenTransfer', from: ME, contract: TOKEN, method: 'transfer', gasLimit: tx.gasLimit, feeNano: tx.maxFeeNano,
      depositNano: String(core.fees.STORAGE_DEPOSIT_NANO), totalNano: String(BigInt(tx.maxFeeNano) + BigInt(core.fees.STORAGE_DEPOSIT_NANO)),
      nonce: '5', balanceNano: '1000000000000', verified: false, verification: 'live', outstanding: [], replacesNonce: null, inFlight: false,
      to: payee, amountBase: '2500000', tokenBalance: '7000000', tokenProblem: null,
    });
    assert.equal(tx.gasLimit, tx.intrinsicGas, 'a token transfer runs no code: its gas limit is its intrinsic gas');
    // a recipient who holds the token already: no deposit; one proven absent, or unreadable, counts as new
    installFetch(callChain({ balance: '1000000000000', nonce: '4', balances: { [ME]: '7000000', [payee]: '1' } }).route);
    assert.equal((await qnet.prepareCall(request)).depositNano, '0');
    installFetch(callChain({ balance: '1000000000000', nonce: '4', balances: { [ME]: '7000000' } }).route);
    assert.equal((await qnet.prepareCall(request)).depositNano, String(core.fees.STORAGE_DEPOSIT_NANO));
    await rejectsWith(qnet.prepareCall({ ...request, amountBase: '0' }), 'INVALID_PARAMS');
  });

  it('sendCall: a token transfer signed over the node preimage, posted to the call route, and kept like a transfer', async () => {
    const env = installEnv();
    const payee = eonOf(52);
    let pendingAtPost = null;
    const { route, log } = callChain({
      balance: '1000000000000', balances: { [ME]: '7000000', [payee]: '3' },
      onCall: (request) => {
        pendingAtPost = env.state().pendingTransfers;
        return { body: { success: true, tx_hash: TX_HASH } };
      },
    });
    installFetch(route);
    const request = { kind: 'tokenTransfer', token: TOKEN, to: payee, amountBase: '2500000' };
    const tx = core.buildTokenTransfer({ from: ME, token: TOKEN, to: payee, amount: '2500000', nonce: '1' });
    const result = await qnet.sendCall({ request, expectedFeeNano: tx.maxFeeNano, expectedDepositNano: '0', expectedNonce: '1', oneInFlight: true });
    assert.deepEqual(result, { txHash: TX_HASH, status: 'submitted', nonce: '1', from: ME });
    assert.equal(log.calls.length, 1);
    assert.equal(log.posts.length, 0, 'nothing to the transfer route');
    const { body } = log.calls[0];
    const parsed = JSON.parse(body);
    assert.deepEqual(Object.keys(parsed), ['from', 'contract_address', 'method', 'args', 'gas_price', 'gas_limit', 'nonce', 'dilithium_signature', 'dilithium_public_key']);
    assert.deepEqual(parsed.args, [payee, '2500000']);
    assert.equal(body, core.contractCallRequestJson(tx, parsed.dilithium_signature, parsed.dilithium_public_key), 'the shared builder\'s bytes');
    assert.equal(await core.verifyConsensusSignature(tx.preimage, parsed.dilithium_signature, parsed.dilithium_public_key), true);
    assert.match(tx.preimage, new RegExp(`^q1337\\|contract_call:${ME}:[0-9a-f]{64}:1:10:${tx.gasLimit}$`));
    assert.equal(pendingAtPost.length, 1, 'stored before the POST');
    assert.deepEqual(env.state().pendingTransfers, [{
      nonce: '1', to: TOKEN, amountNano: '0', feeNano: tx.maxFeeNano, body, txHash: TX_HASH, createdAt: pendingAtPost[0].createdAt,
      lastSubmitAt: pendingAtPost[0].lastSubmitAt, outcome: 'pending', kind: 'call', call: { method: 'transfer', recipient: payee, amount: '2500000' },
    }]);
    assert.deepEqual(env.state().recipients, [payee], 'a token recipient the user signed for is known');
    assert.equal(env.calls.signQnetCall, 1);
  });

  it('sendCall: refuses what the review did not show and what the node\'s door would not check', async () => {
    const env = installEnv();
    const payee = eonOf(53);
    const request = { kind: 'tokenTransfer', token: TOKEN, to: payee, amountBase: '2500000' };
    const tx = core.buildTokenTransfer({ from: ME, token: TOKEN, to: payee, amount: '2500000', nonce: '1' });
    const send = (extra = {}) => qnet.sendCall({ request, expectedFeeNano: tx.maxFeeNano, expectedDepositNano: '0', expectedNonce: '1', ...extra });
    installFetch(callChain({ balance: '1000000000000', balances: { [ME]: '7000000' } }).route);
    await rejectsWith(send(), 'FEE_CHANGED', 'the recipient holds none now: a deposit the review did not show');
    await rejectsWith(send({ expectedFeeNano: '1' }), 'FEE_CHANGED');
    await rejectsWith(send({ expectedDepositNano: String(core.fees.STORAGE_DEPOSIT_NANO), expectedNonce: '2' }), 'NONCE_CHANGED');
    installFetch(callChain({ balance: '1000000000000', balances: { [ME]: '2499999', [payee]: '1' } }).route);
    await rejectsWith(send(), 'INSUFFICIENT_FUNDS', 'the token balance does not cover the amount');
    installFetch(callChain({ balance: '1000000000000', balances: { [payee]: '1' } }).route);
    await rejectsWith(send(), 'INSUFFICIENT_FUNDS', 'a live balance of none');
    installFetch(callChain({ balance: '1000000000000', balances: { [ME]: '7000000', [payee]: '1' }, unreadable: [TOKEN] }).route);
    await rejectsWith(send({ expectedDepositNano: String(core.fees.STORAGE_DEPOSIT_NANO) }), 'NETWORK', 'no node answered the token proof');
    // a fresh worker: nothing an earlier read of this test kept stands in
    qnet = await worker(`poor=${Date.now()}`);
    installFetch(callChain({ balance: String(BigInt(tx.maxFeeNano) - 1n), balances: { [ME]: '7000000', [payee]: '1' } }).route);
    await rejectsWith(send(), 'INSUFFICIENT_FUNDS', 'the QNC balance does not cover the fee');
    assert.equal(env.calls.signQnetCall, 0);
    // behind a transaction not in a block yet, a dApp request is refused before signing (the node admits committed + 1 only)
    const earlier = { nonce: '1', to: payee, amountNano: '1', feeNano: FEE, body: '{"n":1}', txHash: null, createdAt: Date.now(), lastSubmitAt: Date.now(), outcome: 'pending', kind: 'transfer', call: null };
    env.setState({ ...emptyState(), pendingTransfers: [earlier] });
    installFetch(callChain({ balance: '1000000000000', balances: { [ME]: '7000000', [payee]: '1' } }).route);
    const next = core.buildTokenTransfer({ from: ME, token: TOKEN, to: payee, amount: '2500000', nonce: '2' });
    await rejectsWith(qnet.sendCall({ request, expectedFeeNano: next.maxFeeNano, expectedDepositNano: '0', expectedNonce: '2', oneInFlight: true }), 'NONCE_CHANGED');
    assert.equal(env.calls.signQnetCall, 0);
  });

  it('sendCall: a WASM call with the default fuel, hex input, and a node\'s refusal kept as refused', async () => {
    const env = installEnv();
    const { route, log } = callChain({ onCall: () => ({ body: { success: false, error: 'Failed to submit contract call' } }) });
    installFetch(route);
    const request = { kind: 'contractCall', contract: GAME, method: 'play', args: 'c0ffee', gasLimit: null };
    const tx = core.buildContractCall({ from: ME, contract: GAME, method: 'play', args: 'c0ffee', nonce: '1' });
    assert.equal(Number(tx.gasLimit), Number(tx.intrinsicGas) + core.WASM_DEFAULT_FUEL);
    await rejectsWith(qnet.sendCall({ request, expectedFeeNano: tx.maxFeeNano, expectedDepositNano: '0', expectedNonce: '1' }), 'NODE_REJECTED');
    assert.equal(JSON.parse(log.calls[0].body).args, 'c0ffee');
    const [kept] = env.state().pendingTransfers;
    assert.deepEqual([kept.kind, kept.outcome, kept.to, kept.amountNano, kept.call], ['call', 'refused', GAME, '0', { method: 'play', recipient: null, amount: null }]);
    assert.deepEqual(env.state().recipients, [], 'a contract is no recipient');
    // the next transaction takes its nonce by default, as after a refused transfer (R5-EXTQ-02)
    const review = await qnet.preview({ to: eonOf(54), amount: '1' });
    assert.equal(review.nonce, '1');
    assert.deepEqual(review.outstanding.map((p) => [p.nonce, p.kind, p.refused]), [['1', 'call', true]]);
  });

  it('prepareCall: a call without input carries "" in its calldata, as the mobile app builds it; null or uppercase is refused', async () => {
    installEnv();
    installFetch(callChain().route);
    const preview = await qnet.prepareCall({ kind: 'contractCall', contract: GAME, method: 'run', args: '', gasLimit: null });
    const tx = core.buildContractCall({ from: ME, contract: GAME, method: 'run', args: '', nonce: '1' });
    assert.equal(tx.callData, `{"args":"","contract":"${GAME}","method":"run"}`);
    assert.deepEqual([preview.args, preview.gasLimit, preview.feeNano, preview.nonce], ['', tx.gasLimit, tx.maxFeeNano, '1']);
    await rejectsWith(qnet.prepareCall({ kind: 'contractCall', contract: GAME, method: 'run', args: null, gasLimit: null }), 'INVALID_PARAMS');
    await rejectsWith(qnet.prepareCall({ kind: 'contractCall', contract: GAME, method: 'run', args: 'C0', gasLimit: null }), 'INVALID_PARAMS');
  });

  it('resends a call body to the call route, and decides it by a contract_call row at its nonce', async () => {
    const record = (nonce, extra = {}) => ({
      nonce, to: GAME, amountNano: '0', feeNano: '4500000', body: `{"call":${nonce}}`, txHash: null, createdAt: Date.now() - 60_000,
      lastSubmitAt: Date.now() - 60_000, outcome: 'pending', kind: 'call', call: { method: 'play', recipient: null, amount: null }, ...extra,
    });
    let env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('1'), record('2')] } });
    const row = (nonce, type = 'contract_call', to = GAME) => ({ from: ME, to, amount: 0, nonce: Number(nonce), type, hash: 'ee'.repeat(32) });
    const { route, log } = callChain({ nonce: '1', sent: [row('1')] });
    installFetch(route);
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 1, confirmed: 1, replaced: 0, passed: 0 });
    assert.deepEqual(log.calls.map((r) => r.body), ['{"call":2}'], 'the call route, the same bytes');
    assert.equal(log.posts.length, 0);
    assert.deepEqual(env.state().pendingTransfers.map((p) => [p.nonce, p.outcome]), [['1', 'confirmed'], ['2', 'pending']]);
    // a transfer at its nonce: another transaction took it
    env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('1')] } });
    installFetch(callChain({ nonce: '1', sent: [{ ...row('1', 'transfer', eonOf(55)), amount: 5 }] }).route);
    assert.deepEqual(await qnet.resubmitPending(), { resubmitted: 0, confirmed: 0, replaced: 1, passed: 0 });
    const listed = (await (async () => {
      installFetch(routes(archiveRoute([]), callChain({ nonce: '1' }).route));
      return qnet.getHistory({});
    })()).pending;
    assert.deepEqual(listed.map((i) => [i.kind, i.method, i.recipient, i.status]), [['call', 'play', null, 'replaced']]);
  });

  it('a recipient that is a contract is never previewed or signed for: QNC or token, the token itself included (EXT-R2A-01)', async () => {
    const env = installEnv();
    const { route, log, net } = callChain({
      balance: '1000000000000', contracts: { [TOKEN]: tokenInfo(), [GAME]: notToken }, balances: { [ME]: '7000000' },
      accounts: { [GAME]: GAME_ACCOUNT },
    });
    installFetch(route);
    const payee = eonOf(56);
    // what a recipient is comes at once from what two pinned nodes report of it: a token, another contract, none
    await qnet.assertPayableRecipient(payee);
    await rejectsWith(qnet.assertPayableRecipient(GAME), 'RECIPIENT_IS_CONTRACT');
    await rejectsWith(qnet.assertPayableRecipient(TOKEN), 'RECIPIENT_IS_CONTRACT');
    await qnet.backgroundReads();
    const proofReads = () => net.requests.filter((r) => r.includes(`/api/v1/account/${ME}/balance/proof`)).length;
    const own = [proofReads(), log.tokenReads];
    await qnet.assertPayableRecipient(ME, ME);
    await qnet.backgroundReads();
    assert.deepEqual([proofReads(), log.tokenReads], own, "the wallet's own address is no contract and is not read");
    // the popup's review and send, and a dApp's transfer
    await rejectsWith(qnet.preview({ to: GAME, amount: '100' }), 'RECIPIENT_IS_CONTRACT');
    await rejectsWith(qnet.prepareTransfer({ to: TOKEN, amountNano: '1' }), 'RECIPIENT_IS_CONTRACT');
    await rejectsWith(qnet.send({ to: GAME, amount: '100', expectedFeeNano: FEE, expectedNonce: '1' }), 'RECIPIENT_IS_CONTRACT');
    await rejectsWith(qnet.sendTransfer({ to: TOKEN, amountNano: '1', expectedFeeNano: FEE, oneInFlight: true }), 'RECIPIENT_IS_CONTRACT');
    // a token transfer to the token contract or to another contract
    for (const to of [TOKEN, GAME]) {
      const request = { kind: 'tokenTransfer', token: TOKEN, to, amountBase: '2500000' };
      const tx = core.buildTokenTransfer({ from: ME, token: TOKEN, to, amount: '2500000', nonce: '1' });
      await rejectsWith(qnet.prepareCall(request), 'RECIPIENT_IS_CONTRACT');
      await rejectsWith(qnet.sendCall({ request, expectedFeeNano: tx.maxFeeNano, expectedDepositNano: '0', expectedNonce: '1' }), 'RECIPIENT_IS_CONTRACT');
    }
    assert.equal(env.calls.signQnetTransfer, 0);
    assert.equal(env.calls.signQnetCall, 0);
    assert.deepEqual([log.posts.length, log.calls.length], [0, 0]);
    assert.deepEqual(env.state().pendingTransfers, []);
    // a contract call's target is a contract by design: not refused
    const call = await qnet.prepareCall({ kind: 'contractCall', contract: GAME, method: 'play', args: '', gasLimit: null });
    assert.equal(call.contract, GAME);
  });

  it('a recipient no two nodes agree on is not signed for: RECIPIENT_UNCHECKED, whatever its certified leaf says (EXT-R2A-01)', async () => {
    const env = installEnv();
    const payee = eonOf(57);
    const none = noContractOf(payee);
    const refused = async () => {
      await rejectsWith(qnet.assertPayableRecipient(payee), 'RECIPIENT_UNCHECKED');
      await rejectsWith(qnet.preview({ to: payee, amount: '1' }), 'RECIPIENT_UNCHECKED');
      await rejectsWith(qnet.send({ to: payee, amount: '1', expectedFeeNano: FEE, expectedNonce: '1' }), 'RECIPIENT_UNCHECKED');
      await qnet.backgroundReads();
    };
    // no node answers what the address is, while its certified leaf proves no contract
    const { route } = callChain({ balance: '1000000000000' });
    installFetch(async (request) => (request.url.includes(`/api/v1/token/${payee}`) ? { status: 503, body: '{"error":"busy"}' } : route(request)));
    await refused();
    // one node's word is not enough
    installFetch(callChain({ balance: '1000000000000', contracts: { [payee]: (node) => (node === QNET.NODES[0] ? none : { success: false, error: 'busy' }) } }).route);
    await refused();
    // two nodes that answer differently, the others nothing usable: no answer stands
    const split = [none, notTokenOf(payee)];
    installFetch(callChain({ balance: '1000000000000', contracts: { [payee]: (node) => split[QNET.NODES.indexOf(node)] ?? { success: false, error: 'busy' } } }).route);
    await refused();
    assert.equal(env.calls.signQnetTransfer, 0);
    assert.deepEqual(env.state().pendingTransfers, []);
  });

  it('a recipient\'s certified leaf is read in the background only: it never holds the check, one read at a time, and a contract it proves is refused from then on', async () => {
    const env = installEnv();
    const payee = eonOf(59);
    const { route, log, net } = callChain({ balance: '1000000000000', accounts: { [GAME]: GAME_ACCOUNT } });
    const reads = (address) => net.requests.filter((r) => r.includes(`/api/v1/account/${address}/balance/proof`)).length;
    // the read ahead of the Send tab and the review share one leaf read
    installFetch(route);
    await qnet.sendWarm({ to: payee });
    await Promise.all([qnet.assertPayableRecipient(payee), qnet.prepareTransfer({ to: payee, amountNano: '1' })]);
    await qnet.backgroundReads();
    assert.equal(reads(payee), 1, 'one certified leaf read for the read ahead and the two checks');
    // a slow committee walk: every certified read waits 3 s, and the checks answer at once on the nodes' word
    installFetch(async (request) => {
      const { pathname, search } = new URL(request.url);
      if (pathname.startsWith('/api/v1/macroblock/') || search.includes('mb=')) await new Promise((resolve) => setTimeout(resolve, 3000));
      return route(request);
    });
    const started = Date.now();
    await qnet.assertPayableRecipient(GAME); // every node says GAME holds no contract
    const preview = await qnet.preview({ to: eonOf(60), amount: '1' });
    const took = Date.now() - started;
    assert.equal(preview.to, eonOf(60));
    assert.ok(took < 1500, `the recipient checks took ${took} ms, not the committee walk`);
    // its certified leaf, read beside the check, proves a contract: refused from then on, with no node asked again
    await qnet.backgroundReads();
    const asked = log.tokenReads;
    await rejectsWith(qnet.assertPayableRecipient(GAME), 'RECIPIENT_IS_CONTRACT');
    await rejectsWith(qnet.preview({ to: GAME, amount: '1' }), 'RECIPIENT_IS_CONTRACT');
    await rejectsWith(qnet.send({ to: GAME, amount: '1', expectedFeeNano: FEE, expectedNonce: '1' }), 'RECIPIENT_IS_CONTRACT');
    assert.equal(log.tokenReads, asked, 'a contract the leaf proved is refused without asking the nodes');
    assert.equal(env.calls.signQnetTransfer, 0);
  });

  it('a recipient\'s certified leaf stands while its macroblock does, and a contract stays one', async () => {
    installEnv();
    const payee = eonOf(58);
    const { route, net } = callChain({ balance: '1000000000000', contracts: { [GAME]: notToken }, accounts: { [GAME]: GAME_ACCOUNT } });
    installFetch(route);
    const reads = (address) => net.requests.filter((r) => r.includes(`/api/v1/account/${address}/balance/proof`)).length;
    // a check, then the leaf read it started in the background
    const check = async (address) => {
      const refusal = qnet.assertPayableRecipient(address).then(() => null, (error) => error);
      await qnet.backgroundReads();
      const error = await refusal;
      if (error !== null) throw error;
    };
    await check(payee);
    await check(payee);
    assert.equal(reads(payee), 1, 'read once while its macroblock stands');
    await rejectsWith(check(GAME), 'RECIPIENT_IS_CONTRACT');
    // three macroblocks on, the leaf read before no longer stands; a contract still is one
    for (let i = 0; i < 3; i++) net.certify({ [ME]: { balance: '1000000000000', nonce: '0' }, [GAME]: GAME_ACCOUNT });
    net.install();
    await check(payee);
    assert.equal(reads(payee), 2, 'read again at a macroblock that stands');
    await rejectsWith(check(GAME), 'RECIPIENT_IS_CONTRACT');
    assert.equal(reads(GAME), 1, 'a contract is not read again');
  });

  it('transactionStatus: pending while this wallet sends one there, in a block with the hash two nodes list, else unknown', async () => {
    const pending = {
      nonce: '3', to: GAME, amountNano: '0', feeNano: '4500000', body: '{}', txHash: TX_HASH, createdAt: Date.now(), lastSubmitAt: Date.now(),
      outcome: 'pending', kind: 'call', call: { method: 'play', recipient: null, amount: null },
    };
    installEnv({ state: { ...emptyState(), pendingTransfers: [pending, { ...pending, nonce: '4', body: '{"n":4}', outcome: 'refused' }] } });
    const hash = 'ee'.repeat(32);
    const found = (height) => () => ({ status: 'found', transaction: { hash, status: 'confirmed', block_height: height, tx_type: 'ContractCall' } });
    installFetch(callChain({ nonce: '2', sent: [{ from: ME, to: GAME, amount: 0, nonce: 2, type: 'contract_call', hash }], tx: { [hash]: found(2212409) } }).route);
    assert.deepEqual(await qnet.transactionStatus({ from: ME, nonce: '3' }), { status: 'pending', from: ME, nonce: '3', txHash: null, blockHeight: null });
    assert.deepEqual(await qnet.transactionStatus({ from: ME, nonce: '4' }), { status: 'unknown', from: ME, nonce: '4', txHash: null, blockHeight: null },
      'a refused one is no longer sent');
    assert.deepEqual(await qnet.transactionStatus({ from: ME, nonce: '9' }), { status: 'unknown', from: ME, nonce: '9', txHash: null, blockHeight: null });
    assert.deepEqual(await qnet.transactionStatus({ from: ME, nonce: '2' }), { status: 'in_block', from: ME, nonce: '2', txHash: hash, blockHeight: 2212409 });
    // nodes that report another height: in a block, the height unknown
    installFetch(callChain({
      nonce: '2', sent: [{ from: ME, to: GAME, amount: 0, nonce: 2, type: 'contract_call', hash }],
      tx: { [hash]: (node) => found(QNET.NODES.indexOf(node))() },
    }).route);
    assert.deepEqual(await qnet.transactionStatus({ from: ME, nonce: '2' }), { status: 'in_block', from: ME, nonce: '2', txHash: hash, blockHeight: null });
    // a used nonce no two nodes list: unknown; an account nonce no two nodes report alike: unknown
    installFetch(callChain({ nonce: '2', sent: [] }).route);
    assert.equal((await qnet.transactionStatus({ from: ME, nonce: '1' })).status, 'unknown');
    installFetch(callChain({ nonce: '2', perNode: (node) => ({ balance: '1', nonce: String(QNET.NODES.indexOf(node) + 5), pk: false }) }).route);
    qnet = await worker(`status=${Date.now()}`);
    assert.equal((await qnet.transactionStatus({ from: ME, nonce: '3' })).status, 'unknown', 'no agreed account nonce: unknown');
    // the nonce two nodes report live decides, never a certified state that lags it: in a block at once
    installFetch(callChain({
      nonce: '0', perNode: () => ({ balance: '1', nonce: '2', pk: false }),
      sent: [{ from: ME, to: GAME, amount: 0, nonce: 2, type: 'contract_call', hash }], tx: { [hash]: found(2212409) },
    }).route);
    assert.deepEqual(await qnet.transactionStatus({ from: ME, nonce: '2' }), { status: 'in_block', from: ME, nonce: '2', txHash: hash, blockHeight: 2212409 });
    await rejectsWith(qnet.transactionStatus({ from: GAME, nonce: '1' }), 'UNAUTHORIZED');
    await rejectsWith(qnet.transactionStatus({ from: ME, nonce: '0' }), 'INVALID_PARAMS');
  });
  // Owner, 06.10: any token of the QNet network can be sent from the popup, by the path and checks of a dApp's token
  // transfer; the wallet lists the built-in tokens it holds, each named by two nodes, each balance certified.
  it('listTokens: the contracts two nodes list as held, each a QRC-20 token two nodes name, with its live balance', async () => {
    installEnv();
    const realRandom = Math.random;
    Math.random = () => 0.999999; // the pinned nodes in their own order: the first two are asked
    try {
      const GOLD = TOKEN;
      const SILVER = core.deriveContractAddress(ME, 2);
      const EMPTY = core.deriveContractAddress(ME, 4);
      const lists = { [QNET.NODES[0]]: [GOLD, GAME], [QNET.NODES[1]]: [GOLD, SILVER, EMPTY] };
      const silver = { success: true, token: { contract_address: SILVER, standard: 'qrc20', name: 'Silver', symbol: 'SLV', decimals: 2 } };
      const empty = { success: true, token: { contract_address: EMPTY, standard: 'qrc20', name: 'Empty', symbol: 'EMP', decimals: 0 } };
      // SILVER's balance proof is unreadable on every node, EMPTY's holder entry is proven absent (a balance of 0)
      const base = callChain({
        contracts: { [GOLD]: tokenInfo(), [GAME]: notToken, [SILVER]: silver, [EMPTY]: empty },
        balances: { [ME]: '1500000' }, tokens: { [SILVER]: { holders: { [ME]: '5' } }, [EMPTY]: { holders: {} } }, unreadable: [SILVER],
      });
      const held = nodeRoute(({ node, path: p }) => {
        if (p === `/api/v1/account/${ME}/tokens`) {
          return { body: { success: true, address: ME, tokens: (lists[node] ?? []).map((contract) => ({ contract_address: contract, balance: '1' })) } };
        }
        return undefined;
      });
      const requests = installFetch(routes(held, base.route));
      // a fresh worker: no token read by an earlier test is kept
      const qnet = await worker(`held=${Date.now()}`);
      // a token whose balance is unread is listed, with a dash for its balance: the list leaves nothing out (L-13)
      assert.deepEqual(await qnet.listTokens(), {
        tokens: [
          { contract: GOLD, name: 'Gold Coin', symbol: 'GOLD', decimals: 6, balanceBase: '1500000', reserved: false },
          { contract: SILVER, name: 'Silver', symbol: 'SLV', decimals: 2, balanceBase: null, reserved: false },
        ],
        complete: true,
      });
      const listReads = requests.filter((r) => r.url.endsWith(`/account/${ME}/tokens`)).map((r) => new URL(r.url).origin);
      assert.deepEqual(listReads, [QNET.NODES[0], QNET.NODES[1]], 'two nodes list the held contracts; another contract and a zero balance are left out');
      // the list of held contracts is kept a minute, the balances are read again
      await qnet.listTokens();
      assert.equal(requests.filter((r) => r.url.endsWith(`/account/${ME}/tokens`)).length, 2);
      // a token this wallet is sending all of stays listed at zero while History lists that send (it names the send's
      // token and amount by this list), first, so tokens sent to the wallet unasked never push it out (L-13); a replaced
      // one does not keep it
      const sendingCall = (outcome) => ({
        nonce: '3', to: EMPTY, amountNano: '0', feeNano: FEE, body: `{"c":"${outcome}"}`, txHash: null, createdAt: Date.now(),
        lastSubmitAt: Date.now(), outcome, kind: 'call', call: { method: 'transfer', recipient: TO, amount: '5' },
      });
      installEnv({ state: { ...emptyState(), pendingTransfers: [sendingCall('pending')] } });
      installFetch(routes(held, base.route));
      const sending = await worker(`sending=${Date.now()}`);
      assert.deepEqual((await sending.listTokens()).tokens.map((token) => [token.symbol, token.balanceBase]),
        [['EMP', '0'], ['GOLD', '1500000'], ['SLV', null]]);
      installEnv({ state: { ...emptyState(), pendingTransfers: [sendingCall('replaced')] } });
      installFetch(routes(held, base.route));
      const replaced = await worker(`replaced=${Date.now()}`);
      assert.deepEqual((await replaced.listTokens()).tokens.map((token) => token.symbol), ['GOLD', 'SLV']);
      // no node lists anything: NETWORK
      const fresh = await worker(`tokens=${Date.now()}`);
      installFetch(nodeRoute(() => ({ status: 503, body: '{}' })));
      await rejectsWith(fresh.listTokens(), 'NETWORK');
    } finally {
      Math.random = realRandom;
    }
  });

  // L-13: tokens sent to the wallet unasked may be more than TOKEN_LIST_MAX (20); the token of this wallet's own send comes
  // first and is never cut, and a list that leaves held tokens out says it is not complete (the popup says so). M-5: each
  // row says whether the token is named after QNet's own coin.
  it('listTokens: the token of a send comes before the held ones, a list past 20 is not complete, and a QNC-named token is marked', async () => {
    const realRandom = Math.random;
    Math.random = () => 0.999999;
    try {
      const held = Array.from({ length: 22 }, (_, i) => core.deriveContractAddress(ME, 100 + i));
      const SENDING = core.deriveContractAddress(ME, 200);
      const info = (contract, symbol) => ({
        success: true, token: { contract_address: contract, standard: 'qrc20', name: `Token ${symbol}`, symbol, decimals: 2 },
      });
      const contracts = Object.fromEntries([...held.map((contract, i) => [contract, info(contract, i === 0 ? 'QNC' : `T${i}`)]),
        [SENDING, info(SENDING, 'MINE')]]);
      const base = callChain({
        contracts, tokens: Object.fromEntries([...held, SENDING].map((contract) => [contract, { holders: { [ME]: '700' } }])),
      });
      const list = nodeRoute(({ path: p }) => (p === `/api/v1/account/${ME}/tokens`
        ? { body: { success: true, address: ME, tokens: held.map((contract) => ({ contract_address: contract, balance: '700' })) } } : undefined));
      const sendingCall = {
        nonce: '3', to: SENDING, amountNano: '0', feeNano: FEE, body: '{"c":1}', txHash: null, createdAt: Date.now(), lastSubmitAt: Date.now(),
        outcome: 'pending', kind: 'call', call: { method: 'transfer', recipient: TO, amount: '5' },
      };
      installEnv({ state: { ...emptyState(), pendingTransfers: [sendingCall] } });
      installFetch(routes(list, base.route));
      const fresh = await worker(`many=${Date.now()}`);
      const { tokens, complete } = await fresh.listTokens();
      assert.equal(complete, false, '23 tokens, 20 listed');
      assert.equal(tokens.length, 20);
      assert.equal(tokens[0].contract, SENDING, 'the token of the send first');
      assert.deepEqual(tokens.slice(1).map((token) => token.contract), held.slice(0, 19));
      assert.deepEqual(tokens.filter((token) => token.reserved).map((token) => token.symbol), ['QNC']);
      // within the cap, with every token read: complete
      installEnv();
      installFetch(routes(nodeRoute(({ path: p }) => (p === `/api/v1/account/${ME}/tokens`
        ? { body: { success: true, address: ME, tokens: held.slice(0, 3).map((contract) => ({ contract_address: contract, balance: '700' })) } }
        : undefined)), base.route));
      const few = await worker(`few=${Date.now()}`);
      assert.deepEqual(await few.listTokens().then((r) => [r.tokens.length, r.complete]), [3, true]);
      // a held contract no two nodes say what it is: left out, so not complete
      const unread = held[1];
      installFetch(routes(nodeRoute(({ path: p }) => (p === `/api/v1/account/${ME}/tokens`
        ? { body: { success: true, address: ME, tokens: held.slice(0, 3).map((contract) => ({ contract_address: contract, balance: '700' })) } }
        : undefined)), callChain({
        contracts: { ...contracts, [unread]: (node) => info(unread, `N${QNET.NODES.indexOf(node)}`) },
        tokens: Object.fromEntries(held.map((contract) => [contract, { holders: { [ME]: '700' } }])),
      }).route));
      const partial = await worker(`partial=${Date.now()}`);
      const read = await partial.listTokens();
      assert.equal(read.complete, false);
      assert.deepEqual(read.tokens.map((token) => token.contract), [held[0], held[2]]);
    } finally {
      Math.random = realRandom;
    }
  });

  it('tokenPreview and tokenSend: the decimal amount in the token\'s decimals, then prepareCall and sendCall, as a dApp\'s', async () => {
    const env = installEnv();
    const payee = eonOf(54);
    const { route, log } = callChain({
      balance: '1000000000000', contracts: { [TOKEN]: tokenInfo(6, 'QNC Gold', 'GOLD') }, balances: { [ME]: '7000000', [payee]: '3' },
    });
    installFetch(route);
    // a fresh worker: no token read by an earlier test is kept
    const qnet = await worker(`send=${Date.now()}`);
    const preview = await qnet.tokenPreview({ token: TOKEN, to: payee, amount: '2.5' });
    const tx = core.buildTokenTransfer({ from: ME, token: TOKEN, to: payee, amount: '2500000', nonce: '1' });
    assert.equal(preview.kind, 'tokenTransfer');
    assert.equal(preview.token, TOKEN);
    assert.equal(preview.amountBase, '2500000');
    assert.equal(preview.amount, '2.5');
    assert.deepEqual([preview.name, preview.symbol, preview.decimals], ['QNC Gold', 'GOLD', 6]);
    assert.deepEqual([preview.feeNano, preview.depositNano, preview.nonce, preview.tokenBalance], [tx.maxFeeNano, '0', '1', '7000000']);
    assert.equal(preview.reserved, true, 'a token named after QNC is flagged, as in the approval window');
    assert.equal(preview.burn, false);
    assert.equal(typeof preview.recipient?.known, 'boolean');
    await rejectsWith(qnet.tokenPreview({ token: TOKEN, to: payee, amount: '0.0000001' }), 'INVALID_AMOUNT');
    await rejectsWith(qnet.tokenPreview({ token: eonOf(55), to: payee, amount: '1' }), 'INVALID_PARAMS');
    const result = await qnet.tokenSend({
      token: TOKEN, to: payee, amount: '2.5', expectedFeeNano: preview.feeNano, expectedDepositNano: '0', expectedNonce: '1',
    });
    assert.deepEqual(result, { txHash: TX_HASH, status: 'submitted', nonce: '1', from: ME });
    assert.deepEqual(JSON.parse(log.calls[0].body).args, [payee, '2500000']);
    assert.equal(env.state().pendingTransfers[0].call.amount, '2500000');
    await rejectsWith(qnet.tokenSend({
      token: TOKEN, to: payee, amount: '2.5', expectedFeeNano: '1', expectedDepositNano: '0', expectedNonce: '2',
    }), 'FEE_CHANGED');
    // a contract that is no QRC-20 token is no token to send
    installFetch(callChain({ balance: '1000000000000', contracts: { [GAME]: notToken } }).route);
    await rejectsWith(qnet.tokenPreview({ token: GAME, to: payee, amount: '1' }), 'INVALID_PARAMS');
  });

  // The send rule for a token, as the app: the token balance at a pinned node's live tip, less what this wallet's own token
  // transfers not in a block yet may still move.
  it('a token balance a send is decided by is the live one, less this wallet\'s own token transfers above the live nonce', async () => {
    const payee = eonOf(58);
    const at = Date.now() - 60_000;
    const transferRecord = (nonce, amount) => ({
      nonce, to: TOKEN, amountNano: '0', feeNano: '1511025', body: `{"t":${nonce}}`, txHash: TX_HASH, createdAt: at, lastSubmitAt: at,
      outcome: 'pending', kind: 'call', call: { method: 'transfer', recipient: payee, amount },
    });
    installEnv({ state: { ...emptyState(), pendingTransfers: [transferRecord('1', '2000000'), transferRecord('2', '1000000')] } });
    // certified at nonce 0 with 7 GOLD; the tip took nonce 1 (5 GOLD left), and nonce 2 is still on its way
    const { route, net } = callChain({ balance: '1000000000000', balances: { [ME]: '7000000', [payee]: '9' } });
    net.setTip({ [ME]: { balance: '999990000000', nonce: '1' } }, { [TOKEN]: { holders: { [ME]: '5000000', [payee]: '2000009' } } });
    installFetch(route);
    const preview = await qnet.prepareCall({ kind: 'tokenTransfer', token: TOKEN, to: payee, amountBase: '1000' });
    assert.deepEqual([preview.nonce, preview.tokenBalance, preview.tokenProblem, preview.outstanding.map((p) => p.nonce)],
      ['3', '4000000', null, ['2']]);
    assert.ok(net.requests.some((r) => r.endsWith(`/token/${TOKEN}/${ME}/balance/proof`)), 'at the live tip');
    assert.ok(!net.requests.some((r) => r.includes(`/token/${TOKEN}/${ME}/balance/proof?mb=`)), 'no certified token read');
    const tx = core.buildTokenTransfer({ from: ME, token: TOKEN, to: payee, amount: '4000001', nonce: '3' });
    await rejectsWith(qnet.sendCall({
      request: { kind: 'tokenTransfer', token: TOKEN, to: payee, amountBase: '4000001' }, expectedFeeNano: tx.maxFeeNano, expectedDepositNano: '0',
    }), 'INSUFFICIENT_FUNDS');
  });

  it('a token figure of a node behind the QNC base is passed over for the next node\'s: a token transfer the base holds is not counted twice', async () => {
    const realRandom = Math.random;
    Math.random = () => 0.999999; // the pinned nodes in their own order: the lagging one is asked first
    try {
      const [lagging] = QNET.NODES;
      const payee = eonOf(57);
      const at = Date.now() - 60_000;
      installEnv({ state: { ...emptyState(), pendingTransfers: [{
        nonce: '1', to: TOKEN, amountNano: '0', feeNano: '1511025', body: '{"t":1}', txHash: TX_HASH, createdAt: at, lastSubmitAt: at,
        outcome: 'pending', kind: 'call', call: { method: 'transfer', recipient: payee, amount: '2000000' },
      }] } });
      const { route, net } = callChain({ balance: '1000000000000', balances: { [ME]: '7000000', [payee]: '9' } });
      // the tip took the 2 GOLD transfer at nonce 1; the lagging node's token state is from before it, and its QNC proof fails
      net.setTip({ [ME]: { balance: '999990000000', nonce: '1' } }, { [TOKEN]: { holders: { [ME]: '5000000', [payee]: '2000009' } } }, FIRST_INDEX * 90 + 70);
      net.setTip({ [ME]: { balance: '1000000000000', nonce: '0' } }, { [TOKEN]: { holders: { [ME]: '7000000', [payee]: '9' } } }, FIRST_INDEX * 90 + 65, lagging);
      installFetch(routes(nodeRoute(({ node, path: p }) => (node === lagging && p === `/api/v1/account/${ME}/balance/proof`
        ? { status: 503, body: '{}' } : undefined)), route));
      const preview = await qnet.prepareCall({ kind: 'tokenTransfer', token: TOKEN, to: payee, amountBase: '1000' });
      assert.deepEqual([preview.nonce, preview.tokenBalance, preview.outstanding], ['2', '5000000', []]);
      const asked = net.requests.filter((r) => r.endsWith(`/token/${TOKEN}/${ME}/balance/proof`)).map((r) => new URL(r).origin);
      assert.deepEqual(asked.slice(0, 2), [lagging, QNET.NODES[1]]);
    } finally {
      Math.random = realRandom;
    }
  });

  it('a token send after this wallet\'s own contract call waits for the call\'s block: what the call moved is not known', async () => {
    const payee = eonOf(59);
    const call = {
      nonce: '1', to: GAME, amountNano: '0', feeNano: '4507800', body: '{"c":1}', txHash: TX_HASH, createdAt: Date.now() - 60_000,
      lastSubmitAt: Date.now() - 60_000, outcome: 'pending', kind: 'call', call: { method: 'play', recipient: null, amount: null },
    };
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [call] } });
    installFetch(callChain({ balance: '1000000000000', balances: { [ME]: '7000000', [payee]: '9' } }).route);
    const request = { kind: 'tokenTransfer', token: TOKEN, to: payee, amountBase: '1000' };
    const preview = await qnet.prepareCall(request);
    assert.deepEqual([preview.tokenBalance, preview.tokenProblem], [null, 'BALANCE_UNCONFIRMED']);
    const tx = core.buildTokenTransfer({ from: ME, token: TOKEN, to: payee, amount: '1000', nonce: '2' });
    await rejectsWith(qnet.sendCall({ request, expectedFeeNano: tx.maxFeeNano, expectedDepositNano: '0' }), 'BALANCE_UNCONFIRMED');
    assert.equal(env.calls.signQnetCall, 0);
    // the tip took the call: the token balance decides again
    installFetch(callChain({ balance: '1000000000000', nonce: '1', balances: { [ME]: '7000000', [payee]: '9' } }).route);
    assert.equal((await qnet.prepareCall(request)).tokenBalance, '7000000');
  });

  it('an older node\'s token proof counts when its root is a recent certified one; a proven absence is a balance of 0', async () => {
    const { route, net } = callChain({ balances: { [ME]: '42' } });
    for (const node of QNET.NODES) net.old.add(node);
    net.live = false;
    installFetch(route);
    assert.equal(await qnet.readTokenBalance(TOKEN, ME), '42');
    assert.ok(QNET.NODES.some((node) => core.nodeMarkedOld(node)));
    const fresh = await worker(`absentToken=${Date.now()}`);
    const certified = callChain({ balances: {} });
    certified.net.live = false;
    installFetch(certified.route);
    assert.equal(await fresh.readTokenBalance(TOKEN, ME), '0', 'the holder\'s entry proven absent');
    assert.equal(await fresh.readTokenBalance(core.deriveContractAddress(ME, 9), ME), '0', 'the contract proven absent');
  });

  it('a token balance Assets shows is the live one; the certified one stands in without it, and never goes over a newer live one', async () => {
    const { route, net } = callChain({ balances: { [ME]: '42' } });
    net.setTip({ [ME]: { balance: '5000000000000', nonce: '0' } }, { [TOKEN]: { holders: { [ME]: '50' } } });
    installFetch(route);
    assert.equal(await qnet.readTokenBalance(TOKEN, ME), '50', 'the tip took 8 more');
    assert.ok(net.requests.some((r) => r.endsWith(`/token/${TOKEN}/${ME}/balance/proof`)));
    net.live = false;
    const fresh = await worker(`certifiedToken=${Date.now()}`);
    assert.equal(await fresh.readTokenBalance(TOKEN, ME), '42', 'no live figure: the certified one');
    net.live = true;
    net.unreadable.add(TOKEN);
    const none = await worker(`noToken=${Date.now()}`);
    assert.equal(await none.readTokenBalance(TOKEN, ME), null, 'neither: no figure is made up');
  });

  it('a refresh joins the certified token read still running: one per token and holder at a time', async () => {
    const { route } = callChain({ balances: { [ME]: '42' } });
    const certified = `/token/${TOKEN}/${ME}/balance/proof?`;
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let asked = 0;
    let firstAsked;
    const seen = new Promise((resolve) => {
      firstAsked = resolve;
    });
    installFetch(async (request) => {
      if (request.url.includes(certified)) {
        asked += 1;
        firstAsked();
        await held;
      }
      return route(request);
    });
    try {
      assert.equal(await qnet.readTokenBalance(TOKEN, ME), '42');
      await seen;
      assert.equal(await qnet.readTokenBalance(TOKEN, ME), '42', 'the live figure, at once');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(asked, 1, 'the second read joined the first one\'s certified read');
    } finally {
      release();
    }
    await qnet.backgroundReads();
    const before = asked;
    await qnet.readTokenBalance(TOKEN, ME);
    await qnet.backgroundReads();
    assert.ok(asked > before, 'once it ended, the next refresh reads again');
  });

  it('txLookup: in a block at the height two nodes report alike, else unknown', async () => {
    installEnv();
    const found = (height) => ({ status: 'found', tx_hash: TX_HASH, transaction: { hash: TX_HASH, status: 'confirmed', block_height: height } });
    installFetch(callChain({ tx: { [TX_HASH]: () => found(4321) } }).route);
    assert.deepEqual(await qnet.txLookup({ hash: TX_HASH }), { status: 'in_block', blockHeight: 4321 });
    installFetch(callChain({ tx: { [TX_HASH]: () => ({ status: 'not_found', tx_hash: TX_HASH, transaction: null }) } }).route);
    assert.deepEqual(await qnet.txLookup({ hash: TX_HASH }), { status: 'unknown', blockHeight: null });
    await rejectsWith(qnet.txLookup({ hash: 'x' }), 'INVALID_PARAMS');
  });
});

// Owner, 06.10: balances load fast, and cached chain data of a chain the wallet no longer follows never hangs the wallet;
// a pending row resolves in a bounded time.
describe('chains-activation qnet: fast balance reads (owner, 06.10)', () => {
  it('a silent node does not hold a proof read for its whole timeout: the next node joins after the hedge', async () => {
    installEnv();
    const silent = new Set();
    const base = chain({ balance: '5000000000000', nonce: '2' });
    installFetch(async (request) => {
      const url = new URL(request.url);
      // the first node asked for the proof never answers (until the read is aborted)
      if (url.pathname.endsWith('/balance/proof') && (silent.size === 0 || silent.has(url.origin))) {
        silent.add(url.origin);
        return new Promise((resolve, reject) => {
          request.init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return base.route(request);
    });
    const started = Date.now();
    const account = await qnet.readAccount(ME, { display: true });
    const took = Date.now() - started;
    assert.deepEqual([account.balanceNano, account.nonce, account.verification], ['5000000000000', '2', 'proof']);
    assert.ok(took < 3000, `answered in ${took} ms, not after the node's ${8000} ms timeout`);
  });

  it('the popup\'s balance and a send never wait for the committee check; the certified read waits at most 1.5 s once a figure is read', async () => {
    installEnv();
    const base = chain({ balance: '5000000000000', nonce: '2' });
    installFetch(async (request) => {
      if (new URL(request.url).pathname.startsWith('/api/v1/macroblock/')) await new Promise((resolve) => setTimeout(resolve, 1600));
      return base.route(request);
    });
    let started = Date.now();
    const shown = await qnet.readAccount(ME, { display: true });
    const took = Date.now() - started;
    assert.deepEqual([shown.balanceNano, shown.verified, shown.verification], ['5000000000000', false, 'none'],
      'the figure shows as not verified while the walk goes on');
    assert.ok(took >= 1400 && took < 2500, `waited ${took} ms for the check, then answered`);
    started = Date.now();
    const balance = await qnet.getBalance();
    assert.deepEqual([balance.balanceNano, balance.verification], ['5000000000000', 'live']);
    started = Date.now();
    const preview = await qnet.prepareTransfer({ to: ME, amountNano: '1' });
    assert.deepEqual([preview.verification, preview.balanceNano], ['live', '5000000000000']);
    assert.ok(Date.now() - started < 1000, `a send's check took ${Date.now() - started} ms`);
  });

  it('a slow committee check never holds the popup\'s balance: the live figure comes at once', async () => {
    installEnv();
    const base = chain({ balance: '5000000000000', nonce: '2' });
    installFetch(async (request) => {
      const { pathname, search } = new URL(request.url);
      if (pathname.startsWith('/api/v1/macroblock/') || search.includes('mb=')) await new Promise((resolve) => setTimeout(resolve, 3000));
      return base.route(request);
    });
    const started = Date.now();
    const balance = await qnet.getBalance();
    const took = Date.now() - started;
    assert.deepEqual([balance.balanceNano, balance.verification, balance.spendableNano], ['5000000000000', 'live', '5000000000000']);
    assert.ok(took < 1500, `answered in ${took} ms, not after the committee check`);
  });
});

describe('chains-activation qnet: the chain this wallet follows (owner, 06.10)', () => {
  const pendingRecord = (nonce, extra = {}) => ({
    nonce, to: TO, amountNano: '1000000000', feeNano: FEE, body: `{"n":${nonce}}`, txHash: null, createdAt: Date.now(),
    lastSubmitAt: Date.now(), outcome: 'pending', kind: 'transfer', call: null, ...extra,
  });
  const heightRoute = (height) => nodeRoute(({ path: p }) => (p === '/api/v1/height' ? { body: `{"height":${height}}` } : undefined));

  it('a network head far below the one this wallet saw is another chain: its anchors, pending sends and balances go', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [pendingRecord('7'), pendingRecord('8')] } });
    env.chainCache = { headIndex: 50_000, views: { qnetBalance: { balanceNano: '1' } } };
    env.anchors = { 49_998: { eligible_ids: ['node_001'], beacon: 'ab'.repeat(32), registry_root: 'cd'.repeat(32) } };
    installFetch(heightRoute(1000 * 90 + 5));
    const fresh = await worker(`chain=${Date.now()}`);
    assert.equal(await fresh.followChain(), 'changed');
    assert.deepEqual(env.state().pendingTransfers, [], 'the old chain\'s sends can be decided on no chain the nodes serve');
    assert.deepEqual(env.anchors, {}, 'the kept anchors are dropped');
    assert.equal(env.capsule, null, 'and the capsule');
    assert.equal(env.capsuleWrites, 1);
    assert.deepEqual(env.forgotten, ['qnetBalance', 'qnetTokens', 'qnetHistory']);
    assert.equal(env.chainCache.headIndex, 1000, 'the new chain\'s head is the one followed now');
    assert.equal(await fresh.followChain(), 'unknown', 'checked at most once a minute');
    core.clearQcCache();
  });

  it('the same chain moving on keeps everything; the kept head moves up in steps, and anchors above the head go', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [pendingRecord('7')] } });
    env.chainCache = { headIndex: 1000 };
    installFetch(heightRoute(1004 * 90));
    let fresh = await worker(`same=${Date.now()}`);
    assert.equal(await fresh.followChain(), 'same');
    assert.equal(env.state().pendingTransfers.length, 1);
    assert.equal(env.chainCache.headIndex, 1000, 'four macroblocks on: nothing written');
    installFetch(heightRoute(1012 * 90));
    fresh = await worker(`same2=${Date.now()}`);
    assert.equal(await fresh.followChain(), 'same');
    assert.equal(env.chainCache.headIndex, 1012);
    assert.equal(env.anchorWrites, 0);
    // a kept anchor far above the head two nodes report belongs to another chain: dropped, the rest kept
    const pin = core.genesisConsensus.WS_CHECKPOINT.index;
    env.chainCache = { headIndex: pin + 100 };
    env.anchors = { [pin + 5000]: { eligible_ids: ['node_001'], beacon: 'ab'.repeat(32), registry_root: 'cd'.repeat(32) } };
    installFetch(heightRoute((pin + 100) * 90));
    fresh = await worker(`ahead=${Date.now()}`);
    assert.equal(await fresh.followChain(), 'same');
    assert.deepEqual(env.anchors, {});
    assert.equal(env.state().pendingTransfers.length, 1, 'only the anchors go');
    core.clearQcCache();
  });

  it('a chain cache an earlier build kept under the genesis identities alone is this chain: nothing goes, the identity is renamed', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [pendingRecord('7')] } });
    const { GENESIS_NODE_IDS, GENESIS_CONSENSUS_PKS } = core.genesisConsensus;
    const legacy = core.sha3_256Hex(core.utf8Encode([...GENESIS_NODE_IDS].sort().map((id) => `${id}:${GENESIS_CONSENSUS_PKS[id]}`).join('|')))
      .slice(0, 32);
    assert.notEqual(legacy, core.chainIdentity(), 'the identity now folds the network identity');
    env.chainCache = { chain: legacy, headIndex: 1000 };
    installFetch(heightRoute(1004 * 90));
    const fresh = await worker(`renamed=${Date.now()}`);
    assert.equal(await fresh.followChain(), 'same');
    assert.equal(env.state().pendingTransfers.length, 1);
    assert.deepEqual(env.forgotten, []);
    assert.deepEqual(env.chainCache, { chain: core.chainIdentity(), headIndex: 1004 });
    // another identity is another chain's
    env.chainCache = { chain: 'ff'.repeat(16), headIndex: 1000 };
    const other = await worker(`otherChain=${Date.now()}`);
    assert.equal(await other.followChain(), 'changed');
    assert.deepEqual(env.state().pendingTransfers, []);
    core.clearQcCache();
  });

  it('two lagging nodes that answer first never pass for another chain: every node is asked before anything is dropped', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [pendingRecord('7')] } });
    env.chainCache = { headIndex: 50_000 };
    const [slowA, slowB] = QNET.NODES;
    installFetch(nodeRoute(async ({ node, path: p }) => {
      if (p !== '/api/v1/height') return undefined;
      // two nodes far behind answer at once; the others, at the tip, after the hedge window of the head read
      if (node === slowA || node === slowB) return { body: `{"height":${1000 * 90}}` };
      await new Promise((resolve) => setTimeout(resolve, 900));
      return { body: `{"height":${50_002 * 90}}` };
    }));
    const fresh = await worker(`lagging=${Date.now()}`);
    assert.equal(await fresh.followChain(), 'same');
    assert.equal(env.state().pendingTransfers.length, 1, 'nothing of the chain this wallet follows is dropped');
    assert.deepEqual(env.forgotten, []);
    assert.equal(env.chainCache.headIndex, 50_000);
    core.clearQcCache();
  });

  it('no proof answer: the balance read makes nothing up (NETWORK), and a 0 no certificate verified is never shown', async () => {
    installEnv();
    installFetch(nodeRoute(() => ({ status: 503, body: '{}' })));
    await rejectsWith(qnet.readAccount(G1, { display: true }), 'NETWORK');
    const { route, net } = chain();
    net.headless = true;
    installFetch(route);
    await rejectsWith(qnet.readAccount(G1, { display: true }), 'BALANCE_UNCONFIRMED');
  });

  // the light client's own rule (QcLightClient onLineageReset): the first step above an anchor kept from an earlier session,
  // refused by two nodes for what ties it to that anchor, roots the walk lower at once; the anchor goes (and the wallet's
  // stored copy with it) only when a step of that lower walk verifies, so a device that verifies no step keeps what it has
  it('a kept anchor whose step nodes refuse stays while no lower step verifies either: the walk goes on from the pin', async () => {
    const env = installEnv();
    const proofText = raw('chains-activation-proof-g1.json');
    const proof = JSON.parse(proofText);
    const index = core.trustFloorIndex() + 1000;
    const lowProof = proofText.replace(`"block_height":${proof.block_height}`, `"block_height":${index * 90 + 5}`);
    // every node serves a well-formed step whose committee keys bind to no registry of the kept anchor's root
    const served = JSON.parse(raw('macroblock_23160_proof.json'));
    const registry = raw('registry_height_2084400.json');
    const steps = [];
    installFetch(nodeRoute(({ path: p }) => {
      const step = /^\/api\/v1\/macroblock\/([0-9]+)\/proof$/.exec(p);
      if (step) {
        const j = Number(step[1]);
        steps.push(j);
        return { body: { ...served, index: j, checkpoint: { ...served.checkpoint, index: j, window_head_height: j * 90 } } };
      }
      if (p.startsWith('/api/v1/registry/height/')) return { body: registry };
      if (p === '/api/v1/height') return { body: `{"height":${index * 90 + 30}}` };
      if (p === '/api/v1/state/certified') return { body: { proof_format: 2, views: [], newest_certified_index: index, capture: 'ok' } };
      if (p.startsWith(`/api/v1/account/${G1}/balance/proof`)) return { body: lowProof };
      if (p === `/api/v1/account/${G1}`) return { body: raw('chains-activation-account-g1.json') };
      return undefined;
    }));
    const kept = { [index - 2]: { eligible_ids: ['genesis_node_001'], beacon: 'ab'.repeat(32), registry_root: 'cd'.repeat(32) } };
    env.anchors = kept;
    // a light client with nothing of an earlier test (a head read that found too few answers is not repeated for 10 s)
    core.clearQcCache();
    const fresh = await worker(`lineage=${Date.now()}`);
    assert.equal((await fresh.readAccount(G1)).verification, 'none');
    await flush(20);
    assert.equal(steps[0], index, 'the walk started above the kept anchor');
    assert.ok(steps.some((j) => j < index - 2), 'then from the pin, at once');
    assert.deepEqual(env.anchors, kept, 'no step from the pin verified either: the kept anchor stays');
    core.clearQcCache();
  });

  it('a kept anchor of another lineage goes, from the vault too, once a step of the walk rooted below it verifies', async () => {
    // a send of this wallet a moment ago: its proofs ask for the newest certified state
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [pendingRecord('1')] } });
    const { route, net } = chain({ balance: '5' });
    installFetch(route);
    // this session verified FIRST_INDEX; the vault also holds an anchor two above it that no committee of this chain made
    const bogus = { eligible_ids: ['node_x'], beacon: 'ab'.repeat(32), registry_root: 'cd'.repeat(32) };
    env.anchors = { [FIRST_INDEX + 2]: bogus };
    assert.equal((await qnet.readAccount(ME)).index, FIRST_INDEX);
    for (let i = 0; i < 4; i++) net.certify({ [ME]: { balance: '5' } });
    net.requests.length = 0;
    await qnet.getBalance();
    const account = await qnet.readAccount(ME);
    await flush(20);
    // the walk to FIRST_INDEX + 4 rooted at the bogus anchor, its step was refused, and the walk from FIRST_INDEX verified
    const walked = net.requests.filter((r) => r.includes('/macroblock/')).map((r) => Number(r.split('/macroblock/')[1].split('/')[0]) - FIRST_INDEX);
    assert.deepEqual([walked[0], walked.includes(2)], [4, true], `steps asked: ${walked}`);
    assert.deepEqual([account.index, account.verification], [FIRST_INDEX + 4, 'proof']);
    assert.equal(Object.values(env.anchors).some((a) => a.registry_root === bogus.registry_root), false, 'the bogus anchor is gone');
    core.clearQcCache();
  });
});

describe('chains-activation qnet: a pending row resolves (owner, 06.10)', () => {
  const HOUR = 60 * 60 * 1000;
  const record = (nonce, ageMs, extra = {}) => ({
    nonce, to: TO, amountNano: '1000000000', feeNano: FEE, body: `{"n":${nonce}}`, txHash: null, createdAt: Date.now() - ageMs,
    lastSubmitAt: Date.now() - ageMs, outcome: 'pending', kind: 'transfer', call: null, ...extra,
  });
  const historyRoute = (request) => (request.url.startsWith(`${QNET.EXPLORER_API}/api/address/`)
    ? { body: { success: true, address: ME, items: [], next_cursor: null } } : undefined);

  it('a send no node can hold any more, its nonce free, reads as dropped; the next send takes its nonce', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('5', 2 * HOUR), record('6', 10 * 60 * 1000)] } });
    installFetch(routes(historyRoute, chain({ balance: '5000000000000', nonce: '4', sent: [] }).route));
    const fresh = await worker(`dropped=${Date.now()}`);
    const balance = await fresh.getBalance();
    // the dropped send's amount is no longer kept back: the next send takes its place
    assert.equal(balance.spendableNano, String(5_000_000_000_000n - 1_000_000_000n - BigInt(FEE)));
    const history = await fresh.getHistory({});
    assert.deepEqual(history.pending.map((p) => [p.nonce, p.status]), [['6', 'pending'], ['5', 'dropped']]);
    const preview = await fresh.preview({ to: TO, amount: '2' });
    assert.equal(preview.replacesNonce, '5', 'the new send is signed at the dropped one\'s nonce');
    assert.equal(preview.nonce, '5');
    assert.equal(env.state().pendingTransfers.length, 2, 'nothing is dropped from the vault before its day');
  });

  it('a dropped send leaves the list a day after it was dropped; one sent recently never reads as dropped', async () => {
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [record('5', 26 * HOUR), record('6', 50 * 60 * 1000)] } });
    installFetch(routes(historyRoute, chain({ balance: '5000000000000', nonce: '4', sent: [] }).route));
    const fresh = await worker(`expired=${Date.now()}`);
    await fresh.resubmitPending();
    assert.deepEqual(env.state().pendingTransfers.map((p) => p.nonce), ['6']);
    const history = await fresh.getHistory({});
    assert.deepEqual(history.pending.map((p) => p.status), ['pending'], 'within the node\'s lifetime it may still go through');
  });
});

describe('chains-activation qnet: token rows and blocks in the history (owner, 06.10)', () => {
  it('maps an archive token row with its token and amount, a block number, and calls it included by its own logs proof', async () => {
    installEnv();
    const TOKEN = core.deriveContractAddress(ME, 1);
    const block = FIRST_INDEX * 90 - 5;
    const tokenRow = {
      source: 'token', hash: 'cd'.repeat(32), idx: 0, block, timestamp: 1790219000000, from: TO, to: ME, amount: '340282366920938463463374607431768211455',
      tx_type: 'Transfer', fee: '0', contract: TOKEN, kind: 'transfer', std: 'qrc20', token_id: null, symbol: 'GOLD', decimals: 6, logo: '',
    };
    const nftRow = { ...tokenRow, hash: 'ef'.repeat(32), std: 'qrc721' };
    // the transfer's event leaf alone in its block, that block alone in the window the certified checkpoint closes
    const leaf = core.transferLogLeaf({ tx_hash: tokenRow.hash, log_index: 0, contract: TOKEN, from: TO, to: ME, amount: tokenRow.amount,
      kind: 'transfer', std: 'qrc20', token_id: null });
    const tagged = (tag, hex) => core.sha3_256Hex(core.concatBytes(core.utf8Encode(tag), core.hexToBytes(hex)));
    const blockRoot = tagged('log-leaf', leaf);
    const logsRoot = tagged('logw-leaf', blockRoot);
    const logProofs = [];
    const proof = { leaf, proof: [], block_root: blockRoot, window_proof: [], logs_root: logsRoot, window_end: FIRST_INDEX * 90 };
    let served = proof;
    const sent = [{ hash: 'cd'.repeat(32), from: TO, to: TOKEN, amount: 0, type: 'contract_call', nonce: 3 }];
    const archive = (request) => (request.url.startsWith(`${QNET.EXPLORER_API}/api/address/`)
      ? { body: { success: true, address: ME, items: [tokenRow, nftRow], next_cursor: null } } : undefined);
    const logs = (request) => {
      const url = new URL(request.url);
      if (url.pathname !== '/api/v1/logs/proof') return undefined;
      logProofs.push(url.search);
      return { body: served };
    };
    installFetch(routes(archive, logs, chain({ sent, logsRoot }).route));
    // a received row: no read waits for its logs proof, which runs in the background; a later read shows the verdict
    assert.deepEqual((await qnet.getHistory({})).items.map((item) => item.status), ['unverified']);
    await qnet.backgroundReads();
    const { items } = await qnet.getHistory({});
    assert.deepEqual(items, [{
      hash: 'cd'.repeat(32), direction: 'in', from: TO, to: ME, amountNano: '0', feeNano: '0', timestamp: 1790219000000, status: 'included',
      nonce: null, kind: 'token', block, token: { contract: TOKEN, symbol: 'GOLD', decimals: 6, reserved: false },
      amountBase: '340282366920938463463374607431768211455',
    }], 'a non-QRC-20 row is left out');
    assert.deepEqual(logProofs, [`?tx_hash=${'cd'.repeat(32)}&log_index=0`]);
    await qnet.getHistory({});
    assert.equal(logProofs.length, 1, 'a proven row is not asked for again');

    // two nodes listing a call another address made is no proof of the token row it received: another row's leaf, a proof
    // that does not fold, or a root that folds but is not the one the committee certified leaves it unverified
    const otherLeaf = '11'.repeat(32);
    const cases = [
      [{ ...proof, leaf: otherLeaf, block_root: tagged('log-leaf', otherLeaf), logs_root: tagged('logw-leaf', tagged('log-leaf', otherLeaf)) }, logsRoot],
      [{ ...proof, window_proof: [{ hash: '33'.repeat(32), right: true }] }, logsRoot],
      [proof, '44'.repeat(32)],
    ];
    for (const [forged, certifiedRoot] of cases) {
      qnet = await worker(`forgedRow=${Math.random()}`);
      served = forged;
      installFetch(routes(archive, logs, chain({ sent, logsRoot: certifiedRoot }).route));
      await qnet.getHistory({});
      await qnet.backgroundReads();
      assert.deepEqual((await qnet.getHistory({})).items.map((item) => item.status), ['unverified']);
    }
  });

  // Owner, 18.10: the status of every transaction shows at once on the nodes' word. A token row this wallet sent is in a
  // block once two pinned nodes list its call (a node lists a call only under its caller); its logs proof only runs in the
  // background, and a proof that contradicts the archive's row takes the row back to unverified.
  it('a token send of this wallet stays Confirmed once the archive lists its row, while its logs proof is still pending', async () => {
    const TOKEN = core.deriveContractAddress(ME, 1);
    const hash = 'c1'.repeat(32);
    const at = Date.now() - 60_000;
    const block = FIRST_INDEX * 90 - 5;
    const sentCall = { nonce: '3', to: TOKEN, amountNano: '0', feeNano: FEE, body: '{"n":3}', txHash: hash, createdAt: at, lastSubmitAt: at,
      outcome: 'confirmed', kind: 'call', call: { method: 'transfer', recipient: TO, amount: '5' } };
    const env = installEnv({ state: { ...emptyState(), pendingTransfers: [sentCall] } });
    const tokenRow = (amount) => ({ source: 'token', hash, idx: 0, block, timestamp: at, from: ME, to: TO, amount, fee: '0',
      contract: TOKEN, kind: 'transfer', std: 'qrc20', token_id: null, symbol: 'GOLD', decimals: 6, logo: '' });
    // the archive lists the call too, as its own row
    const callRow = { source: 'tx', hash, idx: 0, block, timestamp: at, from: ME, to: TOKEN, amount: '0', fee: FEE, tx_type: 'ContractCall' };
    const archive = [];
    // the window of its block is not certified yet: the node has no proof for it, and answers only when released
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const proofs = [];
    let served = null;
    const logs = async (request) => {
      if (!request.url.includes('/api/v1/logs/proof')) return undefined;
      proofs.push(request.url);
      await held;
      return served === null ? { status: 404, body: { error: 'proof not found' } } : { body: served };
    };
    const sent = [{ hash, from: ME, to: TOKEN, amount: 0, type: 'contract_call', nonce: 3 }];
    installFetch(routes(archiveRoute(archive), logs, chain({ nonce: '3', sent }).route));
    try {
      assert.deepEqual((await qnet.getHistory({})).pending.map((i) => [i.status, i.hash, i.kind]), [['included', hash, 'call']]);
      archive.push(tokenRow('5'), callRow);
      const started = Date.now();
      const page = await qnet.getHistory({});
      assert.ok(Date.now() - started < 1500, `History waited ${Date.now() - started} ms for the proof`);
      assert.deepEqual(page.items.map((i) => [i.kind, i.status]), [['token', 'included'], ['call', 'included']], 'Confirmed, never Unverified');
      assert.deepEqual(page.pending, []);
      assert.deepEqual(env.state().pendingTransfers, [], 'its row reads Confirmed on the nodes\' word: the record leaves');
    } finally {
      release();
    }
    await qnet.backgroundReads();
    assert.deepEqual((await qnet.getHistory({})).items.map((i) => i.status), ['included', 'included'], 'a pending proof takes nothing back');
    assert.equal(proofs.length, 1, 'a pending proof is asked again only after a minute');
    // one the chain skipped at apply wrote no event: the archive's row of its call alone stands for it
    const skippedEnv = installEnv({ state: { ...emptyState(), pendingTransfers: [sentCall] } });
    archive.splice(0, archive.length, callRow);
    const skipped = await qnet.getHistory({});
    assert.deepEqual([skipped.items.map((i) => [i.kind, i.status]), skipped.pending], [[['call', 'included']], []]);
    assert.deepEqual(skippedEnv.state().pendingTransfers, []);

    // the archive names another amount for the call: the node's proof of the call's own event contradicts the row
    qnet = await worker(`contradicted=${Date.now()}`);
    archive.splice(0, archive.length, tokenRow('500'));
    served = { leaf: core.transferLogLeaf({ tx_hash: hash, log_index: 0, contract: TOKEN, from: ME, to: TO, amount: '5', kind: 'transfer',
      std: 'qrc20', token_id: null }), proof: [], block_root: '22'.repeat(32), window_proof: [], logs_root: '33'.repeat(32), window_end: FIRST_INDEX * 90 };
    assert.deepEqual((await qnet.getHistory({})).items.map((i) => i.status), ['included']);
    await qnet.backgroundReads();
    assert.deepEqual((await qnet.getHistory({})).items.map((i) => i.status), ['unverified'], 'the proof contradicts it');
  });

  it('a token row whose macroblock is far below what the wallet verified is left unverified, with no proof asked', async () => {
    installEnv();
    const TOKEN = core.deriveContractAddress(ME, 1);
    const row = {
      source: 'token', hash: 'ce'.repeat(32), idx: 1, block: 2068700, timestamp: 1790219000000, from: TO, to: ME, amount: '5',
      tx_type: 'Transfer', fee: '0', contract: TOKEN, kind: 'transfer', std: 'qrc20', token_id: null, symbol: 'GOLD', decimals: 6, logo: '',
    };
    const asked = [];
    installFetch(routes(
      (request) => (request.url.startsWith(`${QNET.EXPLORER_API}/api/address/`) ? { body: { success: true, address: ME, items: [row], next_cursor: null } } : undefined),
      (request) => (request.url.includes('/api/v1/logs/proof') ? (asked.push(request.url), { body: {} }) : undefined),
      chain({ sent: [{ hash: 'ce'.repeat(32), from: TO, to: TOKEN, amount: 0, type: 'contract_call', nonce: 3 }] }).route,
    ));
    assert.deepEqual((await qnet.getHistory({})).items.map((item) => item.status), ['unverified']);
    assert.deepEqual(asked, []);
  });

  // M-5: a token row whose symbol is QNet's own, in any spelling or behind a hidden character, says so (reserved), and a
  // hidden character is shown as U+FFFD
  it('marks an archive token row named after QNC, and shows a hidden character in its symbol as U+FFFD', async () => {
    installEnv();
    const TOKEN = core.deriveContractAddress(ME, 1);
    const row = (hash, symbol) => ({
      source: 'token', hash, idx: 0, block: 2068700, timestamp: 1790219000000, from: TO, to: ME, amount: '5', tx_type: 'Transfer', fee: '0',
      contract: TOKEN, kind: 'transfer', std: 'qrc20', token_id: null, symbol, decimals: 6, logo: '',
    });
    installFetch(routes(
      (request) => (request.url.startsWith(`${QNET.EXPLORER_API}/api/address/`)
        ? { body: { success: true, address: ME, items: [row('a1'.repeat(32), 'QNC'), row('a2'.repeat(32), '\u202eCNQ'), row('a3'.repeat(32), 'GOLD')], next_cursor: null } }
        : undefined),
      chain({}).route,
    ));
    const { items } = await qnet.getHistory({});
    assert.deepEqual(items.map((item) => item.token), [
      { contract: TOKEN, symbol: 'QNC', decimals: 6, reserved: true },
      { contract: TOKEN, symbol: '\ufffdCNQ', decimals: 6, reserved: true },
      { contract: TOKEN, symbol: 'GOLD', decimals: 6, reserved: false },
    ]);
  });

  // Owner, 06.10: one transaction is one row. A node registration has no recipient (the archive gives `to: null`): it was
  // left out before; it is now its own kind with `to: ''`, never a transfer of 0 QNC, included when two pinned nodes list
  // a registration with its hash, and named by its node when it is the light node registration this wallet submitted. A
  // reward distribution (the node balance moved in) and a deploy keep their kinds; a transfer with no recipient is still
  // left out, as is a row this wallet is no party to.
  it('maps a node registration with no recipient, a reward and a deploy by their type, and confirms a registration by its hash', async () => {
    const at = 1_790_000_000_000;
    const own = '1a'.repeat(32);
    const activation = { code: core.KAT.activation.code, nodeType: 'light', burnTx: core.KAT.activation.burnTx, burnAmount: 1500,
      solanaAddress: WALLET.solanaAddress, cluster: 'devnet', createdAt: at };
    const registration = { nodeId: core.lightNodeId(ME), burnTx: activation.burnTx, burner: WALLET.solanaAddress, state: 'onchain', attempts: 1,
      nextAt: at, txHash: own, admittedAt: at, lastError: null, updatedAt: at };
    installEnv({ state: { ...emptyState(), activation, registration } });
    const row = (hash, extra) => ({ source: 'tx', hash, idx: 0, block: 10, timestamp: at, from: ME, to: null, amount: '0', fee: '0', ...extra });
    const archived = [
      row(own, { tx_type: 'NodeRegistration' }),
      row('2b'.repeat(32), { tx_type: 'NodeRegistration' }),
      row('3c'.repeat(32), { from: 'system_rewards_pool', to: ME, amount: '5000000000', tx_type: 'RewardDistribution' }),
      row('4d'.repeat(32), { tx_type: 'ContractDeploy', fee: '1000' }),
      row('5e'.repeat(32), { tx_type: 'Transfer' }),
      row('5f'.repeat(32), { to: '', tx_type: 'Transfer' }),
      row('6f'.repeat(32), { from: TO, tx_type: 'NodeRegistration' }),
    ];
    installFetch(routes(archiveRoute(archived), chain({
      sent: [
        { hash: own, from: ME, to: null, amount: 0, type: 'node_registration', nonce: 0 },
        { hash: '3c'.repeat(32), from: 'system_rewards_pool', to: ME, amount: 5000000000, type: 'reward', nonce: 0 },
      ],
    }).route));
    const { items } = await qnet.getHistory({});
    const base = { direction: 'out', from: ME, to: '', amountNano: '0', feeNano: '0', timestamp: at, nonce: null, block: 10 };
    assert.deepEqual(items, [
      { ...base, hash: own, status: 'included', kind: 'node_registration', nodeId: core.lightNodeId(ME) },
      { ...base, hash: '2b'.repeat(32), status: 'unverified', kind: 'node_registration' },
      { ...base, hash: '3c'.repeat(32), direction: 'in', from: 'system_rewards_pool', to: ME, amountNano: '5000000000', status: 'included', kind: 'reward' },
      { ...base, hash: '4d'.repeat(32), feeNano: '1000', status: 'unverified', kind: 'deploy' },
    ]);
  });
});

// Plan 2.5 / 2.7: a kept QNC proof stands by its macroblock (also for a worker woken from sleep: the session keeps it), the
// follow alarm keeps a verified checkpoint at the head while unlocked, and the genesis capsule is loaded, refused and
// forgotten as docs/protocols/galc-capsule-v2.md says. Today's nodes serve no capsule (405): every read goes on from the
// pin and the anchors exactly as before, each node asked for one at most once per TTL.
describe('chains-activation qnet: the follow and the capsule (GALC v2)', () => {
  const ownProofReads = (net) => net.requests.filter((r) => r.includes(`/api/v1/account/${ME}/balance/proof`)).length;
  const waitFor = async (ready) => {
    for (let i = 0; i < 200 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  };

  it('a follow tick walks toward the certified head and keeps what it verified, reading no balance; the alarm runs only while unlocked', async () => {
    const env = installEnv();
    const alarms = new Map();
    const cleared = [];
    globalThis.chrome = {
      alarms: {
        get: async (name) => alarms.get(name),
        create: async (name, info) => {
          alarms.set(name, { name, ...info });
        },
        clear: async (name) => {
          cleared.push(name);
          return alarms.delete(name);
        },
      },
    };
    try {
      const { route, net } = chain({ balance: '100000000000' });
      net.certify({ [ME]: { balance: '100000000000', nonce: '0' } });
      installFetch(route);
      await qnet.startFollow();
      await qnet.startFollow();
      assert.deepEqual([...alarms.values()], [{ name: 'qnet-follow', periodInMinutes: 0.5 }]);
      const tick = await qnet.followTick();
      assert.deepEqual(tick, { ok: true, head: FIRST_INDEX + 1, verified: true });
      assert.ok(env.anchorWrites >= 1, 'what the tick verified is kept');
      assert.equal(ownProofReads(net), 0, 'no balance read: the popup reads its own');
      const reads = net.requests.length;
      assert.deepEqual(await qnet.followTick(), { ok: true, head: FIRST_INDEX + 1, verified: true });
      assert.equal(net.requests.length, reads, 'nothing new: no walk');
      await qnet.onAlarm({ name: 'qnet-register' });
      assert.deepEqual(cleared, [], 'another module\'s alarm');
      env.locked = true;
      await qnet.onAlarm({ name: 'qnet-follow' });
      assert.deepEqual(cleared, ['qnet-follow'], 'a locked session stops the alarm');
      assert.deepEqual(await qnet.followTick(), { ok: false, reason: 'locked' });
    } finally {
      delete globalThis.chrome;
    }
  });

  it('a kept capsule that does not verify again is deleted, and the reads go on from the anchors', async () => {
    const env = installEnv();
    const { route } = chain({ balance: '100000000000' });
    env.capsule = {
      capsule: {
        version: 2, network_id: '00'.repeat(32), mb_index: FIRST_INDEX + 10, mb_hash: '01'.repeat(32), committee_digest_anchor: '02'.repeat(32),
        committee_digest_pred: '03'.repeat(32), minted_at_height: (FIRST_INDEX + 10) * 90, cp_hash_anchor: '04'.repeat(32), cp_hash_pred: '05'.repeat(32),
        sigs: [],
      },
      roots: {},
    };
    installFetch(route);
    assert.equal((await qnet.readAccount(ME)).verified, true);
    assert.equal(env.capsule, null);
    assert.equal(env.capsuleWrites, 1);
    assert.equal(core.heldCapsuleIndex(), 0);
  });

  it('no capsule route (405): a walk from the pin goes on as before, and each node is asked for a capsule at most once', async () => {
    installEnv();
    core.clearQcCache();
    core.clearCapsule();
    const index = core.trustFloorIndex() + 1000;
    const proofText = raw('chains-activation-proof-g1.json');
    const proof = JSON.parse(proofText);
    const lowProof = proofText.replace(`"block_height":${proof.block_height}`, `"block_height":${index * 90 + 5}`);
    const capsuleAsks = new Map();
    installFetch(nodeRoute(({ node, path: p }) => {
      if (p === '/api/v1/galc/capsule') {
        capsuleAsks.set(node, (capsuleAsks.get(node) ?? 0) + 1);
        return { status: 405, body: 'HTTP method not allowed' };
      }
      if (/^\/api\/v1\/macroblock\/[0-9]+\/proof$/.test(p)) return { status: 404, body: '{"error":"not found"}' };
      if (p.startsWith(`/api/v1/account/${G1}/balance/proof`)) return { body: lowProof };
      if (p === '/api/v1/state/certified') return { body: { proof_format: 2, views: [], newest_certified_index: index, capture: 'ok' } };
      return undefined;
    }));
    for (let i = 0; i < 3; i++) {
      const fresh = await worker(`noCapsule=${i}-${Date.now()}`);
      assert.equal((await fresh.readAccount(G1)).verification, 'none', 'the walk failed here (404): not verified');
    }
    assert.ok(capsuleAsks.size >= 1, 'a long walk asks for a capsule first');
    assert.ok([...capsuleAsks.values()].every((n) => n === 1), `at most one ask per node: ${[...capsuleAsks.values()]}`);
    assert.equal(core.heldCapsuleIndex(), 0);
    core.clearQcCache();
  });

  // decision 49: what a woken worker takes over (chrome.storage.session, qnet_light_hints_v1)
  const sessionStore = () => {
    const store = {};
    globalThis.chrome = {
      storage: {
        session: {
          get: async (key) => ({ [key]: structuredClone(store[key]) }),
          set: async (items) => {
            Object.assign(store, structuredClone(items));
          },
        },
      },
    };
    return store;
  };

  it('a woken worker takes over the head it saw: its first proof read asks for the macroblock it verified, no walk', async () => {
    const env = installEnv();
    const store = sessionStore();
    try {
      const { route, net } = chain({ balance: '5' });
      installFetch(route);
      assert.equal((await qnet.readAccount(ME)).index, FIRST_INDEX);
      await waitFor(() => store.qnet_light_hints_v1?.headSeen?.index === FIRST_INDEX);
      // the worker sleeps: its memory and the light client's go; the vault keeps the anchors, the session the head seen
      const anchors = env.anchors;
      net.install();
      env.anchors = anchors;
      net.requests.length = 0;
      const woken = await worker(`wokenHead=${Date.now()}`);
      const account = await woken.readAccount(ME);
      assert.deepEqual([account.index, account.verification], [FIRST_INDEX, 'proof']);
      const asked = net.requests.filter((r) => r.includes('/balance/proof'));
      assert.ok(asked[0].endsWith(`?mb=${FIRST_INDEX}`), asked.join(' '));
      assert.ok(!net.requests.some((r) => r.includes('/macroblock/')), 'no walk');
    } finally {
      delete globalThis.chrome;
    }
  });

  it('a refresh that found no capsule is not made again by the next worker within the TTL', async () => {
    installEnv();
    const store = sessionStore();
    core.clearQcCache();
    core.clearCapsule();
    const index = core.trustFloorIndex() + 1000;
    const proofText = raw('chains-activation-proof-g1.json');
    const proof = JSON.parse(proofText);
    const lowProof = proofText.replace(`"block_height":${proof.block_height}`, `"block_height":${index * 90 + 5}`);
    let capsuleAsks = 0;
    installFetch(nodeRoute(({ path: p }) => {
      if (p === '/api/v1/galc/capsule') {
        capsuleAsks += 1;
        return { status: 405, body: 'HTTP method not allowed' };
      }
      if (/^\/api\/v1\/macroblock\/[0-9]+\/proof$/.test(p)) return { status: 404, body: '{"error":"not found"}' };
      if (p.startsWith(`/api/v1/account/${G1}/balance/proof`)) return { body: lowProof };
      if (p === '/api/v1/state/certified') return { body: { proof_format: 2, views: [], newest_certified_index: index, capture: 'ok' } };
      return undefined;
    }));
    try {
      for (let i = 0; i < 3; i++) {
        core.clearCapsule(); // a new worker's light client: which nodes had none is forgotten with it
        const fresh = await worker(`quietCapsule=${i}-${Date.now()}`);
        const view = await fresh.readAccount(G1);
        assert.equal(view.verification, 'none');
        // a long walk is why: the view says how far it is
        assert.ok(Number.isSafeInteger(view.walkSteps) && view.walkSteps > 2, `${view.walkSteps}`);
      }
      const { toUiError } = await import('../dist/background/errors.js');
      assert.deepEqual(toUiError(new WalletError('BALANCE_UNCONFIRMED', { walkSteps: 7 })),
        { code: 'BALANCE_UNCONFIRMED', message: 'The balance is not confirmed yet', walkSteps: 7 });
      assert.equal(capsuleAsks, 3, 'the first worker asked three nodes; the next ones asked nobody');
      assert.ok(store.qnet_light_hints_v1.capsuleQuietUntil > Date.now());
    } finally {
      delete globalThis.chrome;
      core.clearQcCache();
    }
  });

  it('a walk of a few steps from the anchors asks for no capsule', async () => {
    installEnv();
    const { route, net } = chain({ balance: '100000000000' });
    const asked = [];
    installFetch(async (request) => {
      if (!request.url.includes('/api/v1/galc/capsule')) return route(request);
      asked.push(request.url);
      return { status: 405, body: '' };
    });
    assert.equal((await qnet.readAccount(ME)).verified, true);
    assert.deepEqual(asked, []);
    assert.ok(ownProofReads(net) >= 1);
  });

  it('sendWarm starts the certified head read and a typed recipient\'s checks, and the review finds them done beside its live read', async () => {
    installEnv();
    const { route, net } = chain({ balance: '100000000000' });
    const archiveReads = [];
    installFetch(routes(async (request) => {
      if (!request.url.startsWith(`${QNET.EXPLORER_API}/api/address/`)) return undefined;
      archiveReads.push(request.url);
      return { body: { success: true, address: ME, items: [], next_cursor: null } };
    }, route));
    const recipientReads = () => net.requests.filter((r) => r.includes(`/api/v1/account/${TO}/balance/proof`)).length;
    assert.deepEqual(await qnet.sendWarm({}), { started: true });
    assert.deepEqual(await qnet.sendWarm({ to: TO }), { started: true });
    await rejectsWith(qnet.sendWarm({ to: 'x' }), 'INVALID_ADDRESS');
    await waitFor(() => archiveReads.length > 0 && recipientReads() > 0);
    await flush(20);
    assert.ok(net.requests.some((r) => r.endsWith('/api/v1/state/certified')), 'the certified head');
    const before = [ownProofReads(net), recipientReads(), archiveReads.length];
    const preview = await qnet.preview({ to: TO, amount: '1' });
    assert.equal(preview.recipient.historyRead, true);
    assert.deepEqual([ownProofReads(net), recipientReads(), archiveReads.length], [before[0] + 1, before[1], before[2]],
      'the wallet\'s own live read only');
  });
});
