'use client';

import { useState } from 'react';
import { sanitizeLogo } from '@/lib/sanitize-logo';

// ============================================================================
// TokenIcon — a token's icon "like normal blockchains", everywhere tokens show.
// ============================================================================
// Priority: (1) a real on-chain logo (only https:// URLs are rendered as <img>,
// so an unsanitized logo can never inject a javascript:/data: scheme); (2) an
// emoji logo shown in a chip; (3) a deterministic generated avatar (the token
// symbol's first letter on a colour derived from the contract address) — so
// EVERY token has an icon even with no logo set.

function hashColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 60%, 42%)`;
}

interface TokenIconProps {
  logo?: string | null;
  symbol?: string | null;
  address?: string | null;
  size?: number;
  // TRUE only for the native QNC coin (native transfers / QNC balance). Renders the fixed QNC brand
  // mark. Never set from a QRC-20's symbol, so a token that names itself "QNC" can't borrow the brand.
  native?: boolean;
}

export default function TokenIcon({ logo, symbol, address, size = 28, native = false }: TokenIconProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const logoStr = sanitizeLogo(logo); // backstop: node-mirrored sanitize at the render sink too
  const isUrl = !native && logoStr.startsWith('https://');
  const isEmoji = !native && logoStr.length > 0 && !isUrl && logoStr.length <= 8;
  const seed = String(address || symbol || '?');
  const letter = (String(symbol || '?').trim().charAt(0) || '?').toUpperCase();
  const px = `${size}px`;

  // Native QNC: fixed brand mark (cyan disc, "Q") — consistent everywhere the coin appears.
  if (native) {
    return (
      <span aria-hidden style={{
        width: px, height: px, borderRadius: '50%', flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(135deg,#00e5f0,#0a8fa0)', color: '#04141a',
        fontSize: Math.round(size * 0.5), fontWeight: 800, lineHeight: 1, userSelect: 'none',
      }}>Q</span>
    );
  }

  if (isUrl && !imgFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoStr}
        alt={symbol ? `${symbol} logo` : 'token logo'}
        width={size}
        height={size}
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
      style={{
        width: px, height: px, borderRadius: '50%', flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: isEmoji ? '#0b1a22' : hashColor(seed), color: '#fff',
        fontSize: isEmoji ? Math.round(size * 0.6) : Math.round(size * 0.46),
        fontWeight: 700, lineHeight: 1, userSelect: 'none', overflow: 'hidden',
      }}
    >
      {isEmoji ? logoStr : letter}
    </span>
  );
}
