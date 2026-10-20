// Which store a device installs QNet Wallet from: iPhone and iPad from the App Store (TestFlight until the listing is
// live), Android from Google Play, anything else from the page that lists every way (/wallet#get). An iPad in desktop
// mode reports a Mac user agent; only the page, which sees its touch points, can tell (maxTouchPoints).

import { ANDROID_PLAY_URL, IOS_INSTALL_URL } from './app-links.ts';

export type InstallTarget = 'ios' | 'android' | 'desktop';

export const GET_PAGE_PATH = '/wallet#get';

export function installTarget(userAgent: string | null | undefined, maxTouchPoints = 0): InstallTarget {
  const ua = String(userAgent || '');
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/macintosh/i.test(ua) && maxTouchPoints > 1) return 'ios';
  return 'desktop';
}

/** The store page for a phone or tablet, or null for a computer (it gets the page with every way). */
export function storeUrl(target: InstallTarget): string | null {
  if (target === 'ios') return IOS_INSTALL_URL;
  if (target === 'android') return ANDROID_PLAY_URL;
  return null;
}
