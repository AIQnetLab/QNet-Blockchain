'use client';

// The link page's one live part (docs/protocols/qnet-link-v1.md sections 4, 4.1 and 14.3): on Android, when this
// page's own URL is a valid link, the button that opens QNet Wallet. The URL is read once, as a whole, through
// the strict parser, and goes nowhere but into that intent: URL in this page. Its texts come from the page.

import { useEffect, useState } from 'react';
import { WALLET_PAGE, androidIntentUrl, parseLink } from '@/lib/qnet-link';
import { isAndroid } from '@/lib/qnet-provider';

export default function LinkButtons({ lead, button, note }: { lead: string; button: string; note: string }) {
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    const here = window.location.href;
    if (isAndroid(window.navigator) && parseLink(here)) setLink(here);
  }, []);

  if (!link) return null;
  const open = androidIntentUrl(link, WALLET_PAGE);
  if (!open) return null;
  return (
    <div className="activate-card">
      <p>{lead}</p>
      <div className="link-open">
        <a className="qnet-button activate-primary" href={open}>{button}</a>
      </div>
      <p className="activate-note">{note}</p>
    </div>
  );
}
