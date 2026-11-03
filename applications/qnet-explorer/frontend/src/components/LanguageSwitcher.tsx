'use client';

// The language switcher, one for the whole site: in the header's row on a wide screen (a button and its menu), and on a
// phone the same eleven languages in place inside the header's menu, one tap each. The languages are QNet Wallet's, in
// its order and each in its own language. A choice opens the same page, query included, in that language and keeps it
// in a cookie (src/lib/languages.ts), a full page load so the whole page changes language at once. Each language's link
// names it, English too (/en/...), so the choice holds in a browser that refuses the cookie.

import type { MouseEvent } from 'react';
import { usePath, useI18n } from '@/i18n/client';
import { LANGUAGES, language, localeCookie, localePath, type Locale } from '@/lib/languages';
import { useMenu } from './ui/useMenu';

function choose(e: MouseEvent<HTMLAnchorElement>, locale: Locale, path: string) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  document.cookie = localeCookie(locale, window.location.protocol === 'https:');
  window.location.assign(`${localePath(locale, path, true)}${window.location.search}${window.location.hash}`);
}

export default function LanguageSwitcher() {
  const { locale, t } = useI18n();
  const path = usePath();
  const { open, setOpen, root, button, listId } = useMenu(path);
  const current = language(locale);
  return (
    <div className="lang" data-open={open || undefined} ref={root}>
      <button
        ref={button}
        type="button"
        className="nav-link lang-btn"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={t('lang_button', { language: current.name })}
        data-field-clear
        onClick={() => setOpen((was) => !was)}
      >
        {/* The globe says "language" to a reader who cannot read the page's own. */}
        <svg className="lang-mark" viewBox="0 0 16 16" width={15} height={15} aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M1.5 8h13M8 1.5c-2.2 2.4-2.2 10.6 0 13M8 1.5c2.2 2.4 2.2 10.6 0 13" />
        </svg>
        <span className="lang-now" lang={current.code}>{current.name}</span>
        <span className="chev" aria-hidden="true" />
      </button>
      <p className="label lang-h" aria-hidden="true">{t('lang_label')}</p>
      <ul className="lang-menu" id={listId} hidden={!open} aria-label={t('lang_label')}>
        {LANGUAGES.map((l) => (
          <li key={l.code}>
            <a
              className="lang-link"
              href={localePath(l.code, path, true)}
              hrefLang={l.code}
              lang={l.code}
              aria-current={l.code === locale ? 'true' : undefined}
              onClick={(e) => choose(e, l.code, path)}
            >
              {l.name}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
