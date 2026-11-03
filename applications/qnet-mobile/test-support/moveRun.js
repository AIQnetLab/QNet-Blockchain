/* eslint-env jest */
/**
 * A run of Move to wallet under Jest: the claims of its parts, the wallet's live figure that shows them in the wallet,
 * and the wallet screen's run (WalletScreen startMove over services/MoveRun) for nodeLinkActions without the screen.
 */
const { runMove } = require('../src/services/MoveRun');

// The claim hashes of a run's parts.
const H1 = 'a1'.repeat(32);
const H2 = 'b2'.repeat(32);
const H3 = 'c3'.repeat(32);

// A part the network took, as a claim answers it: its batch above `prev` up to `last`, stopped at `stop` (a quote's
// stop reason) or whole; `pending` as WalletManager.claimRewards answers a claim it sent that no block holds yet.
const answer = ({ pending }) => (amountNano, prev, last, txHash, stop = null) => ({
  success: true, amountNano, prevWatermark: prev, lastEpoch: last, txHash, ...(pending ? { pending } : {}),
  stoppedAtEpoch: stop ? last + 1 : null, stoppedReason: stop,
});
const part = answer({ pending: false });
const sentPart = answer({ pending: true });

// The wallet's live figure (a genesis node's live tip, its proof folded) with its claim watermark.
const liveAt = (qnc, figureClaimedEpoch, blockHeight = 9100) => ({
  balance: qnc, balanceNano: String(Math.round(qnc * 1e9)), nonce: '3', blockHeight, figureClaimedEpoch,
});

/**
 * The screen's run for nodeLinkActions: `move` and `claimBusy`, one run at a time. A part is not followed here (`record`
 * false), so a run is one claim unless the test passes `record` and `settled` (a moveOutcome) that say otherwise.
 */
function sheetMove(walletManager, {
  walletAddress, credential = 'c', record = () => false, settled = async () => ({ result: 'done', appliedNano: 0 }),
} = {}) {
  let running = false;
  const move = async ({ nodeType, nodeId, balanceNano, until = null, onPart = () => {} }) => {
    if (!(balanceNano > 0) || running) return null;
    running = true;
    try {
      return await runMove({
        walletManager, credential: typeof credential === 'function' ? credential : () => credential, record, settled,
        pause: async () => {}, live: () => true,
        signing: () => {}, onPart, now: Date.now,
      }, { nodeType, nodeId, walletAddress, balanceNano, until });
    } finally {
      running = false;
    }
  };
  return { move, claimBusy: () => running };
}

module.exports = { H1, H2, H3, part, sentPart, liveAt, sheetMove };
