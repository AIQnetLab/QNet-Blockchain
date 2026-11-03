/**
 * The words of a move of a node balance (Move to wallet), one composition for the Node tab's result card (WalletScreen
 * txResultNote, claimErrorText) and a QNet Link claim sheet's outcome (screens/QNetLinkScreen). A move that did not go
 * says the text of its code, never the words a node or the client put in the error (those are English and may speak the
 * network's own terms); anything else says the network did not take it.
 */
export const CLAIM_TEXT = Object.freeze({
  NO_REWARDS: 'err_NO_REWARDS', MIN_CLAIM: 'err_MIN_CLAIM', CLAIM_BUSY: 'err_CLAIM_BUSY', NODE_ID_UNKNOWN: 'err_NODE_ID_UNKNOWN',
  NOT_REGISTERED: 'err_NOT_REGISTERED', RATE_LIMITED: 'err_RATE_LIMITED', TX_EXPIRED: 'err_TX_EXPIRED',
});

/** The text key of a move that did not go: an error or a refusal, by its `code`. */
export const claimErrorKey = (error) => (error && CLAIM_TEXT[error.code]) || 'claim_failed';

/**
 * What a move says under its amount, from its note (ClaimTransit.moveNote or runNote): the note itself; then, for a
 * next part that was not sent, the refusal's text when its code says more than that the rest stays (TX_EXPIRED speaks
 * of one part alone); then that the network did not answer, when that part may have gone. `amountText(nano)` writes an
 * amount as the screen shows it.
 */
export function moveNoteText(t, n, amountText) {
  const why = n.reason && n.reason !== 'TX_EXPIRED' ? CLAIM_TEXT[n.reason] : null;
  return [
    t(n.key, n.appliedNano !== undefined ? { amount: amountText(n.appliedNano) } : { epoch: n.epoch }),
    why ? t(why) : null,
    n.unknown ? t('claim_note_unknown') : null,
  ].filter(Boolean).join(' ');
}
