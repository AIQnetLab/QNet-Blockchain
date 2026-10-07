// The app identities in src/lib/app-links.ts (which the /.well-known files of link.aiqnet.io are built
// from) are the ones the app's build files declare: the one Android applicationId and the iOS
// PRODUCT_BUNDLE_IDENTIFIER. A mismatch would make every QNet Link open in the browser instead of the app.
// The store listings are compared in npm run check:release. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANDROID_PLAY_PACKAGE, IOS_BUNDLE_ID, assetLinks } from '../app-links.ts';

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

test('every iOS build configuration\'s bundle identifier is the one apple-app-site-association names', () => {
  const ids = [...read('ios/QNetMobile.xcodeproj/project.pbxproj').matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)]
    .map((m) => m[1]);
  assert.ok(ids.length >= 2, 'Debug and Release');
  // A test target may carry its own identifier; the app's configurations all carry IOS_BUNDLE_ID.
  const app = ids.filter((id) => !/Tests$/.test(id));
  assert.ok(app.length >= 2);
  for (const id of app) assert.equal(id, IOS_BUNDLE_ID);
});
