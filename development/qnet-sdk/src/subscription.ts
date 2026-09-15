import { QNetClient } from './client';
import { MicroBlock, MacroBlock, Transaction, QNetAddress } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// QNet Event Subscription (polling-based — WebSocket optional in v2)
// ─────────────────────────────────────────────────────────────────────────────

export type BlockHandler     = (block: MicroBlock | MacroBlock) => void;
export type MacroHandler     = (block: MacroBlock) => void;
export type TxHandler        = (tx: Transaction) => void;
export type ErrorHandler     = (err: Error) => void;

export interface SubscriptionOptions {
  /** Poll interval in milliseconds (default 1000 — one microblock per second) */
  pollIntervalMs?: number;
  /** Suppress console errors (default false) */
  silent?: boolean;
}

/**
 * Subscribe to real-time QNet events via polling.
 *
 * @example
 * ```typescript
 * const sub = new QNetSubscription(client, { pollIntervalMs: 1000 });
 *
 * sub.onBlock(block => console.log('New block:', block.height));
 * sub.onMacroBlock(mb => console.log('MacroBlock epoch:', mb.epoch));
 * sub.onAddressTransaction('19chex...', tx => console.log('Incoming tx:', tx.hash));
 *
 * sub.start();
 * // ... later ...
 * sub.stop();
 * ```
 */
export class QNetSubscription {
  private blockHandlers:       BlockHandler[]                           = [];
  private macroHandlers:       MacroHandler[]                          = [];
  private txHandlers:          Map<QNetAddress, TxHandler[]>           = new Map();
  private errorHandlers:       ErrorHandler[]                          = [];
  private timer:               ReturnType<typeof setInterval> | null   = null;
  private lastHeight:          number                                  = -1;
  private readonly interval:   number;
  private readonly silent:     boolean;

  constructor(
    private readonly client: QNetClient,
    options: SubscriptionOptions = {},
  ) {
    this.interval = options.pollIntervalMs ?? 1_000;
    this.silent   = options.silent         ?? false;
  }

  // ── Registration ────────────────────────────────────────────────────────────

  /** Fires for every new micro- or macroblock. */
  onBlock(handler: BlockHandler): this {
    this.blockHandlers.push(handler);
    return this;
  }

  /** Fires only for MacroBlocks (every 90 microblocks). */
  onMacroBlock(handler: MacroHandler): this {
    this.macroHandlers.push(handler);
    return this;
  }

  /**
   * Fires whenever a transaction involving `address` appears in a new block.
   * Multiple handlers can be registered for the same address.
   */
  onAddressTransaction(address: QNetAddress, handler: TxHandler): this {
    if (!this.txHandlers.has(address)) {
      this.txHandlers.set(address, []);
    }
    this.txHandlers.get(address)!.push(handler);
    return this;
  }

  /** Fires when the polling loop encounters an error (network, etc.). */
  onError(handler: ErrorHandler): this {
    this.errorHandlers.push(handler);
    return this;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /** Begin polling. Safe to call multiple times — subsequent calls are no-ops. */
  start(): this {
    if (this.timer !== null) return this;
    this.timer = setInterval(() => this.poll(), this.interval);
    // Kick off immediately so callers don't wait for the first interval
    void this.poll();
    return this;
  }

  /** Stop polling and remove the interval. */
  stop(): this {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this;
  }

  /** `true` while the subscription is actively polling. */
  get isRunning(): boolean {
    return this.timer !== null;
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      const latest = await this.client.getLatestBlock();
      if (latest.height <= this.lastHeight) return; // no new block

      // Fetch any blocks we may have missed since last poll
      const from = this.lastHeight + 1;
      const to   = Math.min(latest.height, from + 50); // max 50 at once
      this.lastHeight = to;

      const blocks = (to > from)
        ? await this.client.getBlocks(from, to)
        : [latest];

      for (const block of blocks) {
        // Notify all block handlers
        for (const h of this.blockHandlers) h(block);

        // Notify MacroBlock handlers
        if (block.blockType === 'MACROBLOCK') {
          for (const h of this.macroHandlers) h(block as MacroBlock);
        }

        // Address-specific transaction watchers
        if (this.txHandlers.size > 0) {
          await this.notifyTxHandlers(block.height);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!this.silent) {
        for (const h of this.errorHandlers) h(error);
      }
    }
  }

  private async notifyTxHandlers(height: number): Promise<void> {
    for (const [address, handlers] of this.txHandlers) {
      try {
        const txs = await this.client.getAddressTransactions(address, 10, 0);
        for (const tx of txs) {
          if (tx.blockHeight === height) {
            for (const h of handlers) h(tx);
          }
        }
      } catch {
        // Swallow per-address errors to avoid stopping the subscription
      }
    }
  }
}
