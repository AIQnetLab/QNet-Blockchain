'use client';

// The site's shell around every page: the wallet context, the header with its wallet control, and the footer. The
// field (the hex rain) lives in each page's own head zone (components/ui/PageHead.tsx), never behind the whole page.
// The link pages (/l and /send, docs/protocols/qnet-link-v1.md sections 4 and 15) are not pages of the site: they are
// served on link.aiqnet.io, where the extension does not run, and carry a wallet request in the URL. Each renders alone
// on every host, the server's render included: no provider discovery, no wallet control, no navigation and no other
// site script around it. So does any other page rendered for the link host (the root layout passes `onLinkHost` from
// the request's Host). The proxy (src/proxy.ts) already sends every path there but its exact files to aiqnet.io, and a
// missing build asset is a plain 404; this holds even for a request that reaches the app past that rule, as
// /icon-1.png and /_next/staticx did (SITE-R4-CSP-01).

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { AppProvider } from '@/contexts/AppContext';
import { LINK_PAGES } from '@/lib/hosts';
import { installTarget } from '@/lib/install-target';
import Header from './Header';
import Footer from './Footer';

// The root layout names the device from the request (<html data-device>); only the page sees an iPad in desktop mode
// by its touch points, and corrects it.
function DeviceClass() {
  useEffect(() => {
    const target = installTarget(navigator.userAgent, navigator.maxTouchPoints || 0);
    if (document.documentElement.dataset.device !== target) document.documentElement.dataset.device = target;
  }, []);
  return null;
}

// `React.ReactNode`, the type the root layout receives from Next.js, passed through unchanged.
export default function SiteShell({ children, onLinkHost }: { children: React.ReactNode; onLinkHost: boolean }) {
  const pathname = usePathname();
  if (onLinkHost || LINK_PAGES.has(pathname)) {
    return (
      <div className="app-wrapper">
        <main className="qnet-container">{children}</main>
      </div>
    );
  }
  return (
    <AppProvider>
      <div className="app-wrapper">
        <DeviceClass />
        <Header />
        <main className="qnet-container">{children}</main>
        <Footer />
      </div>
    </AppProvider>
  );
}
