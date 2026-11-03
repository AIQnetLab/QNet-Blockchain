/**
 * A launch the system makes in the background (a push, the periodic wake) costs the wake as little as it can: the push
 * and fetch handlers are registered before any of the app's screens load, and the app draws nothing and loads no screen
 * until the first open.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';

const mockLoaded = [];
jest.mock('../src/screens/WalletScreen', () => {
  mockLoaded.push('WalletScreen');
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: () => R.createElement(Text, null, 'wallet') };
});
jest.mock('../src/i18n/direction', () => {
  mockLoaded.push('direction');
  return { settleLayoutDirection: jest.fn(async () => true) };
});
// No native view gives the provider insets here; it draws its children at once.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  SafeAreaProvider: ({ children }) => children,
}));
jest.mock('../src/services/PushService', () => ({
  initializePushService: jest.fn(async () => {}),
  handlePushMessage: jest.fn(async () => true),
  backgroundRefreshFcmToken: jest.fn(async () => {}),
  onBackgroundFetch: jest.fn(async () => {}),
}));

describe('index.js', () => {
  it('registers the push and fetch handlers with none of the app\'s screens loaded; they load when the app\'s view runs', () => {
    const order = [];
    jest.isolateModules(() => {
      jest.doMock('../src/polyfills/crypto-install', () => ({}));
      jest.doMock('react-native-get-random-values', () => ({}));
      jest.doMock('../App', () => {
        order.push('App');
        return { __esModule: true, default: 'App' };
      });
      const { AppRegistry } = require('react-native');
      const register = jest.spyOn(AppRegistry, 'registerComponent').mockImplementation(() => 'QNetMobile');
      require('@react-native-firebase/messaging').default().setBackgroundMessageHandler.mockImplementation(() => order.push('push'));
      require('react-native-background-fetch').default.registerHeadlessTask = jest.fn(() => order.push('fetch'));
      try {
        require('../index');
        expect(order).toEqual(['push', 'fetch']);
        const [[name, provider]] = register.mock.calls;
        expect(name).toBe('QNetMobile');
        expect(provider()).toBe('App');
        expect(order).toEqual(['push', 'fetch', 'App']);
      } finally {
        register.mockRestore();
        for (const m of ['../src/polyfills/crypto-install', 'react-native-get-random-values', '../App']) jest.dontMock(m);
      }
    });
  });
});

describe('App', () => {
  const { AppState } = require('react-native');
  const Push = require('../src/services/PushService');
  let listeners;
  let saved;
  let spy;
  beforeEach(() => {
    listeners = [];
    saved = AppState.currentState;
    spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
      if (type === 'change') listeners.push(handler);
      return { remove: jest.fn() };
    });
  });
  afterEach(() => {
    AppState.currentState = saved;
    spy.mockRestore();
  });

  it('a process started in the background draws nothing and loads no screen until the first open, with its wakes armed', async () => {
    const { Linking } = require('react-native');
    const linkSpy = jest.spyOn(Linking, 'addEventListener');
    AppState.currentState = 'background';
    const App = require('../App').default;
    let tree;
    await act(async () => { tree = renderer.create(React.createElement(App)); });
    expect(tree.toJSON()).toBe(null);
    expect(mockLoaded).toEqual([]);
    expect(Push.initializePushService).toHaveBeenCalledTimes(1);
    // The user opens the app: the wallet screen loads and starts. A link that came meanwhile waited in the native link
    // inbox, which the wallet screen reads once it is up (LinkInbox.test.js); the app itself listens for none.
    AppState.currentState = 'active';
    await act(async () => { listeners.forEach((h) => h('active')); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // the layout's direction settles
    expect(mockLoaded).toEqual(expect.arrayContaining(['WalletScreen', 'direction']));
    expect(JSON.stringify(tree.toJSON())).toContain('wallet');
    expect(linkSpy).not.toHaveBeenCalled();
    linkSpy.mockRestore();
    // Back in the background it stays drawn: only a process started there waits.
    AppState.currentState = 'background';
    await act(async () => { listeners.forEach((h) => h('background')); });
    expect(JSON.stringify(tree.toJSON())).toContain('wallet');
    await act(async () => { tree.unmount(); });
  });
});
