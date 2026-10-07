'use client';

// The link between explorer pages. The QNet app's store builds open explorer pages with ?from=app, and the
// site keeps that visit in the app's view (src/lib/activate-view.ts); a plain link would drop the marker, and
// a reload or a new tab of the next page would show the full site (R5-XPD-06). Every link of the explorer's
// pages is this one (src/lib/__tests__/in-app-pages.test.mjs).

import Link from 'next/link';
import type { AnchorHTMLAttributes } from 'react';
import { useKeepFromApp } from '@/contexts/AppContext';

// A same-site path (a string, never a URL object), and the anchor's own attributes.
type ExplorerLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string };

export default function ExplorerLink({ href, ...rest }: ExplorerLinkProps) {
  const keep = useKeepFromApp();
  return <Link href={keep(href)} {...rest} />;
}
