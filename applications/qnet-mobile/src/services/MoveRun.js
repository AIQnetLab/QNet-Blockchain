/**
 * One press of Move to wallet, the Node tab's and a QNet Link claim sheet's alike: one quote holds at most what one
 * request may (rewards_api.rs), so the balance shown moves in parts, each once the one before is in the wallet (its
 * record's watermark, never a clock). Only the sheet's answer has a deadline (`until`), inside its session.
 */
import { claimedNano, movesOn, restEpochOf } from './ClaimTransit';
import { BEHIND_TRIES, BEHIND_WAIT_MS } from '../utils/claimRun';

// What part `p` of a run put in the wallet (BigInt nanoQNC), by its record now (`o`: ClaimTransit.moveOutcome), else by
// what the run saw (`takenNano`): what it submitted, the share of one taken in part, nothing of one that expired.
function partNano(p, o) {
  if (o && o.result === 'expired') return 0n;
  if (o && o.result === 'partial') {
    const applied = Math.round(Number(o.appliedNano));
    return Number.isFinite(applied) && applied > 0 ? BigInt(applied) : 0n;
  }
  return BigInt(o ? p.amountNano : (p.takenNano ?? p.amountNano));
}

/**
 * What the parts of `run` put in the wallet (BigInt nanoQNC), each by what its record says now, `outcomeOf(txHash)`
 * (ClaimTransit.moveOutcome; null: what the run saw). The QNet Link answer and the Node tab's card count a move so.
 */
export function runMovedNano(run, outcomeOf = () => null) {
  return run.parts.reduce((sum, p) => sum + partNano(p, outcomeOf(p.txHash)), 0n);
}

/**
 * The last part of `run` that counts, by the same reading (it put something in the wallet, or still may; one that
 * expired counts nothing), or null: the claim the QNet Link answer names, and the hash the Node tab's card shows.
 */
export function lastCountedPart(run, outcomeOf = () => null) {
  for (let i = run.parts.length - 1; i >= 0; i -= 1) {
    if (partNano(run.parts[i], outcomeOf(run.parts[i].txHash)) > 0n) return run.parts[i];
  }
  return null;
}

/**
 * Runs the parts of one move; the first part's error is thrown.
 * @param steps { walletManager, credential() (null once locked), record(nodeId, result, restNano) (the part in transit;
 *   false: not followed), settled(txHash, until) (its record's moveOutcome once not moving, null once `until` passed or no
 *   record names it), pause(ms), live(), signing(on), onPart({ parts, movedNano, more }), now() }
 * @param request { nodeType, nodeId, walletAddress, balanceNano (shown at the press), until (ms, null for none) }
 * @returns { parts: [{ txHash, amountNano (submitted), lastEpoch, stoppedAtEpoch, takenNano? and restEpoch? (a last part
 *   its record showed taken in part, or expired: '0') }], movedNano (BigInt, submitted), whole (nothing left to quote),
 *   stop ({ code } | { unknown: true } | { ended: true }: why no next part went; null), settled ('partial' | 'expired';
 *   null), live, refused (the first part's refusal; null) }
 */
export async function runMove(steps, request) {
  const { walletManager, credential, record, settled, pause, live, signing, onPart = () => {}, now = Date.now } = steps;
  const { nodeType, nodeId, walletAddress, balanceNano, until = null } = request;
  const run = { parts: [], movedNano: 0n, whole: false, stop: null, settled: null, live: true, refused: null };
  const end = (extra = {}) => Object.assign(run, extra, { live: live() });
  // The next part goes only with the session open, and before `until`.
  const mayGoOn = () => !!credential() && !(Number.isFinite(until) && now() >= until);
  let after = null;
  let behind = 0;
  for (;;) {
    const first = run.parts.length === 0;
    let result = null;
    let failure = null;
    signing(true);
    try {
      result = await walletManager.claimRewards(nodeType, walletAddress, credential(), first ? balanceNano : null, nodeId, { after });
    } catch (error) {
      failure = { error };
    } finally {
      signing(false);
    }
    if (failure) {
      const { error } = failure;
      if (first) throw error;
      const code = (error && error.code) || null;
      if (code === 'CLAIM_BEHIND' && behind < BEHIND_TRIES) {
        behind += 1;
        await pause(BEHIND_WAIT_MS);
        if (!live()) return end();
        if (!mayGoOn()) return end({ stop: { ended: true } });
        continue;
      }
      // Nothing left after the parts before is the whole balance moved; anything else is said with its reason.
      if (code === 'NO_REWARDS') return end({ whole: true });
      return end({ stop: error && error.unknown ? { unknown: true } : { code } });
    }
    if (!result || !result.success) {
      // Nothing was submitted for this part: the node refused it.
      if (first) return end({ refused: result || { success: false } });
      return end(result && result.code === 'NO_REWARDS' ? { whole: true } : { stop: { code: (result && result.code) || null } });
    }
    // A part the network took is the wallet's move in transit, and counts in the run's total, even when the screen went.
    const followed = record(nodeId, result, balanceNano - Number(run.movedNano)) === true;
    const amountNano = claimedNano(result) || '0';
    run.parts.push({
      txHash: result.txHash, amountNano, lastEpoch: result.lastEpoch,
      stoppedAtEpoch: Number.isSafeInteger(result.stoppedAtEpoch) ? result.stoppedAtEpoch : null,
    });
    run.movedNano += BigInt(amountNano);
    behind = 0;
    if (!live()) return end();
    const more = followed && movesOn(result) && run.movedNano < BigInt(Math.floor(balanceNano));
    onPart({ parts: run.parts.slice(), movedNano: run.movedNano, more });
    if (!more) return end({ whole: !Number.isSafeInteger(result.stoppedAtEpoch) });
    const outcome = await settled(result.txHash, until);
    if (!live()) return end();
    // null: `until` passed with the part in transit (or no record names it): the request stops sending, the part goes on.
    if (outcome === null) return end();
    if (outcome.result !== 'done') {
      // What the record shows of it, which the answer counts: its applied share and where the rest begins, or nothing.
      const last = run.parts[run.parts.length - 1];
      const restEpoch = outcome.result === 'partial' ? restEpochOf(result.parts, outcome.appliedNano) : null;
      run.parts[run.parts.length - 1] = { ...last, takenNano: partNano(last, outcome).toString(), restEpoch };
      return end({ settled: outcome.result });
    }
    if (!mayGoOn()) return end({ stop: { ended: true } });
    after = result.lastEpoch;
  }
}
