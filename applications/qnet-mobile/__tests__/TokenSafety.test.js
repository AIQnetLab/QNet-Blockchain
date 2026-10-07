// A token sent to this wallet unasked is not listed until the user shows it, one named after QNet is marked as
// not QNC, and every row carries its contract id (MOBNET-R2-08).
const { usesReservedName, contractShortId, tokenVisible, tokenLabel } = require('../src/utils/tokenSafety');

it('spots QNet\'s names in any spelling a reader takes for them', () => {
  for (const [symbol, name] of [
    ['QNC', 'Anything'], ['qnc', ''], ['Q N C', ''], ['ＱＮＣ', ''], ['QNC.', ''], ['XYZ', 'QNet - claim bonus at qnet-claim.io'],
    ['WQNC', 'Wrapped'], ['BONUS', 'Official Q-Net rewards'], ['X', 'q​net'],
  ]) {
    expect([symbol, name, usesReservedName(symbol, name)]).toEqual([symbol, name, true]);
  }
  for (const [symbol, name] of [['GLD', 'Guild gold'], ['QUAN', 'Quantum points'], ['', ''], [null, undefined]]) {
    expect([symbol, name, usesReservedName(symbol, name)]).toEqual([symbol, name, false]);
  }
});

// The look-alike skeleton runs before NFKD and after it: NFKD makes the lunate sigma letters Sigma and final sigma, and
// keeps the small capitals, some letterlike symbols and the boxed letters. The extension compiles this same rule
// (its test/core.test.mjs).
it('spots QNet\'s names spelled with letters NFKD changes or keeps', () => {
  for (const [symbol, name] of [
    ['QNϹ', ''], ['qnϲ', ''], // Greek lunate sigma, capital and small
    ['QNⲤ', ''], ['qnⲥ', ''], // Coptic Sima
    ['QNᴄ', ''], ['ꞯɴᴄ', ''], ['', 'QNᴇᴛ Coin'], // small capitals C; Q, N, C; E, T
    ['QᶰC', ''], // modifier small capital N, which NFKD makes the small capital
    ['', 'QN℮T'], ['', 'QNℇT'], // the estimated sign; the Euler constant, which NFKC makes the open E
    ['', 'QNƐT'], ['', 'qnɛt'], ['', 'qnεt'], ['', 'qnϵt'], // open E; Greek epsilon, lunate too
    ['զNC', ''], ['Qꓠꓚ', ''], ['', 'QNꓰꓔ'], // Armenian Za; Lisu N, C; Lisu E, T
    ['QNᏟ', ''], ['qnꮯ', ''], ['', 'QNᎬᎢ'], ['', 'qnꭼꭲ'], // Cherokee
    ['', 'QNЄT'], ['', 'qnєt'], // Ukrainian Ie
    ['\u{1F160}\u{1F15D}\u{1F152}', ''], ['\u{1F180}\u{1F17D}\u{1F172}', ''], // negative circled, negative squared
    ['\u{1F1F6}\u{1F1F3}\u{1F1E8}', ''], ['', '\u{1F180}\u{1F17D}\u{1F174}\u{1F183}'], // regional indicators; QNET
    ['', 'Q N ᴇ T'], ['ＱɴϹ', ''], // spaced; full-width Q with the others
  ]) {
    expect([symbol, name, usesReservedName(symbol, name)]).toEqual([symbol, name, true]);
  }
  // Names that only share these letters stay unmarked.
  for (const [symbol, name] of [
    ['ᴄᴏɪɴ', 'Small caps coin'], ['NEO', '℮-token'], ['\u{1F150}\u{1F151}\u{1F152}', 'Boxed'],
    ['ЄВРО', 'євро'], ['ΣΣ', 'Σigma'], ['զ', 'Qanat'],
  ]) {
    expect([symbol, name, usesReservedName(symbol, name)]).toEqual([symbol, name, false]);
  }
});

// An accent makes no other word: NFKD parts it from its letter and it is dropped with the other marks, so a letter
// written whole ('Ċ') reads as the same letter with a combining accent ('C' + U+0307) already did.
it('spots QNet\'s names spelled with accented letters, written whole or with a combining accent', () => {
  for (const [symbol, name] of [
    ['QNĊ', ''], ['QÑC', ''], ['QŃC', ''], ['QNÇ', ''], ['Q̨NC', ''], ['QNĊ', ''],
    ['', 'QNÉT'], ['', 'qńeţ'], ['', 'QΝΈΤ'], ['QṆĈ', ''], ['ꞯɴᴄ́', ''],
  ]) {
    expect([symbol, name, usesReservedName(symbol, name)]).toEqual([symbol, name, true]);
  }
  for (const [symbol, name] of [['CAFÉ', 'Café crème'], ['ÑANDÚ', 'Ñandú'], ['QÜÉ', 'Qué']]) {
    expect([symbol, name, usesReservedName(symbol, name)]).toEqual([symbol, name, false]);
  }
});

it('a symbol or name with a hidden or format character is marked, and shown with the character replaced', () => {
  for (const [symbol, name] of [['‮CNQ', 'Token'], ['Q‮CN‬', 'Token'], ['QN​C', 'Token'], ['ABC', 'A⁦B⁩C'], ['T﻿', 'T']]) {
    expect([symbol, name, usesReservedName(symbol, name)]).toEqual([symbol, name, true]);
  }
  expect(tokenLabel('‮CNQ')).toBe('�CNQ');
  expect(tokenLabel('Q‮CN‬')).toBe('Q�CN�');
  expect(tokenLabel('USDT')).toBe('USDT');
  expect(tokenLabel(null)).toBe('');
  expect(usesReservedName('ABC', 'Alpha Beta')).toBe(false);
});

it('a label made safe keeps its warning and carries no format character (Q\\u202ECN\\u202C)', () => {
  const symbol = 'Q‮CN‬';
  const label = tokenLabel(symbol);
  expect(usesReservedName(symbol, '')).toBe(true);
  expect(/\p{Cf}/u.test(label)).toBe(false);
  expect(label).toBe('Q�CN�');
  // The Send screen and a pending History row hold the label, not the raw symbol: the warning stays.
  expect(usesReservedName(label, '')).toBe(true);
  expect(usesReservedName('', tokenLabel('‮tenq'))).toBe(true);
  expect(usesReservedName(tokenLabel('GLD'), tokenLabel('Guild gold'))).toBe(false);
});

it('every screen writes a token\'s symbol and name through tokenLabel', () => {
  const fs = require('fs');
  const path = require('path');
  const ws = fs.readFileSync(path.join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
  // No symbol or name of a token row is drawn raw: not as a title, a second line, an avatar letter or a send choice.
  expect(ws).not.toMatch(/tk\.symbol \|\| tk\.name/);
  expect(ws).not.toMatch(/\{tk\.name\}/);
  expect(ws).toMatch(/const tokenTitle = \(tk\) => tokenLabel\(tk\.symbol\) \|\| tokenLabel\(tk\.name\) \|\| t\('tok_default_name'\);/);
  const history = fs.readFileSync(path.join(__dirname, '../src/screens/HistoryTab.js'), 'utf8');
  expect(history).toMatch(/const tokenSymbol = tokenLabel\(tx\.tokenSymbol\);/);
  expect(history).not.toMatch(/String\(tx\.tokenSymbol/);
});

it('names every contract by a short id', () => {
  expect(contractShortId('1a2b3c'.padEnd(64, '0') + '')).toBe('1a2b3c…0000');
  expect(contractShortId('abc')).toBe('abc');
});

it('lists a token only when the user added it or chose to show it, and never one the user hid', () => {
  const hidden = new Set(['h']);
  const added = new Set(['a', 'h']);
  const shown = new Set(['s']);
  expect(tokenVisible('a', { hidden, added, shown })).toBe(true);
  expect(tokenVisible('s', { hidden, added, shown })).toBe(true);
  expect(tokenVisible('airdrop', { hidden, added, shown })).toBe(false);
  expect(tokenVisible('h', { hidden, added, shown })).toBe(false);
  expect(tokenVisible('', { hidden, added, shown })).toBe(false);
});

it('the Assets list, the proofs and the manager all use this rule', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
  expect(src).toMatch(/qrcTokens\.filter\(\(tk\) => isTokenShown\(tk\.contract\)\)\.map/);
  expect(src).toMatch(/const toProve = list\.filter\(\(tk\) => tokenVisible\(/);
  expect(src).toMatch(/t\('tok_contract_id', \{ id: contractShortId\(tk\.contract\) \}\)/);
  expect(src).toMatch(/t\('tok_reserved_warning'\)/);
});
