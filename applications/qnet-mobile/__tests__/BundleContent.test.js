// The static half of the bundle scan (plan-mobile 10.1): what the app's code and its eleven translation tables may
// never carry. No burn, activation code, recovery of a code, self-update or notification prompt ships in any build; no
// text speaks of activation, burning, rewards or mining in any language; no text names a platform or a phone, because
// every screen is the same on every phone and tablet.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const translations = require('../src/i18n/translations').default;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const rel = (f) => path.relative(root, f).replace(/\\/g, '/');
const code = [...walk(path.join(root, 'src')), path.join(root, 'App.tsx'), path.join(root, 'index.js')]
  .filter((f) => !f.includes(`${path.sep}locales${path.sep}`) && /\.(js|tsx?|json)$/.test(f))
  .map((f) => ({ name: rel(f), text: fs.readFileSync(f, 'utf8') }));
const native = [
  ...walk(path.join(root, 'ios', 'QNetMobile')).filter((f) => /\.(swift|m|h|plist|entitlements)$/.test(f)),
  ...walk(path.join(root, 'android', 'app', 'src', 'main')).filter((f) => /\.(kt|java|xml)$/.test(f)),
].map((f) => ({ name: rel(f), text: fs.readFileSync(f, 'utf8') }));

const holding = (files, needle) => files.filter((s) => s.text.includes(needle)).map((s) => s.name);

// The off-chain signer refuses messages that start with a node preimage prefix, so the prefix stays listed there.
const SIGNER_GUARD = { 'qnet_register:': ['src/crypto/OffchainMessage.js'] };

describe('what the code never carries', () => {
  it('no burn, code, recovery, self-update or notification-prompt identifier in any source file', () => {
    for (const id of [
      'NodeBurn', 'BurnMatcher', 'activateWithCode', 'recoverActivationCode', 'checkActivationCode', 'deriveActivationCode',
      'parseActivationCode', 'getCanonicalActivation', 'storeActivationCode', 'exportActivationCode', 'createBurnInstruction',
      'buildBurnTransaction', 'signBurnTransaction', 'NODE_TYPE_MEMO', 'QNET_NODE_TYPE', 'qnet_register:', 'QNET-BOOT-',
      'act_source_extension', 'requestPermission(', 'requestAuthorization', 'checkForUpdate', 'UpdateCheck', 'QNetStore',
      'config/store', 'registerNodeWithCode', 'createAndSubmitNodeRegistrationTx', 'owner_signature',
    ]) {
      expect([id, holding(code, id)]).toEqual([id, SIGNER_GUARD[id] || []]);
    }
  });

  it('the native projects ask for no notification permission and show no notification', () => {
    expect(holding(native, 'requestAuthorization')).toEqual([]);
    expect(holding(native, 'willPresent')).toEqual([]);
    expect(holding(native, 'POST_NOTIFICATIONS" />')).toEqual([]);
  });

  it('the removed modules are gone, not hidden', () => {
    for (const f of ['src/services/NodeBurn.js', 'src/services/BurnMatcher.js', 'src/config/burn.js', 'src/utils/activationCode.js',
      'src/services/UpdateCheck.js', 'src/config/store.js', 'android/app/src/main/java/com/qnetmobile/StoreModule.kt']) {
      expect([f, fs.existsSync(path.join(root, f))]).toEqual([f, false]);
    }
  });
});

describe('what the translation tables never carry', () => {
  const PREFIXES = ['act_', 'rec_', 'reg_msg_', 'export_activation', 'activation_code', 'node_code_needed', 'node_retry_code',
    'link_burn', 'link_title_activate', 'link_auth_activate', 'link_result_superseded', 'link_lost_burn', 'upd_'];

  it('no key of a removed flow, in any language', () => {
    for (const [lang, table] of Object.entries(translations)) {
      const found = Object.keys(table).filter((k) => PREFIXES.some((p) => k.startsWith(p)));
      expect([lang, found]).toEqual([lang, []]);
    }
  });

  // The forms each language uses for activation, burning, rewards, mining, a price and a purchase (fixtures/forbidden_words.json, shared
  // with the screen tests that render data, such as History's detail screen); in Russian "заработ" reads as "earn" as
  // well as "start working" (SD-R2-12), and "доход" is income. `hist_burn` (a token burn in the history) and
  // `dapp_token_destroyed` (a dApp sending tokens where nobody can move them) are ordinary token actions.
  const FORBIDDEN = require('./fixtures/forbidden_words.json');
  const ALLOWED_KEYS = new Set(['hist_burn', 'dapp_token_destroyed']);

  it('every language has its list', () => {
    expect(Object.keys(FORBIDDEN).sort()).toEqual(Object.keys(translations).sort());
  });

  it('no text speaks of activation, burning, rewards or mining', () => {
    for (const [lang, table] of Object.entries(translations)) {
      const found = [];
      for (const [k, v] of Object.entries(table)) {
        if (ALLOWED_KEYS.has(k)) continue;
        const text = v.toLowerCase();
        for (const w of FORBIDDEN[lang]) if (text.includes(w.toLowerCase())) found.push(`${k}: ${w}`);
      }
      expect([lang, found]).toEqual([lang, []]);
    }
  });

  it('no key names activation, burning, rewards, mining, a price or a purchase either', () => {
    // A key is never shown, but it ships in every bundle. hist_burn is a token burn; err_NO_REWARDS is the text of a
    // node's error code; a passcode is no code.
    const allowed = new Set(['hist_burn', 'err_NO_REWARDS']);
    const named = /activat|burn|reward|mining|(^|_)earn|price|purchase|(?<!pass)code/i;
    const tables = [...Object.entries(translations), ...Object.entries(require('../src/i18n/overlay.legacy').default)];
    for (const [lang, table] of tables) {
      expect([lang, Object.keys(table).filter((k) => !allowed.has(k) && named.test(k))]).toEqual([lang, []]);
    }
    expect(named.test('hist_node_activated')).toBe(true);
  });

  // A device word, never a platform, a platform's own service (iCloud, SD-R3-07) or "phone": the same text is on every
  // phone and tablet.
  const PLATFORM = {
    en: /iphone|ipad|android|icloud|\bphones?\b/i,
    ru: /iphone|ipad|android|icloud|телефон/i,
    de: /iphone|ipad|android|icloud|telefon|handy/i,
    es: /iphone|ipad|android|icloud|teléfono|móvil/i,
    fr: /iphone|ipad|android|icloud|téléphone/i,
    it: /iphone|ipad|android|icloud|telefono/i,
    pt: /iphone|ipad|android|icloud|telefone|celular/i,
    ja: /iphone|ipad|android|icloud|スマートフォン|スマホ|電話/i,
    ko: /iphone|ipad|android|icloud|휴대폰|핸드폰|전화/i,
    'zh-CN': /iphone|ipad|android|icloud|手机|电话/i,
    ar: /iphone|ipad|android|icloud|هاتف|الهاتف/i,
  };

  it('no text names a platform or a phone', () => {
    for (const [lang, table] of Object.entries(translations)) {
      const found = Object.entries(table).filter(([, v]) => PLATFORM[lang].test(v)).map(([k]) => k);
      expect([lang, found]).toEqual([lang, []]);
    }
  });

  // The Android half (plan-technical 16.2, F8): Android's own texts may name its store, and nothing else changes.
  const androidOverlay = require('../src/i18n/overlay.android').default;
  const shared = { ...translations };
  for (const [lang, table] of Object.entries(androidOverlay)) {
    shared[lang] = Object.fromEntries(Object.entries(translations[lang]).filter(([k]) => !(k in table)));
  }

  it('Android\'s texts: every language, the same keys, none of a shared text', () => {
    expect(Object.keys(androidOverlay).sort()).toEqual(Object.keys(translations).sort());
    const keys = Object.keys(androidOverlay.en).sort();
    for (const [lang, table] of Object.entries(androidOverlay)) {
      expect([lang, Object.keys(table).sort()]).toEqual([lang, keys]);
      for (const k of keys) expect([lang, k, typeof table[k] === 'string' && table[k].trim().length > 0]).toEqual([lang, k, true]);
    }
    for (const k of keys) expect([k, k in translations.en]).toEqual([k, false]); // under Jest the tables are iOS's
  });

  it('Android\'s texts pass the same word lists: no activation, burning, rewards, mining, platform or phone', () => {
    for (const [lang, table] of Object.entries(androidOverlay)) {
      for (const [k, v] of Object.entries(table)) {
        const found = FORBIDDEN[lang].filter((w) => v.toLowerCase().includes(w.toLowerCase()));
        expect([lang, k, found, PLATFORM[lang].test(v)]).toEqual([lang, k, [], false]);
      }
    }
  });

  it('only Android\'s texts name a store; no shared text does', () => {
    for (const [lang, table] of Object.entries(shared)) {
      const found = Object.entries(table).filter(([, v]) => /google play|play store|app store/i.test(v)).map(([k]) => k);
      expect([lang, found]).toEqual([lang, []]);
    }
    const imports = code.filter((s) => /overlays\/android/.test(s.text) && !s.name.startsWith('src/i18n/overlays/'));
    expect(imports.map((s) => s.name)).toEqual(['src/i18n/overlay.android.js']);
  });

  it('the scan sees what it must catch', () => {
    expect(FORBIDDEN.en.some((w) => 'Claim your rewards'.toLowerCase().includes(w))).toBe(true);
    expect(FORBIDDEN.ru.some((w) => 'Получить награды'.toLowerCase().includes(w))).toBe(true);
    expect(PLATFORM.en.test('Stop node on this phone')).toBe(true);
    expect(PLATFORM.en.test('passcode')).toBe(false);
    expect(PLATFORM.ja.test('このスマートフォンで停止')).toBe(true);
  });
});

// The Metro half (scripts/bundle-check.js): what ships in each platform's release bundle. The scanner itself is checked
// here on texts made for it; the bundles are built and scanned before every release build and in the iOS workflow
// (QNET_BUNDLE_CHECK=1 runs it here too: Metro takes minutes).
describe('what the release bundles never carry', () => {
  const { scanBundle, tableValues } = require('../scripts/bundle-check');
  const locales = path.join(root, 'src', 'i18n', 'locales');
  const tables = fs.readdirSync(locales).map((f) => tableValues(path.join(locales, f)).node_none);
  const overlay = fs.readdirSync(path.join(root, 'src', 'i18n', 'overlays', 'android'))
    .flatMap((f) => Object.values(tableValues(path.join(root, 'src', 'i18n', 'overlays', 'android', f))));
  // Minified strings: Latin-1 as \xNN, the rest as \uNNNN.
  const minified = (s) => s.replace(/[^\x20-\x7e]/g, (c) => {
    const n = c.charCodeAt(0);
    return n < 256 ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16).padStart(4, '0')}`;
  });
  const bundle = (extra) => [...tables.map(minified), ...extra].map((s) => `'${s}'`).join(',');

  it('reads every language\'s table and Android\'s own texts', () => {
    expect(tables).toHaveLength(11);
    expect(tables.every(Boolean)).toBe(true);
    expect(overlay.length).toBe(11 * Object.keys(require('../src/i18n/overlay.android').default.en).length);
  });

  it('a clean bundle passes; a removed flow, Android\'s texts on iOS or tables it did not scan fail', () => {
    expect(scanBundle('ios', bundle([]))).toEqual([]);
    expect(scanBundle('android', bundle(overlay.map(minified)))).toEqual([]);
    expect(scanBundle('android', bundle(['activateWithCode', ...overlay]))).toEqual(['android: carries "activateWithCode"']);
    expect(scanBundle('ios', bundle(['Open Google Play']))).toEqual([
      expect.stringMatching(/^ios: carries Android's own "Open Google Play"/), 'ios: carries Android\'s own "Google Play"']);
    expect(scanBundle('android', bundle([]))).toEqual(['android: Android\'s own texts are missing, so the scan cannot see them']);
    // The old package's move notice: its link to the site's download page and its texts ship in no bundle (SD-12).
    const legacyDir = path.join(root, 'src', 'i18n', 'overlays', 'legacy');
    const legacy = fs.readdirSync(legacyDir).flatMap((f) => Object.values(tableValues(path.join(legacyDir, f))));
    expect(legacy.length).toBe(11 * 5);
    expect(scanBundle('android', bundle([...overlay, 'https://aiqnet.io/wallet'].map(minified)))).toEqual([
      'android: carries the old package\'s move notice "aiqnet.io/wallet"']);
    expect(scanBundle('android', bundle([...overlay, legacy[0]].map(minified)))).toHaveLength(1);
    expect(scanBundle('ios', bundle([minified(legacy[3])]))).toHaveLength(1);
    expect(scanBundle('ios', tables.slice(1).map((s) => `'${minified(s)}'`).join(','))).toHaveLength(1);
  });

  it('the old package\'s last update is scanned the other way round for its notice (--legacy, M15)', () => {
    const legacyDir = path.join(root, 'src', 'i18n', 'overlays', 'legacy');
    const legacy = fs.readdirSync(legacyDir).flatMap((f) => Object.values(tableValues(path.join(legacyDir, f))));
    const full = [...overlay, ...legacy, 'https://aiqnet.io/wallet'].map(minified);
    expect(scanBundle('android', bundle(full), { legacy: true })).toEqual([]);
    // A notice text missing, a removed flow or Android's own texts missing fail it; iOS has no such update.
    expect(scanBundle('android', bundle(full.filter((s) => s !== minified(legacy[0]))), { legacy: true })).toHaveLength(1);
    expect(scanBundle('android', bundle([...full, 'activateWithCode']), { legacy: true })).toEqual(['android: carries "activateWithCode"']);
    expect(scanBundle('android', bundle([...legacy, 'https://aiqnet.io/wallet'].map(minified)), { legacy: true }))
      .toContain('android: Android\'s own texts are missing, so the scan cannot see them');
    expect(scanBundle('ios', bundle(full), { legacy: true })).toHaveLength(1);
    // Gradle passes it exactly when the build is that update.
    const gradle = fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'utf8');
    expect(gradle).toMatch(/legacyMove \? \["--legacy"\] : \[\]/);
    expect(fs.readFileSync(path.join(root, 'scripts', 'bundle-check.js'), 'utf8')).toMatch(/'--config', path\.join\(ROOT, 'metro\.legacy\.config\.js'\)/);
  });

  it('runs before every Android release build and in the iOS workflow', () => {
    const gradle = fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'utf8');
    expect(gradle).toMatch(/commandLine\(\["node", "scripts\/bundle-check\.js", "--platform", "android"\] \+ \(legacyMove \? \["--legacy"\] : \[\]\)\)/);
    const workflow = fs.readFileSync(path.join(root, '..', '..', '.github', 'workflows', 'ios-build.yml'), 'utf8');
    expect(workflow).toMatch(/node scripts\/bundle-check\.js --platform all/);
  });

  (process.env.QNET_BUNDLE_CHECK === '1' ? it : it.skip)('the bundles Metro builds now are clean', () => {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'bundle-check.js'), '--platform', 'all'], { cwd: root, stdio: 'inherit' });
  }, 900000);
});
