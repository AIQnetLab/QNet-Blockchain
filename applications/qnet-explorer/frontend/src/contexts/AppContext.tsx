'use client';

// Wallet connection state for the whole page: one instance, shared by the desktop and the mobile
// header. On its own the page only asks the passive qnet_accounts; the wallet is asked to connect
// only when the user clicks. Everything here runs in the browser.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  detectProvider,
  loadView,
  readAccounts,
  requestAccounts,
  revokeAccess,
  saveView,
  sendSolanaTransfer,
  supportsSolanaTransfer,
  type AddressView,
  type ProviderStatus,
  type QNetProvider,
  type SolanaTransfer,
  type SolanaTransferResult,
  type WalletAccounts,
  type WalletChannel,
} from '@/lib/qnet-provider';
import {
  activateWithExtension, claimWithExtension, getExtensionActivation, unlinkWithExtension, type ExtensionActivation, type ExtensionActivationRead, type ExtensionClaim,
  type ExtensionUnlink, type NodeType,
} from '@/lib/qnet-link';
import { showsActivationContent } from '@/lib/activate-view';

interface WalletContextValue {
  providerStatus: ProviderStatus;
  // Null until a provider is bound; 'mobile' is the QNet app's in-app browser.
  providerChannel: WalletChannel | null;
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
  // qnet_claimNodeBalance: the extension moves the balance of `nodeId`, its own wallet's light or super node; checked
  // for `wallet` and that node.
  claimNodeBalance: (wallet: string, nodeId: string) => Promise<ExtensionClaim>;
  // qnet_getActivation: what the extension holds of its wallet's activation, read without a window; checked.
  readActivation: () => Promise<ExtensionActivationRead>;
  // qnet_unlinkNodeDevice: the extension unlinks its own wallet's light node from its device; checked for `wallet`.
  unlinkNodeDevice: (wallet: string) => Promise<ExtensionUnlink>;
  // qnet_sendSolanaTransfer: whether the bound extension takes it (asked without a window), and the transfer, which the
  // user confirms in the extension's window.
  takesSolanaTransfer: () => Promise<boolean>;
  sendSolanaTransfer: (transfer: SolanaTransfer) => Promise<SolanaTransferResult>;
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
  const [accounts, setAccounts] = useState<WalletAccounts | null>(null);
  const [accountsKnown, setAccountsKnown] = useState(false);
  const [view, setViewState] = useState<AddressView>('qnet');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Each read, connect or disconnect takes a number; only the latest may set the accounts.
  const seq = useRef(0);

  useEffect(() => {
    setViewState(loadView(localStore()));
    return detectProvider(
      window,
      (p: QNetProvider, channel: WalletChannel) => {
        setProvider(p);
        setProviderChannel(channel);
        setProviderStatus('available');
      },
      () => setProviderStatus('missing'),
    );
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
    async (wallet: string, nodeId: string): Promise<ExtensionClaim> =>
      provider ? claimWithExtension(provider, wallet, nodeId, Math.floor(Date.now() / 1000)) : { ok: false, failure: 'unsupported' },
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

  const takesSolanaTransfer = useCallback(
    async (): Promise<boolean> => (provider && providerChannel === 'extension' ? supportsSolanaTransfer(provider) : false),
    [provider, providerChannel],
  );

  const sendTransfer = useCallback(
    async (transfer: SolanaTransfer): Promise<SolanaTransferResult> =>
      provider ? sendSolanaTransfer(provider, transfer) : { ok: false, failure: 'unsupported' },
    [provider],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      providerStatus, providerChannel, accounts, accountsKnown, view, connecting, error, connect, disconnect, setView, clearError, activateNode,
      claimNodeBalance, readActivation, unlinkNodeDevice, takesSolanaTransfer, sendSolanaTransfer: sendTransfer,
    }),
    [providerStatus, providerChannel, accounts, accountsKnown, view, connecting, error, connect, disconnect, setView, clearError, activateNode,
      claimNodeBalance, readActivation, unlinkNodeDevice, takesSolanaTransfer, sendTransfer],
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
// the QNet app's in-app browser and not before the wallet is detected (src/lib/activate-view.ts). The
// header and every page decide with this one rule.
export function useActivationContent(): boolean {
  const { providerStatus, providerChannel } = useWallet();
  return showsActivationContent(providerStatus, providerChannel);
}
