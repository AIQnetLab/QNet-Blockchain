'use client';

// The site's shell around every page: the wallet context, the background, the header with its wallet
// control, and the footer. The link page (/l, docs/protocols/qnet-link-v1.md section 4) is not a page of the
// site: it is served on link.aiqnet.io, where the extension does not run, and carries a wallet request in
// its URL. It renders alone on every host, the server's render included: no provider discovery, no wallet
// control, no navigation and no other site script around it. So does any other page rendered for the link
// host (the root layout passes `onLinkHost` from the request's Host). The proxy (src/proxy.ts) already sends every
// path there but its exact files to aiqnet.io, and a missing build asset is a plain 404; this holds even
// for a request that reaches the app past that rule, as /icon-1.png and /_next/staticx did (SITE-R4-CSP-01).

import { usePathname } from 'next/navigation';
import { AppProvider } from '@/contexts/AppContext';
import { LINK_PAGE_PATH } from '@/lib/hosts';
import Header from './Header';
import MatrixRain from './MatrixRain';
import Footer from './Footer';

// `React.ReactNode`, the type the root layout receives from Next.js, passed through unchanged.
export default function SiteShell({ children, onLinkHost }: { children: React.ReactNode; onLinkHost: boolean }) {
  const pathname = usePathname();
  if (onLinkHost || pathname === LINK_PAGE_PATH) {
    return (
      <div className="app-wrapper">
        <main className="qnet-container">{children}</main>
      </div>
    );
  }
  return (
    <AppProvider>
      <div className="app-wrapper">
        <MatrixRain />
        <Header />
        <main className="qnet-container">{children}</main>
        <Footer />
      </div>
    </AppProvider>
  );
}
