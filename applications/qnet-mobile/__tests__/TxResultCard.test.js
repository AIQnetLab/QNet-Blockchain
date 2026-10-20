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
  it('reports a success with its amount and opens the hash in the explorer; Copy answers on itself', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const Clipboard = require('@react-native-clipboard/clipboard').default;
    let tree;
    await act(async () => {
      tree = renderer.create(
        <TxResultCard state="success" title="Transaction Sent" amount="10" symbol="QNC" counterparty={'a'.repeat(45)} hash="f00d" />
      );
    });
    const shown = texts(tree);
    expect(shown).toContain('Transaction Sent');
    expect(shown).toContain('10 QNC');
    expect(shown).not.toMatch(/[✓⧗✕]/);
    const title = tree.root.findAllByType(Text).find((n) => n.props.children === 'Transaction Sent');
    expect(StyleSheet.flatten(title.props.style).color).toBe(color.paper);

    const hashCard = tree.root.findAll((n) => typeof n.props.onLongPress === 'function' && typeof n.props.onPress === 'function')[0];
    await act(async () => { hashCard.props.onPress(); });
    expect(open).toHaveBeenCalledWith(`${EXPLORER_API}/explorer/tx/f00d?from=app`);
    open.mockRestore();

    const copy = tree.root.find((n) => n.props.testID === 'tx-result-copy' && typeof n.props.onPress === 'function');
    expect(copy.props.label).toBe(tr('common_copy'));
    await act(async () => { copy.props.onPress(); });
    expect(Clipboard.setString).toHaveBeenCalledWith('f00d');
    expect(tree.root.find((n) => n.props.testID === 'tx-result-copy' && typeof n.props.onPress === 'function').props.label)
      .toBe(tr('common_copied'));
    await act(async () => { tree.unmount(); });
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
    expect(tree.root.findAll((n) => n.props.testID === 'tx-result-copy')).toHaveLength(0);
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
