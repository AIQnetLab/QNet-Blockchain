// WALLET_APK_URL: where the wallet page offers QNet Wallet's Android file (owner decision 26.09: one Android package,
// io.aiqnet.wallet; the file the site offers is the same Play-signed build as Google Play, and the app does not
// update itself, so the site offers the newest file). Unset, or not an https address of an .apk file, means the site
// offers no file yet. Read per request, so setting it needs a restart, not a build.
//
// A GitHub release file must be one fixed release (docs/applications/mobile-wallet.md): the older Android build's move
// release owns the tag pattern `wallet-<x.y.z>-<n>` and the asset name `QNet-Wallet.apk`, which the 1.1.7 site APK's
// update check takes, so an address with either, or a `releases/latest` one that could resolve to it, offers no file.

export const WALLET_APK_ENV = 'WALLET_APK_URL';

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const RELEASE_PATH = /^\/[^/]+\/[^/]+\/releases(?:\/|$)/i;
const FIXED_RELEASE_FILE = /^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/([^/]+)$/;
const MOVE_TAG = /^wallet-\d+\.\d+\.\d+-\d+$/i;
const MOVE_ASSET = 'qnet-wallet.apk';

function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export function walletApkUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[WALLET_APK_ENV];
  if (typeof raw !== 'string' || raw === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') return null;
  if (!/\.apk$/i.test(url.pathname)) return null;
  if (GITHUB_HOSTS.has(url.hostname) && RELEASE_PATH.test(url.pathname)) {
    const file = FIXED_RELEASE_FILE.exec(url.pathname);
    const tag = file ? decoded(file[1]) : null;
    const asset = file ? decoded(file[2]) : null;
    if (tag === null || asset === null || tag.toLowerCase() === 'latest' || MOVE_TAG.test(tag) || asset.toLowerCase() === MOVE_ASSET) return null;
  }
  return url.href;
}
