// dApp approval cooldown (anti prompt-spam), the rule of 28.09: a single rejected or closed approval bars nothing,
// its origin may ask again at once; the fifth within 10 min bars the origin for 1 min, and every window counts
// against a budget of 5 a minute and 20 in 10 min however it ends. Meanwhile a request that would need a window
// fails at once with 4001 and a fixed text. An approved action clears it. The state is in worker memory and
// chrome.storage.session, so a restarted worker keeps it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, STORAGE_KEYS, TIMINGS } from '../dist/background/config.js';
import { ERROR_MESSAGES } from '../dist/background/errors.js';
import { contentScriptSender, until } from './helpers/chrome-mock.mjs';
import {
  ACCOUNTS, APP, GAME, SITE, TOKEN, ask, createWorld, replyTo, settleAll,
} from './helpers/provider-harness.mjs';

const REJECTED = { code: 4001, message: 'User rejected the request' };
const COOLDOWN = { code: 4001, message: ERROR_MESSAGES.APPROVAL_COOLDOWN };
const KEY = STORAGE_KEYS.APPROVAL_COOLDOWN;
const LONG = TIMINGS.APPROVAL_COOLDOWN_LONG_MS;
const REJECTIONS = LIMITS.APPROVAL_COOLDOWN_REJECTIONS;
// Rejections this far apart keep under the window budget (at most 3 windows a minute) and still fall within the
// 10-minute window: what bars the origin below is then the count of rejections alone.
const GAP = TIMINGS.APPROVAL_BUDGET_SHORT_MS / 3;

function clock(start = 1_800_000_000_000) {
  const c = { now: start };
  c.fn = () => c.now;
  return c;
}

async function world(c, ...grants) {
  const w = createWorld({ now: c.fn });
  await w.grant(SITE, APP, ...grants);
  return w;
}

let seq = 0;
const sign = (port, message = 'm') => {
  seq += 1;
  const id = `s${seq}`;
  port.send({ id, method: 'qnet_signMessage', params: { message } });
  return id;
};
const errorOf = async (port, id) => {
  const reply = await replyTo(port, id);
  assert.equal(reply.ok, false, JSON.stringify(reply));
  return reply.error;
};

// Opens one approval of `port`'s origin and rejects it (or closes its window).
async function rejectOne(w, port, { close = false, after = null } = {}) {
  const id = sign(port);
  const shown = await w.shown({ after });
  if (close) await w.userCloses(shown.windowId);
  else assert.equal((await shown.resolve(false)).ok, true);
  assert.deepEqual(await errorOf(port, id), REJECTED);
  return shown;
}

// Rejects `count` approvals of `port`'s origin GAP apart (closing the window for the indexes in `closes`); the clock
// ends at the last one, and so does the returned window.
async function rejectSeries(w, c, port, count, { after = null, closes = [] } = {}) {
  let last = null;
  for (let i = 0; i < count; i += 1) {
    if (i > 0) c.now += GAP;
    last = await rejectOne(w, port, { close: closes.includes(i), after: last?.windowId ?? after });
  }
  return last;
}

// The rejections the provider stored for `origin` (its writes are queued: they land first).
async function storedRejections(w, origin) {
  await settleAll();
  return w.chrome.storage.session.dump()[KEY]?.[origin]?.rejections.length ?? 0;
}

async function blocked(w, port) {
  const windows = w.log.windows.length;
  const id = sign(port);
  const error = await errorOf(port, id);
  assert.equal(w.log.windows.length, windows, 'no window during the cooldown');
  return error;
}

async function opens(w, port, after) {
  const id = sign(port);
  const shown = await w.shown({ after });
  return { id, shown };
}

describe('provider: approval cooldown', () => {
  it('is the rule of 28.09: one rejection bars nothing, five within 10 minutes bar 1 minute; 5 windows a minute, 20 in 10', () => {
    assert.equal(TIMINGS.APPROVAL_COOLDOWN_MS, 0);
    assert.equal(REJECTIONS, 5);
    assert.equal(TIMINGS.APPROVAL_COOLDOWN_WINDOW_MS, 600_000);
    assert.equal(LONG, 60_000);
    assert.equal(LIMITS.APPROVAL_BUDGET_SHORT, 5);
    assert.equal(TIMINGS.APPROVAL_BUDGET_SHORT_MS, 60_000);
    assert.equal(LIMITS.APPROVAL_BUDGET_LONG, 20);
    // the spacing of the tests below: under the window budget, inside the rejection window, shorter than the cooldown
    assert.ok(Math.ceil(TIMINGS.APPROVAL_BUDGET_SHORT_MS / GAP) < LIMITS.APPROVAL_BUDGET_SHORT);
    assert.ok(GAP * (REJECTIONS - 1) < TIMINGS.APPROVAL_COOLDOWN_WINDOW_MS);
    assert.ok(GAP < LONG);
  });

  it('a single rejection bars nothing; the fifth within 10 minutes bars its origin for 1 minute with 4001 and the fixed text; others and window-less calls are served', async () => {
    const c = clock();
    const w = await world(c);
    const site = w.connect(`${SITE}/`);
    const app = w.connect(`${APP}/`);
    const first = await rejectOne(w, site);
    assert.equal(await storedRejections(w, SITE), 1, 'counted');
    // no cooldown after one (owner, 28.09): the next request opens its window at once
    const again = await opens(w, site, first.windowId);
    assert.equal((await again.shown.get()).result.origin, SITE);
    assert.equal((await again.shown.resolve(false)).ok, true);
    assert.deepEqual(await errorOf(site, again.id), REJECTED);
    c.now += GAP;
    const last = await rejectSeries(w, c, site, REJECTIONS - 2, { after: again.shown.windowId });
    assert.equal(await storedRejections(w, SITE), REJECTIONS);

    assert.deepEqual(await blocked(w, site), COOLDOWN);
    const t = await ask(site, { id: 't', method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
    assert.deepEqual(t.error, COOLDOWN);
    assert.deepEqual((await ask(site, { id: 'a', method: 'qnet_accounts' })).result, ACCOUNTS);
    assert.deepEqual((await ask(site, { id: 'r', method: 'qnet_requestAccounts' })).result, ACCOUNTS, 'granted: no window needed');
    assert.equal((await ask(site, { id: 'c', method: 'qnet_chainId' })).ok, true);

    const other = await opens(w, app, last.windowId);
    assert.equal((await other.shown.resolve(true)).ok, true);
    assert.equal((await replyTo(app, other.id)).ok, true);

    c.now += LONG - 1;
    assert.deepEqual(await blocked(w, site), COOLDOWN);
    c.now += 1;
    const later = await opens(w, site, other.shown.windowId);
    assert.equal((await later.shown.get()).result.origin, SITE);
  });

  it('a rejected token transfer or contract call counts like a send, and a barred request reads no node', async () => {
    const call = { type: 'contractCall', contract: GAME, method: 'play', args: '' };
    const token = { type: 'tokenTransfer', token: TOKEN, to: ACCOUNTS.qnet, amount: '1' };
    const transfer = { type: 'transfer', to: ACCOUNTS.qnet, amount: '1' };
    for (const params of [call, token]) {
      const c = clock();
      const w = await world(c);
      const site = w.connect(`${SITE}/`);
      const last = await rejectSeries(w, c, site, REJECTIONS - 1);
      c.now += GAP;
      // the fifth rejection is the token transfer or the contract call
      site.send({ id: 'x', method: 'qnet_sendTransaction', params });
      const shown = await w.shown({ after: last.windowId });
      assert.equal((await shown.resolve(false)).ok, true);
      assert.deepEqual(await errorOf(site, 'x'), REJECTED);
      const reads = w.log.contractReads.length;
      const recipientReads = w.log.recipientReads.length;
      // one id per request: an answer is matched by its id
      for (const [n, barred] of [call, token, transfer].entries()) {
        assert.deepEqual((await ask(site, { id: `b${n}`, method: 'qnet_sendTransaction', params: barred })).error, COOLDOWN,
          `${params.type}, then ${barred.type}`);
      }
      assert.equal(w.log.contractReads.length, reads, 'no node read during the cooldown');
      assert.equal(w.log.recipientReads.length, recipientReads, 'no recipient read during the cooldown either');
    }
  });

  it('closing the approval window counts as a rejection', async () => {
    const c = clock();
    const w = await world(c);
    const site = w.connect(`${SITE}/`);
    const first = await rejectOne(w, site, { close: true });
    assert.equal(await storedRejections(w, SITE), 1, 'counted');
    // the fifth, a closed window too, bars the origin
    c.now += GAP;
    await rejectSeries(w, c, site, REJECTIONS - 1, { after: first.windowId, closes: [REJECTIONS - 2] });
    assert.deepEqual(await blocked(w, site), COOLDOWN);
  });

  it("a single rejection ends only its own approval: the origin's waiting requests keep their turn", async () => {
    const c = clock();
    const w = await world(c);
    const site = w.connect(`${SITE}/`);
    const app = w.connect(`${APP}/`);
    const s1 = sign(site, 'one');
    const first = await w.shown();
    const s2 = sign(site, 'two');
    const a1 = sign(app, 'from app');
    await until(() => w.provider.snapshot().queued === 3);
    await first.resolve(false);
    assert.deepEqual(await errorOf(site, s1), REJECTED);
    const second = await w.shown({ after: first.windowId });
    assert.equal((await second.get()).result.origin, SITE, 'the site\'s next request gets its window');
    assert.equal((await second.resolve(true)).ok, true);
    assert.equal((await replyTo(site, s2)).ok, true);
    const third = await w.shown({ after: second.windowId });
    assert.equal((await third.get()).result.origin, APP);
    assert.equal((await third.resolve(true)).ok, true);
    assert.equal((await replyTo(app, a1)).ok, true);
  });

  it("the rejection that brings the cooldown ends the origin's waiting approvals with the cooldown error", async () => {
    const c = clock();
    const w = await world(c);
    const site = w.connect(`${SITE}/`);
    const last = await rejectSeries(w, c, site, REJECTIONS - 1);
    c.now += GAP;
    const fifth = await opens(w, site, last.windowId);
    const waiting = sign(site, 'waiting');
    await until(() => w.provider.snapshot().queued === 2);
    assert.equal((await fifth.shown.resolve(false)).ok, true);
    assert.deepEqual(await errorOf(site, fifth.id), REJECTED);
    assert.deepEqual(await errorOf(site, waiting), COOLDOWN, 'the waiting request never gets a window');
  });

  it('five rejections within 10 minutes bar the origin for 1 minute; four bar nothing', async () => {
    const c = clock();
    const w = await world(c);
    const site = w.connect(`${SITE}/`);
    const last = await rejectSeries(w, c, site, REJECTIONS - 1);
    c.now += GAP;
    const fifth = await opens(w, site, last.windowId);
    assert.equal((await fifth.shown.resolve(false)).ok, true);
    assert.deepEqual(await errorOf(site, fifth.id), REJECTED);
    assert.deepEqual(await blocked(w, site), COOLDOWN, 'the fifth rejection brings the cooldown');
    c.now += LONG - 1;
    assert.deepEqual(await blocked(w, site), COOLDOWN);
    c.now += 1;
    await opens(w, site, fifth.shown.windowId);
  });

  it('every tab of an origin shares its cooldown and its count: more tabs get no window', async () => {
    const c = clock();
    const w = await world(c);
    // Each tab is its own relay port with its own tab id; the cooldown is keyed by the sender's origin.
    const tab = (n) => {
      const url = `${SITE}/tab-${n}`;
      return w.connect(url, contentScriptSender(url, { tabId: 100 + n }));
    };
    const [a, b, d] = [tab(1), tab(2), tab(3)];
    const s1 = sign(a);
    const first = await w.shown();
    const s2 = sign(b);
    const s3 = sign(d);
    await until(() => w.provider.snapshot().queued === 3);
    assert.equal((await first.resolve(false)).ok, true);
    assert.deepEqual(await errorOf(a, s1), REJECTED);
    // a single rejection ends nothing else: the other tabs' requests get their windows in turn, and count too
    const second = await w.shown({ after: first.windowId });
    assert.equal((await second.resolve(false)).ok, true);
    assert.deepEqual(await errorOf(b, s2), REJECTED);
    const third = await w.shown({ after: second.windowId });
    assert.equal((await third.resolve(false)).ok, true);
    assert.deepEqual(await errorOf(d, s3), REJECTED);
    // two more from other tabs, one closing its window: with the first three they make five
    let last = third;
    for (let i = 1; i <= REJECTIONS - 3; i += 1) {
      c.now += GAP;
      last = await rejectOne(w, tab(3 + i), { close: i === 1, after: last.windowId });
    }
    const windows = w.log.windows.length;
    for (let n = 10; n < 18; n += 1) assert.deepEqual(await blocked(w, tab(n)), COOLDOWN, `new tab ${n}`);
    assert.equal(w.log.windows.length, windows, 'no tab got a window during the cooldown');
    c.now += LONG - 1;
    assert.deepEqual(await blocked(w, a), COOLDOWN);
    c.now += 1;
    await opens(w, tab(21), last.windowId);
  });

  it('rejections spread over more than 10 minutes bar nothing', async () => {
    const c = clock();
    const w = await world(c);
    const site = w.connect(`${SITE}/`);
    let last = null;
    // five, a quarter of the window apart: never five within it, and each opens its window
    for (let i = 0; i < REJECTIONS; i += 1) {
      if (i > 0) c.now += TIMINGS.APPROVAL_COOLDOWN_WINDOW_MS / (REJECTIONS - 1);
      last = await rejectOne(w, site, { after: last?.windowId ?? null });
    }
    await opens(w, site, last.windowId);
  });

  it('an approved action clears the cooldown and the count of rejections', async () => {
    const c = clock();
    const w = await world(c);
    const site = w.connect(`${SITE}/`);
    let last = await rejectSeries(w, c, site, REJECTIONS - 1);
    c.now += GAP;
    const approved = await opens(w, site, last.windowId);
    assert.equal((await approved.shown.resolve(true)).ok, true);
    assert.equal((await replyTo(site, approved.id)).ok, true);
    await until(() => w.chrome.storage.session.dump()[KEY] === undefined);
    // Without the clear this would be the fifth rejection within 10 minutes.
    c.now += GAP;
    last = await rejectOne(w, site, { after: approved.shown.windowId });
    await opens(w, site, last.windowId);
  });

  it('a page that goes away once its window had been shown for the confirm delay counts as a rejection (ES-03)', async () => {
    const c = clock();
    const w = await world(c);
    // a page reloading itself to open window after focused window, each let go once shown for the confirm delay
    let after = null;
    for (let cycle = 1; cycle <= REJECTIONS; cycle += 1) {
      if (cycle > 1) c.now += GAP;
      const page = w.connect(`${SITE}/?reload=${cycle}`);
      // it opens: the cycles before bar nothing
      const pending = await opens(w, page, after);
      // the approval page loaded (approval.get): the confirm delay counts from what it drew
      await pending.shown.get();
      c.now += TIMINGS.CONFIRM_ARM_MS;
      page.close();
      await until(() => w.log.removed.includes(pending.shown.windowId));
      after = pending.shown.windowId;
      assert.equal(await storedRejections(w, SITE), cycle, `cycle ${cycle} counted`);
    }
    // the fifth within the window bars the origin
    assert.deepEqual(await blocked(w, w.connect(`${SITE}/later`)), COOLDOWN);
    c.now += LONG;
    await opens(w, w.connect(`${SITE}/much-later`), after);
  });

  it('a page that goes away before the confirm delay, or while its approval only waits, counts nothing', async () => {
    const c = clock();
    const w = await world(c);
    const first = w.connect(`${SITE}/a`);
    const shown = await opens(w, first);
    const second = w.connect(`${SITE}/b`);
    sign(second);
    await until(() => w.provider.snapshot().queued === 2);
    second.close();
    await until(() => w.provider.snapshot().queued === 1);
    c.now += TIMINGS.CONFIRM_ARM_MS - 1;
    first.close();
    await until(() => w.log.removed.includes(shown.shown.windowId));
    assert.equal(await storedRejections(w, SITE), 0, 'counted nothing');
    await opens(w, w.connect(`${SITE}/c`), shown.shown.windowId);
  });

  it('a timeout, a page closed at once or a wipe counts no rejection', async () => {
    const c = clock();
    const w = await world(c);
    const site = w.connect(`${SITE}/`);
    const timedOut = await opens(w, site);
    c.now += TIMINGS.APPROVAL_TIMEOUT_MS;
    w.fireTimers(TIMINGS.APPROVAL_TIMEOUT_MS);
    assert.deepEqual(await errorOf(site, timedOut.id), REJECTED);
    assert.equal(await storedRejections(w, SITE), 0, 'a timeout counts nothing');
    const gone = w.connect(`${SITE}/gone`);
    const closed = await opens(w, gone, timedOut.shown.windowId);
    gone.close();
    await until(() => w.log.removed.includes(closed.shown.windowId));
    assert.equal(await storedRejections(w, SITE), 0, 'nor does a page closed at once');
    const next = await opens(w, site, closed.shown.windowId);
    await w.provider.notifyLockChanged({ locked: true, reason: 'wipe' });
    await settleAll();
    assert.deepEqual(await errorOf(site, next.id), { code: 4900, message: 'Disconnected' });
    await opens(w, site, next.shown.windowId);
  });

  it('survives a worker restart through storage.session; malformed or foreign entries are ignored', async () => {
    const c = clock();
    const w = await world(c);
    const site = w.connect(`${SITE}/`);
    const start = c.now;
    await rejectSeries(w, c, site, REJECTIONS);
    await until(() => w.chrome.storage.session.dump()[KEY]?.[SITE]?.rejections.length === REJECTIONS);
    const stored = w.chrome.storage.session.dump()[KEY];
    const times = Array.from({ length: REJECTIONS }, (_, i) => start + i * GAP);
    // windows: the approval windows of the origin that ended without an approved action (R2-ERP-01)
    assert.deepEqual(stored, { [SITE]: { rejections: times, until: c.now + LONG, windows: times } });

    const restarted = await world(c);
    await restarted.chrome.storage.session.set({ [KEY]: stored });
    const port = restarted.connect(`${SITE}/`);
    assert.deepEqual(await blocked(restarted, port), COOLDOWN);
    c.now += LONG;
    await opens(restarted, port);

    const junk = await world(c);
    await junk.chrome.storage.session.set({
      [KEY]: {
        [SITE]: { rejections: ['x'], until: c.now + LONG },
        [APP]: { rejections: [], until: String(c.now + LONG) },
        [`${SITE}/`]: { rejections: [c.now], until: c.now + LONG },
      },
    });
    const sitePort = junk.connect(`${SITE}/`);
    const appPort = junk.connect(`${APP}/`);
    const opened = await opens(junk, sitePort);
    assert.equal((await opened.shown.resolve(true)).ok, true);
    await opens(junk, appPort, opened.shown.windowId);
  });

  it('a page reloading before the confirm arms, window after window, spends its budget, each window from its second a rejection (R2-EXT-UI-02)', async () => {
    const c = clock();
    const w = await world(c);
    // a window opens and its page reloads 800 ms later, before the confirm arms
    const flash = async (name, after) => {
      const page = w.connect(`${SITE}/?reload=${name}`);
      const opened = await opens(w, page, after);
      c.now += 800;
      page.close();
      await until(() => w.log.removed.includes(opened.shown.windowId));
      return opened.shown.windowId;
    };
    let after = null;
    for (let i = 1; i <= LIMITS.APPROVAL_BUDGET_SHORT; i += 1) {
      after = await flash(i, after);
      assert.equal(await storedRejections(w, SITE), i - 1, `window ${i}: the first counts nothing, each later one a rejection`);
    }
    assert.deepEqual(await blocked(w, w.connect(`${SITE}/?reload=next`)), COOLDOWN, 'the budget of a minute is spent');
    assert.equal(w.log.windows.length, LIMITS.APPROVAL_BUDGET_SHORT);
    // a minute on, the budget has room again and the rejections still count: the first window of the new minute counts
    // nothing, the second is the fifth rejection within 10 minutes
    c.now += TIMINGS.APPROVAL_BUDGET_SHORT_MS;
    after = await flash('later-1', after);
    after = await flash('later-2', after);
    assert.equal(await storedRejections(w, SITE), REJECTIONS);
    assert.deepEqual(await blocked(w, w.connect(`${SITE}/?reload=last`)), COOLDOWN, 'the fifth rejection bars the origin');
  });

  it('every window counts against the budget of its origin, however it ends: 5 a minute, 20 in ten minutes (R2-ERP-01)', async () => {
    const c = clock();
    const w = await world(c);
    const site = w.connect(`${SITE}/`);
    let after = null;
    // windows that time out count no rejection, but each counts against the budget
    for (let i = 0; i < LIMITS.APPROVAL_BUDGET_SHORT; i += 1) {
      const opened = await opens(w, site, after);
      w.fireTimers(TIMINGS.APPROVAL_TIMEOUT_MS);
      assert.deepEqual(await errorOf(site, opened.id), REJECTED);
      after = opened.shown.windowId;
    }
    assert.deepEqual(await blocked(w, site), COOLDOWN, 'the sixth within a minute opens no window');
    const app = w.connect(`${APP}/`);
    const other = await opens(w, app, after);
    assert.equal((await other.shown.resolve(false)).ok, true, 'another origin is not affected');
    after = other.shown.windowId;
    c.now += TIMINGS.APPROVAL_BUDGET_SHORT_MS;
    // later windows, two a minute: the long budget ends it at 20 within ten minutes
    for (let i = LIMITS.APPROVAL_BUDGET_SHORT; i < LIMITS.APPROVAL_BUDGET_LONG; i += 1) {
      const opened = await opens(w, site, after);
      w.fireTimers(TIMINGS.APPROVAL_TIMEOUT_MS);
      await errorOf(site, opened.id);
      after = opened.shown.windowId;
      c.now += TIMINGS.APPROVAL_BUDGET_SHORT_MS / 2;
    }
    assert.deepEqual(await blocked(w, site), COOLDOWN);
    c.now += TIMINGS.APPROVAL_COOLDOWN_WINDOW_MS;
    const later = await opens(w, site, after);
    // an approved action takes the origin's windows off its budget
    assert.equal((await later.shown.resolve(true)).ok, true);
    assert.equal((await replyTo(site, later.id)).ok, true);
    await until(() => w.chrome.storage.session.dump()[KEY] === undefined);
  });

  // R3-ERP-01: the page goes away while windows.create is still pending; the window then opens (and steals the
  // focus) for an approval already ended, and is closed at once. It must count against the budget all the same.
  it('a window created after its approval ended counts against the budget too (R3-ERP-01)', async () => {
    const c = clock();
    const w = await world(c);
    const create = w.chrome.windows.create;
    let release = null;
    w.chrome.windows.create = async (data) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return create(data);
    };
    for (let i = 0; i < LIMITS.APPROVAL_BUDGET_SHORT; i += 1) {
      const port = w.connect(`${SITE}/?flash=${i}`);
      const before = w.log.windows.length;
      sign(port);
      await until(() => release !== null);
      port.close();
      await settleAll();
      const open = release;
      release = null;
      open();
      await until(() => w.log.windows.length === before + 1 && w.log.removed.includes(w.log.windows.at(-1).id));
    }
    w.chrome.windows.create = create;
    assert.deepEqual(await blocked(w, w.connect(`${SITE}/?flash=last`)), COOLDOWN, 'the flashed windows spent the budget');
  });

  // R3-ERP-02: the user closes the window while its confirm runs, and the confirm then ends in a retry the window
  // would have offered. The request ends as a closed window ends it; it never waits for another origin's request
  // to pop up again.
  it('a window closed while its confirm runs ends the request when the confirm asks to retry (R3-ERP-02)', async () => {
    const c = clock();
    const w = await world(c);
    const site = w.connect(`${SITE}/`);
    const id = 'send-1';
    site.send({ id, method: 'qnet_sendTransaction', params: { to: ACCOUNTS.qnet, amount: '1' } });
    const shown = await w.shown();
    await shown.get();
    let open;
    w.state.gates.unlock = new Promise((resolve) => {
      open = resolve;
    });
    const confirming = shown.resolve(true);
    await settleAll();
    await w.userCloses(shown.windowId);
    w.state.nonce = '6';
    open();
    w.state.gates.unlock = null;
    assert.equal((await confirming).ok, false, 'the page, if it were still there, would hear NONCE_CHANGED');
    assert.deepEqual((await replyTo(site, id)).error, REJECTED, 'the dApp hears the closed window');
    assert.equal(w.provider.snapshot().queued, 0, 'nothing waits in the queue');
    assert.equal(await storedRejections(w, SITE), 1, 'counted as the rejection a closed window is');
    // another origin's request opens its own approval, not the dismissed send
    const app = w.connect(`${APP}/`);
    const other = await opens(w, app, shown.windowId);
    assert.equal((await other.shown.get()).result.origin, APP);
  });

  it('an activation whose window closed during a locked or price-changed confirm ends as closed (R3-ERP-02)', async () => {
    for (const failure of ['LOCKED', 'PRICE_CHANGED']) {
      const c = clock();
      const w = await world(c);
      const site = w.connect(`${SITE}/`);
      const id = `act-${failure}`;
      site.send({ id, method: 'qnet_activateNode', params: { nodeType: 'light' } });
      const shown = await w.shown();
      await shown.get();
      let open;
      w.state.gates.unlock = new Promise((resolve) => {
        open = resolve;
      });
      if (failure === 'PRICE_CHANGED') {
        const { WalletError } = await import('../dist/background/errors.js');
        w.state.activateError = new WalletError('PRICE_CHANGED');
      }
      const confirming = shown.resolve(true);
      await settleAll();
      await w.userCloses(shown.windowId);
      // LOCKED: the wallet locked while the confirm waited for the session
      if (failure === 'LOCKED') w.state.unlocked = false;
      open();
      w.state.gates.unlock = null;
      assert.equal((await confirming).ok, false);
      assert.deepEqual((await replyTo(site, id)).error, REJECTED, failure);
      assert.equal(w.provider.snapshot().queued, 0, failure);
    }
  });

  // Decision 37 (owner, 30.09): the approval opens under the extension's toolbar icon, the top-right corner of a
  // browser window, 16 px from its right edge and 72 px below its top, kept wholly inside a window of at least 400x640.
  // Knowing that place does not let a page aim at Confirm: the gap above the actions is drawn at random with every view
  // and Confirm arms only after its delay (R2-ERP-02, provider-approve-page).
  it('opens the window under the toolbar icon, the top-right corner of the requesting browser window (decision 37)', async () => {
    const c = clock();
    const w = await world(c);
    let box = { left: 100, top: 50, width: 1400, height: 900 };
    w.chrome.tabs.get = async (tabId) => ({ id: tabId, windowId: 7 });
    w.chrome.windows.get = async (windowId) => ({ id: windowId, ...box });
    const site = w.connect(`${SITE}/`);
    let after = null;
    const cases = [
      // left + width - 400 - 16, top + 72
      [{ left: 100, top: 50, width: 1400, height: 900 }, { left: 1084, top: 122 }],
      [{ left: 100, top: 50, width: 1400, height: 900 }, { left: 1084, top: 122 }],
      // a window on a display left of and above the primary one
      [{ left: -1920, top: -300, width: 1920, height: 1040 }, { left: -416, top: -228 }],
      // lower than 640 + 72: the gap shrinks so the approval ends at the window's bottom edge
      [{ left: 0, top: 0, width: 1000, height: 680 }, { left: 584, top: 40 }],
      // narrower than 400 + 16: at the window's left edge
      [{ left: 30, top: 10, width: 410, height: 700 }, { left: 30, top: 70 }],
    ];
    for (const [window, place] of cases) {
      box = window;
      const opened = await opens(w, site, after);
      const win = w.log.windows.find((x) => x.id === opened.shown.windowId);
      assert.deepEqual({ left: win.left, top: win.top }, place, JSON.stringify(window));
      assert.ok(win.left >= box.left && win.left + 400 <= box.left + box.width, 'wholly inside the window');
      assert.ok(win.top >= box.top && win.top + 640 <= box.top + box.height, 'wholly inside the window');
      assert.equal((await opened.shown.resolve(true)).ok, true);
      await replyTo(site, opened.id);
      after = opened.shown.windowId;
    }
    // without the requesting window, Chrome's default placement
    w.chrome.tabs.get = async () => {
      throw new Error('No tab with id');
    };
    const plain = await opens(w, site, after);
    const win = w.log.windows.find((x) => x.id === plain.shown.windowId);
    assert.equal(win.left, undefined);
    assert.equal(win.top, undefined);
  });

  // R4-ERP-01: a page can open itself in a popup window of any size and place; a corner taken from that window would let
  // the page choose the spot exactly, so the approval opens under the toolbar icon of the user's normal window.
  it('places the approval under the toolbar icon of the user\'s normal window, never on a spot a requesting popup window fixes (R4-ERP-01)', async () => {
    const c = clock();
    const w = await world(c);
    const normal = { id: 1, type: 'normal', state: 'maximized', left: 0, top: 0, width: 1920, height: 1040 };
    for (const size of [{ width: 400, height: 640 }, { width: 404, height: 646 }]) {
      const popup = { id: 7, type: 'popup', state: 'normal', left: 900, top: 120, focused: true, ...size };
      w.chrome.tabs.get = async (tabId) => ({ id: tabId, windowId: 7 });
      w.chrome.windows.get = async () => ({ ...popup });
      w.chrome.windows.getAll = async (filter) => {
        assert.deepEqual(filter, { windowTypes: ['normal'] });
        // a minimized normal window is never chosen; Chrome lists no popup here, and one listed all the same is skipped
        return [{ ...normal }, { id: 9, type: 'normal', state: 'minimized', left: -32000, top: -32000, width: 160, height: 28 },
          { ...popup }];
      };
      const site = w.connect(`${SITE}/`);
      let after = w.provider.snapshot().windowId;
      for (let i = 0; i < 4; i += 1) {
        const opened = await opens(w, site, after);
        const win = w.log.windows.find((x) => x.id === opened.shown.windowId);
        assert.deepEqual({ left: win.left, top: win.top }, { left: 1920 - 400 - 16, top: 72 }, 'the normal window\'s corner');
        const popupCorner = {
          left: popup.left + Math.max(0, popup.width - 400 - 16), top: popup.top + Math.min(72, Math.max(0, popup.height - 640)),
        };
        assert.notDeepEqual({ left: win.left, top: win.top }, popupCorner, 'never the popup\'s corner');
        assert.equal((await opened.shown.resolve(true)).ok, true);
        await replyTo(site, opened.id);
        after = opened.shown.windowId;
      }
    }
    // no normal window readable and the request comes from a popup window: Chrome's own placement, never the popup's spot
    w.chrome.windows.getAll = async () => {
      throw new Error('unavailable');
    };
    const site = w.connect(`${SITE}/`);
    const plain = await opens(w, site, w.provider.snapshot().windowId);
    const win = w.log.windows.find((x) => x.id === plain.shown.windowId);
    assert.equal(win.left, undefined);
    assert.equal(win.top, undefined);
  });

  // ERP-R5-01: the box around all normal windows spans screen space no display covers when the displays differ in size
  // or offset; Chrome refuses bounds less than half on a display, and the request failed with INTERNAL, no window. The
  // corner of one window lies on that window's display (decision 37).
  it('places the approval under the toolbar icon of one normal window, and falls back to Chrome\'s placement when refused (ERP-R5-01)', async () => {
    const c = clock();
    const w = await world(c);
    // a 1366x768 laptop screen at (0,0) and a 2560x1440 monitor to its right, 400 px higher, one normal window on each
    const displays = [{ left: 0, top: 0, width: 1366, height: 768 }, { left: 1366, top: -400, width: 2560, height: 1440 }];
    const laptop = { id: 1, type: 'normal', state: 'normal', left: 0, top: 0, width: 1366, height: 728 };
    const monitor = { id: 2, type: 'normal', state: 'maximized', left: 1366, top: -400, width: 2560, height: 1400 };
    const corners = { laptop: { left: 1366 - 416, top: 72 }, monitor: { left: 1366 + 2560 - 416, top: -400 + 72 } };
    const visible = (b) => displays.reduce((sum, d) => sum
      + Math.max(0, Math.min(b.left + b.width, d.left + d.width) - Math.max(b.left, d.left))
      * Math.max(0, Math.min(b.top + b.height, d.top + d.height) - Math.max(b.top, d.top)), 0);
    const create = w.chrome.windows.create;
    const refused = [];
    w.chrome.windows.create = async (data) => {
      if (data.left !== undefined && visible({ left: data.left, top: data.top, width: data.width, height: data.height }) * 2
        < data.width * data.height) {
        refused.push(data);
        throw new Error('Invalid value for bounds. Bounds must be at least 50% within visible screen space.');
      }
      return create(data);
    };
    let windows = [{ ...laptop }, { ...monitor }];
    w.chrome.windows.getAll = async () => windows.map((x) => ({ ...x }));
    const inside = (win, box) => win.left >= box.left && win.left + 400 <= box.left + box.width
      && win.top >= box.top && win.top + 640 <= box.top + box.height;
    const placeOf = (opened) => {
      const win = w.log.windows.find((x) => x.id === opened.shown.windowId);
      return { left: win.left, top: win.top };
    };
    const site = w.connect(`${SITE}/`);
    let after = w.provider.snapshot().windowId;
    const approve = async (opened) => {
      assert.equal((await opened.shown.resolve(true)).ok, true);
      await replyTo(site, opened.id);
      after = opened.shown.windowId;
    };
    const used = new Set();
    for (let i = 0; i < 40; i += 1) {
      const opened = await opens(w, site, after);
      const place = placeOf(opened);
      const name = Object.keys(corners).find((key) => place.left === corners[key].left && place.top === corners[key].top);
      assert.ok(name, `the corner of one window: ${place.left},${place.top}`);
      assert.ok(inside(place, name === 'laptop' ? laptop : monitor));
      used.add(name);
      await approve(opened);
    }
    assert.deepEqual(refused, [], 'never a place Chrome refuses');
    assert.equal(used.size, 2, 'either window, at random, when none has the focus');
    // the focused one when the user works in one
    windows = [{ ...laptop }, { ...monitor, focused: true }];
    for (let i = 0; i < 4; i += 1) {
      const opened = await opens(w, site, after);
      assert.deepEqual(placeOf(opened), corners.monitor);
      await approve(opened);
    }
    // a smaller focused window on the laptop: its corner, the gap below its top cut so the approval ends at its bottom
    const small = { id: 4, type: 'normal', state: 'normal', left: 200, top: 40, width: 900, height: 700, focused: true };
    windows = [{ ...small }, { ...monitor }];
    const opened = await opens(w, site, after);
    assert.deepEqual(placeOf(opened), { left: 200 + 900 - 416, top: 40 + 60 });
    assert.ok(inside(placeOf(opened), small));
    await approve(opened);
    assert.deepEqual(refused, []);
    // a place refused all the same (a window hanging off its display): Chrome's default placement, not a failure
    windows = [{ id: 3, type: 'normal', state: 'normal', left: -1200, top: 500, width: 1300, height: 700, focused: true }];
    const plain = await opens(w, site, after);
    assert.equal(refused.length, 1);
    assert.deepEqual({ left: refused[0].left, top: refused[0].top }, { left: -1200 + 1300 - 416, top: 500 + 60 });
    assert.deepEqual(placeOf(plain), { left: undefined, top: undefined });
    assert.equal((await plain.shown.resolve(true)).ok, true);
    w.chrome.windows.create = create;
  });

  it('a clock set back cannot stretch a cooldown beyond the long cooldown (1 minute)', async () => {
    const c = clock();
    const w = await world(c);
    await w.chrome.storage.session.set({ [KEY]: { [SITE]: { rejections: [c.now], until: c.now + 365 * 86_400_000 } } });
    const site = w.connect(`${SITE}/`);
    assert.deepEqual(await blocked(w, site), COOLDOWN);
    c.now += LONG - 1;
    assert.deepEqual(await blocked(w, site), COOLDOWN);
    c.now += 1;
    await opens(w, site);
  });
});
