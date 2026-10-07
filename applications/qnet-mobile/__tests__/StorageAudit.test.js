// What the wallet leaves in plaintext storage. After each flow — create, unlock, the launch cleanup of what older
// builds kept for activation, history, lock, switch, delete — every AsyncStorage key and value is dumped and checked:
// no recovery phrase, no private key, no activation code and no burn outside the sealed vault, and no key name
// carrying an address or a code. Delete leaves only the allow-listed settings.
jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  signWithDilithium: jest.fn(async () => 'dilithium_sig_test'),
  signDetached: jest.fn(async () => 'ab'.repeat(8)),
  generateRawDilithiumKeypair: jest.fn(async () => ({ publicKey: 'a'.repeat(3904), secretKey: 'b'.repeat(8064) })),
  runCompatibilityTest: jest.fn(),
}));

const nacl = require('tweetnacl');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { WalletManager } = require('../src/components/WalletManager');
const { loadCachedHistory, saveCachedHistory, HISTORY_CACHE_KEY } = require('../src/services/HistoryCache');

jest.setTimeout(120000);

const SOL = 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR';
const QNET = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
// An older build's burn and code, as it kept them in plaintext beside the vault.
const OLD_BURN = 'nqh74heddHDKQbzTqJAmu6o8VZEyBbdsfJcDJTtfPCYgTmGagX2xsrdZhkKFKBGFHyEq6tyNFrgZWrbTatq8Ywx';
const KAT = 'QNET-LFEFD9-706058-537636';
const OTHER = { sol: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', qnet: 'dc6e4f045e96c0bf43deon546e9f27ad8f91464e6a4f6' };
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PHRASE_B = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

const SOL_KEY = Array.from(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey);
const ML_SK = Array.from({ length: 4032 }, (_, i) => (i * 37 + 11) % 256);
const EVM_SK = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const hex = (a) => Buffer.from(a).toString('hex');

const walletOf = (sol, qnet, mnemonic) => ({
  address: sol, publicKey: sol, solanaAddress: sol, qnetAddress: qnet, mnemonic,
  secretKey: SOL_KEY.slice(),
  qnetKeypair: { publicKey: Array(1952).fill(1), privateKey: ML_SK.slice(), path: 'test' },
  evmKeypair: { publicKey: '04' + 'cd'.repeat(64), privateKey: EVM_SK, path: "m/44'/60'/0'/0/0" },
});

// Nothing below may appear in any plaintext value: phrases, private keys (as hex or as a JSON array), the ping secret
// key the mocked keygen returns, and an older build's burn.
const SECRETS = [
  PHRASE, PHRASE_B, hex(SOL_KEY.slice(0, 32)), SOL_KEY.slice(0, 16).join(','), hex(ML_SK.slice(0, 32)),
  ML_SK.slice(0, 16).join(','), EVM_SK, 'b'.repeat(64), OLD_BURN,
];
const ADDRESSES = [SOL, QNET, OTHER.sol, OTHER.qnet].map((a) => a.toLowerCase());
const CODE_RE = /QNET-[LS][0-9A-F]{5}-[0-9A-F]{6}-[0-9A-F]{6}/i;

const WORDS = new Set(new WalletManager().getBIP39WordList());
// Six wordlist words in a row, space-separated: a recovery phrase, whichever one.
function hasPhrase(text) {
  const re = /[a-z]{3,8}(?: [a-z]{3,8}){5,}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const words = m[0].split(' ');
    for (let i = 0; i + 6 <= words.length; i++) {
      if (words.slice(i, i + 6).every((w) => WORDS.has(w))) return true;
    }
  }
  return false;
}

async function audit(step) {
  const all = await AsyncStorage.multiGet(await AsyncStorage.getAllKeys());
  expect(all.length).toBeGreaterThan(0);
  const problems = [];
  for (const [k, v] of all) {
    if (ADDRESSES.some((a) => k.toLowerCase().includes(a))) problems.push(`${step}: key ${k} names an address`);
    if (CODE_RE.test(k)) problems.push(`${step}: key ${k} names a code`);
    const text = String(v);
    if (hasPhrase(text)) problems.push(`${step}: ${k} holds a recovery phrase`);
    if (CODE_RE.test(text)) problems.push(`${step}: ${k} holds an activation code`);
    SECRETS.forEach((s, i) => { if (text.includes(s)) problems.push(`${step}: ${k} holds secret #${i}`); });
  }
  expect(problems).toEqual([]);
}

beforeEach(async () => {
  await AsyncStorage.clear();
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })); // nothing reaches a network
});

it('create, unlock, cleanup, history, lock, switch and delete leave nothing secret in plaintext', async () => {
  const wm = new WalletManager();
  wm.migrateQNetAddress = async (w) => w; // the test keys are not a derived ML-DSA identity (no native keygen here)

  await wm.storeWallet(walletOf(SOL, QNET, PHRASE), 'Lantern-Quartz-Oriole-4');
  await audit('create');

  const r = await wm.unlockWithPassword('Lantern-Quartz-Oriole-4');
  expect(r.ok).toBe(true);
  await wm.loadWallet(r.token);
  await audit('unlock');

  // What an older build left: a node record naming its code and burn, plaintext copies, keys named after a code.
  await AsyncStorage.multiSet([
    [WalletManager.NODE_RECORD_KEY, JSON.stringify({ nodeType: 'light', pseudonym: wm.generateLightNodePseudonym(QNET), code: KAT, burnTxHash: OLD_BURN })],
    ['qnet_activation_meta_light', JSON.stringify({ burnTxHash: OLD_BURN, burnAmount: 1500 })],
    ['qnet_link_burn', JSON.stringify({ burnTx: OLD_BURN })], ['qnet_onchain_reg_pending', JSON.stringify({ burnTxHash: OLD_BURN })],
    [`qnet_identity_pk_${KAT}`, 'pk'], ['qnet_update_dismissed_code', '17'],
  ]);
  await wm.cleanupActivationStorage();
  await audit('cleanup');
  expect(await AsyncStorage.getItem(WalletManager.NODE_RECORD_KEY)).toContain('"nodeType":"light"');

  await saveCachedHistory(QNET, [{ hash: 'h1', from: OTHER.qnet, to: QNET, status: 'confirmed', timestamp: 1 }]);
  await audit('history');

  wm.closeSession();
  await audit('lock');

  await AsyncStorage.setItem('qnet_language', 'ru');
  // A new wallet never replaces a stored vault (MVA-R2-03); what a previous wallet left beside a vault that is
  // gone is cleared when the next one is stored.
  await expect(wm.storeWallet(walletOf(OTHER.sol, OTHER.qnet, PHRASE_B), 'Otter-Canyon-58')).rejects.toMatchObject({ code: 'WALLET_EXISTS' });
  await AsyncStorage.multiRemove(['qnet_wallet', 'qnet_wallet.bak']);
  await wm.storeWallet(walletOf(OTHER.sol, OTHER.qnet, PHRASE_B), 'Otter-Canyon-58');
  await audit('switch');

  await wm.eraseAllData();
  expect(await AsyncStorage.getAllKeys()).toEqual(['qnet_language']);
});

it('the audit itself catches each thing it looks for', async () => {
  for (const [k, v] of [
    ['notes', `seed: ${PHRASE_B}`], ['meta', `{"code":"${KAT}"}`], [`history_${QNET}`, '[]'],
    ['blob', hex(ML_SK.slice(0, 40))], ['arr', JSON.stringify(SOL_KEY)], ['burn', OLD_BURN], [`k_${KAT}`, '1'],
  ]) {
    await AsyncStorage.clear();
    await AsyncStorage.multiSet([['ok', '1'], [k, v]]);
    await expect(audit('control')).rejects.toThrow();
  }
});

it("the history cache keeps each wallet's rows under one key and absorbs older builds' per-address keys", async () => {
  await AsyncStorage.multiSet([
    [`qnet_tx_history_${QNET}`, JSON.stringify([{ hash: 'a' }])],
    [`qnet_tx_history_${OTHER.qnet}`, JSON.stringify([{ hash: 'b' }])],
  ]);
  expect(await loadCachedHistory(QNET.toUpperCase())).toEqual([{ hash: 'a' }]);
  expect(await AsyncStorage.getAllKeys()).toEqual([HISTORY_CACHE_KEY]);
  expect(await loadCachedHistory(OTHER.qnet)).toEqual([{ hash: 'b' }]);

  // Writes from two refreshes at once both land; the most recently written wallet comes first.
  await Promise.all([saveCachedHistory(QNET, [{ hash: 'a2' }]), saveCachedHistory(OTHER.qnet, [{ hash: 'b2' }])]);
  expect(await loadCachedHistory(QNET)).toEqual([{ hash: 'a2' }]);
  expect(await loadCachedHistory(OTHER.qnet)).toEqual([{ hash: 'b2' }]);
  expect(await loadCachedHistory('unknown')).toEqual([]);
});
