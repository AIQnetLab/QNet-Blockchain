// The chain's epochs as the cabinet numbers them (development/qnet-integration/src/reward_epoch.rs): an epoch is
// 14,400 blocks, about 4 hours at one block a second, numbered by block height / 14,400, as the node status numbers
// its counted epochs. The network settles each epoch under a key of its own, the macroblock index 160 * (N + 1)
// (a macroblock every 90 blocks), which the nodes' per-epoch history names; key K settles blocks
// [(K / 160 - 1) * 14,400, K / 160 * 14,400), the epoch K / 160 - 1 (work_window_of, work_epoch_of). Pure.

export const EPOCH_BLOCKS = 14_400;
export const MB_PER_EPOCH = 160;

export interface EpochSpan {
  epoch: number;
  // Its blocks, [start, end).
  start: number;
  end: number;
}

// The epoch the key `key` settles; null for a number that is no such key (is_reward_epoch), or the first key, which
// settles nothing.
export function epochOfKey(key: number): EpochSpan | null {
  if (!Number.isSafeInteger(key) || key < MB_PER_EPOCH || key % MB_PER_EPOCH !== 0) return null;
  const end = key / MB_PER_EPOCH;
  return { epoch: end - 1, start: (end - 1) * EPOCH_BLOCKS, end: end * EPOCH_BLOCKS };
}

export function epochOfHeight(height: number): number {
  return Math.floor(height / EPOCH_BLOCKS);
}

export interface EpochProgress {
  epoch: number;
  // Blocks to the epoch's end, 1 to EPOCH_BLOCKS, and the share of its blocks done.
  left: number;
  done: number;
}

// Where the head is in its epoch, the one rule for every epoch reading; null while the height is not known.
export function epochProgress(height: number): EpochProgress | null {
  if (!Number.isSafeInteger(height) || height <= 0) return null;
  const left = EPOCH_BLOCKS - (height % EPOCH_BLOCKS);
  return { epoch: epochOfHeight(height), left, done: (EPOCH_BLOCKS - left) / EPOCH_BLOCKS };
}
