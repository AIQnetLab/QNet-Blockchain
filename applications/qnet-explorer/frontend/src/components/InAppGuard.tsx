'use client';

// The pages whose subject is activation, its cost, the testnet faucet, the DAO, the extension or the
// documentation (IN_APP_EXCLUDED_PAGES in src/lib/activate-view.ts). No link in the QNet app's view leads
// to them; one reached anyway (a typed address) shows nothing there and goes to the explorer.
//
// They follow the site's one rule (useActivationContent): nothing of them is displayed while the wallet is
// still being detected, the server's render included, so the app's in-app browser never paints them before
// its provider has announced itself. The markup stays in the page, hidden, so a crawler still reads it; the
// wrapper takes no box of its own once shown.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useActivationContent, useWallet } from '@/contexts/AppContext';
import { IN_APP_HOME, isInAppBrowser, keepFromApp } from '@/lib/activate-view';

// `React.ReactNode`: the layouts pass on what Next.js gives them, unchanged.
export default function InAppGuard({ children }: { children: React.ReactNode }) {
  const { providerChannel, fromApp } = useWallet();
  const show = useActivationContent();
  const router = useRouter();
  const inApp = fromApp || isInAppBrowser(providerChannel);

  useEffect(() => {
    if (inApp) router.replace(keepFromApp(IN_APP_HOME, fromApp));
  }, [inApp, fromApp, router]);

  if (inApp) return null;
  return (
    <div hidden={!show} style={show ? { display: 'contents' } : undefined}>
      {children}
    </div>
  );
}
