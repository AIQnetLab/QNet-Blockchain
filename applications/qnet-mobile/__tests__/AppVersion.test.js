const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

it('one app version across package.json, package-lock, Android and iOS', () => {
  const version = JSON.parse(read('package.json')).version;
  const lock = JSON.parse(read('package-lock.json'));
  expect(lock.version).toBe(version);
  expect(lock.packages[''].version).toBe(version);

  const gradle = read('android/app/build.gradle');
  expect(gradle).toMatch(new RegExp(`versionName "${version.replace(/\./g, '\\.')}"`));
  const code = /versionCode (\d+)/.exec(gradle)[1];

  const pbx = read('ios/QNetMobile.xcodeproj/project.pbxproj');
  const marketing = [...pbx.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1]);
  const builds = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/g)].map((m) => m[1]);
  expect(marketing.length).toBeGreaterThan(0);
  marketing.forEach((v) => expect(v).toBe(version));
  builds.forEach((b) => expect(b).toBe(code));
});
