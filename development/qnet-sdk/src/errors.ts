// Every SDK failure carries a stable `code`. Messages are fixed texts: no key, phrase, password or signature is
// ever placed in an error.

const MESSAGES: Record<string, string> = {
  INVALID_ADDRESS: 'Not a QNet address',
  INVALID_AMOUNT: 'The amount is not a positive number in the allowed precision',
  INVALID_INTEGER: 'Not an unsigned 64-bit integer',
  INVALID_NONCE: 'The nonce must be at least 1',
  INVALID_GAS_PRICE: 'The gas price is below the network minimum',
  INVALID_GAS_LIMIT: 'The gas limit is outside what the transaction needs and the network allows',
  INVALID_FUEL: 'The fuel budget is outside the allowed range',
  INVALID_ARGS: 'Contract arguments must be even-length hex',
  INVALID_METHOD: 'Not a valid contract method name',
  INVALID_CALL: 'The contract call is incomplete',
  INVALID_CODE: 'Not a WebAssembly module',
  CODE_TOO_LARGE: 'The module is larger than one deploy can carry',
  REQUEST_TOO_LARGE: 'The request is larger than the node accepts',
  INVALID_SIGNATURE: 'The signature is malformed',
  INVALID_PUBLIC_KEY: 'The public key is malformed',
  INVALID_MNEMONIC: 'Not a valid 12- or 24-word recovery phrase',
  INVALID_ENTROPY: 'The key material is malformed',
  KEY_ADDRESS_MISMATCH: 'The key does not belong to the sending account',
  SIGNATURE_SELF_CHECK_FAILED: 'The signature did not verify',
  INVALID_MESSAGE: 'The message is empty or holds characters a wallet would not show',
  INVALID_ORIGIN: 'Not a web origin',
  PROTOCOL_PREFIX: 'The message starts like a protocol message',
  MESSAGE_TOO_LONG: 'The message is too long',
  SIGNIN_MALFORMED: 'Not a QNet sign-in message',
  SIGNIN_WRONG_DOMAIN: 'The sign-in message names another site',
  SIGNIN_WRONG_CHAIN: 'The sign-in message names another network',
  SIGNIN_NOT_YET_VALID: 'The sign-in message is not valid yet',
  SIGNIN_EXPIRED: 'The sign-in message has expired',
  SIGNIN_TOO_LONG_LIVED: 'The sign-in message is valid for longer than allowed',
  SIGNIN_WRONG_ADDRESS: 'The public key does not belong to the signing account',
  SIGNIN_BAD_SIGNATURE: 'The sign-in signature does not verify',
  SIGNIN_REPLAYED: 'The sign-in nonce is unknown, already used, or issued to another session',
  INVALID_BINDING: 'A nonce is bound to the id of the session that asked for it: 16 to 512 characters',
  NO_PROVIDER: 'No QNet wallet is available on this page',
  INVALID_RESPONSE: 'The answer is not in the expected form',
  NODE_UNAVAILABLE: 'No node answered',
  NODE_REJECTED: 'The node refused the request',
  SUBMIT_UNCERTAIN: 'No node confirmed the transaction, and a node that did not answer may have taken it: wait for the account nonce before sending again',
  NODES_DISAGREE: 'The nodes gave different answers',
  RATE_LIMITED: 'The node rate limit was reached',
  NOT_FOUND: 'Not found',
  TIMEOUT: 'Timed out',
  KEY_NOT_FOUND: 'No key with that name',
  KEY_EXISTS: 'A key with that name already exists',
  INVALID_KEY_NAME: 'Key names are 1 to 32 letters, digits, dots, dashes or underscores',
  WRONG_PASSWORD: 'Wrong password, or the key file was changed',
  KEYSTORE_CORRUPT: 'The key file is damaged or not a QNet key file',
  KEY_FILE_PERMISSIONS: 'The key file can be read by other users of this computer; make it private (chmod 600)',
  WEAK_PASSWORD: 'The password is too short',
  INVALID_WASM: 'The module breaks the deploy rules',
  INSUFFICIENT_FUNDS: 'The account does not hold enough QNC for this',
};

export class QNetError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? MESSAGES[code] ?? code);
    this.name = 'QNetError';
    this.code = code;
  }
}

/**
 * A refusal from a node: `reason` is the node's own error text, as it sent it. SUBMIT_UNCERTAIN: a submit that no
 * node confirmed after a node that may hold the body gave no answer; the transaction may still apply.
 */
export class QNetNodeError extends QNetError {
  readonly reason: string;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: 'NODE_REJECTED' | 'RATE_LIMITED' | 'NODE_UNAVAILABLE' | 'INVALID_RESPONSE' | 'SUBMIT_UNCERTAIN' | 'NODES_DISAGREE',
    reason: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(code, reason ? `${MESSAGES[code]}: ${reason}` : MESSAGES[code]);
    this.name = 'QNetNodeError';
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Numeric codes a QNet wallet answers a page with. */
export const PROVIDER_ERROR_CODES = Object.freeze({
  USER_REJECTED: 4001,
  UNAUTHORIZED: 4100,
  UNSUPPORTED_METHOD: 4200,
  DISCONNECTED: 4900,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
});

// The one other text a 4001 carries: the wallet refuses this site for a while after repeated rejections.
const COOLDOWN_MESSAGE = 'Too many rejected requests from this site, try again later';

/** A wallet's refusal of a page request. `providerCode` is the wallet's number; `cooldown` marks its rejection pause. */
export class QNetProviderError extends QNetError {
  readonly providerCode: number;
  readonly cooldown: boolean;

  constructor(providerCode: number, cooldown = false) {
    const name = Object.entries(PROVIDER_ERROR_CODES).find(([, n]) => n === providerCode)?.[0] ?? 'INTERNAL';
    super(name, cooldown ? COOLDOWN_MESSAGE : `The wallet answered ${providerCode}`);
    this.name = 'QNetProviderError';
    this.providerCode = providerCode;
    this.cooldown = cooldown;
  }

  static from(error: unknown): QNetProviderError | QNetError {
    let code: unknown;
    let message: unknown;
    try {
      code = (error as { code?: unknown } | null)?.code;
      message = (error as { message?: unknown } | null)?.message;
    } catch {
      return new QNetError('INVALID_RESPONSE');
    }
    if (typeof code !== 'number') return new QNetError('INVALID_RESPONSE');
    return new QNetProviderError(code, code === 4001 && message === COOLDOWN_MESSAGE);
  }
}

// The shared modules throw their own error classes with the same `code` field: TxBuildError, CoreError,
// OffchainMessageError. Anything with a string code becomes a QNetError; anything else is rethrown as is.
export function asQNetError(error: unknown): unknown {
  if (error instanceof QNetError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof code === 'string' && (name === 'TxBuildError' || name === 'CoreError' || name === 'OffchainMessageError')) {
    return new QNetError(code);
  }
  return error;
}

export function mapped<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args: A) => {
    try {
      return fn(...args);
    } catch (error) {
      throw asQNetError(error);
    }
  };
}
