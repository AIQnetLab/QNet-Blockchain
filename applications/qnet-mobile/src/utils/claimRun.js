// The rules of a node balance's move in parts that the app and the extension share. It imports nothing: the
// extension's crypto bundle compiles it for its own move.

// The stops of a quote at a bound of one request (rewards_api.rs: MAX_BATCH, CLAIM_QUOTE_BYTE_BUDGET, the leaf rebuilds
// of one request): the next quote goes on from the watermark this batch leaves. Any other stop is an epoch the nodes
// cannot serve now, which stays for a later move.
export const SIZE_STOPS = Object.freeze(['batch_full', 'quote_byte_budget', 'rebuild_budget']);

// The next part that every node quoted from before the last part (none applied it yet) is asked for again this many
// times, this far apart: the nodes apply a block within a second or two of each other.
export const BEHIND_TRIES = 2;
export const BEHIND_WAIT_MS = 3_000;
