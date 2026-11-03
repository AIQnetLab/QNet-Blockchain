// Which language a page request is served in (src/proxy.ts). The address decides: /ru/explorer is the explorer in
// Russian, /explorer in English, and /en/explorer in English too, for a browser that keeps no cookie; once English is
// kept, /en/... goes to the address without it. A visitor's first page without a kept language takes the browser's
// language once and keeps it in a cookie; the switcher's choice replaces it; with a kept language other than English an
// address without a language goes to that language's. Crawlers are never sent to another language, and the link pages
// (served on the link host too) take the visitor's language without changing their address.

import { DEFAULT_LOCALE, localeFromAccept, localeIn, localePath, splitLocale, type Locale } from './languages.ts';
import { LINK_PAGES } from './hosts.ts';

export interface LocaleRequest {
  pathname: string;
  search: string;
  cookie: string | null;
  acceptLanguage: string | null;
  userAgent: string | null;
  // A browser loading a page (not a router fetch, a prefetch or a script).
  document: boolean;
}

export type LocaleRoute =
  | { kind: 'redirect'; location: string; keep?: Locale }
  | { kind: 'page'; locale: Locale; path: string; rewrite: boolean; keep?: Locale }
  | { kind: 'none' };

// Whether a request is a browser loading a page: Sec-Fetch-Dest, or, from a browser that sends none, an Accept naming
// HTML. The router's own requests and prefetches are fetches, never that; their RSC headers are not read.
export function isPageLoad(method: string, headers: { get(name: string): string | null }): boolean {
  if (method !== 'GET' || headers.get('purpose') === 'prefetch') return false;
  const dest = headers.get('sec-fetch-dest');
  return dest === null ? /\btext\/html\b/i.test(headers.get('accept') ?? '') : dest === 'document';
}

// Crawlers and link previews: generic words of their user agents.
const CRAWLER = /bot|crawl|spider|preview|externalhit|headless/i;
// Paths that are no page in a language: files, the app-association files, the robots and sitemap files, /get, the API.
const UNLOCALIZED = /^\/(\.well-known\/|api\/|robots\.txt$|sitemap\.xml$|get$|_next\/)|\.[a-z0-9]+$/i;

export function localeRoute(req: LocaleRequest): LocaleRoute {
  const { locale, path } = splitLocale(req.pathname);
  if (UNLOCALIZED.test(path)) return { kind: 'none' };
  const kept = localeIn(req.cookie);
  const crawler = CRAWLER.test(req.userAgent ?? '');
  if (locale === DEFAULT_LOCALE && (crawler || (req.document && kept === DEFAULT_LOCALE))) return { kind: 'redirect', location: `${path}${req.search}` };
  if (locale) return { kind: 'page', locale, path, rewrite: true };
  if (LINK_PAGES.has(path)) return { kind: 'page', locale: kept ?? (crawler ? null : localeFromAccept(req.acceptLanguage)) ?? DEFAULT_LOCALE, path, rewrite: false };
  if (crawler || !req.document) return { kind: 'page', locale: DEFAULT_LOCALE, path, rewrite: false };
  const chosen = kept ?? localeFromAccept(req.acceptLanguage) ?? DEFAULT_LOCALE;
  const keep = kept ? undefined : chosen;
  if (chosen !== DEFAULT_LOCALE) return { kind: 'redirect', location: localePath(chosen, `${path}${req.search}`), keep };
  return { kind: 'page', locale: DEFAULT_LOCALE, path, rewrite: false, keep };
}
