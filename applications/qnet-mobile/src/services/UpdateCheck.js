import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORE, APP_VERSION_CODE } from '../config/store';

// The APK installed from outside Google Play updates itself from GitHub Releases: each wallet release is tagged
// `wallet-<versionName>-<versionCode>` and carries QNet-Wallet.apk. Google Play and the App Store update their
// own builds, so only the site flavor asks.
export const RELEASES_URL = 'https://api.github.com/repos/AIQnetLab/QNet-Blockchain/releases?per_page=30';
export const RELEASE_TAG = /^wallet-(\d+\.\d+\.\d+)-(\d+)$/;
export const APK_ASSET = 'QNet-Wallet.apk';
const CHECKED_AT_KEY = 'qnet_update_checked_at';
const DISMISSED_KEY = 'qnet_update_dismissed_code';
const CACHE_KEY = 'qnet_update_cache'; // { etag, latest } — a 304 answer reuses it and spends no API quota
const CHECK_EVERY_MS = 12 * 3600_000;

// The newest published wallet release with an APK, or null.
export function pickLatestWalletRelease(releases) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || r.prerelease) continue;
    const m = RELEASE_TAG.exec(r.tag_name || '');
    if (!m) continue;
    const asset = (r.assets || []).find((a) => a && a.name === APK_ASSET && a.browser_download_url);
    if (!asset) continue;
    const versionCode = Number(m[2]);
    if (!best || versionCode > best.versionCode) {
      best = { versionName: m[1], versionCode, url: asset.browser_download_url, page: r.html_url || '' };
    }
  }
  return best;
}

// { status: 'update', release } when a newer release exists; 'current' when the list was read and nothing in
// it is newer; 'failed' when GitHub could not be read; 'skipped' when this build does not check or it is too
// soon. Without `force` it asks at most every 12 hours — failures included — and stays quiet about a version the
// user set aside.
export async function checkForUpdate({ force = false, installedCode = APP_VERSION_CODE, store = STORE } = {}) {
  if (store !== 'site' || !installedCode) return { status: 'skipped' };
  try {
    if (!force) {
      const last = Number(await AsyncStorage.getItem(CHECKED_AT_KEY)) || 0;
      if (Date.now() - last < CHECK_EVERY_MS) return { status: 'skipped' };
    }
    await AsyncStorage.setItem(CHECKED_AT_KEY, String(Date.now()));

    let cache = null;
    try { cache = JSON.parse((await AsyncStorage.getItem(CACHE_KEY)) || 'null'); } catch (_) { cache = null; }
    const headers = { Accept: 'application/vnd.github+json' };
    if (cache && cache.etag) headers['If-None-Match'] = cache.etag;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let latest;
    try {
      const res = await fetch(RELEASES_URL, { headers, signal: controller.signal });
      if (res.status === 304 && cache) {
        latest = cache.latest || null;
      } else if (res.ok) {
        latest = pickLatestWalletRelease(await res.json());
        const etag = res.headers && res.headers.get ? res.headers.get('etag') : null;
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ etag, latest }));
      } else {
        return { status: 'failed' };
      }
    } finally {
      clearTimeout(timer);
    }

    if (!latest || latest.versionCode <= installedCode) return { status: 'current' };
    if (!force && Number(await AsyncStorage.getItem(DISMISSED_KEY)) === latest.versionCode) return { status: 'skipped' };
    return { status: 'update', release: latest };
  } catch (_) {
    return { status: 'failed' }; // offline, timed out or rate-limited
  }
}

export async function dismissUpdate(versionCode) {
  try { await AsyncStorage.setItem(DISMISSED_KEY, String(versionCode)); } catch (_) { /* best effort */ }
}
