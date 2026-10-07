// /.well-known/assetlinks.json and /.well-known/apple-app-site-association (src/lib/app-links.ts): what
// is known is published, what is not is left out. The release check (npm run check:release) is separate.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANDROID_PLAY_CERT_SHA256,
  ANDROID_PLAY_PACKAGE,
  IOS_BUNDLE_ID,
  IOS_TEAM_ID,
  appleAppSiteAssociation,
  assetLinks,
  isFingerprint,
  isTeamId,
  wellKnownResponse,
} from '../app-links.ts';

const SITE_FP = 'F2:17:49:46:C9:7C:9A:3B:AD:3B:16:92:14:95:F3:22:92:E8:5A:05:18:CA:D6:22:98:2B:3E:70:A1:57:CE:59';

// One Android package: the Play-signed file, from Google Play and from aiqnet.io alike (qnet-link-v1.md 14.2).
test('the one Android package is published with the Play app-signing certificate, and no other', () => {
  assert.equal(ANDROID_PLAY_PACKAGE, 'io.aiqnet.wallet');
  const links = assetLinks();
  assert.deepEqual(links.map((s) => s.target.package_name), ANDROID_PLAY_CERT_SHA256 === null ? [] : ['io.aiqnet.wallet']);
  assert.equal(links.some((s) => s.target.package_name === 'com.qnetmobile'), false);
});

test('an unknown Play signing certificate is left out, never guessed', () => {
  const play = assetLinks().find((s) => s.target.package_name === ANDROID_PLAY_PACKAGE);
  if (ANDROID_PLAY_CERT_SHA256 === null) assert.equal(play, undefined);
  else assert.deepEqual(play.target.sha256_cert_fingerprints, [ANDROID_PLAY_CERT_SHA256]);
  const fp = 'AB:'.repeat(31) + 'CD';
  const both = assetLinks([{ package: 'a.b', fingerprint: SITE_FP }, { package: 'c.d', fingerprint: fp }]);
  assert.equal(both.length, 2);
  for (const bad of [null, '', 'ab:'.repeat(31) + 'cd', SITE_FP.replace(/:/g, ''), `${SITE_FP}:00`, ' ' + SITE_FP]) {
    assert.equal(assetLinks([{ package: 'x.y', fingerprint: bad }]).length, 0, String(bad));
  }
});

test('apple-app-site-association: no app until the Team ID is set, then only the /l path', () => {
  if (IOS_TEAM_ID === null) assert.deepEqual(appleAppSiteAssociation(), { applinks: { details: [] } });
  assert.deepEqual(appleAppSiteAssociation('ABCDE12345', IOS_BUNDLE_ID), {
    applinks: {
      details: [{ appIDs: [`ABCDE12345.${IOS_BUNDLE_ID}`], components: [{ '/': '/l', comment: 'QNet Link v1 requests' }] }],
    },
  });
  for (const bad of ['abcde12345', 'ABCDE1234', 'ABCDE123456', 'ABCDE-2345', '']) {
    assert.deepEqual(appleAppSiteAssociation(bad), { applinks: { details: [] } }, bad);
  }
  assert.equal(isTeamId('ABCDE12345'), true);
  assert.equal(isFingerprint(SITE_FP), true);
});

test('both files are served as JSON, 200, without a redirect', async () => {
  const res = wellKnownResponse(assetLinks());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(res.headers.get('location'), null);
  assert.deepEqual(JSON.parse(await res.text()), assetLinks());
});
