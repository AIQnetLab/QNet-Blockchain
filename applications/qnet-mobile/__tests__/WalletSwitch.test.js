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
// B's devnet burn (public chain data): 1500 1DEV, memo QNET_NODE_TYPE:LIGHT.
const B_BURN = 'nqh74heddHDKQbzTqJAmu6o8VZEyBbdsfJcDJTtfPCYgTmGagX2xsrdZhkKFKBGFHyEq6tyNFrgZWrbTatq8Ywx';
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
  it("wipes the old wallet's activation, node and token data, keeps device settings and per-address history", async () => {
    await AsyncStorage.multiSet([
      ['qnet_address', A.qnet], ['qnet_wallet_address', A.sol],
      ['qnet_activation_meta_light', JSON.stringify({ burnTxHash: 'x', burnAmount: 1500, walletAddress: A.sol })],
      ['qnet_last_activated_node', '{}'], ['qnet_custom_tokens', '[]'], ['node_pseudonym_QNET-X', 'n'],
      ['qnet_onchain_reg_pending_' + A.qnet, '{}'], ['qnet_rate_limit', '{"attempts":3}'],
      ['qnet_language', 'ru'], ['qnet_tx_history_' + A.qnet, '[]'],
    ]);
    const wm = new WalletManager();
    await wm.storeWallet(walletOf(B, { mnemonic: TEST_MNEMONIC }), 'password-b-1');

    const keys = await AsyncStorage.getAllKeys();
    for (const gone of ['qnet_activation_meta_light', 'qnet_last_activated_node', 'qnet_custom_tokens',
      'node_pseudonym_QNET-X', 'qnet_onchain_reg_pending_' + A.qnet, 'qnet_rate_limit']) {
      expect(keys).not.toContain(gone);
    }
    expect(await AsyncStorage.getItem('qnet_language')).toBe('ru');
    expect(await AsyncStorage.getItem('qnet_tx_history_' + A.qnet)).toBe('[]');
    // The no-password path now names the new wallet, not the old one.
    expect(await AsyncStorage.getItem('qnet_address')).toBe(B.qnet);
    expect(await AsyncStorage.getItem('qnet_wallet_address')).toBe(B.sol);
  });

  it("keeps the new wallet's light-node identity key, which the wipe would otherwise remove", async () => {
    await AsyncStorage.multiSet([['qnet_address', A.qnet], ['qnet_wallet_address', A.sol], ['qnet_identity_pk_old', 'aa']]);
    const wm = new WalletManager();
    const pk = Array.from({ length: 64 }, (_, i) => i);
    await wm.storeWallet(walletOf(B, { mnemonic: TEST_MNEMONIC, qnetKeypair: { publicKey: pk } }), 'password-b-1');
    expect(await AsyncStorage.getItem('qnet_identity_pk_old')).toBeNull();
    expect(await AsyncStorage.getItem(`qnet_identity_pk_${wm.generateLightNodePseudonym(B.qnet)}`)).not.toBeNull();
  });

  it("re-saving the same wallet keeps its data", async () => {
    await AsyncStorage.multiSet([['qnet_address', B.qnet], ['qnet_wallet_address', B.sol], ['qnet_last_activated_node', '{"k":1}']]);
    const wm = new WalletManager();
    await wm.storeWallet(walletOf(B, { mnemonic: TEST_MNEMONIC }), 'password-b-1');
    expect(await AsyncStorage.getItem('qnet_last_activated_node')).toBe('{"k":1}');
  });
});

describe('the vault answers only to its own password', () => {
  it('a cached key never opens the vault for a different password', async () => {
    const wm = new WalletManager();
    await wm.storeWallet(walletOf(B, { mnemonic: TEST_MNEMONIC }), 'right-password-1');
    const vault = JSON.parse(await AsyncStorage.getItem('qnet_wallet'));
    await expect(wm._decryptGCM(vault, 'wrong-password-1')).rejects.toBeDefined();
    await expect(wm._decryptGCM(vault, 'right-password-1')).resolves.toContain(B.qnet);
  });

  it('a password change keeps the seed phrase and the activation codes', async () => {
    const wm = new WalletManager();
    await wm.storeWallet(walletOf(B, { mnemonic: TEST_MNEMONIC }), 'old-password-1');
    await wm.storeActivationCode('QNET-LFEFD9-706058-537636', 'light', 'old-password-1',
      { burnTxHash: B_BURN, burnAmount: 1500, walletAddress: B.sol });

    await wm.changePassword('old-password-1', 'new-password-2');

    const vault = JSON.parse(await AsyncStorage.getItem('qnet_wallet'));
    expect(JSON.parse(await wm._decryptGCM(vault, 'new-password-2')).mnemonic).toBe(TEST_MNEMONIC);
    await expect(wm._decryptGCM(vault, 'old-password-1')).rejects.toBeDefined();
    const codes = await wm.getStoredActivationCodes('new-password-2');
    expect(codes.light.code).toBe('QNET-LFEFD9-706058-537636');
  });

  it('a wrong current password changes nothing', async () => {
    const wm = new WalletManager();
    await wm.storeWallet(walletOf(B, { mnemonic: TEST_MNEMONIC }), 'old-password-1');
    const before = await AsyncStorage.getItem('qnet_wallet');
    await expect(wm.changePassword('not-the-password', 'new-password-2')).rejects.toBeDefined();
    expect(await AsyncStorage.getItem('qnet_wallet')).toBe(before);
  });
});

describe('an activation code is bound to the Solana wallet that burned', () => {
  it("derives B's code from its burn", () => {
    const wm = new WalletManager();
    expect(wm.generateActivationCodeLocally('light', B.sol, B_BURN, 1500)).toBe('QNET-LFEFD9-706058-537636');
    // Derived from the QNet address instead, the node refuses it ("XOR mismatch").
    expect(wm.generateActivationCodeLocally('light', B.qnet, B_BURN, 1500)).not.toBe('QNET-LFEFD9-706058-537636');
  });

  it('a stored code derived from the wrong address is re-derived; one burned by another wallet is dropped', async () => {
    const wm = new WalletManager();
    await AsyncStorage.multiSet([['qnet_address', B.qnet], ['qnet_wallet_address', B.sol]]);
    const wrong = wm.generateActivationCodeLocally('light', B.qnet, B_BURN, 1500);
    await wm.storeActivationCode(wrong, 'light', 'pw-1', { burnTxHash: B_BURN, burnAmount: 1500 });
    expect((await wm.getStoredActivationCodes('pw-1')).light.code).toBe('QNET-LFEFD9-706058-537636');

    await wm.storeActivationCode('QNET-LAAAAA-111111-222222', 'light', 'pw-1',
      { burnTxHash: 'other', burnAmount: 1500, walletAddress: A.sol });
    expect((await wm.getStoredActivationCodes('pw-1')).light).toBeUndefined();
  });

  it('a sync started for one wallet writes nothing once the device switched to another', async () => {
    const wm = new WalletManager();
    await AsyncStorage.multiSet([['qnet_address', B.qnet], ['qnet_wallet_address', B.sol],
      ['qnet_activation_meta_light', JSON.stringify({ burnTxHash: B_BURN, burnAmount: 1500, walletAddress: B.sol })]]);
    const syncing = wm.syncActivationCodes(B.qnet, null, 'pw-1');
    await wm.wipeWalletScope();
    await syncing;
    expect(await AsyncStorage.getItem('qnet_activation_codes')).toBeNull();
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
