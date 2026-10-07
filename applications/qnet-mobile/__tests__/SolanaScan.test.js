/**
 * 29.09: the Solana Send screen's QR scan (utils/solanaRequest + components/QrScanSheet): a Solana address, or the
 * standard payment-request text `solana:<address>?…` for SOL or a token the wallet holds, fills in the form, and
 * nothing read is ever opened; the QNet Send screen's scan still takes a QNet address only. The whole addresses on the
 * QNet Link sheets, a site's connect sheet, the Assets card and Receive fit one line.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Linking, StyleSheet, Text } from 'react-native';
import nacl from 'tweetnacl';
import { makeT } from '../src/i18n';
import { ONE_DEV_MINT } from '../src/config/nodes';
import { base58Encode, associatedTokenAddress } from '../src/crypto/SolanaTx';
import { SOLANA_TOKENS } from '../src/services/SolanaSend';
import { MAX_MEMO_BYTES, parseSolanaScan, solanaScanToForm } from '../src/utils/solanaRequest';

jest.mock('../src/services/QNetLink', () => ({
  ...jest.requireActual('../src/services/QNetLink'),
  openSession: jest.fn(async () => ({ expiresAt: Date.now() + 60000 })),
  prepareOffer: jest.fn(async () => ({
    kind: 'connect',
    addresses: { qnet: 'd9fa370374e24333242eon847d1d354dcd87fe873823e', solana: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' },
  })),
  deliverAnswer: jest.fn(async () => 'delivered'),
  markHandled: jest.fn(async () => {}),
}));

jest.mock('react-native-camera-kit', () => {
  const mockReact = require('react');
  const { View: MockView } = require('react-native');
  const Camera = mockReact.forwardRef((props, ref) => mockReact.createElement(MockView, { ...props, ref }));
  return { __esModule: true, Camera, default: {} };
});

const ROOT = path.join(__dirname, '..');
const t = makeT('en');
const ADDR = base58Encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey);
const OTHER_MINT = base58Encode(new Uint8Array(32).fill(0x44));
const REF = (n) => base58Encode(new Uint8Array(32).fill(0x60 + n));
const QNET = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';

describe('what the Solana scan reads (parseSolanaScan)', () => {
  it('a plain address, trimmed: the recipient only', () => {
    expect(parseSolanaScan(` ${ADDR}\n`)).toEqual({ ok: true, address: ADDR, amount: null, mint: null, references: [], memo: null, request: false });
  });

  it('a payment request: recipient, amount, token, references and memo; label and message are ignored', () => {
    expect(parseSolanaScan(`solana:${ADDR}`)).toEqual({ ok: true, address: ADDR, amount: null, mint: null, references: [], memo: null, request: true });
    const text = `solana:${ADDR}?amount=12.5&spl-token=${ONE_DEV_MINT}&reference=${REF(1)}&reference=${REF(2)}`
      + '&label=Shop%20name&message=Thanks%20for%20your%20order&memo=order%2042&unknown=1';
    expect(parseSolanaScan(text)).toEqual({
      ok: true, address: ADDR, amount: '12.5', mint: ONE_DEV_MINT, references: [REF(1), REF(2)], memo: 'order 42', request: true,
    });
    expect(parseSolanaScan(`SOLANA:${ADDR}?amount=1`)).toMatchObject({ ok: true, amount: '1' }); // the scheme in any case
    expect(parseSolanaScan(`solana:${ADDR}?amount=0`)).toMatchObject({ ok: true, amount: null }); // zero asks for no amount
    expect(parseSolanaScan(`solana:${ADDR}?amount=0.000`)).toMatchObject({ ok: true, amount: null });
    expect(parseSolanaScan(`solana:${ADDR}?`)).toMatchObject({ ok: true, amount: null });
    // Form encoding, as request generators write it: '+' is a space and %2B a plus.
    expect(parseSolanaScan(`solana:${ADDR}?memo=order+42%2B1`)).toMatchObject({ ok: true, memo: 'order 42+1' });
  });

  it('a malformed or repeated parameter makes the request unreadable', () => {
    for (const q of [
      'amount=1e3', 'amount=-1', 'amount=.5', 'amount=1.', 'amount=1,5', 'amount=', 'amount=1%2B1', 'amount=0x10',
      'amount=1&amount=2', `spl-token=${ONE_DEV_MINT}&spl-token=${ONE_DEV_MINT}`, 'spl-token=notamint', 'spl-token=',
      `reference=${REF(1)}&reference=${REF(1)}`, 'reference=bad',
      [1, 2, 3, 4, 5].map((n) => `reference=${REF(n)}`).join('&'),
      'memo=', `memo=${'x'.repeat(MAX_MEMO_BYTES + 1)}`, 'memo=a%E2%80%AEb', 'memo=a%0Ab', 'memo=%E0%A4%A', 'memo=a&memo=b',
    ]) {
      expect([q, parseSolanaScan(`solana:${ADDR}?${q}`)]).toEqual([q, { ok: false, reason: 'invalid' }]);
    }
    expect(parseSolanaScan(`solana:${ADDR}?memo=${'é'.repeat(MAX_MEMO_BYTES / 2)}`)).toMatchObject({ ok: true });
    expect(parseSolanaScan(`solana:${ADDR}?${[1, 2, 3, 4].map((n) => `reference=${REF(n)}`).join('&')}`).references).toHaveLength(4);
  });

  it('a memo that is not well-formed (a lone surrogate, only raw text holds one) makes the request unreadable', () => {
    // Its UTF-8 would be U+FFFD, not the text shown; the extension refuses it too (CONTRACTS.md decision 34).
    for (const memo of ['a\uD800b', '\uDC00', 'x\uD83D', '😀\uDC00']) {
      expect([memo, parseSolanaScan(`solana:${ADDR}?memo=${memo}`)]).toEqual([memo, { ok: false, reason: 'invalid' }]);
    }
    expect(solanaScanToForm(`solana:${ADDR}?memo=a\uD800b`, SOLANA_TOKENS)).toEqual({ note: 'scan_request_invalid' });
    expect(parseSolanaScan(`solana:${ADDR}?memo=😀`)).toMatchObject({ ok: true, memo: '😀' });
    expect(parseSolanaScan(`solana:${ADDR}?memo=%F0%9F%98%80`)).toMatchObject({ ok: true, memo: '😀' });
  });

  it('anything else is not a Solana address: links, a link as the recipient, other addresses, junk', () => {
    for (const text of [
      'https://example.org/pay', `https://example.org/?to=${ADDR}`, 'solana:https://example.org/tx', 'solana:https%3A%2F%2Fexample.org',
      `solana:${ADDR}x`, `solana:${ADDR.slice(0, 20)}`, 'solana:', `example:${ADDR}`, QNET, 'a'.repeat(64), `${ADDR} ${ADDR}`,
      base58Encode(new Uint8Array(31).fill(9)), base58Encode(new Uint8Array(64).fill(9)), 'hello world', '',
      `solana:${ADDR}?memo=${'x'.repeat(3000)}`, null, undefined, 42, { address: ADDR },
    ]) {
      expect([text, parseSolanaScan(text)]).toEqual([text, { ok: false, reason: 'not_solana' }]);
    }
  });
});

describe('what a scan puts into the form (solanaScanToForm)', () => {
  const form = (text) => solanaScanToForm(text, SOLANA_TOKENS);

  it('an address leaves the token and the amount as they are', () => {
    expect(form(ADDR)).toEqual({ value: { address: ADDR, symbol: null, amount: null, request: null } });
  });

  it('a request names its token (SOL without spl-token) and an amount that fits its decimals', () => {
    expect(form(`solana:${ADDR}?amount=0.000000001`)).toEqual({
      value: { address: ADDR, symbol: 'SOL', amount: '0.000000001', request: { address: ADDR, references: [], memo: null } },
    });
    expect(form(`solana:${ADDR}?amount=0010.500000&spl-token=${ONE_DEV_MINT}&memo=hi&reference=${REF(1)}`)).toEqual({
      value: { address: ADDR, symbol: '1DEV', amount: '10.5', request: { address: ADDR, references: [REF(1)], memo: 'hi' } },
    });
    expect(form(`solana:${ADDR}?spl-token=${ONE_DEV_MINT}`)).toMatchObject({ value: { symbol: '1DEV', amount: null } });
  });

  it('more decimals than the token has, a token the wallet does not hold, and anything else are short notes', () => {
    expect(form(`solana:${ADDR}?amount=0.0000000001`)).toEqual({ note: 'scan_request_invalid' }); // 10 > 9 for SOL
    expect(form(`solana:${ADDR}?amount=1.1234567&spl-token=${ONE_DEV_MINT}`)).toEqual({ note: 'scan_request_invalid' });
    expect(form(`solana:${ADDR}?amount=1&spl-token=${OTHER_MINT}`)).toEqual({ note: 'scan_token_not_held' });
    expect(form(`solana:${ADDR}?amount=abc`)).toEqual({ note: 'scan_request_invalid' });
    expect(form('https://example.org')).toEqual({ note: 'scan_not_solana' });
    expect(form(QNET)).toEqual({ note: 'scan_not_solana' });
    expect([t('scan_not_solana'), t('scan_token_not_held'), t('scan_request_invalid')]).toEqual([
      'Not a Solana address', 'This wallet does not hold the requested token', 'This payment request cannot be read']);
  });
});

describe('the scan sheet on the Solana Send screen', () => {
  const QrScanSheet = require('../src/components/QrScanSheet').default;
  const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join(''));
  const read = async (tree, value) => {
    await act(async () => { tree.root.findByProps({ testID: 'scan-camera' }).props.onReadCode({ nativeEvent: { codeStringValue: value } }); });
  };
  afterEach(() => { jest.restoreAllMocks(); });

  it('its own title; junk, another address or a token the wallet lacks is a note while scanning; a request fills the form once', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const onAddress = jest.fn();
    let tree;
    await act(async () => {
      tree = renderer.create(<QrScanSheet t={t} title={t('scan_title_solana')} read={(x) => solanaScanToForm(x, SOLANA_TOKENS)} onAddress={onAddress} onClose={() => {}} />);
    });
    expect(texts(tree)).toContain('Scan a Solana address');
    for (const [junk, note] of [
      ['https://example.org/pay', 'Not a Solana address'], [QNET, 'Not a Solana address'],
      [`solana:${ADDR}?amount=1&spl-token=${OTHER_MINT}`, 'This wallet does not hold the requested token'],
      [`solana:${ADDR}?amount=1e9`, 'This payment request cannot be read'],
    ]) {
      await read(tree, junk);
      expect(texts(tree)).toContain(note);
      expect(tree.root.findAllByProps({ testID: 'scan-camera' }).length).toBeGreaterThan(0);
    }
    expect(onAddress).not.toHaveBeenCalled();
    await read(tree, `solana:${ADDR}?amount=2&spl-token=${ONE_DEV_MINT}`);
    await read(tree, ADDR);
    expect(onAddress.mock.calls).toEqual([[{ address: ADDR, symbol: '1DEV', amount: '2', request: { address: ADDR, references: [], memo: null } }]]);
    expect(openURL).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('the QNet Send screen\'s sheet still takes a QNet address only: a Solana address or request is "Not a QNet address"', async () => {
    const onAddress = jest.fn();
    let tree;
    await act(async () => { tree = renderer.create(<QrScanSheet t={t} onAddress={onAddress} onClose={() => {}} />); });
    expect(texts(tree)).toContain('Scan a QNet address');
    for (const other of [ADDR, `solana:${ADDR}?amount=1`]) {
      await read(tree, other);
      expect(texts(tree)).toContain('Not a QNet address');
    }
    expect(onAddress).not.toHaveBeenCalled();
    await read(tree, QNET);
    expect(onAddress.mock.calls).toEqual([[QNET]]);
    act(() => tree.unmount());
  });

  it('the wallet screen opens the Solana sheet only on the Solana Send screen, and what it reads only fills the form', () => {
    const screen = fs.readFileSync(path.join(ROOT, 'src/screens/WalletScreen.js'), 'utf8');
    expect(screen).toMatch(/\{showScan && showSendScreen && sendingToken && sendingToken\.network === 'solana' && activeTab === 'assets' \? \(\s*<QrScanSheet\s*t=\{t\}\s*title=\{t\('scan_title_solana'\)\}\s*read=\{\(text\) => solanaScanToForm\(text, SOLANA_TOKENS\)\}\s*onAddress=\{\(value\) => \{ applySolanaScan\(value\); setShowScan\(false\); \}\}/);
    const apply = screen.slice(screen.indexOf('const applySolanaScan = (value) => {'));
    const body = apply.slice(0, apply.indexOf('\n  };'));
    expect(body).toMatch(/setSendAddress\(value\.address\)/);
    // A request with no amount that switches the token keeps the typed amount within the new token's decimals.
    expect(body).toMatch(/else if \(value\.symbol\) setSendAmount\(\(prev\) => cleanAmountInput\(prev, solanaToken\(value\.symbol\)\.decimals\)\)/);
    expect(body).not.toMatch(/handleSend|reviewSend|confirmFresh|Linking/);
  });
});

describe('whole addresses fit one line', () => {
  const MONO_EM = 0.6; // a monospace character's advance, in em
  const width = (text, st) => [...text].length * MONO_EM * st.fontSize + (st.letterSpacing || 0) * [...text].length;
  const flat = (s) => StyleSheet.flatten(s) || {};
  // The widest the line can be at its smallest fit: the font at the largest system text size it follows, shrunk by
  // the minimum scale, and the letter spacing grown with the text size but never shrunk.
  const LARGEST_TEXT = 1.2;
  const widestFit = (text, st) => [...text].length
    * (MONO_EM * st.fontSize * LARGEST_TEXT * 0.5 + (st.letterSpacing || 0) * LARGEST_TEXT);

  it('the QNet Link sheet: both addresses of a connect, and the wallet of a reservation or a link, one line each, fitting 320 dp', async () => {
    const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
    const QNetLinkScreen = require('../src/screens/QNetLinkScreen').default;
    const { linkScreenStyles: s } = require('../src/screens/QNetLinkScreen');
    let tree;
    await act(async () => {
      tree = renderer.create(<QNetLinkScreen link={{ id: 'c'.repeat(32), intent: 'connect' }} wallet={{ qnetAddress: QNET, solanaAddress: SOL }} t={t} authenticate={async () => true} onClose={() => {}} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const lines = tree.root.findAll((n) => n.type === Text && n.props.testID === 'link-address');
    expect(lines.map((n) => n.props.children)).toEqual([QNET, SOL]);
    // The card's inner width on a 320 dp screen: the scroll's padding, the card's padding and border.
    const scroll = flat(s.scroll);
    const card = flat(s.card);
    const inner = 320 - 2 * scroll.padding - 2 * card.padding - 2 * card.borderWidth;
    for (const n of lines) {
      expect(n.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.5, maxFontSizeMultiplier: LARGEST_TEXT });
      const st = flat(n.props.style);
      expect(width(n.props.children, st)).toBeGreaterThan(inner); // at full size it would wrap: it shrinks instead
      expect(width(n.props.children, st) * n.props.minimumFontScale).toBeLessThanOrEqual(inner);
      // A larger system text size never pushes the smallest fit past the line (it would be cut with an ellipsis).
      expect(widestFit(n.props.children, st)).toBeLessThanOrEqual(inner);
    }
    const src = fs.readFileSync(path.join(ROOT, 'src/screens/QNetLinkScreen.js'), 'utf8');
    expect(src.match(/addressRow\(t\('link_wallet'\), o\.qnet\)/g)).toHaveLength(5); // reserve, unlink (this device, and by the wallet key), link, claim
    act(() => tree.unmount());
  });

  it('a site\'s connect sheet, the Assets card and Receive: one line, the font shrinking, never cut', () => {
    const dapp = fs.readFileSync(path.join(ROOT, 'src/browser/DappSheet.js'), 'utf8');
    expect(dapp).toMatch(/addressRow\(t\('dapp_qnet_address'\)/);
    expect(dapp).toMatch(/addressRow\(t\('dapp_solana_address'\)/);
    expect(dapp).toMatch(/const addressRow = [\s\S]{0,200}numberOfLines=\{1\} adjustsFontSizeToFit minimumFontScale=\{0\.5\} maxFontSizeMultiplier=\{1\.2\}/);
    const screen = fs.readFileSync(path.join(ROOT, 'src/screens/WalletScreen.js'), 'utf8');
    const card = screen.slice(screen.indexOf('testID="address-card"'), screen.indexOf('{cardAddress}', screen.indexOf('testID="address-card"')));
    expect(card).toMatch(/numberOfLines=\{1\}\s*adjustsFontSizeToFit\s*minimumFontScale=\{0\.5\}\s*maxFontSizeMultiplier=\{1\.2\}/);
    const receive = screen.slice(screen.indexOf('testID="receive-address"'), screen.indexOf('{currentReceiveAddress}', screen.indexOf('testID="receive-address"')));
    expect(receive).toMatch(/numberOfLines=\{1\} adjustsFontSizeToFit minimumFontScale=\{0\.5\} maxFontSizeMultiplier=\{1\.2\}/);
    expect(screen).not.toMatch(/numberOfLines=\{2\}\s*adjustsFontSizeToFit\s*minimumFontScale=\{0\.6\}/);
    // The Receive address on a 320 dp screen: the tab's padding and the address box's padding; the Assets card: the
    // tab's padding, the card's side padding and border; a site's sheet: the scroll's and the card's padding and border.
    const styles = require('../src/screens/WalletScreen.styles').default;
    const st = flat(styles.addressText);
    const receiveInner = 320 - 2 * flat(styles.content).padding - 2 * flat(styles.addressDisplay).padding;
    const box = flat(styles.addressContainer);
    const cardInner = 320 - 2 * flat(styles.content).padding - 2 * box.paddingHorizontal - 2 * box.borderWidth;
    const { sheetStyles } = require('../src/browser/DappSheet');
    const sheetInner = 320 - 2 * flat(sheetStyles.scroll).padding - 2 * flat(sheetStyles.card).padding - 2 * flat(sheetStyles.card).borderWidth;
    const SOL = associatedTokenAddress(ADDR, ONE_DEV_MINT).padEnd(44, 'W'); // the longest a Solana address can be
    for (const text of [QNET, SOL]) {
      expect(width(text, st) * 0.5).toBeLessThanOrEqual(receiveInner);
      expect(widestFit(text, st)).toBeLessThanOrEqual(receiveInner);
      expect(widestFit(text, st)).toBeLessThanOrEqual(cardInner);
      expect(widestFit(text, flat(sheetStyles.mono))).toBeLessThanOrEqual(sheetInner);
    }
    expect(associatedTokenAddress(ADDR, ONE_DEV_MINT).length).toBeLessThanOrEqual(44);
  });
});
