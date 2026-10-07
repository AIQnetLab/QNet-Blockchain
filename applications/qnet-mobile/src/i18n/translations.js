// UI strings for every supported language, one file per language in ./locales (English is the source). Kept out
// of the screens so they carry behaviour only; src/i18n/index.js looks them up and fills their {placeholders}.
// ./overlay adds the few texts of one platform (Android's name Google Play); on iOS it adds nothing.
import en from './locales/en';
import zhCN from './locales/zh-CN';
import ru from './locales/ru';
import es from './locales/es';
import ko from './locales/ko';
import ja from './locales/ja';
import pt from './locales/pt';
import fr from './locales/fr';
import de from './locales/de';
import ar from './locales/ar';
import it from './locales/it';
import overlay from './overlay';

const shared = { en, 'zh-CN': zhCN, ru, es, ko, ja, pt, fr, de, ar, it };

const translations = Object.fromEntries(
  Object.entries(shared).map(([lang, table]) => [lang, { ...table, ...overlay[lang] }]),
);

export default translations;
