// "Get QNet Wallet" (components/GetTheApp.tsx) and GET /get (app/get/route.ts): one link printed as a QR code sends each
// device to its own store; a computer gets the page that lists every way.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANDROID_PLAY_URL, GET_APP_URL, IOS_APP_STORE_URL, IOS_INSTALL_URL, IOS_TESTFLIGHT_URL } from '../app-links.ts';
import { GET_PAGE_PATH, installTarget, storeUrl } from '../install-target.ts';
import { qrMatrix } from '../qr.ts';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

test('each device is sent to its own store; a Mac with touch is an iPad', () => {
  assert.equal(installTarget(UA.iphone), 'ios');
  assert.equal(installTarget(UA.ipad), 'ios');
  assert.equal(installTarget(UA.ipadDesktop, 5), 'ios');
  assert.equal(installTarget(UA.ipadDesktop, 0), 'desktop');
  assert.equal(installTarget(UA.android), 'android');
  assert.equal(installTarget(UA.windows), 'desktop');
  assert.equal(installTarget(undefined), 'desktop');
  assert.equal(storeUrl('ios'), IOS_INSTALL_URL);
  assert.equal(storeUrl('android'), ANDROID_PLAY_URL);
  assert.equal(storeUrl('desktop'), null);
  assert.equal(GET_PAGE_PATH, '/wallet#get');
});

test('iPhone and iPad install from TestFlight until the App Store listing is live', () => {
  assert.equal(IOS_INSTALL_URL, IOS_APP_STORE_URL ?? IOS_TESTFLIGHT_URL);
  assert.match(IOS_TESTFLIGHT_URL, /^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/);
});

test('the printed link fits a small code with room for the logo it carries in the middle', () => {
  assert.equal(GET_APP_URL, 'https://aiqnet.io/get?from=qr');
  const m = qrMatrix(GET_APP_URL);
  // Version 3, level M: 26 error-correction codewords, so up to 13 damaged codewords are restored; the 5x5-module logo
  // (plus its half-module frame) touches at most 8 of the 70.
  assert.equal(m.version, 3);
  assert.equal(m.size, 29);
  const source = read('components/GetTheApp.tsx');
  assert.match(source, /const LOGO_MODULES = 5;/);
});

test('GET /get redirects by device and is never cached across devices', () => {
  const route = read('app/get/route.ts');
  assert.match(route, /storeUrl\(installTarget\(request\.headers\.get\('user-agent'\)\)\)/);
  // A relative Location for the page: behind the proxy request.url names the server's bind address, not the site.
  assert.match(route, /status: 302,/);
  assert.match(route, /Location: target \?\? GET_PAGE_PATH, 'Cache-Control': 'no-store', Vary: 'User-Agent'/);
  assert.doesNotMatch(route, /new URL\(|NextResponse\.redirect\(/);
});

test('the block shows the QR code only on a computer and the own store first on a phone, decided at first paint', () => {
  const source = read('components/GetTheApp.tsx');
  // No device check after load (B-SPEC 3.2): the root layout names the device from the request, CSS shows the variant.
  assert.doesNotMatch(source, /useEffect|useState|navigator\./);
  const layout = read('app/layout.tsx');
  assert.match(layout, /const device = installTarget\(request\.get\('user-agent'\)\);/);
  assert.match(layout, /<html lang="en" data-device=\{device\}/);
  // Only an iPad in desktop mode is corrected in the browser, by its touch points.
  assert.match(read('components/SiteShell.tsx'), /const target = installTarget\(navigator\.userAgent, navigator\.maxTouchPoints \|\| 0\);/);
  const css = read('styles/home.css');
  assert.match(css, /\.own \{ display: none; grid-column: 1 \/ -1; \}/);
  assert.match(css, /\[data-device='ios'\] \.own-ios, \[data-device='android'\] \.own-android \{ display: block; \}/);
  assert.match(css, /\[data-device='ios'\] \.get \.qr, \[data-device='ios'\] \.get \.stores, \[data-device='android'\] \.get \.qr, \[data-device='android'\] \.get \.stores \{ display: none; \}/);
  // The two phone stores have their own button; a phone cannot install the extension, so it has none.
  assert.match(source, /<OwnStore store=\{ios\} other=\{android\} \/>\s*<OwnStore store=\{android\} other=\{ios\} \/>/);
  assert.match(source, /href=\{store\.href\} target="_blank" rel="noopener noreferrer"/);
  // One measurement: the 264 px code and three rows a third of it each.
  assert.match(source, /width=\{264\} height=\{264\}/);
  assert.match(css, /\.stores \{ display: grid; grid-template-rows: repeat\(3, 88px\);/);
  // The wallet page's title band already says the lead, and the section takes the tool pages' rhythm.
  assert.match(read('app/wallet/page.tsx'), /<GetTheApp lead=\{null\} variant="tool" \/>/);
});
