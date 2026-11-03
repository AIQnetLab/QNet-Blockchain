/**
 * The retries that wait on a back-off for aiqnet.io (a QNet Link answer being delivered, the request's reads, a
 * registration being sent) try again at once when the network comes back or the app comes to the front, and keep their
 * back-off otherwise (utils/pause retryPause, services/NetworkWake). One signal: the platform's network watch
 * (Android's AppNetwork.kt, iOS's AppNetwork.swift) told to JS, and the app's return to the front.
 */
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const ticks = async (n = 5) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };

describe('the back-off', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] }); });
  afterEach(() => { jest.useRealTimers(); });

  it('ends after its time, or at once when woken; a plain pause is never woken', async () => {
    const { pause, retryPause, wakeRetries } = require('../src/utils/pause');
    const ended = [];
    retryPause(2000).then(() => ended.push('first'));
    retryPause(30000).then(() => ended.push('second'));
    pause(2000).then(() => ended.push('pause'));
    jest.advanceTimersByTime(1999);
    await ticks();
    expect(ended).toEqual([]);
    jest.advanceTimersByTime(1);
    await ticks();
    expect(ended).toEqual(['first', 'pause']);
    wakeRetries();
    await ticks();
    expect(ended).toEqual(['first', 'pause', 'second']);
    // Nothing is left behind: a woken back-off's timer is gone.
    expect(jest.getTimerCount()).toBe(0);
    wakeRetries();
    await ticks();
    expect(ended).toHaveLength(3);
  });

  // A retry that fails again after a wake waits its first pause, never the doubled one it had reached (up to 30 s).
  it('doubles up to its cap, and after a wake during a pause or a try starts again from its first pause', async () => {
    const { retryBackoff, wakeRetries } = require('../src/utils/pause');
    const b = retryBackoff(2000, 30000);
    const waited = [];
    // One failed try and the pause after it, on the fake clock: the whole pause, or a wake half way through it.
    const failedTry = async (wake = false) => {
      b.trying();
      const ms = b.nextMs();
      const paused = b.pause();
      jest.advanceTimersByTime(wake ? ms / 2 : ms);
      if (wake) wakeRetries();
      await paused;
      waited.push(ms);
    };
    for (let i = 0; i < 6; i += 1) await failedTry();
    expect(waited).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
    await failedTry(true);
    await failedTry();
    await failedTry();
    expect(waited.slice(6)).toEqual([30000, 2000, 4000]);
    // A wake while a try runs: the pause after it is the first one too.
    b.trying();
    wakeRetries();
    expect(b.nextMs()).toBe(2000);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('what wakes it', () => {
  const { AppState, DeviceEventEmitter, NativeModules } = require('react-native');
  let listeners;
  let spy;
  beforeEach(() => {
    listeners = [];
    spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((type, fn) => {
      if (type === 'change') listeners.push(fn);
      return { remove: () => { listeners = listeners.filter((f) => f !== fn); } };
    });
    NativeModules.QNetNetwork = { addListener: jest.fn(), removeListeners: jest.fn() };
  });
  afterEach(() => {
    spy.mockRestore();
    delete NativeModules.QNetNetwork;
  });

  it('the app coming to the front and a network that appears; nothing else, and nothing once stopped', async () => {
    const { retryPause } = require('../src/utils/pause');
    const { watchWakes, NETWORK_BACK_EVENT } = require('../src/services/NetworkWake');
    const stop = watchWakes();
    const woken = (wake) => {
      let done = false;
      retryPause(60000).then(() => { done = true; });
      wake();
      return ticks().then(() => done);
    };
    expect(await woken(() => listeners.forEach((fn) => fn('active')))).toBe(true);
    expect(await woken(() => DeviceEventEmitter.emit(NETWORK_BACK_EVENT))).toBe(true);
    expect(await woken(() => listeners.forEach((fn) => fn('background')))).toBe(false);
    stop();
    expect(listeners).toEqual([]);
    expect(await woken(() => DeviceEventEmitter.emit(NETWORK_BACK_EVENT))).toBe(false);
    require('../src/utils/pause').wakeRetries();
  });

  // On the Solana site route the endpoint is tried again after a network change (services/SolanaSend).
  it('keeps the time a network last appeared, 0 before the first; the app coming to the front is no network change', () => {
    jest.isolateModules(() => { expect(require('../src/services/NetworkWake').lastNetworkBack()).toBe(0); });
    const { watchWakes, lastNetworkBack, NETWORK_BACK_EVENT } = require('../src/services/NetworkWake');
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const stop = watchWakes();
    try {
      DeviceEventEmitter.emit(NETWORK_BACK_EVENT);
      expect(lastNetworkBack()).toBe(1_800_000_000_000);
      now.mockReturnValue(1_800_000_060_000);
      listeners.forEach((fn) => fn('active'));
      expect(lastNetworkBack()).toBe(1_800_000_000_000);
      DeviceEventEmitter.emit(NETWORK_BACK_EVENT);
      expect(lastNetworkBack()).toBe(1_800_000_060_000);
    } finally {
      stop();
      now.mockRestore();
    }
  });

  it('starts with the JS, before anything runs, and the native side tells it under the same name', () => {
    const index = read('index.js');
    expect(index).toMatch(/import \{ watchWakes \} from '\.\/src\/services\/NetworkWake';/);
    expect(index.indexOf('watchWakes();')).toBeGreaterThan(-1);
    expect(index.indexOf('watchWakes();')).toBeLessThan(index.indexOf('setBackgroundMessageHandler'));
    const { NETWORK_BACK_EVENT } = require('../src/services/NetworkWake');
    const kt = read('android/app/src/main/java/com/qnetmobile/AppNetwork.kt');
    expect(kt).toContain(`const val NETWORK_BACK = "${NETWORK_BACK_EVENT}"`);
    expect(kt).toMatch(/override fun getName\(\): String = "QNetNetwork"/);
    expect(kt).toMatch(/AppNetwork\.networkBack = tell/);
    expect(read('android/app/src/main/java/com/qnetmobile/DilithiumPackage.kt')).toMatch(/AppNetworkModule\(reactContext\)/);
  });

  // iOS tells a network that appears as Android does, so its retries never wait for the return to the front. Its module
  // (AppNetwork.swift, NWPathMonitor) is not compiled in this repository's checks; these pins hold its name, event and
  // registration.
  it('a network that appears wakes it on iOS as on Android: the same module and event, registered in the iOS project', async () => {
    const { Platform } = require('react-native');
    const { retryPause } = require('../src/utils/pause');
    const { watchWakes, NETWORK_BACK_EVENT } = require('../src/services/NetworkWake');
    const os = Platform.OS;
    try {
      for (const p of ['ios', 'android']) {
        Platform.OS = p;
        const stop = watchWakes();
        let done = false;
        retryPause(60000).then(() => { done = true; });
        DeviceEventEmitter.emit(NETWORK_BACK_EVENT);
        await ticks();
        stop();
        expect([p, done]).toEqual([p, true]);
      }
    } finally {
      Platform.OS = os;
    }
    const swift = read('ios/QNetMobile/AppNetwork.swift');
    expect(swift).toMatch(/@objc\(QNetNetwork\)\s*class QNetNetwork: RCTEventEmitter \{/);
    expect(swift).toContain(`static let networkBack = "${NETWORK_BACK_EVENT}"`);
    expect(swift).toMatch(/let watch = NWPathMonitor\(\)/);
    expect(swift).toMatch(/guard path\.status == \.satisfied else \{/);
    expect(swift).toMatch(/if now == current \{ return \}/);
    expect(swift).toMatch(/sendEvent\(withName: QNetNetwork\.networkBack, body: nil\)/);
    expect(swift).toMatch(/override func startObserving\(\)[\s\S]*override func stopObserving\(\)/);
    // RCTEventEmitter and RCTViewManager adopt RCTBridgeModule, so Swift takes requiresMainQueueSetup as inherited there.
    const seen = [];
    for (const f of fs.readdirSync(path.join(__dirname, '../ios/QNetMobile')).filter((n) => n.endsWith('.swift'))) {
      for (const m of read(`ios/QNetMobile/${f}`).matchAll(/^(?:final )?class (\w+): (\w+)[^{]*\{([\s\S]*?)^\}/gm)) {
        const decl = /^\s*(?:@objc )?(override )?static func requiresMainQueueSetup\(\)/m.exec(m[3]);
        if (decl) seen.push([m[1], !!decl[1], m[2] !== 'NSObject']);
      }
    }
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (const [name, override, rct] of seen) expect([name, override]).toEqual([name, rct]);
    expect(read('ios/QNetMobile/QNetNetwork.m')).toMatch(/@interface RCT_EXTERN_MODULE\(QNetNetwork, RCTEventEmitter\)\s*@end/);
    const pbx = read('ios/QNetMobile.xcodeproj/project.pbxproj');
    for (const f of ['AppNetwork.swift', 'QNetNetwork.m']) {
      expect([f, pbx.includes(`/* ${f} in Sources */,`), pbx.includes(`path = QNetMobile/${f};`), pbx.includes(`/* ${f} */,`)])
        .toEqual([f, true, true, true]);
    }
  });

  it('the retries for aiqnet.io wait on it; the light client and the node answers keep their own pause', () => {
    for (const f of ['src/services/QNetLink.js', 'src/services/RegistrationSubmit.js']) {
      expect([f, (read(f).match(/sleep = retryPause/g) || []).length > 0, /sleep = pause\b/.test(read(f))]).toEqual([f, true, false]);
    }
    expect((read('src/services/QNetLink.js').match(/sleep = retryPause/g) || []).length).toBe(3);
    for (const f of ['src/crypto/QcLightClient.js', 'src/services/PushService.js']) expect([f, read(f).includes('retryPause')]).toEqual([f, false]);
  });
});
