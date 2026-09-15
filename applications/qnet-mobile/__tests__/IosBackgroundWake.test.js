/**
 * iOS runs a background wake only when the app registers it at launch and Info.plist permits it, and no
 * iOS wake is guaranteed: every wake (push, periodic fetch, app open or return) ends in the one bounded
 * self-attest round. These pin the native pairing and the device-side rules.
 */
import fs from 'fs';
import path from 'path';

jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signWithDilithium: jest.fn().mockResolvedValue('sig'),
}));

const IOS = path.join(__dirname, '..', 'ios', 'QNetMobile');

describe('iOS background wake wiring', () => {
  const plist = fs.readFileSync(path.join(IOS, 'Info.plist'), 'utf8');
  const delegate = fs.readFileSync(path.join(IOS, 'AppDelegate.swift'), 'utf8');

  it('leaves the background push and its completion to React Native Firebase', () => {
    expect(delegate).not.toMatch(/didReceiveRemoteNotification/);
  });

  it('permits the fetch task exactly when the app delegate registers it at launch', () => {
    // A permitted id with no launch handler crashes the app when iOS launches it for the task; a second
    // registration of the same id throws. So both halves ship together, and the call happens once.
    const call = 'TSBackgroundFetch.sharedInstance().didFinishLaunching()';
    expect(plist).toMatch(/<key>BGTaskSchedulerPermittedIdentifiers<\/key>\s*<array>\s*<string>com\.transistorsoft\.fetch<\/string>/);
    expect(delegate.split(call).length - 1).toBe(1);
    expect(delegate).toMatch(/^import TSBackgroundFetch$/m);
    const launch = delegate.indexOf('didFinishLaunchingWithOptions');
    const at = delegate.indexOf(call);
    expect(launch).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(launch);
    expect(at).toBeLessThan(delegate.indexOf('return true', launch));
  });

  it('declares the fetch background mode and no processing task', () => {
    const modes = plist.slice(plist.indexOf('<key>UIBackgroundModes</key>'));
    const list = modes.slice(0, modes.indexOf('</array>'));
    expect(list).toContain('<string>fetch</string>');
    expect(list).toContain('<string>remote-notification</string>');
    expect(list).not.toContain('<string>processing</string>');
  });
});

describe('device-side wake rules', () => {
  const AsyncStorage = require('@react-native-async-storage/async-storage');
  const Keychain = require('react-native-keychain');
  const BackgroundFetch = require('react-native-background-fetch').default;
  const { AppState, Platform } = require('react-native');
  const NODE = 'light_mobile_83afab763b9058fd';
  const reply = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  const settle = () => new Promise(r => setTimeout(r, 50));
  let Push;
  let resume = null;
  let calls;

  beforeAll(() => {
    jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
      if (type === 'change') resume = handler;
      return { remove: jest.fn() };
    });
    Push = require('../src/services/PushService');
  });

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    Keychain.getGenericPassword.mockResolvedValue(false);
    calls = [];
    global.fetch = jest.fn((url) => { calls.push(url); return reply(url.endsWith('/api/v1/height') ? { height: 1000 } : {}); });
  });

  it('schedules the precise polling wake on Android only', async () => {
    const nextPingTime = Math.floor(Date.now() / 1000) + 3600;
    await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ nodeId: NODE, pushType: 'polling', nextPingTime }));
    const os = Platform.OS;
    try {
      Platform.OS = 'ios';
      await Push.initializePushService();
      expect(BackgroundFetch.configure).toHaveBeenCalled();
      expect(BackgroundFetch.scheduleTask).not.toHaveBeenCalled();
      Platform.OS = 'android';
      await Push.initializePushService();
      expect(BackgroundFetch.scheduleTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'qnet-ping-check' }));
    } finally {
      Platform.OS = os;
      await settle();
    }
  });

  it('attests when the app returns to the foreground, and the hold keeps the next return silent', async () => {
    await Push.initializePushService(); // no node yet: only the listener
    expect(typeof resume).toBe('function');
    await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ nodeId: NODE, pushType: 'fcm' }));
    await AsyncStorage.setItem('qnet_ping_node_id', NODE);
    global.fetch = jest.fn((url) => {
      calls.push(url);
      if (url.endsWith('/api/v1/height')) return reply({ height: 1000 });
      if (url.includes('/api/v1/microblock/')) return reply({ previous_hash: new Array(32).fill(1) });
      return reply({});
    });
    resume('background');
    resume('active');
    await settle();
    expect(calls.filter(u => u.endsWith('/api/v1/height')).length).toBe(1); // refused (no ping key): backs off
    calls = [];
    resume('active');
    await settle();
    expect(calls).toEqual([]);
  });

  it('shares one round between concurrent wakes', async () => {
    await AsyncStorage.setItem('qnet_ping_node_id', NODE);
    await Promise.all([
      Push.selfAttestIfNeeded(NODE),
      Push.selfAttestIfNeeded(NODE),
      Push.handlePushMessage({ node_id: NODE }),
    ]);
    expect(calls.filter(u => u.endsWith('/api/v1/height')).length).toBe(1);
  });

  it('finishes a background wake inside the iOS window when the network hangs', async () => {
    jest.useFakeTimers();
    try {
      await AsyncStorage.setItem('qnet_ping_node_id', NODE);
      global.fetch = jest.fn((url, opts) => new Promise((_, reject) => {
        if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      const done = Push.onBackgroundFetch('t-hang');
      await jest.advanceTimersByTimeAsync(20000); // iOS allows about 30 s, 25 s for a push
      await done;
      expect(BackgroundFetch.finish).toHaveBeenCalledWith('t-hang');
    } finally {
      jest.useRealTimers();
    }
  });

  it('ends a push wake inside the 25 s a background push gets when the network hangs', async () => {
    jest.useFakeTimers();
    try {
      await AsyncStorage.setItem('qnet_ping_node_id', NODE);
      await AsyncStorage.setItem(`qnet_ping_dilithium_pk_${NODE}`, 'pk');
      Keychain.getGenericPassword.mockResolvedValue({ password: 'sk' });
      global.fetch = jest.fn((url, opts) => new Promise((_, reject) => {
        if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      let finished = false;
      const done = Push.handlePushMessage({ action: 'ping_response', challenge: 'c', node_id: NODE, response_url: 'http://n' })
        .then(() => { finished = true; });
      await jest.advanceTimersByTimeAsync(22000);
      expect(finished).toBe(true);
      await done;
    } finally {
      jest.useRealTimers();
    }
  });

  it('re-reads Background App Refresh when the app returns', async () => {
    await Push.initializePushService();
    BackgroundFetch.status.mockResolvedValueOnce(1);
    resume('active');
    await settle();
    expect(await AsyncStorage.getItem(Push.BG_REFRESH_STATUS_KEY)).toBe('1');
  });

  it('records the Background App Refresh status configure reports', async () => {
    await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ nodeId: NODE, pushType: 'fcm' }));
    BackgroundFetch.configure.mockRejectedValueOnce(1); // iOS: turned off for this app
    await Push.initializePushService();
    expect(await AsyncStorage.getItem(Push.BG_REFRESH_STATUS_KEY)).toBe('1');
    await Push.initializePushService();
    expect(await AsyncStorage.getItem(Push.BG_REFRESH_STATUS_KEY)).toBe('2');
    await settle();
  });
});
