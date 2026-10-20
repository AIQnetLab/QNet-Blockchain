'use client';

import { useState } from 'react';
import { sanitizeLogo } from '@/lib/sanitize-logo';

// A contract address in EON form (src/server/logo-proxy.ts CONTRACT_RE); only such a path is ever built.
const CONTRACT_RE = /^[0-9a-f]{19}eon[0-9a-f]{15}[0-9a-f]{8}$/;

// ============================================================================
// TokenIcon — a token's icon "like normal blockchains", everywhere tokens show.
// ============================================================================
// Priority: (1) a real on-chain logo: when the token's logo is an https:// URL,
// the image is loaded from this site's own /api/token/<contract>/logo, which
// fetches it server-side (src/server/logo-proxy.ts), never from the deployer's
// host, so the logo cannot tell its deployer who views which address (the page
// CSP allows images from 'self' and data: only); (2) an emoji logo shown in a
// chip; (3) a deterministic generated avatar (the token symbol's first letter on
// a colour derived from the contract address) — so EVERY token has an icon even
// with no logo set, or when its logo cannot be served.

// The two Solana assets the site names (activation, faucet), bundled: SOL's mark drawn inline, 1DEV's image as data.
const ONE_DEV_SRC = 'data:image/webp;base64,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';
const SOL_BARS = [
  'M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1z',
  'M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1z',
  'M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1z',
];

function hashColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 60%, 42%)`;
}

interface TokenIconProps {
  logo?: string | null;
  symbol?: string | null;
  address?: string | null;
  // Pixels, or 'text': the height of the surrounding text's capitals and figures (styles/base.css .tok-text), for an
  // icon that stands in a line with an amount or a token's name.
  size?: number | 'text';
  // TRUE only for the native QNC coin (native transfers / QNC balance). Renders the fixed QNC brand
  // mark. Never set from a QRC-20's symbol, so a token that names itself "QNC" can't borrow the brand.
  native?: boolean;
  // A Solana asset by its symbol: its own bundled icon.
  solana?: 'SOL' | '1DEV';
}

export default function TokenIcon({ logo, symbol, address, size = 28, native = false, solana }: TokenIconProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const logoStr = sanitizeLogo(logo); // backstop: node-mirrored sanitize at the render sink too
  const isUrl = !native && logoStr.startsWith('https://');
  const contract = typeof address === 'string' && CONTRACT_RE.test(address) ? address : null;
  const isEmoji = !native && logoStr.length > 0 && !isUrl && logoStr.length <= 8;
  const seed = String(address || symbol || '?');
  const letter = (String(symbol || '?').trim().charAt(0) || '?').toUpperCase();
  // In a line of text the stylesheet sizes the icon from the text; otherwise it is `size` pixels square.
  const text = size === 'text';
  const px = text ? undefined : `${size}px`;
  const box = text ? 'tok-text' : undefined;
  const glyph = (scale: number) => (text ? `${scale}em` : Math.round((size as number) * scale));

  if (solana === '1DEV') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={ONE_DEV_SRC} alt="1DEV" width={text ? 16 : size} height={text ? 16 : size} className={box}
        style={{ width: px, height: px, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
    );
  }
  if (solana === 'SOL') {
    return (
      <span aria-hidden className={box} style={{
        width: px, height: px, borderRadius: '50%', flexShrink: 0, background: '#05080a',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg viewBox="0 0 397.7 311.7" width="58%" height="58%" aria-hidden>
          <defs>
            <linearGradient id="sol-mark" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#9945FF" />
              <stop offset="1" stopColor="#14F195" />
            </linearGradient>
          </defs>
          {SOL_BARS.map((d) => <path key={d} d={d} fill="url(#sol-mark)" />)}
        </svg>
      </span>
    );
  }

  // Native QNC: the real brand logo (local /public asset), consistent with the mobile wallet.
  // If the asset ever 404s (e.g. not deployed), fall back to a brand disc — never a broken image.
  if (native) {
    if (imgFailed) {
      return (
        <span aria-hidden className={box} style={{
          width: px, height: px, borderRadius: '50%', flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'linear-gradient(135deg,#00e5f0,#0a8fa0)', color: '#04141a',
          fontWeight: 800, lineHeight: 1, userSelect: 'none',
        }}><span style={{ fontSize: glyph(0.5) }}>Q</span></span>
      );
    }
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/qnc-logo.png"
        alt="QNC"
        width={text ? 16 : size}
        height={text ? 16 : size}
        className={box}
        onError={() => setImgFailed(true)}
        style={{ width: px, height: px, borderRadius: '50%', objectFit: 'contain', flexShrink: 0, background: '#04141a' }}
      />
    );
  }

  if (isUrl && contract && !imgFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/token/${contract}/logo`}
        alt={symbol ? `${symbol} logo` : 'token logo'}
        width={text ? 16 : size}
        height={text ? 16 : size}
        className={box}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
        style={{ width: px, height: px, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, background: '#0b1a22' }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={box}
      style={{
        width: px, height: px, borderRadius: '50%', flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: isEmoji ? '#0b1a22' : hashColor(seed), color: '#fff',
        fontWeight: 700, lineHeight: 1, userSelect: 'none', overflow: 'hidden',
      }}
    >
      <span style={{ fontSize: glyph(isEmoji ? 0.6 : 0.46) }}>{isEmoji ? logoStr : letter}</span>
    </span>
  );
}
