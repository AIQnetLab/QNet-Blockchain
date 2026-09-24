// The Play build must not start a node activation (Google Play billing policy); every other build does.
const load = (os, store, extra = {}) => {
  jest.resetModules();
  jest.doMock('react-native', () => ({
    Platform: { OS: os },
    NativeModules: store === undefined ? {} : { QNetStore: { STORE: store, ...extra } },
  }));
  return require('../src/config/store');
};

it('the Google Play build activates nothing in the app', () => {
  expect(load('android', 'play')).toMatchObject({ STORE: 'play', IN_APP_ACTIVATION: false });
});

it('the site APK and iOS keep in-app activation', () => {
  expect(load('android', 'site')).toMatchObject({ STORE: 'site', IN_APP_ACTIVATION: true });
  expect(load('ios', undefined)).toMatchObject({ STORE: 'ios', IN_APP_ACTIVATION: true });
});

it('an Android build that cannot name its flavor keeps activation off', () => {
  expect(load('android', undefined)).toMatchObject({ STORE: 'play', IN_APP_ACTIVATION: false });
});

it('reports the installed version from the native module', () => {
  expect(load('android', 'site', { VERSION_CODE: 18, VERSION_NAME: '1.1.7' }))
    .toMatchObject({ APP_VERSION_CODE: 18, APP_VERSION_NAME: '1.1.7' });
  expect(load('ios', undefined)).toMatchObject({ APP_VERSION_CODE: 0, APP_VERSION_NAME: '' });
});
