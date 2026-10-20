// Deleting or replacing the wallet wipes what the in-app browser left on the device (L-6): cookies, site storage and the
// web caches, the same on Android and iOS, best effort, and never holding up the erase. Android also clears the app's
// image cache, and its own network reads are never cached on disk.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function withNative(os, native) {
  let DS;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: os }, NativeModules: { QNetSecurity: native } }));
    DS = require('../src/services/DeviceSecurity');
    jest.dontMock('react-native');
  });
  return DS;
}

describe('DeviceSecurity clearBrowserData', () => {
  it('asks the native module on both platforms; a missing method or a failure is false, never a throw', async () => {
    for (const os of ['android', 'ios']) {
      const native = { clearWebData: jest.fn(async () => true) };
      expect(await withNative(os, native).clearBrowserData()).toBe(true);
      expect(native.clearWebData).toHaveBeenCalledTimes(1);
      expect(await withNative(os, {}).clearBrowserData()).toBe(false);
      expect(await withNative(os, { clearWebData: jest.fn(async () => { throw new Error('no web view'); }) }).clearBrowserData()).toBe(false);
    }
  });
});

describe('Delete wallet and a wallet that replaces another', () => {
  const DeviceSecurity = require('../src/services/DeviceSecurity');
  const { WalletManager } = require('../src/components/WalletManager');

  it('eraseAllData and wipeWalletScope start the wipe and do not wait for it', async () => {
    // A wipe that never ends: the erase finishes all the same.
    const wipe = jest.spyOn(DeviceSecurity, 'clearBrowserData').mockImplementation(() => new Promise(() => {}));
    try {
      await new WalletManager().eraseAllData();
      expect(wipe).toHaveBeenCalledTimes(1);
      await new WalletManager().wipeWalletScope();
      expect(wipe).toHaveBeenCalledTimes(2);
    } finally {
      wipe.mockRestore();
    }
  });

  it('every way the wallet leaves this device goes through one of them', () => {
    const ws = read('src/screens/WalletScreen.js');
    const erase = ws.slice(ws.indexOf('const eraseWallet = async () => {'), ws.indexOf('const deleteWallet = async () => {'));
    expect(erase).toMatch(/await walletManager\.eraseAllData\(\);/);
    const wm = read('src/components/WalletManager.js');
    const store = wm.slice(wm.indexOf('async storeWallet(walletData, password'), wm.indexOf('async storeWallet(walletData, password') + 1500);
    expect(store).toMatch(/await this\.wipeWalletScope\(\);/);
  });
});

describe('the native halves, alike', () => {
  it('Android: every cookie, all site storage, the web view cache and form data, on the main thread, never a throw', () => {
    const kt = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');
    const fn = kt.slice(kt.indexOf('fun clearWebData(promise: Promise)'));
    expect(fn).toMatch(/main\.post \{/);
    expect(fn).toMatch(/CookieManager\.getInstance\(\)/);
    expect(fn).toMatch(/cookies\.removeAllCookies\(null\)/);
    expect(fn).toMatch(/WebStorage\.getInstance\(\)\.deleteAllData\(\)/);
    expect(fn).toMatch(/clearCache\(true\)/);
    expect(fn).toMatch(/catch \(_: Throwable\) \{\s*promise\.resolve\(false\)/);
    // The app's own images (an asset icon from the network) leave the image cache, memory and disk.
    expect(fn).toMatch(/runCatching \{ if \(Fresco\.hasBeenInitialized\(\)\) Fresco\.getImagePipeline\(\)\.clearCaches\(\) \}/);
    // React Native's HTTP cache is never written (the cache-less client) and goes once at start, not here.
    expect(kt).not.toMatch(/http-cache|HTTP_CACHE_DIR/);
  });

  it('Android: the app\'s own network reads are never kept on disk; a cache an earlier build left is deleted at start', () => {
    const app = read('android/app/src/main/java/com/qnetmobile/MainApplication.kt');
    // React Native's client caches 10 MB of answers under cacheDir/http-cache; the factory's client has no cache.
    expect(app).toMatch(/OkHttpClientProvider\.setOkHttpClientFactory \{ OkHttpClientProvider\.createClientBuilder\(\)\.build\(\) \}/);
    expect(app.indexOf('setOkHttpClientFactory')).toBeLessThan(app.indexOf('loadReactNative(this)'));
    expect(app).toMatch(/Thread \{ File\(cacheDir, HTTP_CACHE_DIR\)\.deleteRecursively\(\) \}\.start\(\)/);
    expect(app).toMatch(/const val HTTP_CACHE_DIR = "http-cache"/);
    const provider = read('node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/network/OkHttpClientProvider.kt');
    expect(provider).toMatch(/val cacheDirectory = File\(context\.cacheDir, "http-cache"\)/);
    expect(provider).toMatch(/return factory\?\.createNewNetworkModuleClient\(\) \?: createClientBuilder\(context\)\.build\(\)/);
  });

  it('iOS: every kind of data in the default web data store', () => {
    const m = read('ios/QNetMobile/QNetSecurityModule.m');
    expect(m).toMatch(/#import <WebKit\/WebKit\.h>/);
    const fn = m.slice(m.indexOf('RCT_EXPORT_METHOD(clearWebData:'));
    expect(fn).toMatch(/\[WKWebsiteDataStore defaultDataStore\]/);
    expect(fn).toMatch(/removeDataOfTypes:\[WKWebsiteDataStore allWebsiteDataTypes\]\s+modifiedSince:\[NSDate distantPast\]/);
    expect(fn).toMatch(/resolve\(@YES\)/);
  });
});
