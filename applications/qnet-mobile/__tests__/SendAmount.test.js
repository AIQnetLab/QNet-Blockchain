// The QNet Send screen's 25 / 50 / 75 % and MAX buttons (L-9): an amount the token takes (no more decimals than its own,
// at most six; QNC five after its fee), worked out in whole base units.
const fs = require('fs');
const path = require('path');
const { amountShare } = require('../src/utils/sendAmount');
const WalletManager = require('../src/components/WalletManager').default;

const token = (decimals, balanceText, percentage = 100) => amountShare({ contract: 'c', decimals, balanceText, balance: Number(balanceText), percentage });

it('a token of fewer than six decimals gets its own number of decimals, and the amount is one it takes', () => {
  expect(token(2, '12.34')).toBe('12.34');
  expect(token(2, '12.34', 50)).toBe('6.17');
  expect(token(0, '7', 50)).toBe('3');
  expect(token(0, '7')).toBe('7');
  const wm = new WalletManager();
  for (const [d, text] of [[2, '12.34'], [0, '7'], [3, '0.005']]) {
    for (const pct of [25, 50, 75, 100]) {
      const amount = token(d, text, pct);
      expect(() => wm.toBaseUnits(amount, d)).not.toThrow();
    }
  }
});

it('a token of more decimals gets six, floored, and a large balance loses no digit', () => {
  expect(token(9, '1.123456789')).toBe('1.123456');
  // 2^64 - 1 base units of an 18-decimal token: beyond what a float holds exactly.
  expect(token(18, '18.446744073709551615')).toBe('18.446744');
  expect(token(6, '123456789012345.678901')).toBe('123456789012345.678901');
  expect(token(6, '123456789012345.678901', 25)).toBe('30864197253086.419725');
  expect(token(6, '0.000003', 25)).toBe('0.000000');
});

it('without the exact text the figure on screen is used; nothing held is zero', () => {
  expect(amountShare({ contract: 'c', decimals: 2, balanceText: null, balance: 12.34, percentage: 100 })).toBe('12.34');
  expect(amountShare({ contract: 'c', decimals: 4, balanceText: 'n/a', balance: 0, percentage: 100 })).toBe('0.0000');
});

it('QNC: five decimals after the fee, never below zero', () => {
  expect(amountShare({ balance: 10, feeNano: 150000, percentage: 100 })).toBe('9.99985');
  expect(amountShare({ balance: 10, feeNano: 150000, percentage: 50 })).toBe('4.99992');
  expect(amountShare({ balance: 0.0001, feeNano: 150000, percentage: 100 })).toBe('0.00000');
});

it('the screen uses it, and says when an amount has more decimals than the token', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
  const pct = src.slice(src.indexOf('const setAmountPercentage = '), src.indexOf('const startTxConfirmationPolling = '));
  expect(pct).toMatch(/setSendAmount\(amountShare\(\{/);
  expect(pct).toMatch(/feeNano: sendingToken\.contract \? 0 : TRANSFER_FEE_NANO/);
  expect(pct).not.toMatch(/toFixed/);
  expect(src).toMatch(/e && e\.code === 'AMOUNT_DECIMALS' \? t\('err_AMOUNT_DECIMALS', e\.params\) : t\('send_invalid_amount'\)/);
  expect(src).toMatch(/testID="send-amount-decimals"/);
});

// The amount field of both Send forms: a pasted figure with thousands separators is the figure it says or nothing,
// never a smaller one read with a separator taken for the decimal point.
describe('amountInput: what the amount field keeps of a typed or pasted figure', () => {
  const { amountInput } = require('../src/utils/sendAmount');

  it('both separators: the last is the decimal point, the other only groups thousands', () => {
    expect(amountInput('1,000.50', 6)).toBe('1000.50');
    expect(amountInput('1.000,50', 6)).toBe('1000.50');
    expect(amountInput('12,345,678.9', 6)).toBe('12345678.9');
    expect(amountInput('1.234.567,891', 6)).toBe('1234567.891');
    // Anything else is refused: the field keeps what it had.
    expect(amountInput('1,00.50', 6)).toBeNull();
    expect(amountInput('1,0000.5', 6)).toBeNull();
    expect(amountInput('1000,000.5', 6)).toBeNull();
    expect(amountInput('1.000.5,0', 6)).toBeNull();
    expect(amountInput('1,000.5.0', 6)).toBeNull();
    // A separator typed after an amount is not read as making the rest a group: "1.000" then "," stays as it was.
    expect(amountInput('1.000,', 6)).toBeNull();
    expect(amountInput('1,000.', 6)).toBeNull();
  });

  it('one separator several times only groups thousands', () => {
    expect(amountInput('1,000,000', 6)).toBe('1000000');
    expect(amountInput('1.000.000', 6)).toBe('1000000');
    expect(amountInput('1,2,3', 6)).toBeNull();
    expect(amountInput('1.2.3', 9)).toBeNull();
    expect(amountInput('12,34,567', 6)).toBeNull();
  });

  it('a single comma is the decimal point, as before', () => {
    expect(amountInput('12,5', 6)).toBe('12.5');
    expect(amountInput(',25', 6)).toBe('0.25');
    expect(amountInput('1,000', 6)).toBe('1.000');
    expect(amountInput('0,1234567', 6)).toBe('0.123456');
  });

  it('spaces, no-break spaces and apostrophes group; other marks go', () => {
    expect(amountInput('1 000 000.25', 6)).toBe('1000000.25');
    expect(amountInput('1\u00A0000,5', 6)).toBe('1000.5');
    expect(amountInput('1\u202F234\u202F567,8', 6)).toBe('1234567.8');
    expect(amountInput("1'000'000.5", 6)).toBe('1000000.5');
    expect(amountInput('1\u2019000.5', 6)).toBe('1000.5');
    expect(amountInput(' 2.5 QNC', 6)).toBe('2.5');
    expect(amountInput('abc12,3456789', 6)).toBe('12.345678');
  });

  it('digits, one point, the places the field takes; a leading point gets its zero', () => {
    expect(amountInput('', 6)).toBe('');
    expect(amountInput('.5', 9)).toBe('0.5');
    expect(amountInput('7', 0)).toBe('7');
    expect(amountInput('1.123456789', 9)).toBe('1.123456789');
    expect(amountInput('1.123456789', 6)).toBe('1.123456');
    expect(amountInput('9'.repeat(40), 6)).toHaveLength(32);
  });

  it('both forms use it, and a refused text leaves the field as it was', () => {
    const ws = fs.readFileSync(path.join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    const qnet = ws.slice(ws.indexOf('const validateAmountInput = '), ws.indexOf('const setAmountPercentage = '));
    expect(qnet).toMatch(/const normalized = amountInput\(text, 6\);\s*if \(normalized === null\) return;/);
    expect(qnet).not.toMatch(/replace\(',', '\.'\)/);
    const sol = fs.readFileSync(path.join(__dirname, '../src/screens/SolanaSend.js'), 'utf8');
    expect(sol).toMatch(/const s = amountInput\(text, decimals\);\s*return s === null \? kept : s;/);
    expect(sol).toMatch(/onAmount\(cleanAmountInput\(text, token\.decimals, amount\)\)/);
  });
});
