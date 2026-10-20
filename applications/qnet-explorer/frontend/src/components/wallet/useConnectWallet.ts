'use client';

// The one Connect wallet, behind the header's control and My node's connect card (owner, 20.10). What it does on this
// device is connectWay (src/lib/qnet-provider.ts): a computer with the QNet extension asks it, and My node keeps the
// wallet it shares as one connected with a tap; a phone or tablet asks QNet Wallet with the connect card's `connect`
// request (src/lib/cabinet/connect-card.ts), whose button opens the app; a computer without the extension gets the
// extension's store page, a link, so nothing is asked. Every tap ends a view of an address.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@/contexts/AppContext';
import { chooseWallet, endView } from '@/components/cabinet/CabinetProvider';
import { useDeviceKind } from '@/hooks/useDeviceKind';
import { askAppConnect } from '@/lib/cabinet/connect-card';
import { connectWay, type ConnectWay } from '@/lib/qnet-provider';

export interface ConnectWallet {
  way: ConnectWay;
  // The extension's approval window is open (asked here or by the other control).
  waiting: boolean;
  // This control asked the extension and it did not share its wallet; gone with the wallet's error.
  failed: boolean;
  // Connect wallet: the way of this device.
  run: () => void;
  // The extension, asked directly (a phone or tablet whose browser has it).
  askExtension: () => void;
}

// `onConnected`: after the extension shared its wallet because this control asked (the header opens My node).
export function useConnectWallet(onConnected?: () => void): ConnectWallet {
  const { providerStatus, providerChannel, accounts, connecting, error, connect } = useWallet();
  const device = useDeviceKind();
  const way = connectWay(providerStatus, providerChannel, device, device ? window.navigator : null);
  const [asked, setAsked] = useState(false);
  const [tried, setTried] = useState(false);
  const done = useRef(onConnected);
  done.current = onConnected;

  // The extension shared its wallet after this control asked.
  useEffect(() => {
    if (!asked || !accounts) return;
    setAsked(false);
    chooseWallet({ qnet: accounts.qnet, source: 'extension', solana: accounts.solana });
    done.current?.();
  }, [asked, accounts]);

  // Declined, or not answered: the ask ends with the wallet's error shown.
  useEffect(() => {
    if (asked && !connecting && error) setAsked(false);
  }, [asked, connecting, error]);

  const askExtension = useCallback(() => {
    endView();
    setTried(true);
    setAsked(true);
    if (!accounts) void connect();
  }, [accounts, connect]);

  const kind = way.kind;
  const run = useCallback(() => {
    if (kind === 'extension') askExtension();
    else if (kind === 'app') {
      endView();
      askAppConnect();
    }
  }, [kind, askExtension]);

  return { way, waiting: connecting, failed: tried && !connecting && error !== null, run, askExtension };
}
