// Every language's catalog, for the server (getI18n, metadata) and the tests. The browser gets only its page's texts of
// one, as data (src/i18n/areas.ts), so no client component imports this module.

import type { Locale } from '../lib/languages.ts';
import type { Catalog } from '../lib/texts.ts';
import en from './locales/en.ts';
import zhCN from './locales/zh-CN.ts';
import ru from './locales/ru.ts';
import es from './locales/es.ts';
import ko from './locales/ko.ts';
import ja from './locales/ja.ts';
import pt from './locales/pt.ts';
import fr from './locales/fr.ts';
import de from './locales/de.ts';
import ar from './locales/ar.ts';
import it from './locales/it.ts';

export const CATALOGS: Readonly<Record<Locale, Catalog>> = { en, 'zh-CN': zhCN, ru, es, ko, ja, pt, fr, de, ar, it };
