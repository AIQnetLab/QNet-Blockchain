// The wallet's node from the genesis nodes' verify-activation answers (WalletManager.walletNode): the first answer that
// names a node names it at once, a second one alike confirms it, and only two authoritative answers say the wallet has
// none; whether a given server node is the wallet's takes two answers alike (confirmServerNode). Neither reads a table of
// genesis wallets: a genesis node is named by the answers as any other node.
const { WalletManager } = require('../src/components/WalletManager');
const { GENESIS_NODES } = require('../src/config/nodes');

const WALLET = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';

describe('the wallet\'s node, as the genesis nodes answer for it', () => {
  const answering = (byIndex) => jest.fn(async (url, opts) => {
    const i = GENESIS_NODES.findIndex((g) => url.startsWith(g));
    expect(url).toBe(`${GENESIS_NODES[i]}/api/v1/verify-activation`);
    expect(opts.headers['X-QNet-Wallet']).toBe(WALLET); // the wallet in a header, never in the URL
    const a = byIndex[i];
    return a === undefined ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => a };
  });

  it('true only when two genesis nodes each confirm the node; false only on two authoritative no', async () => {
    const wm = new WalletManager();
    const yes = { verified: true, node_type: 'super', node_id: 'super_x' };
    global.fetch = answering([yes, yes]);
    expect(await wm.confirmServerNode(WALLET, { nodeType: 'super', nodeId: 'super_x' })).toBe(true);
    global.fetch = answering([yes]);
    expect(await wm.confirmServerNode(WALLET, { nodeType: 'super', nodeId: 'super_x' })).toBeNull();
    global.fetch = answering([yes, { verified: true, node_type: 'super', node_id: 'super_other' }]);
    expect(await wm.confirmServerNode(WALLET, { nodeType: 'super', nodeId: 'super_x' })).toBeNull();
    const no = { verified: false, authoritative: true };
    global.fetch = answering([no, no, { verified: false, authoritative: false }]);
    expect(await wm.confirmServerNode(WALLET, { nodeType: 'super', nodeId: 'super_x' })).toBe(false);
    global.fetch = answering([{ verified: false, authoritative: false }, { verified: false, authoritative: false }]);
    expect(await wm.confirmServerNode(WALLET, { nodeType: 'super' })).toBeNull(); // nodes behind the network say nothing
  });

  // One verified answer names the node at once (onNamed) and the rest confirm it; "none" takes two authoritative answers.
  it('walletNode: named at once by the first answer, confirmed by a second alike; none only on two authoritative no', async () => {
    const wm = new WalletManager();
    const named = [];
    const onNamed = (node) => named.push(node);
    const yes = (id, type = 'super') => ({ verified: true, node_type: type, node_id: id });
    const no = { verified: false, authoritative: true };
    global.fetch = answering([yes('super_x'), yes('super_x')]);
    expect(await wm.walletNode(WALLET, { onNamed })).toEqual({ nodeId: 'super_x', nodeType: 'super', confirmed: true });
    expect(named).toEqual([{ nodeId: 'super_x', nodeType: 'super', confirmed: false }]);
    // One answer and nothing else: named, unconfirmed, never 'none'.
    named.length = 0;
    global.fetch = answering([undefined, yes('light_mobile_1111222233334444', 'light')]);
    expect(await wm.walletNode(WALLET, { onNamed })).toEqual({ nodeId: 'light_mobile_1111222233334444', nodeType: 'light', confirmed: false });
    expect(named).toHaveLength(1);
    // One "no" and nothing else, or nodes behind the network: nothing can be told.
    global.fetch = answering([no]);
    expect(await wm.walletNode(WALLET)).toBeNull();
    global.fetch = answering([{ verified: false, authoritative: false }, { verified: false, authoritative: false }, no]);
    expect(await wm.walletNode(WALLET)).toBeNull();
    // Two authoritative "no": the wallet has none, even when one answer named a node.
    global.fetch = answering([yes('super_x'), no, no]);
    expect(await wm.walletNode(WALLET)).toBe('none');
    // Nothing answers: unknown, and nothing is named.
    named.length = 0;
    global.fetch = answering([]);
    expect(await wm.walletNode(WALLET, { onNamed })).toBeNull();
    expect(named).toEqual([]);
    expect(await wm.walletNode(null)).toBeNull();
  });

  // The answers that settled the verdict decide what is shown: one that comes after two authoritative no names nothing.
  it('walletNode: an answer after the verdict names no node', async () => {
    const wm = new WalletManager();
    const named = [];
    // The genesis nodes are asked in a shuffled order: the first two asked say "no" at once, the third "yes" late.
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      const late = calls > 2;
      if (late) await new Promise((r) => setTimeout(r, 50));
      return { ok: true, json: async () => (late ? { verified: true, node_type: 'super', node_id: 'super_x' } : { verified: false, authoritative: true }) };
    });
    expect(await wm.walletNode(WALLET, { onNamed: (n) => named.push(n) })).toBe('none');
    await new Promise((r) => setTimeout(r, 100));
    expect(named).toEqual([]);
  });

  // The app keeps no table of genesis wallets: a genesis node two genesis nodes name is the wallet's node, as any node.
  it('walletNode: a genesis node two genesis nodes name is the wallet\'s, with no table in the app', async () => {
    const wm = new WalletManager();
    global.fetch = answering([undefined, { verified: true, node_type: 'super', node_id: 'genesis_node_003' },
      { verified: true, node_type: 'super', node_id: 'genesis_node_003' }]);
    expect(await wm.walletNode(WALLET)).toEqual({ nodeId: 'genesis_node_003', nodeType: 'super', confirmed: true });
    // Two that name different nodes confirm neither: the first named stands, unconfirmed.
    global.fetch = answering([{ verified: true, node_type: 'super', node_id: 'genesis_node_003' },
      { verified: true, node_type: 'super', node_id: 'super_y' }]);
    expect(await wm.walletNode(WALLET)).toMatchObject({ confirmed: false });
  });
});
