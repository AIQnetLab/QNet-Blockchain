// The app's language: lookup with {placeholders}, the language list, right-to-left handling, and the language
// services outside a screen (native prompts, the crash screen) speak in. Strings live in ./locales, one file per
// language, every file with every key (__tests__/I18n.test.js).
import { I18nManager, Platform, Settings } from 'react-native';
import translations from './translations';

// The picker's order; each name is written in its own language.
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
]);

export const DEFAULT_LANGUAGE = 'en';
const RTL = new Set(['ar']);

export const isSupported = (lang) => typeof lang === 'string' && Object.prototype.hasOwnProperty.call(translations, lang);
export const isRTL = (lang) => RTL.has(lang);
export const languageName = (lang) => (LANGUAGES.find((l) => l.code === lang) || LANGUAGES[0]).name;

// Values put into a sentence (addresses, amounts, codes, names) are wrapped in a first-strong isolate in a
// right-to-left language, so a Latin or numeric run keeps its own order inside Arabic text.
const FSI = '\u2068';
const PDI = '\u2069';

export function hasKey(key) {
  return Object.prototype.hasOwnProperty.call(translations.en, key);
}

export function translate(lang, key, params) {
  const table = isSupported(lang) ? translations[lang] : translations[DEFAULT_LANGUAGE];
  let text = table[key];
  if (typeof text !== 'string') text = translations[DEFAULT_LANGUAGE][key];
  if (typeof text !== 'string') return key;
  if (!params) return text;
  const isolate = isRTL(lang);
  return text.replace(/\{(\w+)\}/g, (m, name) => {
    if (params[name] === undefined || params[name] === null) return m;
    const value = String(params[name]);
    return isolate ? `${FSI}${value}${PDI}` : value;
  });
}

/** A translator bound to one language: t(key, params). */
export function makeT(lang) {
  const t = (key, params) => translate(lang, key, params);
  t.lang = isSupported(lang) ? lang : DEFAULT_LANGUAGE;
  t.rtl = isRTL(t.lang);
  return t;
}

// The phone's language as the system names it (`ru_RU`, `zh-Hans-CN`, `pt-BR`), or ''. Android gives it as the locale
// identifier; iOS gives none there (React Native exports only the layout direction), so iOS reads the first of the user's
// preferred languages, which is also the one chosen for this app in its Settings (SD-R3-02).
function systemLocale() {
  if (Platform.OS === 'ios') {
    try {
      const preferred = Settings.get('AppleLanguages');
      const first = Array.isArray(preferred) ? preferred[0] : preferred;
      if (typeof first === 'string' && first) return first;
      const locale = Settings.get('AppleLocale');
      if (typeof locale === 'string' && locale) return locale;
    } catch (_) { /* no settings module: the locale identifier below, else English */ }
  }
  try {
    return String((I18nManager.getConstants && I18nManager.getConstants().localeIdentifier) || '');
  } catch (_) {
    return '';
  }
}

/** The phone's language when the app has one for it, else English (the first start, before a choice). */
export function deviceLanguage() {
  const id = systemLocale();
  const lang = (id.split(/[-_]/)[0] || '').toLowerCase();
  if (lang === 'zh') return 'zh-CN';
  return isSupported(lang) ? lang : DEFAULT_LANGUAGE;
}

// The language of the open screen, for code that runs outside it: native prompt titles, the crash screen.
let current = DEFAULT_LANGUAGE;
const listeners = new Set();

export function setCurrentLanguage(lang) {
  const next = isSupported(lang) ? lang : DEFAULT_LANGUAGE;
  if (next === current) return;
  current = next;
  listeners.forEach((fn) => { try { fn(next); } catch (_) { /* a listener never breaks the switch */ } });
}

export const currentLanguage = () => current;
export const onLanguageChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const tr = (key, params) => translate(current, key, params);

/** The key of an error's own translated text when it carries a known code, else null. */
export function errorKey(err) {
  const code = err && (err.code || (err.name === 'TooManyPendingError' ? 'TOO_MANY_PENDING' : null));
  const key = code ? `err_${code}` : null;
  return key && hasKey(key) ? key : null;
}

/**
 * What to tell the user about a failed operation: the error's own translated text when it carries a known code,
 * else the operation's `fallbackKey`, with the raw detail (a node's or the network's own words) after it.
 */
export function errorText(t, err, fallbackKey) {
  const key = errorKey(err);
  if (key) return t(key, err && err.params);
  const detail = err && typeof err.message === 'string' ? err.message.trim() : (typeof err === 'string' ? err.trim() : '');
  return detail ? `${t(fallbackKey)}\n${t('err_detail', { detail })}` : t(fallbackKey);
}
