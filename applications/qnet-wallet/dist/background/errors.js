// Errors that cross the worker boundary. A module throws WalletError(code); the router turns any error
// into a generic envelope: a stable code and a fixed message from this table, never the thrown text, so
// no secret, address, amount or activation code can leave the worker inside an error (R21).

export const ERROR_MESSAGES = Object.freeze({
  // router
  INVALID_REQUEST: 'Malformed request',
  UNKNOWN_TYPE: 'Unknown request type',
  FORBIDDEN_SENDER: 'Request not allowed from this sender',
  INVALID_PARAMS: 'Invalid parameters',
  // a contract call carries no QNC value and no access list: the network accepts neither today
  UNSUPPORTED_PARAM: 'The network does not accept this parameter',
  // vault and session
  NO_VAULT: 'No wallet exists',
  VAULT_EXISTS: 'A wallet already exists',
  LOCKED: 'Wallet is locked',
  BAD_PASSWORD: 'Wrong password',
  BACKOFF: 'Too many attempts, wait before retrying',
  WEAK_PASSWORD: 'Password is shorter than the minimum',
  KDF_BELOW_FLOOR: 'Vault key derivation is below the minimum',
  VAULT_CORRUPT: 'Wallet data failed its integrity check',
  ADDRESS_MISMATCH: 'Derived addresses do not match the wallet',
  SIGNING_DISABLED: 'Signing is disabled: the crypto self-test failed',
  RESTORE_EXPIRED: 'The restore step expired, start again',
  // network
  NETWORK: 'Network unavailable',
  NODE_REJECTED: 'A node refused the transaction; it may still apply, so the wallet keeps it and the next transfer takes its place',
  SOLANA_UNAVAILABLE: 'Solana could not be read',
  HISTORY_TOO_LONG: 'The Solana history is too long to search in one go, try again to continue',
  // QNet
  INSUFFICIENT_FUNDS: 'Insufficient balance',
  FEE_CHANGED: 'The fee changed, review again',
  NONCE_CHANGED: 'The account changed, review again',
  NONCE_UNAVAILABLE: 'The account nonce could not be verified',
  // a balance is verified by the committee's certificate or it decides nothing: answers came, none certified a recent state
  BALANCE_UNCONFIRMED: 'The balance is not confirmed yet',
  // a nonce above the certified state that is none of this wallet's own transactions: one sent from another device
  BALANCE_FOREIGN_PENDING: 'A transaction from another device is not confirmed yet',
  TOO_MANY_PENDING: 'Too many unconfirmed transactions',
  // a contract account has no key and no contract sends QNC or a built-in token on: what reaches one stays there
  RECIPIENT_IS_CONTRACT: 'The recipient is a contract: nothing can ever move what is sent to it',
  RECIPIENT_UNCHECKED: 'The recipient could not be checked',
  // Solana
  INSUFFICIENT_SOL: 'Not enough SOL for the transaction and its network fee',
  INSUFFICIENT_TOKENS: 'Not enough 1DEV',
  // the chain's rent rule: a funded account keeps its rent floor or is emptied, and a new account starts with the floor
  SOL_BELOW_RENT: 'The SOL left in the account would be below its rent floor',
  AMOUNT_BELOW_RENT: 'A first transfer to a new account must cover its rent floor',
  BLOCKHASH_EXPIRED: 'The transaction expired before it was sent, review again',
  SIMULATION_FAILED: 'The transaction failed simulation',
  TX_FAILED: 'The transaction failed on chain',
  // a payment request's references and memo add to the transaction, whose size Solana caps
  TX_TOO_LARGE: 'The transaction is larger than Solana accepts',
  // activation
  ALREADY_ACTIVATED: 'This wallet already has an activation code',
  BURN_EXISTS: 'This wallet already burned for a node: use Recover',
  BURN_UNUSABLE: 'This wallet already burned for a node in a form this version cannot derive a code from',
  NODE_EXISTS: 'This wallet already has a node',
  PRICE_UNAVAILABLE: 'The activation price is unavailable',
  PRICE_CHANGED: 'The activation price changed, review again',
  PHASE_UNSUPPORTED: 'Activation by burn is not available in this phase',
  BURN_IN_PROGRESS: 'An activation is already in progress',
  // aiqnet.io's record of this wallet's burn (decision 35): it holds one; one is starting elsewhere; it could not answer
  ACTIVATION_RECORDED: 'aiqnet.io holds a burn of this wallet',
  ACTIVATION_RESERVED: 'An activation of this wallet is starting elsewhere',
  RECORD_UNAVAILABLE: 'aiqnet.io could not be reached',
  // the light node (nodes.js)
  NO_NODE: 'This wallet has no light node on the QNet network',
  CLAIM_REFUSED: 'The QNet network refused to move the node balance',
  CLAIM_BUSY: 'A move of this node balance is already running',
  // the wallet key's unbind of the light node's device (decision 38)
  NOT_LINKED: 'The light node runs on no device',
  UNLINK_REFUSED: 'The QNet network refused to unlink the device',
  // provider, approvals
  NOT_FOUND: 'Request not found',
  USER_REJECTED: 'Request rejected',
  APPROVAL_COOLDOWN: 'Too many rejected requests from this site, try again later',
  UNAUTHORIZED: 'Site is not connected or the wallet is locked',
  UNSUPPORTED_METHOD: 'Unsupported method',
  DISCONNECTED: 'Disconnected',
  // qnet-core CoreError codes that may surface unchanged
  INVALID_MNEMONIC: 'Invalid recovery phrase',
  INVALID_ADDRESS: 'Invalid address',
  INVALID_AMOUNT: 'Invalid amount',
  INVALID_INTEGER: 'Invalid number',
  INVALID_MESSAGE: 'Invalid message',
  MESSAGE_TOO_LONG: 'Message too long',
  PROTOCOL_PREFIX: 'Message looks like a protocol message',
  INVALID_ORIGIN: 'Invalid origin',
  INVALID_NODE_TYPE: 'Invalid node type',
  INVALID_BURN_TX: 'Invalid burn transaction',
  INVALID_TRANSFER: 'Invalid transfer',
  INVALID_METHOD: 'Invalid contract method',
  INVALID_ARGS: 'Invalid contract call input',
  INVALID_GAS_LIMIT: 'Invalid gas limit',
  KEY_ADDRESS_MISMATCH: 'Key does not match the address',
  SIGNATURE_SELF_CHECK_FAILED: 'Signature self-check failed',
  SELF_TEST_FAILED: 'Crypto self-test failed',
  INTERNAL: 'Internal error',
});

// Provider error codes (4001-4900) and the generic invalid-params and internal codes of the dApp provider.
export const PROVIDER_ERROR_CODES = Object.freeze({
  USER_REJECTED: 4001,
  UNAUTHORIZED: 4100,
  UNSUPPORTED_METHOD: 4200,
  DISCONNECTED: 4900,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
});

const PROVIDER_MESSAGES = Object.freeze({
  4001: 'User rejected the request',
  4100: 'Unauthorized',
  4200: 'Unsupported method',
  4900: 'Disconnected',
  [-32602]: 'Invalid params',
  [-32603]: 'Internal error',
});

// Wallet codes a dApp may learn as invalid input; everything else it did not cause is -32603.
const PROVIDER_INPUT_CODES = new Set([
  'INVALID_PARAMS', 'INVALID_REQUEST', 'INVALID_ADDRESS', 'INVALID_AMOUNT', 'INVALID_INTEGER',
  'INVALID_MESSAGE', 'MESSAGE_TOO_LONG', 'PROTOCOL_PREFIX', 'INVALID_TRANSFER', 'INVALID_METHOD', 'INVALID_ARGS', 'INVALID_GAS_LIMIT',
  'UNSUPPORTED_PARAM', 'RECIPIENT_IS_CONTRACT',
]);
// The fields of a contract call the network does not accept today (UNSUPPORTED_PARAM names which one).
export const UNSUPPORTED_CALL_FIELDS = Object.freeze(['value', 'accessList']);
// The provider text of that refusal, the one other text a -32602 carries (the mobile in-app browser's too).
export const UNSUPPORTED_PARAM_MESSAGE = 'Unsupported parameter';

export class WalletError extends Error {
  /**
   * @param {string} code key of ERROR_MESSAGES
   * @param {{retryAfterMs?: number, field?: string}} [extra] retryAfterMs for BACKOFF; field for INVALID_PARAMS
   */
  constructor(code, extra = {}) {
    super(code);
    this.name = 'WalletError';
    this.code = code;
    if (Number.isSafeInteger(extra.retryAfterMs) && extra.retryAfterMs > 0) this.retryAfterMs = extra.retryAfterMs;
    if (typeof extra.field === 'string') this.field = extra.field;
  }
}

export class ProviderError extends Error {
  /** @param {number} code a PROVIDER_ERROR_CODES value */
  constructor(code) {
    super(PROVIDER_MESSAGES[code] ?? PROVIDER_MESSAGES[-32603]);
    this.name = 'ProviderError';
    this.code = Object.hasOwn(PROVIDER_MESSAGES, code) ? code : PROVIDER_ERROR_CODES.INTERNAL;
  }
}

const isKnownCode = (code) => typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code);
const isCoreError = (error) => error?.name === 'CoreError' && typeof error.code === 'string';

/**
 * The error half of a UI envelope. Only WalletError and qnet-core CoreError codes pass through; any
 * other error becomes INTERNAL.
 * @param {unknown} error
 * @returns {{code: string, message: string, retryAfterMs?: number, field?: string}}
 */
export function toUiError(error) {
  const code = (error instanceof WalletError || isCoreError(error)) && isKnownCode(error.code) ? error.code : 'INTERNAL';
  const out = { code, message: ERROR_MESSAGES[code] };
  if (code === 'BACKOFF' && error.retryAfterMs) out.retryAfterMs = error.retryAfterMs;
  if (code === 'INVALID_PARAMS' && typeof error.field === 'string') out.field = error.field;
  return out;
}

/**
 * The error half of a provider envelope. A contract call naming a field the network does not accept is -32602 with
 * the text UNSUPPORTED_PARAM_MESSAGE and data {reason: 'UNSUPPORTED_PARAM'}, the only error that carries data (the
 * mobile in-app browser's shape).
 * @param {unknown} error
 * @returns {{code: number, message: string, data?: {reason: 'UNSUPPORTED_PARAM'}}}
 */
export function toProviderError(error) {
  // An origin in its approval cooldown: 4001 at once, with its own fixed text.
  if (error instanceof WalletError && error.code === 'APPROVAL_COOLDOWN') {
    return { code: PROVIDER_ERROR_CODES.USER_REJECTED, message: ERROR_MESSAGES.APPROVAL_COOLDOWN };
  }
  if (error instanceof WalletError && error.code === 'UNSUPPORTED_PARAM' && UNSUPPORTED_CALL_FIELDS.includes(error.field)) {
    return { code: PROVIDER_ERROR_CODES.INVALID_PARAMS, message: UNSUPPORTED_PARAM_MESSAGE, data: { reason: 'UNSUPPORTED_PARAM' } };
  }
  let code = PROVIDER_ERROR_CODES.INTERNAL;
  if (error instanceof ProviderError) code = error.code;
  else if (error instanceof WalletError || isCoreError(error)) {
    if (PROVIDER_INPUT_CODES.has(error.code)) code = PROVIDER_ERROR_CODES.INVALID_PARAMS;
    else if (error.code === 'LOCKED' || error.code === 'UNAUTHORIZED') code = PROVIDER_ERROR_CODES.UNAUTHORIZED;
    else if (Object.hasOwn(PROVIDER_ERROR_CODES, error.code)) code = PROVIDER_ERROR_CODES[error.code];
  }
  return { code, message: PROVIDER_MESSAGES[code] };
}
