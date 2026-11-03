'use client';

// The page's language in the browser: the root layout hands the provider the shell's texts, a part of the site adds its
// own (I18nArea), both with the page's data. Links and router moves stay in the page's language; only the language
// switcher leaves it, with a full page load, so the whole page, <html lang> included, changes together.

import NextLink, { type LinkProps } from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, forwardRef, useContext, useMemo, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { DEFAULT_LOCALE, splitLocale, type Locale } from '@/lib/languages';
import type { Texts } from '@/lib/texts';
import { makeI18n, type I18n } from './core';

const I18nContext = createContext<I18n | null>(null);

// Whether an English page's address names English (/en/..., a browser that keeps no cookie): its links keep the prefix.
function useNamed(locale: Locale): boolean {
  return locale === DEFAULT_LOCALE && splitLocale(usePathname() ?? '/').locale === DEFAULT_LOCALE;
}

export function I18nProvider({ locale, messages, children }: { locale: Locale; messages: Texts; children: ReactNode }) {
  const named = useNamed(locale);
  const value = useMemo(() => makeI18n(locale, messages, named), [locale, messages, named]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

// A part of the site's texts over the shell's, for the pages below it (src/i18n/area.tsx renders it).
export function I18nArea({ messages, children }: { messages: Texts; children: ReactNode }) {
  const outer = useI18n();
  const named = useNamed(outer.locale);
  const value = useMemo(() => makeI18n(outer.locale, { ...outer.t.catalog, ...messages }, named), [outer, messages, named]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}

export const useT = () => useI18n().t;

// The page's path without its language: the same for /explorer and /ru/explorer.
export function usePath(): string {
  return splitLocale(usePathname() ?? '/').path;
}

type LocaleLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps> & LinkProps & { children?: ReactNode };

// next/link with the page's language put in front of a path on this site.
export const Link = forwardRef<HTMLAnchorElement, LocaleLinkProps>(function Link({ href, ...rest }, ref) {
  const { href: local } = useI18n();
  return <NextLink ref={ref} href={typeof href === 'string' ? local(href) : href} {...rest} />;
});

// The router, moving within the page's language.
export function useLocaleRouter() {
  const router = useRouter();
  const { href } = useI18n();
  return useMemo(() => ({
    push: (path: string) => router.push(href(path)),
    replace: (path: string) => router.replace(href(path)),
    prefetch: (path: string) => router.prefetch(href(path)),
  }), [router, href]);
}
