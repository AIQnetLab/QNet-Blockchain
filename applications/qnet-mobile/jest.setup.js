/**
 * Native modules have no JS implementation under Jest, so anything that touches one at import time
 * throws before a test runs. Mock the ones the app graph pulls in; the pure crypto/consensus code the
 * suite actually pins is untouched by these.
 */
// One instance, so a test can see which calls reached it (a token taken, a token deleted).
jest.mock('@react-native-firebase/messaging', () => {
  const instance = {
    requestPermission: jest.fn().mockResolvedValue(1),
    registerDeviceForRemoteMessages: jest.fn().mockResolvedValue(undefined),
    getToken: jest.fn().mockResolvedValue('test-fcm-token'),
    onMessage: jest.fn(() => jest.fn()),
    onTokenRefresh: jest.fn(() => jest.fn()),
    onNotificationOpenedApp: jest.fn(() => jest.fn()),
    getInitialNotification: jest.fn().mockResolvedValue(null),
    setBackgroundMessageHandler: jest.fn(),
    deleteToken: jest.fn().mockResolvedValue(undefined),
  };
  const messaging = () => instance;
  messaging.AuthorizationStatus = { AUTHORIZED: 1, PROVISIONAL: 2, DENIED: 0 };
  return { __esModule: true, default: messaging };
});

jest.mock('react-native-background-fetch', () => ({
  __esModule: true,
  default: {
    configure: jest.fn().mockResolvedValue(2), // STATUS_AVAILABLE; iOS rejects with 0 or 1 instead
    finish: jest.fn(),
    stop: jest.fn(),
    scheduleTask: jest.fn().mockResolvedValue(undefined),
    status: jest.fn().mockResolvedValue(2),
    STATUS_AVAILABLE: 2,
    NETWORK_TYPE_ANY: 0,
  },
}));

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn().mockResolvedValue(true),
  getGenericPassword: jest.fn().mockResolvedValue(false),
  hasGenericPassword: jest.fn().mockResolvedValue(false),
  resetGenericPassword: jest.fn().mockResolvedValue(true),
  getAllGenericPasswordServices: jest.fn().mockResolvedValue([]),
  getSupportedBiometryType: jest.fn().mockResolvedValue(null),
  isPasscodeAuthAvailable: jest.fn().mockResolvedValue(false),
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  },
  ACCESS_CONTROL: {
    BIOMETRY_ANY_OR_DEVICE_PASSCODE: 'BiometryAnyOrDevicePasscode',
    BIOMETRY_CURRENT_SET: 'BiometryCurrentSet',
  },
}));

jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: { setString: jest.fn(), getString: jest.fn().mockResolvedValue('') },
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

// The in-app browser's WebView is native. A host component that keeps its props, with the ref methods the
// browser calls, lets tests drive it (props.onMessage, props.onShouldStartLoadWithRequest …).
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  const WebView = React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => {
      const methods = {};
      for (const m of ['goBack', 'goForward', 'reload', 'stopLoading', 'injectJavaScript', 'clearCache', 'clearHistory']) {
        methods[m] = (...args) => (WebView.calls.push([m, ...args]), undefined);
      }
      return methods;
    });
    return React.createElement(View, { ...props, testID: 'webview' });
  });
  WebView.calls = [];
  return { __esModule: true, default: WebView, WebView };
});
