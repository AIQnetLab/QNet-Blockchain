/**
 * A move of a node balance in transit (owner, 11.10 and 18.10; services/ClaimTransit): in transit from the moment the
 * network took it until the wallet's live figure (a genesis node's live tip, its proof folded) shows its claim watermark
 * at the batch's last epoch (done) or past its start only (in part). Its record stays until a certified read settles it
 * and raises the wallet's durable watermark, in the background. Nothing else ends it, neither the clock nor nodes'
 * answers of the node balance (owner, 12.10: a QNet transaction has no consensus expiry yet, so there is no "did not go
 * through"). The wallet's watermark judges every node balance answer. The live watermark is one node's word: held in
 * memory only, and a certified read of its height or later that shows less puts the move back in transit. The rules
 * alone, without the screen; the screen itself is App1110.test.js.
 */
const AsyncStorage = require('@react-native-async-storage/async-storage');
const {
  TRANSIT_KEY, OUTCOME_KEEP_MS, emptyTransit, transitRecord, addMove, settleMoves, heldMove, transitTotal, withMoveStates,
  readTransit, writeTransit, balanceAnswerCounts, acceptedBalance, noteLiveWatermark, moveOutcome, moveNote, answerFloor,
} = require('../src/services/ClaimTransit');
const ClaimTransit = require('../src/services/ClaimTransit');

const W = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const W2 = 'aa00370374e24333242eon847d1d354dcd87fe8738bbb';
const LIGHT = 'light_mobile_1111222233334444';
const SUPER = 'super_node_5555666677778888';
const HASH = 'ab'.repeat(32);
const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);
// The batch signed: epochs 101, 102 and 103 above the epoch 100 below its first one, 12.5 QNC in all.
const PARTS = [[101, '2500000000'], [102, '4000000000'], [103, '6000000000']];
const result = (over = {}) => ({
  success: true, amountNano: '12500000000', prevWatermark: 100, lastEpoch: 103, parts: PARTS, txHash: HASH, ...over,
});
const answer = (pendingRewards, firstUnclaimedEpoch) => ({ success: true, pendingRewards, firstUnclaimedEpoch });
// The height of the live figure whose watermark the tests note.
const LIVE_AT = 9100;

describe('the record of a move', () => {
  it('names the node, the amount, the epoch below the batch, its last epoch, its parts, the hash and the time', () => {
    expect(transitRecord({ nodeId: LIGHT, result: result(), balanceNano: 13e9, now: T0 })).toEqual({
      nodeId: LIGHT, amountNano: '12500000000', restNano: 5e8, prevWatermark: 100, lastEpoch: 103, parts: PARTS, txHash: HASH,
      time: T0,
    });
    // The amount in QNC when the answer names no nano figure; no balance read: no rest to show; parts that do not add up
    // to the amount, or skip below the batch, are not kept (the whole amount stands for the move).
    expect(transitRecord({ nodeId: LIGHT, result: result({ amountNano: null, amount: 2.5, parts: null }), now: T0 }))
      .toMatchObject({ amountNano: '2500000000', restNano: null, parts: null });
    expect(transitRecord({ nodeId: LIGHT, result: result({ parts: [[101, '1']] }), now: T0 }).parts).toBe(null);
    expect(transitRecord({ nodeId: LIGHT, result: result({ parts: [[100, '6500000000'], [103, '6000000000']] }), now: T0 }).parts).toBe(null);
  });

  it('is no record when the answer names no batch to follow, or nothing moved', () => {
    for (const r of [result({ prevWatermark: null }), result({ lastEpoch: 100 }), result({ lastEpoch: 'x' }), result({ amountNano: '0' }),
      result({ success: false }), null]) {
      expect(transitRecord({ nodeId: LIGHT, result: r, now: T0 })).toBe(null);
    }
    expect(transitRecord({ nodeId: '', result: result(), now: T0 })).toBe(null);
  });
});

describe('what a certified read tells of it', () => {
  const held = () => addMove(emptyTransit(W), transitRecord({ nodeId: LIGHT, result: result(), balanceNano: 13e9, now: T0 }));

  it('a watermark at or past the last epoch: done; past the start only: in part, with what came back to the node', () => {
    expect(settleMoves(held(), { lastClaimedEpoch: 103, now: T0 + 1000 }).settled)
      .toEqual([{ move: expect.objectContaining({ nodeId: LIGHT }), result: 'done', returnedNano: 0, liveSeen: false }]);
    expect(settleMoves(held(), { lastClaimedEpoch: 120, now: T0 + 1000 }).settled[0].result).toBe('done');
    // Epoch 101 went through: 2.5 QNC in the wallet, 10 QNC back on the node.
    expect(settleMoves(held(), { lastClaimedEpoch: 101, now: T0 + 1000 }).settled[0]).toMatchObject({ result: 'partial', returnedNano: 10e9 });
    for (const lce of [100, 99, null, undefined, -1, 1.5]) {
      const s = { ...held(), floor: 100 };
      const r = settleMoves(s, { lastClaimedEpoch: lce, now: T0 + 1000 });
      expect([lce, r.settled, r.state === s]).toEqual([lce, [], true]); // nothing changed: the same object
    }
  });

  it('the clock alone never ends a move, however late, and no rule of the module says one did not go through', () => {
    const WEEK = 7 * 24 * 3600_000;
    const s = held();
    for (const now of [T0 + 35 * 60_000, T0 + WEEK, T0 + 52 * WEEK]) {
      const late = settleMoves(s, { lastClaimedEpoch: null, now });
      expect([late.settled, late.state === s]).toEqual([[], true]);
      // A certified watermark still short of the batch (the claim not included yet): still held.
      expect(settleMoves(s, { lastClaimedEpoch: 100, now }).state.moves).toEqual(s.moves);
    }
    expect(settleMoves(s, { lastClaimedEpoch: 103, now: T0 + WEEK }).settled[0].result).toBe('done');
    // No timer, no poll of nodes, no failure state left to call.
    for (const gone of ['TRANSIT_MAX_MS', 'overdueMoves', 'tipVerdict', 'failMoves', 'failedMove']) {
      expect([gone, ClaimTransit[gone]]).toEqual([gone, undefined]);
    }
  });

  it('the watermark becomes the wallet\'s floor, which only goes up', () => {
    let s = settleMoves(emptyTransit(W), { lastClaimedEpoch: 90, now: T0 }).state;
    expect(s.floor).toBe(90);
    s = settleMoves(s, { lastClaimedEpoch: 88, now: T0 }).state; // an older certified view says less
    expect(s.floor).toBe(90);
    expect(settleMoves(s, { lastClaimedEpoch: 103, now: T0 }).state.floor).toBe(103);
  });
});

describe('the wallet\'s move, whichever node id it was made by', () => {
  it('one held move holds every card: the same move again takes its place, its total and rest are the wallet\'s', () => {
    let s = addMove(emptyTransit(W), transitRecord({ nodeId: LIGHT, result: result(), balanceNano: 13e9, now: T0 }));
    // The same batch quoted again by the server node's id (a race): one move, never twice the amount.
    s = addMove(s, transitRecord({ nodeId: SUPER, result: result(), balanceNano: 13e9, now: T0 + 5 }));
    expect([s.moves.length, transitTotal(s)]).toEqual([1, 12_500_000_000]);
    expect(heldMove(s)).toMatchObject({ amountNano: '12500000000', restNano: 5e8 });
    // A later batch above it is another move: both are in transit.
    s = addMove(s, transitRecord({ nodeId: SUPER, result: result({ amountNano: '2000000000', prevWatermark: 103, lastEpoch: 104, parts: [[104, '2000000000']], txHash: 'cd'.repeat(32) }), balanceNano: 2e9, now: T0 }));
    expect(transitTotal(s)).toBe(14_500_000_000);
    const r = settleMoves(s, { lastClaimedEpoch: 103, now: T0 + 1000 });
    expect(r.settled.map((x) => [x.move.nodeId, x.result])).toEqual([[SUPER, 'done']]);
    expect(transitTotal(r.state)).toBe(2_000_000_000);
  });

});

// Before, only a certified read ended a move: Assets showed the claimed QNC within seconds (the live figure) while the
// Node tab said "Moving X" and History "Moving" for minutes. These tests fail on that rule.
describe('what the wallet\'s live figure tells of it (owner, 18.10)', () => {
  const held = () => addMove(emptyTransit(W), transitRecord({ nodeId: LIGHT, result: result(), balanceNano: 13e9, now: T0 }));

  it('a live watermark at or past the last epoch ends it on screen at once; the record stays for a certified read', () => {
    const s = held();
    const r = noteLiveWatermark(s, 103, LIVE_AT);
    expect(r.settled).toEqual([{ move: expect.objectContaining({ nodeId: LIGHT }), result: 'done', returnedNano: 0 }]);
    expect([transitTotal(r.state), heldMove(r.state)]).toEqual([0, null]);
    expect(r.state.moves).toHaveLength(1); // the record itself waits for the certified read
    expect([r.state.floor, r.state.liveLce, r.state.liveHeight]).toEqual([null, 103, LIVE_AT]); // never the durable one
    expect(moveOutcome(r.state, HASH)).toEqual({ result: 'done', appliedNano: 12.5e9 });
    // The certified read that comes later settles the record and raises the floor, and says the screen showed it already.
    const c = settleMoves(r.state, { lastClaimedEpoch: 103, now: T0 + 1000 });
    expect(c.settled).toEqual([expect.objectContaining({ result: 'done', liveSeen: true })]);
    expect([c.state.moves, c.state.floor, c.state.liveLce]).toEqual([[], 103, 103]);
    expect(moveOutcome(c.state, HASH)).toEqual({ result: 'done', appliedNano: 12.5e9 });
  });

  it('past the start only: in part, with what came back to the node; short of the batch: still in transit', () => {
    const part = noteLiveWatermark(held(), 101, LIVE_AT);
    expect(part.settled[0]).toMatchObject({ result: 'partial', returnedNano: 10e9 });
    expect(moveOutcome(part.state, HASH)).toEqual({ result: 'partial', appliedNano: 2.5e9 });
    for (const lce of [100, 99, null, undefined, -1, 1.5]) {
      const s = held();
      const r = noteLiveWatermark(s, lce, LIVE_AT);
      // A watermark short of the batch is kept, and nothing ends; no watermark at all changes nothing.
      expect([lce, r.settled, r.state === s, transitTotal(r.state)]).toEqual([lce, [], !Number.isSafeInteger(lce) || lce < 0, 12.5e9]);
      expect(moveOutcome(r.state, HASH)).toEqual({ result: 'moving' });
    }
  });

  it('only ever raised: a node a block behind never puts a move back in transit, and a move once seen is told once', () => {
    let s = noteLiveWatermark(held(), 103, LIVE_AT).state;
    const back = noteLiveWatermark(s, 100, LIVE_AT);
    expect([back.state === s, back.settled, transitTotal(back.state)]).toEqual([true, [], 0]);
    expect(noteLiveWatermark(s, 104, LIVE_AT).settled).toEqual([]);
    // A move made after the watermark was seen starts in transit again.
    s = addMove(s, transitRecord({ nodeId: SUPER, result: result({ amountNano: '2000000000', prevWatermark: 103, lastEpoch: 104,
      parts: [[104, '2000000000']], txHash: 'cd'.repeat(32) }), balanceNano: 2e9, now: T0 }));
    expect([s.liveLce, transitTotal(s)]).toEqual([103, 2e9]);
    expect(moveOutcome(s, 'ee'.repeat(32))).toBe(null);
  });

  // Before, the live watermark judged every node balance answer for good, written to the device: one node's answer too
  // high refused every later answer of the wallet's node balance, and nothing certified lowered it.
  it('node balance answers are judged by the certified floor, raised to the live watermark only while a move it ended waits', () => {
    expect(answerFloor(null)).toBe(null);
    expect(answerFloor(emptyTransit(W))).toBe(null);
    expect(answerFloor({ ...emptyTransit(W), floor: 90 })).toBe(90);
    // No move it ended: the live watermark judges nothing.
    expect(answerFloor({ ...emptyTransit(W), liveLce: 103, liveHeight: LIVE_AT })).toBe(null);
    expect(answerFloor({ ...emptyTransit(W), floor: 90, liveLce: 103, liveHeight: LIVE_AT })).toBe(90);
    expect(answerFloor(noteLiveWatermark(held(), 100, LIVE_AT).state)).toBe(null); // short of the batch: ends nothing
    // A move it ended waits for its certified settle: a node still holding the moved epochs no longer counts meanwhile.
    const seen = noteLiveWatermark(held(), 103, LIVE_AT).state;
    expect(answerFloor(seen)).toBe(103);
    expect(answerFloor({ ...seen, floor: 105 })).toBe(105);
    expect(acceptedBalance([answer(4e9, 101), answer(0, null)], answerFloor(seen))).toBe(0);
    // Settled by the certified read: the floor judges, the live watermark no more.
    expect(answerFloor(settleMoves(seen, { lastClaimedEpoch: 103, blockHeight: LIVE_AT, now: T0 }).state)).toBe(103);
  });

  it('a certified read of the live figure\'s height or later that shows less puts what that figure ended back in transit', () => {
    const seen = noteLiveWatermark(held(), 103, LIVE_AT).state;
    expect(moveOutcome(seen, HASH)).toEqual({ result: 'done', appliedNano: 12.5e9 });
    // A certified state older than the live figure may simply lag: the move stays ended on screen.
    const lagging = settleMoves(seen, { lastClaimedEpoch: 100, blockHeight: LIVE_AT - 90, now: T0 });
    expect([lagging.reverted, lagging.state.liveLce, transitTotal(lagging.state), lagging.state.floor]).toEqual([false, 103, 0, 100]);
    // One of its height or later with the watermark short of the batch: that figure was of a branch the chain left.
    const back = settleMoves(seen, { lastClaimedEpoch: 100, blockHeight: LIVE_AT, now: T0 });
    expect(back.reverted).toBe(true);
    expect([back.state.liveLce, back.state.liveHeight, back.settled]).toEqual([null, null, []]);
    expect([moveOutcome(back.state, HASH), transitTotal(back.state), heldMove(back.state).amountNano])
      .toEqual([{ result: 'moving' }, 12.5e9, '12500000000']);
    expect(answerFloor(back.state)).toBe(100);
    // Short of the live watermark but past the batch's start: the move went through in part, and the screen is told so.
    const part = settleMoves(seen, { lastClaimedEpoch: 101, blockHeight: LIVE_AT + 90, now: T0 });
    expect(part.reverted).toBe(true);
    expect(part.settled).toEqual([expect.objectContaining({ result: 'partial', returnedNano: 10e9, liveSeen: false })]);
    expect(moveOutcome(part.state, HASH)).toEqual({ result: 'partial', appliedNano: 2.5e9 });
    // A certified read that agrees settles it as the screen showed it.
    expect(settleMoves(seen, { lastClaimedEpoch: 103, blockHeight: LIVE_AT + 90, now: T0 }))
      .toMatchObject({ reverted: false, settled: [expect.objectContaining({ result: 'done', liveSeen: true })] });
  });

  it('the result card says in transit, done or the part in the wallet', () => {
    expect(moveNote({ result: 'done', appliedNano: 1 })).toEqual({ key: 'claim_note_done' });
    expect(moveNote({ result: 'partial', appliedNano: 2.5e9 })).toEqual({ key: 'claim_note_partial', appliedNano: 2.5e9 });
    expect(moveNote({ result: 'moving' }, 120)).toEqual({ key: 'claim_stopped_at', epoch: 120 });
    expect(moveNote(null)).toEqual({ key: 'claim_credited_on_block' });
    expect(moveNote({ result: 'moving' }, null)).toEqual({ key: 'claim_credited_on_block' });
  });
});

describe('a node balance answer counts only from a node not behind the wallet\'s certified watermark', () => {
  it('first unclaimed epoch past the floor, or nothing left to claim (the node\'s answer after a whole move)', () => {
    expect(balanceAnswerCounts(answer(4e9, 101), null)).toBe(true); // no floor known: every answer
    expect(balanceAnswerCounts(answer(4e9, 101), 103)).toBe(false); // still holds epochs the wallet moved
    expect(balanceAnswerCounts(answer(1e9, 104), 103)).toBe(true);
    expect(balanceAnswerCounts(answer(0, null), 103)).toBe(true);
    expect(balanceAnswerCounts(answer(4e9, null), 103)).toBe(false);
    expect(balanceAnswerCounts({ success: false }, null)).toBe(false);
    // The largest of those that count; a lagging node never brings a moved amount back.
    expect(acceptedBalance([answer(4e9, 101), answer(0, null), answer(0, null)], 103)).toBe(0);
    expect(acceptedBalance([answer(4e9, 101), answer(1e9, 104)], 103)).toBe(1e9);
    expect(acceptedBalance([answer(4e9, 101)], 103)).toBe(null);
    expect(acceptedBalance([answer(4e9, 101), answer(3e9, 101)], null)).toBe(4e9);
  });
});

describe('the history row of a move', () => {
  it('in transit says so; seen through by the live figure or a certified read is confirmed, whatever one node reported', () => {
    const rows = [{ hash: HASH, status: 'reported' }, { hash: 'ee'.repeat(32), status: 'reported' }];
    const s = addMove(emptyTransit(W), transitRecord({ nodeId: LIGHT, result: result(), now: T0 }));
    expect(withMoveStates(rows, s)).toEqual([{ hash: HASH, status: 'reported', moving: true }, rows[1]]);
    expect(withMoveStates(rows, noteLiveWatermark(s, 103, LIVE_AT).state)).toEqual([{ hash: HASH, status: 'confirmed' }, rows[1]]);
    const done = settleMoves(s, { lastClaimedEpoch: 103, now: T0 + 1 }).state;
    expect(withMoveStates(rows, done)).toEqual([{ hash: HASH, status: 'confirmed' }, rows[1]]);
    // A day after it settled the record no longer marks the row.
    expect(withMoveStates(rows, settleMoves(done, { now: T0 + 1 + OUTCOME_KEEP_MS }).state)).toBe(rows);
    expect(withMoveStates(rows, emptyTransit(W))).toBe(rows);
  });
});

describe('kept on the device for each wallet on it', () => {
  beforeEach(async () => { await AsyncStorage.clear(); });

  it('reads back what it wrote, for that wallet only, beside another wallet\'s, and drops anything malformed', async () => {
    const s = addMove(emptyTransit(W), transitRecord({ nodeId: LIGHT, result: result(), balanceNano: 13e9, now: T0 }));
    await writeTransit(s);
    expect(await readTransit(W)).toEqual(s);
    expect(await readTransit(W2)).toEqual(emptyTransit(W2));
    // Another wallet's record goes beside it: a switch away and back finds the move where it was.
    const other = { ...emptyTransit(W2), floor: 7 };
    await writeTransit(other);
    expect([await readTransit(W), await readTransit(W2)]).toEqual([s, other]);
    // The first form (one wallet's record alone) still reads.
    await AsyncStorage.setItem(TRANSIT_KEY, JSON.stringify({ owner: W, moves: [{ nodeId: LIGHT, amountNano: 'x' }, s.moves[0]], outcomes: [{ result: 'odd' }] }));
    expect(await readTransit(W)).toEqual(s);
    await AsyncStorage.setItem(TRANSIT_KEY, '{not json');
    expect(await readTransit(W)).toEqual(emptyTransit(W));
    // The live watermark is one node's word, never written: after a restart the move is in transit again until the next
    // live figure shows it (the record is the same).
    const seen = noteLiveWatermark(s, 103, LIVE_AT).state;
    expect(transitTotal(seen)).toBe(0);
    await writeTransit(seen);
    expect(JSON.parse(await AsyncStorage.getItem(TRANSIT_KEY)).wallets[W]).not.toHaveProperty('liveLce');
    expect(await readTransit(W)).toEqual(s);
    expect(transitTotal(await readTransit(W))).toBe(12.5e9);
    // One an earlier build wrote is not read back either.
    await AsyncStorage.setItem(TRANSIT_KEY, JSON.stringify({ wallets: { [W]: { ...s, liveLce: 103 } } }));
    expect((await readTransit(W)).liveLce).toBe(null);
    // Nothing held and no floor: nothing kept.
    await AsyncStorage.clear();
    await writeTransit(emptyTransit(W));
    expect(await AsyncStorage.getItem(TRANSIT_KEY)).toBe(null);
  });

  it('a move an earlier build said had not gone through is held again until a certified read settles it', async () => {
    const newer = transitRecord({ nodeId: SUPER, result: result({ amountNano: '2000000000', prevWatermark: 103, lastEpoch: 104,
      parts: [[104, '2000000000']], txHash: 'cd'.repeat(32) }), balanceNano: 2e9, now: T0 + 60_000 });
    const failed = { nodeId: LIGHT, txHash: HASH, amountNano: '12500000000', result: 'failed', at: T0 + 40 * 60_000,
      prevWatermark: 100, lastEpoch: 103, returnedNano: 12.5e9 };
    // One of the same epochs as a move held is not held twice.
    const twin = { ...failed, nodeId: SUPER, at: T0 + 41 * 60_000, prevWatermark: 103, lastEpoch: 104 };
    await AsyncStorage.setItem(TRANSIT_KEY, JSON.stringify({ wallets: { [W]: { moves: [newer], outcomes: [failed, twin], floor: 100 } } }));
    const s = await readTransit(W);
    expect(s.outcomes).toEqual([]);
    expect(s.moves).toEqual([
      { nodeId: LIGHT, amountNano: '12500000000', restNano: null, prevWatermark: 100, lastEpoch: 103, parts: null, txHash: HASH,
        time: T0 + 40 * 60_000 },
      newer,
    ]);
    expect([transitTotal(s), heldMove(s).restNano]).toEqual([14.5e9, 0]);
    // Only a certified watermark ends it: 103 settles it, the newer move still waits.
    const r = settleMoves(s, { lastClaimedEpoch: 103, now: T0 + 3600_000 });
    expect(r.settled.map((x) => [x.move.nodeId, x.result])).toEqual([[LIGHT, 'done']]);
    expect(r.state.moves).toEqual([newer]);
    // The wallet's certified watermark already past its start: its epochs are in the QNC figure or back on the node, so
    // nothing of it is in transit and it is not held again (it would show an amount the figure holds a second time).
    for (const floor of [101, 103, 120]) {
      await AsyncStorage.setItem(TRANSIT_KEY, JSON.stringify({ wallets: { [W]: { moves: [], outcomes: [failed], floor } } }));
      expect(await readTransit(W)).toEqual({ ...emptyTransit(W), floor });
    }
    // One with no epochs to follow is malformed: dropped, never shown.
    await AsyncStorage.setItem(TRANSIT_KEY, JSON.stringify({ wallets: { [W]: { moves: [], outcomes: [{ ...failed, lastEpoch: null }] } } }));
    expect(await readTransit(W)).toEqual(emptyTransit(W));
  });
});
