// The site's side of the QNet wallet provider protocol: discovery through the provider announcement event
// and provider requests (applications/qnet-wallet: inject/provider.js). Browser-only and framework-free. Every
// value the wallet hands back is checked here before the page shows it.

import jsSha3 from 'js-sha3';
import bs58 from 'bs58';

export const QNET_RDNS = 'io.aiqnet.wallet';
export const EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/pahnggomgmhhjjncgfnmmofmplfhkncg';

const ANNOUNCE_EVENT = 'qnet:announceProvider';
const REQUEST_EVENT = 'qnet:requestProvider';
// How long the page waits for the wallet's announcement before it counts the wallet as missing; a later announcement
// still binds.
export const DETECT_MS = 1_000;
const PASSIVE_TIMEOUT_MS = 5_000;
// The user may take a while in the approval window; past this the page stops waiting.
const CONNECT_TIMEOUT_MS = 180_000;
const VIEW_KEY = 'qnet.addressView';

export type AddressView = 'qnet' | 'solana';

// Where the announced provider runs: the browser extension, or the QNet app's in-app browser, which
// offers no node activation (docs/protocols/qnet-link-v1.md section 11).
export type WalletChannel = 'extension' | 'mobile';

// The page's search for the wallet: until DETECT_MS has passed without one it is 'detecting'.
export type ProviderStatus = 'detecting' | 'available' | 'missing';

export interface WalletAccounts {
  qnet: string;
  solana: string;
}

type Listener = (...args: unknown[]) => void;

export interface QNetProvider {
  request(args: { method: string; params?: unknown }): unknown;
  on?(event: string, listener: Listener): unknown;
  removeListener?(event: string, listener: Listener): unknown;
}

// EON: 19 hex + "eon" + 15 hex, closed by the first 8 hex of SHA3-256 over those 37 chars.
const EON_RE = /^([0-9a-f]{19})eon([0-9a-f]{15})([0-9a-f]{8})$/;

export function isEonAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = EON_RE.exec(value);
  return m !== null && jsSha3.sha3_256(`${m[1]}eon${m[2]}`).slice(0, 8) === m[3];
}

// A Solana address is the base58 of a 32-byte public key.
export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

// A Solana transaction signature is the base58 of 64 bytes (64 to 88 characters).
export function isSolanaSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 64 || value.length > 88) return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

export type AccountsResult =
  | { kind: 'none' }
  | { kind: 'ok'; accounts: WalletAccounts }
  | { kind: 'invalid' };

// `{}` means not connected; anything else must be a valid QNet and Solana pair.
export function parseAccounts(value: unknown): AccountsResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'invalid' };
  let qnet: unknown;
  let solana: unknown;
  try {
    qnet = (value as Record<string, unknown>).qnet;
    solana = (value as Record<string, unknown>).solana;
  } catch {
    return { kind: 'invalid' };
  }
  if (qnet === undefined && solana === undefined) return { kind: 'none' };
  if (!isEonAddress(qnet) || !isSolanaAddress(solana)) return { kind: 'invalid' };
  return { kind: 'ok', accounts: { qnet, solana } };
}

export interface Announced {
  provider: QNetProvider;
  channel: WalletChannel;
}

// One announcement, accepted only with the QNet rdns and a callable request(). The rdns and the
// channel are self-asserted, so this picks the wallet among several and what the page offers it; it
// does not authenticate it. The control is the approval the wallet asks for, showing this origin.
// A missing or unknown channel reads as 'extension' (older builds have none).
export function readAnnouncement(event: Event): Announced | null {
  try {
    const detail = (event as CustomEvent<unknown>).detail as
      | { info?: { uuid?: unknown; rdns?: unknown; channel?: unknown } | null; provider?: unknown }
      | null
      | undefined;
    const info = detail?.info;
    const provider = detail?.provider as QNetProvider | null | undefined;
    if (!info || info.rdns !== QNET_RDNS || typeof info.uuid !== 'string') return null;
    if (!provider || typeof provider.request !== 'function') return null;
    return { provider, channel: info.channel === 'mobile' ? 'mobile' : 'extension' };
  } catch {
    return null;
  }
}

// Listens for the wallet's announcement, then asks for it. The first QNet announcement wins, later
// ones are ignored. Returns the cleanup.
export function watchProviders(
  target: EventTarget,
  onProvider: (provider: QNetProvider, channel: WalletChannel) => void,
): () => void {
  let bound = false;
  const onAnnounce = (event: Event) => {
    if (bound) return;
    const announced = readAnnouncement(event);
    if (!announced) return;
    bound = true;
    onProvider(announced.provider, announced.channel);
  };
  target.addEventListener(ANNOUNCE_EVENT, onAnnounce);
  target.dispatchEvent(new Event(REQUEST_EVENT));
  return () => target.removeEventListener(ANNOUNCE_EVENT, onAnnounce);
}

// window.qnet: the same provider under its alias, used only when no announcement arrived.
export function aliasProvider(win: unknown): QNetProvider | null {
  try {
    const p = (win as { qnet?: unknown } | null)?.qnet as (QNetProvider & { isQNet?: unknown }) | undefined;
    return p && p.isQNet === true && typeof p.request === 'function' ? p : null;
  } catch {
    return null;
  }
}

// The page's search for the wallet: the first QNet announcement binds; with none within `ms`, the window.qnet alias
// binds, else `onMissing` runs. An announcement after that still binds (an extension that injected late). Returns the
// cleanup.
export function detectProvider(
  win: EventTarget,
  onProvider: (provider: QNetProvider, channel: WalletChannel) => void,
  onMissing: () => void,
  ms: number = DETECT_MS,
): () => void {
  let bound = false;
  const bind = (provider: QNetProvider, channel: WalletChannel) => {
    if (bound) return;
    bound = true;
    onProvider(provider, channel);
  };
  const stop = watchProviders(win, bind);
  const timer = setTimeout(() => {
    if (bound) return;
    const alias = aliasProvider(win);
    if (alias) bind(alias, 'extension');
    else onMissing();
  }, ms);
  return () => {
    stop();
    clearTimeout(timer);
  };
}

// One request, rejected with Error('timeout') when the wallet has not answered in time.
export function callProvider(provider: QNetProvider, method: string, timeoutMs: number, params?: unknown): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = Promise.resolve().then(() => provider.request(params === undefined ? { method } : { method, params }));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  return Promise.race([answer, timeout]).finally(() => clearTimeout(timer));
}

export function errorCode(err: unknown): number | null {
  try {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'number' ? code : null;
  } catch {
    return null;
  }
}

// The one other text a 4001 carries (applications/qnet-wallet CONTRACTS.md 4.5): the wallet refuses this
// origin for a while after repeated rejections. Compared, never shown.
export const COOLDOWN_MESSAGE = 'Too many rejected requests from this site, try again later';
export const COOLDOWN_TEXT = 'Too many declined requests. Try again in a few minutes.';

export function isApprovalCooldown(err: unknown): boolean {
  if (errorCode(err) !== 4001) return false;
  try {
    return (err as { message?: unknown }).message === COOLDOWN_MESSAGE;
  } catch {
    return false;
  }
}

export type ProviderFailure = 'rejected' | 'cooldown' | 'unauthorized' | 'unsupported' | 'disconnected' | 'timeout' | 'failed';

// A provider call that threw, by its protocol code (applications/qnet-wallet CONTRACTS.md 4.5); 4200 is a wallet
// without the method.
export function providerFailure(err: unknown): ProviderFailure {
  if (err instanceof Error && err.message === 'timeout' && errorCode(err) === null) return 'timeout';
  switch (errorCode(err)) {
    case 4001:
      return isApprovalCooldown(err) ? 'cooldown' : 'rejected';
    case 4100:
      return 'unauthorized';
    case 4200:
      return 'unsupported';
    case 4900:
      return 'disconnected';
    default:
      return 'failed';
  }
}

// Fixed texts per protocol error code; the wallet's own message text is not shown.
export function connectErrorMessage(err: unknown): string {
  switch (errorCode(err)) {
    case 4001:
      return isApprovalCooldown(err) ? COOLDOWN_TEXT : 'The connection was rejected in the wallet.';
    case 4100:
      return 'The wallet is locked or has not approved this site. Unlock it and try again.';
    case 4200:
      return 'This version of the wallet cannot connect to sites. Update the extension.';
    case 4900:
      return 'The wallet is disconnected. Reload the page and try again.';
    default:
      return 'The wallet did not connect. Try again.';
  }
}

// qnet_accounts: no prompt. Locked, not approved, an error or a timeout all read as not connected.
export async function readAccounts(provider: QNetProvider): Promise<WalletAccounts | null> {
  try {
    const result = parseAccounts(await callProvider(provider, 'qnet_accounts', PASSIVE_TIMEOUT_MS));
    return result.kind === 'ok' ? result.accounts : null;
  } catch {
    return null;
  }
}

export type ConnectResult = { ok: true; accounts: WalletAccounts } | { ok: false; message: string };

// qnet_requestAccounts: the wallet asks the user to approve this site.
export async function requestAccounts(provider: QNetProvider): Promise<ConnectResult> {
  let value: unknown;
  try {
    value = await callProvider(provider, 'qnet_requestAccounts', CONNECT_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, message: connectErrorMessage(err) };
  }
  const result = parseAccounts(value);
  if (result.kind === 'ok') return { ok: true, accounts: result.accounts };
  return { ok: false, message: 'The wallet returned an address that is not valid, so nothing is shown.' };
}

// qnet_disconnect: the wallet drops this site's approval. False when it did not confirm.
export async function revokeAccess(provider: QNetProvider): Promise<boolean> {
  try {
    await callProvider(provider, 'qnet_disconnect', PASSIVE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

// qnet_sendSolanaTransfer (aiqnet.io only): the extension's Solana send window opens with the recipient, the token and
// the amount filled in, and the user confirms there; the site cannot change any of them once asked.
export const SOLANA_TRANSFER_METHOD = 'qnet_sendSolanaTransfer';
// The user reviews the transfer in the extension's window.
const SOLANA_TRANSFER_TIMEOUT_MS = 5 * 60_000;

// One transfer: SOL (`mint` null) or a token, `amount` in whole units.
export interface SolanaTransfer {
  to: string;
  mint: string | null;
  amount: string;
}

// A plain decimal above zero: no sign, exponent, grouping, leading zero or trailing zero in the fraction.
const TRANSFER_AMOUNT_RE = /^(?:0|[1-9]\d{0,19})(?:\.\d{0,17}[1-9])?$/;

export function isSolanaTransfer(value: unknown): value is SolanaTransfer {
  if (typeof value !== 'object' || value === null) return false;
  const { to, mint, amount } = value as Record<string, unknown>;
  return isSolanaAddress(to) && (mint === null || isSolanaAddress(mint)) && typeof amount === 'string' && TRANSFER_AMOUNT_RE.test(amount) && amount !== '0';
}

// `short`: the window refused it for the wallet's balance (INSUFFICIENT_SOL, INSUFFICIENT_TOKENS); `failed` also covers
// an error result (Solana unreachable, a refused transaction, no wallet).
export type SolanaTransferResult = { ok: true; signature: string } | { ok: false; failure: ProviderFailure | 'short' | 'unverifiable' };

// Exactly {status: 'submitted', signature} or {status: 'error', error}; anything else is unverifiable.
export function readSolanaTransfer(value: unknown): SolanaTransferResult {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, failure: 'unverifiable' };
    const r = value as Record<string, unknown>;
    const keys = Object.keys(r).sort().join(',');
    if (r.status === 'submitted' && keys === 'signature,status' && isSolanaSignature(r.signature)) return { ok: true, signature: r.signature };
    if (r.status === 'error' && keys === 'error,status' && typeof r.error === 'string') {
      return { ok: false, failure: r.error === 'INSUFFICIENT_SOL' || r.error === 'INSUFFICIENT_TOKENS' ? 'short' : 'failed' };
    }
  } catch {
    // a hostile object: unverifiable
  }
  return { ok: false, failure: 'unverifiable' };
}

// Whether the extension takes the transfer, asked without a window: one that has the method refuses a call without
// params (-32602) before anything else, one without it answers 4200.
export async function supportsSolanaTransfer(provider: QNetProvider): Promise<boolean> {
  try {
    await callProvider(provider, SOLANA_TRANSFER_METHOD, PASSIVE_TIMEOUT_MS);
  } catch (err) {
    return errorCode(err) === -32602;
  }
  return false;
}

export async function sendSolanaTransfer(provider: QNetProvider, transfer: SolanaTransfer): Promise<SolanaTransferResult> {
  if (!isSolanaTransfer(transfer)) return { ok: false, failure: 'failed' };
  let result: unknown;
  try {
    result = await callProvider(provider, SOLANA_TRANSFER_METHOD, SOLANA_TRANSFER_TIMEOUT_MS, { to: transfer.to, mint: transfer.mint, amount: transfer.amount });
  } catch (err) {
    return { ok: false, failure: providerFailure(err) };
  }
  return readSolanaTransfer(result);
}

// Where "Connect wallet" sends a visitor whose browser has no QNet provider: the extension's store page
// on a desktop browser that installs from that store, the mobile app's page on a phone (browser extensions do
// not run there), and the extension page, which lists the supported browsers, anywhere else.
export type InstallTarget = { kind: 'store' | 'mobile' | 'unsupported'; href: string };

export interface NavigatorLike {
  userAgent?: string;
  userAgentData?: { mobile?: boolean; platform?: string; brands?: { brand: string }[] } | null;
  maxTouchPoints?: number;
}

const touchScreen = (nav: NavigatorLike | null | undefined): boolean => typeof nav?.maxTouchPoints === 'number' && nav.maxTouchPoints > 1;

// An Android tablet browsing in desktop mode, as the common tablet browsers do by default on large tablets: its user
// agent names a desktop Linux (X11; Linux x86_64) without Android or Mobile, and only the touch screen tells it apart.
// A laptop whose user agent names CrOS stays a computer, touch screen or not (SITE-5).
function desktopModeAndroid(nav: NavigatorLike | null | undefined, ua: string): boolean {
  return /\bX11\b|\bLinux (x86_64|aarch64|armv)/.test(ua) && !/\bCrOS\b/.test(ua) && touchScreen(nav);
}

// A phone or tablet: runs no browser extensions, and opens app links itself. The iPad's own browser presents a desktop
// Mac, and an Android tablet in desktop mode a desktop Linux; each is told apart by its touch screen.
export function isPhoneLike(nav: NavigatorLike | null | undefined): boolean {
  const ua = typeof nav?.userAgent === 'string' ? nav.userAgent : '';
  if (nav?.userAgentData?.mobile === true || nav?.userAgentData?.platform === 'Android' || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  return (/Macintosh/.test(ua) && touchScreen(nav)) || desktopModeAndroid(nav, ua);
}

// Android, where the site opens the app with an intent: URL (docs/protocols/qnet-link-v1.md section 4.1), a tablet in
// desktop mode included.
export function isAndroid(nav: NavigatorLike | null | undefined): boolean {
  const ua = typeof nav?.userAgent === 'string' ? nav.userAgent : '';
  return nav?.userAgentData?.platform === 'Android' || /\bAndroid\b/i.test(ua) || desktopModeAndroid(nav, ua);
}

export function installTarget(nav: NavigatorLike | null | undefined): InstallTarget {
  const ua = typeof nav?.userAgent === 'string' ? nav.userAgent : '';
  const data = nav?.userAgentData;
  if (isPhoneLike(nav)) return { kind: 'mobile', href: '/wallet' };
  const chromium = Array.isArray(data?.brands)
    ? data.brands.some((b) => b?.brand === 'Chromium')
    : /\b(Chrome|Chromium|Edg)\//.test(ua) && !/\bFirefox\//.test(ua);
  if (chromium) return { kind: 'store', href: EXTENSION_STORE_URL };
  return { kind: 'unsupported', href: '/qnet-wallet-extension' };
}

// What Connect wallet does, the header's and My node's alike (owner, 20.10): nothing while the wallet is being detected;
// on a phone or tablet it asks QNet Wallet (never an extension offer); on a computer it asks the QNet extension, or
// without one opens the extension's store page at once (`store`; in a browser that store does not serve, the page that
// lists the browsers it installs in).
export type ConnectWay =
  | { kind: 'wait' }
  | { kind: 'app' }
  | { kind: 'extension' }
  | { kind: 'install'; href: string; store: boolean };

export function connectWay(status: ProviderStatus, channel: WalletChannel | null, device: { phone: boolean } | null, nav: NavigatorLike | null | undefined): ConnectWay {
  if (status === 'detecting' || device === null) return { kind: 'wait' };
  if (device.phone) return { kind: 'app' };
  if (status === 'available' && channel === 'extension') return { kind: 'extension' };
  const target = installTarget(nav);
  return { kind: 'install', href: target.href, store: target.kind === 'store' };
}

export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

// Which address the header shows: a display preference only, never an address.
export function loadView(storage: Pick<Storage, 'getItem'> | null | undefined): AddressView {
  try {
    return storage?.getItem(VIEW_KEY) === 'solana' ? 'solana' : 'qnet';
  } catch {
    return 'qnet';
  }
}

export function saveView(storage: Pick<Storage, 'setItem'> | null | undefined, view: AddressView): void {
  try {
    storage?.setItem(VIEW_KEY, view);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}
