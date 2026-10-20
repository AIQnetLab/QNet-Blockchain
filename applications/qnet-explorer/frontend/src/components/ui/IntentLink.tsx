'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AnchorHTMLAttributes } from 'react';

// A link to an entity's page (a block, a transaction, an address, a token, an epoch): never read ahead as it comes into
// view, which a list of fifty rows would turn into fifty page reads per screen, only as the visitor points at it, focuses
// it or touches it, so the page is on its way before the click lands. The site's navigation keeps Next.js's own.
export default function IntentLink({ href, onMouseEnter, onFocus, onTouchStart, ...rest }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string }) {
  const router = useRouter();
  const ahead = () => router.prefetch(href);
  return (
    <Link
      {...rest}
      href={href}
      prefetch={false}
      onMouseEnter={(e) => { ahead(); onMouseEnter?.(e); }}
      onFocus={(e) => { ahead(); onFocus?.(e); }}
      onTouchStart={(e) => { ahead(); onTouchStart?.(e); }}
    />
  );
}
