// ─────────────────────────────────────────────────────────────────────────────
// @qnet/sdk — Public API surface
// ─────────────────────────────────────────────────────────────────────────────

// ── Core client ───────────────────────────────────────────────────────────────
export { QNetClient }                 from './client';

// ── Wallet helpers ────────────────────────────────────────────────────────────
export { buildUnsignedTransfer,
         buildRewardClaimPayload,
         addressFromPublicKeyHash }   from './wallet';

// ── Address utilities ─────────────────────────────────────────────────────────
export { isValidQNetAddress,
         publicKeyHashToAddress,
         computeChecksum,
         formatQNC,
         parseQNC }                   from './address';

// ── Contract interaction ──────────────────────────────────────────────────────
export { ContractHandle,
         encodeCalldata,
         decodeUint64,
         decodeBool }                 from './contract';
export type {
  DeployContractParams,
  DeployContractResult,
  CallContractParams,
  ContractCallResult,
  ContractLog,
}                                     from './contract';

// ── Event subscriptions (class-based) ────────────────────────────────────────
export { QNetSubscription }           from './subscription';
export type {
  BlockHandler    as SubBlockHandler,
  MacroHandler,
  TxHandler,
  ErrorHandler    as SubErrorHandler,
  SubscriptionOptions,
}                                     from './subscription';

// ── Block / event poller (functional API) ────────────────────────────────────
export { pollBlocks,
         waitForHeight,
         waitForTransaction }         from './poller';
export type {
  BlockHandler,
  ErrorHandler,
  PollerOptions,
}                                     from './poller';

// ── Typed error hierarchy ─────────────────────────────────────────────────────
export {
  QNetError,
  QNetApiError,
  QNetSyncError,
  QNetAddressError,
  QNetTransactionError,
  QNetRewardError,
  QNetContractError,
}                                     from './errors';

// ── All types ─────────────────────────────────────────────────────────────────
export * from './types';
