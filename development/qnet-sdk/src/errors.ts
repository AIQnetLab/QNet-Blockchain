// ─────────────────────────────────────────────────────────────────────────────
// QNet SDK — Typed error hierarchy
// ─────────────────────────────────────────────────────────────────────────────

/** Base class for all QNet SDK errors. Includes the HTTP status when known. */
export class QNetError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'QNetError';
  }
}

/** Thrown when the node returns a non-2xx HTTP response. */
export class QNetApiError extends QNetError {
  constructor(message: string, httpStatus: number) {
    super(message, 'API_ERROR', httpStatus);
    this.name = 'QNetApiError';
  }
}

/** Thrown when an operation cannot be completed because the node is not synced. */
export class QNetSyncError extends QNetError {
  constructor(currentHeight: number, networkHeight: number) {
    super(
      `Node is not synced (local=${currentHeight} network=${networkHeight})`,
      'NODE_NOT_SYNCED',
    );
    this.name = 'QNetSyncError';
  }
}

/** Thrown when a provided address fails checksum or format validation. */
export class QNetAddressError extends QNetError {
  constructor(address: string) {
    super(`Invalid QNet address: "${address}"`, 'INVALID_ADDRESS');
    this.name = 'QNetAddressError';
  }
}

/** Thrown when a transaction is rejected by the node (e.g. bad nonce, low fee). */
export class QNetTransactionError extends QNetError {
  constructor(message: string, public readonly txHash?: string) {
    super(message, 'TX_REJECTED');
    this.name = 'QNetTransactionError';
  }
}

/** Thrown when a reward claim is rejected (bad signature, no pending rewards). */
export class QNetRewardError extends QNetError {
  constructor(message: string) {
    super(message, 'REWARD_CLAIM_FAILED');
    this.name = 'QNetRewardError';
  }
}

/** Thrown when a contract call reverts or a deploy fails. */
export class QNetContractError extends QNetError {
  constructor(message: string, public readonly contractAddress?: string) {
    super(message, 'CONTRACT_ERROR');
    this.name = 'QNetContractError';
  }
}
