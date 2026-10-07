// The old Android package's last update only (android/app/build.gradle -PqnetLegacyMove, metro.legacy.config.js takes
// this file in place of ./overlay.android.js): Android's own texts and the move notice. No other build carries the
// notice, its site link or its texts (scripts/bundle-check.js refuses them in the io.aiqnet.wallet and iOS bundles).
import android from './overlay.android';
import en from './overlays/legacy/en';
import zhCN from './overlays/legacy/zh-CN';
import ru from './overlays/legacy/ru';
import es from './overlays/legacy/es';
import ko from './overlays/legacy/ko';
import ja from './overlays/legacy/ja';
import pt from './overlays/legacy/pt';
import fr from './overlays/legacy/fr';
import de from './overlays/legacy/de';
import ar from './overlays/legacy/ar';
import it from './overlays/legacy/it';

const legacy = { en, 'zh-CN': zhCN, ru, es, ko, ja, pt, fr, de, ar, it };

export default Object.fromEntries(Object.entries(android).map(([lang, table]) => [lang, { ...table, ...legacy[lang] }]));
