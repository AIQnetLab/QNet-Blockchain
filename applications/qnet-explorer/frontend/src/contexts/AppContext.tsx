'use client';

// Wallet connection state for the whole page: one instance, shared by the desktop and the mobile
// header. On its own the page only asks the passive qnet_accounts; the wallet is asked to connect
// only when the user clicks. Everything here runs in the browser.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  aliasProvider,
  loadView,
  readAccounts,
  requestAccounts,
  revokeAccess,
  saveView,
  watchProviders,
  type AddressView,
  type QNetProvider,
  type WalletAccounts,
  type WalletChannel,
} from '@/lib/qnet-provider';
import {
  activateWithExtension, claimWithExtension, getExtensionActivation, unlinkWithExtension, type ExtensionActivation, type ExtensionActivationRead, type ExtensionClaim,
  type ExtensionUnlink, type NodeType,
} from '@/lib/qnet-link';
import { keepFromApp, openedFromApp, showsActivationContent } from '@/lib/activate-view';

// How long the page waits for the wallet's announcement before offering the install link. A later
// announcement still binds.
const DETECT_MS = 1_000;

export type ProviderStatus = 'detecting' | 'available' | 'missing';

interface WalletContextValue {
  providerStatus: ProviderStatus;
  // Null until a provider is bound; 'mobile' is the QNet app's in-app browser.
  providerChannel: WalletChannel | null;
  // The visit began on a page the QNet app opened with its marker (?from=app); kept for the visit.
  fromApp: boolean;
  accounts: WalletAccounts | null;
  // `accounts` is the bound provider's answer (the latest read, connect or disconnect), no longer the page's initial
  // null: it says whether the wallet approved this site.
  accountsKnown: boolean;
  view: AddressView;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  setView: (view: AddressView) => void;
  clearError: () => void;
  // qnet_activateNode: the wallet asks the user, burns and answers; the result is already checked.
  activateNode: (nodeType: NodeType) => Promise<ExtensionActivation>;
  // qnet_claimNodeBalance: the extension moves its own wallet's node balance; checked for `wallet`.
  claimNodeBalance: (wallet: string) => Promise<ExtensionClaim>;
  // qnet_getActivation: what the extension holds of its wallet's activation, read without a window; checked.
  readActivation: () => Promise<ExtensionActivationRead>;
  // qnet_unlinkNodeDevice: the extension unlinks its own wallet's light node from its device; checked for `wallet`.
  unlinkNodeDevice: (wallet: string) => Promise<ExtensionUnlink>;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [provider, setProvider] = useState<QNetProvider | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>('detecting');
  const [providerChannel, setProviderChannel] = useState<WalletChannel | null>(null);
  const [fromApp, setFromApp] = useState(false);
  const [accounts, setAccounts] = useState<WalletAccounts | null>(null);
  const [accountsKnown, setAccountsKnown] = useState(false);
  const [view, setViewState] = useState<AddressView>('qnet');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Each read, connect or disconnect takes a number; only the latest may set the accounts.
  const seq = useRef(0);

  useEffect(() => {
    // Read once and kept in memory only; once set it holds for the visit.
    if (openedFromApp(window.location.search)) setFromApp(true);
    setViewState(loadView(localStore()));
    let bound = false;
    const bind = (p: QNetProvider, channel: WalletChannel) => {
      if (bound) return;
      bound = true;
      setProvider(p);
      setProviderChannel(channel);
      setProviderStatus('available');
    };
    const stop = watchProviders(window, bind);
    const timer = window.setTimeout(() => {
      if (bound) return;
      const alias = aliasProvider(window);
      if (alias) bind(alias, 'extension');
      else setProviderStatus('missing');
    }, DETECT_MS);
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!provider) return;
    let alive = true;
    const refresh = async () => {
      const mine = ++seq.current;
      const current = await readAccounts(provider);
      // A read overtaken by a newer step leaves both to that step.
      if (!alive || mine !== seq.current) return;
      setAccounts(current);
      setAccountsKnown(true);
    };
    const onAccountsChanged = () => {
      void refresh();
    };
    const onDisconnect = () => {
      ++seq.current;
      if (!alive) return;
      setAccounts(null);
      setAccountsKnown(true);
    };
    void refresh();
    try {
      provider.on?.('accountsChanged', onAccountsChanged);
      provider.on?.('disconnect', onDisconnect);
    } catch {
      // a provider without events: the state is read once
    }
    return () => {
      alive = false;
      try {
        provider.removeListener?.('accountsChanged', onAccountsChanged);
        provider.removeListener?.('disconnect', onDisconnect);
      } catch {
        // nothing to undo
      }
    };
  }, [provider]);

  const connect = useCallback(async () => {
    if (!provider || inFlight.current) return;
    inFlight.current = true;
    setConnecting(true);
    setError(null);
    const mine = ++seq.current;
    const result = await requestAccounts(provider);
    inFlight.current = false;
    setConnecting(false);
    const latest = mine === seq.current;
    if (latest) setAccountsKnown(true);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (latest) setAccounts(result.accounts);
  }, [provider]);

  const disconnect = useCallback(async () => {
    ++seq.current;
    setAccounts(null);
    setAccountsKnown(true);
    setError(null);
    if (provider && !(await revokeAccess(provider))) {
      setError('The wallet did not confirm. The site can also be removed under Connected sites in the extension settings.');
    }
  }, [provider]);

  const setView = useCallback((next: AddressView) => {
    setViewState(next);
    saveView(localStore(), next);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const activateNode = useCallback(
    async (nodeType: NodeType): Promise<ExtensionActivation> =>
      provider ? activateWithExtension(provider, nodeType) : { ok: false, failure: 'unsupported' },
    [provider],
  );

  const claimNodeBalance = useCallback(
    async (wallet: string): Promise<ExtensionClaim> =>
      provider ? claimWithExtension(provider, wallet, Math.floor(Date.now() / 1000)) : { ok: false, failure: 'unsupported' },
    [provider],
  );

  const readActivation = useCallback(
    async (): Promise<ExtensionActivationRead> => (provider ? getExtensionActivation(provider) : { ok: false, failure: 'unsupported' }),
    [provider],
  );

  const unlinkNodeDevice = useCallback(
    async (wallet: string): Promise<ExtensionUnlink> =>
      provider ? unlinkWithExtension(provider, wallet, Math.floor(Date.now() / 1000)) : { ok: false, failure: 'unsupported' },
    [provider],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      providerStatus, providerChannel, fromApp, accounts, accountsKnown, view, connecting, error, connect, disconnect, setView, clearError, activateNode,
      claimNodeBalance, readActivation, unlinkNodeDevice,
    }),
    [providerStatus, providerChannel, fromApp, accounts, accountsKnown, view, connecting, error, connect, disconnect, setView, clearError, activateNode, claimNodeBalance, readActivation,
      unlinkNodeDevice],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error('useWallet must be used within an AppProvider');
  }
  return context;
}

// Whether the page may show text about activation, its cost, other platforms or sideloaded builds: not in
// the QNet app's in-app browser, not on a visit the app opened, and not before the wallet is detected
// (src/lib/activate-view.ts). The header and every page decide with this one rule.
export function useActivationContent(): boolean {
  const { providerStatus, providerChannel, fromApp } = useWallet();
  return showsActivationContent(providerStatus, providerChannel, fromApp);
}

// A same-site path with the app's marker (?from=app) kept on it when the visit began with it, so a reload or
// a new tab of the next page stays in the app's view (keepFromApp). Every link and navigation between
// explorer pages goes through it (src/components/ExplorerLink.tsx, R5-XPD-06).
export function useKeepFromApp(): (href: string) => string {
  const { fromApp } = useWallet();
  return useCallback((href: string) => keepFromApp(href, fromApp), [fromApp]);
}
