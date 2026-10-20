// Amounts in one format in every one of the app's eleven languages (utils/amountFormat, owner 19.10): the whole part
// grouped by three with ',' and the decimals after '.', written into the exact decimal string, so no digit of a 64- or
// 128-bit figure is lost. Never a language's own marks, whatever the platform's number formatting says.
const fs = require('fs');
const path = require('path');
const { amountText, qncText, AMOUNT_GROUP } = require('../src/utils/amountFormat');

it('an amount is 42,578.81988, never written with a language\'s own marks', () => {
  expect(amountText('42578.81988')).toBe('42,578.81988');
  expect(amountText('1234')).toBe('1,234');
  expect(AMOUNT_GROUP).toBe(',');
  // No space of any width, no decimal comma, no Arabic marks or digits in any figure.
  expect(amountText('2047243.4405')).not.toMatch(/[\s  ٫٬٠-٩]|\d,\d{1,2}$|\d,\d{4}/);
});

it('a short whole part stays as it is; four digits and more are grouped', () => {
  expect(amountText('999')).toBe('999');
  expect(amountText('0.5')).toBe('0.5');
  expect(amountText('12.5')).toBe('12.5');
  expect(amountText('0')).toBe('0');
  expect(amountText('1234.5')).toBe('1,234.5');
  expect(amountText('9999')).toBe('9,999');
  expect(amountText('123456')).toBe('123,456');
});

it('a sign stays in front of the figure', () => {
  expect(amountText('-1234567.89')).toBe('-1,234,567.89');
  expect(amountText('+1500')).toBe('+1,500');
  expect(amountText('+0.25')).toBe('+0.25');
});

it('large values keep every digit: 2^64 - 1, 2^128 - 1 and an 18-decimal token', () => {
  expect(amountText('18446744073709551615')).toBe('18,446,744,073,709,551,615');
  expect(amountText('340282366920938463463374607431768211455')).toBe('340,282,366,920,938,463,463,374,607,431,768,211,455');
  // The fraction is never grouped.
  expect(amountText('18.446744073709551615')).toBe('18.446744073709551615');
  expect(amountText('1000000.000000000000000001')).toBe('1,000,000.000000000000000001');
});

it('any other text comes back as it was', () => {
  for (const text of ['—', '••••', '', '1e+21', '1.2.3', ' 12', '12.', '.5', '1,234', 'abc', '<0.00000001']) {
    expect(amountText(text)).toBe(text);
  }
  expect(amountText(null)).toBe('');
  expect(amountText(undefined)).toBe('');
});

it('QNC from nano, exact, in the same format; masked or unknown as before', () => {
  expect(qncText('42578819880000')).toBe('42,578.81988 QNC');
  expect(qncText(4714356375000, true)).toBe('••••');
  expect(qncText(null)).toBe('—');
});

it('the platform\'s number formatting never decides an amount', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'amountFormat.js'), 'utf8');
  expect(src).not.toMatch(/Intl|toLocaleString|NumberFormat/);
  // Nothing else in the app writes an amount with the language's marks.
  const files = ['screens/HistoryTab.js', 'screens/WalletScreen.js', 'screens/SolanaSend.js', 'screens/NodeTab.js',
    'screens/QNetLinkScreen.js', 'browser/DappSheet.js', 'components/TxResultCard.js', 'services/SolanaSend.js'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    expect([f, /(amountText|qncText|solText)\([^)]*t\.lang/.test(text)]).toEqual([f, false]);
  }
});
