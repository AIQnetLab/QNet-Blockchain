/**
 * How often the open app asks the network for what is on screen, and how its address socket comes back (docs:
 * mobile-wallet "Requests from the open app"). At ten million devices a million apps may be open at once, so every
 * figure here is per open app; a screen in the background asks nothing.
 */

const EPOCH_BLOCKS = 14400;

// The Node tab: its statuses on every open, pull to refresh, return to the app and after Use this device, and in
// between this often.
export const NODE_STATUS_MS = 5 * 60_000;
// The epoch clock runs from the last height read at one block a second, for at most this long past it.
export const COUNTDOWN_MAX_MS = 10 * 60_000;
// While a light node is being linked (its record not on the chain yet): its status every LINKING_FAST_MS for the first
// LINKING_FAST_FOR_MS after the link, then every LINKING_SLOW_MS (linkingReadMs).
export const LINKING_FAST_MS = 10_000;
export const LINKING_FAST_FOR_MS = 2 * 60_000;
export const LINKING_SLOW_MS = 60_000;
// Assets and History: every ASSETS_POLL_MS and HISTORY_POLL_MS, and every SOCKET_LIVE_POLL_MS while the address socket
// is live (it delivered an account event, whose follow reads the rest); one that delivered none (an older node) or a
// refused socket keeps the shorter pace (pollMs).
export const ASSETS_POLL_MS = 30_000;
export const HISTORY_POLL_MS = 30_000;
export const SOCKET_LIVE_POLL_MS = 60_000;
// The wallet's QNC figure at a genesis node's live tip: this often while Assets is in front and the address socket is
// not live, and while a move of a node balance is in transit (the figure whose watermark ends it).
export const LIVE_READ_MS = 15_000;
// An account event (the node's BalanceUpdate: a block touched the wallet) is a hint: the live figure ACCOUNT_EVENT_MS
// after it, again as often while the figure shown is of a state before the event's block, ACCOUNT_EVENT_READS at most.
export const ACCOUNT_EVENT_MS = 1000;
export const ACCOUNT_EVENT_READS = 3;
// A live figure read this recently is taken as it is: the LIVE_READ_MS read skips while one is younger than
// LIVE_READ_MS - LIVE_SHARE_MS, and the balance read takes one younger than LIVE_SHARE_MS, so an open Assets asks for it
// twice in ASSETS_POLL_MS whichever timer fires first.
export const LIVE_SHARE_MS = 2000;
// The address socket: after a drop, a wait drawn evenly between zero and SOCKET_BASE_MS doubled per failure in a row,
// at most SOCKET_MAX_MS; after a refusal (it closed before it opened: the node's connection limit, or no network),
// SOCKET_REFUSED_MS and a wait drawn evenly up to SOCKET_MAX_MS on top.
export const SOCKET_BASE_MS = 5000;
export const SOCKET_MAX_MS = 300_000;
export const SOCKET_REFUSED_MS = 300_000;
const SOCKET_MIN_MS = 1000;

/** The wait before the address socket's next try, after `failures` in a row; `opened` when the last one had opened. */
export function socketRetryMs(failures, { opened = true, random = Math.random } = {}) {
  if (!opened) return SOCKET_REFUSED_MS + Math.floor(random() * SOCKET_MAX_MS);
  const cap = Math.min(SOCKET_MAX_MS, SOCKET_BASE_MS * 2 ** Math.max(0, Math.min(failures, 16)));
  return Math.max(SOCKET_MIN_MS, Math.floor(random() * cap));
}

/** The wait before the next read of Assets or History (`baseMs`); `socketLive` while the address socket is live. */
export const pollMs = (baseMs, socketLive) => (socketLive ? SOCKET_LIVE_POLL_MS : baseMs);

/** The wait before the next status read of a light node being linked, `sinceMs` after the link started. */
export const linkingReadMs = (sinceMs) => (sinceMs < LINKING_FAST_FOR_MS ? LINKING_FAST_MS : LINKING_SLOW_MS);

/** The chain's height now as `read` ({ height, at }: a height and when it was read) puts it; 0 when none is known. */
export function estimatedHeight(read, now = Date.now()) {
  if (!read || !(read.height > 0) || !Number.isFinite(read.at)) return 0;
  return read.height + Math.floor(Math.min(Math.max(0, now - read.at), COUNTDOWN_MAX_MS) / 1000);
}

// A live figure names the block of the state it was read at. More than LIVE_TIP_MARGIN blocks past the chain's height
// as the app read it within TIP_FRESH_MS, counted on, is of no state the chain has (a node on a branch the chain left, or
// a faulty one). The live reads read that height again once it is TIP_READ_MS old.
export const LIVE_TIP_MARGIN = 30;
export const TIP_FRESH_MS = 120_000;
export const TIP_READ_MS = 60_000;

/** Whether a live figure of block `height` fits the chain's height as `read` puts it; true while no read is that fresh. */
export function liveHeightFits(height, read, now = Date.now()) {
  if (!read || !(read.height > 0) || !Number.isFinite(read.at) || now - read.at > TIP_FRESH_MS) return true;
  return height <= estimatedHeight(read, now) + LIVE_TIP_MARGIN;
}

/**
 * Whether a node balance is due for a read: once per epoch and node (it changes only when an epoch settles, and with a
 * move, which asks for it), and every NODE_STATUS_MS while the epoch is not known. `last`: { nodeId, epoch, at } of the
 * last read, or null.
 */
export function balanceDue(last, nodeId, height, now = Date.now()) {
  if (!last || last.nodeId !== nodeId) return true;
  const epoch = height > 0 ? Math.floor(height / EPOCH_BLOCKS) : null;
  if (epoch === null || last.epoch === null) return now - last.at >= NODE_STATUS_MS;
  return epoch !== last.epoch;
}

/** The record of a balance read now, for balanceDue. */
export const balanceRead = (nodeId, height, now = Date.now()) => ({
  nodeId, epoch: height > 0 ? Math.floor(height / EPOCH_BLOCKS) : null, at: now,
});
