/**
 * QNet Wallet names its build on every request to aiqnet.io and the genesis nodes (src/utils/clientAgent.js), so what
 * reaches them can be tied to a build: User-Agent "QNetWallet/<version> (<build>; <platform> <system version>)", set
 * once on React Native's XMLHttpRequest, which fetch is built on; no other host gets it, and nothing tells devices apart.
 */
const fs = require('fs');
const path = require('path');
const { clientAgent, installClientAgent, namesItselfTo } = require('../src/utils/clientAgent');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// React Native's XMLHttpRequest as far as the agent touches it: open, setRequestHeader, send.
function fakeXhr() {
  return class Xhr {
    open(method, url) { this.url = url; this.headers = {}; }
    setRequestHeader(name, value) { this.headers[name.toLowerCase()] = value; }
    send() { Xhr.sent.push({ url: this.url, headers: this.headers }); }
  };
}
const request = (Xhr, url) => { const x = new Xhr(); x.open('GET', url); x.setRequestHeader('Accept', 'application/json'); x.send(); };

it('names the version, the build and the platform, from the native build constants', () => {
  expect(clientAgent({ version: '1.3.1', build: '31' }, { OS: 'android', Version: 28 })).toBe('QNetWallet/1.3.1 (31; android 28)');
  expect(clientAgent({ version: '1.3.1', build: '31' }, { OS: 'ios', Version: '18.2' })).toBe('QNetWallet/1.3.1 (31; ios 18.2)');
  // No build constants (an older native build, the tests): no header at all, never a made-up one.
  expect(clientAgent(undefined, { OS: 'android', Version: 28 })).toBe(null);
  expect(clientAgent({ version: '', build: '31' }, { OS: 'android', Version: 28 })).toBe(null);
  expect(clientAgent({ version: '1.3.1 (x)', build: '31' }, { OS: 'android', Version: 28 })).toBe(null);
});

it('goes to aiqnet.io and the five genesis names only, on every request there, fetch included', () => {
  const Xhr = fakeXhr();
  Xhr.sent = [];
  expect(installClientAgent(Xhr, 'QNetWallet/1.3.1 (31; android 28)')).toBe(true);
  expect(installClientAgent(Xhr, 'QNetWallet/9 (9; android 1)')).toBe(false); // once
  for (const url of [
    'https://aiqnet.io/api/link/sessions/abc', 'https://aiqnet.io/api/cabinet/register', 'https://AIQNET.io/x',
    'https://node1.aiqnet.io/api/v1/light-node/status', 'https://node5.aiqnet.io',
  ]) {
    request(Xhr, url);
  }
  for (const url of [
    'https://api.devnet.solana.com', 'https://link.aiqnet.io/l', 'https://aiqnet.io.example.com/x', 'http://aiqnet.io/x',
    'https://aiqnet.io:8443/x', 'https://node6.aiqnet.io/x', 'https://user@aiqnet.io/x',
  ]) {
    request(Xhr, url);
  }
  const named = Xhr.sent.filter((s) => s.headers['user-agent']).map((s) => s.url);
  expect(named).toEqual(['https://aiqnet.io/api/link/sessions/abc', 'https://aiqnet.io/api/cabinet/register', 'https://AIQNET.io/x',
    'https://node1.aiqnet.io/api/v1/light-node/status', 'https://node5.aiqnet.io']);
  expect(Xhr.sent[0].headers).toEqual({ accept: 'application/json', 'user-agent': 'QNetWallet/1.3.1 (31; android 28)' });
  expect(namesItselfTo(null)).toBe(false);
  // React Native's fetch is whatwg-fetch over the global XMLHttpRequest: the one place covers both.
  expect(read('node_modules/react-native/Libraries/Network/fetch.js')).toMatch(/require\('whatwg-fetch'\)/);
  expect(fs.readFileSync(require.resolve('whatwg-fetch'), 'utf8')).toMatch(/new XMLHttpRequest\(\)/);
});

it('is installed before anything runs, background wakes included; the native build gives the version and build', () => {
  const index = read('index.js');
  expect(index).toMatch(/import \{ installClientAgent \} from '\.\/src\/utils\/clientAgent';\s*\/\/[^\n]*\ninstallClientAgent\(\);/);
  expect(index.indexOf('installClientAgent();')).toBeLessThan(index.indexOf('setBackgroundMessageHandler'));
  const android = read('android/app/src/main/java/com/qnetmobile/AppBuildModule.kt');
  expect(android).toMatch(/"version" to BuildConfig\.VERSION_NAME/);
  expect(android).toMatch(/"build" to BuildConfig\.VERSION_CODE\.toString\(\)/);
  const ios = read('ios/QNetMobile/QNetAppBuild.m');
  expect(ios).toMatch(/RCT_EXPORT_MODULE\(QNetAppBuild\)/);
  expect(ios).toMatch(/info\[@"CFBundleShortVersionString"\]/);
  expect(ios).toMatch(/info\[@"CFBundleVersion"\]/);
  const pbx = read('ios/QNetMobile.xcodeproj/project.pbxproj');
  expect(pbx).toMatch(/QNetAppBuild\.m in Sources \*\/,/);
  expect(pbx).toMatch(/path = QNetMobile\/QNetAppBuild\.m;/);
});
