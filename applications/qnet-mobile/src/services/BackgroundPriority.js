/**
 * How much the system lets QNet Wallet run in the background: the Node tab's "Background" row; it never leaves the
 * device (docs: mobile-wallet "Background priority on Android and iOS").
 * The node answers in the background with no notification, at the highest priority each system lets an app have without
 * one; the same question and the same texts on every phone and tablet. `priority`:
 * - 'unrestricted': Android, the user exempted the app from battery optimization and did not restrict its background
 *   activity; iOS, Background App Refresh is on for it.
 * - 'restricted': otherwise. `changeable` when the user can change it in the system settings: always on Android; on iOS
 *   not when a profile or a parental control turned Background App Refresh off.
 * - null: this build cannot tell (no native module, an error).
 * Nothing here asks the user anything, needs a permission or shows a notification; nothing counts by what it reports.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import BackgroundFetch from 'react-native-background-fetch';
import { Linking, NativeModules, Platform } from 'react-native';

// The last Background App Refresh status a configure or a return to the app read (iOS rejects the configure with it):
// what readBackground answers when the status cannot be read now.
export const BG_REFRESH_STATUS_KEY = 'qnet_bg_refresh_status';

// Android's app standby buckets by their system values; any other value is reported as its number.
const BUCKETS = { 5: 'exempted', 10: 'active', 20: 'working_set', 30: 'frequent', 40: 'rare', 45: 'restricted', 50: 'never' };
// The buckets in which the system holds the app's background work back the most.
const HELD_BUCKETS = new Set(['rare', 'restricted', 'never']);
// iOS's Background App Refresh status (UIApplication.backgroundRefreshStatus).
const REFRESH = { 0: 'restricted', 1: 'denied', 2: 'available' };

// A read of the system's state never holds a wake up longer than this.
export const BG_READ_MS = 1000;

const within = (promise) => {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), BG_READ_MS); });
  return Promise.race([Promise.resolve(promise).catch(() => null), late]).finally(() => clearTimeout(timer));
};
const bool = (v) => (typeof v === 'boolean' ? v : null);

/** Android's state (`QNetBackground.state`: { exempt, bucket, userRestricted }) as readBackground answers it. */
export function androidPriority(s) {
  if (!s || typeof s !== 'object') return null;
  const exempt = bool(s.exempt);
  const userRestricted = bool(s.userRestricted);
  const bucket = Number.isSafeInteger(s.bucket) ? (BUCKETS[s.bucket] || String(s.bucket)) : null;
  if (exempt === null) return null;
  const restricted = !exempt || userRestricted === true || HELD_BUCKETS.has(bucket);
  return { priority: restricted ? 'restricted' : 'unrestricted', changeable: true, exempt, bucket, userRestricted, refresh: null };
}

/** iOS's Background App Refresh status (0, 1, 2) as readBackground answers it. */
export function iosPriority(status) {
  const refresh = REFRESH[status] || null;
  if (!refresh) return null;
  return {
    priority: refresh === 'available' ? 'unrestricted' : 'restricted', changeable: refresh !== 'restricted',
    exempt: null, bucket: null, userRestricted: null, refresh,
  };
}

/** { priority, changeable, exempt, bucket, userRestricted, refresh } now, or null when this build cannot tell. */
export async function readBackground() {
  try {
    if (Platform.OS === 'android') {
      const native = NativeModules.QNetBackground;
      if (!native || typeof native.state !== 'function') return null;
      return androidPriority(await within(native.state()));
    }
    if (Platform.OS === 'ios') {
      const now = await within(BackgroundFetch.status());
      if (REFRESH[now]) return iosPriority(now);
      const kept = await AsyncStorage.getItem(BG_REFRESH_STATUS_KEY);
      return iosPriority(kept === null ? null : Number(kept));
    }
  } catch (_) { /* cannot tell */ }
  return null;
}

/**
 * Opens the system settings where the user gives the app its background priority: on Android the app's own page (its
 * battery use is set there), through the native module; on iOS the app's page in Settings (Background App Refresh).
 * True when a page opened.
 */
export async function openBackgroundSettings() {
  try {
    const native = NativeModules.QNetBackground;
    if (Platform.OS === 'android' && native && typeof native.openSettings === 'function') {
      if ((await native.openSettings()) === true) return true;
    }
    await Linking.openSettings();
    return true;
  } catch (_) {
    return false;
  }
}

export default { readBackground, openBackgroundSettings, androidPriority, iosPriority };
