// A new wallet on the device must never show or use the previous one's data, and the vault must answer
// only to its own password. Reported on a phone: after Delete → Create, the new, empty wallet showed the
// old wallet's 1,970,899 QNC and never refreshed.
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { WalletManager } = require('../src/components/WalletManager');
const { mergeTokenBalances } = require('../src/utils/balanceMerge');
const { teardownLightNodeIfForeign } = require('../src/services/PushService');

jest.setTimeout(60000);

const A = { qnet: 'dc6e4f045e96c0bf43deon546e9f27ad8f91464e6a4f6', sol: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' };
const B = { qnet: '02dca74ef2eae3be97feon499504db891ae0c60e364a8', sol: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR' };
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const walletOf = (w, extra = {}) => ({ address: w.sol, publicKey: w.sol, solanaAddress: w.sol, qnetAddress: w.qnet, ...extra });

beforeEach(async () => { await AsyncStorage.clear(); });

describe('balances follow the wallet they were read for', () => {
  it("a new wallet starts from zero, not from the previous wallet's balance", () => {
    const prev = { owner: A.qnet, qnc: 1970899.39547, sol: 0.5, '1dev': 10 };
    expect(mergeTokenBalances(prev, { owner: B.qnet, qnc: 0, verified: false, sol: null, oneDev: null }))
      .toEqual({ owner: B.qnet, qnc: 0, sol: 0, '1dev': 0 });
  });

  it('the same wallet keeps the anti-zeroing rule: an unverified lower QNC is ignored, a verified one applied', () => {
    const prev = { owner: A.qnet, qnc: 100, sol: 1, '1dev': 2 };
    expect(mergeTokenBalances(prev, { owner: A.qnet, qnc: 0, verified: false }).qnc).toBe(100);
    expect(mergeTokenBalances(prev, { owner: A.qnet, qnc: 40, verified: true }).qnc).toBe(40);
    expect(mergeTokenBalances(prev, { owner: A.qnet, qnc: 40, verified: false, optimistic: true }).qnc).toBe(40);
    expect(mergeTokenBalances(prev, { owner: A.qnet, sol: null, oneDev: null, qnc: null })).toEqual(prev);
  });
});

describe('storing a different wallet clears what the previous one left', () => {
  it("wipes the old wallet's node and token data, keeps device settings and per-address history", async () => {
    await AsyncStorage.multiSet([
      ['qnet_address', A.qnet], ['qnet_wallet_address', A.sol],
      ['qnet_last_activated_node', '{}'], ['qnet_custom_tokens', '[]'], ['qnet_node_link_pending', '{}'],
      ['qnet_rate_limit', '{"attempts":3}'], ['qnet_pending_txs', '[]'],
      ['qnet_language', 'ru'], ['qnet_tx_history', JSON.stringify([{ owner: A.qnet, rows: [] }])],
    ]);
    const wm = new WalletManager();
    await wm.storeWallet(walletOf(B, { mnemonic: TEST_MNEMONIC }), 'bravo-lantern-94');

    const keys = await AsyncStorage.getAllKeys();
    for (const gone of ['qnet_last_activated_node', 'qnet_custom_tokens', 'qnet_node_link_pending', 'qnet_rate_limit',
      'qnet_pending_txs']) {
      expect(keys).not.toContain(gone);
    }
    expect(await AsyncStorage.getItem('qnet_language')).toBe('ru');
    // History is kept per wallet (services/HistoryCache), so switching back shows the old wallet's rows.
    expect(await AsyncStorage.getItem('qnet_tx_history')).toBe(JSON.stringify([{ owner: A.qnet, rows: [] }]));
    // The no-password path now names the new wallet, not the old one.
    expect(await AsyncStorage.getItem('qnet_address')).toBe(B.qnet);
    expect(await AsyncStorage.getItem('qnet_wallet_address')).toBe(B.sol);
  });

  it("keeps the new wallet's light-node identity key, which the wipe would otherwise remove", async () => {
    await AsyncStorage.multiSet([['qnet_address', A.qnet], ['qnet_wallet_address', A.sol], ['qnet_identity_pk_old', 'aa']]);
    const wm = new WalletManager();
    const pk = Array.from({ length: 64 }, (_, i) => i);
    await wm.storeWallet(walletOf(B, { mnemonic: TEST_MNEMONIC, qnetKeypair: { publicKey: pk } }), 'bravo-lantern-94');
    expect(await AsyncStorage.getItem('qnet_identity_pk_old')).toBeNull();
    expect(await AsyncStorage.getItem(`qnet_identity_pk_${wm.generateLightNodePseudonym(B.qnet)}`)).not.toBeNull();
  });

  it("re-saving the same wallet keeps its data", async () => {
    await AsyncStorage.multiSet([['qnet_address', B.qnet], ['qnet_wallet_address', B.sol], ['qnet_last_activated_node', '{"k":1}']]);
    const wm = new WalletManager();
    await wm.storeWallet(walletOf(B, { mnemonic: TEST_MNEMONIC }), 'bravo-lantern-94');
    expect(await AsyncStorage.getItem('qnet_last_activated_node')).toBe('{"k":1}');
  });
});

describe('the vault answers only to its own password', () => {
  it('an open session never opens the vault for a different password', async () => {
    const wm = new WalletManager();
    wm.migrateQNetAddress = async (w) => w; // this vault has no ML-DSA key to derive (no native module here)
    const session = await wm.storeWallet(walletOf(B, { mnemonic: TEST_MNEMONIC }), 'Lantern-Quartz-Oriole-4');
    expect(WalletManager.isSessionToken(session)).toBe(true);
    await expect(wm.loadWallet('wrong-password-1')).rejects.toBeDefined();
    expect(await wm.verifyPassword('wrong-password-1')).toBe(false);
    expect((await wm.loadWallet('Lantern-Quartz-Oriole-4')).qnetAddress).toBe(B.qnet);
    expect((await wm.loadWallet(session)).qnetAddress).toBe(B.qnet);
    // The token is a session, never a password: it opens nothing once locked and reveals nothing ever.
    expect((await wm.revealMnemonic(session)).ok).toBe(false);
    wm.closeSession();
    await expect(wm.loadWallet(session)).rejects.toThrow(/locked/);
  });

  it('a password change keeps the seed phrase and the open session', async () => {
    const wm = new WalletManager();
    await AsyncStorage.multiSet([['qnet_address', B.qnet], ['qnet_wallet_address', B.sol]]);
    const session = await wm.storeWallet(walletOf(B, { mnemonic: TEST_MNEMONIC }), 'Kite-Marble-73');
    const sealedBefore = JSON.parse(await AsyncStorage.getItem('qnet_wallet'));

    await wm.changePassword('Kite-Marble-73', 'Otter-Canyon-58');

    expect(await wm.revealMnemonic('Otter-Canyon-58')).toEqual({ ok: true, mnemonic: TEST_MNEMONIC });
    expect((await wm.revealMnemonic('Kite-Marble-73')).ok).toBe(false);
    const after = JSON.parse(await AsyncStorage.getItem('qnet_wallet'));
    // A new data key too (MVA-R2-06): the wallet is sealed again, so a data key captured before opens nothing.
    expect(after.id).toBe(sealedBefore.id);
    expect(after.encrypted).not.toBe(sealedBefore.encrypted);
    expect(after.kdf.salt).not.toBe(sealedBefore.kdf.salt);
    expect(wm.sessionOpen(session)).toBe(true);
  });

  it('a wrong current password changes nothing', async () => {
    const wm = new WalletManager();
    await wm.storeWallet(walletOf(B, { mnemonic: TEST_MNEMONIC }), 'Kite-Marble-73');
    const before = await AsyncStorage.getItem('qnet_wallet');
    await expect(wm.changePassword('not-the-password', 'Otter-Canyon-58')).rejects.toBeDefined();
    expect(await AsyncStorage.getItem('qnet_wallet')).toBe(before);
  });
});

describe('older builds left a code in the node record and in key names', () => {
  it('the launch cleanup keeps the node, drops the code and its burn, and every key named after a code', async () => {
    const wm = new WalletManager();
    const code = 'QNET-LFEFD9-706058-537636';
    await AsyncStorage.multiSet([
      ['qnet_address', B.qnet], ['qnet_wallet_address', B.sol],
      ['qnet_last_activated_node', JSON.stringify({ nodeType: 'light', code, burnTxHash: 'registered', walletAddress: B.qnet })],
      [`node_pseudonym_${code}`, 'light_mobile_1234567890abcdef'],
      [`node_next_ping_${code}`, '1790000000'],
      [`qnet_identity_pk_${code}`, 'aa'],
      [`qnet_dilithium_public_key_${code}`, 'bb'],
      [`qnet_dilithium_secret_key_enc_${code}`, 'cc'],
      [`qnet_dilithium_salt_${code}`, 'dd'],
      [`blockchain_check_${B.sol}`, '{}'],
      [`node_last_ping_${B.qnet}`, '1'],
      ['qnet_activation_meta_light', JSON.stringify({ burnTxHash: 'synced', signature: 'x', burnAmount: '1500', walletAddress: B.sol })],
      ['qnet_activation_meta_full', '{}'],
      ['qnet_identity_pk_light_mobile_1234567890abcdef', 'ee'],
    ]);
    await wm.cleanupActivationStorage();

    const keys = await AsyncStorage.getAllKeys();
    expect(keys.filter((k) => k.includes(code))).toEqual([]);
    for (const gone of [`blockchain_check_${B.sol}`, `node_last_ping_${B.qnet}`, 'qnet_activation_meta_light', 'qnet_activation_meta_full']) {
      expect(keys).not.toContain(gone);
    }
    expect(keys).toContain('qnet_identity_pk_light_mobile_1234567890abcdef');
    expect(JSON.parse(await AsyncStorage.getItem('qnet_last_activated_node'))).toEqual({ nodeType: 'light', walletAddress: B.qnet });

    // The node record is read back for its own wallet only, and never carries a code.
    expect(await wm.loadNodeRecord([B.qnet, B.sol])).toEqual({ nodeType: 'light', walletAddress: B.qnet });
    expect(await wm.loadNodeRecord([A.qnet, A.sol])).toBeNull();
  });

  it('a genesis record keeps its node, known by its id', async () => {
    const wm = new WalletManager();
    const G = '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d';
    await AsyncStorage.setItem('qnet_last_activated_node', JSON.stringify({
      nodeType: 'super', code: 'QNET-BOOT-001-STRAP', pseudonym: 'genesis_node_001', isGenesis: true,
      bootstrapId: '001', burnTxHash: 'genesis', walletAddress: G }));
    await wm.cleanupActivationStorage();
    expect(await wm.loadNodeRecord([G])).toEqual({ nodeType: 'super', walletAddress: G, pseudonym: 'genesis_node_001',
      isGenesis: true, bootstrapId: '001' });
    expect(await AsyncStorage.getItem('qnet_last_activated_node')).not.toContain('QNET-BOOT');
  });
});

describe("the phone stops answering for another wallet's light node", () => {
  it('tears down a record of another wallet and keeps its own', async () => {
    await AsyncStorage.setItem('qnet_light_node_info', JSON.stringify({ nodeId: 'light_x', walletAddress: A.qnet }));
    await teardownLightNodeIfForeign([A.qnet, A.sol]);
    expect(await AsyncStorage.getItem('qnet_light_node_info')).not.toBeNull();

    await teardownLightNodeIfForeign([B.qnet, B.sol]);
    expect(await AsyncStorage.getItem('qnet_light_node_info')).toBeNull();
  });
});
