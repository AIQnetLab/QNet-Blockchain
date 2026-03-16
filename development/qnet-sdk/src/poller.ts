import { QNetClient } from './client';
import { MicroBlock, MacroBlock } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Block & Event Poller
//
// QNet nodes expose a REST API only (no WebSocket in v1).
// This module provides efficient polling utilities with:
//   - Exponential back-off on errors
//   - Missed-block recovery (downloads gaps automatically)
//   - MacroBlock-only mode (lighter polling for reward tracking)
// ─────────────────────────────────────────────────────────────────────────────

export type BlockHandler    = (block: MicroBlock | MacroBlock) => void | Promise<void>;
export type ErrorHandler    = (err: Error) => void;

export interface PollerOptions {
  /** Starting block height (default: current head) */
  fromHeight?: number;
  /** Poll interval in milliseconds (default 1000 — QNet ~1s microblocks) */
  intervalMs?: number;
  /** Only emit MacroBlocks (every 90 microblocks) — reduces callback frequency */
  macroBlockOnly?: boolean;
  /** Max consecutive errors before stopping (default 10) */
  maxErrors?: number;
}

/**
 * Subscribe to new QNet blocks via polling.
 *
 * Returns a `stop()` function to cancel the subscription.
 *
 * @example
 * const stop = pollBlocks(client, (block) => {
 *   console.log(`New block #${block.height} by ${block.producer}`);
 * });
 *
 * // Later:
 * stop();
 */
export function pollBlocks(
  client: QNetClient,
  onBlock: BlockHandler,
  options: PollerOptions = {},
  onError?: ErrorHandler,
): () => void {
  const intervalMs    = options.intervalMs    ?? 1_000;
  const macroOnly     = options.macroBlockOnly ?? false;
  const maxErrors     = options.maxErrors      ?? 10;

  let running         = true;
  let consecutiveErrs = 0;
  let currentHeight   = options.fromHeight ?? -1;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (!running) return;

    try {
      const latest = await client.getLatestBlock();

      // First run — initialise current height
      if (currentHeight === -1) {
        currentHeight = options.fromHeight ?? latest.height;
      }

      // Recover missed blocks (in case of long poll interval or restart)
      if (latest.height > currentHeight) {
        const missingFrom = currentHeight + 1;
        const missingTo   = Math.min(latest.height, missingFrom + 99); // max 100/call

        if (missingTo > missingFrom) {
          const blocks = await client.getBlocks(missingFrom, missingTo);
          for (const b of blocks) {
            if (!macroOnly || b.blockType === 'MACROBLOCK') {
              await onBlock(b);
            }
          }
          currentHeight = missingTo;
        } else {
          if (!macroOnly || latest.blockType === 'MACROBLOCK') {
            await onBlock(latest);
          }
          currentHeight = latest.height;
        }
      }

      consecutiveErrs = 0;
    } catch (err) {
      consecutiveErrs++;
      const e = err instanceof Error ? err : new Error(String(err));
      onError?.(e);
      if (consecutiveErrs >= maxErrors) {
        running = false;
        onError?.(new Error(`pollBlocks stopped after ${maxErrors} consecutive errors`));
        return;
      }
      // Exponential back-off capped at 30 s
      const backoff = Math.min(intervalMs * 2 ** consecutiveErrs, 30_000);
      await sleep(backoff);
    }

    if (running) {
      timer = setTimeout(tick, intervalMs);
    }
  }

  // Kick off immediately
  void tick();

  return () => {
    running = false;
    if (timer !== null) clearTimeout(timer);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Await a specific block height (useful in tests / scripting)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve once the network reaches or exceeds `targetHeight`.
 *
 * @example
 * // Wait for the next MacroBlock after the current head
 * const latest = await client.getLatestBlock();
 * const nextMacro = Math.ceil((latest.height + 1) / 90) * 90;
 * const macroBlock = await waitForHeight(client, nextMacro, { timeoutMs: 120_000 });
 */
export async function waitForHeight(
  client: QNetClient,
  targetHeight: number,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<MicroBlock | MacroBlock> {
  const pollMs   = options.pollIntervalMs ?? 1_000;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);

  while (Date.now() < deadline) {
    const latest = await client.getLatestBlock();
    if (latest.height >= targetHeight) {
      return client.getBlock(targetHeight);
    }
    await sleep(pollMs);
  }

  throw new Error(`waitForHeight: timed out waiting for block ${targetHeight}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Await transaction confirmation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve once a transaction with `txHash` appears in a confirmed block.
 *
 * @example
 * const tx = await waitForTransaction(client, result.txHash, { confirmations: 1 });
 * console.log('Confirmed at block', tx.blockHeight);
 */
export async function waitForTransaction(
  client: QNetClient,
  txHash: string,
  options: { confirmations?: number; pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<import('./types').Transaction> {
  const confirmations = options.confirmations  ?? 1;
  const pollMs        = options.pollIntervalMs ?? 1_000;
  const deadline      = Date.now() + (options.timeoutMs ?? 120_000);

  while (Date.now() < deadline) {
    try {
      const tx = await client.getTransaction(txHash);
      if (tx.status === 'confirmed') {
        if (confirmations <= 1) return tx;
        const latest = await client.getLatestBlock();
        if (latest.height - tx.blockHeight >= confirmations - 1) return tx;
      }
      if (tx.status === 'failed') {
        throw new Error(`Transaction ${txHash} failed on-chain`);
      }
    } catch (err) {
      // Transaction not yet indexed — keep polling
      if (!(err instanceof Error && err.message.includes('404'))) throw err;
    }
    await sleep(pollMs);
  }

  throw new Error(`waitForTransaction: timed out waiting for ${txHash}`);
}

// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
