/**
 * A move of a node balance in transit (owner, 11.10). The node balance and its claim watermark are the wallet's, not a
 * node's (the network sums one wallet's reward leaves whichever of its node ids is asked), so everything here is per
 * wallet. A Move to wallet the network took (the Node tab's card, or a QNet Link claim sheet) is held from the moment
 * it was submitted until a certified read of the wallet shows its claim watermark at the batch's last epoch: the claim
 * credits the wallet and moves the watermark in one step of the same block, so that read's QNC figure holds the amount.
 * While a move is held Assets shows the amount on a line of its own under QNC (never inside the QNC figure), the Node
 * tab says "Moving X" with its button off and the rest of the node balance, and the move's history row says so too:
 * the amount is never shown twice, nor nowhere. A watermark past the batch's start but short of its end is a move that
 * went through in part (the network stops a batch at an epoch it cannot prove). Nothing else ends a move, neither the
 * clock nor what nodes say of their live state (owner, 12.10: settleMoves says why). The wallet's last certified
 * watermark (`floor`) also judges every node balance read: a node whose state is behind it still holds a moved amount
 * (acceptedBalance). Kept on the device per wallet (`qnet_claim_transit_v1`, no secret in it); the screen reads and
 * writes it, every rule here is a pure function of the record and is tested without the screen.
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
  return { owner, moves: [], outcomes: [], floor: null };
}

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
  let amountNano = isNano(result.amountNano) ? result.amountNano : null;
  if (amountNano === null && Number.isFinite(Number(result.amount)) && Number(result.amount) > 0) {
    amountNano = String(Math.round(Number(result.amount) * 1e9));
  }
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
  };
}

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
 * What a certified read tells of the moves held: `lastClaimedEpoch` the wallet's claim watermark in a state the
 * committee certified (null when the read certified none: then only outcomes past their day go), `now` the clock. A
 * watermark at or past a move's last epoch: 'done'; past its start only: 'partial'; otherwise the move stays held. The
 * watermark becomes the wallet's `floor`. { state, settled: [{ move, result, returnedNano }] }; `state` is the same
 * object when nothing changed.
 */
export function settleMoves(state, { lastClaimedEpoch = null, now = Date.now() } = {}) {
  const s = state || emptyTransit();
  const lce = isEpoch(lastClaimedEpoch) ? lastClaimedEpoch : null;
  const settled = [];
  const moves = [];
  for (const move of s.moves) {
    // Only the certified watermark decides, never a timer or nodes' live answers: a QNet transaction has no consensus
    // expiry (no valid_until height; each node's mempool TTL is its own), so a batch not seen yet can still be included
    // later and nothing can say it never will. A "did not go through" state waits for such a rule.
    const result = lce === null ? null : (lce >= move.lastEpoch ? 'done' : (lce > move.prevWatermark ? 'partial' : null));
    if (result) {
      const o = outcomeOf(move, result, now, lce);
      settled.push({ move, result, returnedNano: o.returnedNano, outcome: o });
    } else moves.push(move);
  }
  const kept = s.outcomes.filter((o) => now - o.at < OUTCOME_KEEP_MS);
  const was = isEpoch(s.floor) ? s.floor : null;
  const floor = lce !== null && !(was !== null && was >= lce) ? lce : was;
  if (settled.length === 0 && kept.length === s.outcomes.length && floor === was) return { state: s, settled };
  const outcomes = [...kept, ...settled.map((x) => x.outcome)].slice(-MAX_OUTCOMES);
  return { state: { owner: s.owner, moves, outcomes, floor }, settled: settled.map(({ outcome, ...x }) => x) };
}

/**
 * The wallet's move in transit as the Node tab shows it ({ amountNano, restNano }: all that is in transit, and the rest
 * of the node balance the latest move left), or null.
 */
export function heldMove(state) {
  if (!state || state.moves.length === 0) return null;
  const last = state.moves[state.moves.length - 1];
  return { ...last, amountNano: String(transitTotal(state)) };
}

/** All that is in transit to the wallet, nanoQNC (0 when nothing is). */
export function transitTotal(state) {
  return state ? state.moves.reduce((sum, m) => sum + Number(m.amountNano), 0) : 0;
}

/**
 * What Assets' line shows in transit beside a QNC figure whose leaf has watermark `figureLce` (null: not known): the
 * epochs of each move that figure does not hold yet. A figure on screen that holds a move before a certified read ended
 * it (one not verified yet) does not show it twice; the move itself still waits for that read.
 */
export function shownTransitNano(state, figureLce = null) {
  if (!state) return 0;
  const w = isEpoch(figureLce) ? figureLce : null;
  return state.moves.reduce((sum, m) => {
    if (w === null || w <= m.prevWatermark) return sum + Number(m.amountNano);
    return sum + Number(m.amountNano) - appliedNano(m, w);
  }, 0);
}

/**
 * Whether a node balance answer may be shown for the wallet whose last certified claim watermark is `floor` (null: none
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
 * re-verified on chain against the certified reward root, so among nodes not behind the wallet's certified watermark an
 * honest one can only under-report), or null when none does.
 */
export function acceptedBalance(answers, floor = null) {
  const ok = (Array.isArray(answers) ? answers : []).filter((r) => balanceAnswerCounts(r, floor));
  return ok.length > 0 ? ok.reduce((m, r) => Math.max(m, r.pendingRewards), 0) : null;
}

/**
 * History rows with the state of the moves: the row of a move in transit is `moving`; the row of one a certified read
 * saw through is confirmed by that, whatever one node reported of it (its explorer row may not have come yet).
 */
export function withMoveStates(rows, state) {
  if (!Array.isArray(rows) || !state || (state.moves.length === 0 && state.outcomes.length === 0)) return rows;
  const moving = new Set(state.moves.map((m) => m.txHash).filter(Boolean));
  const through = new Set(state.outcomes.map((o) => o.txHash).filter(Boolean));
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

/** Keeps `state` for its wallet beside the others'; a failed write only loses the record for the next start. */
export async function writeTransit(state) {
  try {
    if (!state || !state.owner) return;
    let all = {};
    try { all = await readAll(); } catch (_) { all = {}; }
    const { [state.owner]: _old, ...others } = all;
    const empty = state.moves.length === 0 && state.outcomes.length === 0 && !isEpoch(state.floor);
    const kept = Object.keys(others).slice(-(MAX_WALLETS - (empty ? 0 : 1))).reduce((o, k) => ({ ...o, [k]: others[k] }), {});
    const wallets = empty ? kept : { ...kept, [state.owner]: state };
    if (Object.keys(wallets).length === 0) {
      await AsyncStorage.removeItem(TRANSIT_KEY);
      return;
    }
    await AsyncStorage.setItem(TRANSIT_KEY, JSON.stringify({ wallets }));
  } catch (_) { /* the screen still holds it for this session */ }
}
