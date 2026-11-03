'use client';

// Last resort when the root layout itself fails: a plain page with a reload button. The site's stylesheets do not load
// here, so its few rules are written in place with the values of styles/tokens.css (Ink, Paper, Signal, the 2 px radius).
// Without the layout there is no language provider: the page reads its language from its address and its words from
// the texts it carries for every language, so its first frame is already in that language and loads nothing.

import { useSyncExternalStore } from 'react';
import { LAST_RESORT } from '@/i18n/last-resort';
import { DEFAULT_LOCALE, isRtl, splitLocale, type Locale } from '@/lib/languages';

const INK = '#05080A';
const PAPER = '#E8F0F0';
const SIGNAL = '#3CF0DC';

// The address never changes while this page is shown. A server render, which has no address here, says English and
// the browser's first render after it switches at once.
const unchanging = () => () => {};
const addressLocale = (): Locale => splitLocale(window.location.pathname).locale ?? DEFAULT_LOCALE;
const serverLocale = (): Locale => DEFAULT_LOCALE;

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const locale = useSyncExternalStore(unchanging, addressLocale, serverLocale);
  const say = LAST_RESORT[locale];
  return (
    <html lang={locale} dir={isRtl(locale) ? 'rtl' : 'ltr'}>
      <body style={{ background: INK, color: PAPER, fontFamily: "'Helvetica Neue', Arial, system-ui, sans-serif", margin: 0 }}>
        <main style={{ maxWidth: '640px', margin: '20vh auto 0', padding: '0 16px' }}>
          <h1 style={{ margin: 0, fontSize: '36px', fontWeight: 760, lineHeight: 1.05, letterSpacing: '-0.03em' }}>{say.title}</h1>
          <p style={{ margin: '18px 0 0', fontSize: '17px', lineHeight: 1.6, color: 'rgb(232 240 240 / .8)' }}>{say.lead}</p>
          <button
            type="button"
            onClick={() => { reset(); window.location.reload(); }}
            style={{ marginTop: '28px', padding: '17px 24px', minWidth: '120px', minHeight: '52px', background: SIGNAL, color: INK, border: 0, borderRadius: '2px', font: 'inherit', fontSize: '15.5px', fontWeight: 600, cursor: 'pointer' }}
          >
            {say.reload}
          </button>
        </main>
      </body>
    </html>
  );
}
