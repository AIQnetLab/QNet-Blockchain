// Round-3 Node tab finding: a server node links to the wallet only on two genesis nodes' word, never on one node's
// by-wallet listing (MOBACT-R3-03), and the tab offers nothing to enter or recover in its place.
const fs = require('fs');
const path = require('path');
const { WalletManager } = require('../src/components/WalletManager');
const { GENESIS_NODES } = require('../src/config/nodes');

const screen = fs.readFileSync(path.join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
const WALLET = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';

describe('MOBACT-R3-03: a server node links on two genesis nodes\' word', () => {
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

  it('the Node tab links and unlinks by that rule, and an unconfirmed server node shows a plain notice', () => {
    expect(screen).toMatch(/if \(serverNode && serverConfirmed === true\) \{/);
    expect(screen).toMatch(/if \(still === false\) \{\s*setActivatedNodeType\(null\);[\s\S]{0,300}await walletManager\.forgetServerNodeRecord\(\);/);
    // The card of a server node the network has not confirmed (screens/NodeTab): a notice, nothing to press.
    const tab = fs.readFileSync(path.join(__dirname, '../src/screens/NodeTab.js'), 'utf8');
    const start = tab.indexOf('if (!(status && status.success === true && status.registered !== false)) {');
    expect(start).toBeGreaterThan(-1);
    const unconfirmed = tab.slice(start, tab.indexOf("{t('node_super_server_sub')}", start));
    expect(unconfirmed).toMatch(/t\('node_super_server'\)/);
    expect(unconfirmed).not.toMatch(/onPress=/);
  });
});
