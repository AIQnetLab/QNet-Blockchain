// The app identities in src/lib/app-links.ts (which the /.well-known files of link.aiqnet.io are built
// from) are the ones the app's build files declare: the one Android applicationId and the iOS
// PRODUCT_BUNDLE_IDENTIFIER. A mismatch would make every QNet Link open in the browser instead of the app.
// The store listings are compared in npm run check:release. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANDROID_PLAY_PACKAGE, IOS_BUNDLE_ID, LINK_PATH, TRANSFER_PATH, appleAppSiteAssociation, assetLinks } from '../app-links.ts';
import { LINK_HOST } from '../hosts.ts';

const MOBILE = new URL('../../../../../qnet-mobile/', import.meta.url);
const read = (path) => readFileSync(new URL(path, MOBILE), 'utf8');

// One package: the Play-signed file from Google Play is the file aiqnet.io serves (qnet-link-v1.md section 14.2).
// The one other id is the old app's last release that asks its users to move (-PqnetLegacyMove), which the
// association never names: QNet Link opens only the new app.
test('the Android applicationId is the one package the Digital Asset Links statement names', () => {
  const gradle = read('android/app/build.gradle');
  const ids = [...gradle.matchAll(/\bapplicationId\s+(?:"([^"]+)"|legacyMove \? "([^"]+)" : "([^"]+)")\s*$/gm)];
  assert.equal(ids.length, 1);
  const [, plain, legacy, regular] = ids[0];
  assert.equal(plain ?? regular, ANDROID_PLAY_PACKAGE);
  if (legacy !== undefined) {
    assert.equal(legacy, 'com.qnetmobile');
    assert.match(gradle, /def legacyMove = project\.hasProperty\("qnetLegacyMove"\)/);
  }
  assert.deepEqual(assetLinks().map((a) => a.target.package_name), [ANDROID_PLAY_PACKAGE]);
  assert.doesNotMatch(gradle, /productFlavors/);
});

// The paths the association covers are the ones QNet Wallet takes: its one verified Android filter on link.aiqnet.io
// (the site's intent: URL reaches the app through it too), its iOS associated domain and its two readers. A published
// path the filter lacks would leave the payment address's Android button on the fallback page.
test('the paths apple-app-site-association lists are the ones the app\'s verified filter and readers take', () => {
  const paths = appleAppSiteAssociation('ABCDE12345', IOS_BUNDLE_ID).applinks.details[0].components.map((c) => c['/']);
  assert.deepEqual(paths, [LINK_PATH, TRANSFER_PATH]);
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const verified = [...manifest.matchAll(/<intent-filter android:autoVerify="true">([\s\S]*?)<\/intent-filter>/g)].map((m) => m[1]);
  assert.equal(verified.length, 1);
  const data = [...verified[0].matchAll(/<data ([^>]*?)\/>/g)]
    .map((m) => Object.fromEntries([...m[1].matchAll(/android:(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])));
  assert.deepEqual([...new Set(data.map((d) => d.host).filter(Boolean))], [LINK_HOST]);
  assert.deepEqual(data.map((d) => d.path).filter(Boolean).sort(), [...paths].sort());
  assert.match(read('ios/QNetMobile/QNetMobile.entitlements'), /<string>applinks:link\.aiqnet\.io<\/string>/);
  assert.match(read('src/services/QNetLink.js'), /PREFIX: 'https:\/\/link\.aiqnet\.io\/l#v1\.'/);
  assert.match(read('src/services/transferLink.js'), /const TRANSFER_PATH = 'https:\/\/link\.aiqnet\.io\/send';/);
});

test('every iOS build configuration\'s bundle identifier is the one apple-app-site-association names', () => {
  const ids = [...read('ios/QNetMobile.xcodeproj/project.pbxproj').matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)]
    .map((m) => m[1]);
  assert.ok(ids.length >= 2, 'Debug and Release');
  // A test target may carry its own identifier; the app's configurations all carry IOS_BUNDLE_ID.
  const app = ids.filter((id) => !/Tests$/.test(id));
  assert.ok(app.length >= 2);
  for (const id of app) assert.equal(id, IOS_BUNDLE_ID);
});
