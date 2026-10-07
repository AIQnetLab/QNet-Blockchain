/**
 * 29.09, the Node tab for both node types (R4): the wallet's super node id as the chain derives it, the chain's
 * registrations of the wallet's nodes (node-events), a server node's registration flag and its counted and missed
 * epochs (PushService), and what aiqnet.io records of a node the network does not list yet (NodeRecordRead), of which
 * the app reads the state and the node type only.
 */
const { WalletManager } = require('../src/components/WalletManager');
const { GENESIS_NODES, EXPLORER_API } = require('../src/config/nodes');
const { checkServerNodeStatus, getWalletNodeEvents, getNodeEpochs } = require('../src/services/PushService');
const { readNodeRecordState, pendingNodeType } = require('../src/services/NodeRecordRead');

const reply = (body, status = 200) => Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(body) });

describe('the wallet\'s super node id', () => {
  // Two super nodes of the live registry at height 2,084,400 (registry rows node_id / wallet): the ids the node's
  // generate_super_node_pseudonym gave their wallets.
  it.each([
    ['006a5c220ca2fa77021eon2b5c6703999066d5411e2ff', 'super_node_60a735f53dd87f1b'],
    ['c81f26da185fd05dcaeeona499b3d9e58d7ec75304f1b', 'super_node_76d638f2b358fc9f'],
  ])('%s → %s, as the chain derives it', (wallet, id) => {
    expect(WalletManager.prototype.generateSuperNodePseudonym(wallet)).toBe(id);
    // Its own domain: the light id of the same wallet is another.
    expect(WalletManager.prototype.generateLightNodePseudonym(wallet)).not.toBe(id.replace('super_node_', 'light_mobile_'));
  });
});

describe('the node status of a server node', () => {
  it('carries whether the chain registered it, from onchain_registered or registered; nothing when a node says neither', async () => {
    const body = (over) => ({ success: true, node_id: 'super_node_60a735f53dd87f1b', node_type: 'super', is_online: true,
      last_seen: 1790000000, last_seen_ago_seconds: 42, heartbeat_count: 4, required_heartbeats: 9, pending_rewards: 0, ...over });
    for (const [over, registered] of [
      [{ onchain_registered: true, registered: true }, true],
      [{ onchain_registered: false, registered: false }, false],
      [{ registered: false }, false],
      [{}, undefined],
    ]) {
      global.fetch = jest.fn(() => reply(body(over)));
      const s = await checkServerNodeStatus('super_node_60a735f53dd87f1b', null, 1);
      expect([over, s.registered]).toEqual([over, registered]);
      expect(s).toMatchObject({ lastSeen: 1790000000, lastSeenAgoSeconds: 42, heartbeatCount: 4, requiredHeartbeats: 9 });
    }
  });
});

describe('the chain\'s registrations of the wallet\'s nodes (node-events)', () => {
  const W = '006a5c220ca2fa77021eon2b5c6703999066d5411e2ff';
  const ids = {
    light: WalletManager.prototype.generateLightNodePseudonym(W), super: 'super_node_60a735f53dd87f1b', genesis: null,
  };

  it('takes only the ids this wallet derives, types them by id, ignores the burn, and asks a genesis node by name', async () => {
    const calls = [];
    global.fetch = jest.fn((url) => {
      calls.push(url);
      return reply({ address: W, count: 4, events: [
        { type: 'node_activation', node_id: ids.super, node_type: 'Light', height: 1, timestamp: 0, burn_tx: '' },
        { type: 'node_activation', node_id: ids.light, node_type: 'light', height: 2084000, timestamp: 1, burn_tx: 'x' },
        { type: 'node_activation', node_id: 'super_node_76d638f2b358fc9f', node_type: 'super', height: 5, burn_tx: '' },
        { type: 'node_activation', node_id: 'genesis_node_001', node_type: 'super', height: 0, burn_tx: '' },
        { type: 'other', node_id: ids.light, height: 3 },
      ] });
    });
    expect(await getWalletNodeEvents(W, ids)).toEqual({ success: true, nodes: [
      { nodeId: ids.super, nodeType: 'super', height: 1 },
      { nodeId: ids.light, nodeType: 'light', height: 2084000 },
    ] });
    expect(calls).toHaveLength(1);
    expect(GENESIS_NODES.some((g) => calls[0] === `${g}/api/v1/account/${W}/node-events`)).toBe(true);
  });

  it('a genesis wallet\'s genesis id is its super node; an answer for another address or none at all is unknown', async () => {
    global.fetch = jest.fn(() => reply({ address: W, events: [{ type: 'node_activation', node_id: 'genesis_node_003', height: 0 }] }));
    expect(await getWalletNodeEvents(W, { ...ids, genesis: 'genesis_node_003' })).toEqual({ success: true, nodes: [
      { nodeId: 'genesis_node_003', nodeType: 'super', height: 0 }] });
    global.fetch = jest.fn(() => reply({ address: 'someone else', events: [] }));
    expect(await getWalletNodeEvents(W, ids)).toEqual({ success: false });
    global.fetch = jest.fn(() => Promise.reject(new Error('down')));
    expect(await getWalletNodeEvents(W, ids)).toEqual({ success: false });
    expect(global.fetch).toHaveBeenCalledTimes(2); // a second genesis node, then no more
  });
});

describe('a server node\'s counted and missed epochs', () => {
  const W = '006a5c220ca2fa77021eon2b5c6703999066d5411e2ff';
  const ID = 'super_node_60a735f53dd87f1b';
  // Epoch N is settled under the key 160 * (N + 1).
  const row = (epoch, status) => ({ epoch: 160 * (epoch + 1), block_range: '', amount_qnc: status.startsWith('claim') ? 1 : 0, status });

  it('paid is counted, not eligible is missed; epochs before the registration are left out, its own is never missed', async () => {
    const calls = [];
    global.fetch = jest.fn((url) => {
      calls.push(url);
      return reply({ node_id: ID, wallet: W, history: [
        row(150, 'claimable'), row(149, 'claimed'), row(148, 'not_eligible'), row(147, 'shard_not_certified'),
        row(146, 'claimed'), row(145, 'not_eligible'), row(144, 'not_eligible'), row(143, 'claimed'),
      ] });
    });
    // Registered at a height in epoch 145: epochs 144 and 143 are before it, and 145 (its own) is not missed.
    expect(await getNodeEpochs(ID, { walletAddress: W, registeredHeight: 145 * 14400 + 77 })).toEqual({ counted: 3, missed: 1 });
    expect(calls[0]).toMatch(new RegExp(`/api/v1/rewards/history/${ID}\\?limit=64$`));
    expect(calls).toHaveLength(1); // every epoch served: one node is enough
    // Registered in epoch 0 (a genesis node): every epoch is its.
    expect(await getNodeEpochs(ID, { walletAddress: W, registeredHeight: 0 })).toEqual({ counted: 4, missed: 3 });
  });

  it('a second genesis node fills the epochs the first could not serve; unavailable is neither counted nor missed', async () => {
    const answers = [
      { node_id: ID, wallet: W, history: [row(150, 'unavailable'), row(149, 'claimed'), row(148, 'unavailable')] },
      { node_id: ID, wallet: W, history: [row(150, 'not_eligible'), row(149, 'claimed'), row(148, 'unavailable')] },
    ];
    global.fetch = jest.fn(() => reply(answers.shift()));
    expect(await getNodeEpochs(ID, { walletAddress: W, registeredHeight: 0 })).toEqual({ counted: 1, missed: 1 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('an answer for another wallet counts for nothing; no answer is unknown (null)', async () => {
    global.fetch = jest.fn(() => reply({ node_id: ID, wallet: 'someone else', history: [row(150, 'not_eligible')] }));
    expect(await getNodeEpochs(ID, { walletAddress: W, registeredHeight: 0 })).toBe(null);
    expect(global.fetch).toHaveBeenCalledTimes(3); // three genesis nodes at most
    global.fetch = jest.fn(() => Promise.reject(new Error('down')));
    expect(await getNodeEpochs(ID, { walletAddress: W, registeredHeight: 0 })).toBe(null);
  });
});

describe('what aiqnet.io records of the wallet\'s node (NodeRecordRead)', () => {
  const W = '006a5c220ca2fa77021eon2b5c6703999066d5411e2ff';
  const body = (over) => ({
    wallet: W, state: 'none', nodeType: null, way: null, burner: null, burnTx: null, burnAmount: null, code: null, until: null,
    recordedAt: null, scan: null, ...over,
  });

  it('reads the site\'s record by the wallet, without credentials, and keeps the state and the node type only', async () => {
    const calls = [];
    global.fetch = jest.fn((url, init) => {
      calls.push([url, init]);
      return reply(body({ state: 'recorded', nodeType: 'super', way: 'extension', code: 'QNET-SECRET-CODE', burnTx: 'sig' }));
    });
    expect(await readNodeRecordState(W)).toEqual({ state: 'recorded', nodeType: 'super' });
    expect(calls[0][0]).toBe(`${EXPLORER_API}/api/cabinet/activation/${W}`);
    expect(calls[0][1]).toMatchObject({ method: 'GET', credentials: 'omit' });
    global.fetch = jest.fn(() => reply(body()));
    expect(await readNodeRecordState(W)).toEqual({ state: 'none', nodeType: null });
  });

  it('any failure is null: a refusal, a busy site, an unknown state, a record with no type, no answer', async () => {
    for (const answer of [
      () => reply({ error: 'unavailable' }, 503), () => reply({ error: 'forbidden_origin' }, 403), () => reply({}, 429),
      () => reply(body({ state: 'mystery' })), () => reply(body({ state: 'recorded', nodeType: null })),
      // The state of a payment burn held for a day is gone: a record is kept for good once it is final.
      () => reply(body({ state: 'burned', nodeType: 'light' })),
      () => reply(null), () => Promise.reject(new Error('down')),
    ]) {
      global.fetch = jest.fn(answer);
      expect(await readNodeRecordState(W)).toBe(null);
    }
    global.fetch = jest.fn(() => reply(body()));
    expect(await readNodeRecordState('not a wallet/../x')).toBe(null);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a node the site recorded or has on its way counts until the network lists that type', () => {
    for (const state of ['recorded', 'sending']) {
      expect(pendingNodeType({ state, nodeType: 'super' }, [])).toBe('super');
      expect(pendingNodeType({ state, nodeType: 'light' }, ['super'])).toBe('light');
      expect(pendingNodeType({ state, nodeType: 'light' }, ['light'])).toBe(null);
    }
    for (const state of ['none', 'reserved', 'burned']) expect(pendingNodeType({ state, nodeType: 'light' }, [])).toBe(null);
    expect(pendingNodeType(null, [])).toBe(null);
  });
});
