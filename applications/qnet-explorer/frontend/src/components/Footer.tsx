'use client';

import React, { memo, useRef } from 'react';
import Link from 'next/link';
import EntityLink from '@/components/ui/EntityLink';
import { LiveDot } from '@/components/ui/Status';
import { useActivationContent } from '@/contexts/AppContext';
import { useChainHead } from '@/hooks/useChainHead';
import { useIntersectionObserver } from '@/hooks/useIntersectionObserver';
import { ANDROID_PLAY_URL, IOS_APP_STORE_URL, IOS_TESTFLIGHT_URL } from '@/lib/app-links';
import { t } from '@/lib/texts';

// Privacy and Terms on every page, in the small line under the footer (owner, 12.10); Support is in the Docs menu.
// They are pages of the QNet app's view too, where its own menu lists them with Support.
const FOOTER_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
];

// The social marks, drawn in the text colour.
const MARKS = {
  github: 'M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z',
  x: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z',
  telegram: 'M21.192 2.012a2.033 2.033 0 0 0-1.806-.415L2.14 8.71c-1.25.485-1.234 1.748.022 2.086l4.69 1.407 10.95-6.57-8.312 7.493-.588 4.542a1.49 1.49 0 0 0 1.42 1.482 1.49 1.49 0 0 0 .61-.13l2.364-1.182 4.418 3.26a1.488 1.488 0 0 0 2.21-.76l3.582-16.73A2.033 2.033 0 0 0 21.192 2.012z',
} as const;

function Mark({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

// The head block, linked to its page; the chain's stream is joined only while the footer is near the screen.
function LiveHeight() {
  const head = useChainHead();
  return head.height > 0 ? <EntityLink kind="block" value={head.height} /> : <span className="dash">—</span>;
}

const FooterComponent = () => {
  // The QNet app's view (and the page before the wallet is detected) links no place off this site
  // (src/lib/activate-view.ts): the repository's front page describes node activation and its cost and its
  // Releases hold the APK; the Telegram channel is where the site says Android builds are shared; and the
  // X account's posts are about the same subjects (R4-XPD-06). The row keeps its height either way.
  const full = useActivationContent();
  const root = useRef<HTMLElement>(null);
  const near = useIntersectionObserver(root, { rootMargin: '240px 0px' });
  return (
    <footer className={`ftr${near ? '' : ' off'}`} ref={root}>
      <div className="wrap">
        <p className="ftr-line">QNet Blockchain has you, Eon...<span className="cursor" aria-hidden="true" /></p>
        <div className="ftr-row">
          {full && (<a href="https://github.com/AIQnetLab/QNet-Blockchain/tree/testnet" target="_blank" rel="noopener noreferrer" className="ftr-mark" aria-label="QNet Blockchain on GitHub">
            <Mark path={MARKS.github} />
          </a>)}
          {full && (<a href="https://x.com/AIQnetLab" target="_blank" rel="noopener noreferrer" className="ftr-mark" aria-label="QNet Blockchain on X">
            <Mark path={MARKS.x} />
          </a>)}
          {full && (<a href="https://t.me/AiQnetLab" target="_blank" rel="noopener noreferrer" className="ftr-mark" aria-label="QNet Blockchain on Telegram">
            <Mark path={MARKS.telegram} />
          </a>)}
          {/* Until the App Store listing is live, iPhone and iPad install from TestFlight, named as such: the App Store
              badge opens only the listing (owner, 12.10: a badge never opens a placeholder). */}
          {full && !IOS_APP_STORE_URL && (
            <a href={IOS_TESTFLIGHT_URL} target="_blank" rel="noopener noreferrer" className="ftr-link">TestFlight</a>
          )}
          {/* The official store badges, served from /public/badges (img-src 'self'), off the QNet app's view like every
              other off-site link. One group, so a phone wraps it whole under the marks. */}
          {full && (<div className="store-badges">
            {IOS_APP_STORE_URL ? (
              <a href={IOS_APP_STORE_URL} target="_blank" rel="noopener noreferrer" className="app-store-badge">
                <img src="/badges/app-store.svg" alt={t('store_badge_ios')} className="store-badge" width={120} height={40} />
              </a>
            ) : (
              <span className="app-store-badge">
                <img src="/badges/app-store.svg" alt={t('store_badge_ios')} className="store-badge" width={120} height={40} />
              </span>
            )}
            <a href={ANDROID_PLAY_URL} target="_blank" rel="noopener noreferrer" className="google-play-badge">
              <img src="/badges/google-play.png" alt={t('store_badge_android')} width={646} height={250} />
            </a>
          </div>)}
        </div>
        <div className="ftr-legal">
          <span className="ftr-copyright">© 2026 Orrery Group LLC</span>
          <nav className="ftr-links" aria-label="Site policies">
            {FOOTER_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="ftr-link">{link.label}</Link>
            ))}
          </nav>
          <span className="ftr-height"><LiveDot />Block {near ? <LiveHeight /> : <span className="dash">—</span>}</span>
        </div>
      </div>
    </footer>
  );
};

const Footer = memo(FooterComponent);

export default Footer;
