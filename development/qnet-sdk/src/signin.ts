// Sign in with a QNet wallet. The page asks the wallet to sign a short text naming the site, the account, the
// network, a nonce from the site's server and a validity window (qnet_signMessage); the server checks it with
// verifySignIn. The wallet signs "QNet Signed Message:\n" + origin + "\n" + byte length + "\n" + text with the
// FIPS 204 context the node never uses (applications/qnet-mobile/src/crypto/OffchainMessage.js, compiled here), so
// the signature binds the page's origin and can never pass as a transaction.
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { OFFCHAIN_MESSAGE_MAX_BYTES, hasHiddenCharacter, verifyOffchainMessage } from '#mobile/crypto/OffchainMessage.js';
import { QNetError } from './errors.js';
import { addressFromPublicKey, isValidAddress } from './tx.js';

/** The chain id a QNet wallet reports (qnet_chainId) and a sign-in message names. */
export const QNET_CHAIN_ID = 'q1337';
export const SIGNIN_DEFAULT_TTL_MS = 10 * 60 * 1000;
export const SIGNIN_MAX_VALIDITY_MS = 24 * 60 * 60 * 1000;
const STATEMENT_MAX_CHARS = 200;
const DEFAULT_SKEW_MS = 60 * 1000;

const NONCE_RE = /^[A-Za-z0-9]{16,64}$/;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::[1-9][0-9]{0,4})?$/;
const TIME_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const CHAIN_RE = /^q[0-9]{1,10}$/;

export interface SignInFields {
  /** The site's host as its origin writes it: "games.aiqnet.io", or "localhost:3000" for a local page. */
  domain: string;
  address: string;
  chainId: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  /** One optional line the site adds, such as "Sign in to play". */
  statement?: string;
}

export interface SignInMessageInput {
  /** The page's origin (https://games.aiqnet.io), or its host. */
  origin: string;
  address: string;
  nonce: string;
  chainId?: string;
  statement?: string;
  issuedAt?: Date;
  /** Validity from issuedAt; default 10 minutes, at most 24 hours. */
  ttlMs?: number;
}

const malformed = (): never => {
  throw new QNetError('SIGNIN_MALFORMED');
};

function hostOf(originOrHost: string): string {
  if (typeof originOrHost !== 'string') return malformed();
  let host = originOrHost;
  if (/^https?:\/\//.test(originOrHost)) {
    try {
      const url = new URL(originOrHost);
      if (url.origin !== originOrHost) return malformed();
      host = url.host;
    } catch {
      return malformed();
    }
  }
  return HOST_RE.test(host) ? host : malformed();
}

const isoSeconds = (date: Date): string => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return malformed();
  return `${date.toISOString().slice(0, 19)}Z`;
};

function checkStatement(statement: string | undefined): void {
  if (statement === undefined) return;
  if (typeof statement !== 'string' || statement.length === 0 || statement.length > STATEMENT_MAX_CHARS
    || /[\r\n]/.test(statement) || statement !== statement.trim() || hasHiddenCharacter(statement)) {
    malformed();
  }
}

function render(f: SignInFields): string {
  const lines = [`Sign in to ${f.domain}`];
  if (f.statement !== undefined) lines.push(f.statement);
  lines.push(
    '',
    `Account: ${f.address}`,
    `Chain: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued at: ${isoSeconds(f.issuedAt)}`,
    `Expires at: ${isoSeconds(f.expiresAt)}`,
  );
  return lines.join('\n');
}

/** A random nonce for one sign-in (32 hex characters). Keep it on the server until it is used or expires. */
export const createSignInNonce = (): string => bytesToHex(randomBytes(16));

/** The text a page asks the wallet to sign. */
export function createSignInMessage(input: SignInMessageInput): string {
  const issuedAt = input.issuedAt ?? new Date(Math.floor(Date.now() / 1000) * 1000);
  const ttl = input.ttlMs ?? SIGNIN_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > SIGNIN_MAX_VALIDITY_MS) malformed();
  const fields: SignInFields = {
    domain: hostOf(input.origin),
    address: isValidAddress(input.address) ? input.address : malformed(),
    chainId: input.chainId ?? QNET_CHAIN_ID,
    nonce: NONCE_RE.test(input.nonce) ? input.nonce : malformed(),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + ttl),
    statement: input.statement,
  };
  if (!CHAIN_RE.test(fields.chainId)) malformed();
  checkStatement(fields.statement);
  return render(fields);
}

/** The fields of a sign-in text, or SIGNIN_MALFORMED unless it is exactly what createSignInMessage writes. */
export function parseSignInMessage(message: string): SignInFields {
  if (typeof message !== 'string' || message.length > OFFCHAIN_MESSAGE_MAX_BYTES) return malformed();
  const lines = message.split('\n');
  const head = /^Sign in to (.+)$/.exec(lines[0] ?? '');
  if (!head || (lines.length !== 7 && lines.length !== 8)) return malformed();
  const statement = lines.length === 8 ? lines[1] : undefined;
  const rest = lines.slice(lines.length - 6);
  const field = (i: number, label: string): string => {
    const line = rest[i];
    return line.startsWith(`${label}: `) ? line.slice(label.length + 2) : malformed();
  };
  if (rest[0] !== '') malformed();
  const address = field(1, 'Account');
  const chainId = field(2, 'Chain');
  const nonce = field(3, 'Nonce');
  const issued = field(4, 'Issued at');
  const expires = field(5, 'Expires at');
  if (!isValidAddress(address) || !CHAIN_RE.test(chainId) || !NONCE_RE.test(nonce) || !TIME_RE.test(issued) || !TIME_RE.test(expires)) {
    malformed();
  }
  checkStatement(statement);
  const fields: SignInFields = {
    domain: hostOf(head[1]),
    address,
    chainId,
    nonce,
    issuedAt: new Date(issued),
    expiresAt: new Date(expires),
    statement,
  };
  // One text per sign-in: the parse must write back exactly what was signed.
  if (render(fields) !== message) malformed();
  return fields;
}

export interface SignedSignIn {
  message: string;
  /** Hex (as the wallet returns it) or bytes. */
  signature: string | Uint8Array;
  publicKey: string | Uint8Array;
  /** The address the wallet reported, when the page forwards it; checked against the key. */
  address?: string;
}

export interface VerifySignInOptions {
  /** The site's origin exactly as the browser writes it: "https://games.aiqnet.io". */
  origin: string;
  /**
   * Marks the nonce used and says whether this server issued it to the session this request came in and had not seen
   * it used: true once, false after, and false for a nonce issued to another session. Required: it is what makes a
   * signed text worth nothing to whoever copies it, or replays it into someone else's browser. With the SDK's store:
   * `(n) => nonces.consume(n, sessionId)`.
   */
  consumeNonce(nonce: string): boolean | Promise<boolean>;
  chainId?: string;
  now?: Date | number;
  /** Longest validity window accepted (default 24 hours). */
  maxValidityMs?: number;
  /** Clock difference tolerated for issuedAt (default 60 seconds). */
  clockSkewMs?: number;
}

const bytesOf = (value: string | Uint8Array, length: number, code: string): Uint8Array => {
  if (value instanceof Uint8Array) {
    if (value.length !== length) throw new QNetError(code);
    return value;
  }
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-fA-F]+$/.test(value)) throw new QNetError(code);
  return hexToBytes(value);
};

/**
 * Checks a signed sign-in on the server: the text names this site and network, it is inside its validity window,
 * the key is the account's own (eon(publicKey) == address), the wallet's signature verifies for this origin, and
 * the nonce is used for the first time. Returns the signed-in account's fields; throws QNetError SIGNIN_* otherwise.
 */
export async function verifySignIn(signed: SignedSignIn, options: VerifySignInOptions): Promise<SignInFields> {
  if (typeof options?.consumeNonce !== 'function') throw new QNetError('SIGNIN_REPLAYED');
  const fields = parseSignInMessage(signed?.message);
  let expectedHost: string;
  try {
    if (!/^https?:\/\//.test(options.origin)) throw new QNetError('INVALID_ORIGIN');
    expectedHost = hostOf(options.origin);
  } catch {
    throw new QNetError('INVALID_ORIGIN');
  }
  if (fields.domain !== expectedHost) throw new QNetError('SIGNIN_WRONG_DOMAIN');
  if (fields.chainId !== (options.chainId ?? QNET_CHAIN_ID)) throw new QNetError('SIGNIN_WRONG_CHAIN');

  const now = options.now === undefined ? Date.now() : new Date(options.now).getTime();
  const skew = options.clockSkewMs ?? DEFAULT_SKEW_MS;
  const maxValidity = options.maxValidityMs ?? SIGNIN_MAX_VALIDITY_MS;
  const issued = fields.issuedAt.getTime();
  const expires = fields.expiresAt.getTime();
  if (expires <= issued || expires - issued > maxValidity) throw new QNetError('SIGNIN_TOO_LONG_LIVED');
  if (issued > now + skew) throw new QNetError('SIGNIN_NOT_YET_VALID');
  if (now >= expires) throw new QNetError('SIGNIN_EXPIRED');

  const publicKey = bytesOf(signed.publicKey, 1952, 'SIGNIN_WRONG_ADDRESS');
  const signature = bytesOf(signed.signature, 3309, 'SIGNIN_BAD_SIGNATURE');
  const owner = addressFromPublicKey(publicKey);
  if (owner !== fields.address || (signed.address !== undefined && signed.address !== owner)) {
    throw new QNetError('SIGNIN_WRONG_ADDRESS');
  }
  if (!verifyOffchainMessage(options.origin, signed.message, signature, publicKey)) throw new QNetError('SIGNIN_BAD_SIGNATURE');
  if ((await options.consumeNonce(fields.nonce)) !== true) throw new QNetError('SIGNIN_REPLAYED');
  return fields;
}

export interface NonceStore {
  /**
   * A fresh nonce for the client `binding` names, remembered until it is used or `ttlMs` passes. The binding is the id
   * of the session the request for the nonce came in (a random cookie value the server set, 16 to 512 characters),
   * never a value the request chooses: a sign-in is then accepted only from the browser that asked for its nonce.
   */
  issue(binding: string): string;
  /**
   * True once for a nonce this store issued to this same binding and that has not expired; false after, and for any
   * other nonce. A nonce presented under another binding stays unused for its own client (DEVP-R4-04).
   */
  consume(nonce: string, binding: string): boolean;
}

export const NONCE_BINDING_MIN_CHARS = 16;
export const NONCE_BINDING_MAX_CHARS = 512;
const isBinding = (binding: unknown): binding is string => typeof binding === 'string'
  && binding.length >= NONCE_BINDING_MIN_CHARS && binding.length <= NONCE_BINDING_MAX_CHARS;

/**
 * A nonce store in this process's memory, for a single server. Several servers behind one site need a shared
 * store (a database row per nonce with its binding, deleted when used) with the same issue/consume rules. Each nonce
 * belongs to the session that asked for it: a sign-in someone made with his own wallet for this site and replays into
 * another person's browser (a cross-site post of his signed text) carries a nonce issued to his session, not to hers,
 * and is refused. It holds at most `max`
 * nonces: when full, issuing drops the oldest one, so a flood of requests for nonces cannot stop issuing, and each
 * issue costs the same whether the store is full or not. A flood does shorten how long an unused nonce lives, down to
 * less than a user needs to approve in the wallet once it issues `max` nonces within that time: rate-limit the route
 * that issues nonces per client.
 */
export function createNonceStore({ ttlMs = SIGNIN_DEFAULT_TTL_MS, max = 100_000, now = () => Date.now() } = {}): NonceStore {
  if (!Number.isSafeInteger(max) || max < 1) throw new QNetError('INVALID_INTEGER', 'max');
  const live = new Map<string, { until: number; binding: string }>();
  // Every nonce lives the same ttlMs, so insertion order is expiry order: the expired ones are at the front, and the
  // sweep stops at the first that is not, instead of walking every live nonce on every issue (DEVP-R2-02).
  const sweep = () => {
    const t = now();
    for (const [nonce, entry] of live) {
      if (entry.until > t) break;
      live.delete(nonce);
    }
  };
  return {
    issue(binding) {
      if (!isBinding(binding)) throw new QNetError('INVALID_BINDING');
      sweep();
      // The first in insertion order is the oldest (DEVP-R1-04).
      while (live.size >= max) live.delete(live.keys().next().value as string);
      const nonce = createSignInNonce();
      live.set(nonce, { until: now() + ttlMs, binding });
      return nonce;
    },
    consume(nonce, binding) {
      const entry = live.get(nonce);
      if (entry === undefined || !isBinding(binding) || entry.binding !== binding) return false;
      live.delete(nonce);
      return entry.until > now();
    },
  };
}
