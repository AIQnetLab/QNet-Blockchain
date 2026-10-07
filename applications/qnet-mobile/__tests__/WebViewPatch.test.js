// The in-app browser relies on a patched react-native-webview (patches/react-native-webview+14.0.1.patch,
// applied by patch-package on every install): the origin of every message comes from the platform, subframes
// cannot message the app, nothing is handed to other apps, and no downloads, file picker, camera, microphone
// or location. This checks the pin, the patch file and that the installed library carries it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PATCH = path.join(ROOT, 'patches', 'react-native-webview+14.0.1.patch');
const lib = (p) => fs.readFileSync(path.join(ROOT, 'node_modules', 'react-native-webview', p), 'utf8');
const ANDROID = 'android/src/main/java/com/reactnativecommunity/webview/';

it('is pinned to the exact version the patch was made for, and patch-package runs on install', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  expect(pkg.dependencies['react-native-webview']).toBe('14.0.1');
  expect(JSON.parse(lib('package.json')).version).toBe('14.0.1');
  expect(pkg.scripts.postinstall).toBe('patch-package');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  expect(lock.packages['node_modules/react-native-webview'].version).toBe('14.0.1');
  expect(fs.existsSync(PATCH)).toBe(true);
  expect(fs.readFileSync(PATCH, 'utf8')).not.toMatch(/\r/);
});

it('Android: messages arrive only through addWebMessageListener, from the top frame, with the reported origin', () => {
  const src = lib(`${ANDROID}RNCWebView.java`);
  expect(src).toContain('WebViewCompat.addWebMessageListener(');
  expect(src).toContain('if (!isMainFrame || data == null || !isAllowedMessageOrigin(sourceOrigin))');
  expect(src).toContain('data.putString("frameOrigin", frameOrigin);');
  expect(src).toContain('data.putBoolean("isMainFrame", true);');
  expect(src).not.toMatch(/addJavascriptInterface\(|@JavascriptInterface|fallbackBridge/);
  expect(src).toMatch(/"https"\.equals\(scheme\)/);
});

it('Android: no downloads, no file picker, no camera, microphone or location, and the scheme policy is native', () => {
  const manager = lib(`${ANDROID}RNCWebViewManagerImpl.kt`);
  expect(manager).toContain('webView.setDownloadListener(DownloadListener { _, _, _, _, _ -> })');
  expect(manager).not.toContain('module.downloadFile(');
  expect(manager).toContain('WebStorage.getInstance().deleteAllData()');
  const chrome = lib(`${ANDROID}RNCWebChromeClient.java`);
  expect(chrome).toMatch(/onPermissionRequest\(final PermissionRequest request\) \{\s*request\.deny\(\);\s*\}/);
  expect(chrome).toMatch(/onGeolocationPermissionsShowPrompt\(String origin, GeolocationPermissions\.Callback callback\) \{\s*callback\.invoke\(origin, false, false\);/);
  expect(chrome).toMatch(/onShowFileChooser\([^)]*\) \{\s*return false;\s*\}/);
  // The scheme policy is native, before JS is asked: a busy JS thread cannot let intent:, http: and the like through.
  const client = lib(`${ANDROID}RNCWebViewClient.java`);
  expect(client).toContain('protected static boolean isAllowedNavigation(Uri uri, boolean isMainFrame)');
  // A refusal is only reported to JS (reportWalletOnly: a wallet-only page, MB-R1-02), never left to it.
  expect(client).toMatch(/shouldOverrideUrlLoading\(WebView view, String url\) \{\s*if \(!isAllowedNavigation\(Uri\.parse\(url\), true\)\) \{\s*reportWalletOnly\([^;]*\);\s*return true;/);
  expect(client).toMatch(/shouldOverrideUrlLoading\(WebView view, WebResourceRequest request\) \{\s*if \(!isAllowedNavigation\(request\.getUrl\(\), request\.isForMainFrame\(\)\)\) \{\s*if \(request\.isForMainFrame\(\)\) reportWalletOnly\([^;]*\);\s*return true;/);
  expect(client).toMatch(/case "http":\s*return ReactBuildConfig\.DEBUG && !credentials && \("localhost"\.equals\(host\) \|\| "127\.0\.0\.1"\.equals\(host\)\);/);
  expect(client).toMatch(/default:\s*return false;/);
});

// MB2-06 / APP-7: the wallet-only pages (the QNet Link host, aiqnet.io's node cabinet, /activate, /wallet and /l) are
// refused natively in any frame, and a main-frame navigation JS does not decide in time is refused, not allowed.
it('Android: the wallet-only pages are refused natively, and an undecided main-frame navigation is blocked', () => {
  const client = lib(`${ANDROID}RNCWebViewClient.java`);
  expect(client).toMatch(/case "https":\s*return host != null && !host\.isEmpty\(\) && !credentials && !isWalletOnlyPage\(host, uri\.getPath\(\)\);/);
  expect(client).toContain('if ("link.aiqnet.io".equals(h)) return true;');
  expect(client).toContain('if (!"aiqnet.io".equals(h) && !"www.aiqnet.io".equals(h) && !"explorer.aiqnet.io".equals(h)) return false;');
  expect(client).toContain('return p.isEmpty() || "/".equals(p) || p.matches("^/(activate|wallet|node|l|docs|dao|testnet|qnet-wallet-extension)(/.*)?$");');
  // Uri.getPath() is already decoded and WebView resolves dot segments; repeated slashes count as one.
  expect(client).toContain('path.toLowerCase(java.util.Locale.ROOT).replaceAll("/{2,}", "/");');
  expect(client).toMatch(/SHOULD_OVERRIDE_URL_LOADING_TIMEOUT\) \{[\s\S]*?return isMainFrame;/);
  expect(client).toMatch(/InterruptedException e\) \{[\s\S]*?return isMainFrame;/);
  expect(client).toContain('return askJsShouldOverride(view, request.getUrl().toString(), request.isForMainFrame());');
  // The same rule as the JS policy (src/browser/url.js isWalletOnlyPage); the native side lowercases the path first.
  const { navigationDecision } = require('../src/browser/url');
  // The site's own list of pages kept out of the app (MB-03): its home, /docs, /dao, /testnet, /qnet-wallet-extension.
  const rule = /^(\/?|\/(activate|wallet|node|l|docs|dao|testnet|qnet-wallet-extension)(\/.*)?)$/;
  for (const path of ['/activate', '/l', '/activate/x', '/wallet', '/wallet/', '/node', '/node/super', '/activated', '/explorer',
    '/wallets', '/nodes', '/Node/light', '/', '/docs', '/docs/rpc', '/dao', '/testnet', '/qnet-wallet-extension', '/docsx',
    '/privacy', '/terms', '/support']) {
    const u = `https://aiqnet.io${path}`;
    expect([u, navigationDecision(u).reason === 'site']).toEqual([u, rule.test(path.toLowerCase())]);
  }
});

// MB2-01: a main-frame navigation that ends without committing (ERR_ABORTED: a 204, a refused navigation) still
// gets onPageFinished with its own URL; the finish events carry the URL of the page on screen instead.
it('Android: finish events name the committed page, never an aborted navigation\'s target', () => {
  const client = lib(`${ANDROID}RNCWebViewClient.java`);
  expect(client).toMatch(/doUpdateVisitedHistory \(WebView webView, String url, boolean isReload\) \{\s*super\.doUpdateVisitedHistory\(webView, url, isReload\);\s*mCommittedUrl = url;/);
  expect(client).toContain('emitFinishEvent(webView, committedUrlOr(url));');
  expect(client).toContain('emitFinishEvent(webView, committedUrlOr(failingUrl));');
  expect(client).not.toMatch(/emitFinishEvent\(webView, (url|failingUrl)\);/);
});

it('iOS: only the top frame may message the app, with WebKit\'s origin; the new architecture passes it on', () => {
  const impl = lib('apple/RNCWebViewImpl.m');
  expect(impl).toContain('if (!frame.isMainFrame || ![message.body isKindOfClass:[NSString class]]');
  expect(impl).toContain('WKSecurityOrigin *securityOrigin = frame.securityOrigin;');
  expect(impl).toContain('@"frameOrigin": frameOrigin, @"isMainFrame": @YES');
  const fabric = lib('apple/RNCWebView.mm');
  expect(fabric).toContain('data.frameOrigin = nullSafeString([dictionary valueForKey:@"frameOrigin"]);');
  expect(fabric).toContain('data.isMainFrame = static_cast<bool>([[dictionary valueForKey:@"isMainFrame"] boolValue]);');
  const spec = lib('src/RNCWebViewNativeComponent.ts');
  expect(spec).toMatch(/data: string;\s*\/\/ QNet patch[^\n]*\n\s*frameOrigin: string;\s*isMainFrame: boolean;/);
});

// MBL-01: a page's alert(), confirm() and prompt() would be native dialogs drawn over whatever the app shows —
// another tab, the lock screen — with words (and for prompt a text field) the page chose.
it('pages cannot open JavaScript dialogs on either platform: each is answered at once', () => {
  const impl = lib('apple/RNCWebViewImpl.m');
  const panel = (sel) => {
    const at = impl.indexOf(sel);
    expect(at).toBeGreaterThan(0);
    return impl.slice(at, impl.indexOf('\n}', at));
  };
  expect(panel('runJavaScriptAlertPanelWithMessage')).toMatch(/\{\s*completionHandler\(\);\s*$/);
  expect(panel('runJavaScriptConfirmPanelWithMessage')).toMatch(/\{\s*completionHandler\(NO\);\s*$/);
  expect(panel('runJavaScriptTextInputPanelWithPrompt')).toMatch(/\{\s*completionHandler\(nil\);\s*$/);
  expect(impl).not.toMatch(/UIAlertController|NSAlert/);
  const chrome = lib(`${ANDROID}RNCWebChromeClient.java`);
  expect(chrome).toMatch(/onJsAlert\(WebView view, String url, String message, JsResult result\) \{\s*result\.confirm\(\);\s*return true;\s*\}/);
  expect(chrome).toMatch(/onJsConfirm\(WebView view, String url, String message, JsResult result\) \{\s*result\.cancel\(\);\s*return true;\s*\}/);
  expect(chrome).toMatch(/onJsPrompt\(WebView view, String url, String message, String defaultValue, JsPromptResult result\) \{\s*result\.cancel\(\);\s*return true;\s*\}/);
  expect(chrome).toMatch(/onJsBeforeUnload\(WebView view, String url, String message, JsResult result\) \{\s*result\.confirm\(\);\s*return true;\s*\}/);
});

// MBR2-04: an allowed navigation uses WebKit's public policy only: no private WebKit value (App Review 2.5.1, and its
// meaning could change in any release). The app's own link host never reaches it: the JS policy cancels link.aiqnet.io
// and the wallet-only pages before (MBL-03 / CROSS-09 hold through that refusal).
it('iOS: every allowed navigation uses WebKit\'s public "allow" policy, never a private value', () => {
  const impl = lib('apple/RNCWebViewImpl.m');
  expect(impl).not.toMatch(/QNetAllowWithoutAppLink|WKNavigationActionPolicyAllow \+|AllowWithoutTryingAppLink/);
  const decide = impl.slice(impl.indexOf('decidePolicyForNavigationAction:(WKNavigationAction *)'), impl.indexOf('didStartProvisionalNavigation'));
  expect((decide.match(/^\s*decisionHandler\(WKNavigationActionPolicyAllow\);/gm) || []).length).toBe(2);
  const { navigationDecision } = require('../src/browser/url');
  for (const u of ['https://link.aiqnet.io/l#x', 'https://LINK.aiqnet.io/l', 'https://link.aiqnet.io./l']) {
    expect([u, navigationDecision(u, { topFrame: true }).allow]).toEqual([u, false]);
  }
});

// MBL-02: the address the app shows comes from committed navigations only. A navigation allowed but never
// committed (a 204, a download, WebKit 102, a cancellation) leaves the page on screen and must not move the address.
it('iOS: the load-start event is sent when a navigation commits, and events never name a provisional target', () => {
  const impl = lib('apple/RNCWebViewImpl.m');
  const decide = impl.slice(impl.indexOf('decidePolicyForNavigationAction:(WKNavigationAction *)'), impl.indexOf('didStartProvisionalNavigation'));
  expect(decide).not.toMatch(/_onLoadingStart\(/);
  const commit = impl.slice(impl.indexOf('didCommitNavigation:(WKNavigation *)navigation'));
  expect(commit.slice(0, 600)).toMatch(/_qnetCommittedURL = webView\.URL;[\s\S]*_onLoadingStart\(event\);/);
  expect(impl).toContain('_qnetProvisionalNavigation = navigation;');
  expect(impl).toContain('NSURL *shownURL = _qnetProvisionalNavigation != nil ? _qnetCommittedURL : _webView.URL;');
  expect(impl).toContain('@"url": shownURL.absoluteString ?: @""');
  // A failed or cancelled provisional navigation clears the marker and tells the app the page still shown.
  const fail = impl.slice(impl.indexOf('didFailProvisionalNavigation:(WKNavigation *)navigation'));
  expect(fail.slice(0, 900)).toMatch(/_qnetProvisionalNavigation = nil;[\s\S]*_onLoadingFinish\(\[self baseEvent\]\);/);
});

// MB4-01: below iOS 18.4 WebKit asks the app nothing before its upload sheet, so two document-start scripts stop file
// inputs: one in the page's world (it can patch what the page uses, and watches every shadow root the page attaches,
// open or closed), one in the app's own content world (the page can neither see nor undo it). Both run here, as they
// are compiled into the installed library, against a small DOM with shadow roots.
describe('iOS below 18.4: file inputs cannot open the upload sheet, shadow roots included', () => {
  // The JS text of the Objective-C string literal `name` in RNCWebViewImpl.m.
  const scriptOf = (name) => {
    const impl = lib('apple/RNCWebViewImpl.m').replace(/\r\n/g, '\n');
    const at = impl.indexOf(`NSString *${name} =`);
    expect(at).toBeGreaterThan(0);
    const lines = impl.slice(at, impl.indexOf('";\n', at) + 2).split('\n').slice(1);
    return lines.map((l) => JSON.parse(`"${/^\s*@?"((?:[^"\\]|\\.)*)"/.exec(l)[1]}"`)).join('');
  };

  // A DOM just big enough: elements, open and closed shadow roots, childList MutationObservers (not crossing a shadow
  // boundary, as in a browser), and click dispatch with capture and bubble phases and a composed path that hides the
  // inside of a closed shadow root from listeners outside it.
  function makeDom() {
    const observers = [];
    class Node {
      constructor() { this.children = []; this.parent = null; this.listeners = []; }
      addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture: capture === true || !!(capture && capture.capture) }); }
      appendChild(child) {
        child.parent = this;
        this.children.push(child);
        for (const o of observers) {
          let n = this;
          while (n && n !== o.target) n = n instanceof ShadowRoot ? null : n.parent;
          if (n) Promise.resolve().then(() => o.cb([{ type: 'childList', target: this, addedNodes: [child] }]));
        }
        return child;
      }
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
        walk(this);
        return out;
      }
    }
    class Element extends Node {
      constructor(tag, type = '') { super(); this.tagName = tag.toUpperCase(); this.type = type; this.disabled = false; this.shadowRoot = null; }
    }
    class ShadowRoot extends Node {
      constructor(host, mode) { super(); this.host = host; this.mode = mode; }
    }
    Element.prototype.attachShadow = function attachShadow({ mode }) {
      const root = new ShadowRoot(this, mode);
      if (mode === 'open') this.shadowRoot = root;
      return root;
    };
    class HTMLInputElement extends Element {
      constructor(type) { super('input', type); }
    }
    // The platform's own picker: what a file input's click() or showPicker() would open.
    HTMLInputElement.prototype.click = function click() { this.pickerOpened = true; };
    HTMLInputElement.prototype.showPicker = function showPicker() { this.pickerOpened = true; };
    const matches = (n, sel) => (sel === '*' ? n instanceof Element
      : sel === 'input[type=file]' ? n.tagName === 'INPUT' && String(n.type).toLowerCase() === 'file' : false);
    class MutationObserver {
      constructor(cb) { this.cb = cb; }
      observe(target) { observers.push({ target, cb: this.cb }); }
    }
    const document = new Node();
    const window = new Node();
    Object.assign(window, { document, HTMLInputElement, Element, MutationObserver });
    const closedRoots = (n) => {
      const out = [];
      for (let x = n; x; x = x instanceof ShadowRoot ? x.host : x.parent) if (x instanceof ShadowRoot && x.mode === 'closed') out.push(x);
      return out;
    };
    const click = (target) => {
      const path = [];
      for (let n = target; n; n = n instanceof ShadowRoot ? n.host : n.parent) path.push(n);
      path.push(window);
      const event = {
        type: 'click', target, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
      };
      const run = (at, capture) => {
        const inside = new Set(closedRoots(at));
        event.composedPath = () => path.filter((p) => closedRoots(p).every((r) => inside.has(r) || r === at));
        for (const l of at.listeners) {
          if (l.type === 'click' && l.capture === capture) { l.fn(event); if (event.stopped) return true; }
        }
        return false;
      };
      for (const at of [...path].reverse()) if (run(at, true)) return event;
      for (const at of path) if (run(at, false)) return event;
      return event;
    };
    return { window, document, Element, HTMLInputElement, MutationObserver, click };
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));
  const install = (dom, name) => new Function('window', 'document', 'MutationObserver', scriptOf(name))(dom.window, dom.document, dom.MutationObserver);

  it('in the page\'s world: file inputs in the document and in every shadow root, open or closed', async () => {
    const dom = makeDom();
    install(dom, 'noFilePickerSource');
    let pageSawClick = 0;
    dom.document.addEventListener('click', () => { pageSawClick += 1; });

    const plain = dom.document.appendChild(new dom.HTMLInputElement('file'));
    const text = dom.document.appendChild(new dom.HTMLInputElement('text'));
    for (const mode of ['open', 'closed']) {
      const host = dom.document.appendChild(new dom.Element('upload-button'));
      const root = host.attachShadow({ mode });
      const inner = root.appendChild(new dom.HTMLInputElement('FILE'));
      await settle();
      expect([mode, inner.disabled]).toEqual([mode, true]);
      const ev = dom.click(inner);
      expect([mode, ev.defaultPrevented, ev.stopped]).toEqual([mode, true, true]);
      inner.click();
      inner.showPicker();
      expect([mode, !!inner.pickerOpened]).toEqual([mode, false]);
    }
    await settle();
    expect(plain.disabled).toBe(true);
    expect(dom.click(plain).defaultPrevented).toBe(true);
    expect(pageSawClick).toBe(0);
    // Everything else keeps working.
    text.click();
    expect(text.pickerOpened).toBe(true);
    expect(text.disabled).toBe(false);
    expect(dom.click(text).defaultPrevented).toBe(false);
    expect(pageSawClick).toBe(1);
  });

  it('in the app\'s own world, which the page cannot undo: file inputs under open shadow roots, and their labels', async () => {
    const dom = makeDom();
    const impl = lib('apple/RNCWebViewImpl.m').replace(/\r\n/g, '\n');
    expect(impl).toContain('inContentWorld:[WKContentWorld defaultClientWorld]];\n  [wkWebViewConfig.userContentController addUserScript:noFilePickerGuard];');
    // A component whose shadow root already holds a file input when it is added to the document.
    const host = new dom.Element('file-drop');
    const root = host.attachShadow({ mode: 'open' });
    const inner = root.appendChild(new dom.HTMLInputElement('file'));
    install(dom, 'noFilePickerGuardSource');
    dom.document.appendChild(host);
    await settle();
    expect(inner.disabled).toBe(true);
    expect(dom.click(inner).defaultPrevented).toBe(true);
    const label = dom.document.appendChild(new dom.Element('label'));
    label.control = dom.document.appendChild(new dom.HTMLInputElement('file'));
    expect(dom.click(label).defaultPrevented).toBe(true);
    expect(dom.click(dom.document.appendChild(new dom.Element('button'))).defaultPrevented).toBe(false);
  });

  it('the patch carries both scripts, the camera text is declared once (for the scan on the Send screen), and the browser says what holds', () => {
    const patch = fs.readFileSync(PATCH, 'utf8');
    for (const line of ['+  NSString *noFilePickerSource =', '+  NSString *noFilePickerGuardSource =',
      "+     \"  if (eproto && eproto.attachShadow) {\\n\""]) {
      expect([line, patch.includes(line)]).toEqual([line, true]);
    }
    const plist = fs.readFileSync(path.join(ROOT, 'ios', 'QNetMobile', 'Info.plist'), 'utf8');
    expect(plist.match(/<key>NSCameraUsageDescription<\/key>/g)).toHaveLength(1);
    expect(fs.readFileSync(path.join(ROOT, 'src', 'browser', 'BrowserScreen.js'), 'utf8'))
      .toMatch(/One limit, on iOS below 18\.4 only/);
  });
});

it('JS: a URL outside the whitelist is blocked, never opened in another app (source and build)', () => {
  for (const f of ['src/WebViewShared.tsx', 'lib/WebViewShared.js']) {
    expect([f, /Linking\.(openURL|canOpenURL)/.test(lib(f))]).toEqual([f, false]);
  }
});

it('the patch file holds every one of these changes, so a fresh install reproduces them', () => {
  const patch = fs.readFileSync(PATCH, 'utf8');
  for (const file of [
    `${ANDROID}RNCWebView.java`, `${ANDROID}RNCWebViewClient.java`, `${ANDROID}RNCWebChromeClient.java`,
    `${ANDROID}RNCWebViewManagerImpl.kt`, 'apple/RNCWebViewImpl.m', 'apple/RNCWebView.mm',
    'src/RNCWebViewNativeComponent.ts', 'src/WebViewShared.tsx', 'lib/WebViewShared.js',
  ]) {
    expect([file, patch.includes(`diff --git a/node_modules/react-native-webview/${file}`)]).toEqual([file, true]);
  }
  for (const line of [
    '+              if (!isMainFrame || data == null || !isAllowedMessageOrigin(sourceOrigin)) {',
    '-            addJavascriptInterface(fallbackBridge, JAVASCRIPT_INTERFACE);',
    '+        request.deny();',
    '+    protected static boolean isAllowedNavigation(Uri uri, boolean isMainFrame) {',
    '+                data.frameOrigin = nullSafeString([dictionary valueForKey:@"frameOrigin"]);',
    '+// QNet patch: an allowed navigation gets WebKit\'s public policy, WKNavigationActionPolicyAllow; no private WebKit value',
    '+- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation',
    '+  completionHandler(nil);',
    '+    public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {',
  ]) {
    expect([line, patch.includes(line)]).toEqual([line, true]);
  }
});
