// The texts only Android shows, merged over the shared tables by ./translations (Metro takes this file for Android
// and ./overlay.js elsewhere, so no iOS build carries them). Every language has the keys of ./overlays/android/en.
import en from './overlays/android/en';
import zhCN from './overlays/android/zh-CN';
import ru from './overlays/android/ru';
import es from './overlays/android/es';
import ko from './overlays/android/ko';
import ja from './overlays/android/ja';
import pt from './overlays/android/pt';
import fr from './overlays/android/fr';
import de from './overlays/android/de';
import ar from './overlays/android/ar';
import it from './overlays/android/it';

export default { en, 'zh-CN': zhCN, ru, es, ko, ja, pt, fr, de, ar, it };
