// One Android package and the same app on every phone: the file Google Play installs is the file aiqnet.io serves, a
// build signed with the upload key runs the same code, and nothing a user sees or can do depends on the platform, the
// store or the signature. Solana is devnet only, with no prices, in every build.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const rel = (f) => path.relative(root, f).replace(/\\/g, '/');
const sources = [...walk(path.join(root, 'src')), path.join(root, 'App.tsx'), path.join(root, 'index.js')]
  .filter((f) => !f.includes(`${path.sep}locales${path.sep}`))
  .map((f) => ({ name: rel(f), text: fs.readFileSync(f, 'utf8') }));
const androidMain = walk(path.join(root, 'android', 'app', 'src', 'main'))
  .filter((f) => /\.(kt|java|xml)$/.test(f))
  .map((f) => ({ name: rel(f), text: fs.readFileSync(f, 'utf8') }));
const holding = (files, re) => files.filter((s) => re.test(s.text)).map((s) => s.name).sort();
const en = require('../src/i18n/translations').default.en;

describe('one Android package', () => {
  const gradle = read('android/app/build.gradle');

  it('the build names io.aiqnet.wallet and has no flavors; the old package only for its last update', () => {
    // com.qnetmobile only behind -PqnetLegacyMove, the one-time move notice for installs of the old package.
    expect([...gradle.matchAll(/applicationId\s+(.+)/g)].map((m) => m[1].trim()))
      .toEqual(['legacyMove ? "com.qnetmobile" : "io.aiqnet.wallet"']);
    expect(gradle).toMatch(/def legacyMove = project\.hasProperty\("qnetLegacyMove"\)/);
    expect([...gradle.matchAll(/buildConfigField\s+(.+)/g)].map((m) => m[1].trim()))
      .toEqual(['"boolean", "QNET_LEGACY_MOVE", legacyMove ? "true" : "false"']);
    for (const re of [/productFlavors/, /flavorDimensions/, /applicationIdSuffix/, /missingDimensionStrategy/]) {
      expect([String(re), re.test(gradle)]).toEqual([String(re), false]);
    }
    // Tests beside the one main source set; no flavor's source set.
    expect(fs.readdirSync(path.join(root, 'android', 'app', 'src')).sort()).toEqual(['androidTest', 'main', 'metroDebug', 'test']);
  });

  it('a release build still waits for the light-client pin check and the bundle scan', () => {
    expect(gradle).toMatch(/task\.name == "preReleaseBuild"\) task\.dependsOn\(qnetReleaseCheck, qnetBundleCheck\)/);
    expect(gradle).toMatch(/commandLine\(\["node", "scripts\/bundle-check\.js", "--platform", "android"\] \+ \(legacyMove \? \["--legacy"\] : \[\]\)\)/);
  });

  it('the old package\'s last update is read in two places only, and never on iOS', () => {
    expect(require('../src/config/legacy')).toEqual({ LEGACY_MOVE: false, NEW_APP_PLAY_URL: null, NEW_APP_SITE_URL: null });
    // The move notice and its links are built only into that update (SD-12): Metro takes legacy.move.js in place of
    // legacy.js there, and nowhere else; no platform file makes the io.aiqnet.wallet bundle carry them.
    expect(fs.existsSync(path.join(root, 'src', 'config', 'legacy.android.js'))).toBe(false);
    expect(read('src/config/legacy.move.js')).toMatch(/NativeModules\.QNetAppBuild\.legacyMove === true/);
    const metro = read('metro.legacy.config.js');
    expect(metro).toMatch(/'config', 'legacy\.js'\)[^\n]*'config', 'legacy\.move\.js'\)/);
    expect(metro).toMatch(/'i18n', 'overlay\.android\.js'\)[^\n]*'i18n', 'overlay\.legacy\.js'\)/);
    expect(gradle).toMatch(/if \(legacyMove\) bundleConfig = file\("\.\.\/\.\.\/metro\.legacy\.config\.js"\)/);
    expect(gradle.indexOf('def legacyMove')).toBeLessThan(gradle.indexOf('react {'));
    // The swap itself, as Metro runs it (plain Node: the Metro config is not for Jest): Android only, those two files only.
    const probe = `
      const path = require('path');
      const c = require(${JSON.stringify(path.join(root, 'metro.legacy.config.js'))});
      const at = (...p) => path.join(${JSON.stringify(root)}, ...p);
      const to = (f, platform, from) => c.resolver.resolveRequest({ originModulePath: from, resolveRequest: () => ({ type: 'sourceFile', filePath: f }) }, 'x', platform).filePath;
      const app = at('src', 'i18n', 'translations.js');
      console.log(JSON.stringify([
        to(at('src', 'config', 'legacy.js'), 'android', app) === at('src', 'config', 'legacy.move.js'),
        to(at('src', 'i18n', 'overlay.android.js'), 'android', app) === at('src', 'i18n', 'overlay.legacy.js'),
        to(at('src', 'config', 'legacy.js'), 'ios', app) === at('src', 'config', 'legacy.js'),
        to(at('src', 'config', 'nodes.js'), 'android', app) === at('src', 'config', 'nodes.js'),
        // overlay.legacy.js builds on ./overlay.android: that import keeps the original, or the file imports itself.
        to(at('src', 'i18n', 'overlay.android.js'), 'android', at('src', 'i18n', 'overlay.legacy.js')) === at('src', 'i18n', 'overlay.android.js'),
      ]));`;
    const out = require('child_process').execFileSync(process.execPath, ['-e', probe], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(out.trim().split('\n').pop())).toEqual([true, true, true, true, true]);
    expect(holding(sources, /from '[./]*config\/legacy'/)).toEqual(['src/screens/WalletScreen.js', 'src/services/PushService.js']);
    expect(read('android/app/src/main/java/com/qnetmobile/AppBuildModule.kt')).toMatch(/"legacyMove" to BuildConfig\.QNET_LEGACY_MOVE/);
  });

  it('the scripts run the one package and nothing chooses a variant', () => {
    const { scripts } = JSON.parse(read('package.json'));
    expect(scripts.android).toBe('react-native run-android --appId io.aiqnet.wallet');
    expect(Object.keys(scripts).filter((k) => /play|site|store|flavor/i.test(k))).toEqual([]);
  });

  it('no code asks which store installed the app or which key signed it', () => {
    const re = /signingInfo|GET_SIGNATURES|GET_SIGNING_CERTIFICATES|getInstallerPackageName|getInstallSourceInfo|QNetStore|\bSTORE\b/;
    expect(holding(androidMain, re)).toEqual([]);
    expect(holding(sources, re)).toEqual([]);
  });
});

describe('the same app on every phone', () => {
  it('no text exists in a platform variant', () => {
    expect(Object.keys(en).filter((k) => /_(ios|android)(_|$)/i.test(k))).toEqual([]);
  });

  it('the only platform texts are Android\'s few that name Google Play, where iOS has nothing to say', () => {
    expect(require('../src/i18n/overlay').default).toEqual({});
    const android = require('../src/i18n/overlay.android').default.en;
    expect(Object.keys(android).sort()).toEqual(['node_play_licence', 'node_play_open']);
    for (const k of ['node_play_licence', 'node_play_open']) expect(android[k]).toMatch(/Google Play/);
    // The old package's last update adds its move notice to them (overlay.legacy.js, that build only).
    const legacy = require('../src/i18n/overlay.legacy').default.en;
    expect(Object.keys(legacy).sort()).toEqual(['legacy_move_body', 'legacy_move_later', 'legacy_move_node',
      'legacy_move_site', 'legacy_move_title', 'node_play_licence', 'node_play_open']);
    expect(legacy.legacy_move_body).toMatch(/Google Play/);
    // The move notice exists only in the old package's last build, which only Android has.
    const legacyUsers = sources.filter((s) => /'legacy_move_/.test(s.text)).map((s) => s.name);
    expect(legacyUsers).toEqual(['src/screens/WalletScreen.js']);
  });

  it('no screen picks a text or a feature by platform', () => {
    expect(holding(sources, /Platform\.select/)).toEqual([]);
    expect(holding(sources, /Platform\.OS[^\n]*\bt\(/)).toEqual([]);
    for (const f of ['src/services/QNetLink.js', 'src/screens/QNetLinkScreen.js', 'src/browser/url.js',
      'src/browser/BrowserScreen.js']) {
      expect([f, /\bPlatform\b/.test(read(f))]).toEqual([f, false]);
    }
  });
});

describe('Solana devnet only, with no prices, in every build', () => {
  it('the cluster and its endpoints are constants of the build', () => {
    const nodes = require('../src/config/nodes');
    expect(nodes.SOLANA_CLUSTER).toBe('devnet');
    expect(nodes.SOLANA_RPC_ENDPOINTS.length).toBeGreaterThan(0);
    for (const u of nodes.SOLANA_RPC_ENDPOINTS) expect(u).toMatch(/^https:\/\/api\.devnet\.solana\.com$/);
    expect(nodes.getSolanaRpcUrl()).toBe(nodes.SOLANA_RPC_ENDPOINTS[0]);
  });

  it('no source reaches another cluster or a price', () => {
    for (const re of [/mainnet-beta/, /api\.mainnet/, /coingecko/i, /tokenPrices/, /fetchTokenPrices/, /\busd\b/i,
      /getItem\(\s*'qnet_testnet'/, /setTestnet|isTestnet/]) {
      expect([String(re), holding(sources, re)]).toEqual([String(re), []]);
    }
  });

  // 29.09: the Solana Send screen sends SOL and 1DEV the user chose to send. That transfer is the one Solana
  // transaction there is: built byte by byte in crypto/SolanaTx and sent from services/SolanaSend only, with no library
  // transaction, no simulation, and no instruction but a transfer, its recipient's token account and a memo.
  it('the only Solana transaction is a transfer the user sends, built and sent in one place', () => {
    expect(holding(sources, /'sendTransaction'/)).toEqual(['src/services/SolanaSend.js']);
    expect(holding(sources, /'getLatestBlockhash'/)).toEqual(['src/services/SolanaSend.js']);
    for (const re of [/'simulateTransaction'/, /TransactionInstruction/, /new Transaction\(/, /@solana\/spl-token/]) {
      expect([String(re), holding(sources, re)]).toEqual([String(re), []]);
    }
    expect(JSON.parse(read('package.json')).dependencies).not.toHaveProperty('@solana/spl-token');
    const tx = read('src/crypto/SolanaTx.js');
    // The programs a transaction may name: System, Token (and Token-2022 only to refuse it), the associated account
    // program and Memo. The Token program's one instruction is TransferChecked (12); the account program's is
    // CreateIdempotent (1); the System program's is Transfer (2).
    expect([...tx.matchAll(/programId: ([A-Za-z_]+)/g)].map((m) => m[1]).sort())
      .toEqual(['ASSOCIATED_TOKEN_PROGRAM_ID', 'MEMO_PROGRAM_ID', 'SYSTEM_PROGRAM_ID', 'tokenProgram']);
    expect([...tx.matchAll(/data: concat\(Uint8Array\.of\((\d+)\)|data: concat\(u32le\((\d+)\)|data: Uint8Array\.of\((\d+)\)/g)]
      .map((m) => m[1] || m[2] || m[3])).toEqual(['2', '1', '12']);
    expect(holding(sources, /TOKEN_2022_PROGRAM_ID/)).toEqual(['src/crypto/SolanaTx.js', 'src/services/SolanaSend.js']);
  });

  it('no text shows a price or a currency', () => {
    const keys = Object.keys(en).filter((k) => /\bUSD\b|\$\s?\d|\bprice\b/i.test(en[k]));
    expect(keys).toEqual([]);
  });
});

describe('a QNet Link connects, reserves, links, unlinks and moves, and nothing else', () => {
  it('the five intents of revision 2, reached from the link screen and the receiver only', () => {
    const { LINK } = require('../src/services/QNetLink');
    expect(Object.keys(LINK.STATUSES)).toEqual(['connect', 'link', 'claim', 'reserve', 'unlink']);
    expect(holding(sources, /from '[./]*(services\/)?QNetLink'/)).toEqual(['src/screens/QNetLinkScreen.js', 'src/screens/WalletScreen.js']);
    expect(holding(sources, /<QNetLinkScreen\b/)).toEqual(['src/screens/WalletScreen.js']);
  });

  it('outside the link screen, only the neutral link texts and the device check of "Use this device" appear', () => {
    const outside = sources.filter((s) => s.name !== 'src/screens/QNetLinkScreen.js');
    const used = [...new Set(outside.flatMap((s) => [...s.text.matchAll(/'(link_[a-zA-Z_]+)'/g)].map((m) => m[1])))].sort();
    expect(used).toEqual(['link_device_check_body', 'link_device_check_title', 'link_invalid', 'link_refused_title',
      'link_waiting_unlock']);
  });
});

describe('the in-app browser offers no node action and no payment beyond the transactions the user confirms', () => {
  const dir = path.join(root, 'src', 'browser');
  const code = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    // comments may say what is not offered; the code and its strings may not
    .map((text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));

  it('has no activation method, no burn and no Solana signing', () => {
    const { METHODS } = require('../src/browser/dappProvider');
    expect(METHODS.some((m) => /activat|solana|burn/i.test(m))).toBe(false);
    for (const text of code) expect(text).not.toMatch(/activateNode|NodeBurn|QNetLink|burn|solana_sign/i);
  });

  it('its texts speak of neither activation nor purchases', () => {
    const keys = Object.keys(en).filter((k) => /^(tab_|assets_|browser_|dapp_|sites_)/.test(k));
    expect(keys.length).toBeGreaterThan(60);
    for (const k of keys) expect([k, /activat|burn|1DEV|price|buy|purchase/i.test(en[k])]).toEqual([k, false]);
  });
});
