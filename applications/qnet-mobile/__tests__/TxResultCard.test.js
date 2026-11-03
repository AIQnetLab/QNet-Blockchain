import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Linking, StyleSheet, Text } from 'react-native';
import TxResultCard from '../src/components/TxResultCard';
import { explorerTxUrl, EXPLORER_API } from '../src/config/nodes';
import { matchesAsset } from '../src/utils/txHistory';
import { color } from '../src/theme';
import { tr } from '../src/i18n';

const texts = (tree) => tree.root.findAllByType(Text).map((t) => t.props.children).flat(Infinity).join('');

describe('transaction result surface', () => {
  // With the `from=app` query every link of the app carries; the site shows the same page with or without it.
  it('points at the explorer page of this transaction', () => {
    expect(explorerTxUrl('abc')).toBe(`${EXPLORER_API}/explorer/tx/abc?from=app`);
    expect(explorerTxUrl('')).toBe(`${EXPLORER_API}/explorer/tx/?from=app`);
  });

  // The outcome is said by the title alone (no glyph in a circle); a refusal's title is in Ember.
  // The hash and the recipient are copied as every value is, by a tap, the copy mark answering; no Copy word.
  it('reports a success with its amount; Explorer opens the hash\'s page, a tap on the hash or the recipient copies it', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const onExplorer = jest.fn();
    const Clipboard = require('@react-native-clipboard/clipboard').default;
    const to = 'a'.repeat(45);
    let tree;
    await act(async () => {
      tree = renderer.create(
        <TxResultCard state="success" title="Transaction Sent" amount="10" symbol="QNC" counterparty={to} hash="f00d" onExplorer={onExplorer} />
      );
    });
    const shown = texts(tree);
    expect(shown).toContain('Transaction Sent');
    expect(shown).toContain('10 QNC');
    expect(shown).not.toMatch(/[✓⧗✕]/);
    expect(shown).not.toContain(tr('common_copied'));
    const title = tree.root.findAllByType(Text).find((n) => n.props.children === 'Transaction Sent');
    expect(StyleSheet.flatten(title.props.style).color).toBe(color.paper);

    const press = (id) => tree.root.find((n) => n.props.testID === id && typeof n.props.onPress === 'function');
    await act(async () => { press('tx-result-explorer').props.onPress(); });
    expect([onExplorer.mock.calls, open.mock.calls.length]).toEqual([[['f00d', 'qnet']], 0]);
    open.mockRestore();

    await act(async () => { await press('tx-result-hash').props.onPress(); });
    expect(Clipboard.setString).toHaveBeenLastCalledWith('f00d');
    await act(async () => { await press('tx-result-to').props.onPress(); });
    expect(Clipboard.setString).toHaveBeenLastCalledWith(to);
    expect(tree.root.findAll((n) => n.props.testID === 'copy-glyph-done' && typeof n.type === 'string').length).toBeGreaterThan(0);
    expect(tree.root.findAll((n) => n.props.kind === 'act')).toHaveLength(0);
    await act(async () => { tree.unmount(); });
  });

  // One handler opens a transaction's page and, when it cannot open, copies the hash and says so: the wallet screen's,
  // for the detail screen and this card alike.
  it('Explorer is the wallet screen\'s one handler: without it no Explorer, and the card itself opens and copies nothing', async () => {
    let tree;
    await act(async () => { tree = renderer.create(<TxResultCard state="success" title="Sent" amount="1" symbol="QNC" hash="beef" />); });
    expect(tree.root.findAll((n) => n.props.testID === 'tx-result-explorer')).toHaveLength(0);
    await act(async () => { tree.unmount(); });
    const fs = require('fs');
    const path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    expect(read('src/components/TxResultCard.js')).not.toMatch(/Linking|Clipboard|explorerTxUrl/);
    const ws = read('src/screens/WalletScreen.js');
    expect(ws).toMatch(/<TxResultCard[^>]*\sonExplorer=\{shownResult\.explorer \? handleOpenTx : null\}/s);
    expect(ws).toMatch(/explorer: r\.chain !== 'solana' && !r\.unrun/);
    const handler = /Linking\.openURL\(chain === 'solana' \? solanaExplorerTxUrl\(hash\) : explorerTxUrl\(hash\)\)\.catch\(\(\) => \{\s*Clipboard\.setString\(hash\);\s*setCustomAlert\(\{[^}]*tx_hash_copied/g;
    expect(ws.match(handler)).toHaveLength(1);
  });

  it('reports a failure the same way, with no amount and no hash card, its title in Ember', async () => {
    let tree;
    await act(async () => {
      tree = renderer.create(<TxResultCard state="failed" title="Claim Failed" amount="10" error="node refused" />);
    });
    expect(texts(tree)).toContain('node refused');
    expect(texts(tree)).not.toContain('10');
    const title = tree.root.findAllByType(Text).find((n) => n.props.children === 'Claim Failed');
    expect(StyleSheet.flatten(title.props.style).color).toBe(color.ember);
    expect(tree.root.findAll((n) => n.props.testID === 'tx-result-hash')).toHaveLength(0);
    await act(async () => { tree.unmount(); });
  });

  it('reports an unanswered submit as pending: its amount stands, and it is not an error', async () => {
    let tree;
    await act(async () => {
      tree = renderer.create(
        <TxResultCard state="pending" title="Awaiting Confirmation" amount="10" symbol="QNC" note="not decided yet" />
      );
    });
    const shown = texts(tree);
    expect(shown).toContain('10 QNC');
    expect(shown).toContain('not decided yet');
    const title = tree.root.findAllByType(Text).find((n) => n.props.children === 'Awaiting Confirmation');
    expect(StyleSheet.flatten(title.props.style).color).toBe(color.paper);
    await act(async () => { tree.unmount(); });
  });
});

// The result screen: its status at the top, the details on one card, Done at the foot whatever the card holds.
describe('the result screen in three parts', () => {
  const { ScrollView, View } = require('react-native');
  const flat = (s) => StyleSheet.flatten(s) || {};
  const host = (tree, id) => tree.root.find((n) => n.props.testID === id && typeof n.type === 'string');
  const textIn = (node) => node.findAllByType(Text).map((n) => n.props.children).flat(Infinity).join('');
  const has = (node, id) => node.findAll((n) => n.props.testID === id).length > 0;
  const word = (tree, status) => tree.root.findAll((n) => n.type === Text && n.props.testID === `tx-result-status-${status}`);
  const liveDot = (tree) => tree.root.findAll((n) => n.type === View && flat(n.props.style).backgroundColor === color.signal).length > 0;
  const draw = async (el) => { let tree; await act(async () => { tree = renderer.create(el); }); return tree; };
  const HASH = 'ab'.repeat(32);
  const TO = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';

  it('what happened at the top, the details on one card, the explorer and Done at the foot out of the scroll', async () => {
    const tree = await draw(
      <TxResultCard state="success" status="pending" title="Transaction Sent" amount="10" symbol="QNC" counterparty={TO}
        fee="0.00015 QNC" block={9100} hash={HASH} onExplorer={() => {}} onAction={() => {}} />,
    );
    const scroll = tree.root.findByType(ScrollView);
    const head = host(tree, 'tx-result-head');
    const card = host(tree, 'tx-result-details');
    expect([has(scroll, 'tx-result-head'), has(scroll, 'tx-result-details')]).toEqual([true, true]);
    // The details' card is the theme's one card, with the recipient, the fee, the block and the hash on it.
    expect(flat(card.props.style)).toMatchObject({ borderRadius: 16, borderColor: color.rule, backgroundColor: color.surface });
    for (const id of ['tx-result-to', 'tx-result-fee', 'tx-result-block', 'tx-result-hash']) expect([id, has(card, id)]).toEqual([id, true]);
    expect(textIn(card)).toContain('0.00015 QNC');
    expect(textIn(card)).toContain('9100');
    expect([has(head, 'tx-result-hash'), textIn(head).includes('10 QNC')]).toEqual([false, true]);
    // The foot: outside the scroll, the explorer (outlined, across) over Done (the one filled action).
    const foot = host(tree, 'tx-result-actions');
    expect([has(scroll, 'tx-result-actions'), has(scroll, 'tx-result-done'), has(scroll, 'tx-result-explorer')]).toEqual([false, false, false]);
    const actions = foot.findAll((n) => n.props.kind && n.props.label);
    expect(actions.map((a) => [a.props.testID, a.props.kind])).toEqual([['tx-result-explorer', 'text'], ['tx-result-done', 'solid']]);
    expect(actions[0].props.align).toBe('center');
    expect(flat(foot.props.style)).toMatchObject({ borderTopWidth: 1, borderTopColor: color.rule });
    expect(foot.props.edges).toMatchObject({ bottom: 'additive', top: 'off' });
    await act(async () => { tree.unmount(); });
  });

  // The words are History's (screens/HistoryTab BADGE_KEY), in every language.
  it('says the chain\'s state at the top: the live dot while no block took it, Confirmed in Mint, a move no block took in Ember', async () => {
    for (const status of ['pending', 'moving']) {
      const tree = await draw(<TxResultCard state="success" status={status} title="x" amount="1" symbol="QNC" />);
      expect([status, word(tree, status).map((n) => n.props.children), liveDot(tree)])
        .toEqual([status, [tr(`hist_status_${status}`)], true]);
      await act(async () => { tree.unmount(); });
    }
    const done = await draw(<TxResultCard state="success" status="confirmed" title="x" amount="1" symbol="QNC" />);
    expect([word(done, 'confirmed').map((n) => n.props.children), flat(word(done, 'confirmed')[0].props.style).color, liveDot(done)])
      .toEqual([[tr('hist_status_confirmed')], color.mint, false]);
    await act(async () => { done.unmount(); });
    const expired = await draw(<TxResultCard state="success" status="failed" title="x" amount="1" symbol="QNC" />);
    expect(flat(word(expired, 'failed')[0].props.style).color).toBe(color.ember);
    await act(async () => { expired.unmount(); });
    // A refusal's title says it alone; no status at all without one.
    const refused = await draw(<TxResultCard state="failed" status="failed" title="Transaction Failed" error="no" />);
    const none = await draw(<TxResultCard state="success" title="x" amount="1" />);
    expect([word(refused, 'failed').length, liveDot(refused), liveDot(none)]).toEqual([0, false, false]);
    await act(async () => { refused.unmount(); none.unmount(); });
  });

  // Hide balances masks every amount (utils/privacy): the result screen exactly as History's detail screen does.
  it('with amounts hidden, the amount and the fee show masked as in History; whom it went to and the hash stay', async () => {
    const { MASK } = require('../src/utils/amountFormat');
    const props = {
      state: 'success', status: 'pending', title: 'Transaction Sent', amount: '235717.81871', symbol: 'QNC', counterparty: TO,
      fee: '0.00015 QNC', hash: HASH,
    };
    const hidden = await draw(<TxResultCard {...props} hideAmounts />);
    const all = texts(hidden);
    expect([all.includes('235,717.81871'), all.includes('0.00015')]).toEqual([false, false]);
    expect(textIn(hidden.root.find((n) => n.props.testID === 'tx-result-amount' && n.type === Text))).toBe(MASK);
    expect(textIn(host(hidden, 'tx-result-details'))).toContain(MASK);
    expect(all).toContain(TO);
    await act(async () => { hidden.unmount(); });
    const shown = await draw(<TxResultCard {...props} />);
    expect(texts(shown)).toContain('235,717.81871 QNC');
    expect(texts(shown)).toContain('0.00015 QNC');
    await act(async () => { shown.unmount(); });
    // The wallet screen hands the card the mask (a move's note masked too: App1110.test.js).
    const screen = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
    expect(screen).toMatch(/<TxResultCard\b[^>]*\bhideAmounts=\{balancesHidden\}/);
    // A send refused for want of balance says so on the same card: every figure of it masked too, the balance included.
    const refusals = [...screen.matchAll(
      /t\((?:'send_insufficient_(?:qnc|token)'|need\.depositNano \? 'send_fee_short_deposit' : 'send_fee_short'), \{([\s\S]*?)\}\)/g,
    )].map((m) => m[1]);
    expect(refusals).toHaveLength(5);
    for (const params of refusals) {
      expect(params.split('shownAmount(').length).toBe(params.split(', balancesHidden)').length);
      expect(params).toContain('balance: shownAmount(');
    }
  });

  it('a move says where the amount came from; a refused transaction shows no fee, since it took none', async () => {
    const move = await draw(<TxResultCard state="success" status="moving" title="Move submitted" amount="4" symbol="QNC" source="Node balance" hash={HASH} />);
    const card = host(move, 'tx-result-details');
    expect(textIn(card)).toContain(tr('tx_detail_from'));
    expect(textIn(card)).toContain('Node balance');
    await act(async () => { move.unmount(); });
    const refused = await draw(<TxResultCard state="failed" title="Expired" error="no block" fee="0.00015 QNC" hash={HASH} />);
    expect([has(refused.root, 'tx-result-fee'), has(refused.root, 'tx-result-hash')]).toEqual([false, true]);
    // Nothing to detail: no empty card.
    const bare = await draw(<TxResultCard state="failed" title="Cannot send" error="no" />);
    expect(bare.root.findAll((n) => n.props.testID === 'tx-result-details')).toHaveLength(0);
    await act(async () => { refused.unmount(); bare.unmount(); });
  });
});

describe('history asset filter', () => {
  const native = { hash: 'n1' };
  const token = { hash: 't1', tokenContract: '0xAbC' };

  it('keeps everything under all, splits native from a token contract', () => {
    expect(matchesAsset(native, 'all')).toBe(true);
    expect(matchesAsset(token, 'all')).toBe(true);
    expect(matchesAsset(native, 'qnc')).toBe(true);
    expect(matchesAsset(token, 'qnc')).toBe(false);
    expect(matchesAsset(token, '0xabc')).toBe(true);
    expect(matchesAsset(token, '0xother')).toBe(false);
    expect(matchesAsset(native, '0xabc')).toBe(false);
  });
});
