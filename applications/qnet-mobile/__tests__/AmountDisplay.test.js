/**
 * Every amount the app shows is written as its language writes figures (utils/amountFormat): the whole part grouped by
 * three, the language's decimal mark. What a field, a signature, a site or the history cache holds stays canonical.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

const { makeT, LANGUAGES } = require('../src/i18n');
const { compactAmount, compactDecimalText, describeTx } = require('../src/screens/HistoryTab');
const { formatNano, qncText } = require('../src/utils/amountFormat');
const { pendingLine } = require('../src/browser/DappSheet');
const { solText } = require('../src/services/SolanaSend');
const { cleanAmountInput } = require('../src/screens/SolanaSend');
const TxResultCard = require('../src/components/TxResultCard').default;

const NBSP = ' ';
const NNBSP = ' ';
const ME = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const OTHER = 'e'.repeat(45);

describe('History', () => {
  it('a row in the language\'s marks and within 11 characters; a suffixed figure takes only the decimal mark', () => {
    expect(compactAmount(98765.4321, 'de')).toBe('98.765,43');
    expect(compactAmount(98765.4321, 'ru')).toBe(`98${NBSP}765,43`);
    expect(compactAmount(1234.5, 'es')).toBe('1234,5');
    expect(compactAmount(12345.5, 'it')).toBe('12.345,5');
    expect(compactAmount(123456.7, 'fr')).toBe('123,46K');
    expect(compactAmount(4.2e15, 'de')).toBe('4200T');
    expect(compactAmount(1e-9, 'pt')).toBe('<0,00000001');
    expect(compactAmount(3.4e32, 'it')).toBe('3,4e32');
    expect(compactDecimalText('1,234,567.891234', 'de')).toBe('1,23M');
    expect(compactAmount(98765.4321)).toBe('98,765.43');
    for (const { code: lang } of LANGUAGES) {
      for (const n of [0.12345678, 1e-9, 99999.9999, 123456789012.345, 1e18]) {
        expect([lang, n, compactAmount(n, lang).length <= 11]).toEqual([lang, n, true]);
      }
    }
  });

  it('the detail: the exact amount and the fee; a token as the history keeps it, a Solana send', () => {
    const send = { hash: 'a'.repeat(64), from: ME, to: OTHER, amount: 1234567.12345, fee: 0.00015, status: 'confirmed', timestamp: 1, type: 'send' };
    const de = describeTx(send, 'de');
    expect(de.legs[0]).toMatchObject({ number: '−1,23M', exact: '−1.234.567,12345' });
    expect(de.fee).toBe('0,00015 QNC');
    expect(describeTx(send).legs[0].exact).toBe('−1,234,567.12345');
    const token = {
      hash: 'b'.repeat(64), from: OTHER, to: ME, amount: 0, fee: 0, status: 'confirmed', timestamp: 1, type: 'receive',
      tokenContract: 'c'.repeat(64), tokenSymbol: 'GLD', tokenAmountDisplay: '1,500.25', tokenMetaTrusted: true,
    };
    expect(describeTx(token, 'de').legs[0]).toMatchObject({ number: '+1.500,25', exact: '+1.500,25' });
    const sol = {
      hash: 's'.repeat(88), chain: 'solana', from: 'So1Owner', to: 'So1Recipient', amount: 0, fee: 0,
      solSymbol: 'SOL', solAmount: '1234.5', solFee: '0.000005', status: 'confirmed', timestamp: 1, type: 'send',
    };
    const fr = describeTx(sol, 'fr');
    expect(fr.legs[0].exact).toBe(`−1${NNBSP}234,5`);
    expect(fr.fee).toBe('0,000005 SOL');
  });

  // Before, the detail went through a float: 12345678123456789 nanoQNC read 12,345,678.123456787.
  it('the detail of a QNC row is exact from its nanoQNC text, past 2^53 too', () => {
    const { nodeNativeRow } = require('../src/utils/txHistory');
    const row = nodeNativeRow({ hash: 'a'.repeat(64), tx_type: 'Transfer', from: OTHER, to: ME, amount: '12345678123456789', timestamp: 1, fee: 0 }, ME);
    expect(describeTx(row).legs[0].exact).toBe('+12,345,678.123456789');
    expect(describeTx({ ...row, amountNano: '987654321987654321' }, 'de').legs[0].exact).toBe('+987.654.321,987654321');
    // A row that carries no nanoQNC text (a send this device just made) writes the figure it has.
    expect(describeTx({ ...row, amountNano: undefined, amount: 12.5 }).legs[0].exact).toBe('+12.5');
  });
});

describe('the Node tab, the QNet Link sheet and the browser\'s sheet', () => {
  // Before, the Node tab and the QNet Link sheet rounded a node balance to six decimals while the Node tab's result card
  // wrote it exact: one partial move read 1.234567891 QNC on one screen and 1.234568 QNC on the other.
  it('a node balance and a claim amount: one helper, exact to the nano, in every screen', () => {
    expect(qncText(4714356375000, 'ru')).toBe(`4${NBSP}714,356375 QNC`);
    expect(qncText(4714356375000, 'en')).toBe('4,714.356375 QNC');
    expect(qncText(1234567891, 'en')).toBe('1.234567891 QNC');
    expect(qncText('1234567891', 'en')).toBe('1.234567891 QNC');
    expect(qncText(0, 'en')).toBe('0 QNC');
    expect(qncText(4714356375000, 'ru', true)).toBe('••••');
    // Not read yet, or no node answered: unknown, never "0 QNC".
    for (const unknown of [Number.NaN, -1, 1.5, null, undefined, 'x', 2 ** 53]) expect(qncText(unknown, 'de')).toBe('—');
    // The Node tab, the QNet Link sheet and the result card's note all write it through this one helper.
    const fs = require('fs');
    const read = (f) => fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
    expect(read('src/screens/NodeTab.js')).not.toMatch(/balanceText|toFixed\(6\)/);
    expect(read('src/screens/QNetLinkScreen.js')).not.toMatch(/from '\.\/NodeTab'|balanceText/);
    expect(read('src/screens/QNetLinkScreen.js')).toMatch(/\{ amount: qncText\(n\.appliedNano, t\.lang\) \}/);
    expect(read('src/screens/WalletScreen.js')).toMatch(/\{ amount: qncText\(n\.appliedNano, t\.lang\) \}/);
  });

  it('QNC on the sheet and the line of an unconfirmed transfer, the canonical figure kept for sites', () => {
    expect(formatNano('1500500000000')).toBe('1500.5');
    expect(qncText('1500500000000', 'de')).toBe('1.500,5 QNC');
    expect(qncText('x', 'de')).toBe('—');
    const t = makeT('de');
    const line = pendingLine(t, { kind: 'transfer', amountNano: 1500500000000, to: OTHER, ageMs: 120000 });
    expect(line).toBe(`${t('pending_line_transfer', { amount: '1.500,5 QNC', to: OTHER })} · ${t('time_min', { n: 2 })}`);
  });
});

describe('the result card', () => {
  it('shows a canonical amount in the language\'s marks', async () => {
    let tree;
    await act(async () => {
      tree = renderer.create(<TxResultCard state="success" title="x" amount="12345.5" symbol="QNC" t={makeT('fr')} />);
    });
    const text = tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('\n');
    expect(text).toContain(`12${NNBSP}345,5 QNC`);
    await act(async () => { tree.unmount(); });
  });
});

describe('the Solana form', () => {
  it('SOL in the language\'s marks; a figure pasted as the language writes it is read as written', () => {
    expect(solText(1500000000000n, 'de')).toBe('1.500 SOL');
    expect(solText(5000, 'fr')).toBe('0,000005 SOL');
    expect(cleanAmountInput('1.500', 9, '', 'de')).toBe('1500');
    expect(cleanAmountInput('1,500', 9, '', 'en')).toBe('1500');
    // Typed one character at a time, a comma is still the decimal point.
    expect(cleanAmountInput('1,', 9, '1', 'en')).toBe('1.');
  });
});
