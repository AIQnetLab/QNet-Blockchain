// The page's language on the server: the proxy (src/proxy.ts) takes it from the address and hands it on in request
// headers it always sets itself, with the path without the language and whether the address named English. Every page
// renders per request, so each language is rendered when it is asked for and nothing is prerendered eleven times.

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_HEADER, NAMED_HEADER, PATH_HEADER, alternates, isLocale, ogLocale, type Locale } from '@/lib/languages';
import { SITE_ORIGIN } from '@/lib/hosts';
import type { MessageKey } from '@/lib/texts';
import { pageTitle } from '@/lib/texts';
import { CATALOGS } from './catalogs';
import { makeI18n, type I18n } from './core';

export async function getLocale(): Promise<Locale> {
  const value = (await headers()).get(LOCALE_HEADER);
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

// `href` keeps /en/ for a page whose address names English, as the browser's links do (src/i18n/client.tsx).
export async function getI18n(): Promise<I18n> {
  const locale = await getLocale();
  const named = locale === DEFAULT_LOCALE && (await headers()).get(NAMED_HEADER) === '1';
  return makeI18n(locale, CATALOGS[locale], named);
}

// The page's canonical link and hreflang alternates (src/lib/languages.ts alternates).
export async function localeAlternates(): Promise<Metadata['alternates']> {
  return alternates(await getLocale(), (await headers()).get(PATH_HEADER) || '/', SITE_ORIGIN);
}

// A page's title and description in its language: the parts of the title, then the site's name.
export async function pageMetadata(title: MessageKey[], description?: MessageKey): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: pageTitle(t, ...title), ...(description ? { description: t(description) } : {}) };
}

// A chain record's page (a block, a transaction, an address, a token): its kind in the explorer as its title, crawlable
// for its links and kept out of the index.
export async function recordMetadata(kind: MessageKey): Promise<Metadata> {
  return { ...(await pageMetadata([kind, 'hdr_explorer'])), robots: { index: false, follow: true } };
}

export { ogLocale };
