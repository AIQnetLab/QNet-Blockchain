/**
 * One press of Move to wallet (src/services/MoveRun.js): the run the Node tab's card and a QNet Link claim sheet share. Each part goes once the part before is in the wallet, quoted from its last epoch; the run stops on a lock,
 * a refusal, an epoch the nodes cannot serve, a part not taken in whole, the balance shown, or the sheet's deadline,
 * which never decides a part's fate. The screen's wiring is App1110.test.js (Node tab) and LinkClaimRun.test.js (sheet).
 */
const { lastCountedPart, runMove, runMovedNano } = require('../src/services/MoveRun');
const { BEHIND_TRIES, BEHIND_WAIT_MS } = require('../src/utils/claimRun');
const { H1, H2, H3, part } = require('../test-support/moveRun');

const W = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const NODE = 'light_mobile_1111222233334444';
const coded = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

// The run over `answers` (each claim's answer in turn; an Error is thrown), with what the test says of each part's fate.
const outcome = (result, appliedNano = 0) => ({ result, appliedNano });
function harness(answers, { balanceNano = 9e9, until = null, settledAs = async () => outcome('done'), clock = { now: 1000 } } = {}) {
  const log = [];
  const state = { session: 'session-token', live: true };
  const walletManager = {
    claimRewards: jest.fn(async (...args) => {
      log.push(['claim', args[5].after]);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  const steps = {
    walletManager,
    credential: () => state.session,
    record: jest.fn(() => true),
    settled: jest.fn(async (txHash, u) => { log.push(['settled', txHash, u]); return settledAs(txHash, state, clock); }),
    pause: jest.fn(async (ms) => { log.push(['pause', ms]); }),
    live: () => state.live,
    signing: jest.fn(),
    onPart: jest.fn(),
    now: () => clock.now,
  };
  const go = () => runMove(steps, { nodeType: 'light', nodeId: NODE, walletAddress: W, balanceNano, until });
  return { walletManager, steps, state, log, go, clock };
}

describe('the parts of one press', () => {
  it('three parts, each quoted from the last epoch of the one before once it is in the wallet: the whole balance, exact', async () => {
    const h = harness([part('3000000000', 100, 612, H1, 'batch_full'), part('3000000000', 612, 1124, H2, 'quote_byte_budget'),
      part('3000000000', 1124, 1300, H3)]);
    const run = await h.go();
    expect(h.log).toEqual([['claim', null], ['settled', H1, null], ['claim', 612], ['settled', H2, null], ['claim', 1124]]);
    expect(h.walletManager.claimRewards.mock.calls.map((c) => c.slice(0, 5))).toEqual([
      ['light', W, 'session-token', 9e9, NODE], ['light', W, 'session-token', null, NODE], ['light', W, 'session-token', null, NODE],
    ]);
    expect(run).toEqual({
      parts: [
        { txHash: H1, amountNano: '3000000000', lastEpoch: 612, stoppedAtEpoch: 613 },
        { txHash: H2, amountNano: '3000000000', lastEpoch: 1124, stoppedAtEpoch: 1125 },
        { txHash: H3, amountNano: '3000000000', lastEpoch: 1300, stoppedAtEpoch: null },
      ],
      movedNano: 9000000000n, whole: true, stop: null, settled: null, live: true, refused: null,
    });
    // Each part in transit with the rest of the balance shown, and said as it went.
    expect(h.steps.record.mock.calls.map((c) => [c[0], c[1].txHash, c[2]])).toEqual([[NODE, H1, 9e9], [NODE, H2, 6e9], [NODE, H3, 3e9]]);
    expect(h.steps.onPart.mock.calls.map(([v]) => [v.parts.length, v.movedNano, v.more])).toEqual([[1, 3000000000n, true],
      [2, 6000000000n, true], [3, 9000000000n, false]]);
    // Only a claim being quoted, signed and sent holds what the user waits on, never the wait for a block.
    expect(h.steps.signing.mock.calls.map((c) => c[0])).toEqual([true, false, true, false, true, false]);
  });

  it('a lock before the next part: that part is not sent', async () => {
    const h = harness([part('3000000000', 100, 612, H1, 'batch_full'), part('2000000000', 612, 700, H2)], {
      settledAs: async (txHash, state) => { state.session = null; return outcome('done'); },
    });
    const run = await h.go();
    expect([h.walletManager.claimRewards.mock.calls.length, run.stop, run.whole, run.movedNano]).toEqual([1, { ended: true }, false, 3000000000n]);
  });

  it('the next part refused, or sent with no answer, ends the run with the reason; nothing left is the whole balance', async () => {
    for (const [second, stop, whole] of [
      [coded('RATE_LIMITED'), { code: 'RATE_LIMITED' }, false],
      [{ success: false, code: 'RATE_LIMITED' }, { code: 'RATE_LIMITED' }, false],
      [coded('late', { code: undefined, unknown: true }), { unknown: true }, false],
      [coded('NO_REWARDS'), null, true],
      [{ success: false, code: 'NO_REWARDS' }, null, true],
    ]) {
      const run = await harness([part('3000000000', 100, 612, H1, 'batch_full'), second]).go();
      expect([run.parts.length, run.stop, run.whole]).toEqual([1, stop, whole]);
    }
  });

  it('every node behind the last part is asked again BEHIND_TRIES times, BEHIND_WAIT_MS apart, then it ends', async () => {
    expect([BEHIND_TRIES, BEHIND_WAIT_MS]).toEqual([2, 3000]);
    const behind = () => coded('CLAIM_BEHIND');
    const caught = harness([part('3000000000', 100, 612, H1, 'batch_full'), behind(), behind(), part('2000000000', 612, 700, H2)]);
    const run = await caught.go();
    expect(caught.log.filter((e) => e[0] === 'pause')).toEqual([['pause', 3000], ['pause', 3000]]);
    expect([run.parts.length, run.whole, caught.log.filter((e) => e[0] === 'claim').map((e) => e[1])]).toEqual([2, true, [null, 612, 612, 612]]);
    const stuck = await harness([part('3000000000', 100, 612, H1, 'batch_full'), behind(), behind(), behind()]).go();
    expect([stuck.parts.length, stuck.stop]).toEqual([1, { code: 'CLAIM_BEHIND' }]);
  });

  it('it ends with the balance shown, at an epoch the nodes cannot serve, or with a part the screen does not follow', async () => {
    const covered = harness([part('3000000000', 100, 612, H1, 'batch_full'), part('1', 612, 613, H2)], { balanceNano: 3e9 });
    expect(await covered.go()).toMatchObject({ whole: false, stop: null, movedNano: 3000000000n });
    expect(covered.walletManager.claimRewards).toHaveBeenCalledTimes(1);
    const unservable = harness([part('3000000000', 100, 612, H1, 'root_not_here'), part('1', 612, 613, H2)]);
    expect(await unservable.go()).toMatchObject({ whole: false, stop: null });
    expect([unservable.walletManager.claimRewards.mock.calls.length, unservable.steps.settled.mock.calls.length]).toEqual([1, 0]);
    const unfollowed = harness([part('3000000000', 100, 612, H1, 'batch_full'), part('1', 612, 613, H2)]);
    unfollowed.steps.record.mockImplementation(() => false);
    await unfollowed.go();
    expect(unfollowed.walletManager.claimRewards).toHaveBeenCalledTimes(1);
  });

  it('a part not taken in whole, or that no block took in time, ends the run with what became of it', async () => {
    for (const fate of ['partial', 'expired']) {
      const run = await harness([part('3000000000', 100, 612, H1, 'batch_full'), part('1', 612, 613, H2)], { settledAs: async () => outcome(fate) }).go();
      expect([run.parts.length, run.settled, run.stop]).toEqual([1, fate, null]);
    }
    // The record's share of it and where its rest begins, which the answer counts; the submitted total stays.
    const first = { ...part('3000000000', 100, 612, H1, 'batch_full'), parts: [[101, '1000000000'], [300, '1000000000'], [612, '1000000000']] };
    const partial = await harness([first], { settledAs: async () => outcome('partial', 1000000000) }).go();
    expect([partial.parts[0].takenNano, partial.parts[0].restEpoch, partial.movedNano]).toEqual(['1000000000', 300, 3000000000n]);
    const expired = await harness([first], { settledAs: async () => outcome('expired') }).go();
    expect([expired.parts[0].takenNano, expired.parts[0].restEpoch]).toEqual(['0', null]);
  });

  it('the first part\'s error is thrown; its refusal is the run\'s answer; a run the screen let go of stops', async () => {
    await expect(harness([coded('late', { code: undefined, unknown: true })]).go()).rejects.toMatchObject({ unknown: true });
    const refused = await harness([{ success: false, code: 'MIN_CLAIM' }]).go();
    expect([refused.refused, refused.parts]).toEqual([{ success: false, code: 'MIN_CLAIM' }, []]);
    const gone = harness([part('3000000000', 100, 612, H1, 'batch_full'), part('1', 612, 613, H2)]);
    gone.steps.record.mockImplementation(() => { gone.state.live = false; return true; });
    const run = await gone.go();
    // The part the network took still counts in the run's total.
    expect([run.live, run.parts.length, run.movedNano, gone.steps.onPart.mock.calls.length]).toEqual([false, 1, 3000000000n, 0]);
  });
});

// What a run put in the wallet and the claim it names, one rule for the QNet Link answer and the Node tab's card: each
// part by its record now (ClaimTransit.moveOutcome), else by what the run saw of it.
describe('what a run put in the wallet', () => {
  const sent = (txHash, amountNano, extra = {}) => ({ txHash, amountNano, lastEpoch: 1, stoppedAtEpoch: null, ...extra });
  const run = { parts: [sent(H1, '3000000000'), sent(H2, '2000000000')] };
  const records = (byHash) => (hash) => byHash[hash] || null;

  it('by the run alone: what each part submitted, a last part taken in part its share, one that expired nothing', () => {
    expect([runMovedNano(run), lastCountedPart(run)]).toEqual([5000000000n, run.parts[1]]);
    const partial = { parts: [run.parts[0], { ...run.parts[1], takenNano: '1500000000' }] };
    expect([runMovedNano(partial), lastCountedPart(partial).txHash]).toEqual([4500000000n, H2]);
    const expired = { parts: [run.parts[0], { ...run.parts[1], takenNano: '0' }] };
    expect([runMovedNano(expired), lastCountedPart(expired).txHash]).toEqual([3000000000n, H1]);
    const alone = { parts: [{ ...run.parts[0], takenNano: '0' }] };
    expect([runMovedNano(alone), lastCountedPart(alone)]).toEqual([0n, null]);
  });

  it('by the records now: a last part the run did not wait for counts as its record says, over what the run saw', () => {
    const late = records({ [H1]: outcome('done', 3e9), [H2]: outcome('expired') });
    expect([runMovedNano(run, late), lastCountedPart(run, late).txHash]).toEqual([3000000000n, H1]);
    expect(runMovedNano(run, records({ [H2]: outcome('partial', 1e9) }))).toBe(4000000000n);
    // Back in transit (a certified read showed less): what it submitted, and its hash again.
    const back = { parts: [run.parts[0], { ...run.parts[1], takenNano: '0' }] };
    const moving = records({ [H2]: { result: 'moving' } });
    expect([runMovedNano(back, moving), lastCountedPart(back, moving).txHash]).toEqual([5000000000n, H2]);
  });
});

// A QNet Link claim answers once, inside its session: a next part starts only before `until`, and a wait for a part's
// block ends there, the part staying in transit.
describe('the deadline of a QNet Link claim', () => {
  it('passed before the next part: that part is not sent', async () => {
    const h = harness([part('3000000000', 100, 612, H1, 'batch_full'), part('2000000000', 612, 700, H2)], {
      until: 5000, settledAs: async (txHash, state, clock) => { clock.now = 5000; return outcome('done'); },
    });
    const run = await h.go();
    expect([h.walletManager.claimRewards.mock.calls.length, run.stop]).toEqual([1, { ended: true }]);
    expect(h.steps.settled).toHaveBeenCalledWith(H1, 5000);
  });

  it('reached while the part waits for its block: the run ends with that part in transit', async () => {
    const run = await harness([part('3000000000', 100, 612, H1, 'batch_full'), part('2000000000', 612, 700, H2)], {
      until: 5000, settledAs: async () => null,
    }).go();
    expect([run.parts.length, run.stop, run.settled, run.whole, run.live]).toEqual([1, null, null, false, true]);
  });

  it('the first part goes whatever is left of it', async () => {
    const h = harness([part('3000000000', 100, 612, H1)], { until: 500, clock: { now: 1000 } });
    expect(await h.go()).toMatchObject({ whole: true, movedNano: 3000000000n });
    expect(h.walletManager.claimRewards).toHaveBeenCalledTimes(1);
  });
});
