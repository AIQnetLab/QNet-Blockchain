// Which wallet the cabinet shows (docs/protocols/qnet-link-v1.md section 14): the address, how the page learned it
// and, when the wallet shared it, its Solana address. The choice is remembered in this browser only, as a
// convenience; nothing goes into a URL.

import { isEonAddress, isSolanaAddress, type WalletAccounts, type WalletChannel } from '../qnet-provider.ts';
import { lightNodeId, walletHash } from '../qnet-link.ts';

// extension: qnet_requestAccounts, or qnet_accounts once the extension approved this site (extensionReconnect);
// entered: typed by the visitor; app: a QNet Link `connect` opened on this device; app-qr: a `connect` shown as a QR
// code, which anyone who saw the code could have answered.
export const WALLET_SOURCES = ['extension', 'entered', 'app', 'app-qr'] as const;
export type WalletSource = (typeof WALLET_SOURCES)[number];

export interface WalletChoice {
  qnet: string;
  source: WalletSource;
  // The wallet's own Solana address, when the extension or QNet Wallet shared it (never typed).
  solana?: string;
}

export const WALLET_KEY = 'qnet.cabinet.wallet';

// Whether the page holds this wallet for a request's `walletHash` without the check number (section 14.4): a
// wallet from a QR answer is not held, so a request that relies on it asks for the check number.
export function isHeldWallet(choice: WalletChoice): boolean {
  return choice.source !== 'app-qr';
}

// The wallet's own Solana address as far as the page can rely on it: the one the extension or QNet Wallet on this
// device shared, never one from a QR answer anyone could have given. A payment key sends what is left back to it
// (owner rule, 26.09), and Node details tell by it whose burn registered the node.
export function ownSolanaOf(choice: WalletChoice | null): string | null {
  return choice && isHeldWallet(choice) && choice.solana ? choice.solana : null;
}

export function choiceView(choice: WalletChoice): { qnet: string; nodeId: string; walletHash: string } {
  return { qnet: choice.qnet, nodeId: lightNodeId(choice.qnet), walletHash: walletHash(choice.qnet) };
}

export function parseChoice(text: string | null | undefined): WalletChoice | null {
  if (typeof text !== 'string' || text.length > 200) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const { qnet, source, solana, ...rest } = value as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || !isEonAddress(qnet) || !(WALLET_SOURCES as readonly unknown[]).includes(source)) return null;
    if (solana !== undefined && (!isSolanaAddress(solana) || source === 'entered')) return null;
    return solana === undefined ? { qnet, source: source as WalletSource } : { qnet, source: source as WalletSource, solana };
  } catch {
    return null;
  }
}

export function loadChoice(storage: Pick<Storage, 'getItem'> | null | undefined): WalletChoice | null {
  try {
    return parseChoice(storage?.getItem(WALLET_KEY));
  } catch {
    return null;
  }
}

export function saveChoice(storage: Pick<Storage, 'setItem'> | null | undefined, choice: WalletChoice): void {
  try {
    const kept = choice.solana ? { qnet: choice.qnet, source: choice.source, solana: choice.solana } : { qnet: choice.qnet, source: choice.source };
    storage?.setItem(WALLET_KEY, JSON.stringify(kept));
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

export function clearChoice(storage: Pick<Storage, 'removeItem'> | null | undefined): void {
  try {
    storage?.removeItem(WALLET_KEY);
  } catch {
    // nothing was kept
  }
}

// Kept while Disconnect was the last word in this browser: the cabinet then takes up no wallet by itself until one is
// connected with a tap.
export const DISCONNECTED_KEY = 'qnet.cabinet.disconnected';

export function loadDisconnected(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    return storage?.getItem(DISCONNECTED_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveDisconnected(storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined, disconnected: boolean): void {
  try {
    if (disconnected) storage?.setItem(DISCONNECTED_KEY, '1');
    else storage?.removeItem(DISCONNECTED_KEY);
  } catch {
    // storage blocked: it lasts for this page only
  }
}

// The wallet the cabinet takes up by itself from the QNet extension, or null for no change. `accounts` come from the
// silent qnet_accounts, so the extension approved this site before; the page never asks it on its own. Taken only when
// no wallet is chosen and Disconnect was not the last word in this browser; a wallet chosen another way stays. An
// extension's wallet already chosen follows the extension when it answers with another (its accountsChanged).
export function extensionReconnect(
  choice: WalletChoice | null,
  channel: WalletChannel | null,
  accounts: WalletAccounts | null,
  disconnected: boolean,
): WalletChoice | null {
  if (channel !== 'extension' || !accounts) return null;
  const taken: WalletChoice = { qnet: accounts.qnet, source: 'extension', solana: accounts.solana };
  if (choice === null) return disconnected ? null : taken;
  if (choice.source === 'extension' && (choice.qnet !== accounts.qnet || choice.solana !== accounts.solana)) return taken;
  return null;
}

// Whether the cabinet shows nothing yet because the extension's first answer may still set its wallet: none is chosen
// and Disconnect was not the last word, or the chosen one is the extension's, which follows it.
export function awaitsExtension(choice: WalletChoice | null, channel: WalletChannel | null, answered: boolean, disconnected: boolean): boolean {
  if (channel !== 'extension' || answered) return false;
  return choice ? choice.source === 'extension' : !disconnected;
}
