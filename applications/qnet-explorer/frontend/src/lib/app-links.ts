// Which apps may open https://link.aiqnet.io/l links (QNet Link v1, docs/protocols/qnet-link-v1.md
// section 4): the Android Digital Asset Links statement and the iOS apple-app-site-association file,
// both served from /.well-known on link.aiqnet.io (and on aiqnet.io, where nothing claims them). An app
// whose signing identity is not known yet is left out, never guessed: `npm run check:release` fails
// until every value below is set.

const FINGERPRINT_RE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;

// The one Android package (docs/protocols/qnet-link-v1.md section 14.2): Google Play signs it with its app-signing
// key, and aiqnet.io hands out that same Play-signed file. This SHA-256 is the one the Play Console shows under Test
// and release > App integrity (classic key). A build signed with the upload key for local testing is not listed:
// the site's Android button names the package, which opens it without the association.
export const ANDROID_PLAY_PACKAGE = 'io.aiqnet.wallet';
// The live Google Play listing of that package (owner, 05.10: accepted into the store).
export const ANDROID_PLAY_URL = `https://play.google.com/store/apps/details?id=${ANDROID_PLAY_PACKAGE}`;
export const ANDROID_PLAY_CERT_SHA256: string | null = '2A:A5:A0:B0:40:DD:D2:50:3A:EA:28:BC:AC:8D:47:89:24:7D:8A:E4:7A:20:B4:9B:6A:C6:B1:E1:BE:7D:D0:4A';

// iOS: the Apple Developer Team ID of Orrery Group LLC.
export const IOS_TEAM_ID: string | null = '33H36C42XS';
export const IOS_BUNDLE_ID = 'com.qnetmobile';

// The only path the apps handle; the data is in the fragment.
export const LINK_PATH = '/l';

export const isFingerprint = (value: unknown): value is string => typeof value === 'string' && FINGERPRINT_RE.test(value);
export const isTeamId = (value: unknown): value is string => typeof value === 'string' && TEAM_ID_RE.test(value);

interface AndroidApp {
  package: string;
  fingerprint: string | null;
}

export function assetLinks(apps: AndroidApp[] = [
  { package: ANDROID_PLAY_PACKAGE, fingerprint: ANDROID_PLAY_CERT_SHA256 },
]): object[] {
  return apps
    .filter((app): app is { package: string; fingerprint: string } => isFingerprint(app.fingerprint))
    .map((app) => ({
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: app.package, sha256_cert_fingerprints: [app.fingerprint] },
    }));
}

export function appleAppSiteAssociation(teamId: string | null = IOS_TEAM_ID, bundleId: string = IOS_BUNDLE_ID): object {
  const details = isTeamId(teamId)
    ? [{ appIDs: [`${teamId}.${bundleId}`], components: [{ '/': LINK_PATH, comment: 'QNet Link v1 requests' }] }]
    : [];
  return { applinks: { details } };
}

// What a store release still needs; empty when nothing is missing.
export function releaseGaps(): string[] {
  const gaps: string[] = [];
  if (!isFingerprint(ANDROID_PLAY_CERT_SHA256)) gaps.push(`${ANDROID_PLAY_PACKAGE}: Google Play app-signing certificate SHA-256`);
  if (!isTeamId(IOS_TEAM_ID)) gaps.push(`${IOS_BUNDLE_ID}: Apple Team ID`);
  return gaps;
}

// Both files are JSON, served as such, never redirected and cacheable for an hour.
export function wellKnownResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' },
  });
}
