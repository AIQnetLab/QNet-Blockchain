// Which language a page is served in and how a visitor changes it: the address decides (English without a prefix,
// every other language with its code first), a first visit takes the browser's language once, the switcher's choice
// wins and stays, crawlers are never redirected; links and the router stay in the page's language, the switcher keeps
// the page and its query, Arabic reads right to left and every page names its address in each language.
// Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import {
  DEFAULT_LOCALE, LANGUAGES, LOCALES, alternates, dateLocale, isRtl, localeFromAccept, localeIn, localePath, ogLocale, splitLocale,
} from '../languages.ts';
import { isPageLoad, localeRoute } from '../locale-route.ts';
import { translator } from '../texts.ts';
import { day } from '../format.ts';
import { CATALOGS } from '../../i18n/catalogs.ts';
import { SRC, code, cssRules, read, sourceFiles } from './source.mjs';

// The site's proxy itself. Next.js's bundler takes `next/server` for the package's server.js; Node needs the file name.
register('data:text/javascript,export const resolve = (s, c, next) => next(s === "next/server" ? "next/server.js" : s, c);');
const { proxy: siteProxy } = await import('../../proxy.ts');
const require = createRequire(import.meta.url);
const NEXT_CONFIG = require('../../../next.config.js');
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const page = (pathname, more = {}) => localeRoute({
  pathname, search: '', cookie: null, acceptLanguage: null, userAgent: BROWSER, document: true, ...more,
});

test('a page\'s address carries its language: English without a prefix, every other language with its code first', () => {
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.deepEqual(splitLocale('/ru/explorer/tx/ab'), { locale: 'ru', path: '/explorer/tx/ab' });
  assert.deepEqual(splitLocale('/zh-CN'), { locale: 'zh-CN', path: '/' });
  assert.deepEqual(splitLocale('/explorer'), { locale: null, path: '/explorer' });
  assert.deepEqual(splitLocale('/en/explorer'), { locale: 'en', path: '/explorer' });
  assert.deepEqual(splitLocale('/en'), { locale: 'en', path: '/' });
  assert.deepEqual(splitLocale('/zh-cn/explorer'), { locale: null, path: '/zh-cn/explorer' });
  assert.equal(localePath('ru', '/explorer?at=5#top'), '/ru/explorer?at=5#top');
  assert.equal(localePath('ar', '/'), '/ar');
  assert.equal(localePath('de', '/?q=1'), '/de?q=1');
  assert.equal(localePath('en', '/explorer'), '/explorer');
  // The address that names English, for a browser that keeps no cookie.
  assert.equal(localePath('en', '/explorer?at=5', true), '/en/explorer?at=5');
  assert.equal(localePath('en', '/', true), '/en');
  assert.equal(localePath('ru', '/explorer', true), '/ru/explorer');
  assert.equal(localePath('ru', '/de/explorer'), '/de/explorer', 'a path already in a language stays');
  assert.equal(localePath('ru', '/en/explorer'), '/en/explorer');
  for (const href of ['https://aiqnet.io/node', '//aiqnet.io', 'mailto:support@aiqnet.io', '#top', '?tab=overview']) assert.equal(localePath('ja', href), href);
});

test('the address decides; a first visit takes the browser\'s language once; the switcher\'s choice wins; crawlers stay', () => {
  // An address in a language is that language, whatever is kept or asked for.
  assert.deepEqual(page('/ru/explorer', { cookie: 'qnet.lang=de', acceptLanguage: 'ja' }), { kind: 'page', locale: 'ru', path: '/explorer', rewrite: true });
  // /en/... is English where no cookie keeps it (all cookies refused, a browser in another language); once English is
  // kept, and for a crawler, it goes to the address without it.
  assert.deepEqual(page('/en/explorer', { acceptLanguage: 'ru' }), { kind: 'page', locale: 'en', path: '/explorer', rewrite: true });
  assert.deepEqual(page('/en/explorer', { cookie: 'qnet.lang=ru', acceptLanguage: 'ru' }), { kind: 'page', locale: 'en', path: '/explorer', rewrite: true });
  assert.deepEqual(page('/en/explorer', { cookie: 'qnet.lang=en', acceptLanguage: 'ru', search: '?at=5' }), { kind: 'redirect', location: '/explorer?at=5' });
  assert.deepEqual(page('/en', { cookie: 'qnet.lang=en' }), { kind: 'redirect', location: '/' });
  assert.deepEqual(page('/en/explorer', { userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' }), { kind: 'redirect', location: '/explorer' });
  assert.deepEqual(page('/en/explorer', { cookie: 'qnet.lang=en', document: false }), { kind: 'page', locale: 'en', path: '/explorer', rewrite: true });
  // First visit: the browser's language, kept in the cookie; English stays at its address.
  assert.deepEqual(page('/explorer', { search: '?at=5', acceptLanguage: 'ru-RU,ru;q=0.9,en;q=0.8' }), { kind: 'redirect', location: '/ru/explorer?at=5', keep: 'ru' });
  assert.deepEqual(page('/', { acceptLanguage: 'pt-PT' }), { kind: 'redirect', location: '/pt', keep: 'pt' });
  assert.deepEqual(page('/explorer', { acceptLanguage: 'en-US,en;q=0.9' }), { kind: 'page', locale: 'en', path: '/explorer', rewrite: false, keep: 'en' });
  assert.deepEqual(page('/explorer', { acceptLanguage: 'sv' }), { kind: 'page', locale: 'en', path: '/explorer', rewrite: false, keep: 'en' });
  // A kept language wins over the browser's and is not written again.
  assert.deepEqual(page('/explorer', { cookie: 'qnet.lang=en', acceptLanguage: 'ru' }), { kind: 'page', locale: 'en', path: '/explorer', rewrite: false, keep: undefined });
  assert.deepEqual(page('/node', { cookie: 'a=1; qnet.lang=de', acceptLanguage: 'ru' }), { kind: 'redirect', location: '/de/node', keep: undefined });
  // Crawlers, previews and the router's own requests are never redirected and set nothing.
  for (const userAgent of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'LinkExternalHit/1.1', 'Mozilla/5.0 HeadlessBrowser/1.0']) {
    assert.deepEqual(page('/explorer', { userAgent, acceptLanguage: 'ru' }), { kind: 'page', locale: 'en', path: '/explorer', rewrite: false }, userAgent);
  }
  assert.deepEqual(page('/explorer', { document: false, acceptLanguage: 'ru' }), { kind: 'page', locale: 'en', path: '/explorer', rewrite: false });
  // The link pages take the visitor's language without changing their address.
  assert.deepEqual(page('/l', { acceptLanguage: 'ja' }), { kind: 'page', locale: 'ja', path: '/l', rewrite: false });
  assert.deepEqual(page('/l', { cookie: 'qnet.lang=it', acceptLanguage: 'ja' }), { kind: 'page', locale: 'it', path: '/l', rewrite: false });
  // Files, the app-association files, robots, the sitemap, /get and the API are no page in a language.
  for (const path of ['/robots.txt', '/sitemap.xml', '/.well-known/assetlinks.json', '/icon-32.png', '/manifest.json', '/get', '/ru/api/head', '/de/sitemap.xml']) {
    assert.deepEqual(page(path, { acceptLanguage: 'ru' }), { kind: 'none' }, path);
  }
});

test('the browser\'s language: the first one the site speaks, by weight; Chinese and Portuguese as the app has them', () => {
  assert.equal(localeFromAccept('zh-TW,zh;q=0.9'), 'zh-CN');
  assert.equal(localeFromAccept('pt-BR'), 'pt');
  assert.equal(localeFromAccept('sv, de;q=0.5, fr;q=0.7'), 'fr');
  assert.equal(localeFromAccept('fr;q=0, it'), 'it');
  assert.equal(localeFromAccept('AR-EG'), 'ar');
  assert.equal(localeFromAccept('sv, nl'), null);
  assert.equal(localeFromAccept(null), null);
  assert.equal(localeIn('qnet.lang=zh-CN'), 'zh-CN');
  assert.equal(localeIn('qnet.lang=zh-cn'), null);
  // A malformed value is no language: the page is served from the address and the browser's language, never an error.
  for (const cookie of ['qnet.lang=%', 'qnet.lang=%E0', 'qnet.lang=%E0%A4%A', 'a=%; qnet.lang=%7']) assert.equal(localeIn(cookie), null, cookie);
  assert.equal(localeIn('a=%E0; qnet.lang=ru'), 'ru');
  assert.deepEqual(page('/explorer', { cookie: 'qnet.lang=%E0', acceptLanguage: 'ru' }), { kind: 'redirect', location: '/ru/explorer', keep: 'ru' });
  assert.deepEqual(page('/explorer', { cookie: 'qnet.lang=%' }), { kind: 'page', locale: 'en', path: '/explorer', rewrite: false, keep: 'en' });
});

test('the proxy serves the page in its language from headers it sets itself, and redirects only page loads', () => {
  const proxy = code('proxy.ts');
  assert.match(proxy, /requestHeaders\.delete\(LOCALE_HEADER\);\n\s*requestHeaders\.delete\(PATH_HEADER\);\n\s*requestHeaders\.delete\(NAMED_HEADER\);\n\s*if \(route\.kind === 'page'\) \{\n\s*requestHeaders\.set\(LOCALE_HEADER, route\.locale\);\n\s*requestHeaders\.set\(PATH_HEADER, route\.path\);/);
  assert.match(proxy, /const here = \(path: string\) => new URL\(path, request\.url\);/);
  assert.match(proxy, /NextResponse\.rewrite\(here\(`\$\{route\.path\}\$\{search\}`\), \{ request: \{ headers: requestHeaders \} \}\)/);
  assert.match(proxy, /if \(route\.kind === 'redirect'\) return keep\(NextResponse\.redirect\(here\(route\.location\), 307\)\);/);
  assert.match(proxy, /response\.headers\.set\('Vary', 'Accept-Language, Cookie'\);/);
  assert.match(proxy, /document: isPageLoad\(request\.method, request\.headers\),/);
  // The router's RSC and prefetch headers reach the proxy but say nothing a page load needs: nothing rests on them.
  assert.doesNotMatch(proxy + code('lib/locale-route.ts'), /'rsc'|next-router-prefetch|_rsc/);
  // Every page in a language reaches the proxy (the same matcher as the English pages).
  const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info.js');
  const { getMiddlewareRouteMatcher } = require('next/dist/shared/lib/router/utils/middleware-route-matcher.js');
  const literal = /export const config = (\{[\s\S]*?\n\});/.exec(read('proxy.ts'));
  const reaches = getMiddlewareRouteMatcher(getMiddlewareMatchers(new Function(`return (${literal[1]});`)().matcher, NEXT_CONFIG));
  for (const path of ['/ru', '/ar/explorer/tx/ab', '/zh-CN/node/activate', '/en/explorer']) assert.equal(reaches(path, { headers: { host: 'aiqnet.io' } }, {}), true, path);
});

// The server takes a rewrite whose origin is not its own address (bind host, port, X-Forwarded-Proto's scheme) for
// another host and fetches it from outside. Run through Next.js's own proxy adapter and that check (resolve-routes),
// a page in a language stays inside the server on every bind address and behind any front proxy.
test('a page in a language is rewritten inside the server and a redirect is relative, whatever the address and the proxy in front', async () => {
  const { adapter } = require('next/dist/server/web/adapter.js');
  const { getRelativeURL } = require('next/dist/shared/lib/router/utils/relativize-url.js');
  // The build inlines next.config.js skipProxyUrlNormalize into the adapter as this variable (next/dist/build/define-env.js).
  const kept = process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
  if (NEXT_CONFIG.skipProxyUrlNormalize) process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = 'true';
  else delete process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
  const LOAD = { 'user-agent': BROWSER, accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
  try {
    for (const bind of ['127.0.0.1', 'localhost']) {
      for (const front of [{ host: 'aiqnet.io', 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.2.3.4' }, { host: 'localhost:3300' }]) {
        // The address the server hands its proxy and checks the answer against (next-server runMiddleware, resolve-routes).
        const serve = async (path, headers = {}) => {
          const own = `${front['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${bind}:3300${path}`;
          const { response } = await adapter({ handler: siteProxy, page: 'middleware', request: { url: own, method: 'GET', headers: { ...front, ...headers }, nextConfig: {} } });
          const seen = (name) => (response.headers.has(name) ? getRelativeURL(response.headers.get(name), own) : null);
          return { response, rewrite: seen('x-middleware-rewrite'), location: seen('location'), set: (name) => response.headers.get(`x-middleware-request-${name}`) };
        };
        const at = `${bind} ${JSON.stringify(front)}`;
        for (const [path, page, locale] of [['/ru/explorer?at=5', '/explorer?at=5', 'ru'], ['/zh-CN/explorer', '/explorer', 'zh-CN'], ['/ar/node', '/node', 'ar'], ['/ru', '/', 'ru']]) {
          const { response, rewrite, set } = await serve(path, { ...LOAD, 'x-qnet-locale': 'de', 'x-qnet-path': '/wallet' });
          assert.equal(rewrite, page, `${at} ${path}`);
          assert.equal(set('x-qnet-locale'), locale, `${at} ${path}`);
          assert.equal(set('x-qnet-path'), page.split('?')[0], `${at} ${path}`);
          assert.equal(set('content-security-policy'), response.headers.get('content-security-policy'), `${at} ${path}`);
          assert.equal(/worker-src 'none'/.test(response.headers.get('content-security-policy')), page === '/node', `${at} ${path}`);
        }
        // The router's fetch of a page in a language: inside the server, and told the page it got.
        const rsc = await serve('/ru/explorer?_rsc=1a2b', { rsc: '1', 'next-router-state-tree': '%5B%22%22%5D', 'sec-fetch-dest': 'empty', accept: '*/*' });
        assert.equal(rsc.rewrite, '/explorer?_rsc=1a2b', at);
        assert.equal(rsc.response.headers.get('x-nextjs-rewritten-path'), '/explorer', at);
        // /en/explorer: English in place while no cookie keeps it, the address without it once English is kept. The page
        // is told its address named English, so a redirect it makes keeps /en/; no other request is, whatever it sends.
        const english = await serve('/en/explorer', { ...LOAD, 'accept-language': 'ru' });
        assert.equal(english.rewrite, '/explorer', at);
        assert.equal(english.set('x-qnet-locale'), 'en', at);
        assert.equal(english.set('x-qnet-named'), '1', at);
        assert.equal(english.response.headers.get('set-cookie'), null, at);
        for (const path of ['/ru/explorer', '/explorer']) {
          assert.equal((await serve(path, { ...LOAD, cookie: 'qnet.lang=en', 'x-qnet-named': '1' })).set('x-qnet-named'), null, `${at} ${path}`);
        }
        const kept = await serve('/en/explorer', { ...LOAD, cookie: 'qnet.lang=en', 'accept-language': 'ru' });
        assert.equal(kept.response.status, 307, at);
        assert.equal(kept.location, '/explorer', at);
        const first = await serve('/explorer?at=5', { ...LOAD, 'accept-language': 'ru-RU,ru;q=0.9' });
        assert.equal(first.response.status, 307, at);
        assert.equal(first.location, '/ru/explorer?at=5', at);
        assert.match(first.response.headers.get('set-cookie'), /^qnet\.lang=ru;/, at);
        // A malformed kept value is replaced, never an error page.
        const malformed = await serve('/explorer', { ...LOAD, cookie: 'qnet.lang=%E0', 'accept-language': 'ru' });
        assert.equal(malformed.response.status, 307, at);
        assert.match(malformed.response.headers.get('set-cookie'), /^qnet\.lang=ru;/, at);
        assert.equal((await serve('/explorer', LOAD)).rewrite, null, at);
      }
    }
  } finally {
    if (kept === undefined) delete process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
    else process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE = kept;
  }
});

test('only a browser loading a page is a page load: a router fetch, a prefetch or a script never is', () => {
  const HTML = 'text/html,application/xhtml+xml,*/*;q=0.8';
  const load = (headers, method = 'GET') => isPageLoad(method, new Headers(headers));
  assert.equal(load({ 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: HTML }), true);
  // The router's fetch and prefetch as the proxy sees them, their RSC headers along.
  assert.equal(load({ rsc: '1', 'next-router-state-tree': '%5B%22%22%5D', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', accept: '*/*' }), false);
  assert.equal(load({ rsc: '1', 'next-router-prefetch': '1', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', accept: '*/*' }), false);
  assert.equal(load({ 'sec-fetch-dest': 'document', purpose: 'prefetch', accept: HTML }), false);
  // A browser that sends no Sec-Fetch-*: a page load asks for HTML, its fetches do not.
  assert.equal(load({ accept: HTML }), true);
  assert.equal(load({ accept: '*/*' }), false);
  assert.equal(load({}), false);
  assert.equal(load({ 'sec-fetch-dest': 'document', accept: HTML }, 'POST'), false);
});

test('links and the router stay in the page\'s language; only the switcher leaves it', () => {
  for (const file of sourceFiles()) {
    const src = code(file);
    if (file !== 'i18n/client.tsx') {
      assert.doesNotMatch(src, /from 'next\/link'/, `${file}: links through src/i18n/client.tsx Link`);
      assert.doesNotMatch(src, /\b(useRouter|usePathname)\b/, `${file}: the router and the path through src/i18n/client.tsx`);
    }
    // The server's reading of the language (request headers) never reaches a client module.
    if (/^'use client';/.test(read(file))) assert.doesNotMatch(src, /i18n\/server'/, file);
  }
  const client = code('i18n/client.tsx');
  assert.match(client, /return <NextLink ref=\{ref\} href=\{typeof href === 'string' \? local\(href\) : href\} \{\.\.\.rest\} \/>;/);
  assert.match(client, /push: \(path: string\) => router\.push\(href\(path\)\),/);
  assert.match(client, /return splitLocale\(usePathname\(\) \?\? '\/'\)\.path;/);
  // An English page reached at /en/... keeps its links there, so a reload stays English without the cookie.
  assert.match(client, /return locale === DEFAULT_LOCALE && splitLocale\(usePathname\(\) \?\? '\/'\)\.locale === DEFAULT_LOCALE;/);
  assert.match(code('i18n/core.ts'), /href: \(path\) => localePath\(locale, path, named\)/);
  // The server's pages too (the /node redirect is pinned in cabinet-layout.test.mjs): /en/node?tab=history goes to
  // /en/node/history, not to the cookie's or the browser's language.
  assert.match(code('i18n/server.ts'), /const named = locale === DEFAULT_LOCALE && \(await headers\(\)\)\.get\(NAMED_HEADER\) === '1';\n\s*return makeI18n\(locale, CATALOGS\[locale\], named\);/);
  for (const page of ['app/l/page.tsx', 'app/send/page.tsx']) assert.match(code(page), /const \{ t, say, rich, href \} = await getI18n\(\);/, page);
  assert.equal(localePath('en', '/node/history', true), '/en/node/history');
});

test('one switcher lists the app\'s languages in its order, each in its own language, and keeps the page and its query', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.code), ['en', 'zh-CN', 'ru', 'es', 'ko', 'ja', 'pt', 'fr', 'de', 'ar', 'it']);
  const switcher = code('components/LanguageSwitcher.tsx');
  assert.match(switcher, /\{LANGUAGES\.map\(\(l\) => \(\s*<li key=\{l\.code\}>\s*<a\s+className="lang-link"\s+href=\{localePath\(l\.code, path, true\)\}\s+hrefLang=\{l\.code\}\s+lang=\{l\.code\}\s+aria-current=\{l\.code === locale \? 'true' : undefined\}\s+onClick=\{\(e\) => choose\(e, l\.code, path\)\}\s*>\s*\{l\.name\}/);
  // The choice is kept and the same page opens in that language, its query and fragment along, in one full load, at an
  // address that names the language (English too), so a refused cookie cannot send it back to the browser's language.
  assert.match(switcher, /document\.cookie = localeCookie\(locale, window\.location\.protocol === 'https:'\);\n\s*window\.location\.assign\(`\$\{localePath\(locale, path, true\)\}\$\{window\.location\.search\}\$\{window\.location\.hash\}`\);/);
  assert.match(switcher, /const current = language\(locale\);/);
  assert.match(switcher, /if \(e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey \|\| e\.button !== 0\) return;/);
  // A keyboard opens it from its button, Escape closes it with focus back on the button (components/ui/useMenu.ts).
  assert.match(switcher, /aria-expanded=\{open\}\s+aria-controls=\{listId\}\s+aria-label=\{t\('lang_button', \{ language: current\.name \}\)\}/);
  assert.match(code('components/ui/useMenu.ts'), /if \(e\.key !== 'Escape'\) return;\s*setOpen\(false\);\s*button\.current\?\.focus\(\{ preventScroll: true \}\);/);
  // In the header's row on a wide screen and inside its menu on a phone: one component, once.
  const header = code('components/Header.tsx');
  assert.equal(header.match(/<LanguageSwitcher \/>/g)?.length, 1);
  // The menu opens toward the page's end side, so in Arabic it opens from the left.
  const shell = read('styles/shell.css');
  assert.match(shell, /\.lang-menu \{ inset-inline-end: -16px;/);
  // On a phone the eleven languages stand in the menu, two to a row.
  assert.match(shell, /\.lang-menu, \.lang-menu\[hidden\] \{\n\s*position: static; display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
});

test('Arabic reads right to left; the page carries its language; values keep their own direction', () => {
  assert.deepEqual(LOCALES.filter(isRtl), ['ar']);
  assert.match(code('i18n/core.ts'), /dir: isRtl\(locale\) \? 'rtl' : 'ltr'/);
  assert.match(code('app/layout.tsx'), /<html lang=\{locale\} dir=\{dir\} /);
  assert.match(code('app/global-error.tsx'), /<html lang=\{locale\} dir=\{isRtl\(locale\) \? 'rtl' : 'ltr'\}>/);
  // A value set into an Arabic sentence is isolated, so an address or an amount keeps its order.
  const ar = translator('ar', CATALOGS.ar);
  assert.equal(ar('copy_named', { name: 'aiqnet.io' }), CATALOGS.ar.copy_named.replace('{name}', '⁨aiqnet.io⁩'));
  assert.equal(translator('ru', CATALOGS.ru)('copy_named', { name: 'x' }), CATALOGS.ru.copy_named.replace('{name}', 'x'));
  // Dates in the language's month names, digits Latin in every language.
  assert.equal(dateLocale('ar'), 'ar-u-nu-latn');
  assert.match(day(Date.UTC(2026, 9, 27, 12), ar), /^[^٠-٩]*27[^٠-٩]*$/);
  const css = read('styles/i18n.css');
  assert.match(css, /\.ent, \.amount, \.amount-v, \.mono, \.ex-val, \.addr, \.cab-code, \.cab-send-amt, code, kbd, samp \{\n\s*direction: ltr; unicode-bidi: isolate;/);
  // A sentence around amounts reads in the page's direction: in Arabic "250 of 1,500" stays 250 of 1,500. The meter, the
  // base units of a token transfer and the test token's word sit in no left-to-right class.
  const ltr = cssRules(css).find(([, body]) => /direction: ltr; unicode-bidi: isolate;/.test(body))[0].split(/,\s*/).filter((s) => s.startsWith('.')).map((s) => s.slice(1));
  const classesOf = (src, call) => {
    const at = src.indexOf(call);
    assert.ok(at > -1, call);
    return [...src.slice(src.lastIndexOf('<span', at), at).matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(' '));
  };
  const steps = code('components/cabinet/ActivateSteps.tsx');
  for (const [src, call] of [[steps, "t('act_meter', "], [code('app/explorer/tx/[hash]/TransactionClient.tsx'), "t('tx_base_units', "]]) {
    const classes = classesOf(src, call);
    assert.ok(classes.length > 0 && classes.every((c) => !ltr.includes(c)), `${call}: ${classes}`);
  }
  assert.match(code('app/explorer/tx/[hash]/TransactionClient.tsx'), /t\('tx_base_units', \{ amount: \/\^\\d\+\$\/\.test\(call\.amountRaw\) \? formatTokenAmount\(call\.amountRaw, 0\) : call\.amountRaw \}\)/);
  // The test token's word is the label's, beside the amount; the amount names the bare token.
  assert.match(steps, /const amount = \(token: FundingToken\) => <Amount value=\{full\[token\]\} solana=\{tokens\[token\]\} \/>;/);
  assert.doesNotMatch(steps, /<Amount[^>]*tokenName/);
  assert.match(steps, /<span className="cab-send-k">\{tokenName\(token\)\}<\/span>/);
  assert.match(steps, /<div><dt>\{tokenName\('oneDev'\)\}<\/dt><dd>\{amount\('oneDev'\)\}<\/dd><\/div>/);
  assert.ok(!ltr.includes('cab-send-k'));
  assert.match(css, /:root:is\(:lang\(ar\), :lang\(zh-CN\), :lang\(ja\), :lang\(ko\)\) \* \{ letter-spacing: normal !important; \}/);
  // Charts and the Latest blocks strip keep left to right (time runs the same way in every language).
  assert.match(code('components/explorer/LatestBlocks.tsx'), /dir="ltr"/);
  // A table's headers and cells keep their gap on the same side, and My node's names keep theirs from the section
  // track, in either direction.
  const gap = (sel) => /padding: 0; padding-inline-end: (\d+px);/.exec(cssRules(read('styles/base.css')).find(([s]) => s === sel)?.[1] ?? '')?.[1];
  assert.equal(gap('.tbl th'), '14px');
  assert.equal(gap('.tbl td'), gap('.tbl th'));
  const cabinet = read('styles/cabinet.css');
  assert.match(cabinet, /\.cab-nav \{[^}]*border-inline-start: 1px solid var\(--rule\);/);
  assert.match(cabinet, /\.cab-nav-a \{\n[^}]*padding: 13px 0; padding-inline-start: 20px;\n\}/);
});

// In Arabic a count reads in the direction of its first letter, a field's hint reads right to left, a chart's labels keep
// their own order inside its left-to-right axis, and the guide's pictures mirror with their labels whole.
test('Arabic: counts and labels take their own direction, hints read right to left, the guide\'s pictures mirror', () => {
  const css = read('styles/i18n.css');
  // A count is no left-to-right value: it reads in the direction of its first letter; an amount marked as one keeps its run.
  assert.match(css, /\n\.num \{ unicode-bidi: plaintext; \}/);
  assert.ok(css.indexOf('.num { unicode-bidi: plaintext; }') < css.indexOf('.ent, .amount, .amount-v'), 'the values rule comes after');
  assert.match(code('app/explorer/blocks/BlocksClient.tsx'), /meta=\{<span className="label num">\{shownRange\}<\/span>\}/);
  assert.match(code('components/explorer/Ago.tsx'), /<span className="num" suppressHydrationWarning>/);
  assert.match(css, /\[dir='rtl'\] \.mono:placeholder-shown \{ direction: rtl; \}/);
  // Inside a chart or the strip, which keep left to right, every label but one marked dir="auto" takes its own direction.
  assert.match(css, /:where\(\[dir='rtl'\] \[dir='ltr'\]\) :where\(span, li, p, dt, dd, figcaption\):where\(:not\(\[dir\], \[dir='auto'\] \*\)\) \{ unicode-bidi: plaintext; text-align: left; \}/);
  assert.match(css, /\[dir='rtl'\] \.guide-art \{ direction: ltr; transform: scaleX\(-1\); \}/);
  assert.match(css, /\[dir='rtl'\] \.guide-art :is\(text, image\) \{ transform: scaleX\(-1\); transform-box: fill-box; transform-origin: center; \}/);
  assert.match(css, /\[dir='rtl'\] \.guide-art text \{ unicode-bidi: plaintext; \}/);
});

// Every side a rule names follows the text direction: start and end, never left and right, except a box set the same on
// both sides, a chart or the Latest blocks strip (kept left to right in their markup), a chevron drawn by two borders,
// and code (i18n.css keeps it left to right on purpose).
test('the stylesheets name the start and end sides, never left and right, outside the parts kept left to right', () => {
  const KEPT = /^(\.ep-|\.hv-|\.cab-pe|\.ex-cell|\.chev\b|\.ex-chev\b|pre\b|:where\(\[dir='rtl'\] \[dir='ltr'\]\))/;
  const SIDES = /^(padding|margin|border|scroll-padding|scroll-margin|inset)$/;
  const found = [];
  for (const name of ['base', 'shell', 'home', 'explorer', 'cabinet', 'pages', 'i18n']) {
    for (const [selector, body] of cssRules(read(`styles/${name}.css`))) {
      if (selector.startsWith('@') || /^(from|to|\d+%)$/.test(selector)) continue;
      const decls = Object.fromEntries(body.split(';').map((d) => d.split(':')).filter((d) => d.length > 1).map(([k, ...v]) => [k.trim(), v.join(':').trim()]));
      const physical = [];
      for (const [prop, value] of Object.entries(decls)) {
        const side = /^(padding|margin|border|scroll-padding|scroll-margin)-(left|right)(-\w+)?$/.exec(prop);
        if (side && decls[prop.replace(side[2], side[2] === 'left' ? 'right' : 'left')] !== value) physical.push(prop);
        const centred = prop === 'left' && value === '50%' && /translate\(-50%/.test(decls.transform ?? '');
        if ((prop === 'left' || prop === 'right') && !centred && decls[prop === 'left' ? 'right' : 'left'] !== value) physical.push(prop);
        if ((prop === 'text-align' || prop === 'float' || prop === 'clear') && /\b(left|right)\b/.test(value)) physical.push(`${prop}: ${value}`);
        const parts = value.replace(/!important/, '').trim().split(/\s+(?![^(]*\))/);
        if (SIDES.test(prop) && parts.length === 4 && parts[1] !== parts[3]) physical.push(`${prop}: ${value}`);
      }
      // The selector's own list, a comma inside :where() or :not() left in its part.
      const list = [''];
      let depth = 0;
      for (const ch of selector) {
        depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
        if (ch === ',' && depth === 0) list.push(''); else list[list.length - 1] += ch;
      }
      for (const selectorPart of list.map((s) => s.trim())) {
        if (physical.length && !KEPT.test(selectorPart)) found.push(`${name}.css ${selectorPart}: ${physical.join(', ')}`);
      }
    }
  }
  assert.deepEqual(found, []);
});

// A page's tab and a search result name the page in its language: every page but the home page (titled with the site's
// name alone) sets its own title, from its own file or a layout between it and the root, and no part of it repeats the
// name the title ends with.
test('every page but the home page carries its own title in its language', () => {
  const pages = sourceFiles().filter((f) => /^app\/(.+\/)?page\.tsx$/.test(f) && f !== 'app/page.tsx');
  assert.ok(pages.length > 20, `${pages.length} pages`);
  const missing = [];
  for (const page of pages) {
    const dirs = page.split('/').slice(1, -1);
    const chain = [page, ...dirs.map((_, i) => `app/${dirs.slice(0, i + 1).join('/')}/layout.tsx`)];
    const titled = chain.filter((f) => sourceFiles().includes(f)).some((f) => /\b(pageMetadata|recordMetadata)\(/.test(code(f)));
    if (!titled) missing.push(page);
  }
  assert.deepEqual(missing, []);
  for (const file of sourceFiles().filter((f) => f.startsWith('app/'))) {
    for (const m of code(file).matchAll(/\b(?:pageMetadata\(\[([^\]]*)\]|recordMetadata\('([a-z0-9_]+)'\))/g)) {
      for (const key of [...(m[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((k) => k[1]).concat(m[2] ? [m[2]] : [])) {
        assert.ok(CATALOGS.en[key], `${file}: ${key}`);
        assert.doesNotMatch(CATALOGS.en[key], /QNet Blockchain/, `${file}: ${key} repeats the name the title ends with`);
      }
    }
  }
  assert.match(code('app/privacy/layout.tsx'), /pageMetadata\(\['support_legal_privacy'\], 'privacy_lead'\)/);
  assert.match(code('app/terms/layout.tsx'), /pageMetadata\(\['support_legal_terms'\], 'privacy_lead'\)/);
});

// Korean breaks between words, never inside one; Chinese and Japanese headings break between phrases, and the Japanese
// header keeps its punctuation tight so the row fits a tablet.
test('Chinese, Japanese and Korean break lines where their readers expect them', () => {
  const css = read('styles/i18n.css');
  assert.match(css, /:root:lang\(ko\) body \{ word-break: keep-all; overflow-wrap: break-word; \}/);
  assert.match(css, /:root:is\(:lang\(zh-CN\), :lang\(ja\)\) :is\(h1, h2, h3, h4, dt, \.lead, \.deck, \.ftr-line\) \{ word-break: keep-all; overflow-wrap: anywhere; \}/);
  assert.match(css, /:root:lang\(ja\) :is\(h1, h2, h3, h4, dt, \.lead, \.deck, \.ftr-line\) \{ word-break: auto-phrase; \}/);
  assert.ok(css.indexOf('word-break: auto-phrase') > css.indexOf('word-break: keep-all; overflow-wrap: anywhere'), 'phrases over whole runs where the browser knows them');
  assert.match(css, /:root:lang\(ja\) :is\(\.hdr, h1, h2, h3, h4, \.deck, \.ftr-line\) \{ font-feature-settings: 'palt'; \}/);
});

test('every page names its address in each language and its own canonical address', () => {
  const links = alternates('ru', '/explorer', 'https://aiqnet.io');
  assert.equal(links.canonical, 'https://aiqnet.io/ru/explorer');
  assert.deepEqual(Object.keys(links.languages), [...LOCALES, 'x-default']);
  assert.equal(links.languages.en, 'https://aiqnet.io/explorer');
  assert.equal(links.languages['zh-CN'], 'https://aiqnet.io/zh-CN/explorer');
  assert.equal(links.languages['x-default'], 'https://aiqnet.io/explorer');
  assert.deepEqual(alternates('en', '/', 'https://aiqnet.io').canonical, 'https://aiqnet.io/');
  assert.equal(alternates('en', '/', 'https://aiqnet.io').languages.ar, 'https://aiqnet.io/ar');
  assert.match(code('i18n/server.ts'), /return alternates\(await getLocale\(\), \(await headers\(\)\)\.get\(PATH_HEADER\) \|\| '\/', SITE_ORIGIN\);/);
  const layout = code('app/layout.tsx');
  assert.match(layout, /alternates: await localeAlternates\(\),/);
  assert.match(layout, /locale: ogLocale\(locale\),/);
  assert.equal(ogLocale('pt'), 'pt_BR');
  // The sitemap lists each page in every language, each entry with the same alternates.
  assert.match(code('app/sitemap.ts'), /const \{ languages \} = alternates\(DEFAULT_LOCALE, path \|\| '\/', SITE_ORIGIN\);\n\s*return LOCALES\.map\(\(locale\) => \(\{ url: languages\[locale\], alternates: \{ languages \} \}\)\);/);
  // No page replaces the layout's alternates with its own.
  for (const file of readdirSync(new URL('app/', SRC), { recursive: true }).map((n) => `app/${n.replace(/\\/g, '/')}`).filter((n) => /\.tsx?$/.test(n) && n !== 'app/layout.tsx' && n !== 'app/sitemap.ts')) {
    assert.doesNotMatch(code(file), /alternates:/, file);
  }
});
