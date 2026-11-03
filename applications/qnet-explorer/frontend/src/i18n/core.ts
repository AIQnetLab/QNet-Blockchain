// A page's language as one object: its code and direction, the translator (`t`, a string, for attributes and code; `say`,
// the same text as the page shows it), sentences with elements in them, and the address of a page of this site in that
// language. The browser gets it from useI18n, a server component from getI18n.

import { isRtl, localePath, type Locale } from '../lib/languages.ts';
import { richOf, sayOf, type Rich, type Say } from '../lib/rich.tsx';
import { translator, type T, type Texts } from '../lib/texts.ts';

export interface I18n {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: T;
  say: Say;
  rich: Rich;
  href: (path: string) => string;
}

// `named`: the page's address names its language although it is English (/en/...), so its links keep that prefix.
export function makeI18n(locale: Locale, catalog: Texts, named = false): I18n {
  const t = translator(locale, catalog);
  return { locale, dir: isRtl(locale) ? 'rtl' : 'ltr', t, say: sayOf(t), rich: richOf(t), href: (path) => localePath(locale, path, named) };
}
