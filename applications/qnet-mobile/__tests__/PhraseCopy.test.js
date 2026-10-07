// The recovery phrase's Copy: on an explicit tap only, taken off the clipboard after 60 seconds if it is still there,
// and at once when the wallet is deleted. The native side does the timing (iOS: a local-only pasteboard item with an
// expiry; Android: a sensitive clip and a native timer); without it, the plain clipboard and a JS timer.
const fs = require('fs');
const path = require('path');
const Clipboard = require('@react-native-clipboard/clipboard').default;

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

function withNative(os, native) {
  let DS;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: os }, NativeModules: { QNetSecurity: native } }));
    DS = require('../src/services/DeviceSecurity');
    jest.dontMock('react-native');
  });
  return DS;
}

beforeEach(() => {
  Clipboard.setString.mockClear();
  Clipboard.getString.mockReset();
  Clipboard.getString.mockResolvedValue('');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('DeviceSecurity copySecret / clearSecretCopy', () => {
  it('hands the phrase and the 60 seconds to the native module on both platforms, never the plain clipboard', async () => {
    for (const os of ['android', 'ios']) {
      const native = { copySecret: jest.fn(async () => true), clearSecretCopy: jest.fn(async () => null) };
      const DS = withNative(os, native);
      expect(DS.SECRET_CLIPBOARD_SECONDS).toBe(60);
      expect(await DS.copySecret(PHRASE)).toBe(true);
      expect(native.copySecret).toHaveBeenCalledWith(PHRASE, 60);
      await DS.clearSecretCopy();
      expect(native.clearSecretCopy).toHaveBeenCalledTimes(1);
    }
    expect(Clipboard.setString).not.toHaveBeenCalled();
  });

  it('a native refusal or failure is "not copied"; an empty phrase is never copied', async () => {
    expect(await withNative('android', { copySecret: jest.fn(async () => false) }).copySecret(PHRASE)).toBe(false);
    expect(await withNative('ios', { copySecret: jest.fn(async () => { throw new Error('x'); }) }).copySecret(PHRASE)).toBe(false);
    const native = { copySecret: jest.fn(async () => true) };
    expect(await withNative('android', native).copySecret('')).toBe(false);
    expect(native.copySecret).not.toHaveBeenCalled();
  });

  it('without the native method: cleared after 60 s if the clipboard still holds the phrase, kept if something else came', async () => {
    jest.useFakeTimers();
    let DS = withNative('android', {});
    expect(await DS.copySecret(PHRASE)).toBe(true);
    expect(Clipboard.setString).toHaveBeenCalledWith(PHRASE);
    Clipboard.setString.mockClear();
    Clipboard.getString.mockResolvedValue(PHRASE);
    jest.advanceTimersByTime(59_000);
    await Promise.resolve();
    expect(Clipboard.setString).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_000);
    await new Promise(jest.requireActual('timers').setImmediate);
    expect(Clipboard.setString).toHaveBeenCalledWith('');

    DS = withNative('android', {});
    await DS.copySecret(PHRASE);
    Clipboard.setString.mockClear();
    Clipboard.getString.mockResolvedValue('an address copied later');
    jest.advanceTimersByTime(60_000);
    await new Promise(jest.requireActual('timers').setImmediate);
    expect(Clipboard.setString).not.toHaveBeenCalled();
  });

  it('without the native method: Delete wallet clears it at once', async () => {
    const DS = withNative('ios', {});
    await DS.copySecret(PHRASE);
    Clipboard.setString.mockClear();
    Clipboard.getString.mockResolvedValue(PHRASE);
    await DS.clearSecretCopy();
    expect(Clipboard.setString).toHaveBeenCalledWith('');
  });
});

describe('Delete wallet', () => {
  it('eraseAllData takes a copied phrase off the clipboard', async () => {
    const DeviceSecurity = require('../src/services/DeviceSecurity');
    const { WalletManager } = require('../src/components/WalletManager');
    const clear = jest.spyOn(DeviceSecurity, 'clearSecretCopy');
    try {
      await new WalletManager().eraseAllData();
      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      clear.mockRestore();
    }
  });
});

describe('the native halves', () => {
  it('Android: a clip marked sensitive, cleared by a native timer if it is still the one copied', () => {
    const kt = read('android/app/src/main/java/com/qnetmobile/SecurityModule.kt');
    expect(kt).toMatch(/private const val CLIP_IS_SENSITIVE = "android\.content\.extra\.IS_SENSITIVE"/);
    expect(kt).toMatch(/fun copySecret\(text: String, seconds: Double, promise: Promise\)/);
    expect(kt).toMatch(/clip\.description\.extras = PersistableBundle\(\)\.apply \{ putBoolean\(CLIP_IS_SENSITIVE, true\) \}/);
    expect(kt).toMatch(/main\.postDelayed\(secretCopyExpiry, \(seconds \* 1000\)\.toLong\(\)/);
    expect(kt).toMatch(/fun clearSecretCopy\(promise: Promise\)/);
    expect(kt).toMatch(/description == null \|\| description\.timestamp == stamp/);
  });

  it('iOS: this device only, with the expiry on the pasteboard item; Delete wallet clears it if nothing came after', () => {
    const m = read('ios/QNetMobile/QNetSecurityModule.m');
    expect(m).toMatch(/RCT_EXPORT_METHOD\(copySecret:\(NSString \*\)text\s+seconds:\(double\)seconds/);
    expect(m).toMatch(/UIPasteboardOptionLocalOnly : @YES/);
    expect(m).toMatch(/UIPasteboardOptionExpirationDate : \[NSDate dateWithTimeIntervalSinceNow:MAX\(seconds, 0\)\]/);
    expect(m).toMatch(/RCT_EXPORT_METHOD\(clearSecretCopy:/);
    expect(m).toMatch(/_secretCopyCount >= 0 && board\.changeCount == _secretCopyCount/);
  });
});
