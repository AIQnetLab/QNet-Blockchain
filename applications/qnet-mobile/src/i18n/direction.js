/**
 * The layout follows the app's language on Android and iOS: the whole screen right to left in Arabic, left to right in
 * every other language (React Native's I18nManager). The native side reads the direction when the app's root view is
 * made, so a new one shows once the app's JS starts again (DeviceSecurity.reloadApp): at launch by itself, after a change
 * of language when the user asks for it (Settings).
 */
import { I18nManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isRTL, savedLanguage } from './index';
import { reloadApp } from '../services/DeviceSecurity';

// The direction the last launch restarted for; cleared once a launch finds the layout in it.
const RESTART_KEY = 'qnet_layout_restart';
const named = (rtl) => (rtl ? 'rtl' : 'ltr');

/** Stores the direction of `lang` for the next start of the app's JS; true when the running layout already has it. */
export function applyLayoutDirection(lang) {
  const rtl = isRTL(lang);
  I18nManager.allowRTL(rtl);
  I18nManager.forceRTL(rtl);
  return I18nManager.isRTL === rtl;
}

/** Whether the running layout still has the other direction than `lang` (until the app's JS starts again). */
export const layoutLags = (lang) => I18nManager.isRTL !== isRTL(lang);

/**
 * At launch, before the wallet screen: the saved language's direction, and one restart when the running layout has the
 * other one (the first start after an update, a phone whose own language turned the layout). Never twice in a row for
 * the same direction, so a build that cannot turn its layout never restarts in a loop. Resolves true when the screen may
 * be drawn now, false while the restart is under way.
 */
export async function settleLayoutDirection() {
  const lang = await savedLanguage();
  if (applyLayoutDirection(lang)) {
    AsyncStorage.removeItem(RESTART_KEY).catch(() => {});
    return true;
  }
  const want = named(isRTL(lang));
  try {
    if ((await AsyncStorage.getItem(RESTART_KEY)) === want) return true;
    await AsyncStorage.setItem(RESTART_KEY, want);
  } catch (_) {
    return true; // without the mark a restart could repeat: the screen is drawn in the running layout
  }
  if (await reloadApp()) return false;
  // Nothing restarted (no activity in front, no native method): the next launch may try again.
  AsyncStorage.removeItem(RESTART_KEY).catch(() => {});
  return true;
}
