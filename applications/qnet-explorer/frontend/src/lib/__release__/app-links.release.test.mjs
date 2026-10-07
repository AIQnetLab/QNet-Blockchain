// Release checklist for the app links (npm run check:release, not part of npm run test:wallet): fails
// until every app identity in src/lib/app-links.ts is set, so a store release cannot ship a
// /.well-known file that leaves an app out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANDROID_PLAY_PACKAGE, IOS_BUNDLE_ID, appleAppSiteAssociation, assetLinks, releaseGaps } from '../app-links.ts';

test('every app that opens link.aiqnet.io/l links is published', () => {
  assert.deepEqual(releaseGaps(), [], `missing: ${releaseGaps().join('; ')}`);
  assert.ok(assetLinks().some((s) => s.target.package_name === ANDROID_PLAY_PACKAGE));
  assert.equal(appleAppSiteAssociation().applinks.details.length, 1);
});

// The store records are created from the listing files: an App Store record under another bundle ID
// than the Xcode project and apple-app-site-association would leave link.aiqnet.io unverified for the
// shipped app (the build files themselves are compared in npm run test:wallet, app-identity.test.mjs).
test('the store listings name the identities the site publishes', () => {
  const listing = (file) => readFileSync(new URL(`../../../../../qnet-mobile/store-listing/${file}`, import.meta.url), 'utf8');
  const bundle = /Bundle ID:\s*([A-Za-z0-9.-]+)/.exec(listing('app-store-listing.txt'))?.[1];
  assert.equal(bundle, IOS_BUNDLE_ID, 'app-store-listing.txt Bundle ID');
  assert.match(listing('README.md'), new RegExp(`package,? \`${ANDROID_PLAY_PACKAGE.replace(/\./g, '\\.')}\``), 'the Play build package');
});
