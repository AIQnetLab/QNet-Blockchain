// Release check (npm run check:release): every aiqnet.io page the QNet app's store builds open outside the
// app, and the App Store listing's Marketing URL, opens in the app's view (the ?from=app marker,
// src/lib/activate-view.ts), where the site shows no activation, payment, other-platform or sideload text
// and links none. Fails until the app and the listing carry the marker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FROM_APP_PARAM, FROM_APP_VALUE, IN_APP_EXCLUDED_PAGES, IN_APP_NAV, openedFromApp } from '../activate-view.ts';

const MOBILE = new URL('../../../../../qnet-mobile/', import.meta.url);
const read = (path) => readFileSync(new URL(path, MOBILE), 'utf8');
const MARKER = `?${FROM_APP_PARAM}=${FROM_APP_VALUE}`;

test('the app opens its policy and support pages, and explorer records, in the app\'s view', () => {
  const screen = read('src/screens/WalletScreen.js');
  const legal = /const LEGAL_LINKS = \[([\s\S]*?)\];/.exec(screen);
  assert.ok(legal, 'LEGAL_LINKS');
  const urls = [...legal[1].matchAll(/'(https:\/\/aiqnet\.io\/[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(urls.map((u) => new URL(u).pathname), ['/privacy', '/terms', '/support']);
  for (const u of urls) assert.equal(openedFromApp(new URL(u).search), true, `${u} lacks ${MARKER}`);
  const nodes = read('src/config/nodes.js');
  assert.match(nodes, /export const EXPLORER_API = 'https:\/\/aiqnet\.io';/);
  const txUrl = nodes.split('\n').find((line) => line.includes('export const explorerTxUrl'));
  assert.ok(txUrl, 'explorerTxUrl');
  assert.ok(txUrl.trimEnd().endsWith(`${MARKER}\`;`), `explorerTxUrl lacks ${MARKER}: ${txUrl.trim()}`);
});

test('the App Store Marketing URL is a page of the app\'s view, with the marker', () => {
  const listing = read('store-listing/app-store-listing.txt');
  const marketing = /^Marketing URL:\s*(\S+)/m.exec(listing)?.[1];
  assert.ok(marketing, 'Marketing URL');
  const url = new URL(marketing);
  assert.equal(url.origin, 'https://aiqnet.io');
  assert.ok(IN_APP_NAV.some((l) => l.href === url.pathname), `${url.pathname} is not a page of the app's view`);
  assert.equal(IN_APP_EXCLUDED_PAGES.includes(url.pathname), false);
  assert.equal(openedFromApp(url.search), true, `${marketing} lacks ${MARKER}`);
});
