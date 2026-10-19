/**
 * A move of a node balance in transit (owner, 11.10 and 18.10). The node balance and its claim watermark are the
 * wallet's, not a node's (the network sums one wallet's reward leaves whichever of its node ids is asked), so everything
 * here is per wallet. A Move to wallet the network took (the Node tab's card, or a QNet Link claim sheet) is in transit
 * from the moment it was submitted until the wallet's live figure (a genesis node's live tip, its proof folded to that
 * node's root) shows its claim watermark at the batch's last epoch: the claim credits the wallet and moves the watermark
 * in one step of the same block, so that figure holds the amount. A watermark past the batch's start but short of its end
 * is a move that went through in part (the network stops a batch at an epoch it cannot prove). While a move is in
 * transit the Node tab says "Moving X" with its button off and the rest of the node balance, and the move's history row
 * says so too: the amount is never shown twice, nor nowhere. Nothing else ends a move, neither the clock nor what nodes
 * say of the node balance (owner, 12.10: settleMoves says why). The record itself stays until a certified read of the
 * wallet shows the watermark, in the background: only that read raises the wallet's durable watermark (`floor`), which
 * judges every node balance read (acceptedBalance), and a certified read of the live figure's height or later that shows
 * a lower watermark puts the move back in transit. The live watermark (`liveLce`, with the height of the figure that
 * showed it, `liveHeight`) is held in memory only, never written. The record is kept on the device per wallet
 * (`qnet_claim_transit_v1`, no secret in it); the screen reads and writes it, every rule here is a pure function of the
 * record and is tested without the screen.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const TRANSIT_KEY = 'qnet_claim_transit_v1';
// How long a settled move still marks its history row.
export const OUTCOME_KEEP_MS = 24 * 3600_000;
const MAX_MOVES = 8;
const MAX_OUTCOMES = 16;
// The node quotes at most 512 epochs a batch (rewards_api MAX_BATCH).
const MAX_PARTS = 512;
// The wallets whose records are kept: a switch away and back finds its move where it was.
const MAX_WALLETS = 4;

const isEpoch = (v) => Number.isSafeInteger(v) && v >= 0;
const isNano = (v) => typeof v === 'string' && /^\d{1,30}$/.test(v);

/** Nothing held: what a wallet without a move in transit has. */
export function emptyTransit(owner = null) {
  return { owner, moves: [], outcomes: [], floor: null, liveLce: null, liveHeight: null };
}

// The live watermark of `s` and the height it was seen at, both or neither.
const liveOf = (s) => (isEpoch(s.liveLce) && isEpoch(s.liveHeight)
  ? { liveLce: s.liveLce, liveHeight: s.liveHeight } : { liveLce: null, liveHeight: null });

// The batch's epochs with their amounts ([epoch, nanoText], strictly ascending above `prev`, the last one `last`,
// summing to `amountNano`), or null when they do not: the record then falls back to its whole amount.
function cleanParts(parts, prev, last, amountNano) {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) return null;
  let at = prev;
  let sum = 0n;
  for (const p of parts) {
    if (!Array.isArray(p) || p.length !== 2 || !isEpoch(p[0]) || p[0] <= at || !isNano(p[1])) return null;
    at = p[0];
    sum += BigInt(p[1]);
  }
  return at === last && sum.toString() === amountNano ? parts.map((p) => [p[0], p[1]]) : null;
}

/** The nanoQNC a move's answer (claimRewards) names, as decimal text: its quoted batch, else its QNC amount; or null. */
export function claimedNano(result) {
  if (!result) return null;
  if (isNano(result.amountNano)) return result.amountNano;
  const qnc = Number(result.amount);
  return Number.isFinite(qnc) && qnc > 0 ? String(Math.round(qnc * 1e9)) : null;
}

/**
 * The record of a move the network took, from claimRewards' answer (`result`: amountNano or amount, txHash,
 * prevWatermark, lastEpoch, parts), or null when the answer names no batch to follow (a node that quoted none).
 * `balanceNano`: the node balance shown when the move was made, whose rest (`restNano`) the Node tab shows while it is
 * in transit.
 */
export function transitRecord({ nodeId, result, balanceNano = null, now = Date.now() }) {
  if (!nodeId || !result || result.success === false) return null;
  const { prevWatermark, lastEpoch } = result;
  if (!isEpoch(prevWatermark) || !isEpoch(lastEpoch) || lastEpoch <= prevWatermark) return null;
  const amountNano = claimedNano(result);
  if (amountNano === null || amountNano === '0') return null;
  const before = balanceNano === null || balanceNano === undefined ? NaN : Number(balanceNano);
  const restNano = Number.isFinite(before) && before >= 0 ? Math.max(0, before - Number(amountNano)) : null;
  return {
    nodeId, amountNano, restNano, prevWatermark, lastEpoch,
    parts: cleanParts(result.parts, prevWatermark, lastEpoch, amountNano),
    txHash: typeof result.txHash === 'string' && result.txHash ? result.txHash : null, time: now,
  };
}

const overlaps = (a, b) => a.prevWatermark < b.lastEpoch && b.prevWatermark < a.lastEpoch;

/** `state` with `move` held. A move of the same epochs (the same batch quoted again) takes the earlier one's place. */
export function addMove(state, move) {
  const s = state || emptyTransit();
  return {
    owner: s.owner,
    moves: [...s.moves.filter((m) => !overlaps(m, move)), move].slice(-MAX_MOVES),
    outcomes: s.outcomes,
    floor: isEpoch(s.floor) ? s.floor : null,
    ...liveOf(s),
  };
}

// What watermark `lce` says of `move`: 'done' at or past its last epoch, 'partial' past its start only, else null (the
// move is not in that state yet, or no watermark is known).
const outcomeAt = (move, lce) => {
  if (!isEpoch(lce)) return null;
  if (lce >= move.lastEpoch) return 'done';
  return lce > move.prevWatermark ? 'partial' : null;
};

// The moves the wallet's live watermark does not show through yet: the ones in transit on screen.
const movingMoves = (state) => (state ? state.moves.filter((m) => outcomeAt(m, state.liveLce) === null) : []);

// The part of `move` the network applied by watermark `lce`, nanoQNC as a number (the whole amount without its parts).
function appliedNano(move, lce) {
  if (lce >= move.lastEpoch) return Number(move.amountNano);
  if (!move.parts) return 0;
  return move.parts.reduce((sum, [epoch, nano]) => (epoch <= lce ? sum + Number(nano) : sum), 0);
}

const outcomeOf = (move, result, at, lce) => ({
  nodeId: move.nodeId, txHash: move.txHash, amountNano: move.amountNano, result, at,
  prevWatermark: move.prevWatermark, lastEpoch: move.lastEpoch,
  // What of it is back on the node (the part the network did not apply): the Node tab adds it to the rest.
  returnedNano: result === 'partial' ? Number(move.amountNano) - appliedNano(move, lce) : 0,
});

/**
 * What a certified read tells of the moves held, in the background: `lastClaimedEpoch` the wallet's claim watermark in a
 * state the committee certified (null when the read certified none: then only outcomes past their day go), `blockHeight`
 * the height of that state, `now` the clock. A watermark at or past a move's last epoch: 'done'; past its start only:
 * 'partial'; otherwise the move stays held. The watermark becomes the wallet's `floor`. One lower than the live
 * watermark, in a state at or past the height of the live figure that showed it, contradicts that figure (a node on a
 * branch the chain left, or a faulty one): the live watermark is dropped and what it ended is in transit again
 * (`reverted`). { state, settled: [{ move, result, returnedNano, liveSeen }], reverted }, `liveSeen` when the live
 * watermark showed that move through already (the screen said so then); `state` is the same object when nothing changed.
 */
export function settleMoves(state, { lastClaimedEpoch = null, blockHeight = null, now = Date.now() } = {}) {
  const s = state || emptyTransit();
  const lce = isEpoch(lastClaimedEpoch) ? lastClaimedEpoch : null;
  const seen = liveOf(s);
  const reverted = lce !== null && seen.liveLce !== null && lce < seen.liveLce && isEpoch(blockHeight)
    && blockHeight >= seen.liveHeight;
  const { liveLce: live, liveHeight } = reverted ? { liveLce: null, liveHeight: null } : seen;
  const settled = [];
  const moves = [];
  for (const move of s.moves) {
    // A certified watermark ends the record, never a timer or nodes' answers of the node balance: a QNet transaction has
    // no consensus expiry (no valid_until height; each node's mempool TTL is its own), so a batch not seen yet can still
    // be included later and nothing can say it never will. A "did not go through" state waits for such a rule.
    const result = outcomeAt(move, lce);
    if (result) {
      const o = outcomeOf(move, result, now, lce);
      settled.push({ move, result, returnedNano: o.returnedNano, liveSeen: outcomeAt(move, live) !== null, outcome: o });
    } else moves.push(move);
  }
  const kept = s.outcomes.filter((o) => now - o.at < OUTCOME_KEEP_MS);
  const was = isEpoch(s.floor) ? s.floor : null;
  const floor = lce !== null && !(was !== null && was >= lce) ? lce : was;
  if (settled.length === 0 && kept.length === s.outcomes.length && floor === was && !reverted) {
    return { state: s, settled, reverted };
  }
  const outcomes = [...kept, ...settled.map((x) => x.outcome)].slice(-MAX_OUTCOMES);
  return {
    state: { owner: s.owner, moves, outcomes, floor, liveLce: live, liveHeight },
    settled: settled.map(({ outcome, ...x }) => x),
    reverted,
  };
}

/**
 * `state` with the claim watermark of the wallet's live figure (a genesis node's live tip, its proof folded to that
 * node's root) and that figure's `height`, for the screen and in memory only: only ever raised, as the chain's watermark
 * only moves forward, until a certified read contradicts it (settleMoves). A move it shows at or past its last epoch is
 * no longer in transit ('done'), one it shows past its start only went through in part ('partial'); the record stays
 * until a certified read settles it. { state, settled: [{ move, result, returnedNano }] }: the moves this watermark is the
 * first to show through; `state` is the same object when nothing changed.
 */
export function noteLiveWatermark(state, liveLce, height) {
  const s = state || emptyTransit();
  const was = liveOf(s).liveLce;
  if (!isEpoch(liveLce) || !isEpoch(height) || (was !== null && was >= liveLce)) return { state: s, settled: [] };
  const settled = [];
  for (const move of s.moves) {
    const result = outcomeAt(move, liveLce);
    if (result && outcomeAt(move, was) === null) {
      settled.push({ move, result, returnedNano: outcomeOf(move, result, 0, liveLce).returnedNano });
    }
  }
  return { state: { ...s, liveLce, liveHeight: height }, settled };
}

/**
 * The wallet's move in transit as the Node tab shows it ({ amountNano, restNano }: all that is in transit, and the rest
 * of the node balance the latest move left), or null.
 */
export function heldMove(state) {
  const moving = movingMoves(state);
  if (moving.length === 0) return null;
  return { ...moving[moving.length - 1], amountNano: String(transitTotal(state)) };
}

/** All that is in transit to the wallet, nanoQNC (0 when nothing is). */
export function transitTotal(state) {
  return movingMoves(state).reduce((sum, m) => sum + Number(m.amountNano), 0);
}

/**
 * What became of the move submitted as `txHash`, as its result card says it: { result: 'moving' } while it is in transit,
 * { result: 'done' | 'partial', appliedNano (what of it is in the wallet) } once the live or a certified watermark shows
 * it, null when no record names it.
 */
export function moveOutcome(state, txHash) {
  if (!state || !txHash) return null;
  const move = state.moves.find((m) => m.txHash === txHash);
  if (move) {
    const result = outcomeAt(move, state.liveLce);
    return result ? { result, appliedNano: appliedNano(move, state.liveLce) } : { result: 'moving' };
  }
  const o = state.outcomes.find((x) => x.txHash === txHash);
  return o ? { result: o.result, appliedNano: Number(o.amountNano) - o.returnedNano } : null;
}

/**
 * What a move's result card (the Node tab's, a QNet Link claim sheet's) says under it, as a text key and its values:
 * `outcome` from moveOutcome. Done: in the wallet; in part: the part that is (`appliedNano`); still in transit: that the
 * batch stopped at `stoppedAtEpoch` when the quote did, else that it is credited once in a block.
 */
export function moveNote(outcome, stoppedAtEpoch = null) {
  if (outcome && outcome.result === 'done') return { key: 'claim_note_done' };
  if (outcome && outcome.result === 'partial') return { key: 'claim_note_partial', appliedNano: outcome.appliedNano };
  if (stoppedAtEpoch !== null && stoppedAtEpoch !== undefined) return { key: 'claim_stopped_at', epoch: stoppedAtEpoch };
  return { key: 'claim_credited_on_block' };
}

/**
 * The watermark node balance answers are judged by (balanceAnswerCounts): the wallet's durable certified `floor`, raised
 * to its live watermark only while a move that watermark ended still waits for its certified settle (so a node behind
 * that move does not bring its amount back meanwhile); null while neither counts.
 */
export function answerFloor(state) {
  if (!state) return null;
  const live = state.moves.some((m) => outcomeAt(m, state.liveLce) !== null) ? state.liveLce : null;
  const marks = [state.floor, live].filter(isEpoch);
  return marks.length ? Math.max(...marks) : null;
}

/**
 * Whether a node balance answer may be shown for the wallet whose claim watermark is `floor` (answerFloor; null: none
 * known, every answer counts): only a node whose state is not behind it, its first unclaimed epoch past it, or with
 * nothing left to claim (the answer the network gives right after a whole move). A node behind it still counts epochs
 * the wallet moved already.
 */
export function balanceAnswerCounts(r, floor = null) {
  if (!r || !r.success || !Number.isSafeInteger(r.pendingRewards) || r.pendingRewards < 0) return false;
  if (!isEpoch(floor)) return true;
  const f = r.firstUnclaimedEpoch;
  return (isEpoch(f) && f > floor) || (f === null && r.pendingRewards === 0);
}

/**
 * The node balance (nanoQNC) from genesis answers: the largest of those that count (balanceAnswerCounts: a claim is
 * re-verified on chain against the certified reward root, so among nodes not behind the wallet's watermark an honest one
 * can only under-report), or null when none does.
 */
export function acceptedBalance(answers, floor = null) {
  const ok = (Array.isArray(answers) ? answers : []).filter((r) => balanceAnswerCounts(r, floor));
  return ok.length > 0 ? ok.reduce((m, r) => Math.max(m, r.pendingRewards), 0) : null;
}

/**
 * History rows with the state of the moves: the row of a move in transit is `moving`; the row of one the live or a
 * certified watermark showed through is confirmed by that, whatever one node reported of it (its explorer row may not
 * have come yet).
 */
export function withMoveStates(rows, state) {
  if (!Array.isArray(rows) || !state || (state.moves.length === 0 && state.outcomes.length === 0)) return rows;
  const inTransit = movingMoves(state);
  const moving = new Set(inTransit.map((m) => m.txHash).filter(Boolean));
  const through = new Set([...state.outcomes, ...state.moves.filter((m) => !inTransit.includes(m))]
    .map((x) => x.txHash).filter(Boolean));
  let changed = false;
  const next = rows.map((row) => {
    if (!row || !row.hash) return row;
    if (moving.has(row.hash)) { changed = true; return { ...row, moving: true }; }
    if (through.has(row.hash) && row.status === 'reported') { changed = true; return { ...row, status: 'confirmed' }; }
    return row;
  });
  return changed ? next : rows;
}

// A record read back, field by field: anything malformed is dropped, never shown.
function cleanMove(m) {
  if (!m || typeof m.nodeId !== 'string' || !isNano(m.amountNano) || !isEpoch(m.prevWatermark) || !isEpoch(m.lastEpoch)
      || m.lastEpoch <= m.prevWatermark || !Number.isSafeInteger(m.time)) return null;
  return {
    nodeId: m.nodeId, amountNano: m.amountNano, restNano: Number.isFinite(m.restNano) && m.restNano >= 0 ? m.restNano : null,
    prevWatermark: m.prevWatermark, lastEpoch: m.lastEpoch, parts: cleanParts(m.parts, m.prevWatermark, m.lastEpoch, m.amountNano),
    txHash: typeof m.txHash === 'string' && m.txHash ? m.txHash : null, time: m.time,
  };
}

function cleanOutcome(o) {
  if (!o || typeof o.nodeId !== 'string' || !['done', 'partial'].includes(o.result) || !Number.isSafeInteger(o.at)) return null;
  const span = isEpoch(o.prevWatermark) && isEpoch(o.lastEpoch) && o.lastEpoch > o.prevWatermark;
  return {
    nodeId: o.nodeId, txHash: typeof o.txHash === 'string' && o.txHash ? o.txHash : null,
    amountNano: isNano(o.amountNano) ? o.amountNano : '0', result: o.result, at: o.at,
    prevWatermark: span ? o.prevWatermark : null, lastEpoch: span ? o.lastEpoch : null,
    returnedNano: Number.isFinite(o.returnedNano) && o.returnedNano >= 0 ? o.returnedNano : 0,
  };
}

// A move an earlier build said had not gone through (by the clock: no such state, owner 12.10) is held again, older
// than the moves held beside it, until a certified read settles it; not when the wallet's certified watermark (`floor`)
// is past its start already: its epochs are then in the QNC figure or back on the node, none of it in transit.
function cleanState(owner, raw) {
  if (!raw || typeof raw !== 'object') return emptyTransit(owner);
  const floor = isEpoch(raw.floor) ? raw.floor : null;
  const outcomes = Array.isArray(raw.outcomes) ? raw.outcomes : [];
  const held = (Array.isArray(raw.moves) ? raw.moves : []).map(cleanMove).filter(Boolean);
  const revived = outcomes.filter((o) => o && o.result === 'failed')
    .map((o) => cleanMove({ ...o, restNano: null, parts: null, time: o.at }))
    .filter((m) => m && !(floor !== null && floor > m.prevWatermark) && !held.some((h) => overlaps(h, m)));
  return {
    owner,
    moves: [...revived, ...held].slice(-MAX_MOVES),
    outcomes: outcomes.map(cleanOutcome).filter(Boolean).slice(-MAX_OUTCOMES),
    floor,
    liveLce: null,
    liveHeight: null,
  };
}

// Every wallet's record as kept ({ owner: state }); a record of one wallet alone (the first form) reads as such.
async function readAll() {
  const raw = JSON.parse((await AsyncStorage.getItem(TRANSIT_KEY)) || 'null');
  if (!raw || typeof raw !== 'object') return {};
  if (typeof raw.owner === 'string') return { [raw.owner]: raw };
  return raw.wallets && typeof raw.wallets === 'object' ? raw.wallets : {};
}

/** The record kept for `owner`; nothing for a wallet without one, or when nothing can be read. */
export async function readTransit(owner) {
  try {
    const all = await readAll();
    return Object.prototype.hasOwnProperty.call(all, owner) ? cleanState(owner, all[owner]) : emptyTransit(owner);
  } catch (_) {
    return emptyTransit(owner);
  }
}

/**
 * Keeps `state` for its wallet beside the others', without the live watermark (one node's word: memory only); a failed
 * write only loses the record for the next start.
 */
export async function writeTransit(state) {
  try {
    if (!state || !state.owner) return;
    let all = {};
    try { all = await readAll(); } catch (_) { all = {}; }
    const { [state.owner]: _old, ...others } = all;
    const { liveLce: _live, liveHeight: _height, ...record } = state;
    const empty = state.moves.length === 0 && state.outcomes.length === 0 && !isEpoch(state.floor);
    const kept = Object.keys(others).slice(-(MAX_WALLETS - (empty ? 0 : 1))).reduce((o, k) => ({ ...o, [k]: others[k] }), {});
    const wallets = empty ? kept : { ...kept, [state.owner]: record };
    if (Object.keys(wallets).length === 0) {
      await AsyncStorage.removeItem(TRANSIT_KEY);
      return;
    }
    await AsyncStorage.setItem(TRANSIT_KEY, JSON.stringify({ wallets }));
  } catch (_) { /* the screen still holds it for this session */ }
}
