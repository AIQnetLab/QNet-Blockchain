// The site APK finds its newer releases on GitHub; Play and iOS builds never ask.
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { pickLatestWalletRelease, checkForUpdate, dismissUpdate } = require('../src/services/UpdateCheck');

const rel = (tag, extra = {}) => ({
  tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/x/releases/${tag}`,
  assets: [{ name: 'QNet-Wallet.apk', browser_download_url: `https://github.com/x/${tag}/QNet-Wallet.apk` }],
  ...extra,
});
const headersOf = (etag) => ({ get: (k) => (k.toLowerCase() === 'etag' ? etag : null) });

beforeEach(async () => { await AsyncStorage.clear(); global.fetch = jest.fn(); });

describe('picking the release', () => {
  it('takes the highest build number among wallet releases that carry the APK', () => {
    const latest = pickLatestWalletRelease([
      rel('wallet-1.1.7-18'), rel('wallet-1.1.8-19'), rel('node-v2.0.0'),
      rel('wallet-1.2.0-20', { draft: true }), rel('wallet-1.2.1-21', { prerelease: true }),
      rel('wallet-1.3.0-22', { assets: [{ name: 'other.zip', browser_download_url: 'x' }] }),
    ]);
    expect(latest).toMatchObject({ versionName: '1.1.8', versionCode: 19 });
    expect(latest.url).toContain('wallet-1.1.8-19/QNet-Wallet.apk');
  });

  it('finds nothing in an empty or malformed answer', () => {
    expect(pickLatestWalletRelease([])).toBeNull();
    expect(pickLatestWalletRelease({ message: 'rate limited' })).toBeNull();
  });
});

describe('checking', () => {
  const answer = (list, etag = 'W/"1"') =>
    global.fetch.mockResolvedValue({ ok: true, status: 200, headers: headersOf(etag), json: async () => list });

  it('offers a newer release to the site APK', async () => {
    answer([rel('wallet-1.1.8-19')]);
    const r = await checkForUpdate({ installedCode: 18, store: 'site' });
    expect(r).toMatchObject({ status: 'update', release: { versionCode: 19 } });
  });

  it('reports current when nothing is newer, and never asks from Play or iOS', async () => {
    answer([rel('wallet-1.1.7-18')]);
    expect(await checkForUpdate({ installedCode: 18, store: 'site' })).toEqual({ status: 'current' });
    expect(await checkForUpdate({ force: true, installedCode: 1, store: 'play' })).toEqual({ status: 'skipped' });
    expect(await checkForUpdate({ force: true, installedCode: 1, store: 'ios' })).toEqual({ status: 'skipped' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('asks at most every 12 hours unless forced, and keeps quiet about a dismissed version', async () => {
    answer([rel('wallet-1.1.8-19')]);
    await dismissUpdate(19);
    expect((await checkForUpdate({ installedCode: 18, store: 'site' })).status).toBe('skipped');
    expect((await checkForUpdate({ installedCode: 18, store: 'site' })).status).toBe('skipped'); // throttled
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(await checkForUpdate({ force: true, installedCode: 18, store: 'site' }))
      .toMatchObject({ status: 'update', release: { versionCode: 19 } });
  });

  it('reports a failure as failed, not as up to date, and a failed attempt still starts the 12 h wait', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 403, headers: headersOf(null), json: async () => ({}) });
    expect(await checkForUpdate({ force: true, installedCode: 18, store: 'site' })).toEqual({ status: 'failed' });
    global.fetch.mockRejectedValue(new Error('offline'));
    await AsyncStorage.clear();
    expect(await checkForUpdate({ installedCode: 18, store: 'site' })).toEqual({ status: 'failed' });
    expect((await checkForUpdate({ installedCode: 18, store: 'site' })).status).toBe('skipped');
  });

  it('sends the stored ETag and reuses the cached answer on 304', async () => {
    answer([rel('wallet-1.1.8-19')], 'W/"abc"');
    await checkForUpdate({ force: true, installedCode: 18, store: 'site' });
    global.fetch.mockResolvedValue({ ok: false, status: 304, headers: headersOf('W/"abc"'), json: async () => ({}) });
    const r = await checkForUpdate({ force: true, installedCode: 18, store: 'site' });
    expect(global.fetch.mock.calls[1][1].headers['If-None-Match']).toBe('W/"abc"');
    expect(r).toMatchObject({ status: 'update', release: { versionCode: 19 } });
  });
});
