import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Linking, Text, TouchableOpacity } from 'react-native';
import TxResultCard from '../src/components/TxResultCard';
import { explorerTxUrl, EXPLORER_API } from '../src/config/nodes';
import { matchesAsset } from '../src/utils/txHistory';

const texts = (tree) => tree.root.findAllByType(Text).map((t) => t.props.children).flat(Infinity).join('');

describe('transaction result surface', () => {
  it('points at the explorer page of this transaction', () => {
    expect(explorerTxUrl('abc')).toBe(`${EXPLORER_API}/explorer/tx/abc`);
    expect(explorerTxUrl('')).toBe(`${EXPLORER_API}/explorer/tx/`);
  });

  it('reports a success with its amount and opens the hash in the explorer', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    let tree;
    await act(async () => {
      tree = renderer.create(
        <TxResultCard ok title="Transaction Sent!" amount="10" symbol="QNC" counterparty={'a'.repeat(45)} hash="f00d" />
      );
    });
    expect(texts(tree)).toContain('✓');
    expect(texts(tree)).toContain('10 QNC');

    const hashCard = tree.root.findAllByType(TouchableOpacity)[0];
    await act(async () => { hashCard.props.onPress(); });
    expect(open).toHaveBeenCalledWith(`${EXPLORER_API}/explorer/tx/f00d`);
    open.mockRestore();
    await act(async () => { tree.unmount(); });
  });

  it('reports a failure the same way, with no amount and no hash card', async () => {
    let tree;
    await act(async () => {
      tree = renderer.create(<TxResultCard ok={false} title="Claim failed" amount="10" error="node refused" />);
    });
    expect(texts(tree)).toContain('✕');
    expect(texts(tree)).toContain('node refused');
    expect(texts(tree)).not.toContain('10');
    expect(tree.root.findAllByType(TouchableOpacity)).toHaveLength(0);
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
