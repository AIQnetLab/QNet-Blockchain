// nodes.js, offline: the light node's registration on the QNet network after the burn (the record queued with the
// activation, one signed submit to one pinned node per attempt, the node's answers row by row, the hold after an
// admission, the chain's word ending it, the cap, an activation of an earlier build) and the move of the
// node balance (the balance two nodes agree on, the quote checks the app makes, the two signed steps). The nodes are
// simulated; every signature the wallet sends is verified here as the node verifies it.
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/chains-activation-loader.mjs', import.meta.url);

const core = await import('../dist/lib/qnet-core.js');
const { CLAIM_MIN_NANO, LIMITS, QNET, REGISTRATION_ALARM, TIMINGS } = await import('../dist/background/config.js');
const { WalletError } = await import('../dist/background/errors.js');
const { setViewBroadcaster } = await import('../dist/background/events.js');
const {
  WALLET, installEnv, installFetch, emptyState, fakeSignature, flush,
} = await import('./helpers/chains-activation-env.mjs');
const nodes = await import('../dist/background/nodes.js');
const activation = await import('../dist/background/activation.js');

const W = WALLET.qnetAddress;
const N = core.lightNodeId(W);
const PK_HEX = core.bytesToHex(WALLET.qnetPublicKey);
const BURN_TX = fakeSignature(7);
const utf8 = (text) => new TextEncoder().encode(text);

const viewEvents = [];
setViewBroadcaster((event) => viewEvents.push(event));

const lightActivation = (burner = WALLET.solanaAddress, burnTx = BURN_TX) => ({
  code: core.generateActivationCode('light', burner, burnTx, 1500), nodeType: 'light', burnTx, burnAmount: 1500,
  solanaAddress: burner, cluster: 'devnet', createdAt: 1,
});

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WalletError || error?.name === 'CoreError', `${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

// Each test runs at its own hour, so the module's lookup throttle of an earlier test never applies.
let hour = 0;
let alarms;
beforeEach(() => {
  hour += 1;
  mock.timers.enable({ apis: ['Date'], now: 1_790_000_000_000 + hour * 3_600_000 });
  viewEvents.length = 0;
  alarms = { set: new Set(), created: [], cleared: 0 };
  globalThis.chrome = {
    alarms: {
      get: async (name) => (alarms.set.has(name) ? { name } : undefined),
      create: async (name, info) => {
        alarms.set.add(name);
        alarms.created.push({ name, info });
      },
      clear: async (name) => {
        alarms.cleared += 1;
        return alarms.set.delete(name);
      },
    },
  };
});
afterEach(() => {
  mock.timers.reset();
  delete globalThis.chrome;
});

// A route answer, or no answer at all for an Error (a network failure).
function answered(answer) {
  if (answer instanceof Error) throw answer;
  return answer;
}

/**
 * The pinned nodes. status(nodeId, node) → onchain_registered (true/false), an answer object or an Error; submit(body,
 * node) → {status?, body} or an Error for no answer; claim(body, node) and pending(nodeId, node) for the node balance.
 */
function network({ status = () => false, submit = () => ({ body: { success: true, tx_hash: 'ab'.repeat(32) } }), claim, pending } = {}) {
  const seen = { status: [], submits: [], claims: [], pending: [] };
  const requests = installFetch(async (request) => {
    const url = new URL(request.url);
    if (!QNET.NODES.includes(url.origin)) return undefined;
    if (url.pathname === '/api/v1/light-node/status') {
      seen.status.push(url.origin);
      const answer = await status(url.searchParams.get('node_id'), url.origin);
      if (answer instanceof Error) throw answer;
      return { body: typeof answer === 'boolean' ? { success: true, onchain_registered: answer } : answer };
    }
    if (url.pathname === '/api/v1/node-registration/submit' && request.method === 'POST') {
      const body = JSON.parse(request.body);
      seen.submits.push({ node: url.origin, body, keys: Object.keys(body) });
      return answered(await submit(body, url.origin));
    }
    if (url.pathname === '/api/v1/rewards/claim' && request.method === 'POST') {
      const body = JSON.parse(request.body);
      seen.claims.push({ node: url.origin, body });
      return answered(await claim(body, url.origin));
    }
    if (url.pathname.startsWith('/api/v1/rewards/pending/')) {
      seen.pending.push(url.origin);
      return answered(await pending(url.pathname.split('/').pop(), url.origin));
    }
    return undefined;
  });
  return { seen, requests };
}

// What the node checks at submit (registration_api.rs): the fields in the app's order, the id and proof of this
// wallet and burn, the consent under the wallet key (ML-DSA-65, empty context) and the owner bind under the burner.
async function assertSubmitAsNodeChecks(body, { burner = WALLET.solanaAddress, burnTx = BURN_TX } = {}) {
  assert.deepEqual(Object.keys(body), ['from', 'node_id', 'node_type', 'wallet_address', 'registration_proof', 'timestamp',
    'burn_tx_hash', 'burn_amount', 'burn_wallet', 'dilithium_signature', 'dilithium_public_key', 'owner_signature']);
  assert.equal(body.from, W);
  assert.equal(body.wallet_address, W);
  assert.equal(body.node_id, N);
  assert.equal(body.node_type, 'light');
  assert.equal(body.burn_tx_hash, burnTx);
  assert.equal(body.burn_amount, 1500);
  assert.equal(body.burn_wallet, burner);
  assert.equal(body.registration_proof, core.registrationProof(burnTx, N, W));
  assert.ok(Math.abs(body.timestamp - Math.floor(Date.now() / 1000)) <= 1, 'a fresh timestamp');
  assert.equal(body.dilithium_public_key, PK_HEX);
  assert.equal(core.qnetAddressFromPublicKey(core.hexToBytes(body.dilithium_public_key)), W);
  const consent = core.consentPreimage(N, W, body.registration_proof, body.timestamp);
  assert.equal(await core.verifyConsensusSignature(consent, body.dilithium_signature, body.dilithium_public_key), true, 'consent');
  assert.equal(body.dilithium_signature.length, 3309 * 2);
  const ownerBind = core.ownerBindPreimage(N, W, body.registration_proof, body.timestamp, body.dilithium_public_key, burnTx);
  assert.equal(core.verifySolanaSignature(core.hexToBytes(body.owner_signature), utf8(ownerBind), core.solanaAddressToBytes(burner)), true,
    'owner bind');
}

const queuedState = (extra = {}) => {
  const act = lightActivation(extra.burner);
  return { ...emptyState(), activation: act, registration: { ...nodes.registrationFor(null, act, W, Date.now()), ...(extra.registration ?? {}) } };
};

describe('nodes: the registration record', () => {
  it('queues one for a light activation, none for a Super one, keeps it for the same burn, queues a stopped one on request', () => {
    const act = lightActivation();
    const queued = nodes.registrationFor(null, act, W, 5);
    assert.deepEqual(queued, {
      nodeId: N, burnTx: BURN_TX, burner: WALLET.solanaAddress, state: 'queued', attempts: 0, nextAt: 5, txHash: null,
      admittedAt: null, lastError: null, updatedAt: 5,
    });
    assert.equal(nodes.registrationFor(null, { ...act, nodeType: 'super' }, W, 5), null);
    assert.equal(nodes.registrationFor(null, null, W, 5), null);
    const admitted = { ...queued, state: 'admitted', attempts: 1, admittedAt: 6 };
    assert.equal(nodes.registrationFor(admitted, act, W, 9, { retry: true }), admitted, 'a running registration stays');
    for (const stopped of [{ ...queued, state: 'refused' }, { ...queued, state: 'clock' }, { ...queued, attempts: LIMITS.REGISTRATION_MAX_ATTEMPTS }]) {
      assert.equal(nodes.registrationFor(stopped, act, W, 9), stopped, 'not without a request');
      assert.deepEqual(nodes.registrationFor(stopped, act, W, 9, { retry: true }), { ...queued, nextAt: 9, updatedAt: 9 });
    }
    const onchain = { ...queued, state: 'onchain' };
    assert.equal(nodes.registrationFor(onchain, act, W, 9, { retry: true }), onchain);
  });

  it('shows what a page may: no burn, whether the wallet still tries on its own, and whether its next try is far off', () => {
    const queued = nodes.registrationFor(null, lightActivation(), W, 5);
    assert.deepEqual(nodes.publicRegistration(queued, 5), {
      nodeId: N, state: 'queued', attempts: 0, lastError: null, txHash: null, updatedAt: 5, automatic: true, deferred: false,
    });
    assert.equal(nodes.publicRegistration({ ...queued, attempts: LIMITS.REGISTRATION_MAX_ATTEMPTS }).automatic, false);
    assert.equal(nodes.publicRegistration({ ...queued, state: 'refused' }).automatic, false);
    assert.equal(nodes.publicRegistration(null), null);
    // EXT-R1-04: an admitted record is read on chain until its hold ends, past the attempt cap too
    const admitted = { ...queued, state: 'admitted', attempts: LIMITS.REGISTRATION_MAX_ATTEMPTS, admittedAt: 5 };
    assert.equal(nodes.publicRegistration(admitted, 5).automatic, true);
    // a retry further off than REGISTRATION_SOON_MS is deferred: the page offers Record on the network meanwhile
    const later = { ...queued, attempts: 6, nextAt: 5 + TIMINGS.REGISTRATION_SOON_MS + 1 };
    assert.deepEqual([nodes.publicRegistration(later, 5).automatic, nodes.publicRegistration(later, 5).deferred], [true, true]);
    assert.equal(nodes.publicRegistration({ ...later, nextAt: 5 + TIMINGS.REGISTRATION_SOON_MS }, 5).deferred, false);
    assert.equal(nodes.publicRegistration({ ...later, attempts: LIMITS.REGISTRATION_MAX_ATTEMPTS }, 5).deferred, false, 'stopped, not deferred');
  });
});

describe('nodes: recording the light node', () => {
  it('submits once to one pinned node what the node checks, holds after the admission, and ends when the chain lists it', async () => {
    const env = installEnv({ state: queuedState() });
    let listed = false;
    const net = network({ status: () => listed });
    const view = await nodes.resumeRegistration();
    assert.equal(net.seen.submits.length, 1, 'one submit, never hedged');
    assert.ok(QNET.NODES.includes(net.seen.submits[0].node));
    await assertSubmitAsNodeChecks(net.seen.submits[0].body);
    assert.equal(net.seen.status.length, 2, 'the chain is read from two nodes first');
    assert.deepEqual({ state: view.state, attempts: view.attempts, txHash: view.txHash, automatic: view.automatic },
      { state: 'admitted', attempts: 1, txHash: 'ab'.repeat(32), automatic: true });
    assert.equal(env.state().registration.nextAt, Date.now() + TIMINGS.REGISTRATION_ADMIT_CHECK_MS, 'the chain is read again soon');
    assert.deepEqual(viewEvents, ['activation']);
    assert.deepEqual([...alarms.set], [REGISTRATION_ALARM], 'the alarm runs while it waits');

    // within the hold: the chain is read at most every REGISTRATION_ADMIT_CHECK_MS, and nothing is sent again
    const reads = net.seen.status.length;
    await nodes.resumeRegistration();
    assert.equal(net.seen.status.length, reads, 'not before the next read is due');
    mock.timers.tick(TIMINGS.REGISTRATION_ADMIT_CHECK_MS);
    await nodes.resumeRegistration();
    assert.ok(net.seen.status.length > reads, 'read again within the hold');
    mock.timers.tick(TIMINGS.REGISTRATION_ADMIT_HOLD_MS - TIMINGS.REGISTRATION_ADMIT_CHECK_MS - 1000);
    await nodes.resumeRegistration();
    assert.equal(net.seen.submits.length, 1);
    assert.ok(env.state().registration.nextAt <= env.state().registration.admittedAt + TIMINGS.REGISTRATION_ADMIT_HOLD_MS);
    // the chain lists it: done, without a submit, and the alarm stops
    listed = true;
    mock.timers.tick(2000);
    const done = await nodes.resumeRegistration();
    assert.equal(done.state, 'onchain');
    assert.equal(net.seen.submits.length, 1);
    assert.equal(alarms.set.size, 0);
    assert.equal(env.calls.signNodeRegistration, 1);
  });

  // EXT-R1-02: one node's word never records the node; two nodes listing it do
  it('asks the chain first: two nodes listing it alike record it without a submit, one alone does not', async () => {
    let env = installEnv({ state: queuedState() });
    // one node behind: whichever two are asked first, two report "listed" alike before two report "not"
    let net = network({ status: (id, node) => node !== QNET.NODES[0] });
    const view = await nodes.resumeRegistration();
    assert.equal(view.state, 'onchain');
    assert.equal(net.seen.submits.length, 0);
    assert.equal(env.calls.signNodeRegistration, 0);
    // one node alone (a stale row, a block the others do not have): a submit, and the record is not on chain
    env = installEnv({ state: queuedState() });
    net = network({ status: (id, node) => node === QNET.NODES[0] });
    assert.equal((await nodes.resumeRegistration()).state, 'admitted');
    assert.equal(net.seen.submits.length, 1);
    assert.notEqual(env.state().registration.state, 'onchain');
  });

  // EXT-R1-02: "already registered" from the one node a submit went to is not enough either
  it('"already registered" from one node is recorded only once two nodes list the node; else it is tried again', async () => {
    const env = installEnv({ state: queuedState() });
    let listed = false;
    const net = network({ status: () => listed, submit: () => ({ body: { success: false, code: 'already_registered', error: 'Node already registered' } }) });
    const first = await nodes.resumeRegistration();
    assert.deepEqual([first.state, first.lastError, first.automatic], ['queued', 'already_registered', true]);
    assert.equal(env.state().registration.nextAt, Date.now() + TIMINGS.REGISTRATION_FIRST_RETRY_MS);
    listed = true;
    mock.timers.tick(TIMINGS.REGISTRATION_FIRST_RETRY_MS);
    assert.equal((await nodes.resumeRegistration()).state, 'onchain');
    assert.equal(net.seen.submits.length, 1, 'the chain was read first: no second submit');
  });

  // EXT-R1-02: a record on chain whose block a rollback took back is not stuck for good
  it('a record on chain is read again on request; two nodes no longer listing it queue it again from the start', async () => {
    const onchain = { state: 'onchain', attempts: 3, lastError: null };
    const env = installEnv({ state: queuedState({ registration: onchain }) });
    const started = [];
    const runs = [];
    activation.setRegistrationHook((options) => {
      started.push(options);
      const run = nodes.resumeRegistration(options);
      runs.push(run);
      return run;
    });
    let listed = true;
    let net = network({ status: () => listed });
    try {
      // the chain still lists it: nothing changes, nothing is submitted
      await nodes.requestRecord();
      assert.equal(env.state().registration.state, 'onchain');
      assert.equal(net.seen.submits.length, 0);
      // a confirmed site request asks again: the chain no longer lists it, so it is queued and submitted
      listed = false;
      await activation.activateForSite({ nodeType: 'light', expectedPrice: null });
      await flush();
      await Promise.all(runs);
      assert.deepEqual(started.at(-1), { recheck: true });
      assert.equal(net.seen.submits.length, 1);
      await assertSubmitAsNodeChecks(net.seen.submits[0].body);
      assert.deepEqual([env.state().registration.state, env.state().registration.attempts], ['admitted', 1]);
      // unknown (no two nodes agree): kept on chain, never queued on one node's word
      env.setState(queuedState({ registration: onchain }));
      net = network({ status: (id, node) => (node === QNET.NODES[0] ? false : new TypeError('offline')) });
      await nodes.requestRecord();
      assert.equal(env.state().registration.state, 'onchain');
      assert.equal(net.seen.submits.length, 0);
    } finally {
      activation.setRegistrationHook(null);
    }
  });

  it('a record aiqnet.io paid for stays on chain: it has no owner bind here to submit again', async () => {
    const PAYMENT_KEY = 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR';
    const paid = { ...lightActivation(PAYMENT_KEY), code: core.walletActivationCode(W, BURN_TX, 1500) };
    const env = installEnv({
      state: { ...emptyState(), activation: paid, registration: { ...nodes.registrationFor(null, paid, W, Date.now()), state: 'onchain' } },
    });
    const net = network({ status: () => false });
    await nodes.requestRecord();
    assert.equal(env.state().registration.state, 'onchain');
    assert.equal(net.seen.status.length + net.seen.submits.length, 0);
  });

  const retries = [
    ['node is behind the chain; retry shortly', 'behind_chain'],
    ['burn-attestation committee unavailable (node syncing); retry shortly', 'committee_unavailable'],
    ['burn-attestation quorum not yet reached; retry shortly', 'quorum_pending'],
    ['Failed to add TX to mempool (duplicate or mempool full)', 'mempool_rejected'],
    ['Rate limit exceeded', 'rate_limited'],
    ['owner bind without a time is not accepted by the network yet; retry once nodes list owner_bind_v2', 'bind_v2_pending'],
  ];
  for (const [text, code] of retries) {
    it(`retries after "${text}"`, async () => {
      const env = installEnv({ state: queuedState() });
      network({ submit: () => ({ body: { success: false, error: text } }) });
      const view = await nodes.resumeRegistration();
      assert.deepEqual([view.state, view.attempts, view.lastError, view.automatic], ['queued', 1, code, true]);
      assert.equal(env.state().registration.nextAt, Date.now() + 15_000);
    });
  }

  // H-4: an owner bind without a time before the network takes that form is a retry by its code alone, never a refusal
  it('retries after the code bind_v2_pending with no text, and keeps trying on its own', async () => {
    const env = installEnv({ state: queuedState() });
    network({ submit: () => ({ body: { success: false, code: 'bind_v2_pending', error: '' } }) });
    const view = await nodes.resumeRegistration();
    assert.deepEqual([view.state, view.attempts, view.lastError, view.automatic], ['queued', 1, 'bind_v2_pending', true]);
    assert.equal(env.state().registration.nextAt, Date.now() + 15_000);
  });

  it('retries without an answer and backs off 15 s, 30 s, 60 s, then doubling minutes up to 6 h, then stops at the cap', async () => {
    const env = installEnv({ state: queuedState() });
    const net = network({ submit: () => new TypeError('offline') });
    const delays = [];
    for (let attempt = 1; attempt <= LIMITS.REGISTRATION_MAX_ATTEMPTS; attempt += 1) {
      const before = Date.now();
      const view = await nodes.resumeRegistration();
      assert.equal(view.lastError, 'network');
      delays.push(env.state().registration.nextAt - before);
      mock.timers.tick(env.state().registration.nextAt - before);
    }
    assert.deepEqual(delays.slice(0, 5), [15_000, 30_000, 60_000, 120_000, 240_000]);
    assert.ok(delays.every((d) => d <= TIMINGS.REGISTRATION_BACKOFF_MAX_MS));
    assert.equal(net.seen.submits.length, LIMITS.REGISTRATION_MAX_ATTEMPTS);
    const capped = await nodes.resumeRegistration();
    assert.equal(capped.automatic, false, 'past the cap only Record on the network tries again');
    assert.equal(net.seen.submits.length, LIMITS.REGISTRATION_MAX_ATTEMPTS);
    assert.equal(alarms.set.size, 0);
    // the user asks (no password: the unlocked session, decision 33): one attempt at once
    const manual = await nodes.requestRecord();
    assert.equal(env.calls.verifyPassword, 0);
    assert.equal(manual.registration.attempts, 1);
    assert.equal(net.seen.submits.length, LIMITS.REGISTRATION_MAX_ATTEMPTS + 1);
  });

  // EXT-R1-04 (a): an admission on the last automatic attempt used to leave the record admitted and not automatic, so
  // the chain was never read again and the popup said "Not recorded" after the block took it
  it('admitted on the last automatic attempt: the chain is still read, and a hold without a block stops it', async () => {
    const last = { attempts: LIMITS.REGISTRATION_MAX_ATTEMPTS - 1 };
    installEnv({ state: queuedState({ registration: last }) });
    let listed = false;
    let net = network({ status: () => listed });
    const view = await nodes.resumeRegistration();
    assert.deepEqual([view.state, view.attempts, view.automatic], ['admitted', LIMITS.REGISTRATION_MAX_ATTEMPTS, true]);
    assert.deepEqual([...alarms.set], [REGISTRATION_ALARM]);
    mock.timers.tick(TIMINGS.REGISTRATION_ADMIT_CHECK_MS);
    listed = true;
    assert.equal((await nodes.resumeRegistration()).state, 'onchain', 'the block took it: recorded');
    assert.equal(net.seen.submits.length, 1);

    // no block within the hold: no submit past the cap, and Record on the network is offered
    installEnv({ state: queuedState({ registration: last }) });
    listed = false;
    net = network({ status: () => listed });
    await nodes.resumeRegistration();
    mock.timers.tick(TIMINGS.REGISTRATION_ADMIT_HOLD_MS);
    const stopped = await nodes.resumeRegistration();
    assert.deepEqual([stopped.state, stopped.automatic, stopped.lastError], ['queued', false, 'not_in_block']);
    assert.equal(net.seen.submits.length, 1);
    assert.equal(alarms.set.size, 0);
    mock.timers.tick(3_600_000);
    await nodes.resumeRegistration();
    assert.equal(net.seen.submits.length, 1, 'stopped until the user asks');
    const manual = await nodes.requestRecord();
    assert.deepEqual([manual.registration.state, manual.registration.attempts], ['admitted', 1]);
    assert.equal(net.seen.submits.length, 2);
  });

  it('stops on the clock and on a refusal; only the user tries again, with a new timestamp', async () => {
    const env = installEnv({ state: queuedState() });
    let answer = { body: { success: false, error: 'Request timestamp too old or too far in future (max 5 min)' } };
    let listed = false;
    const net = network({ submit: () => answer, status: () => listed });
    assert.equal((await nodes.resumeRegistration()).state, 'clock');
    mock.timers.tick(3_600_000);
    await nodes.resumeRegistration();
    assert.equal(net.seen.submits.length, 1, 'the clock stops the automatic attempts');
    answer = { body: { success: false, error: 'owner_signature invalid — not the burning wallet\'s owner' } };
    const refused = await nodes.requestRecord();
    assert.deepEqual([refused.registration.state, refused.registration.lastError], ['refused', 'refused']);
    assert.notEqual(net.seen.submits[1].body.timestamp, net.seen.submits[0].body.timestamp, 'every attempt signs afresh');
    await nodes.resumeRegistration();
    assert.equal(net.seen.submits.length, 2);
    // an HTTP refusal is one too; the stable code wins over the text
    answer = { status: 400, body: 'bad json' };
    assert.equal((await nodes.requestRecord()).registration.lastError, 'http_400');
    answer = { body: { success: false, code: 'quorum_pending', error: 'anything' } };
    assert.equal((await nodes.requestRecord()).registration.state, 'queued');
    // "already registered" ends it once two nodes list the node (EXT-R1-02)
    answer = { body: { success: false, error: 'Node already registered', node_id: N } };
    assert.equal((await nodes.requestRecord()).registration.lastError, 'already_registered');
    listed = true;
    assert.equal((await nodes.requestRecord()).registration.state, 'onchain', '"already registered" ends it');
    assert.equal(env.state().registration.state, 'onchain');
  });

  // Decision 36: the network's one-node rule (this wallet has a node of either type already) is a refusal for good: never
  // "on chain", never an automatic retry, by its stable code or by its text from a node that sends none.
  it('the one-node rule refusal stops the record for good: refused with wallet_has_node, never onchain, never retried', async () => {
    for (const answer of [
      { body: { success: false, code: 'wallet_has_node', error: 'This wallet already has a node on the QNet network: one wallet, one node', node_id: N } },
      { body: { success: false, error: 'This wallet already has a node on the QNet network: one wallet, one node' } },
    ]) {
      const env = installEnv({ state: queuedState() });
      const net = network({ submit: () => answer, status: () => false });
      const record = await nodes.resumeRegistration();
      assert.deepEqual([record.state, record.lastError, record.automatic], ['refused', 'wallet_has_node', false], JSON.stringify(answer.body));
      assert.equal(env.state().registration.state, 'refused');
      mock.timers.tick(6 * 3_600_000);
      await nodes.resumeRegistration();
      assert.equal(net.seen.submits.length, 1, 'never tried again on its own');
    }
  });

  it('does nothing while locked, and resumes where it stopped after the unlock', async () => {
    const env = installEnv({ state: queuedState(), locked: true });
    const net = network();
    alarms.set.add(REGISTRATION_ALARM);
    assert.equal(await nodes.resumeRegistration(), null);
    assert.equal(alarms.set.size, 0, 'no alarm wakes the worker while locked: the unlock resumes it');
    await rejectsWith(nodes.requestRecord(), 'LOCKED');
    assert.equal(net.requests.length, 0);
    env.locked = false;
    assert.equal((await nodes.resumeRegistration()).state, 'admitted');
    assert.deepEqual([...alarms.set], [REGISTRATION_ALARM]);
  });

  it('waits for the next attempt when it is not due, and runs one attempt at a time', async () => {
    const env = installEnv({ state: queuedState({ registration: { attempts: 2, nextAt: Date.now() + 60_000 } }) });
    const net = network();
    await nodes.resumeRegistration();
    assert.equal(net.requests.length, 0);
    assert.equal(env.calls.signNodeRegistration, 0);
    mock.timers.tick(60_000);
    const both = await Promise.all([nodes.resumeRegistration(), nodes.resumeRegistration()]);
    assert.equal(net.seen.submits.length, 1, 'a resume asked while one waits is that one');
    assert.equal(both[0].state, 'admitted');
  });

  it('an activation of an earlier build: looked up on chain (at most every 10 minutes), submitted only on request', async () => {
    const env = installEnv({ state: { ...emptyState(), activation: lightActivation() } });
    let listed = false;
    const net = network({ status: () => listed });
    assert.equal(await nodes.resumeRegistration(), null);
    assert.equal(net.seen.status.length, 2);
    assert.equal(env.state().registration, null, 'never registered silently');
    assert.equal(net.seen.submits.length, 0);
    await nodes.resumeRegistration();
    assert.equal(net.seen.status.length, 2, 'the lookup is throttled');
    mock.timers.tick(TIMINGS.REGISTRATION_CHECK_MS);
    listed = true;
    assert.equal((await nodes.resumeRegistration()).state, 'onchain');
    assert.equal(env.state().registration.state, 'onchain');
    assert.equal(net.seen.submits.length, 0);

    // not listed: Record on the network queues it and submits
    const other = installEnv({ state: { ...emptyState(), activation: lightActivation() } });
    listed = false;
    const record = await nodes.requestRecord();
    assert.equal(record.registration.state, 'admitted');
    assert.equal(other.state().registration.attempts, 1);
  });

  it('refuses Record on the network without a light activation', async () => {
    installEnv({ state: emptyState() });
    const net = network();
    await rejectsWith(nodes.requestRecord(), 'NOT_FOUND');
    const superAct = { ...lightActivation(), nodeType: 'super', code: core.generateActivationCode('super', WALLET.solanaAddress, BURN_TX, 1500) };
    installEnv({ state: { ...emptyState(), activation: superAct } });
    await rejectsWith(nodes.requestRecord(), 'NOT_FOUND');
    assert.equal(await nodes.resumeRegistration(), null);
    assert.equal(net.requests.length, 0);
  });

  it('activation.registration answers the view and starts a due step in the background; the alarm resumes it', async () => {
    const env = installEnv({ state: queuedState() });
    const net = network();
    const { registration } = await nodes.getRegistration();
    assert.equal(registration.state, 'queued');
    await nodes.resumeRegistration();
    assert.equal(net.seen.submits.length, 1);
    await nodes.onAlarm({ name: 'qnet-auto-lock' });
    assert.equal(net.seen.submits.length, 1, 'not its alarm');
    env.setState(queuedState());
    await nodes.onAlarm({ name: REGISTRATION_ALARM });
    assert.equal(net.seen.submits.length, 2);
  });
});

// EXT-R2A-03: two nodes listing the light node say that some registration holds it, not whose burn it names; the signed
// status (POST, signer "wallet") names the burn, so a registration of another burn (aiqnet.io's payment key, say) is
// never shown as this burn's record.
describe('nodes: whose burn the registration on chain names (EXT-R2A-03)', () => {
  const OTHER_BURN = fakeSignature(9);
  // The public status (GET, with `features`) lists the node; the signed one (POST: no node_id in the query) names `burn`,
  // refuses (null) or is not served at all (an Error).
  const listedWith = (burn, { listed = () => true, features = ['status_signed'] } = {}) => (id) => {
    if (id !== null) return { success: true, onchain_registered: listed(), registration_pending: false, features };
    if (burn instanceof Error) return burn;
    return burn === null ? { error: 'rate_limited' } : { node_id: N, onchain_registered: true, burn_tx: burn };
  };

  it('a registration of another burn is other_burn: no submit, not automatic, and Record on the network changes nothing', async () => {
    const env = installEnv({ state: queuedState() });
    const net = network({ status: listedWith(OTHER_BURN) });
    const view = await nodes.resumeRegistration();
    assert.deepEqual([view.state, view.automatic, view.deferred], ['other_burn', false, false]);
    assert.equal(net.seen.submits.length, 0, 'the chain was read first');
    assert.ok(env.calls.signNodeStatus >= 1, 'the signed status was read with the wallet key');
    assert.equal(alarms.set.has(REGISTRATION_ALARM), false, 'no automatic attempt waits');
    assert.equal(viewEvents.includes('activation'), true);
    // a retry request does not queue it again; Record on the network reads the chain and keeps it
    const { registration, activation: act } = env.state();
    assert.equal(nodes.registrationFor(registration, act, W, Date.now(), { retry: true }), registration);
    assert.equal((await nodes.requestRecord()).registration.state, 'other_burn');
    assert.equal(net.seen.submits.length, 0);
  });

  it('the registration of this burn is onchain; one of this burn that the signed status cannot name yet is read again, never submitted', async () => {
    let env = installEnv({ state: queuedState() });
    network({ status: listedWith(BURN_TX) });
    assert.equal((await nodes.resumeRegistration()).state, 'onchain');

    env = installEnv({ state: queuedState() });
    let burn = null;
    const net = network({ status: (id) => listedWith(burn)(id) });
    const first = await nodes.resumeRegistration();
    assert.deepEqual([first.state, first.lastError, first.attempts, first.automatic], ['queued', 'burn_unknown', 1, true]);
    assert.equal(env.state().registration.nextAt, Date.now() + TIMINGS.REGISTRATION_FIRST_RETRY_MS);
    assert.equal(net.seen.submits.length, 0, 'the node is listed: a submit would be refused');
    burn = OTHER_BURN;
    mock.timers.tick(TIMINGS.REGISTRATION_FIRST_RETRY_MS);
    assert.equal((await nodes.resumeRegistration()).state, 'other_burn');
    assert.equal(net.seen.submits.length, 0);

    // a network that serves no signed status (two nodes list no status_signed): the listing is all there is to go by
    installEnv({ state: queuedState() });
    network({ status: listedWith(new TypeError('no such route'), { features: ['uptime'] }) });
    assert.equal((await nodes.resumeRegistration()).state, 'onchain');
  });

  it('"already registered" with another burn\'s registration on chain is other_burn after the one submit', async () => {
    const env = installEnv({ state: queuedState() });
    let listed = false;
    const net = network({
      status: listedWith(OTHER_BURN, { listed: () => listed }),
      submit: () => {
        listed = true;
        return { body: { success: false, code: 'already_registered', error: 'Node already registered' } };
      },
    });
    const view = await nodes.resumeRegistration();
    assert.deepEqual([view.state, view.attempts], ['other_burn', 1]);
    assert.equal(net.seen.submits.length, 1);
    assert.equal(env.state().registration.lastError, null);
  });

  it('an activation of an earlier build the chain lists with another burn is recorded as other_burn', async () => {
    const env = installEnv({ state: { ...emptyState(), activation: lightActivation() } });
    const net = network({ status: listedWith(OTHER_BURN) });
    assert.equal((await nodes.resumeRegistration()).state, 'other_burn');
    assert.equal(env.state().registration.burnTx, BURN_TX, 'the record keeps this activation\'s burn');
    assert.equal(net.seen.submits.length, 0);
    // whose burn not known yet: no record, looked up again later
    const later = installEnv({ state: { ...emptyState(), activation: lightActivation() } });
    network({ status: listedWith(null) });
    mock.timers.tick(TIMINGS.REGISTRATION_CHECK_MS);
    assert.equal(await nodes.resumeRegistration(), null);
    assert.equal(later.state().registration, null);
  });

  it('other_burn whose node two nodes no longer list is queued again from the start, on a confirmed site request too', async () => {
    const env = installEnv({ state: queuedState({ registration: { state: 'other_burn', attempts: 1, lastError: null } }) });
    const started = [];
    const runs = [];
    activation.setRegistrationHook((options) => {
      started.push(options);
      const run = nodes.resumeRegistration(options);
      runs.push(run);
      return run;
    });
    let listed = true;
    const net = network({ status: listedWith(OTHER_BURN, { listed: () => listed }) });
    try {
      listed = false;
      await activation.activateForSite({ nodeType: 'light', expectedPrice: null });
      await flush();
      await Promise.all(runs);
      assert.deepEqual(started.at(-1), { recheck: true });
      assert.equal(net.seen.submits.length, 1);
      await assertSubmitAsNodeChecks(net.seen.submits[0].body);
      assert.deepEqual([env.state().registration.state, env.state().registration.attempts], ['admitted', 1]);
    } finally {
      activation.setRegistrationHook(null);
    }
  });
});

describe('nodes: activation.js queues the registration with the activation', () => {
  it('a confirmed site request for a light activation not recorded yet queues it and starts it', async () => {
    const env = installEnv({ state: { ...emptyState(), activation: lightActivation() } });
    const started = [];
    activation.setRegistrationHook(() => started.push(1));
    try {
      const outcome = await activation.activateForSite({ nodeType: 'light', expectedPrice: null });
      assert.equal(outcome.status, 'exists');
      assert.equal(env.state().registration.state, 'queued');
      assert.equal(env.state().registration.nodeId, N);
      await flush();
      assert.deepEqual(started, [1]);
      const status = await activation.getStatus();
      assert.equal(status.registration.state, 'queued');
      // a refused one is queued again by the next confirmed request
      env.setState({ ...env.state(), registration: { ...env.state().registration, state: 'refused' } });
      await activation.activateForSite({ nodeType: 'light', expectedPrice: null });
      assert.equal(env.state().registration.state, 'queued');
    } finally {
      activation.setRegistrationHook(null);
    }
  });
});

// ---------------------------------------------------------------- the node balance

const quoteOf = ({ epochs = [5, 6], amounts = [1_500_000_000, 1_000_000_000], watermark = 4, ts = 1_790_000_000, amountNano, signMessage, stopped = null } = {}) => {
  const claimsData = JSON.stringify({ claims: epochs.map((epoch, i) => ({ epoch, amount: amounts[i], proof: [['ab'.repeat(32), 0]] })) });
  return {
    success: false, needs_signature: true, claims_data: claimsData,
    sign_message: signMessage ?? core.claimPayloadPreimage(W, ts, claimsData), claim_timestamp: ts, epochs_claimed: epochs.length,
    amount_nano: amountNano ?? String(amounts.reduce((a, b) => a + b, 0)), last_claimed_epoch: watermark,
    stopped_at_epoch: stopped, stopped_reason: stopped === null ? null : 'batch_full',
  };
};

function claimNetwork({ quote = quoteOf(), head = 5, balance = 2_500_000_000, listed = true, submitted, step1 } = {}) {
  return network({
    status: () => listed,
    pending: (id) => ({ body: { node_id: id, pending_rewards_nano: balance, first_unclaimed_epoch: head } }),
    claim: (body) => {
      if (body.claims_data === undefined) return { body: step1 ?? quote };
      return { body: submitted ?? { success: true, tx_hash: 'cd'.repeat(32), amount_qnc: 2.5 } };
    },
  });
}

describe('nodes: the node balance', () => {
  it('the view: the balance two pinned nodes agree on, empty below 1 QNC, NO_NODE off chain, NETWORK unknown', async () => {
    installEnv();
    claimNetwork();
    assert.deepEqual(await nodes.claimView(), { mode: 'claim', reason: null, nodeId: N, amountNano: '2500000000' });
    claimNetwork({ balance: 999_999_999 });
    assert.deepEqual(await nodes.claimView(), { mode: 'empty', reason: null, nodeId: N, amountNano: '999999999' });
    claimNetwork({ listed: false });
    assert.deepEqual(await nodes.claimView(), { mode: 'unavailable', reason: 'NO_NODE', nodeId: N, amountNano: null });
    network({ status: () => new TypeError('offline') });
    assert.equal((await nodes.claimView()).reason, 'NETWORK');
    // two nodes that disagree: a third settles it
    let n = 0;
    network({ status: () => true, pending: (id) => ({ body: { node_id: id, pending_rewards_nano: [1, 2, 2, 2, 2][n++], first_unclaimed_epoch: 5 } }) });
    assert.equal((await nodes.claimView()).amountNano, '2');
    assert.equal(BigInt(CLAIM_MIN_NANO), 1_000_000_000n);
  });

  it('moves the quoted batch: the quote signed over claim_rewards, the payload over the message the wallet builds', async () => {
    installEnv();
    const net = claimNetwork({ quote: quoteOf({ stopped: 7 }) });
    const outcome = await nodes.claimForSite();
    assert.deepEqual(outcome, {
      status: 'ok', qnet: W, nodeId: N, amountNano: '2500000000', txHash: 'cd'.repeat(32), stoppedAtEpoch: '7',
    });
    const [first, corroborating, second] = net.seen.claims;
    assert.equal(second.node, first.node, 'the payload goes back to the node that quoted it');
    // EXT-R3-01: a part of the balance is quoted by a second node with the same request, never signed twice
    assert.notEqual(corroborating.node, first.node);
    assert.deepEqual(corroborating.body, first.body);
    assert.equal(net.seen.claims.length, 3);
    assert.deepEqual(Object.keys(first.body), ['node_id', 'wallet_address', 'dilithium_signature', 'dilithium_public_key']);
    assert.equal(await core.verifyConsensusSignature(core.claimQuotePreimage(N, W), first.body.dilithium_signature, PK_HEX), true);
    const quote = quoteOf({ stopped: 7 });
    assert.equal(second.body.claims_data, quote.claims_data, 'the exact bytes quoted');
    assert.equal(second.body.claim_timestamp, quote.claim_timestamp);
    assert.equal(await core.verifyConsensusSignature(core.claimPayloadPreimage(W, quote.claim_timestamp, quote.claims_data),
      second.body.claims_signature, second.body.dilithium_public_key), true);
    assert.ok(net.seen.pending.every((node) => node !== first.node), 'the head from other nodes than the quoting one');
  });

  const refusals = [
    ['a batch that is not strictly ascending', { quote: quoteOf({ epochs: [6, 5] }) }],
    ['a batch at or below the watermark', { quote: quoteOf({ epochs: [4, 5], watermark: 4 }), head: 4 }],
    ['a skipped head', { head: 4 }],
    ['a total that is not the sum', { quote: quoteOf({ amountNano: '9' }) }],
    ['a zero total', { quote: quoteOf({ amounts: [0, 0], amountNano: '0' }) }],
    ['another sign message', { quote: quoteOf({ signMessage: 'q1337|transfer:x' }) }],
    ['no timestamp', { quote: { ...quoteOf(), claim_timestamp: 0 } }],
    ['a full batch below 1 QNC', { quote: quoteOf({ epochs: [5], amounts: [5], amountNano: '5' }), balance: 5 }],
    // EXT-R2-01: a part of the balance moves below 1 QNC, but never nothing
    ['a part of zero', { quote: quoteOf({ amounts: [0, 0], amountNano: '0', stopped: 7 }) }],
    ['a part whose total is not the sum', { quote: quoteOf({ epochs: [5], amounts: [5], amountNano: '6', stopped: 6 }) }],
    ['a part that says it stopped at or below its last epoch', { quote: quoteOf({ stopped: 6 }) }],
    ['a part below 1 QNC that says it stopped at or below its last epoch', { quote: quoteOf({ epochs: [5], amounts: [5], stopped: 5 }) }],
    // EXT-R1-06: a full batch below the balance two other nodes report alike skipped an epoch the wallet holds a leaf in
    ['a full batch that skips epochs the balance counts', { quote: quoteOf({ epochs: [5, 10] }), balance: 4_500_000_000 }],
  ];
  for (const [what, options] of refusals) {
    it(`refuses to sign ${what}`, async () => {
      const env = installEnv();
      const net = claimNetwork(options);
      await rejectsWith(nodes.claimForSite(), 'CLAIM_REFUSED');
      assert.equal(net.seen.claims.length, 1, 'no payload is signed or sent');
      assert.equal(env.calls.signClaimPayload, 0);
    });
  }

  // EXT-R1-06: the full batch's total against the balance other nodes agree on; a part is not held to it
  it('a full batch must reach the balance two other nodes report alike; a part of the balance moves below it', async () => {
    let env = installEnv();
    claimNetwork({ balance: 2_000_000_000 });
    assert.equal((await nodes.claimForSite()).status, 'ok', 'the balance may under-report the quote');
    env = installEnv();
    const part = claimNetwork({ quote: quoteOf({ stopped: 7 }), balance: 9_000_000_000 });
    assert.equal((await nodes.claimForSite()).stoppedAtEpoch, '7');
    assert.ok(part.seen.pending.length >= 1);
    // no two other nodes report the same balance: no check, nothing signed
    env = installEnv();
    let n = 0;
    network({
      status: () => true,
      claim: (body) => ({ body: body.claims_data === undefined ? quoteOf() : { success: true, tx_hash: 'cd'.repeat(32) } }),
      pending: (id) => ({ body: { node_id: id, pending_rewards_nano: 2_000_000_000 + (n++), first_unclaimed_epoch: 5 } }),
    });
    await rejectsWith(nodes.claimForSite(), 'NETWORK');
    assert.equal(env.calls.signClaimPayload, 0);
  });

  // EXT-R2-01 (owner decision of 2026-09-27 on EXT-R1-03): the node caps a quote by size, so with small epochs a quote
  // can hold less than 1 QNC while the balance holds more; that part moves, and the rest moves in the next claims
  it('a part of the balance below 1 QNC is signed and moved; the whole balance moves in several claims', async () => {
    const env = installEnv();
    const small = { epochs: [5, 6, 7], amounts: [10_000_000, 10_000_000, 10_000_000], stopped: 8 };
    const net = claimNetwork({ quote: quoteOf(small), balance: 3_000_000_000 });
    assert.deepEqual(await nodes.claimForSite(), {
      status: 'ok', qnet: W, nodeId: N, amountNano: '30000000', txHash: 'cd'.repeat(32), stoppedAtEpoch: '8',
    });
    assert.equal(env.calls.signClaimPayload, 1);
    const second = net.seen.claims.find((c) => c.body.claims_data !== undefined);
    assert.equal(second.body.claims_data, quoteOf(small).claims_data, 'the exact bytes quoted');
    // one epoch of one nano, as a part, is a move too
    installEnv();
    claimNetwork({ quote: quoteOf({ epochs: [5], amounts: [1], stopped: 6 }), balance: 3_000_000_000 });
    assert.equal((await nodes.claimForSite()).amountNano, '1');
    // the same amounts without a stop epoch are a full batch below 1 QNC: refused, nothing signed
    const full = installEnv();
    claimNetwork({ quote: quoteOf({ ...small, stopped: null }), balance: 30_000_000 });
    await rejectsWith(nodes.claimForSite(), 'CLAIM_REFUSED');
    assert.equal(full.calls.signClaimPayload, 0);
  });

  // EXT-R1-07: "This node cannot serve epoch N — retry on another node" is no refusal of the move
  it('a node that cannot serve an epoch hands the quote to the next pinned node; none able is a refusal', async () => {
    const cannot = { success: false, epochs_claimed: 0, stopped_at_epoch: 5, stopped_reason: 'root_not_here',
      error: 'This node cannot serve epoch 5 (root_not_here) — retry on another node' };
    const serving = QNET.NODES[4];
    let env = installEnv();
    let net = network({
      status: () => true,
      pending: (id) => ({ body: { node_id: id, pending_rewards_nano: 2_500_000_000, first_unclaimed_epoch: 5 } }),
      claim: (body, node) => {
        if (body.claims_data !== undefined) return { body: { success: true, tx_hash: 'cd'.repeat(32) } };
        return { body: node === serving ? quoteOf() : cannot };
      },
    });
    assert.equal((await nodes.claimForSite()).status, 'ok');
    const quoted = net.seen.claims.filter((c) => c.body.claims_data === undefined);
    assert.equal(quoted.at(-1).node, serving);
    assert.equal(new Set(quoted.map((c) => c.node)).size, quoted.length, 'no node is asked twice');
    assert.equal(net.seen.claims.find((c) => c.body.claims_data !== undefined).node, serving, 'the payload goes to the node that quoted');
    assert.ok(net.seen.pending.every((node) => node !== serving));
    env = installEnv();
    net = network({ status: () => true, claim: () => ({ body: cannot }) });
    await rejectsWith(nodes.claimForSite(), 'CLAIM_REFUSED');
    assert.equal(net.seen.claims.length, QNET.NODES.length, 'every pinned node was asked once');
    assert.equal(env.calls.signClaimPayload, 0);
  });

  // EXT-R3-01: a part of the balance is not held to the pending total, so a quoting node could leave out epochs between
  // its first and last one and the claim would move the watermark over them for good. A second node's quote of the same
  // request must list exactly the same epochs and amounts up to the lower last epoch of the two; that lower one is signed.
  describe('a part of the balance is held to a second node\'s quote (EXT-R3-01)', () => {
    const E = 1_000_000_000;
    const honestPart = () => quoteOf({ epochs: [5, 6, 7, 8, 9], amounts: [E, E, E, E, E], stopped: 10 });
    const gapped = () => quoteOf({ epochs: [5, 9], amounts: [E, E], stopped: 10 });
    // `firstQuote` answers the first node asked for a quote, `otherQuote(node)` every other one
    function twoQuotes({ firstQuote, otherQuote, head = 5 }) {
      let quoting = null;
      const net = network({
        status: () => true,
        pending: (id) => ({ body: { node_id: id, pending_rewards_nano: 9 * E, first_unclaimed_epoch: head } }),
        claim: (body, node) => {
          if (body.claims_data !== undefined) return { body: { success: true, tx_hash: 'cd'.repeat(32) } };
          quoting ??= node;
          return node === quoting ? { body: firstQuote } : answered(otherQuote(node));
        },
      });
      return { net, quoting: () => quoting };
    }
    const step1 = (net) => net.seen.claims.filter((c) => c.body.claims_data === undefined);
    const step2 = (net) => net.seen.claims.filter((c) => c.body.claims_data !== undefined);

    it('the finding\'s case: a part that leaves out epochs 6 to 8 is refused, nothing signed', async () => {
      const env = installEnv();
      const { net, quoting } = twoQuotes({ firstQuote: gapped(), otherQuote: () => ({ body: honestPart() }) });
      await rejectsWith(nodes.claimForSite(), 'CLAIM_REFUSED');
      assert.equal(step1(net).length, 2);
      assert.notEqual(step1(net)[1].node, quoting(), 'the second quote comes from another node');
      assert.equal(step2(net).length, 0);
      assert.equal(env.calls.signClaimPayload, 0);
      // the same against a second node that quotes the whole balance, and one that stops later
      for (const other of [quoteOf({ epochs: [5, 6, 7, 8, 9, 10], amounts: [E, E, E, E, E, E] }),
        quoteOf({ epochs: [5, 6, 7, 8, 9, 10], amounts: [E, E, E, E, E, E], stopped: 11 })]) {
        const again = installEnv();
        twoQuotes({ firstQuote: gapped(), otherQuote: () => ({ body: other }) });
        await rejectsWith(nodes.claimForSite(), 'CLAIM_REFUSED');
        assert.equal(again.calls.signClaimPayload, 0);
      }
    });

    it('a second quote with the gap is refused too, whichever node quotes first', async () => {
      const env = installEnv();
      twoQuotes({ firstQuote: honestPart(), otherQuote: () => ({ body: gapped() }) });
      await rejectsWith(nodes.claimForSite(), 'CLAIM_REFUSED');
      assert.equal(env.calls.signClaimPayload, 0);
    });

    it('a second node that stops earlier: its shorter quote, which the first one covers, is signed and moved', async () => {
      const env = installEnv();
      const early = quoteOf({ epochs: [5, 6], amounts: [E, E], stopped: 7, ts: 1_790_000_111 });
      const { net, quoting } = twoQuotes({ firstQuote: honestPart(), otherQuote: () => ({ body: early }) });
      assert.deepEqual(await nodes.claimForSite(), {
        status: 'ok', qnet: W, nodeId: N, amountNano: String(2 * E), txHash: 'cd'.repeat(32), stoppedAtEpoch: '7',
      });
      const [submitted] = step2(net);
      assert.equal(submitted.node, step1(net)[1].node, 'the payload goes to the node whose quote is signed');
      assert.notEqual(submitted.node, quoting());
      assert.equal(submitted.body.claims_data, early.claims_data);
      assert.equal(submitted.body.claim_timestamp, early.claim_timestamp);
      assert.equal(await core.verifyConsensusSignature(core.claimPayloadPreimage(W, early.claim_timestamp, early.claims_data),
        submitted.body.claims_signature, PK_HEX), true);
      assert.equal(env.calls.signClaimPayload, 1);
      // a gapped first quote against an honest second one that stops before the gap: only the honest part moves, so
      // the epochs the first one left out stay above the watermark
      const next = installEnv();
      const head = quoteOf({ epochs: [5], amounts: [E], stopped: 6 });
      const second = twoQuotes({ firstQuote: gapped(), otherQuote: () => ({ body: head }) });
      assert.equal((await nodes.claimForSite()).stoppedAtEpoch, '6');
      assert.equal(step2(second.net)[0].body.claims_data, head.claims_data);
      assert.equal(next.calls.signClaimPayload, 1);
    });

    it('two quotes that agree move the first one; a full second quote agrees with a part of it', async () => {
      installEnv();
      const whole = quoteOf({ epochs: [5, 6, 7, 8, 9, 10], amounts: [E, E, E, E, E, E] });
      const { net, quoting } = twoQuotes({ firstQuote: honestPart(), otherQuote: () => ({ body: whole }) });
      assert.equal((await nodes.claimForSite()).stoppedAtEpoch, '10');
      assert.equal(step2(net)[0].node, quoting());
      assert.equal(step2(net)[0].body.claims_data, honestPart().claims_data);
    });

    it('another watermark or another amount for an epoch is refused', async () => {
      for (const other of [
        quoteOf({ epochs: [5, 6, 7, 8, 9], amounts: [E, E, E, E, E], stopped: 10, watermark: 3 }),
        quoteOf({ epochs: [5, 6, 7, 8, 9], amounts: [E, E, 2 * E, E, E], stopped: 10 }),
        quoteOf({ epochs: [5, 6, 7], amounts: [E, E, 2 * E], stopped: 8 }),
      ]) {
        const env = installEnv();
        twoQuotes({ firstQuote: honestPart(), otherQuote: () => ({ body: other }) });
        await rejectsWith(nodes.claimForSite(), 'CLAIM_REFUSED');
        assert.equal(env.calls.signClaimPayload, 0);
      }
    });

    it('no second quote is no check: its refusal, or NETWORK when no other node answers; nothing signed', async () => {
      const cannot = { success: false, epochs_claimed: 0, stopped_at_epoch: 5, stopped_reason: 'root_not_here',
        error: 'This node cannot serve epoch 5 (root_not_here) — retry on another node' };
      const cases = [
        [() => ({ body: cannot }), 'CLAIM_REFUSED'],
        [() => ({ body: { success: false, error: 'No claimable rewards' } }), 'CLAIM_REFUSED'],
        [() => ({ status: 400, body: '' }), 'CLAIM_REFUSED'],
        [() => ({ status: 500, body: '' }), 'NETWORK'],
        [() => new TypeError('offline'), 'NETWORK'],
      ];
      for (const [otherQuote, code] of cases) {
        const env = installEnv();
        const { net } = twoQuotes({ firstQuote: honestPart(), otherQuote });
        await rejectsWith(nodes.claimForSite(), code);
        assert.equal(step2(net).length, 0);
        assert.equal(env.calls.signClaimPayload, 0);
      }
    });

    it('a full batch is not quoted twice', async () => {
      installEnv();
      const net = claimNetwork();
      assert.equal((await nodes.claimForSite()).status, 'ok');
      assert.equal(step1(net).length, 1);
    });
  });

  it('answers empty, NO_NODE, CLAIM_BUSY and NETWORK as the node says', async () => {
    installEnv();
    claimNetwork({ step1: { success: false, error: 'No claimable rewards' } });
    assert.deepEqual(await nodes.claimForSite(), { status: 'empty', qnet: W, nodeId: N });
    claimNetwork({ step1: { success: false, error: 'Node not registered on-chain. Registration TX required before claiming rewards.' } });
    await rejectsWith(nodes.claimForSite(), 'NO_NODE');
    claimNetwork({ step1: { success: false, error: 'Claim already in progress for this node. Please wait and retry.' } });
    await rejectsWith(nodes.claimForSite(), 'CLAIM_BUSY');
    claimNetwork({ submitted: { success: false, error: 'Claim already in progress for this node. Please wait and retry.' } });
    await rejectsWith(nodes.claimForSite(), 'CLAIM_BUSY');
    claimNetwork({ submitted: { success: false, error: 'claims_signature does not authorize claims_data for this wallet' } });
    await rejectsWith(nodes.claimForSite(), 'CLAIM_REFUSED');
    network({ status: () => true, claim: () => new TypeError('offline'), pending: () => new TypeError('offline') });
    await rejectsWith(nodes.claimForSite(), 'NETWORK');
    // no other node reports the head: no check, no signature
    network({ status: () => true, claim: () => ({ body: quoteOf() }), pending: () => ({ status: 500, body: '' }) });
    await rejectsWith(nodes.claimForSite(), 'NETWORK');
  });
});
