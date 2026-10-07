/**
 * History rows (owner, 06.10): each row is the asset's icon with a badge for what happened, a title in plain words over
 * whom it was with (and its status after it while it is not final), and the amount with its sign and colour; one row per
 * transaction (a node registration the registry and a transaction feed both report is one row, never a "Sent 0 QNC"
 * beside "Node registered"); a header per day; and a screen-reader label naming what, the amount and when.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { StyleSheet, Text, View } from 'react-native';
import {
  BADGES, BadgeGlyph, HistoryRow, TxDetail, dayLabel, describeTx, rowA11yLabel, shortAddress, txKind,
} from '../src/screens/HistoryTab';
import {
  historyEntries, historySections, mergeHistory, splitExplorerItems, txNodeId, txTypeName, nodeNativeRow,
} from '../src/utils/txHistory';
import { tokenIconSource, tokenIconUri } from '../src/components/TokenIcons';

const { makeT } = require('../src/i18n');

const t = makeT('en');
const ME = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const OTHER = 'e'.repeat(45);
const BURN = '0000000000000000000eon00000000000000036877022';
const CONTRACT = 'c0ffee1234567890abcdef1234567890abcdef1234567890abcdef12345678aa';
const AT = new Date(2026, 9, 6, 14, 29).getTime(); // 06.10.2026, 14:29 local
const NOW = new Date(2026, 9, 6, 18, 0).getTime();

const native = (extra = {}) => ({ hash: 'a'.repeat(64), from: ME, to: OTHER, amount: 12.5, fee: 0.00015, status: 'confirmed', timestamp: AT, type: 'send', ...extra });
const token = (extra = {}) => ({
  hash: 'b'.repeat(64), tokenLogIndex: 0, from: OTHER, to: ME, amount: 0, fee: 0, status: 'confirmed', timestamp: AT, type: 'receive',
  tokenContract: CONTRACT, tokenSymbol: 'GLD', tokenAmountDisplay: '1,500', tokenMetaTrusted: true, ...extra,
});
const sol = (extra = {}) => ({
  hash: 's'.repeat(88), chain: 'solana', from: 'So1Owner', to: 'So1Recipient11111111111111111111', amount: 0, fee: 0,
  solSymbol: 'SOL', solAmount: '0.5', solFee: '0.000005', status: 'confirmed', timestamp: AT, type: 'send', ...extra,
});
const nodeEvent = (extra = {}) => ({
  hash: 'node:light_9f3a2c1d0e7b', nodeEvent: true, nodeId: 'light_9f3a2c1d0e7b', nodeType: 'light', height: 2851100,
  from: ME, to: null, amount: 0, fee: 0, status: 'confirmed', timestamp: AT, type: 'receive', ...extra,
});
// What the explorer archive serves for this wallet's registration (from = the wallet, no recipient, nothing moved).
const registrationItem = { source: 'tx', hash: 'f'.repeat(64), idx: 3, block: 2851100, timestamp: AT, from: ME, to: null, amount: '0', tx_type: 'NodeRegistration', fee: '0' };

const shown = (d) => ({
  kind: d.kind, badge: d.badge, title: t(d.title), status: d.status,
  sub: d.sub ? (d.sub.text != null ? d.sub.text : t(d.sub.key, d.sub.params)) : null,
  amounts: d.legs.map((l) => `${l.number} ${l.symbol}`), tones: d.legs.map((l) => l.tone),
});
const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string').join(''));

describe('each kind of row: icon, badge, title, whom with, amount, sign and colour', () => {
  it('QNC sent, received, to itself and burnt', () => {
    expect(shown(describeTx(native()))).toEqual({
      kind: 'send', badge: 'sent', title: 'Sent', status: 'confirmed', sub: `To: ${OTHER.slice(0, 4)}…${OTHER.slice(-4)}`,
      amounts: ['−12.5 QNC'], tones: ['#ffffff'],
    });
    expect(describeTx(native()).icon.source).toBe(tokenIconSource('QNC'));
    expect(shown(describeTx(native({ from: OTHER, to: ME, type: 'receive' })))).toMatchObject({
      kind: 'receive', badge: 'received', title: 'Received', sub: 'From: eeee…eeee', amounts: ['+12.5 QNC'], tones: ['#00ff88'],
    });
    expect(shown(describeTx(native({ to: ME, type: 'self' })))).toMatchObject({
      kind: 'self', badge: 'self', title: 'Sent to self', sub: null, amounts: ['12.5 QNC'], tones: ['#00d4ff'],
    });
    expect(shown(describeTx(native({ to: BURN })))).toMatchObject({ kind: 'burn', badge: 'burn', title: 'Burned', amounts: ['−12.5 QNC'] });
  });

  it('a token: its letter and symbol, its contract id when not added, an NFT by its id', () => {
    const d = describeTx(token());
    expect(shown(d)).toMatchObject({ kind: 'receive', badge: 'received', amounts: ['+1,500 GLD'], tones: ['#00ff88'] });
    expect(d.icon).toMatchObject({ source: null, letter: 'G', seed: CONTRACT });
    expect(shown(describeTx(token({ tokenMetaTrusted: false }))).amounts).toEqual(['+1,500 GLD (c0ffee…78aa)']);
    expect(shown(describeTx(token({ tokenStd: 'qrc721', tokenId: '123456789012', type: 'send', from: ME, to: OTHER }))).amounts)
      .toEqual(['−#1234…9012 GLD']);
    expect(shown(describeTx(token({ tokenSymbol: 'QNC', tokenMetaTrusted: false }))).amounts[0]).toMatch(/^\+1,500 ⚠ QNC \(/);
  });

  it('a Solana send: the asset\'s own icon; a failed one carries the red mark, says Failed and greys its amount', () => {
    const d = describeTx(sol());
    expect(d.icon.source).toEqual({ uri: tokenIconUri('SOL') });
    expect(shown(d)).toMatchObject({ kind: 'send', badge: 'sent', amounts: ['−0.5 SOL'], sub: 'To: So1R…1111' });
    expect(describeTx(sol({ solSymbol: '1DEV' })).icon.source).toEqual({ uri: tokenIconUri('1DEV') });
    expect(shown(describeTx(sol({ status: 'failed' })))).toMatchObject({ badge: 'failed', status: 'failed', tones: ['#8a8fa3'] });
  });

  it('a node registration moves nothing: the node badge, the node, no amount', () => {
    expect(shown(describeTx(nodeEvent()))).toEqual({
      kind: 'node_registered', badge: 'node', title: 'Node registered', status: 'confirmed', sub: 'Node light_9f3a2c1d0e7b', amounts: [], tones: [],
    });
    // The explorer's registration row alone (the registry's feed down): never "Sent 0 QNC".
    const [row] = splitExplorerItems([registrationItem], ME).native;
    expect(shown(describeTx(historyEntries([row])[0]))).toMatchObject({ kind: 'node_registered', title: 'Node registered', amounts: [], sub: 'Block 2851100' });
    // A node's row of it names the node in its type.
    const nodeRow = nodeNativeRow({ hash: 'f'.repeat(64), tx_type: 'NodeRegistration { node_id: "light_9f3a2c1d0e7b", node_type: Light, wallet_address: "x" }', from: ME, to: null, amount: 0, timestamp: AT / 1000 }, ME);
    expect(txTypeName(nodeRow.txType)).toBe('NodeRegistration');
    expect(txNodeId(nodeRow.txType)).toBe('light_9f3a2c1d0e7b');
    expect(shown(describeTx(historyEntries([nodeRow])[0]))).toMatchObject({ kind: 'node_registered', sub: 'Node light_9f3a2c1d0e7b', amounts: [] });
  });

  it('the node balance moved into the wallet, a node check-in, a node back online, an older activation', () => {
    const claim = native({ from: 'system_rewards_pool', to: ME, type: 'receive', amount: 5, txType: 'RewardDistribution', fee: 0 });
    expect(shown(describeTx(claim))).toMatchObject({
      kind: 'node_claim', badge: 'node', title: 'Moved from node', sub: 'From: node balance', amounts: ['+5 QNC'], tones: ['#00ff88'],
    });
    const checkin = native({ amount: 0, to: null, txType: 'Heartbeat { node_id: "super_ab12", anchor_height: 10, anchor_hash: "x" }' });
    expect(shown(describeTx(checkin))).toMatchObject({ kind: 'node_checkin', badge: 'node', title: 'Node check-in', sub: 'Node super_ab12', amounts: [] });
    // The activation transaction of older blocks brought a node in as a registration does, and is called so.
    expect(shown(describeTx(native({ amount: 0, to: null, txType: 'NodeActivation' })))).toMatchObject({ kind: 'node_registered', title: 'Node registered', amounts: [] });
    expect(shown(describeTx(native({ amount: 0, to: null, txType: 'NodeReactivation' })))).toMatchObject({ kind: 'node_back_online', title: 'Node back online' });
  });

  it('a contract call: the code badge and the contract id; an amount only when it carried value', () => {
    expect(shown(describeTx(native({ to: CONTRACT, amount: 0, txType: 'ContractCall' })))).toEqual({
      kind: 'contract_call', badge: 'contract', title: 'Contract call', status: 'confirmed', sub: 'Contract c0ffee…78aa', amounts: [], tones: [],
    });
    expect(shown(describeTx(native({ to: CONTRACT, amount: 2, txType: 'ContractCall' }))).amounts).toEqual(['−2 QNC']);
    expect(shown(describeTx(native({ to: CONTRACT, amount: 0, txType: 'ContractDeploy' })))).toMatchObject({ kind: 'contract_deploy', title: 'Contract deployed' });
  });

  it('a swap: two legs of one transaction, the one received first, its asset\'s icon', () => {
    const out = token({ tokenLogIndex: 0, type: 'send', from: ME, to: CONTRACT, tokenSymbol: 'GLD', tokenAmountDisplay: '10' });
    const got = token({ tokenLogIndex: 1, tokenContract: 'd'.repeat(64), tokenSymbol: 'SLV', tokenAmountDisplay: '250', from: CONTRACT });
    const entries = historyEntries([out, got]);
    expect(entries).toHaveLength(1);
    const d = describeTx(entries[0]);
    expect(shown(d)).toEqual({
      kind: 'swap', badge: 'swap', title: 'Swap', status: 'confirmed', sub: 'GLD → SLV', amounts: ['+250 SLV', '−10 GLD'], tones: ['#00ff88', '#ffffff'],
    });
    expect(d.icon.letter).toBe('S');
    expect(txKind(native({ txType: 'Swap' }))).toBe('swap');
    // A contract call's own 0 QNC row beside the token it brought in is no swap, and no "0 QNC" line.
    const call = native({ hash: 'b'.repeat(64), to: CONTRACT, amount: 0, txType: 'ContractCall' });
    const [one] = historyEntries([call, token()]);
    expect(shown(describeTx(one))).toMatchObject({ kind: 'contract_call', amounts: ['+1,500 GLD'] });
  });

  it('a row not final says its status after whom it was with, wrapping rather than cutting either', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<HistoryRow tx={native({ status: 'pending' })} t={t} hideAmounts={false} onOpen={() => {}} />); });
    expect(texts(tree)).toEqual(['Sent', 'To: eeee…eeee', 'Pending', '−12.5', ' QNC']);
    // Whom with keeps one line; the status is its own run beside it, which wraps under it when both do not fit.
    const party = tree.root.findAllByType(Text).find((n) => [].concat(n.props.children).includes('To: eeee…eeee'));
    expect([party.props.numberOfLines, party.props.adjustsFontSizeToFit, party.props.minimumFontScale]).toEqual([1, true, 0.8]);
    const line = tree.root.findAll((n) => n.type === View && n.findAllByType(Text).includes(party)).pop();
    expect(StyleSheet.flatten(line.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    expect(line.findAllByType(Text).map((n) => [].concat(n.props.children).join(''))).toEqual(['To: eeee…eeee', 'Pending']);
    await act(async () => { tree.update(<HistoryRow tx={native()} t={t} hideAmounts={false} onOpen={() => {}} />); });
    expect(texts(tree)).toEqual(['Sent', 'To: eeee…eeee', '−12.5', ' QNC']);
    // A row that names no one says its status alone.
    await act(async () => { tree.update(<HistoryRow tx={native({ status: 'pending', to: null, amount: 0, txType: 'ContractCall' })} t={t} hideAmounts={false} onOpen={() => {}} />); });
    expect(texts(tree)).toEqual(['Contract call', 'Pending']);
    await act(async () => { tree.update(<HistoryRow tx={native({ status: 'dropped' })} t={t} hideAmounts={false} onOpen={() => {}} />); });
    expect(texts(tree)).toContain('Not found');
    // Nothing moved: the red mark, as for a failed one (and as the extension draws a dropped row).
    expect(tree.root.findAll((n) => n.props.testID === 'history-badge-glyph-failed')).not.toHaveLength(0);
    // A confirmed row says no status.
    await act(async () => { tree.update(<HistoryRow tx={native()} t={t} hideAmounts={false} onOpen={() => {}} />); });
    expect(texts(tree)).not.toContain('Confirmed');
  });

  it('a number and symbol too long for one line stack the symbol under the number, as the extension does; a short pair shares it', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<HistoryRow tx={token({ tokenSymbol: 'LONGSYMBOL', tokenAmountDisplay: '98,765.4321' })} t={t} hideAmounts={false} onOpen={() => {}} />); });
    expect(texts(tree).slice(-2)).toEqual(['+98,765.43', 'LONGSYMBOL']);
    const number = tree.root.findAllByType(Text).find((n) => [].concat(n.props.children).join('') === '+98,765.43');
    expect(StyleSheet.flatten(number.parent.props.style).flexDirection).not.toBe('row');
    await act(async () => { tree.update(<HistoryRow tx={native()} t={t} hideAmounts={false} onOpen={() => {}} />); });
    expect(texts(tree).slice(-2)).toEqual(['−12.5', ' QNC']);
    const inline = tree.root.findAllByType(Text).find((n) => [].concat(n.props.children).join('') === '−12.5');
    expect(StyleSheet.flatten(inline.parent.props.style).flexDirection).toBe('row');
  });

  it('every badge is a disc in the app\'s colours with its glyph; a failed row carries the red one', async () => {
    const Svg = require('react-native-svg');
    for (const name of Object.keys(BADGES)) {
      let glyph;
      await act(async () => { glyph = renderer.create(<BadgeGlyph name={name} size={18} />); });
      expect([name, glyph.root.findAllByType(Svg.Circle).find((n) => n.props.r === 12).props.fill]).toEqual([name, BADGES[name].fill]);
      expect([name, glyph.root.findAllByType(Svg.Path)[0].props.d]).toEqual([name, BADGES[name].d]);
      expect([name, BADGES[name].fill]).toEqual([name, expect.stringMatching(/^#(ffffff|00ff88|00d4ff|b0b0b0|ffaa00|ff4444)$/)]);
      await act(async () => { glyph.unmount(); });
    }
    let tree;
    await act(async () => { tree = renderer.create(<HistoryRow tx={sol({ status: 'failed' })} t={t} hideAmounts={false} onOpen={() => {}} />); });
    expect(tree.root.findAll((n) => n.props.testID === 'history-badge-glyph-failed')).not.toHaveLength(0);
    const disc = tree.root.findAllByType(Svg.Circle).find((n) => n.props.r === 12);
    expect(disc.props.fill).toBe('#ff4444');
  });
});

describe('one row per transaction', () => {
  it('the registration the explorer serves and the registry\'s node event are one row: "Node registered", nothing sent', async () => {
    // As loadTxHistory assembles them: the explorer page, then the node lifecycle rows, merged into what is shown.
    const { native: archived } = splitExplorerItems([
      registrationItem,
      { source: 'tx', hash: '9'.repeat(64), idx: 0, block: 2851000, timestamp: AT - 60000, from: OTHER, to: ME, amount: '2000000000', tx_type: 'Transfer', fee: '0' },
    ], ME);
    const merged = mergeHistory([], [...archived, nodeEvent()], { myAddress: ME, coveredFromMs: 0, nowMs: NOW, nodeEventsOk: true });
    expect(merged).toHaveLength(3); // the feeds' rows stay as served (and cached); the list folds them
    const entries = historyEntries(merged);
    expect(entries).toHaveLength(2);
    const reg = entries.find((e) => e.nodeRegistration);
    expect(reg).toMatchObject({ hash: 'f'.repeat(64), nodeId: 'light_9f3a2c1d0e7b', nodeType: 'light', height: 2851100, status: 'confirmed', block: 2851100 });
    let tree;
    await act(async () => { tree = renderer.create(<HistoryRow tx={reg} t={t} hideAmounts={false} onOpen={() => {}} />); });
    const words = texts(tree);
    expect(words).toContain('Node registered');
    expect(words).toContain('Node light_9f3a2c1d0e7b');
    expect(words.join('|')).not.toMatch(/Sent|QNC/);
    // Its detail: the node, the transaction's hash and its explorer page.
    const onExplorer = jest.fn();
    await act(async () => { tree = renderer.create(<TxDetail tx={{ ...reg, nodeTypeTitle: 'Light node' }} t={t} onBack={() => {}} onCopy={() => {}} onExplorer={onExplorer} />); });
    expect(texts(tree)).toEqual(expect.arrayContaining(['Node registered', 'Light node', 'light_9f3a2c1d0e7b', 'f'.repeat(64), '2851100']));
    expect(tree.root.findAll((n) => n.props.testID === 'history-icon-node')).not.toHaveLength(0);
    await act(async () => { tree.root.find((n) => n.props.testID === 'tx-detail-explorer').props.onPress(); });
    expect(onExplorer).toHaveBeenCalledWith('f'.repeat(64), 'qnet');
  });

  it('a node\'s reported row of the registration is matched by the node it names and is settled by the registry', () => {
    const nodeRow = nodeNativeRow({ hash: 'f'.repeat(64), tx_type: 'NodeRegistration { node_id: "light_9f3a2c1d0e7b", node_type: Light }', from: ME, amount: 0, timestamp: AT / 1000 }, ME);
    expect(nodeRow.status).toBe('reported');
    const entries = historyEntries([nodeRow, nodeEvent({ timestamp: 0 })]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ nodeRegistration: true, status: 'confirmed', timestamp: AT });
  });

  it('a node event alone stays a row; a registration of another node is not folded into it', () => {
    const other = { ...splitExplorerItems([{ ...registrationItem, block: 99 }], ME).native[0] };
    const entries = historyEntries([other, nodeEvent()]);
    expect(entries).toHaveLength(2);
    expect(entries.filter((e) => e.nodeEvent)).toHaveLength(1);
  });

  it('a standalone node event\'s detail has no hash and no explorer page', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<TxDetail tx={nodeEvent()} t={t} onBack={() => {}} onCopy={() => {}} onExplorer={() => {}} />); });
    expect(tree.root.findAll((n) => n.props.testID === 'tx-detail-explorer' || n.props.testID === 'tx-detail-copy')).toHaveLength(0);
    expect(texts(tree)).not.toContain('node:light_9f3a2c1d0e7b');
  });

  it('rows of different transactions, and the same hash on two networks, stay apart', () => {
    expect(historyEntries([native(), native({ hash: 'c'.repeat(64) }), sol({ hash: 'a'.repeat(64) })])).toHaveLength(3);
  });
});

describe('day headers', () => {
  const day = (y, m, d, h = 12) => new Date(y, m, d, h).getTime();

  it('newest first under Today, Yesterday, the date (with the year only when not this year), and Earlier last', () => {
    const rows = [
      native({ hash: '1', timestamp: day(2025, 11, 31) }),
      native({ hash: '2', timestamp: 0 }),
      native({ hash: '3', timestamp: day(2026, 9, 6, 9) }),
      native({ hash: '4', timestamp: day(2026, 9, 5, 23) }),
      native({ hash: '5', timestamp: day(2026, 9, 6, 17) }),
      native({ hash: '6', timestamp: day(2026, 8, 30) }),
    ];
    const items = historySections(rows, NOW);
    expect(items.map((i) => (i.dayHeader ? `[${dayLabel(i, t, NOW)}]` : i.hash))).toEqual([
      '[Today]', '5', '3', '[Yesterday]', '4', '[September 30]', '6', '[December 31, 2025]', '1', '[Earlier]', '2',
    ]);
    expect(new Set(items.filter((i) => i.dayHeader).map((i) => i.key)).size).toBe(5);
    // In the app's language.
    const ru = makeT('ru');
    expect(dayLabel(items[0], ru, NOW)).toBe('Сегодня');
    expect(dayLabel(items.find((i) => i.day === 'date'), ru, NOW)).toBe('30 сентября');
    expect(dayLabel(items.find((i) => i.day === 'date'), makeT('de'), NOW)).toBe('30. September');
  });

  it('an empty list has no header', () => {
    expect(historySections([], NOW)).toEqual([]);
  });
});

describe('the QNC icon', () => {
  it('is the bundled mark Assets draws, enlarged to fill its round; no embedded copy is left', () => {
    expect(tokenIconSource('QNC')).toBe(require('../assets/qnet_logo.png'));
    expect(tokenIconUri('QNC')).toBe(null);
    expect(describeTx(native()).icon).toMatchObject({ source: require('../assets/qnet_logo.png'), zoom: 1.4 });
  });

  it('decodes: every chunk\'s CRC holds and the image data inflates to its full size (the embedded copy it replaces did not)', () => {
    /* eslint-disable no-bitwise */
    const fs = require('fs');
    const zlib = require('zlib');
    const { Buffer } = require('buffer');
    const png = fs.readFileSync(require('path').join(__dirname, '..', 'assets', 'qnet_logo.png'));
    const table = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    let o = 8;
    let width = 0;
    let height = 0;
    const idat = [];
    while (o < png.length) {
      const len = png.readUInt32BE(o);
      const type = png.toString('ascii', o + 4, o + 8);
      expect([type, png.readUInt32BE(o + 8 + len)]).toEqual([type, crc(png.subarray(o + 4, o + 8 + len))]);
      if (type === 'IHDR') { width = png.readUInt32BE(o + 8); height = png.readUInt32BE(o + 12); expect(png[o + 16]).toBe(8); expect(png[o + 17]).toBe(6); }
      if (type === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len));
      o += 12 + len;
    }
    expect(zlib.inflateSync(Buffer.concat(idat)).length).toBe(height * (width * 4 + 1));
    /* eslint-enable no-bitwise */
  });
});

describe('screen-reader labels', () => {
  it('what happened, the amount, whom with, its status and when (in the extension order); no amount while amounts are hidden', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<HistoryRow tx={native({ status: 'pending' })} t={t} hideAmounts={false} onOpen={() => {}} />); });
    const row = tree.root.find((n) => n.props.testID === 'history-row' && typeof n.props.onPress === 'function');
    expect(row.props.accessibilityLabel).toBe('Sent, −12.5 QNC, To: eeee…eeee, Pending, 06.10.2026, 14:29');
    await act(async () => { tree.update(<HistoryRow tx={native()} t={t} hideAmounts onOpen={() => {}} />); });
    expect(tree.root.find((n) => n.props.testID === 'history-row' && typeof n.props.onPress === 'function').props.accessibilityLabel)
      .toBe('Sent, To: eeee…eeee, 06.10.2026, 14:29');
    expect(rowA11yLabel(describeTx(nodeEvent()), nodeEvent(), t, false)).toBe('Node registered, Node light_9f3a2c1d0e7b, 06.10.2026, 14:29');
  });

  it('addresses are shortened to their first and last four characters', () => {
    expect(shortAddress(ME)).toBe('d9fa…823e');
    expect(shortAddress('short')).toBe('short');
  });
});

describe('the detail screen names the network\'s own senders in words (M-2)', () => {
  const FORBIDDEN = require('./fixtures/forbidden_words.json');
  const translations = require('../src/i18n/translations').default;
  // Every string the screen draws or hands to a screen reader.
  const said = (tree) => {
    const out = [...texts(tree)];
    for (const n of tree.root.findAll((x) => x.props && typeof x.props.accessibilityLabel === 'string')) out.push(n.props.accessibilityLabel);
    return out;
  };
  const claim = native({ from: 'system_rewards_pool', to: ME, type: 'receive', amount: 5, txType: 'RewardDistribution', fee: 0 });
  const detail = async (tx, tt = t, onCopy = () => {}) => {
    let tree;
    await act(async () => { tree = renderer.create(<TxDetail tx={tx} t={tt} onBack={() => {}} onCopy={onCopy} onExplorer={() => {}} />); });
    return tree;
  };

  it('a move of the node balance: "From: Node balance", never the raw id, in no language a forbidden word', async () => {
    expect(Object.keys(FORBIDDEN).sort()).toEqual(Object.keys(translations).sort());
    for (const lang of Object.keys(translations)) {
      const tt = makeT(lang);
      for (const tx of [claim, { ...claim, txType: undefined }, nodeNativeRow({ hash: 'd'.repeat(64), tx_type: 'RewardDistribution', from: 'system_rewards_pool', to: ME, amount: 5e9, timestamp: AT / 1000 }, ME)]) {
        const words = said(await detail(tx, tt));
        expect(words).toContain(tt('tx_detail_from_node_balance'));
        const bad = words.filter((w) => /system_/i.test(w) || FORBIDDEN[lang].some((f) => w.toLowerCase().includes(f.toLowerCase())));
        expect([lang, bad]).toEqual([lang, []]);
      }
    }
  });

  it('the sender is not copied and drawn in the plain face; an account still is copied', async () => {
    const onCopy = jest.fn();
    let tree = await detail(claim, t, onCopy);
    const value = tree.root.findAllByType(Text).find((n) => n.props.children === 'Node balance');
    expect(StyleSheet.flatten(value.props.style).fontFamily).toBe(StyleSheet.flatten(tree.root.findAllByType(Text).find((n) => n.props.children === 'From').props.style).fontFamily);
    const copiers = tree.root.findAll((n) => typeof n.props.onPress === 'function' && n.props.accessibilityHint === t('common_tap_to_copy'));
    for (const c of copiers) await act(async () => { c.props.onPress(); });
    expect(onCopy.mock.calls.map((c) => c[1])).not.toContain('detail-from');
    tree = await detail(native({ from: OTHER, to: ME, type: 'receive' }), t, onCopy);
    const from = tree.root.findAll((n) => typeof n.props.onPress === 'function' && n.props.accessibilityHint === t('common_tap_to_copy'))
      .find((n) => n.findAllByType(Text).some((x) => x.props.children === OTHER));
    await act(async () => { from.props.onPress(); });
    expect(onCopy).toHaveBeenLastCalledWith(OTHER, 'detail-from');
  });

  it('genesis is "Genesis" and any other system sender "Network"', async () => {
    let words = said(await detail(native({ from: 'genesis', to: ME, type: 'receive' })));
    expect(words).toContain(t('hist_genesis'));
    expect(words).not.toContain('genesis');
    words = said(await detail(native({ from: 'system_emission', to: ME, type: 'receive', txType: 'Transfer' })));
    expect(words).toContain('Network');
    expect(words.filter((w) => /system_/.test(w))).toEqual([]);
    // The bare "system" sender core also uses.
    words = said(await detail(native({ from: 'system', to: ME, type: 'receive', txType: 'Transfer' })));
    expect(words).toContain('Network');
    expect(words).not.toContain('system');
  });

  it('a row names such a sender in the same words, never by a shortened id', async () => {
    for (const [from, key] of [['system_emission', 'tx_detail_from_network'], ['system', 'tx_detail_from_network'], ['genesis', 'hist_genesis']]) {
      const tx = native({ from, to: ME, type: 'receive', txType: 'Transfer' });
      expect([from, describeTx(tx).sub]).toEqual([from, { key }]);
      let tree;
      await act(async () => { tree = renderer.create(<HistoryRow tx={tx} t={t} hideAmounts={false} onOpen={() => {}} />); });
      expect(said(tree).filter((w) => /syst/i.test(w))).toEqual([]);
    }
  });
});

describe('a token whose symbol carries a direction override (M-5)', () => {
  const RLO = 'Q\u202ECN\u202C';
  const FORMAT = /[\p{Cf}\p{Cc}]/u;

  it('its row and detail warn that it is not QNC and draw no format character', async () => {
    const tx = token({ tokenSymbol: RLO, tokenMetaTrusted: false });
    const d = describeTx(tx);
    expect(d.reserved).toBe(true);
    expect(d.legs[0].symbol.startsWith('⚠ ')).toBe(true);
    expect(FORMAT.test(d.legs[0].symbol)).toBe(false);
    expect(FORMAT.test(d.icon.letter)).toBe(false);
    let tree;
    await act(async () => { tree = renderer.create(<HistoryRow tx={tx} t={t} hideAmounts={false} onOpen={() => {}} />); });
    expect(texts(tree).filter((w) => FORMAT.test(w))).toEqual([]);
    await act(async () => { tree = renderer.create(<TxDetail tx={tx} t={t} onBack={() => {}} onCopy={() => {}} onExplorer={() => {}} />); });
    expect(texts(tree)).toContain(t('tok_reserved_warning'));
    expect(texts(tree).filter((w) => FORMAT.test(w))).toEqual([]);
  });
});
