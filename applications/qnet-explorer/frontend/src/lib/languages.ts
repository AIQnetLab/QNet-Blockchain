// The languages of QNet Wallet, in the app's order and with the app's names (applications/qnet-mobile/src/i18n/index.js
// LANGUAGES); the site speaks the same ones and lists them in that order. English has no prefix in a page's address;
// every other language puts its code first (/ru/explorer), so each page has one address per language.

export const LANGUAGES = Object.freeze([
  { code: 'en', name: 'English' },
  { code: 'zh-CN', name: '中文' },
  { code: 'ru', name: 'Русский' },
  { code: 'es', name: 'Español' },
  { code: 'ko', name: '한국어' },
  { code: 'ja', name: '日本語' },
  { code: 'pt', name: 'Português' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'ar', name: 'العربية' },
  { code: 'it', name: 'Italiano' },
] as const);

export type Locale = (typeof LANGUAGES)[number]['code'];

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALES: readonly Locale[] = LANGUAGES.map((l) => l.code);
const RTL: ReadonlySet<Locale> = new Set(['ar']);

// The cookie that keeps the visitor's language: the switcher's choice, or the one picked once from the browser's.
export const LOCALE_COOKIE = 'qnet.lang';
// A year, like the explorer's own cookie.
const KEEP_S = 365 * 24 * 60 * 60;
// The request header the proxy hands a page its language in (src/proxy.ts); never taken from the visitor.
export const LOCALE_HEADER = 'x-qnet-locale';
// The page's path without its language, for its addresses in the other languages.
export const PATH_HEADER = 'x-qnet-path';
// Set when the page's address names English (/en/...), so the addresses a server page makes keep that prefix.
export const NAMED_HEADER = 'x-qnet-named';

export const isLocale = (value: unknown): value is Locale => typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
export const isRtl = (locale: Locale): boolean => RTL.has(locale);
// A language's entry (its code and its own name); English for a code the site does not speak.
export const language = (locale: Locale) => LANGUAGES.find((l) => l.code === locale) ?? LANGUAGES[0];

// The language a path starts with and the path without it; a path without one is English, and /en/... names English
// (the address for a browser that keeps no cookie, src/lib/locale-route.ts).
export function splitLocale(pathname: string): { locale: Locale | null; path: string } {
  const first = pathname.split('/')[1] ?? '';
  if (isLocale(first)) {
    const rest = pathname.slice(first.length + 1);
    return { locale: first, path: rest === '' ? '/' : rest };
  }
  return { locale: null, path: pathname };
}

// A page's address in a language: English as it is, any other with its code first; `named` puts English's code first
// too, the address that states English where no cookie keeps it. Only a path on this site changes.
export function localePath(locale: Locale, href: string, named = false): string {
  if (!href.startsWith('/') || href.startsWith('//') || (locale === DEFAULT_LOCALE && !named)) return href;
  if (splitLocale(href.split(/[?#]/)[0]).locale) return href;
  return href === '/' ? `/${locale}` : /^\/[?#]/.test(href) ? `/${locale}${href.slice(1)}` : `/${locale}${href}`;
}

// A page's address in every language at `origin`, for its canonical link and its hreflang alternates (x-default the
// English one); the query is no part of it.
export function alternates(locale: Locale, path: string, origin: string): { canonical: string; languages: Record<string, string> } {
  const at = (l: Locale) => `${origin}${localePath(l, path)}`;
  const languages: Record<string, string> = Object.fromEntries(LOCALES.map((l) => [l, at(l)]));
  languages['x-default'] = at(DEFAULT_LOCALE);
  return { canonical: at(locale), languages };
}

// The visitor's language from an Accept-Language header: the first supported one by weight; Chinese is the app's
// Simplified Chinese and every Portuguese the one Portuguese. Null when none is supported.
export function localeFromAccept(header: string | null | undefined): Locale | null {
  const wanted = (header ?? '').split(',').map((part, i) => {
    const [tag, ...params] = part.trim().split(';');
    const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)).find(Boolean);
    return { tag: tag.trim().toLowerCase(), q: q ? Number(q[1]) : 1, i };
  }).filter((w) => w.tag && w.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of wanted) {
    const base = tag.split('-')[0];
    if (base === 'zh') return 'zh-CN';
    const found = LOCALES.find((l) => l.toLowerCase() === base);
    if (found) return found;
  }
  return null;
}

// The language kept in a Cookie header or document.cookie, when it is one of the site's. A language code needs no
// escape (localeCookie writes it raw), so the value is compared as sent: a malformed one is no language, never an error.
export function localeIn(cookies: string | null | undefined): Locale | null {
  for (const part of (cookies ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === LOCALE_COOKIE) {
      const value = part.slice(at + 1).trim();
      return isLocale(value) ? value : null;
    }
  }
  return null;
}

// The Set-Cookie value that keeps a language, for the whole site.
export function localeCookie(locale: Locale, secure: boolean): string {
  const value = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${KEEP_S}; SameSite=Lax`;
  return secure ? `${value}; Secure` : value;
}

// The tag dates and times are written with: the language's month and day names, Latin digits in every language.
export const dateLocale = (locale: Locale): string => (locale === 'ar' ? 'ar-u-nu-latn' : locale);

// The page's language as Open Graph names it.
const OG: Record<Locale, string> = {
  en: 'en_US', 'zh-CN': 'zh_CN', ru: 'ru_RU', es: 'es_ES', ko: 'ko_KR', ja: 'ja_JP', pt: 'pt_BR', fr: 'fr_FR', de: 'de_DE', ar: 'ar_AR', it: 'it_IT',
};
export const ogLocale = (locale: Locale): string => OG[locale];
