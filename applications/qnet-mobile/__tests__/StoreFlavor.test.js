// The Play build must not start a node activation (Google Play billing policy); every other build does.
const load = (os, store) => {
  jest.resetModules();
  jest.doMock('react-native', () => ({
    Platform: { OS: os },
    NativeModules: store === undefined ? {} : { QNetStore: { STORE: store } },
  }));
  return require('../src/config/store');
};

it('the Google Play build activates nothing in the app', () => {
  expect(load('android', 'play')).toEqual({ STORE: 'play', IN_APP_ACTIVATION: false });
});

it('the site APK and iOS keep in-app activation', () => {
  expect(load('android', 'site')).toEqual({ STORE: 'site', IN_APP_ACTIVATION: true });
  expect(load('ios', undefined)).toEqual({ STORE: 'ios', IN_APP_ACTIVATION: true });
});

it('an Android build that cannot name its flavor keeps activation off', () => {
  expect(load('android', undefined)).toEqual({ STORE: 'play', IN_APP_ACTIVATION: false });
});
