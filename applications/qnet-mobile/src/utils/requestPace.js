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
// Assets and History: this often while the address socket is open (its events ask for the rest), else more often.
export const ASSETS_SOCKET_MS = 60_000;
export const ASSETS_POLL_MS = 30_000;
export const HISTORY_SOCKET_MS = 60_000;
export const HISTORY_POLL_MS = 30_000;
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

export const assetsPollMs = (socketOpen) => (socketOpen ? ASSETS_SOCKET_MS : ASSETS_POLL_MS);
export const historyPollMs = (socketOpen) => (socketOpen ? HISTORY_SOCKET_MS : HISTORY_POLL_MS);

/** The chain's height now as `read` ({ height, at }: a height and when it was read) puts it; 0 when none is known. */
export function estimatedHeight(read, now = Date.now()) {
  if (!read || !(read.height > 0) || !Number.isFinite(read.at)) return 0;
  return read.height + Math.floor(Math.min(Math.max(0, now - read.at), COUNTDOWN_MAX_MS) / 1000);
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
