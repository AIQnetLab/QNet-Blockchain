// The in-app browser's navigation policy and addresses (src/browser/url.js), and the WebView it renders: https
// only (plain-http loopback in development builds), no scheme ever handed to another app, the address bar never
// sends typed text anywhere, and what a page's address shows (registrable domain, international names).
const React = require('react');
const TestRenderer = require('react-test-renderer');
const { act } = TestRenderer;
const url = require('node:url');
const {
  navigationDecision, addressToUrl, parseWebUrl, canonicalOrigin, walletOriginOf, describeUrl, registrableDomain,
  hostToUnicode, hostToAscii, punycodeDecode, punycodeEncode,
} = require('../src/browser/url');

describe('navigation policy', () => {
  const blockedEverywhere = [
    'intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;end',
    'market://details?id=com.evil', 'tel:+15551234567', 'mailto:someone@example.com', 'sms:+1555',
    'file:///data/data/com.qnetmobile/shared_prefs/x.xml', 'javascript:alert(1)', 'content://media/external/images',
    'qnetwallet://send?to=x', 'wc:abc@2?relay-protocol=irn', 'solana:pay', 'about:config', 'chrome://settings', 'ftp://example.com/',
  ];

  it('refuses every non-web scheme at the top level, release and development alike', () => {
    for (const u of blockedEverywhere) {
      for (const dev of [false, true]) expect([u, navigationDecision(u, { dev }).allow]).toEqual([u, false]);
    }
    for (const u of ['data:text/html,<script>alert(1)</script>', 'blob:https://example.com/5f3c']) {
      expect(navigationDecision(u).allow).toBe(false); // top level
    }
  });

  it('refuses plain http in a release build, loopback included; a development build allows loopback only', () => {
    for (const u of ['http://example.com/', 'http://localhost:8081/', 'http://127.0.0.1:3000/x', 'http://10.0.2.2/']) {
      expect(navigationDecision(u, { dev: false })).toEqual({ allow: false, reason: 'insecure' });
    }
    expect(navigationDecision('http://localhost:8081/', { dev: true }).allow).toBe(true);
    expect(navigationDecision('http://127.0.0.1:3000/x', { dev: true }).allow).toBe(true);
    expect(navigationDecision('http://example.com/', { dev: true }).allow).toBe(false);
    expect(navigationDecision('http://10.0.2.2/', { dev: true }).allow).toBe(false);
  });

  it('allows https pages and about:blank; refuses https addresses with credentials or hidden characters', () => {
    for (const u of ['https://example.com', 'https://aiqnet.io/explorer?x=1#y', 'https://sub.example.co.uk:8443/a', 'about:blank']) {
      expect(navigationDecision(u).allow).toBe(true);
    }
    for (const u of ['https://aiqnet.io@evil.com/', 'https://exa mple.com/', 'https://example.com/\u202e', 'https://0x7f.1/', 'https://-bad-.com/']) {
      expect([u, navigationDecision(u).allow]).toEqual([u, false]);
    }
  });

  it('a subframe may also be about:srcdoc, data: or blob: (it can never message the wallet), nothing else', () => {
    for (const u of ['about:srcdoc', 'data:text/html,x', 'blob:https://example.com/1']) {
      expect(navigationDecision(u, { topFrame: false }).allow).toBe(true);
    }
    for (const u of ['intent://x#Intent;end', 'http://example.com/', 'javascript:1', 'tel:1']) {
      expect(navigationDecision(u, { topFrame: false }).allow).toBe(false);
    }
  });

  // MBL-03 / CROSS-09 / SITE-R1-05 / APP-7: a QNet Link opened from inside the app would come back to the app itself,
  // and no build offers a node action anywhere: the link host, the node cabinet, /activate, /wallet and /l never load
  // here; a page asked for at the top goes to the explorer instead.
  it('never loads the QNet Link host or the site\'s wallet-only pages, in any frame, and opens the explorer instead', () => {
    const { EXPLORER_PAGE } = require('../src/browser/url');
    expect(EXPLORER_PAGE).toBe('https://aiqnet.io/explorer');
    const refused = [
      'https://link.aiqnet.io/l#v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.connect',
      'https://link.aiqnet.io/', 'https://LINK.aiqnet.io/l', 'https://aiqnet.io/activate', 'https://aiqnet.io/activate?x=1',
      'https://www.aiqnet.io/activate/', 'https://aiqnet.io/l#v1.x', 'https://aiqnet.io/Activate', 'https://aiqnet.io/wallet',
      'https://aiqnet.io/wallet/', 'https://aiqnet.io/node', 'https://aiqnet.io/node/light', 'https://www.aiqnet.io/Node?x=1',
      // The path as the site's router reads it: escapes, dot segments and repeated slashes do not get a page through.
      'https://aiqnet.io/%6Eode', 'https://aiqnet.io/%61ctivate', 'https://aiqnet.io/./node', 'https://aiqnet.io/x/../node',
      'https://aiqnet.io//node', 'https://aiqnet.io/node%2Flight', 'https://aiqnet.io/%2e/wallet',
    ];
    for (const u of refused) {
      expect([u, navigationDecision(u)]).toEqual([u, { allow: false, reason: 'site', redirect: EXPLORER_PAGE }]);
      expect([u, navigationDecision(u, { topFrame: false })]).toEqual([u, { allow: false, reason: 'site' }]);
    }
    for (const u of ['https://aiqnet.io/explorer', 'https://aiqnet.io/explorer/tx/ab', 'https://aiqnet.io/activated-news',
      'https://aiqnet.io/wallets', 'https://aiqnet.io/nodes', 'https://notlink.aiqnet.io/l', 'https://example.com/node']) {
      expect([u, navigationDecision(u).allow]).toEqual([u, true]);
    }
    expect(navigationDecision(EXPLORER_PAGE)).toEqual({ allow: true });
  });

  it('a link the OS delivers while the browser is on screen and the app never left the front came from a page', () => {
    const { handedOverByBrowser } = require('../src/browser/url');
    const t0 = 1_000_000;
    expect(handedOverByBrowser('browser', t0, t0 + 60_000)).toBe(true);
    // Brought to the front by another app's link a moment ago, or another tab on screen, or not in front at all.
    expect(handedOverByBrowser('browser', t0, t0 + 500)).toBe(false);
    expect(handedOverByBrowser('assets', t0, t0 + 60_000)).toBe(false);
    expect(handedOverByBrowser('browser', 0, t0)).toBe(false);
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    const receive = src.slice(src.indexOf('const receive = (url) => {'), src.indexOf('takeInitialUrl(Linking).then(receive)'));
    expect(receive.indexOf('handedOverByBrowser(')).toBeGreaterThan(0);
    expect(receive.indexOf('handedOverByBrowser(')).toBeLessThan(receive.indexOf('parseLink(url)'));
  });
});

describe('the address bar', () => {
  it('assumes https and upgrades a typed http address; never searches', () => {
    expect(addressToUrl('aiqnet.io')).toEqual({ url: 'https://aiqnet.io/' });
    expect(addressToUrl('  aiqnet.io/explorer?tab=blocks ')).toEqual({ url: 'https://aiqnet.io/explorer?tab=blocks' });
    expect(addressToUrl('http://example.com/a')).toEqual({ url: 'https://example.com/a' });
    expect(addressToUrl('HTTPS://Example.COM:443/Path')).toEqual({ url: 'https://example.com/Path' });
    expect(addressToUrl('qnet wallet')).toEqual({ error: 'invalid' });
    expect(addressToUrl('wallet')).toEqual({ error: 'invalid' });
    expect(addressToUrl('')).toEqual({ error: 'empty' });
  });

  it('refuses other schemes and credentials', () => {
    for (const u of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/hosts', 'intent://x', 'ftp://example.com']) {
      expect([u, addressToUrl(u).error]).toEqual([u, 'scheme']);
    }
    expect(addressToUrl('https://aiqnet.io@evil.com').error).toBe('invalid');
  });

  it('keeps plain-http loopback in development builds only', () => {
    expect(addressToUrl('localhost:3000', { dev: true })).toEqual({ url: 'http://localhost:3000/' });
    expect(addressToUrl('http://127.0.0.1:8080/x', { dev: true })).toEqual({ url: 'http://127.0.0.1:8080/x' });
    expect(addressToUrl('localhost:3000').error).toBe('invalid');
    expect(addressToUrl('http://127.0.0.1:8080/x')).toEqual({ url: 'https://127.0.0.1:8080/x' });
  });

  it('turns an international name into its ASCII form, as URL parsers do', () => {
    expect(addressToUrl('münchen.de')).toEqual({ url: 'https://xn--mnchen-3ya.de/' });
    for (const host of ['münchen.de', 'bücher.example', 'аррӏе.com', '例え.jp', 'ex-ample.com']) {
      expect(hostToAscii(host)).toBe(url.domainToASCII(host));
    }
  });
});

describe('what an address shows', () => {
  it('decodes punycode exactly like URL parsers', () => {
    for (const host of ['xn--mnchen-3ya.de', 'xn--80ak6aa92e.com', 'xn--r8jz45g.jp', 'xn--bcher-kva.example', 'example.com']) {
      expect(hostToUnicode(host)).toBe(url.domainToUnicode(host));
    }
    expect(punycodeDecode(punycodeEncode('ليهمابتكلموشعربي؟'))).toBe('ليهمابتكلموشعربي؟');
    expect(punycodeEncode('ليهمابتكلموشعربي؟')).toBe('egbpdaj6bu4bxfgehfvwxn');
    expect(punycodeDecode('99999999999')).toBe(null);
  });

  it('emphasises the registrable domain and flags international names', () => {
    expect(registrableDomain('app.example.org')).toBe('example.org');
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('evil.github.io')).toBe('evil.github.io');
    expect(registrableDomain('aiqnet.io.evil.com')).toBe('evil.com');
    expect(registrableDomain('192.168.1.1')).toBe('192.168.1.1');
    expect(describeUrl('https://aiqnet.io.evil.com/login')).toMatchObject({
      prefix: 'aiqnet.io.', domain: 'evil.com', secure: true, idn: false, origin: 'https://aiqnet.io.evil.com',
    });
    expect(describeUrl('https://xn--80ak6aa92e.com/')).toMatchObject({
      host: 'аррӏе.com', domain: 'аррӏе.com', hostAscii: 'xn--80ak6aa92e.com', idn: true,
    });
  });

  // MB2-05: raw punycode can decode to bidi overrides, zero-width characters and dot look-alikes; such a label is
  // shown in its xn-- form, as the extension does, so the address bar and the sheets never end in a fake domain.
  it('shows a label in its xn-- form when its decoded form could mislead', () => {
    const label = (text) => `xn--${punycodeEncode(text)}`;
    for (const text of ['‮oi․tenqia', 'aiqnet。io', 'aiqnet．io', 'pay​pal', 'a⁦b', 'x⁄y', 'a b', 'a@b', 'a:b', 'ab']) {
      const host = `${label(text)}.evil.example`;
      expect([text, hostToUnicode(host)]).toEqual([text, host]);
      const shown = describeUrl(`https://${host}/`);
      // (A label with an ASCII space, @ or : is not a host at all: the URL parser refuses it before display.)
      if (shown) {
        expect(shown.host).toBe(host);
        expect(shown.idn).toBe(true);
      }
    }
    // An ordinary international name still reads as itself.
    expect(hostToUnicode('xn--mnchen-3ya.de')).toBe('münchen.de');
  });

  it('an origin reported by the WebView is taken only in its exact form', () => {
    expect(canonicalOrigin('https://example.com')).toBe('https://example.com');
    expect(canonicalOrigin('https://example.com/')).toBe('https://example.com');
    expect(canonicalOrigin('https://example.com:443')).toBe('https://example.com');
    expect(canonicalOrigin('https://example.com:8443')).toBe('https://example.com:8443');
    for (const o of ['https://example.com/path', 'https://example.com?x', 'https://u@example.com', 'null', '',
      'http://example.com', 'http://localhost:3000', 'file://', 'https://', 'https://exa mple.com', undefined, 42]) {
      expect([o, canonicalOrigin(o)]).toEqual([o, null]);
    }
    expect(canonicalOrigin('http://localhost:3000', { dev: true })).toBe('http://localhost:3000');
    expect(walletOriginOf('https://aiqnet.io/explorer?x')).toBe('https://aiqnet.io');
    expect(parseWebUrl('https://[::1]:8443/x')).toMatchObject({ host: '[::1]', port: '8443' });
  });
});

describe('the WebView the browser renders', () => {
  const BrowserScreen = require('../src/browser/BrowserScreen').default;
  const { WebView } = require('react-native-webview');
  const t = (k) => k;

  async function openPage(dev) {
    let tree;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(BrowserScreen, {
        visible: true, wallet: null, credential: '', walletManager: {}, t, onSheet: () => {}, confirmAction: () => {}, dev,
      }));
    });
    const bookmark = tree.root.find((n) => n.props.testID === 'bookmark-aiqnet' && typeof n.props.onPress === 'function');
    await act(async () => { bookmark.props.onPress(); });
    return tree;
  }

  it('is locked down: https only, no files, no windows, no location, incognito, provider in the top frame only', async () => {
    const tree = await openPage(false);
    const web = tree.root.findByType(WebView).props;
    expect(web.source).toEqual({ uri: 'https://aiqnet.io/explorer' });
    expect(web.originWhitelist).toEqual(['https://*']);
    expect(web).toMatchObject({
      mixedContentMode: 'never', allowFileAccess: false, allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false, setSupportMultipleWindows: false, javaScriptCanOpenWindowsAutomatically: false,
      geolocationEnabled: false, paymentRequestEnabled: false, mediaCapturePermissionGrantType: 'deny', incognito: true,
      thirdPartyCookiesEnabled: false,
      injectedJavaScriptForMainFrameOnly: true, injectedJavaScriptBeforeContentLoadedForMainFrameOnly: true,
      webviewDebuggingEnabled: false, allowsLinkPreview: false,
    });
    expect(web.injectedJavaScriptBeforeContentLoaded).toContain("CHANNEL = 'mobile'");
    expect(web.injectedJavaScriptBeforeContentLoaded).toContain('var DEV = false;');
    // The navigation hook refuses what the whitelist would let through to it.
    const decide = async (u) => {
      let allowed;
      await act(async () => { allowed = web.onShouldStartLoadWithRequest({ url: u, isTopFrame: true }); });
      return allowed;
    };
    expect(await decide('https://example.com/')).toBe(true);
    expect(await decide('http://example.com/')).toBe(false);
    expect(await decide('intent://x#Intent;end')).toBe(false);
    await act(async () => { tree.unmount(); });
  });

  // MBL-02: the address bar and the page's origin follow committed navigations only (navigation-state events);
  // a progress event names whatever WKWebView calls its URL, which during a provisional load is the target.
  it('the address shown changes only with a navigation-state event, never with a progress event', async () => {
    const { Text } = require('react-native');
    const tree = await openPage(false);
    const web = () => tree.root.findByType(WebView).props;
    const shown = () => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).flat(Infinity)
      .map((c) => (typeof c === 'string' ? c : (c && c.props ? [].concat(c.props.children).join('') : ''))).join('')).join('\n');
    await act(async () => { web().onNavigationStateChange({ url: 'https://evil.example/page', title: 'x', loading: false }); });
    expect(shown()).toContain('evil.example');
    await act(async () => { web().onLoadProgress({ nativeEvent: { url: 'https://aiqnet.io/api/link/sessions/x/response', progress: 0.1, loading: true } }); });
    expect(shown()).toContain('evil.example');
    expect(shown()).not.toContain('aiqnet.io');
    await act(async () => { tree.unmount(); });
  });

  it('an address typed or picked from history gets the same policy as a page\'s navigation', async () => {
    const tree = await openPage(false);
    // The address bar shows the page; tap it to edit.
    const bar = tree.root.findAll((n) => n.props && typeof n.props.onPress === 'function' && /^browser-address/.test(n.props.testID || ''))[0];
    await act(async () => { bar.props.onPress(); });
    const field = tree.root.findAll((n) => n.props && typeof n.props.onSubmitEditing === 'function')[0];
    await act(async () => { field.props.onChangeText('link.aiqnet.io/l'); });
    await act(async () => { field.props.onSubmitEditing(); });
    expect(tree.root.findByType(WebView).props.source.uri).toBe('https://aiqnet.io/explorer'); // not opened: the explorer instead
    await act(async () => { tree.unmount(); });
  });

  it('a development build also loads plain-http loopback', async () => {
    const tree = await openPage(true);
    const web = tree.root.findByType(WebView).props;
    expect(web.originWhitelist).toEqual(['https://*', 'http://localhost*', 'http://127.0.0.1*']);
    expect(web.onShouldStartLoadWithRequest({ url: 'http://localhost:8081/', isTopFrame: true })).toBe(true);
    expect(web.injectedJavaScriptBeforeContentLoaded).toContain('var DEV = true;');
    await act(async () => { tree.unmount(); });
  });

  it('the patched library blocks what is outside the whitelist instead of opening another app', () => {
    const { Linking } = require('react-native');
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const can = jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    const { createOnShouldStartLoadWithRequest } = jest.requireActual('react-native-webview/lib/WebViewShared');
    const decided = [];
    const handler = createOnShouldStartLoadWithRequest((ok, u) => decided.push([ok, u]), ['https://*'], () => true);
    handler({ nativeEvent: { url: 'intent://x#Intent;end', lockIdentifier: 1 } });
    handler({ nativeEvent: { url: 'tel:123', lockIdentifier: 2 } });
    handler({ nativeEvent: { url: 'https://example.com/', lockIdentifier: 3 } });
    expect(decided).toEqual([[false, 'intent://x#Intent;end'], [false, 'tel:123'], [true, 'https://example.com/']]);
    expect(open).not.toHaveBeenCalled();
    expect(can).not.toHaveBeenCalled();
  });
});
