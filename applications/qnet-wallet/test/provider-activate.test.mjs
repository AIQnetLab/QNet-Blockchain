// qnet_activateNode (QNet Link v1 section 10) through the real router and provider state machine: served to
// https://aiqnet.io only, no grant read or created, the approval's view (activation.siteView, the price
// fixed for the approval), the confirm of its own window (no password) running activation.activateForSite, the dApp
// result shapes, failures as results, and the queue and cooldown rules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../dist/lib/qnet-core.js';
import { LIMITS, SOLANA, STORAGE_KEYS, TIMINGS } from '../dist/background/config.js';
import { ProviderError, WalletError } from '../dist/background/errors.js';
import { contentScriptSender, pageSender, until } from './helpers/chrome-mock.mjs';
import {
  ACCOUNTS, APP, BURN_TX, PASSWORD, SITE, activationRecord, createWorld, eventsOf, replyTo, settleAll,
} from './helpers/provider-harness.mjs';

const ERROR_LINGER_MS = 30000;
const COOLDOWN_TEXT = 'Too many rejected requests from this site, try again later';
// Rejections this far apart stay under the window budget of a minute (owner, 28.09: 5 a minute).
const GAP = TIMINGS.APPROVAL_BUDGET_SHORT_MS / 3;
// The rejections the provider stored for `origin` (its writes are queued: they land first).
async function storedRejections(w, origin) {
  await settleAll();
  return w.chrome.storage.session.dump()[STORAGE_KEYS.APPROVAL_COOLDOWN]?.[origin]?.rejections.length ?? 0;
}
const activate = (port, id, nodeType = 'light') => port.send({ id, method: 'qnet_activateNode', params: { nodeType } });
const answered = (port, id) => port.posted.some((message) => message.id === id);
const publicOf = (record) => {
  const { code, ...rest } = record;
  return { ...rest, codeMasked: `${code.slice(0, 6)}•••••-••••••-••••${code.slice(-2)}` };
};

// Another well-formed Solana signature than BURN_TX: the burn this request sent.
const fakeBurnSignature = () => core.base58Encode(new Uint8Array(64).fill(7));

describe('provider: qnet_activateNode', () => {
  it('aiqnet.io: one window with the burn view; its confirm, no password, burns at the price shown and answers the code', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/activate`);
    activate(port, 'a');
    const shown = await w.shown();
    assert.equal(w.log.windows.length, 1);
    assert.deepEqual({ width: w.log.windows[0].width, height: w.log.windows[0].height }, { width: 400, height: 640 });
    const view = (await shown.get()).result;
    assert.equal(view.kind, 'activateNode');
    assert.equal(view.origin, SITE);
    assert.equal(view.locked, false);
    assert.deepEqual(view.details, {
      nodeType: 'light', solanaAddress: ACCOUNTS.solana, mint: SOLANA.ONE_DEV_MINT, tokenProgram: core.SOLANA_PROGRAMS.TOKEN,
      cluster: SOLANA.CLUSTER, mode: 'burn', reason: null, cost: 1500, activation: null, pending: null,
      balances: { lamports: '2000000000', oneDevRaw: '5000000000' }, recorded: false, otherBurn: false,
    });

    // a later quote never changes the amount this approval confirms (the burn itself checks it again)
    w.state.price = 1400;
    assert.equal((await shown.get()).result.details.cost, 1500);
    assert.deepEqual(w.log.siteViews.map((entry) => entry.known), [{ cost: null, nodeChecked: false }, { cost: 1500, nodeChecked: true }]);

    // the window learns the node type of the code the site received (a Super code adds the server's next step)
    assert.deepEqual((await shown.resolve(true)).result, { resolved: true, status: 'ok', error: null, nodeType: 'light' });
    assert.deepEqual(w.log.activations, [{ nodeType: 'light', expectedPrice: 1500 }]);
    const record = activationRecord('light', 1500);
    assert.deepEqual((await replyTo(port, 'a')).result, {
      status: 'ok', qnet: ACCOUNTS.qnet, solana: ACCOUNTS.solana, nodeType: 'light', burnTx: BURN_TX, burnAmount: 1500, code: record.code,
    });
    assert.equal(await w.storedSites(), undefined, 'no grant is created');
    assert.deepEqual(eventsOf(port), [], 'no accountsChanged');

    // the window stays on its outcome until closed, at most ERROR_LINGER_MS
    await settleAll();
    assert.equal(w.openWindows.has(shown.windowId), true);
    w.fireTimers(ERROR_LINGER_MS);
    await until(() => !w.openWindows.has(shown.windowId));
    assert.equal(w.provider.snapshot().queued, 0);
  });

  it('refuses every other origin with 4100 before any window, and answers NO_WALLET at once without a vault', async () => {
    const w = createWorld();
    // www.aiqnet.io is not even a relay host any more (R4-ERP-02): its port never connects
    assert.equal(w.connect('https://www.aiqnet.io/').disconnected, true);
    for (const url of [`${APP}/activate`]) {
      const port = w.connect(url);
      activate(port, 'x');
      assert.equal((await replyTo(port, 'x')).error.code, 4100, url);
    }
    await assert.rejects(w.provider.handleRequest(Object.freeze({ origin: APP, tabId: 1, portId: 77 }), 'qnet_activateNode', { nodeType: 'light' }),
      (error) => error instanceof ProviderError && error.code === 4100);
    w.state.vaultExists = false;
    const port = w.connect(`${SITE}/`);
    activate(port, 'n');
    assert.deepEqual((await replyTo(port, 'n')).result, { status: 'error', error: 'NO_WALLET' });
    await settleAll();
    assert.equal(w.log.windows.length, 0);
    assert.equal(w.log.siteViews.length, 0);
  });

  it('a reject answers 4001; a single rejection brings no cooldown, the fifth within 10 minutes does (owner, 28.09)', async () => {
    const c = { now: 1_800_000_000_000 };
    const w = createWorld({ now: () => c.now });
    const port = w.connect(`${SITE}/`);
    let after = null;
    for (let i = 1; i <= LIMITS.APPROVAL_COOLDOWN_REJECTIONS; i += 1) {
      if (i > 1) c.now += GAP;
      activate(port, `r${i}`);
      // it opens: the rejections before bar nothing
      const shown = await w.shown({ after });
      await shown.get();
      assert.deepEqual((await shown.resolve(false)).result, { resolved: true });
      assert.equal((await replyTo(port, `r${i}`)).error.code, 4001);
      assert.equal(await storedRejections(w, SITE), i);
      after = shown.windowId;
    }
    activate(port, 'late');
    assert.deepEqual((await replyTo(port, 'late')).error, { code: 4001, message: COOLDOWN_TEXT });
    assert.equal(w.log.activations.length, 0);
    assert.equal(w.log.windows.length, LIMITS.APPROVAL_COOLDOWN_REJECTIONS);
  });

  it('a view that cannot offer the action answers its reason; its first close counts nothing, a second soon after does (R2-ERP-01)', async () => {
    const w = createWorld();
    w.state.siteView = { mode: 'unavailable', reason: 'NODE_EXISTS', cost: null, balances: null };
    const port = w.connect(`${SITE}/`);
    activate(port, 'u');
    let shown = await w.shown();
    const view = (await shown.get()).result;
    assert.equal(view.details.mode, 'unavailable');
    assert.equal(view.details.reason, 'NODE_EXISTS');
    assert.deepEqual((await shown.resolve(false)).result, { resolved: true, status: 'error', error: 'NODE_EXISTS' });
    assert.deepEqual((await replyTo(port, 'u')).result, { status: 'error', error: 'NODE_EXISTS' });

    assert.equal(await storedRejections(w, SITE), 0, 'the first counts nothing');

    activate(port, 'u2');
    shown = await w.shown({ after: shown.windowId });
    assert.equal((await shown.get()).result.details.reason, 'NODE_EXISTS', 'no cooldown after the first: the window opens again');
    await w.userCloses(shown.windowId);
    assert.equal((await replyTo(port, 'u2')).error.code, 4001);
    // a page looping on an unavailable activation: the second window it lets end soon after counts as a rejection
    assert.equal(await storedRejections(w, SITE), 1);
    // one rejection bars nothing (owner, 28.09); the loop still ends: its windows spend the budget of a minute
    for (let n = 3; n <= LIMITS.APPROVAL_BUDGET_SHORT; n += 1) {
      activate(port, `u${n}`);
      shown = await w.shown({ after: shown.windowId });
      await w.userCloses(shown.windowId);
      assert.equal((await replyTo(port, `u${n}`)).error.code, 4001);
      assert.equal(await storedRejections(w, SITE), n - 1);
    }
    activate(port, 'over');
    const refused = await replyTo(port, 'over');
    assert.equal(refused.error.code, 4001);
    assert.match(refused.error.message, /Too many rejected requests/);
    assert.equal(w.log.windows.length, LIMITS.APPROVAL_BUDGET_SHORT);
    assert.equal(w.log.activations.length, 0);
  });

  // EXT-R1-01: the network could not vouch that the wallet has no node: the window says so, and the site learns INTERNAL
  // (QNet Link v1 section 7 has no code for it), never a code that would read as "no burn is possible"
  it('a view the QNet network could not clear shows NETWORK and answers the site INTERNAL', async () => {
    const w = createWorld();
    w.state.siteView = { mode: 'unavailable', reason: 'NETWORK', cost: null, balances: null };
    const port = w.connect(`${SITE}/`);
    activate(port, 'n');
    const shown = await w.shown();
    assert.equal((await shown.get()).result.details.reason, 'NETWORK');
    assert.deepEqual((await shown.resolve(false)).result, { resolved: true, status: 'error', error: 'NETWORK' });
    assert.deepEqual((await replyTo(port, 'n')).result, { status: 'error', error: 'INTERNAL' });
    assert.equal(w.log.activations.length, 0);
  });

  it('the wallet\'s activation is answered without a burn: expectedPrice null, the stored code', async () => {
    const w = createWorld();
    const record = activationRecord('super', 6000);
    w.state.siteView = { mode: 'exists', cost: null, activation: publicOf(record), balances: null };
    w.state.activateOutcome = { status: 'exists', activation: record };
    const port = w.connect(`${SITE}/`);
    activate(port, 'e', 'light');
    const shown = await w.shown();
    const view = (await shown.get()).result;
    assert.equal(view.details.mode, 'exists');
    assert.equal(view.details.activation.codeMasked, publicOf(record).codeMasked);
    assert.ok(!JSON.stringify(view).includes(record.code), 'the window never gets the code');
    assert.deepEqual((await shown.resolve(true)).result, { resolved: true, status: 'exists', error: null, nodeType: 'super' });
    assert.deepEqual(w.log.activations, [{ nodeType: 'light', expectedPrice: null }]);
    assert.deepEqual((await replyTo(port, 'e')).result, {
      status: 'exists', qnet: ACCOUNTS.qnet, solana: ACCOUNTS.solana, nodeType: 'super', burnTx: BURN_TX, burnAmount: 6000, code: record.code,
    });
  });

  // XP-R5-03: the burn this request sent lost the race to another device's older burn of the phrase, of another node
  // type: the site gets 'exists' with that activation (never INTERNAL once a burn went out), and both the window and the
  // site's answer name the burn it sent (QNet Link v1 section 7.1, supersededBurnTx).
  it('a burn beaten by another device\'s older one answers exists with it, whatever its type, and names this burn (XP-R5-03)', async () => {
    const w = createWorld();
    const record = activationRecord('super', 6000);
    const own = fakeBurnSignature();
    w.state.activateOutcome = {
      status: 'exists', activation: record,
      superseded: { burnTx: own, nodeType: 'light', burnAmount: 1500, solanaAddress: ACCOUNTS.solana, cluster: 'devnet', createdAt: 1 },
    };
    const port = w.connect(`${SITE}/`);
    activate(port, 's', 'light');
    const shown = await w.shown();
    await shown.get();
    assert.deepEqual((await shown.resolve(true)).result, {
      resolved: true, status: 'exists', error: null, superseded: { burnTx: own, nodeType: 'light', burnAmount: 1500 }, nodeType: 'super',
    });
    assert.deepEqual((await replyTo(port, 's')).result, {
      status: 'exists', qnet: ACCOUNTS.qnet, solana: ACCOUNTS.solana, nodeType: 'super', burnTx: BURN_TX, burnAmount: 6000, code: record.code,
      supersededBurnTx: own,
    });
  });

  it('a burn Solana has not finalized is answered as pending, without a code', async () => {
    const w = createWorld();
    const pending = { burnTx: BURN_TX, nodeType: 'light', burnAmount: 1500, solanaAddress: ACCOUNTS.solana, cluster: 'devnet', createdAt: 1 };
    w.state.activateOutcome = { status: 'pending', pending };
    const port = w.connect(`${SITE}/`);
    activate(port, 'p');
    const shown = await w.shown();
    await shown.get();
    assert.deepEqual((await shown.resolve(true)).result, { resolved: true, status: 'pending', error: null });
    assert.deepEqual((await replyTo(port, 'p')).result, {
      status: 'pending', qnet: ACCOUNTS.qnet, solana: ACCOUNTS.solana, nodeType: 'light', burnTx: BURN_TX, burnAmount: 1500,
    });
  });

  it('a pending burn whose burner is not the wallet\'s Solana address never reaches the site (XP-R2-05)', async () => {
    const stranger = core.KAT.activation.solanaAddress;
    assert.notEqual(stranger, ACCOUNTS.solana);
    const pending = { burnTx: BURN_TX, nodeType: 'super', burnAmount: 6000, solanaAddress: stranger, cluster: 'devnet', createdAt: 1 };
    const other = createWorld();
    other.state.activateOutcome = { status: 'pending', pending };
    const otherPort = other.connect(`${SITE}/`);
    activate(otherPort, 'x');
    const otherShown = await other.shown();
    await otherShown.get();
    await otherShown.resolve(true);
    assert.deepEqual((await replyTo(otherPort, 'x')).result, { status: 'error', error: 'INTERNAL' });
  });

  it('a burn search its budget cut short reaches the site as HISTORY_TOO_LONG (SRA-R2-02, XP-R2-02)', async () => {
    const w = createWorld();
    w.state.activateError = new WalletError('HISTORY_TOO_LONG');
    const port = w.connect(`${SITE}/`);
    activate(port, 'h');
    const shown = await w.shown();
    await shown.get();
    assert.deepEqual((await shown.resolve(true)).result, { resolved: true, status: 'error', error: 'HISTORY_TOO_LONG' });
    assert.deepEqual((await replyTo(port, 'h')).result, { status: 'error', error: 'HISTORY_TOO_LONG' });
  });

  it('a confirm names the view it confirms: a pending view that became a burn meanwhile is reviewed again, never burned (R2-ERP-04)', async () => {
    const w = createWorld();
    const pending = { burnTx: BURN_TX, nodeType: 'light', burnAmount: 1500, solanaAddress: ACCOUNTS.solana, cluster: 'devnet', createdAt: 1 };
    w.state.siteView = { mode: 'pending', cost: null, pending, balances: null };
    const port = w.connect(`${SITE}/`);
    activate(port, 'r');
    const shown = await w.shown();
    const drawn = (await shown.get()).result;
    assert.equal(drawn.details.mode, 'pending');
    // the heartbeat's read: the pending burn expired unseen, so the worker now offers a burn at a price
    w.state.siteView = null;
    const served = (await shown.get()).result;
    assert.equal(served.details.mode, 'burn');
    assert.ok(served.revision > drawn.revision);
    // the user confirms the pending screen still shown: no burn, the window reviews again
    assert.equal((await shown.resolve(true, { revision: drawn.revision })).error.code, 'PRICE_CHANGED');
    assert.equal(w.log.activations.length, 0);
    assert.equal(answered(port, 'r'), false, 'the approval stays open');
    // the burn screen, once drawn and confirmed, burns
    const fresh = (await shown.get()).result;
    assert.equal(fresh.details.mode, 'burn');
    assert.equal((await shown.resolve(true, { revision: fresh.revision })).result.status, 'ok');
    assert.deepEqual(w.log.activations, [{ nodeType: 'light', expectedPrice: 1500 }]);
  });

  it('a read that finishes after the confirm started never changes the price it burns at (R2-EXT-UI-03)', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    activate(port, 's');
    const shown = await w.shown();
    // read A starts before any price is fixed and is slow (Solana, the nodes)
    let openA;
    w.state.gates.siteView = new Promise((resolve) => { openA = resolve; });
    const slow = shown.get();
    await settleAll();
    // read B, started later, answers first: the window shows 1500 and the user confirms it
    w.state.gates.siteView = null;
    const drawn = (await shown.get()).result;
    assert.equal(drawn.details.cost, 1500);
    let openUnlock;
    w.state.gates.unlock = new Promise((resolve) => { openUnlock = resolve; });
    const confirm = shown.resolve(true, { revision: drawn.revision });
    await settleAll();
    // A lands during the confirm with a quote that moved meanwhile
    w.state.price = 1400;
    openA();
    await slow;
    openUnlock();
    assert.equal((await confirm).result.status, 'ok');
    assert.deepEqual(w.log.activations, [{ nodeType: 'light', expectedPrice: 1500 }]);
  });

  it('a confirm carrying a password is refused; a changed price keeps the approval open; every other failure is a result', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    activate(port, 'f');
    const shown = await w.shown();
    await shown.get();
    assert.equal((await shown.resolve(true, { password: PASSWORD })).error.code, 'INVALID_PARAMS', 'no approval takes a password');
    assert.equal(w.log.activations.length, 0);
    w.state.activateError = new WalletError('PRICE_CHANGED');
    assert.equal((await shown.resolve(true)).error.code, 'PRICE_CHANGED');
    await settleAll();
    assert.equal(answered(port, 'f'), false);
    // the next view reads the price again
    w.state.price = 1600;
    assert.equal((await shown.get()).result.details.cost, 1600);
    assert.equal(w.log.siteViews.at(-1).known.cost, null);

    w.state.activateError = new WalletError('TX_FAILED');
    assert.deepEqual((await shown.resolve(true)).result, { resolved: true, status: 'error', error: 'TX_FAILED' });
    assert.deepEqual((await replyTo(port, 'f')).result, { status: 'error', error: 'TX_FAILED' });
    assert.deepEqual(w.log.activations.map((call) => call.expectedPrice), [1500, 1600]);

    // a wallet-side code the protocol does not list reaches the dApp as INTERNAL; the window keeps its own
    const other = createWorld();
    other.state.activateError = new WalletError('SIGNING_DISABLED');
    const otherPort = other.connect(`${SITE}/`);
    activate(otherPort, 's');
    const otherShown = await other.shown();
    await otherShown.get();
    assert.deepEqual((await otherShown.resolve(true)).result, { resolved: true, status: 'error', error: 'SIGNING_DISABLED' });
    assert.deepEqual((await replyTo(otherPort, 's')).result, { status: 'error', error: 'INTERNAL' });
  });

  // EXT-FA1-02: of a light activation's registration the window draws only whether the chain lists the node; its other
  // steps (queued, admitted, deferred, the attempts) never change the details nor the revision, so the armed confirm
  // survives them and a confirm of the view drawn before them goes through (no PRICE_CHANGED)
  it('an exists view changes only when the chain lists the light node, never with the registration\'s other steps (EXT-FA1-02)', async () => {
    const record = activationRecord('light');
    const nodeId = core.lightNodeId(ACCOUNTS.qnet);
    const registration = (state, extra = {}) => ({
      nodeId, state, attempts: 0, lastError: null, txHash: null, updatedAt: 1, automatic: true, deferred: false, ...extra,
    });
    const steps = [
      registration('queued'),
      registration('admitted', { attempts: 1, txHash: 'ab'.repeat(32), updatedAt: 2 }),
      registration('queued', { attempts: 2, lastError: 'behind_chain', deferred: true, updatedAt: 3 }),
      registration('refused', { attempts: 3, lastError: 'refused', automatic: false, updatedAt: 4 }),
    ];
    const open = (id) => {
      const w = createWorld();
      w.state.siteView = {
        mode: 'exists', cost: null, activation: publicOf(record), balances: null, registration: registration('queued', { deferred: true }),
      };
      w.state.activateOutcome = { status: 'exists', activation: record };
      const port = w.connect(`${SITE}/`);
      activate(port, id);
      return { w, port };
    };

    const { w, port } = open('x');
    const shown = await w.shown();
    const drawn = (await shown.get()).result;
    assert.equal(drawn.details.mode, 'exists');
    assert.equal(drawn.details.recorded, false);
    assert.equal(Object.hasOwn(drawn.details, 'registration'), false, 'the window gets no registration it does not draw');
    for (const step of steps) {
      w.state.siteView = { ...w.state.siteView, registration: step };
      const served = (await shown.get()).result;
      assert.equal(served.revision, drawn.revision, `${step.state} ${step.attempts}`);
      assert.deepEqual(served.details, drawn.details);
    }
    assert.equal((await shown.resolve(true, { revision: drawn.revision })).result.status, 'exists');
    assert.equal((await replyTo(port, 'x')).result.status, 'exists');
    assert.equal(w.log.activations.length, 1);

    // the node listed on chain is what the window draws differently (no "it is recorded too"): one new revision
    const listed = open('y');
    const listedShown = await listed.w.shown();
    const before = (await listedShown.get()).result;
    listed.w.state.siteView = { ...listed.w.state.siteView, registration: registration('onchain', { automatic: false }) };
    const after = (await listedShown.get()).result;
    assert.equal(after.details.recorded, true);
    assert.equal(after.revision, before.revision + 1);
    assert.equal((await listedShown.get()).result.revision, after.revision);
    assert.equal((await listedShown.resolve(true, { revision: before.revision })).error.code, 'PRICE_CHANGED');
    assert.equal(listed.w.log.activations.length, 0, 'a view other than the last one served is never confirmed');

    // listed with another burn's registration (EXT-R2A-03): not recorded, and drawn as such, one new revision
    const other = open('z');
    const otherShown = await other.w.shown();
    const first = (await otherShown.get()).result;
    assert.equal(first.details.otherBurn, false);
    other.w.state.siteView = { ...other.w.state.siteView, registration: registration('other_burn', { automatic: false }) };
    const drawnOther = (await otherShown.get()).result;
    assert.deepEqual([drawnOther.details.recorded, drawnOther.details.otherBurn], [false, true]);
    assert.equal(drawnOther.revision, first.revision + 1);
  });

  it('checks the outcome once more: a code that is not this burn\'s, or another wallet\'s burn, never reaches the site', async () => {
    const bad = [
      { status: 'ok', activation: { ...activationRecord(), code: 'QNET-L00000-000000-000000' } },
      { status: 'ok', activation: { ...activationRecord(), solanaAddress: core.KAT.activation.solanaAddress } },
      { status: 'ok', activation: activationRecord('super') },
      { status: 'done', activation: activationRecord() },
      { status: 'pending', pending: { burnTx: 'x', nodeType: 'light', burnAmount: 1500, solanaAddress: ACCOUNTS.solana } },
    ];
    for (const outcome of bad) {
      const w = createWorld();
      w.state.activateOutcome = outcome;
      const port = w.connect(`${SITE}/`);
      activate(port, 'c', 'light');
      const shown = await w.shown();
      await shown.get();
      await shown.resolve(true);
      assert.deepEqual((await replyTo(port, 'c')).result, { status: 'error', error: 'INTERNAL' }, JSON.stringify(outcome).slice(0, 80));
    }
  });

  it('locked: the window unlocks first; nothing is read or burned before', async () => {
    const w = createWorld({ unlocked: false });
    const port = w.connect(`${SITE}/`);
    activate(port, 'l', 'super');
    const shown = await w.shown();
    const view = (await shown.get()).result;
    assert.equal(view.locked, true);
    assert.equal(view.details.mode, null);
    assert.equal(view.details.nodeType, 'super');
    assert.equal(w.log.siteViews.length, 0);
    assert.equal((await shown.resolve(true)).error.code, 'LOCKED');
    assert.equal(w.log.activations.length, 0);
    w.state.unlocked = true;
    // unlocked, the burn is shown and its confirm burns: no password is asked after the unlock
    const drawn = (await shown.get()).result;
    assert.equal(drawn.details.mode, 'burn');
    assert.equal((await shown.resolve(true, { revision: drawn.revision })).result.status, 'ok');
    assert.deepEqual(w.log.activations, [{ nodeType: 'super', expectedPrice: 1500 }]);
    // a confirm before any view was served reviews first
    const early = createWorld();
    const earlyPort = early.connect(`${SITE}/`);
    activate(earlyPort, 'q');
    const earlyShown = await early.shown();
    assert.equal((await earlyShown.resolve(true, { revision: null })).error.code, 'PRICE_CHANGED');
    assert.equal(early.log.activations.length, 0);
  });

  it('no kind of approval takes a password, at the router or at the provider', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    port.send({ id: 'c', method: 'qnet_requestAccounts' });
    const shown = await w.shown();
    await shown.get();
    assert.equal((await shown.resolve(true, { password: PASSWORD })).error.code, 'INVALID_PARAMS');
    await assert.rejects(w.provider.resolveApproval({ id: shown.id, approved: true, password: PASSWORD }, { page: 'approve', sender: shown.sender }),
      (error) => error instanceof WalletError && error.code === 'INVALID_PARAMS');
    assert.equal(answered(port, 'c'), false);
    assert.deepEqual((await shown.resolve(true)).result, { resolved: true });
    assert.deepEqual((await replyTo(port, 'c')).result, ACCOUNTS);

    const act = createWorld();
    const actPort = act.connect(`${SITE}/`);
    activate(actPort, 'a');
    const actShown = await act.shown();
    const drawn = (await actShown.get()).result;
    await assert.rejects(act.provider.resolveApproval({ id: actShown.id, approved: true, password: PASSWORD, revision: drawn.revision },
      { page: 'approve', sender: actShown.sender }), (error) => error instanceof WalletError && error.code === 'INVALID_PARAMS');
    assert.equal(act.log.activations.length, 0);
    assert.equal(answered(actPort, 'a'), false);
  });

  // Without the password, what binds a confirm to its request is the window: the router takes approval.resolve only from
  // this extension's ui/approve.html, and the provider only from the window it opened for that approval, with that
  // approval's id; a settled approval is gone, so a confirm acts once.
  it('an activation is confirmed only from its own window, for its own id, and once', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    activate(port, 'a');
    const shown = await w.shown();
    const drawn = (await shown.get()).result;
    const confirm = { id: shown.id, approved: true, revision: drawn.revision };
    const errorOf = (reply) => reply.error?.code;
    assert.equal(errorOf(await w.ui(w.approveSender(shown.windowId + 1, shown.id), 'approval.resolve', confirm)), 'NOT_FOUND',
      'the approve page in another window');
    assert.equal(errorOf(await w.ui({ ...shown.sender, tab: undefined }, 'approval.resolve', confirm)), 'NOT_FOUND', 'no window');
    assert.equal(errorOf(await w.ui(shown.sender, 'approval.resolve', { ...confirm, id: '0f8fad5b-d9cb-469f-a165-70867728950e' })),
      'NOT_FOUND', 'another id');
    assert.equal(errorOf(await w.ui(pageSender(w.chrome.runtime, 'popup'), 'approval.resolve', confirm)), 'FORBIDDEN_SENDER');
    assert.equal(errorOf(await w.ui(contentScriptSender(`${SITE}/`), 'approval.resolve', confirm)), 'FORBIDDEN_SENDER');
    assert.equal(w.log.activations.length, 0, 'nothing burned for any of them');
    assert.equal(answered(port, 'a'), false);

    assert.equal((await shown.resolve(true, { revision: drawn.revision })).result.status, 'ok');
    assert.equal(errorOf(await shown.resolve(true, { revision: drawn.revision })), 'NOT_FOUND', 'one approval, one burn');
    assert.equal(w.log.activations.length, 1);
    assert.equal((await replyTo(port, 'a')).result.status, 'ok');
  });

  it('a confirmed activation tells the pages to read the balances again; a reject does not', async () => {
    const w = createWorld();
    const port = w.connect(`${SITE}/`);
    activate(port, 'r');
    let shown = await w.shown();
    await shown.get();
    await shown.resolve(false);
    await replyTo(port, 'r');
    assert.equal(w.log.views.includes('balance'), false);
    activate(port, 'a');
    shown = await w.shown({ after: shown.windowId });
    await shown.get();
    assert.equal((await shown.resolve(true)).result.status, 'ok');
    assert.equal(w.log.views.filter((event) => event === 'balance').length, 1);
  });

  it('the per-origin queue applies, and a disconnect leaves an activation waiting', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/`);
    for (const id of ['1', '2', '3']) activate(port, id);
    activate(port, '4');
    assert.equal((await replyTo(port, '4')).error.code, 4001);
    port.send({ id: 'd', method: 'qnet_disconnect' });
    assert.equal((await replyTo(port, 'd')).result, true);
    await settleAll();
    assert.equal(answered(port, '1'), false, 'no grant was needed, so none is missed');
    assert.equal(w.provider.snapshot().queued, 3);
  });
});

// Decision 35: the site reads what the extension knows of the wallet's activation without a window and without the
// user pressing a burn button (qnet_getActivation); a burn the extension cannot offer reaches the site as the section 7
// codes it means.
describe('provider: qnet_getActivation and the codes of aiqnet.io\'s record', () => {
  const read = (port, id) => port.send({ id, method: 'qnet_getActivation' });
  const answerOf = async (port, id) => {
    read(port, id);
    return replyTo(port, id);
  };
  const CODE = activationRecord('light', 1500).code;

  it('answers every status of the extension\'s own knowledge with no window, no budget spent, no grant made and no event', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/node`);
    const base = { qnet: ACCOUNTS.qnet, solana: ACCOUNTS.solana };
    const statuses = [
      { status: 'searching', ...base },
      { status: 'none', ...base },
      { status: 'unusable', ...base },
      { status: 'unknown', ...base, reason: 'SOLANA_UNAVAILABLE' },
      { status: 'unknown', ...base, reason: 'HISTORY_TOO_LONG' },
      { status: 'pending', ...base, nodeType: 'super', burnTx: BURN_TX, burnAmount: 3000 },
      { status: 'exists', ...base, nodeType: 'light', burnTx: BURN_TX, burnAmount: 1500, code: CODE, paidOnSite: false },
      {
        status: 'exists', ...base, nodeType: 'light', burnTx: BURN_TX, burnAmount: 1500,
        code: core.walletActivationCode(ACCOUNTS.qnet, BURN_TX, 1500), paidOnSite: true,
      },
    ];
    for (const [index, answer] of statuses.entries()) {
      w.state.siteActivation = answer;
      assert.deepEqual((await answerOf(port, `s${index}`)).result, answer, answer.status);
    }
    await settleAll();
    assert.equal(w.log.windows.length, 0, 'never a window');
    assert.equal(w.log.activations.length, 0, 'nothing burned');
    assert.deepEqual(eventsOf(port), [], 'no accountsChanged');
    assert.equal(w.chrome.storage.session.dump()[STORAGE_KEYS.APPROVAL_COOLDOWN], undefined, 'no window budget spent');
    assert.equal(Object.keys(await w.storedSites()).length, 1, 'no grant made');
  });

  it('answers no_wallet, locked and not_connected before reading anything, and 4100 to any other origin', async () => {
    const w = createWorld();
    const other = w.connect(`${APP}/node`);
    read(other, 'x');
    assert.equal((await replyTo(other, 'x')).error.code, 4100);
    await assert.rejects(w.provider.handleRequest(Object.freeze({ origin: APP, tabId: 1, portId: 77 }), 'qnet_getActivation', {}),
      (error) => error instanceof ProviderError && error.code === 4100);
    const port = w.connect(`${SITE}/node`);
    assert.deepEqual((await answerOf(port, 'nc')).result, { status: 'not_connected' }, 'no grant of this wallet');
    await w.grant(SITE);
    w.state.unlocked = false;
    assert.deepEqual((await answerOf(port, 'l')).result, { status: 'locked' });
    w.state.vaultExists = false;
    assert.deepEqual((await answerOf(port, 'n')).result, { status: 'no_wallet' });
    assert.equal(w.log.siteActivations, 0);
    // a grant of another wallet is no grant of this one
    w.state.vaultExists = true;
    w.state.unlocked = true;
    w.state.walletId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    assert.deepEqual((await answerOf(port, 'o')).result, { status: 'not_connected' });
    // locked while it reads: locked
    w.state.walletId = '6f1c1d52-8f0a-4c43-9d1e-2b7b8c9a0e11';
    await w.grant(SITE);
    w.state.siteActivationError = new WalletError('LOCKED');
    assert.deepEqual((await answerOf(port, 'r')).result, { status: 'locked' });
  });

  it('lets out only the wallet\'s own addresses, a known status with exactly its keys, and a code that is the node\'s derivation of the burn', async () => {
    const w = createWorld();
    await w.grant(SITE);
    const port = w.connect(`${SITE}/node`);
    const base = { qnet: ACCOUNTS.qnet, solana: ACCOUNTS.solana };
    const exists = { status: 'exists', ...base, nodeType: 'light', burnTx: BURN_TX, burnAmount: 1500, code: CODE, paidOnSite: false };
    const bad = [
      { ...exists, code: activationRecord('light', 1501).code },
      { ...exists, nodeType: 'super' },
      { ...exists, paidOnSite: true },
      { ...exists, solana: core.solanaAddressFromPublicKey(new Uint8Array(32).fill(5)) },
      { ...exists, qnet: core.qnetAddressFromPublicKey(new Uint8Array(1952).fill(3)) },
      { ...exists, extra: 1 },
      { status: 'none', ...base, code: CODE },
      { status: 'unknown', ...base, reason: 'NETWORK' },
      { status: 'pending', ...base, nodeType: 'light', burnTx: 'x', burnAmount: 1500 },
      { status: 'ok', ...base },
      null,
    ];
    for (const [index, answer] of bad.entries()) {
      w.state.siteActivation = answer === null ? undefined : answer;
      if (answer === null) w.state.siteActivationError = new Error('broken');
      assert.equal((await answerOf(port, `b${index}`)).error.code, -32603, JSON.stringify(answer));
    }
  });

  it('an origin reads at most 30 times a minute (more: 4001), and reads again once the minute passed', async () => {
    const clock = { now: 1_800_000_000_000 };
    const w = createWorld({ now: () => clock.now });
    await w.grant(SITE);
    const port = w.connect(`${SITE}/node`);
    for (let i = 0; i < LIMITS.ACTIVATION_READS_PER_MINUTE; i += 1) {
      assert.equal((await answerOf(port, `r${i}`)).result.status, 'none');
      clock.now += 1000;
    }
    assert.equal((await answerOf(port, 'over')).error.code, 4001);
    assert.equal(w.log.siteActivations, LIMITS.ACTIVATION_READS_PER_MINUTE);
    clock.now += 31_000;
    assert.equal((await answerOf(port, 'later')).result.status, 'none');
    assert.equal(w.log.windows.length, 0);
  });

  it('a burn the record of aiqnet.io refuses reaches the site as NODE_EXISTS, BURN_IN_PROGRESS or INTERNAL; the window names why', async () => {
    for (const [reason, siteCode] of [['ACTIVATION_RECORDED', 'NODE_EXISTS'], ['ACTIVATION_RESERVED', 'BURN_IN_PROGRESS'],
      ['RECORD_UNAVAILABLE', 'INTERNAL']]) {
      // shown before the confirm: the window's one button tells the site
      let w = createWorld();
      w.state.siteView = { mode: 'unavailable', reason, cost: null, balances: null };
      let port = w.connect(`${SITE}/`);
      activate(port, 'u');
      let shown = await w.shown();
      assert.equal((await shown.get()).result.details.reason, reason);
      assert.deepEqual((await shown.resolve(false)).result, { resolved: true, status: 'error', error: reason });
      assert.deepEqual((await replyTo(port, 'u')).result, { status: 'error', error: siteCode });
      // found at the confirm: the same code for the site
      w = createWorld();
      w.state.activateError = new WalletError(reason);
      port = w.connect(`${SITE}/`);
      activate(port, 'c');
      shown = await w.shown();
      await shown.get();
      assert.deepEqual((await shown.resolve(true)).result, { resolved: true, status: 'error', error: reason });
      assert.deepEqual((await replyTo(port, 'c')).result, { status: 'error', error: siteCode });
    }
  });

  it('while the wallet is being checked the window offers nothing to confirm, and closing it counts no rejection', async () => {
    const w = createWorld();
    w.state.siteView = { mode: 'checking', reason: null, cost: null, balances: null };
    const port = w.connect(`${SITE}/`);
    activate(port, 'k');
    const shown = await w.shown();
    const view = (await shown.get()).result;
    assert.deepEqual([view.details.mode, view.details.cost], ['checking', null]);
    const confirm = await shown.resolve(true);
    assert.equal(confirm.error.code, 'PRICE_CHANGED', 'nothing reviewed yet: the window reviews again');
    assert.equal(w.log.activations.length, 0);
    // the page reads the view again after that answer: still being checked
    assert.equal((await shown.get()).result.details.mode, 'checking');
    await w.userCloses(shown.windowId);
    assert.equal((await replyTo(port, 'k')).error.code, 4001);
    await settleAll();
    assert.equal(w.chrome.storage.session.dump()[STORAGE_KEYS.APPROVAL_COOLDOWN]?.[SITE]?.rejections.length ?? 0, 0);
  });
});
