// The UI languages: one module per language (<code>.js, a frozen default export of key → text), the
// same keys in every one (test/i18n.test.mjs). English (en.js) is the source text; every other table is
// loaded only when chosen. Keys use [A-Za-z0-9_@] only; $1..$9 are substitutions.
import { SUPPORTED_LANGUAGES } from '../../background/config.js';

// Each language's name in itself: shown the same whatever language the UI is in.
export const LANGUAGE_NAMES = Object.freeze({
  en: 'English',
  'zh-CN': '简体中文',
  ru: 'Русский',
  es: 'Español',
  ko: '한국어',
  ja: '日本語',
  pt: 'Português',
  fr: 'Français',
  de: 'Deutsch',
  ar: 'العربية',
  it: 'Italiano',
});

// Literal specifiers, so scripts/extension.mjs sees every table as loaded.
const LOADERS = Object.freeze({
  en: () => import('./en.js'),
  'zh-CN': () => import('./zh-CN.js'),
  ru: () => import('./ru.js'),
  es: () => import('./es.js'),
  ko: () => import('./ko.js'),
  ja: () => import('./ja.js'),
  pt: () => import('./pt.js'),
  fr: () => import('./fr.js'),
  de: () => import('./de.js'),
  ar: () => import('./ar.js'),
  it: () => import('./it.js'),
});

/**
 * The text table of a SUPPORTED_LANGUAGES code.
 * @param {string} code
 * @returns {Promise<Readonly<Record<string, string>>>}
 * @throws {Error} for any other code
 */
export async function loadMessages(code) {
  if (!SUPPORTED_LANGUAGES.includes(code) || !Object.hasOwn(LOADERS, code)) throw new Error('unsupported language');
  return (await LOADERS[code]()).default;
}
