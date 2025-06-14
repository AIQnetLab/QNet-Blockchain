import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import all language files - ordered by crypto community size
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import es from './locales/es.json';
import ru from './locales/ru.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import de from './locales/de.json';
import fr from './locales/fr.json';
import pt from './locales/pt.json';
import it from './locales/it.json';
import ar from './locales/ar.json';

// Language configuration - ordered by crypto community size
export const SUPPORTED_LANGUAGES = {
  en: { name: 'English', nativeName: 'English', flag: '🇺🇸' },
  'zh-CN': { name: 'Chinese (Simplified)', nativeName: '简体中文', flag: '🇨🇳' },
  es: { name: 'Spanish', nativeName: 'Español', flag: '🇪🇸' },
  ru: { name: 'Russian', nativeName: 'Русский', flag: '🇷🇺' },
  ja: { name: 'Japanese', nativeName: '日本語', flag: '🇯🇵' },
  ko: { name: 'Korean', nativeName: '한국어', flag: '🇰🇷' },
  de: { name: 'German', nativeName: 'Deutsch', flag: '🇩🇪' },
  fr: { name: 'French', nativeName: 'Français', flag: '🇫🇷' },
  pt: { name: 'Portuguese', nativeName: 'Português', flag: '🇧🇷' },
  it: { name: 'Italian', nativeName: 'Italiano', flag: '🇮🇹' },
  ar: { name: 'Arabic', nativeName: 'العربية', flag: '🇸🇦' }
};

// Initialize i18next
i18next
  .use(LanguageDetector)
  .init({
    fallbackLng: 'en',
    debug: false,
    
    // Language detection options
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: 'qnet-wallet-language'
    },
    
    // Resources - ordered by crypto community size
    resources: {
      en: { translation: en },
      'zh-CN': { translation: zhCN },
      es: { translation: es },
      ru: { translation: ru },
      ja: { translation: ja },
      ko: { translation: ko },
      de: { translation: de },
      fr: { translation: fr },
      pt: { translation: pt },
      it: { translation: it },
      ar: { translation: ar }
    },
    
    // Interpolation options
    interpolation: {
      escapeValue: false // React already escapes values
    },
    
    // Key separator
    keySeparator: '.',
    nsSeparator: false
  });

// Translation helper function
export const t = (key, options = {}) => {
  return i18next.t(key, options);
};

// Change language function
export const changeLanguage = (language) => {
  return i18next.changeLanguage(language);
};

// Get current language
export const getCurrentLanguage = () => {
  return i18next.language;
};

// Get language direction (for RTL languages)
export const getLanguageDirection = (language = null) => {
  const lang = language || getCurrentLanguage();
  const rtlLanguages = ['ar', 'he', 'fa', 'ur'];
  return rtlLanguages.includes(lang) ? 'rtl' : 'ltr';
};

// Format currency based on locale
export const formatCurrency = (amount, currency = 'QNC', language = null) => {
  const lang = language || getCurrentLanguage();
  
  try {
    const formatter = new Intl.NumberFormat(lang, {
      style: 'decimal',
      minimumFractionDigits: 2,
      maximumFractionDigits: 8
    });
    
    return `${formatter.format(amount)} ${currency}`;
  } catch (error) {
    // Fallback to English formatting
    return `${amount.toFixed(8)} ${currency}`;
  }
};

// Format date based on locale
export const formatDate = (date, language = null) => {
  const lang = language || getCurrentLanguage();
  
  try {
    return new Intl.DateTimeFormat(lang, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(date));
  } catch (error) {
    // Fallback to ISO string
    return new Date(date).toISOString();
  }
};

// Format number based on locale
export const formatNumber = (number, language = null) => {
  const lang = language || getCurrentLanguage();
  
  try {
    return new Intl.NumberFormat(lang).format(number);
  } catch (error) {
    return number.toString();
  }
};

// Language change event listener
export const onLanguageChange = (callback) => {
  i18next.on('languageChanged', callback);
};

// Remove language change listener
export const offLanguageChange = (callback) => {
  i18next.off('languageChanged', callback);
};

export default i18next; 