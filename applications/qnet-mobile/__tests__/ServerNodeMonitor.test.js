/**
 * 29.09, the Node tab for both node types (R4): the wallet's super node id as the chain derives it, the chain's
 * registrations of the wallet's nodes (node-events), a server node's registration flag and its counted and missed
 * epochs (PushService), and what aiqnet.io records of a node the network does not list yet (NodeRecordRead), of which
 * the app reads the state and the node type only.
 */
const { WalletManager } = require('../src/components/WalletManager');
const { GENESIS_NODES, EXPLORER_API } = require('../src/config/nodes');
const { checkServerNodeStatus, getWalletNodeEvents, getNodeEpochs } = require('../src/services/PushService');
const { readServerNodeListed, serverStatusOf } = require('../src/services/LightNode');
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
  const ID = 'super_node_60a735f53dd87f1b';
  const W = '006a5c220ca2fa77021eon2b5c6703999066d5411e2ff';
  const body = (over) => ({ success: true, node_id: ID, node_type: 'super', is_online: true,
    last_seen: 1790000000, last_seen_ago_seconds: 42, heartbeat_count: 4, required_heartbeats: 9, pending_rewards: 0, ...over });

  it('carries whether the chain registered it, from onchain_registered or registered; nothing when a node says neither', () => {
    for (const [over, registered] of [
      [{ onchain_registered: true, registered: true }, true],
      [{ onchain_registered: false, registered: false }, false],
      [{ registered: false }, false],
      [{}, undefined],
    ]) {
      const s = serverStatusOf(body(over));
      expect([over, s.registered]).toEqual([over, registered]);
      expect(s).toMatchObject({ success: true, nodeId: ID, lastSeen: 1790000000, lastSeenAgoSeconds: 42, heartbeatCount: 4, requiredHeartbeats: 9 });
    }
    expect(serverStatusOf(body({ required_heartbeats: undefined, heartbeat_count: undefined }))).toMatchObject({ heartbeatCount: 0, requiredHeartbeats: 9 });
  });

  it('carries the super node\'s admission when the node reports one; nothing for a missing or unknown value', () => {
    for (const [over, admission] of [
      [{ admission: 'admitted' }, 'admitted'], [{ admission: 'waiting' }, 'waiting'], [{ admission: 'not_required' }, 'not_required'],
      [{ admission: null }, undefined], [{ admission: 'maybe' }, undefined], [{}, undefined],
    ]) {
      expect([over, serverStatusOf(body(over)).admission]).toEqual([over, admission]);
    }
  });

  // The Node tab's server card reads its node by id from every genesis node: the first answer that names the node
  // registered is heard at once, a later one only when it says more (online first, then more heartbeats); an answer
  // that says it is not registered, or names no node or another one, is no status of it.
  it('by its id: each answer that names it registered is heard as soon as it says more, and the listing verdict stays', async () => {
    const answers = [
      body({ onchain_registered: true, is_online: false, heartbeat_count: 0 }),
      body({ onchain_registered: false }),
      body({ onchain_registered: true, is_online: true, heartbeat_count: 3 }),
      { ...body({ onchain_registered: false }), node_id: null },
      body({ onchain_registered: true, is_online: true, heartbeat_count: 2 }),
    ];
    const asked = [];
    global.fetch = jest.fn((url) => {
      const i = GENESIS_NODES.findIndex((g) => url.startsWith(g));
      asked.push(url);
      // In the genesis nodes' order, one after the other.
      return new Promise((resolve) => setTimeout(() => resolve(reply(answers[i])), i * 5));
    });
    const heard = [];
    expect(await readServerNodeListed(ID, { onStatus: (s) => heard.push([s.isOnline, s.heartbeatCount]) })).toBe(null);
    expect(heard).toEqual([[false, 0], [true, 3]]);
    expect(asked).toEqual(GENESIS_NODES.map((g) => `${g}/api/v1/node/status?node_id=${ID}`));
    // Two that say not registered and none that names it: no status at all.
    global.fetch = jest.fn(() => reply(body({ onchain_registered: false })));
    heard.length = 0;
    expect(await readServerNodeListed(ID, { onStatus: (s) => heard.push(s) })).toBe(false);
    expect(heard).toEqual([]);
  });

  // The by-wallet read is the tab's hint that the wallet's node has another id: the wallet in a header, never the URL.
  it('by the wallet: one genesis node, the wallet in a header, read as the by-id answers are', async () => {
    const calls = [];
    global.fetch = jest.fn((url, init) => {
      calls.push([url, init]);
      return reply(body({ onchain_registered: true }));
    });
    expect(await checkServerNodeStatus(W, 1)).toEqual(serverStatusOf(body({ onchain_registered: true })));
    expect(calls).toHaveLength(1);
    expect(GENESIS_NODES.some((g) => calls[0][0] === `${g}/api/v1/node/status`)).toBe(true);
    expect(calls[0][1].headers).toEqual({ 'X-QNet-Wallet': W });
    global.fetch = jest.fn(() => reply({ success: false, error: 'busy' }));
    expect(await checkServerNodeStatus(W, 1)).toEqual({ success: false, error: 'busy' });
    expect(await checkServerNodeStatus(null)).toEqual({ success: false, error: 'wallet required' });
  });
});

describe('the chain\'s registrations of the wallet\'s nodes (node-events)', () => {
  const W = '006a5c220ca2fa77021eon2b5c6703999066d5411e2ff';
  const ids = { light: WalletManager.prototype.generateLightNodePseudonym(W), super: 'super_node_60a735f53dd87f1b' };

  it('takes only the ids this wallet derives and a genesis node\'s, types them by id, ignores the burn, and asks a genesis node by name', async () => {
    const calls = [];
    global.fetch = jest.fn((url) => {
      calls.push(url);
      return reply({ address: W, count: 5, events: [
        { type: 'node_activation', node_id: ids.super, node_type: 'Light', height: 1, timestamp: 0, burn_tx: '' },
        { type: 'node_activation', node_id: ids.light, node_type: 'light', height: 2084000, timestamp: 1, burn_tx: 'x' },
        { type: 'node_activation', node_id: 'super_node_76d638f2b358fc9f', node_type: 'super', height: 5, burn_tx: '' },
        { type: 'node_activation', node_id: 'genesis_node_001', node_type: 'light', height: 0, burn_tx: '' },
        { type: 'node_activation', node_id: 'genesis_node_006', node_type: 'super', height: 0, burn_tx: '' },
        { type: 'other', node_id: ids.light, height: 3 },
      ] });
    });
    expect(await getWalletNodeEvents(W, ids)).toEqual({ success: true, nodes: [
      { nodeId: ids.super, nodeType: 'super', height: 1 },
      { nodeId: ids.light, nodeType: 'light', height: 2084000 },
      { nodeId: 'genesis_node_001', nodeType: 'super', height: 0 },
    ] });
    expect(calls).toHaveLength(1);
    expect(GENESIS_NODES.some((g) => calls[0] === `${g}/api/v1/account/${W}/node-events`)).toBe(true);
  });

  // No table of genesis wallets in the app: an answer about this wallet that names a genesis node is the wallet's super
  // node, as the chain registered it; which node is the wallet's is the genesis nodes' word (WalletManager.walletNode).
  it('a genesis node in an answer about this wallet is its super node; an answer for another address or none at all is unknown', async () => {
    global.fetch = jest.fn(() => reply({ address: W, events: [{ type: 'node_activation', node_id: 'genesis_node_003', height: 0 }] }));
    expect(await getWalletNodeEvents(W, ids)).toEqual({ success: true, nodes: [
      { nodeId: 'genesis_node_003', nodeType: 'super', height: 0 }] });
    global.fetch = jest.fn(() => reply({ address: 'someone else', events: [{ type: 'node_activation', node_id: 'genesis_node_003', height: 0 }] }));
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
    expect(await getNodeEpochs(ID, { walletAddress: W, registeredHeight: 145 * 14400 + 77 })).toEqual({ counted: 3, missed: 1, notAdmitted: 0 });
    expect(calls[0]).toMatch(new RegExp(`/api/v1/rewards/history/${ID}\\?limit=64$`));
    expect(calls).toHaveLength(1); // every epoch served: one node is enough
    // Registered in epoch 0 (a genesis node): every epoch is its.
    expect(await getNodeEpochs(ID, { walletAddress: W, registeredHeight: 0 })).toEqual({ counted: 4, missed: 3, notAdmitted: 0 });
  });

  it('a second genesis node fills the epochs the first could not serve; unavailable is neither counted nor missed', async () => {
    const answers = [
      { node_id: ID, wallet: W, history: [row(150, 'unavailable'), row(149, 'claimed'), row(148, 'unavailable')] },
      { node_id: ID, wallet: W, history: [row(150, 'not_eligible'), row(149, 'claimed'), row(148, 'unavailable')] },
    ];
    global.fetch = jest.fn(() => reply(answers.shift()));
    expect(await getNodeEpochs(ID, { walletAddress: W, registeredHeight: 0 })).toEqual({ counted: 1, missed: 1, notAdmitted: 0 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  // A super node outside the epoch's admitted set earned nothing by the network's admission, not by missed heartbeats.
  it('an epoch outside the admitted set is counted as not admitted, never as missed', async () => {
    global.fetch = jest.fn(() => reply({ node_id: ID, wallet: W, history: [
      row(150, 'claimable'), row(149, 'not_admitted'), row(148, 'not_admitted'), row(147, 'not_eligible'),
    ] }));
    expect(await getNodeEpochs(ID, { walletAddress: W, registeredHeight: 0 })).toEqual({ counted: 1, missed: 1, notAdmitted: 2 });
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
