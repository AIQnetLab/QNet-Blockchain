// A web page's side of the QNet wallet: the browser extension or the QNet app's in-app browser announce a provider
// with the 'qnet:announceProvider' event; the page asks for it with 'qnet:requestProvider'. Keys never leave the
// wallet: the page asks, the wallet shows the user what it will sign and builds every transaction itself.
// A page learns about its transactions through the wallet (getTransactionStatus); other public chain data it reads
// from the nodes' public routes, which allow any origin, or through its own server.
import { base58 } from '@scure/base';
import { QNetError, QNetProviderError } from './errors.js';
import { createSignInMessage, type SignedSignIn } from './signin.js';
import { isValidAddress, MAX_GAS_LIMIT } from './tx.js';

export const WALLET_RDNS = 'io.aiqnet.wallet';
const ANNOUNCE_EVENT = 'qnet:announceProvider';
const REQUEST_EVENT = 'qnet:requestProvider';
const DEFAULT_FIND_MS = 600;
// Approvals wait for the user; past this the page stops waiting (the wallet keeps its own timeout).
const APPROVAL_TIMEOUT_MS = 11 * 60 * 1000;
const READ_TIMEOUT_MS = 10_000;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;
// The largest call input a wallet takes from a page.
const CALL_ARGS_MAX_BYTES = 4096;
const U64_MAX = (1n << 64n) - 1n;
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

type Listener = (...args: unknown[]) => void;

export interface WalletProvider {
  request(args: { method: string; params?: unknown }): unknown;
  on?(event: string, listener: Listener): unknown;
  removeListener?(event: string, listener: Listener): unknown;
}

/** Where the provider runs: the browser extension, or the QNet app's in-app browser. */
export type WalletChannel = 'extension' | 'mobile';

export interface WalletAccounts {
  /** The QNet address. */
  qnet: string;
  /** The wallet's Solana address. */
  solana: string;
}

export interface SendResult {
  /** 'submitted': a node accepted it; 'unknown': the wallet could not tell and keeps resending. */
  status: string;
  from: string;
  /** With `from`, the transaction's identity: at most one transaction of `from` is applied at a nonce. */
  nonce: string;
  /** The hash one node gave its copy; another node's copy of the same transaction may carry another hash. */
  txHash: string | null;
}

export interface TransactionStatus {
  /** 'pending': not in a block yet; 'in_block': a block holds it; 'unknown': the wallet cannot tell. */
  status: 'pending' | 'in_block' | 'unknown';
  /** The block holding it, when known. */
  blockHeight: number | null;
  /** The hash of the copy the chain holds, when known. */
  txHash: string | null;
}

export interface MessageSignature {
  signature: string;
  publicKey: string;
  address: string;
}

const isSolanaAddress = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  try {
    return base58.decode(value).length === 32;
  } catch {
    return false;
  }
};

const invalid = (): never => {
  throw new QNetError('INVALID_RESPONSE');
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : invalid();
}

function parseAccounts(value: unknown): WalletAccounts | null {
  const r = record(value);
  if (r.qnet === undefined && r.solana === undefined) return null;
  return isValidAddress(r.qnet) && isSolanaAddress(r.solana) ? { qnet: r.qnet, solana: r.solana } : invalid();
}

function nonceText(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= U64_MAX) return value;
  return invalid();
}

function parseSendResult(value: unknown): SendResult {
  const r = record(value);
  const txHash = r.txHash === null ? null : typeof r.txHash === 'string' && /^[0-9a-f]{64}$/.test(r.txHash) ? r.txHash : invalid();
  if (typeof r.status !== 'string' || !isValidAddress(r.from)) invalid();
  return { status: r.status as string, from: r.from as string, nonce: nonceText(r.nonce), txHash };
}

function checkDecimal(amount: unknown): string {
  if (typeof amount !== 'string' || !DECIMAL_RE.test(amount) || !/[1-9]/.test(amount)) throw new QNetError('INVALID_AMOUNT');
  return amount;
}

const checkAddress = (value: unknown): string => {
  if (!isValidAddress(value)) throw new QNetError('INVALID_ADDRESS');
  return value;
};

/** A connected QNet wallet. Every refusal is a QNetProviderError with the wallet's code (4001 rejected, 4100 not approved, ...). */
export class QNetWallet {
  readonly provider: WalletProvider;
  readonly channel: WalletChannel;

  constructor(provider: WalletProvider, channel: WalletChannel = 'extension') {
    if (!provider || typeof provider.request !== 'function') throw new QNetError('NO_PROVIDER');
    this.provider = provider;
    this.channel = channel;
  }

  /** One provider request; rejects with QNetProviderError, or QNetError TIMEOUT when the wallet does not answer in time. */
  async request(method: string, params?: unknown, timeoutMs: number = APPROVAL_TIMEOUT_MS): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = Promise.resolve().then(() => this.provider.request(params === undefined ? { method } : { method, params }));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new QNetError('TIMEOUT')), timeoutMs);
    });
    try {
      return await Promise.race([answer, timeout]);
    } catch (error) {
      if (error instanceof QNetError) throw error;
      throw QNetProviderError.from(error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Asks the user to approve this site (once); returns both addresses. */
  async connect(): Promise<WalletAccounts> {
    return parseAccounts(await this.request('qnet_requestAccounts')) ?? invalid();
  }

  /** The approved addresses without asking, or null when this site is not approved or the wallet is locked. */
  async accounts(): Promise<WalletAccounts | null> {
    return parseAccounts(await this.request('qnet_accounts', undefined, READ_TIMEOUT_MS));
  }

  async chainId(): Promise<{ chainId: string; network: string }> {
    const r = record(await this.request('qnet_chainId', undefined, READ_TIMEOUT_MS));
    return typeof r.chainId === 'string' && typeof r.network === 'string' ? { chainId: r.chainId, network: r.network } : invalid();
  }

  /** Withdraws this site's approval. */
  async disconnect(): Promise<void> {
    await this.request('qnet_disconnect', undefined, READ_TIMEOUT_MS);
  }

  /** The wallet signs `message` for this page's origin after the user reads it; verify with verifySignIn on a server. */
  async signMessage(message: string): Promise<MessageSignature> {
    if (typeof message !== 'string' || message.length === 0) throw new QNetError('INVALID_MESSAGE');
    const r = record(await this.request('qnet_signMessage', { message }));
    const hex = (v: unknown, length: number) => (typeof v === 'string' && v.length === length * 2 && HEX_RE.test(v) ? v : invalid());
    return { signature: hex(r.signature, 3309), publicKey: hex(r.publicKey, 1952), address: checkAddress(r.address) };
  }

  /**
   * Sign-in: connects, builds the sign-in text for this page with the server's nonce, and has the wallet sign it.
   * Send the result to the server, which checks it with verifySignIn.
   */
  async signIn({ nonce, statement, ttlMs, origin }: { nonce: string; statement?: string; ttlMs?: number; origin?: string }): Promise<SignedSignIn & { address: string }> {
    const accounts = await this.connect();
    const { chainId } = await this.chainId();
    const pageOrigin = origin ?? (globalThis as { location?: { origin?: string } }).location?.origin;
    if (typeof pageOrigin !== 'string') throw new QNetError('INVALID_ORIGIN');
    const message = createSignInMessage({ origin: pageOrigin, address: accounts.qnet, nonce, chainId, statement, ttlMs });
    const signed = await this.signMessage(message);
    if (signed.address !== accounts.qnet) invalid();
    return { message, signature: signed.signature, publicKey: signed.publicKey, address: signed.address };
  }

  /** Sends `amount` QNC (decimal text, such as "1.5") to `to`. The wallet sets the fee and nonce and asks the user. */
  async sendTransfer({ to, amount }: { to: string; amount: string }): Promise<SendResult> {
    return parseSendResult(await this.request('qnet_sendTransaction', { type: 'transfer', to: checkAddress(to), amount: checkDecimal(amount) }));
  }

  /** Sends `amount` (decimal text in the token's units) of the built-in token at `token` to `to`. */
  async sendTokenTransfer({ token, to, amount }: { token: string; to: string; amount: string }): Promise<SendResult> {
    return parseSendResult(await this.request('qnet_sendTransaction', {
      type: 'tokenTransfer', token: checkAddress(token), to: checkAddress(to), amount: checkDecimal(amount),
    }));
  }

  /**
   * Calls `method` of the contract at `contract` with `args` (hex bytes the contract reads). A call carries no QNC.
   * The wallet reports whether the call reached a block, never what the contract did: the network records no result.
   */
  async callContract({ contract, method, args = '', gasLimit }: { contract: string; method: string; args?: string; gasLimit?: number }): Promise<SendResult> {
    if (typeof method !== 'string' || !METHOD_RE.test(method)) throw new QNetError('INVALID_METHOD');
    if (typeof args !== 'string' || !HEX_RE.test(args) || args.length > 2 * CALL_ARGS_MAX_BYTES) throw new QNetError('INVALID_ARGS');
    if (gasLimit !== undefined && (!Number.isSafeInteger(gasLimit) || gasLimit <= 0 || gasLimit > MAX_GAS_LIMIT)) {
      throw new QNetError('INVALID_GAS_LIMIT');
    }
    const params: Record<string, unknown> = { type: 'contractCall', contract: checkAddress(contract), method, args: args.toLowerCase() };
    if (gasLimit !== undefined) params.gasLimit = gasLimit;
    return parseSendResult(await this.request('qnet_sendTransaction', params));
  }

  /** Where a transaction of the connected account stands, by its identity (from, nonce). */
  async getTransactionStatus({ from, nonce }: { from: string; nonce: string | number }): Promise<TransactionStatus> {
    const n = String(nonce);
    if (!(typeof nonce === 'string' || Number.isSafeInteger(nonce)) || !/^[1-9][0-9]{0,19}$/.test(n) || BigInt(n) > U64_MAX) {
      throw new QNetError('INVALID_NONCE');
    }
    const r = record(await this.request('qnet_getTransactionStatus', { from: checkAddress(from), nonce: n }, READ_TIMEOUT_MS));
    if (r.status !== 'pending' && r.status !== 'in_block' && r.status !== 'unknown') invalid();
    const height = r.blockHeight ?? null;
    const txHash = r.txHash ?? null;
    if (height !== null && !(Number.isSafeInteger(height) && (height as number) >= 0)) invalid();
    if (txHash !== null && !(typeof txHash === 'string' && /^[0-9a-f]{64}$/.test(txHash))) invalid();
    return { status: r.status as TransactionStatus['status'], blockHeight: height as number | null, txHash: txHash as string | null };
  }

  /** 'accountsChanged' (the addresses, or null when the site lost access) or 'disconnect'. Returns the unsubscribe. */
  on(event: 'accountsChanged' | 'disconnect', listener: (data: WalletAccounts | null | unknown) => void): () => void {
    if (typeof this.provider.on !== 'function') return () => {};
    const wrapped: Listener = (data) => {
      if (event !== 'accountsChanged') return listener(data);
      let accounts: WalletAccounts | null = null;
      try {
        accounts = parseAccounts(data);
      } catch {
        accounts = null;
      }
      return listener(accounts);
    };
    this.provider.on(event, wrapped);
    return () => {
      try {
        this.provider.removeListener?.(event, wrapped);
      } catch {
        // the wallet went away with its listeners
      }
    };
  }
}

// One announcement: the QNet rdns and a callable request(). The rdns and channel are self-asserted: they pick the
// wallet, they do not authenticate it. What protects the user is the wallet's own approval, which shows the origin.
function readAnnouncement(event: Event): { provider: WalletProvider; channel: WalletChannel } | null {
  try {
    const detail = (event as CustomEvent).detail as { info?: { rdns?: unknown; uuid?: unknown; channel?: unknown }; provider?: WalletProvider } | null;
    const info = detail?.info;
    const provider = detail?.provider;
    if (!info || info.rdns !== WALLET_RDNS || typeof info.uuid !== 'string') return null;
    if (!provider || typeof provider.request !== 'function') return null;
    return { provider, channel: info.channel === 'mobile' ? 'mobile' : 'extension' };
  } catch {
    return null;
  }
}

/**
 * The QNet wallet of this page, or null when none announced itself within `timeoutMs`. Uses the announcement
 * event; `window.qnet` is taken only when no announcement came.
 */
export function findWallet({ target, timeoutMs = DEFAULT_FIND_MS }: { target?: EventTarget; timeoutMs?: number } = {}): Promise<QNetWallet | null> {
  const where = target ?? (globalThis as unknown as EventTarget);
  if (typeof where?.addEventListener !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAnnounce = (event: Event) => {
      const found = readAnnouncement(event);
      if (!found) return;
      finish(new QNetWallet(found.provider, found.channel));
    };
    const finish = (wallet: QNetWallet | null) => {
      clearTimeout(timer);
      where.removeEventListener(ANNOUNCE_EVENT, onAnnounce);
      resolve(wallet);
    };
    where.addEventListener(ANNOUNCE_EVENT, onAnnounce);
    timer = setTimeout(() => {
      const alias = (where as { qnet?: WalletProvider & { isQNet?: unknown } }).qnet;
      finish(alias && alias.isQNet === true && typeof alias.request === 'function' ? new QNetWallet(alias) : null);
    }, timeoutMs);
    where.dispatchEvent(new Event(REQUEST_EVENT));
  });
}
