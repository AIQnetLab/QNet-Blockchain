// Amounts in each of the app's eleven languages (utils/amountFormat): the whole part grouped by three and the
// language's decimal mark, written into the exact decimal string, so no digit of a 64- or 128-bit figure is lost.
const { LANGUAGES } = require('../src/i18n');

const NBSP = '\u00A0';
const NNBSP = '\u202F';
const COMMA_POINT = ['2,047,243.4405', '1,234'];
const POINT_COMMA = ['2.047.243,4405', '1.234'];
// What each language writes for 2047243.4405 and for 1234.
const EXPECTED = {
  en: COMMA_POINT, ja: COMMA_POINT, ko: COMMA_POINT, 'zh-CN': COMMA_POINT, ar: COMMA_POINT,
  ru: [`2${NBSP}047${NBSP}243,4405`, `1${NBSP}234`],
  fr: [`2${NNBSP}047${NNBSP}243,4405`, `1${NNBSP}234`],
  de: POINT_COMMA, pt: POINT_COMMA,
  es: ['2.047.243,4405', '1234'], it: ['2.047.243,4405', '1234'],
};

// The module as a fresh start loads it: the symbols are read once per language and kept.
const load = () => {
  let mod;
  jest.isolateModules(() => { mod = require('../src/utils/amountFormat'); });
  return mod;
};
const realIntl = global.Intl;
afterEach(() => { global.Intl = realIntl; });

const expectEveryLanguage = ({ amountText }) => {
  for (const [lang, [figure, short]] of Object.entries(EXPECTED)) {
    expect([lang, amountText('2047243.4405', lang), amountText('1234', lang)]).toEqual([lang, figure, short]);
  }
};

it('every language of the app has its expected figures', () => {
  expect(Object.keys(EXPECTED).sort()).toEqual(LANGUAGES.map((l) => l.code).sort());
});

it('each language groups the whole part and writes its own decimal mark', () => {
  expectEveryLanguage(load());
});

it('a short whole part stays as it is, and Spanish and Italian group from five digits', () => {
  const { amountText } = load();
  expect(amountText('999', 'en')).toBe('999');
  expect(amountText('0.5', 'en')).toBe('0.5');
  expect(amountText('0.5', 'de')).toBe('0,5');
  expect(amountText('12.5', 'ru')).toBe('12,5');
  expect(amountText('0', 'fr')).toBe('0');
  expect(amountText('1234.5', 'es')).toBe('1234,5');
  expect(amountText('12345', 'es')).toBe('12.345');
  expect(amountText('9999', 'it')).toBe('9999');
  expect(amountText('10000', 'it')).toBe('10.000');
  expect(amountText('123456', 'en')).toBe('123,456');
});

it('a sign stays in front of the figure', () => {
  const { amountText } = load();
  expect(amountText('-1234567.89', 'en')).toBe('-1,234,567.89');
  expect(amountText('+1500', 'de')).toBe('+1.500');
  expect(amountText('-1234', 'es')).toBe('-1234');
  expect(amountText('+0.25', 'fr')).toBe('+0,25');
});

it('large values keep every digit: 2^64 - 1, 2^128 - 1 and an 18-decimal token', () => {
  const { amountText } = load();
  expect(amountText('18446744073709551615', 'en')).toBe('18,446,744,073,709,551,615');
  expect(amountText('18446744073709551615', 'ru'))
    .toBe(['18', '446', '744', '073', '709', '551', '615'].join(NBSP));
  expect(amountText('18446744073709551615', 'de')).toBe('18.446.744.073.709.551.615');
  expect(amountText('340282366920938463463374607431768211455', 'ja'))
    .toBe('340,282,366,920,938,463,463,374,607,431,768,211,455');
  // The fraction is never grouped.
  expect(amountText('18.446744073709551615', 'en')).toBe('18.446744073709551615');
  expect(amountText('18.446744073709551615', 'pt')).toBe('18,446744073709551615');
  expect(amountText('1000000.000000000000000001', 'fr')).toBe(`1${NNBSP}000${NNBSP}000,000000000000000001`);
  expect(amountText('340282366920938463463.374607431768211455', 'it'))
    .toBe('340.282.366.920.938.463.463,374607431768211455');
});

it('any other text comes back as it was', () => {
  const { amountText } = load();
  for (const text of ['—', '••••', '', '1e+21', '1.2.3', ' 12', '12.', '.5', '1,234', 'abc', '<0.00000001']) {
    expect(amountText(text, 'de')).toBe(text);
  }
  expect(amountText(null, 'en')).toBe('');
  expect(amountText(undefined, 'en')).toBe('');
});

it('no language, or one the platform cannot format, is written as English', () => {
  const { amountText } = load();
  expect(amountText('1234.5')).toBe('1,234.5');
  expect(amountText('1234.5', 'not a language tag')).toBe('1,234.5');
});

describe('the symbols come from the platform, read once per language', () => {
  // A platform that writes `figure` for 1234567.5 and `short` for 1234; gives the tags it is asked for.
  const fakeIntl = (figure, short = figure) => {
    const tags = [];
    const NumberFormat = function NumberFormat(tag) {
      tags.push(tag);
      return { format: (n) => (n === 1234 ? short : figure) };
    };
    global.Intl = { NumberFormat };
    return tags;
  };
  // The table, not the platform, wrote them: a language the table lacks is English.
  const expectTable = (mod) => {
    expectEveryLanguage(mod);
    expect(mod.amountText('1234567.5', 'pl')).toBe('1,234,567.5');
  };

  it("the platform's own data is read: a language the table lacks gets its own symbols and grouping", () => {
    const { amountText } = load();
    expect(amountText('1234567.5', 'pl')).toBe(`1${NBSP}234${NBSP}567,5`);
    expect(amountText('1234', 'pl')).toBe('1234');
    // Groups of two after the first three are not groups of three: English.
    expect(amountText('1234567.5', 'en-IN')).toBe('1,234,567.5');
  });

  it('its own symbols are used, Arabic is asked for in Latin digits, and each language is asked once', () => {
    const tags = fakeIntl("1'234'567.5", "1'234");
    const { amountText, amountSymbols } = load();
    expect(amountText('1234567.5', 'de')).toBe("1'234'567.5");
    expect(amountText('1234', 'de')).toBe("1'234");
    expect(amountText('1000', 'ar')).toBe("1'000");
    expect(amountSymbols('de')).toEqual({ group: "'", decimal: '.', groupFrom: 4 });
    expect(tags).toEqual(['de', 'ar-u-nu-latn']);
  });

  it('the table when the platform throws', () => {
    global.Intl = { NumberFormat: function NumberFormat() { throw new RangeError('no data'); } };
    expectTable(load());
  });

  it('the table when there is no number formatting at all', () => {
    global.Intl = undefined;
    expectTable(load());
  });

  it('the table when the platform writes other digits or another shape', () => {
    // Arabic-Indic digits with the Arabic separators.
    const tags = fakeIntl('\u0661\u066C\u0662\u0663\u0664\u066C\u0665\u0666\u0667\u066B\u0665');
    expectTable(load());
    expect(tags).toHaveLength(Object.keys(EXPECTED).length + 1);
    // Groups of two after the first three; one symbol for both marks; 1234 written another way.
    for (const [figure, short] of [['12,34,567.5', '1,234'], ['1.234.567.5', '1.234'], ['1,234,567.5', '1 234']]) {
      fakeIntl(figure, short);
      expectTable(load());
    }
  });
});
