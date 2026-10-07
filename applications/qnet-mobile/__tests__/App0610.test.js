/**
 * The owner's 06.10 round on the app: nothing takes the focus by itself (the unlock screen included); the private keys
 * are exported behind the same check as the recovery phrase, in the compact form the wallet derives them from; the
 * last verified balances are kept per wallet and chain and shown at once; a pending history row resolves instead of
 * staying Pending for ever; the QNet Send screen sends QNC or any QNet token the Assets list shows.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';

jest.mock('../src/crypto/DilithiumCrypto', () => ({
  isDilithiumAvailable: () => true,
  verifyDilithium: jest.fn(async () => true),
  signWithDilithium: jest.fn(async () => 'sig'),
  signDetached: jest.fn(async () => 'ab'.repeat(8)),
}));
jest.mock('../src/crypto/QcLightClient', () => ({
  ...jest.requireActual('../src/crypto/QcLightClient'),
  verifyMacroblockStateRoot: jest.fn(async () => true),
  certifiedStateRootIndex: jest.fn(async (root, height) => Math.floor(height / 90)),
}));

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');
const { WalletManager } = require('../src/components/WalletManager');
const lc = require('../src/crypto/QcLightClient');
const { WS_CHECKPOINT } = require('../src/config/genesisConsensus');
const { createVault, sealRecord } = require('../src/crypto/Vault');
const {
  mergeHistory, historyBadge, cacheableHistory, PENDING_ROW_MAX_MS,
} = require('../src/utils/txHistory');
const vector = require('./fixtures/wallet_kat.json');

jest.setTimeout(120000);

const K = WS_CHECKPOINT.index;
const PW = 'Lantern-Quartz-Oriole-4';
const hex = (a) => Buffer.from(a).toString('hex');
const flushAll = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function srcFiles(dir = path.join(ROOT, 'src')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return srcFiles(p);
    return /\.(js|jsx|ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

beforeEach(async () => {
  await AsyncStorage.clear();
  lc.clearQcCache();
  global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); });
});

describe('no field takes the focus by itself', () => {
  it('no screen asks for it: one autoFocus in the app, the browser address after a tap on it, and no focus() call', () => {
    const hits = [];
    for (const f of srcFiles()) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/\bautoFocus\b/.test(line) || /\.focus\(\s*\)/.test(line)) hits.push(`${rel}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual(['src/browser/BrowserScreen.js: autoFocus={editing}']);
    const browser = read('src/browser/BrowserScreen.js');
    // `editing` turns on only from a tap on the address shown: the field the user tapped is the one focused.
    expect(browser.match(/setEditing\(true\)/g)).toHaveLength(1);
    expect(browser).toMatch(/onPress=\{\(\) => \{ setInput\(shownUrl\); setEditing\(true\); \}\}/);
    expect(browser).toMatch(/const \[editing, setEditing\] = useState\(false\);/);
  });

  it('locking and unlocking let go of the focus first, so Android never moves it to the next field on screen', () => {
    const ws = read('src/screens/WalletScreen.js');
    expect(ws).toMatch(/const lockSession = \(\) => \{\s*(\/\/[^\n]*\n\s*)+Keyboard\.dismiss\(\);\s*walletManager\.closeSession\(\);/);
    const open = ws.slice(ws.indexOf('const _openSession = async'), ws.indexOf('const loadQrcTokens = async'));
    expect(open.indexOf('Keyboard.dismiss();')).toBeGreaterThan(0);
    expect(open.indexOf('Keyboard.dismiss();')).toBeLessThan(open.indexOf('setWallet(shown);'));
    // The lock screen's password field: the shared password props and nothing that focuses it.
    const lock = ws.slice(ws.indexOf("placeholder={t('enter_password')}"), ws.indexOf('onSubmitEditing={unlockWallet}'));
    expect(lock).toMatch(/\{\.\.\.PASSWORD_INPUT_PROPS\}/);
    expect(lock).not.toMatch(/autoFocus|focus\(/);
    expect(require('../src/utils/sensitiveInput').PASSWORD_INPUT_PROPS.autoFocus).toBeUndefined();
  });
});

describe('Export private key', () => {
  // The KAT wallet: the node's cross-client vector (its phrase, its ML-DSA-65 key seed, public key and address).
  async function katWallet({ mnemonic = vector.mnemonic, qnetAddress = vector.eon_address } = {}) {
    const wm = new WalletManager();
    const seed = require('bip39').mnemonicToSeedSync(vector.mnemonic);
    const sol = Keypair.fromSeed(await wm.deriveHDKeypair(seed, 0));
    const wallet = {
      address: sol.publicKey.toBase58(), publicKey: sol.publicKey.toBase58(), solanaAddress: sol.publicKey.toBase58(),
      qnetAddress, mnemonic, secretKey: Array.from(sol.secretKey),
      qnetKeypair: { publicKey: Array.from(Buffer.from(vector.pk_hex, 'hex')), privateKey: Array(4032).fill(3), path: 'QNET_WALLET_MLDSA65_fips204' },
    };
    if (!mnemonic) delete wallet.mnemonic;
    await wm.storeWallet(wallet, PW);
    return { wm, sol };
  }

  it('gives the QNet key as its 32-byte ML-DSA-65 key seed (hex) and the Solana key as its base58 secret key', async () => {
    const { wm, sol } = await katWallet();
    const r = await wm.revealPrivateKeys(PW);
    expect(r.ok).toBe(true);
    expect(r.qnet).toEqual({ address: vector.eon_address, key: vector.xi_shake256 });
    expect(r.qnet.key).toMatch(/^[0-9a-f]{64}$/);
    // Any FIPS 204 implementation rebuilds the wallet's own key pair from it.
    expect(hex(ml_dsa65.keygen(Buffer.from(r.qnet.key, 'hex')).publicKey)).toBe(vector.pk_hex);
    const secret = bs58.decode(r.solana.key);
    expect(secret).toHaveLength(64);
    expect(r.solana.address).toBe(sol.publicKey.toBase58());
    expect(Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey.toBase58()).toBe(r.solana.address);
    expect(hex(secret)).toBe(hex(sol.secretKey));
  });

  it('is behind the same password check as the phrase: a wrong password reveals nothing and counts', async () => {
    const { wm } = await katWallet();
    const before = await wm.getPasswordLockStatus();
    const r = await wm.revealPrivateKeys('not-the-password-1');
    expect(r.ok).toBe(false);
    expect(r.qnet).toBeUndefined();
    expect(r.solana).toBeUndefined();
    const after = await wm.getPasswordLockStatus();
    expect((after.attempts || 0)).toBeGreaterThan(before.attempts || 0);
    // A session token is not a password.
    const unlocked = await wm.unlockWithPassword(PW);
    expect((await wm.revealPrivateKeys(unlocked.token)).ok).toBe(false);
  });

  it('a key that does not give the wallet\'s address is never handed over; without the phrase the QNet key is not shown', async () => {
    const other = await katWallet({ qnetAddress: 'dc6e4f045e96c0bf43deon546e9f27ad8f91464e6a4f6' });
    const mismatched = await other.wm.revealPrivateKeys(PW);
    expect(mismatched.ok).toBe(true);
    expect(mismatched.qnet.key).toBeNull();
    expect(mismatched.solana.key).not.toBeNull();
    await AsyncStorage.clear();
    const bare = await katWallet({ mnemonic: null });
    const noPhrase = await bare.wm.revealPrivateKeys(PW);
    expect(noPhrase.qnet.key).toBeNull();
    expect(bs58.decode(noPhrase.solana.key)).toHaveLength(64);
    expect(WalletManager.qnetKeySeedHex(require('bip39').mnemonicToSeedSync(vector.mnemonic), vector.eon_address)).toBe(vector.xi_shake256);
  });

  it('the account asked for is the only key derived and handed over', async () => {
    const { wm, sol } = await katWallet();
    const q = await wm.revealPrivateKeys(PW, 'qnet');
    expect(q.qnet.key).toBe(vector.xi_shake256);
    expect(q.solana.key).toBeNull();
    const s = await wm.revealPrivateKeys(PW, 'solana');
    expect(s.qnet.key).toBeNull();
    expect(hex(bs58.decode(s.solana.key))).toBe(hex(sol.secretKey));
  });

  it('nothing of either key is stored or logged', async () => {
    const logs = [];
    const spies = ['log', 'warn', 'error', 'info', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation((...a) => logs.push(a.map(String).join(' '))));
    try {
      const { wm } = await katWallet();
      const r = await wm.revealPrivateKeys(PW);
      const stored = (await AsyncStorage.multiGet(await AsyncStorage.getAllKeys())).map(([k, v]) => `${k}=${v}`).join('\n');
      for (const secret of [r.qnet.key, r.solana.key]) {
        expect(stored.includes(secret)).toBe(false);
        expect(logs.some((l) => l.includes(secret))).toBe(false);
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('the screen: the same fresh check and integrity rule as the phrase, shown at once, copy with the clipboard rule', () => {
    const ws = read('src/screens/WalletScreen.js');
    const reveal = ws.slice(ws.indexOf('const revealSecret = async'), ws.indexOf('const handleChangePassword'));
    expect(reveal).toMatch(/const integrity = await deviceIntegrity\(\);/);
    expect(reveal).toMatch(/const readers = await screenReaderApps\(\);/);
    expect(reveal).toMatch(/await freshCredential\(exportPassword, t\(kind === 'key' \? 'auth_show_private_key' : 'auth_show_phrase'\)\)/);
    // The account is chosen before the password (owner, 07.10, as the extension asks), and only its key is derived.
    expect(reveal).toMatch(/const account = exportAccount === 'solana' \? 'solana' : 'qnet';/);
    expect(reveal).toMatch(/await walletManager\.revealPrivateKeys\(cred\.password, account\)/);
    expect(reveal).toMatch(/setKeyReveal\(\{ \[account\]: r\[account\] \}\);/);
    expect(reveal).toMatch(/AppState\.currentState === 'background' \|\| !walletManager\.sessionOpen\(password\)/);
    const overlay = ws.slice(ws.indexOf('const renderKeyReveal = () =>'), ws.indexOf('const renderEraseConfirm = () =>'));
    // Owner, 06.10: the keys are shown at once after the check, each with its Copy, then Done; no hold to show, no
    // address, no clipboard text (the copy still leaves the clipboard after SECRET_CLIPBOARD_SECONDS).
    expect(overlay).toMatch(/<View style=\{styles\.keyRevealBox\}>\s*<Text style=\{styles\.keyRevealKey\} selectable=\{false\} testID=\{'key-shown-' \+ which\}>\{entry\.key\}<\/Text>/);
    expect(overlay).not.toMatch(/onPressIn|onPressOut|keyHeld|private_key_hold|entry\.address|_copy_warning/);
    // After the password only the secret, Copy and Done: the one warning is said before it.
    expect(overlay).not.toMatch(/_warning/);
    const phrase = ws.slice(ws.indexOf('const renderSeedReveal = () =>'), ws.indexOf('const closeKeyReveal = () =>'));
    expect(phrase).toMatch(/onPress=\{\(\) => copyRecoveryPhrase\(seedReveal\)\}/);
    expect(phrase).not.toMatch(/seed_copy_warning|_warning'\)/);
    const dialog = ws.slice(ws.indexOf('{/* Export the recovery phrase or the private keys'), ws.indexOf('{/* Auto-Lock Time Picker Modal */}'));
    expect(dialog).toMatch(/t\(exportWhat === 'key' \? 'private_key_warning' : 'recovery_phrase_warning'\)/);
    expect(dialog.indexOf("t('private_key_account')")).toBeGreaterThan(-1);
    expect(dialog.indexOf("t('private_key_account')")).toBeLessThan(dialog.indexOf("t('enter_password_to_reveal')"));
    for (const k of ['seed_reveal_warning', 'private_key_reveal_warning']) {
      for (const lang of ['en', 'zh-CN', 'ru', 'es', 'ko', 'ja', 'pt', 'fr', 'de', 'ar', 'it']) {
        expect(read(`src/i18n/locales/${lang}.js`)).not.toMatch(new RegExp(`\\b${k}\\b`));
      }
    }
    expect(read('src/services/DeviceSecurity.js')).toMatch(/export const SECRET_CLIPBOARD_SECONDS = 60;/);
    expect(ws).toMatch(/if \(entry && entry\.key && await copySecret\(entry\.key\)\) setKeyCopied\(which\);/);
    // A secret screen while shown; gone on lock, on leaving the app and on back.
    expect(ws).toMatch(/const secretScreen = !!seedReveal \|\| !!keyReveal/);
    const lock = ws.slice(ws.indexOf('const lockSession = () => {'), ws.indexOf('const nextQueuedLink'));
    expect(lock).toMatch(/closeKeyReveal\(\);/);
    expect(ws).toMatch(/if \(keyReveal\) \{ closeKeyReveal\(\); return true; \}/);
    expect(ws.match(/setSeedReveal\(null\);\s*closeKeyReveal\(\);/g).length).toBeGreaterThanOrEqual(2);
    // No import by a private key anywhere in the app.
    expect(ws).not.toMatch(/importPrivateKey|import_private_key/);
  });
});

describe('the last verified balances, kept per wallet and chain', () => {
  const OWNER = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
  const session = async (wm) => {
    const { vault, dekKey } = await createVault('{}', 'pw-123456789');
    wm._session = { token: 't', dekKey, vaultId: vault.id };
    return { vault, dekKey };
  };

  it('are sealed under the vault key, open only for the same wallet, and travel with a password change', async () => {
    const wm = new WalletManager();
    await session(wm);
    const snap = { owner: OWNER, qnc: 12.5, qncNano: '12500000000', blockHeight: 9000, sol: 1, oneDev: 2, tokens: [], at: 1 };
    expect(await wm.saveBalanceSnapshot(snap)).toBe(true);
    const raw = await AsyncStorage.getItem(WalletManager.BALANCE_CACHE_KEY);
    expect(raw).not.toContain(OWNER);
    expect(raw).not.toContain('12500000000');
    expect(await wm.loadBalanceSnapshot(OWNER)).toMatchObject({ ...snap, chain: lc.chainIdentity() });
    expect(await wm.loadBalanceSnapshot('dc6e4f045e96c0bf43deon546e9f27ad8f91464e6a4f6')).toBeNull();
    expect(WalletManager.SEALED_RECORDS).toEqual(expect.arrayContaining([{ key: 'qnet_balance_cache', purpose: 'balance-cache' }]));
    expect(WalletManager.WALLET_SCOPED_KEYS).toContain('qnet_balance_cache');
    wm.closeSession();
    expect(await wm.loadBalanceSnapshot(OWNER)).toBeNull();
    expect(await wm.saveBalanceSnapshot(snap)).toBe(false);
  });

  it('another chain\'s snapshot is never shown', async () => {
    const wm = new WalletManager();
    const { vault, dekKey } = await session(wm);
    const planted = await sealRecord(dekKey, vault.id, { owner: OWNER, qnc: 99, chain: 'f'.repeat(32) }, 'balance-cache');
    await AsyncStorage.setItem(WalletManager.BALANCE_CACHE_KEY, JSON.stringify(planted));
    expect(await wm.loadBalanceSnapshot(OWNER)).toBeNull();
  });

  it('kept anchors of another chain are dropped, never imported; this chain\'s are, and carry the chain', async () => {
    const wm = new WalletManager();
    const { vault, dekKey } = await session(wm);
    const anchor = { eligible_ids: ['genesis_node_001'], beacon: 'ab'.repeat(32), registry_root: 'cd'.repeat(32) };
    const foreign = await sealRecord(dekKey, vault.id, { anchors: { [K + 30]: anchor }, chain: 'f'.repeat(32) }, 'qc-anchors');
    await AsyncStorage.setItem(WalletManager.ANCHORS_KEY, JSON.stringify(foreign));
    await wm._loadVerifiedAnchors();
    expect(lc.highestVerifiedIndex()).toBe(K);
    expect(await AsyncStorage.getItem(WalletManager.ANCHORS_KEY)).toBeNull();
    lc.importVerifiedAnchors({ [K + 40]: anchor });
    await wm._saveVerifiedAnchors();
    lc.clearQcCache();
    await wm._loadVerifiedAnchors();
    expect(lc.highestVerifiedIndex()).toBe(K + 40);
    // A lineage reset of the walk drops the stored copy too.
    wm._lineageHooks().onLineageReset();
    await flushAll();
    expect(await AsyncStorage.getItem(WalletManager.ANCHORS_KEY)).toBeNull();
  });
});

describe('the balance read', () => {
  const answer = (wm, data) => {
    wm._hedged = jest.fn(async () => ({ ok: true, status: 200, data }));
    wm.verifyMerkleProof = jest.fn(async () => true);
  };
  const PROOF = '{"balance":5000000000,"nonce":3,"merkle_proof":[{"sibling":"00","is_right":true}],"state_root":"ab","block_height":9000}';

  it('hands the figure over as soon as its proof folded, before the lineage walk decides', async () => {
    const wm = new WalletManager();
    answer(wm, PROOF);
    const events = [];
    let release;
    wm._certifiedFresh = jest.fn(() => new Promise((r) => { release = () => { events.push('walk'); r(true); }; }));
    const p = wm.getQNCBalanceWithProof('addr', true, { onFigure: (f) => events.push(['figure', f.balance, f.balanceNano, f.folded]) });
    await flushAll();
    expect(events).toEqual([['figure', 5, '5000000000', true]]);
    release();
    await expect(p).resolves.toMatchObject({ ok: true, verified: true, balanceNano: '5000000000' });
    expect(events).toEqual([['figure', 5, '5000000000', true], 'walk']);
    // Older callers: a number in place of the options is ignored.
    wm._certifiedFresh = jest.fn(async () => false);
    await expect(wm.getQNCBalanceWithProof('addr', true, 3)).resolves.toMatchObject({ ok: true, verified: false });
  });

  it('the walk waits for the kept anchors (bounded), and the head is read while it runs, once', async () => {
    const wm = new WalletManager();
    const order = [];
    let anchorsRead;
    wm._anchorsReady = new Promise((r) => { anchorsRead = () => { order.push('anchors'); r(); }; });
    let headAnswer;
    wm._networkHeadIndex = jest.fn(() => { order.push('head asked'); return new Promise((r) => { headAnswer = r; }); });
    // The walk answers the index whose certified root the proof's is (here one checkpoint below the proof's height):
    // freshness is judged by that index, never by the height the node named.
    lc.certifiedStateRootIndex.mockImplementation(async () => { order.push('walk'); return 99; });
    wm._indexIsFresh = jest.fn(async (idx, known) => { order.push(['fresh', idx, known]); return true; });
    const p = wm._certifiedFresh('ab', 9000);
    await flushAll();
    expect(order).toEqual([]);
    anchorsRead();
    await flushAll();
    expect(order).toEqual(['anchors', 'head asked', 'walk']);
    headAnswer(100);
    await expect(p).resolves.toBe(true);
    expect(order[3]).toEqual(['fresh', 99, 100]);
    expect(wm._networkHeadIndex).toHaveBeenCalledTimes(1);
    // No certified index: not verified, whatever the head.
    lc.certifiedStateRootIndex.mockImplementation(async () => null);
    await expect(wm._certifiedFresh('ab', 9000)).resolves.toBe(false);

    const stuck = new WalletManager();
    stuck._anchorsReady = new Promise(() => {});
    stuck._networkHeadIndex = jest.fn(async () => 100);
    stuck._indexIsFresh = jest.fn(async () => true);
    lc.certifiedStateRootIndex.mockImplementation(async (root, height) => Math.floor(height / 90));
    const saved = WalletManager.ANCHORS_WAIT_MS;
    WalletManager.ANCHORS_WAIT_MS = 20;
    try {
      await expect(stuck._certifiedFresh('ab', 9000)).resolves.toBe(true);
    } finally {
      WalletManager.ANCHORS_WAIT_MS = saved;
    }
  });

  it('a session reads its kept anchors once and keeps the promise the walk waits for', async () => {
    const wm = new WalletManager();
    const load = jest.spyOn(wm, '_loadVerifiedAnchors').mockResolvedValue(undefined);
    wm._openSession({}, 'v1');
    expect(load).toHaveBeenCalledTimes(1);
    expect(wm._anchorsReady).toBeInstanceOf(Promise);
  });
});

describe('a pending history row resolves', () => {
  const ME = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
  const TO = 'dc6e4f045e96c0bf43deon546e9f27ad8f91464e6a4f6';
  const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
  const row = (hash, ageMs, extra = {}) => ({ hash, from: ME, to: TO, amount: 1, fee: 0.0001, status: 'pending', timestamp: NOW - ageMs, type: 'send', ...extra });
  const merge = (prev, fresh = []) => mergeHistory(prev, fresh, { myAddress: ME, coveredFromMs: Infinity, nowMs: NOW, nodeEventsOk: true });

  it('Pending while a node may still hold it, Not found once none can, confirmed whenever a source reports it', () => {
    const young = row('a'.repeat(64), PENDING_ROW_MAX_MS - 1000);
    const old = row('b'.repeat(64), PENDING_ROW_MAX_MS + 1000);
    const out = merge([young, old]);
    expect(out.find((r) => r.hash === young.hash).status).toBe('pending');
    expect(out.find((r) => r.hash === old.hash).status).toBe('dropped');
    expect(historyBadge(out.find((r) => r.hash === old.hash))).toBe('dropped');
    // Late, a source reports it after all: the source's row replaces it.
    const back = merge(out, [{ ...old, status: 'confirmed', block: 77 }]);
    expect(back.filter((r) => r.hash === old.hash)).toEqual([expect.objectContaining({ status: 'confirmed', block: 77 })]);
    // Neither Pending nor Not found is kept on the device: only confirmed rows are.
    expect(cacheableHistory(out)).toEqual([]);
    // As long as some node may still hold it: the wallet sends it again by itself for AUTO_SEND_MS after signing, and a
    // node keeps each copy NODE_MEMPOOL_TTL_MS, plus the margin (PendingTx mayLandUntil); never Not found before that.
    const P = require('../src/services/PendingTx');
    expect(PENDING_ROW_MAX_MS).toBe(P.AUTO_SEND_MS + P.NODE_MEMPOOL_TTL_MS + P.LANDING_MARGIN_MS);
    const lastAutoSend = { createdAt: NOW - PENDING_ROW_MAX_MS, lastSentAt: NOW - PENDING_ROW_MAX_MS + P.AUTO_SEND_MS - 1 };
    expect(P.mayLandUntil(lastAutoSend)).toBeLessThanOrEqual(NOW);
  });

  it('the detail screen of a row not found offers the hash to copy, not the explorer', () => {
    const { TxDetail } = require('../src/screens/HistoryTab');
    const t = require('../src/i18n').makeT('en');
    let tree;
    act(() => {
      tree = renderer.create(<TxDetail tx={row('c'.repeat(64), PENDING_ROW_MAX_MS + 1, { status: 'dropped' })} t={t}
        onBack={() => {}} onCopy={() => {}} onExplorer={() => {}} />);
    });
    expect(tree.root.findAll((n) => n.props.testID === 'tx-detail-badge-dropped').length).toBeGreaterThan(0);
    expect(tree.root.findAll((n) => n.props.testID === 'tx-detail-explorer')).toHaveLength(0);
    expect(tree.root.findAll((n) => n.props.testID === 'tx-detail-copy').length).toBeGreaterThan(0);
    expect(t('hist_status_dropped')).toBe('Not found');
    act(() => tree.unmount());
  });
});

describe('the QNet Send screen sends any QNet token', () => {
  it('offers QNC and every QNet token the Assets list shows, and the send runs for the one chosen', () => {
    const ws = read('src/screens/WalletScreen.js');
    const choices = ws.slice(ws.indexOf('const qnetSendChoices = () => ['), ws.indexOf('const switchQnetToken = (choice) =>'));
    expect(choices).toMatch(/\{ key: 'QNC', symbol: 'QNC', balance: tokenBalances\.qnc, contract: null, decimals: null \}/);
    expect(choices).toMatch(/qrcTokens\.filter\(\(tk\) => tk\.contract && isTokenShown\(tk\.contract\)\)/);
    const sw = ws.slice(ws.indexOf('const switchQnetToken = (choice) =>'), ws.indexOf('const switchSolanaToken'));
    expect(sw).toMatch(/symbol: choice\.symbol, balance: choice\.balance, contract: choice\.contract, decimals: choice\.decimals/);
    expect(ws).toMatch(/onPress=\{\(\) => switchQnetToken\(c\)\}/);
    // A token send goes through the same path as a token row's: the token's own decimals, qrc20Transfer, the fee in QNC.
    const send = ws.slice(ws.indexOf('const handleSendTransaction = async'), ws.indexOf('const pressSend = async'));
    expect(send).toMatch(/const isTokenSend = sendingToken\.network === 'qnet' && !!sendingToken\.contract;/);
    expect(send).toMatch(/walletManager\.qrc20Transfer\(/);
    expect(send).toMatch(/walletManager\.checkedTokenBalance\(sendingToken\.contract/);
  });
});
