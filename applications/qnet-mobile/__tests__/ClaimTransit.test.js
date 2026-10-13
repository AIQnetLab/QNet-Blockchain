/**
 * A move of a node balance in transit (owner, 11.10; services/ClaimTransit): held from the moment the network took it
 * until a certified read of the wallet shows its claim watermark at the batch's last epoch (done) or past its start
 * only (in part). Nothing else ends it, neither the clock nor nodes' live answers (owner, 12.10: a QNet transaction has
 * no consensus expiry yet, so there is no "did not go through"). The wallet's certified watermark judges every node
 * balance answer. The rules alone, without the screen; the screen itself is App1110.test.js.
 */
const AsyncStorage = require('@react-native-async-storage/async-storage');
const {
  TRANSIT_KEY, OUTCOME_KEEP_MS, emptyTransit, transitRecord, addMove, settleMoves, heldMove, transitTotal, withMoveStates,
  readTransit, writeTransit, shownTransitNano, balanceAnswerCounts, acceptedBalance,
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
      .toEqual([{ move: expect.objectContaining({ nodeId: LIGHT }), result: 'done', returnedNano: 0 }]);
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

  it('Assets\' line leaves out what the figure on screen holds already, by that figure\'s own watermark', () => {
    const s = addMove(emptyTransit(W), transitRecord({ nodeId: LIGHT, result: result(), now: T0 }));
    expect(shownTransitNano(s, null)).toBe(12.5e9);
    expect(shownTransitNano(s, 100)).toBe(12.5e9);
    expect(shownTransitNano(s, 102)).toBe(6e9); // epochs 101 and 102 are in that figure
    expect(shownTransitNano(s, 103)).toBe(0);
    expect(shownTransitNano(emptyTransit(W), 0)).toBe(0);
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
  it('in transit says so; seen through by a certified read is confirmed, whatever one node reported of it', () => {
    const rows = [{ hash: HASH, status: 'reported' }, { hash: 'ee'.repeat(32), status: 'reported' }];
    const s = addMove(emptyTransit(W), transitRecord({ nodeId: LIGHT, result: result(), now: T0 }));
    expect(withMoveStates(rows, s)).toEqual([{ hash: HASH, status: 'reported', moving: true }, rows[1]]);
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
