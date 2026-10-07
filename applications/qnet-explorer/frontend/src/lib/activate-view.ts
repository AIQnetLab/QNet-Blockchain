// What the store builds of the QNet app get of the site, as pure functions (src/lib/__tests__/activate-view.test.mjs,
// in-app-pages.test.mjs): their in-app browser, and the pages they open in the system browser. The node cabinet's
// words for the extension's answers are in src/lib/cabinet/extension-view.ts.

import type { WalletChannel } from './qnet-provider.ts';

// The QNet app's store builds (Google Play, App Store) carry no text about activation or payment, and no
// way to it. The site holds to that where those builds show it:
// - in the app's in-app browser, known by the provider channel 'mobile';
// - in the system browser, on a page the app opened with the marker `?from=app` (its policy and support
//   links), kept for the rest of the visit in the page's memory and on the header's links.
// A page shows such text only once it knows it is elsewhere: never while the wallet is still being
// detected (the server's render included), never in those two places.
export type DetectStatus = 'detecting' | 'available' | 'missing';

export function showsActivationContent(status: DetectStatus, channel: WalletChannel | null, fromApp = false): boolean {
  return !fromApp && status !== 'detecting' && channel !== 'mobile';
}

export const FROM_APP_PARAM = 'from';
export const FROM_APP_VALUE = 'app';

// Whether a page's query carries the app's marker.
export function openedFromApp(search: string): boolean {
  try {
    return new URLSearchParams(search).get(FROM_APP_PARAM) === FROM_APP_VALUE;
  } catch {
    return false;
  }
}

// A same-site path with the marker kept on it, so a reload or a new tab stays in the app's view.
export function keepFromApp(href: string, fromApp: boolean): string {
  if (!fromApp || !href.startsWith('/') || href.startsWith('//')) return href;
  const [path, hash = ''] = href.split('#', 2);
  const joined = `${path}${path.includes('?') ? '&' : '?'}${FROM_APP_PARAM}=${FROM_APP_VALUE}`;
  return hash ? `${joined}#${hash}` : joined;
}

export interface NavLink {
  href: string;
  label: string;
  external?: boolean;
}

// The header links in the app's view: the explorer (the in-app browser's bookmark) and the policies the
// app already links; none of the pages about the wallet, the testnet faucet, the DAO or the docs. The
// logo leads to the explorer too. These pages show no activation text and no link to one in that view
// (src/lib/__tests__/in-app-pages.test.mjs).
export const IN_APP_NAV: NavLink[] = [
  { href: '/explorer', label: 'Explorer' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/support', label: 'Support' },
];

export const IN_APP_HOME = '/explorer';

// The pages whose subject is activation, its cost, the node cabinet, the wallet's platforms and builds, the testnet
// faucet, the DAO, the extension or the documentation: the app's view never shows them and goes to the explorer
// instead (src/components/InAppGuard.tsx). `/node` covers every cabinet page; `/activate` is only the redirect to
// /node/activate (next.config.js). The app's in-app browser refuses the same paths.
export const IN_APP_EXCLUDED_PAGES = ['/', '/docs', '/dao', '/testnet', '/qnet-wallet-extension', '/node', '/activate', '/wallet'] as const;

export function isInAppBrowser(channel: WalletChannel | null): boolean {
  return channel === 'mobile';
}
