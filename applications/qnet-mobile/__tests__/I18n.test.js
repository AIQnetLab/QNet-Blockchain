// Every language has every key, with the same {placeholders}; every key the code asks for exists and every key
// is asked for; lookup, right-to-left isolation and the error texts behave (spec: i18n.md).
const fs = require('fs');
const path = require('path');
const translations = require('../src/i18n/translations').default;
const {
  LANGUAGES, translate, makeT, isRTL, errorText, hasKey, deviceLanguage, setCurrentLanguage, tr, currentLanguage,
} = require('../src/i18n');

const en = translations.en;
const keys = Object.keys(en);
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const root = path.join(__dirname, '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sources = walk(path.join(root, 'src'))
  .filter((f) => !f.includes(`${path.sep}i18n${path.sep}locales${path.sep}`))
  .map((f) => ({ name: path.relative(root, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));

describe('the translation tables', () => {
  it('the language picker lists exactly the languages there are tables for', () => {
    expect(LANGUAGES.map((l) => l.code).sort()).toEqual(Object.keys(translations).sort());
    expect(Object.keys(translations)).toHaveLength(11);
  });

  it('every language has every key and nothing else, each a non-empty string', () => {
    for (const [lang, table] of Object.entries(translations)) {
      expect([lang, keys.filter((k) => !(k in table))]).toEqual([lang, []]);
      expect([lang, Object.keys(table).filter((k) => !(k in en))]).toEqual([lang, []]);
      const empty = Object.keys(table).filter((k) => typeof table[k] !== 'string' || table[k].trim() === '');
      expect([lang, empty]).toEqual([lang, []]);
    }
  });

  it('every translation keeps exactly the placeholders of the English text', () => {
    for (const [lang, table] of Object.entries(translations)) {
      const bad = keys.filter((k) => placeholders(table[k]).join() !== placeholders(en[k]).join());
      expect([lang, bad]).toEqual([lang, []]);
    }
  });

  it('Android\'s own texts keep the placeholders of their English text in every language', () => {
    // Android's own texts name Google Play; the old package's last update adds its move notice (overlay.legacy.js).
    const overlay = require('../src/i18n/overlay.legacy').default;
    for (const [lang, table] of Object.entries(overlay)) {
      const bad = Object.keys(overlay.en).filter((k) => placeholders(table[k]).join() !== placeholders(overlay.en[k]).join());
      expect([lang, bad]).toEqual([lang, []]);
      const named = Object.entries(table).filter(([k]) => !k.startsWith('legacy_move_')).map(([, v]) => v);
      expect([lang, named.length > 0 && named.every((v) => v.includes('Google Play'))]).toEqual([lang, true]);
      expect([lang, table.legacy_move_body.includes('Google Play') && table.legacy_move_body.includes('aiqnet.io')]).toEqual([lang, true]);
    }
    expect(Object.keys(require('../src/i18n/overlay.android').default.en).some((k) => k.startsWith('legacy_move_'))).toBe(false);
  });

  it('what is never translated stays as it is in every language: tokens, brands', () => {
    for (const [lang, table] of Object.entries(translations)) {
      for (const [k, token] of [['dapp_title_send', 'QNC'], ['link_origin', 'aiqnet.io'], ['link_err_NO_WALLET', 'aiqnet.io'],
        ['err_MIN_CLAIM', '1 QNC'], ['receive_your_solana', 'Solana'], ['solana_devnet', 'Solana']]) {
        expect([lang, k, table[k].includes(token)]).toEqual([lang, k, true]);
      }
    }
  });

  it('only a real translation differs from English where English words would be left behind', () => {
    // Long sentences are never left in English in another language.
    for (const [lang, table] of Object.entries(translations)) {
      if (lang === 'en') continue;
      const words = (s) => s.split(/\s+/).filter((w) => /[a-z]{2,}/i.test(w) && !/^\{\w+\}$/.test(w));
      const untranslated = keys.filter((k) => words(en[k]).length >= 4 && table[k] === en[k]);
      expect([lang, untranslated]).toEqual([lang, []]);
    }
  });
});

describe('the code and the tables agree', () => {
  // t('key'), tr('key'), tt('key'), tRef.current('key'): the keys the code asks for by name.
  const asked = new Set(sources.flatMap((s) => [...s.text.matchAll(/\b(?:t|tr|tt|tRef\.current)\(\s*'([a-zA-Z0-9_]+)'/g)].map((m) => m[1])));
  // Keys built at run time from a known set of values.
  const built = [
    ...['assets', 'history', 'browser', 'node', 'settings'].map((x) => `tab_${x}`),
    ...['1', '5', '15', '30', 'never'].map((x) => `autolock_${x}`),
    ...['light', 'super', 'full'].map((x) => `node_title_${x}`),
  ];

  it('every key the code asks for exists', () => {
    // Under Jest the tables are iOS's; a key of Android's own texts exists in the Android bundle, and one of the move
    // notice in the old package's last update, the only build whose code path asks for it.
    const androidOnly = require('../src/i18n/overlay.legacy').default.en;
    expect([...asked].filter((k) => !hasKey(k) && !(k in androidOnly)).sort()).toEqual([]);
    expect(built.filter((k) => !hasKey(k))).toEqual([]);
  });

  it('every key is used: asked for by name, named as a literal (store notes, legal links), or built from a code', () => {
    const literal = (k) => sources.some((s) => s.text.includes(`'${k}'`) || s.text.includes(`"${k}"`));
    const dynamic = (k) => built.includes(k) || /^(link_err_|err_[A-Z])/.test(k);
    expect(keys.filter((k) => !asked.has(k) && !literal(k) && !dynamic(k))).toEqual([]);
  });

  it('each error code a service reports has a text', () => {
    // `code: 'X'` on a thrown error or a result, or `e.code = 'X'`.
    const thrown = new Set(sources.flatMap((s) => [...s.text.matchAll(/code(?::| =) '([A-Z][A-Z_]+)'/g)].map((m) => m[1])));
    for (const code of ['INVALID_PHRASE', 'INVALID_ADDRESS', 'ADDRESS_CHECKSUM', 'INVALID_AMOUNT', 'AMOUNT_DECIMALS',
      'NONCE_UNKNOWN', 'NONCE_CHANGED', 'TOO_MANY_PENDING', 'NO_REWARDS', 'MIN_CLAIM', 'NODE_ID_UNKNOWN']) {
      expect([code, thrown.has(code), hasKey(`err_${code}`)]).toEqual([code, true, true]);
    }
    const { ERRORS } = require('../src/services/QNetLink').LINK;
    for (const code of ERRORS) expect([code, hasKey(`link_err_${code}`)]).toEqual([code, true]);
    expect(keys.filter((k) => k.startsWith('link_err_')).map((k) => k.slice(9)).sort()).toEqual([...ERRORS].sort());
  });
});

describe('lookup', () => {
  it('fills placeholders and leaves a missing one visible', () => {
    expect(translate('en', 'send_title', { symbol: 'QNC' })).toBe('Send QNC');
    expect(translate('en', 'send_title', {})).toBe('Send {symbol}');
    expect(translate('de', 'send_title', { symbol: 'QNC' })).toBe('QNC senden');
    expect(makeT('ru')('dapp_auth_send', { amount: '1.5' })).toBe('Отправить 1.5 QNC');
  });

  it('on Android the tables also carry Android\'s own texts; on iOS they do not', () => {
    expect(hasKey('node_play_licence')).toBe(false);
    jest.isolateModules(() => {
      jest.doMock('../src/i18n/overlay', () => jest.requireActual('../src/i18n/overlay.android'));
      const android = require('../src/i18n/translations').default;
      expect(android.en.node_play_licence).toBe('To run the node, install QNet Wallet from Google Play on this device.');
      expect(android.ru.node_play_open).toBe('Открыть Google Play');
      for (const lang of Object.keys(translations)) {
        expect([lang, Object.keys(android[lang]).length]).toEqual([lang, Object.keys(translations[lang]).length + 2]);
        expect([lang, android[lang].node_cant_run]).toEqual([lang, translations[lang].node_cant_run]);
      }
    });
  });

  it('an unknown language speaks English; an unknown key shows itself', () => {
    expect(translate('xx', 'common_ok')).toBe('OK');
    expect(translate('en', 'no_such_key')).toBe('no_such_key');
    expect(makeT('xx').lang).toBe('en');
  });

  it('Arabic is right to left, and a value put into Arabic text keeps its own order', () => {
    expect(LANGUAGES.filter((l) => isRTL(l.code)).map((l) => l.code)).toEqual(['ar']);
    const t = makeT('ar');
    expect(t.rtl).toBe(true);
    const text = t('send_confirm_reason', { amount: '12.5 QNC' });
    expect(text).toContain('\u206812.5 QNC\u2069');
    // Left-to-right languages get the value as it is.
    expect(makeT('en')('send_confirm_reason', { amount: '12.5 QNC' })).toBe('Confirm sending 12.5 QNC');
  });

  it('the language of services outside the screen follows the screen', () => {
    setCurrentLanguage('ja');
    expect(currentLanguage()).toBe('ja');
    expect(tr('bio_use_password')).toBe(translations.ja.bio_use_password);
    setCurrentLanguage('nope');
    expect(currentLanguage()).toBe('en');
  });

  it('the phone language is the first choice when the app has it (Android: the locale identifier)', () => {
    const { I18nManager, Platform } = require('react-native');
    const os = Platform.OS;
    Platform.OS = 'android';
    const spy = jest.spyOn(I18nManager, 'getConstants');
    try {
      for (const [id, lang] of [['ru_RU', 'ru'], ['zh-Hans_CN', 'zh-CN'], ['pt_BR', 'pt'], ['sv_SE', 'en'], ['', 'en']]) {
        spy.mockReturnValue({ localeIdentifier: id, isRTL: false, doLeftAndRightSwapInRTL: true });
        expect([id, deviceLanguage()]).toEqual([id, lang]);
      }
    } finally {
      spy.mockRestore();
      Platform.OS = os;
    }
  });
});

describe('error texts', () => {
  const t = makeT('fr');

  it('a known code is said in the user language', () => {
    expect(errorText(t, Object.assign(new Error('Invalid mnemonic phrase'), { code: 'INVALID_PHRASE' }), 'err_import_wallet'))
      .toBe(translations.fr.err_INVALID_PHRASE);
    expect(errorText(t, { code: 'AMOUNT_DECIMALS', params: { decimals: 6 } }, 'tx_failed')).toContain('6');
    const { TooManyPendingError } = require('../src/services/PendingTx');
    expect(errorText(t, new TooManyPendingError(), 'tx_failed')).toBe(translations.fr.err_TOO_MANY_PENDING);
  });

  it('anything else is the operation\'s own text, with the raw detail after it', () => {
    expect(errorText(t, new Error('node said no'), 'tx_failed')).toBe(`${translations.fr.tx_failed}\nDétails : node said no`);
    expect(errorText(t, null, 'tx_failed')).toBe(translations.fr.tx_failed);
    expect(errorText(t, { message: '', code: 'UNKNOWN_CODE' }, 'claim_failed')).toBe(translations.fr.claim_failed);
  });
});
