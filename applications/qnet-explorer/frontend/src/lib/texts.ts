// The site's texts: one catalog per language in src/i18n/locales, English the source whose keys every other catalog
// has. A page reads them through its language's translator (src/i18n: useI18n in the browser, getI18n on the server);
// amounts and counts keep one format in every language. Server and client code import this module, which loads no
// catalog itself: the browser gets only its page's language.

import type en from '../i18n/locales/en.ts';
import { isRtl, type Locale } from './languages.ts';

export type MessageKey = keyof typeof en;
export type Catalog = Readonly<Record<MessageKey, string>>;
// The part of a catalog the browser holds: the shell's texts and the page's area's (src/i18n/areas.ts).
export type Texts = Partial<Catalog>;
export type Vars = Record<string, string | number>;

// A value set into a right-to-left sentence keeps its own order (an address, an amount, a name): first-strong isolate.
const FSI = '\u2068';
const PDI = '\u2069';

// {name} placeholders, filled from `vars`; a placeholder without a value stays as written.
export function format(template: string, vars: Vars = {}, isolate = false): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return whole;
    return isolate ? `${FSI}${vars[name]}${PDI}` : String(vars[name]);
  });
}

// A translator bound to one language: t(key, vars), with the language it speaks.
export interface T {
  (key: MessageKey, vars?: Vars): string;
  readonly locale: Locale;
  readonly rtl: boolean;
  readonly catalog: Texts;
}

// Every catalog has every key (its type and src/lib/__tests__/i18n-catalogs.test.mjs), and every page's texts every key
// its client modules look up (the same test); a key that is none shows as the key itself.
export function translator(locale: Locale, catalog: Texts): T {
  const rtl = isRtl(locale);
  const t = (key: MessageKey, vars?: Vars) => format(catalog[key] ?? key, vars, rtl);
  return Object.assign(t, { locale, rtl, catalog });
}

const NUMBERS = new Intl.NumberFormat('en');

// A count or an amount as the texts write it in every language: 1,234.5.
export function number(value: number | bigint): string {
  return NUMBERS.format(value);
}

// A text as its runs and its {name} slots, for a sentence that holds a link.
export function templateParts(template: string): (string | { name: string })[] {
  return template.split(/\{(\w+)\}/).map((part, i) => (i % 2 === 1 ? { name: part } : part)).filter((part) => part !== '');
}

// The product names the texts keep as written in every language.
export const PRODUCT_NAMES = ['QNet Blockchain', 'QNet Wallet', 'QNet Link'] as const;
const PRODUCT_NAME_RE = new RegExp(`(${PRODUCT_NAMES.join('|')})`);

// A text as its runs and the product names in it, so a page can keep each name out of a browser's page translation
// (src/lib/rich.tsx named).
export function nameParts(text: string): (string | { product: string })[] {
  return text.split(PRODUCT_NAME_RE).map((part, i) => (i % 2 === 1 ? { product: part } : part)).filter((part) => part !== '');
}

// A page title: its parts, then the site's name.
export function pageTitle(t: T, ...parts: MessageKey[]): string {
  return [...parts.map((k) => t(k)), 'QNet Blockchain'].join(' - ');
}
