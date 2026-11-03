/**
 * Choosing a token and a token's own screen: Send opens a picker of every asset the wallet holds on the
 * network shown, searchable, the one chosen going to its Send form; a token's screen has Receive and Send, a warning for
 * a token the wallet does not know, its balance, only the facts a source answered (supply, holders, when and by whom it
 * was created, what a QNet token's contract or a Solana mint allows) and this wallet's transfers of it from the entries
 * History lists.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { ACTIVITY_SHOWN, TokenDetail, TokenPicker, assetMatches, pickId } from '../src/screens/TokenScreens';
import { assetEntries } from '../src/screens/HistoryTab';
import { assetOf, historyEntries, matchesAsset } from '../src/utils/txHistory';
import { tokenFacts } from '../src/services/TokenFacts';
import { WalletManager } from '../src/components/WalletManager';

const t = require('../src/i18n').makeT('en');

const ME = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const OTHER = 'e'.repeat(45);
const CONTRACT = 'c0ffee1234567890abcdef1234567890abcdef1234567890abcdef12345678aa';
const MINT = '62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ';
const AUTHORITY = 'BPFLoaderUpgradeab1e11111111111111111111111';

const QNC = { key: 'QNC', network: 'qnet', symbol: 'QNC', name: '', contract: null, mint: null, decimals: 9, balance: 2, figure: '2', reserved: false, known: true, history: 'qnc' };
const GOLD = {
  key: CONTRACT, network: 'qnet', symbol: 'GLD', name: 'Gold of the realm', contract: CONTRACT, mint: null, decimals: 6, balance: 1500,
  balanceText: '1500', figure: '1,500', reserved: false, known: false, history: CONTRACT,
};
const SOL = { key: 'SOL', network: 'solana', symbol: 'SOL', name: '', contract: null, mint: null, decimals: 9, balance: 1, figure: '1', reserved: false, known: true, history: 'solana:SOL' };
const ONE_DEV = { key: '1DEV', network: 'solana', symbol: '1DEV', name: '', contract: null, mint: MINT, decimals: 6, balance: 5, figure: '5', reserved: false, known: true, history: 'solana:1DEV' };

const sent = (i, extra = {}) => ({
  hash: `${i}`.padStart(64, 'a'), from: ME, to: OTHER, amount: 1 + i, fee: 0.00015, status: 'confirmed', timestamp: 1790000000000 - i * 60000, type: 'send', ...extra,
});
const goldIn = (i) => ({
  hash: `${i}`.padStart(64, 'b'), tokenLogIndex: 0, from: OTHER, to: ME, amount: 0, fee: 0, status: 'confirmed', timestamp: 1790000000000, type: 'receive',
  tokenContract: CONTRACT.toUpperCase(), tokenSymbol: 'GLD', tokenAmountDisplay: '10', tokenMetaTrusted: true,
});

const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).flat(Infinity).filter((c) => typeof c === 'string').join(''));
const byId = (tree, id) => tree.root.findAll((n) => n.props.testID === id && typeof n.props.onPress === 'function').pop();
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe('the asset a row moves', () => {
  it('QNC for a native row, the contract in lowercase for a token, the symbol on Solana; the filter reads the same', () => {
    expect(assetOf(sent(1))).toBe('qnc');
    expect(assetOf(goldIn(1))).toBe(CONTRACT);
    expect(assetOf({ chain: 'solana', solSymbol: '1DEV' })).toBe('solana:1DEV');
    expect(matchesAsset(goldIn(1), CONTRACT.toUpperCase())).toBe(true);
    expect(matchesAsset({ chain: 'solana', solSymbol: '1DEV' }, 'solana:1DEV')).toBe(true);
    expect(matchesAsset({ chain: 'solana', solSymbol: '1DEV' }, 'solana:1dev')).toBe(false);
    expect(matchesAsset(sent(1), 'solana:SOL')).toBe(false);
  });

  it('a token\'s activity: the entries that move it, a swap under both assets, an action that moved nothing under none', () => {
    const swapHash = 'f'.repeat(64);
    const entries = historyEntries([
      sent(1),
      goldIn(2),
      { ...goldIn(3), hash: swapHash, tokenLogIndex: 1 },
      { ...sent(4), hash: swapHash, tokenContract: 'd'.repeat(64), tokenSymbol: 'OTH', tokenAmountDisplay: '3', tokenLogIndex: 0 },
      { hash: '9'.repeat(64), from: ME, to: OTHER, amount: 0, fee: 0.001, status: 'confirmed', timestamp: 1, type: 'send', txType: 'NodeRegistration' },
    ]);
    expect(assetEntries(entries, 'qnc').map((e) => e.hash)).toEqual([sent(1).hash]);
    expect(assetEntries(entries, CONTRACT).map((e) => e.hash)).toEqual([goldIn(2).hash, swapHash]);
    expect(assetEntries(entries, 'd'.repeat(64)).map((e) => e.hash)).toEqual([swapHash]);
    expect(assetEntries(null, 'qnc')).toEqual([]);
  });
});

describe('the facts of a token', () => {
  it('QNC: supply, in circulation and holders as the nodes\' index gives them', async () => {
    const walletManager = { getQncSupply: jest.fn(async () => ({ totalNano: '4294967295123456789', circulatingNano: '1500000000', holders: 42 })) };
    expect(await tokenFacts(QNC, { walletManager })).toEqual({ totalSupply: '4294967295.123456789', circulating: '1.5', holders: 42 });
    walletManager.getQncSupply.mockResolvedValueOnce(null);
    expect(await tokenFacts(QNC, { walletManager })).toEqual({});
  });

  // The explorer index not reached: a QNet token's facts are the node's alone.
  const noIndex = async () => { throw new Error('offline'); };

  it('a QNet token: its supply in the decimals of the wallet\'s list, when and by whom it was created', async () => {
    const walletManager = { getTokenInfo: jest.fn(async () => ({ totalSupply: '123456789012345678', decimals: 9, deployer: ME, deployedAt: 1790000000000 })) };
    expect(await tokenFacts(GOLD, { walletManager, getJson: noIndex })).toStrictEqual({ totalSupply: '123456789012.345678', createdAt: 1790000000000, creator: ME });
    expect(walletManager.getTokenInfo).toHaveBeenCalledWith(CONTRACT);
    walletManager.getTokenInfo.mockResolvedValueOnce({ totalSupply: null, decimals: 6, deployer: null, deployedAt: null });
    expect(await tokenFacts(GOLD, { walletManager, getJson: noIndex })).toStrictEqual({ totalSupply: null, createdAt: null, creator: null });
  });

  // The holders of a QNet token come from the explorer index (it replays the token's transfers), as QNC's come from the
  // nodes' index: its count, and the share the ten largest hold, from their balances and the supply in base units.
  it('a QNet token: holders and the top-10 share from the explorer\'s index; none when the index is cut or knows none', async () => {
    const walletManager = { getTokenInfo: jest.fn(async () => ({ totalSupply: '7', decimals: 6, deployer: ME, deployedAt: null })) };
    const holder = (raw, percent) => ({ address: `${raw}`.padStart(45, 'a'), balance: '-', balance_raw: raw, percent });
    const ten = ['5000', '2000', '1000', '500', '300', '200', '100', '80', '60', '40'].map((raw) => holder(raw, '0.00'));
    const answer = (data) => async () => ({ success: true, source: 'postgresql', data: { contract_address: CONTRACT, ...data } });
    const index = jest.fn(answer({ holder_count: 37, circulating_raw: '10000', holders: ten, truncated: false }));
    expect(await tokenFacts(GOLD, { walletManager, getJson: index })).toStrictEqual({
      totalSupply: '0.000007', createdAt: null, creator: ME, holders: 37, top10: '92.80',
    });
    expect(index).toHaveBeenCalledWith(`https://aiqnet.io/api/token/${CONTRACT}/holders?limit=10`, { timeoutMs: 20000, maxBytes: 16384 });
    // Fewer than ten holders: all of them; a share is floored to the hundredth.
    const few = answer({ holder_count: 3, circulating_raw: '3', holders: [holder('1'), holder('1'), holder('1')], truncated: false });
    expect(await tokenFacts(GOLD, { walletManager, getJson: few })).toMatchObject({ holders: 3, top10: '100.00' });
    const third = answer({ holder_count: 4, circulating_raw: '3', holders: [holder('1')].concat([holder('0'), holder('0'), holder('0')]), truncated: false });
    expect(await tokenFacts(GOLD, { walletManager, getJson: third })).toMatchObject({ holders: 4, top10: '33.33' });
    // A replay the index cut short, an index that knows no holder, a refusal or no answer: neither row.
    for (const getJson of [
      answer({ holder_count: 37, circulating_raw: '10000', holders: ten, truncated: true }),
      answer({ holder_count: 37, circulating_raw: '10000', holders: ten }),
      answer({ holder_count: 0, circulating_raw: '0', holders: [], truncated: false }),
      async () => ({ success: false, error: 'Failed to derive holders' }), async () => null, noIndex,
    ]) {
      const facts = await tokenFacts(GOLD, { walletManager, getJson });
      expect([facts.holders, facts.top10, 'holders' in facts, 'top10' in facts]).toEqual([undefined, undefined, false, false]);
      expect(facts.totalSupply).toBe('0.000007');
    }
    // Balances that do not add up (more than the supply, one unreadable, fewer rows than holders): the count alone.
    for (const data of [
      { holder_count: 37, circulating_raw: '100', holders: ten, truncated: false },
      { holder_count: 37, circulating_raw: '10000', holders: [...ten.slice(0, 9), holder('many')], truncated: false },
      { holder_count: 37, circulating_raw: '10000', holders: ten.slice(0, 9), truncated: false },
      { holder_count: 37, circulating_raw: 'all', holders: ten, truncated: false },
    ]) {
      expect(await tokenFacts(GOLD, { walletManager, getJson: answer(data) })).toStrictEqual({
        totalSupply: '0.000007', createdAt: null, creator: ME, holders: 37,
      });
    }
    // The node not answering keeps the index's part.
    walletManager.getTokenInfo.mockResolvedValueOnce(null);
    expect(await tokenFacts(GOLD, { walletManager, getJson: index })).toStrictEqual({ holders: 37, top10: '92.80' });
  });

  // The index can take up to FIRST_CONTACT_MS; the node's facts are the screen's as soon as the node answers.
  it('a QNet token: the node\'s facts come as soon as it answers, whatever the index takes; its holders join them later', async () => {
    const walletManager = { getTokenInfo: jest.fn(async () => ({ totalSupply: '7', decimals: 6, deployer: ME, deployedAt: null, mintable: false })) };
    let answer;
    const slowIndex = jest.fn(() => new Promise((resolve) => { answer = resolve; }));
    const parts = [];
    const all = tokenFacts(GOLD, { walletManager, getJson: slowIndex, onFacts: (f) => parts.push(f) });
    await flush();
    const node = { totalSupply: '0.000007', createdAt: null, creator: ME, mint: { open: false, by: null } };
    expect(parts).toStrictEqual([node]);
    expect(slowIndex).toHaveBeenCalledTimes(1);
    answer({ success: true, data: { holder_count: 2, circulating_raw: '7', holders: [{ balance_raw: '5' }, { balance_raw: '2' }], truncated: false } });
    expect(await all).toStrictEqual({ ...node, holders: 2, top10: '100.00' });
    expect(parts).toHaveLength(1);
  });

  // A QNet token's Security as its node answers it, in the shape a Solana mint's takes; an older node that gives none of
  // it leaves it out (above). Whether holders may burn their own is never read: a transfer to the burn address destroys
  // any token.
  it('a QNet token: what its contract allows, each part only where the node answered it, never whether holders may burn', async () => {
    const base = { totalSupply: '7', decimals: 6, deployer: ME, deployedAt: null };
    const walletManager = { getTokenInfo: jest.fn(async () => ({
      ...base, mintable: true, mintAuthority: ME, burnable: true, metadataMutable: false, freezable: false,
    })) };
    expect(await tokenFacts(GOLD, { walletManager, getJson: noIndex })).toStrictEqual({
      totalSupply: '0.000007', createdAt: null, creator: ME,
      mint: { open: true, by: ME }, metadata: { open: false, by: null }, freeze: { open: false, by: null },
    });
    // No more can be issued: nobody named; one the node names no issuer of: Yes alone; an unread part is left out.
    walletManager.getTokenInfo.mockResolvedValueOnce({ ...base, mintable: false, mintAuthority: ME, freezable: true });
    expect(await tokenFacts(GOLD, { walletManager, getJson: noIndex })).toStrictEqual({
      totalSupply: '0.000007', createdAt: null, creator: ME, mint: { open: false, by: null }, freeze: { open: true, by: null },
    });
    walletManager.getTokenInfo.mockResolvedValueOnce({ ...base, mintable: true, mintAuthority: null, burnable: undefined });
    expect(await tokenFacts(GOLD, { walletManager, getJson: noIndex })).toStrictEqual({
      totalSupply: '0.000007', createdAt: null, creator: ME, mint: { open: true, by: null },
    });
  });

  it('SOL: the cluster\'s supply; a mint: its supply and authorities, null where none, left out where unreadable', async () => {
    const rpc = jest.fn(async (method) => (method === 'getSupply'
      ? { value: { total: '598765432109876543', circulating: 512345678901234 } }
      : { value: { data: { parsed: { type: 'mint', info: { supply: '123456789000000', mintAuthority: AUTHORITY, freezeAuthority: null } } } } }));
    expect(await tokenFacts(SOL, { rpc })).toEqual({ totalSupply: '598765432.109876543', circulating: '512345.678901234' });
    expect(await tokenFacts(ONE_DEV, { rpc })).toStrictEqual({ totalSupply: '123456789', mint: { open: true, by: AUTHORITY }, freeze: { open: false, by: null } });
    expect(rpc).toHaveBeenLastCalledWith('getAccountInfo', [MINT, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    rpc.mockResolvedValueOnce({ value: { data: { parsed: { type: 'mint', info: { supply: 'many', mintAuthority: 'not an address', freezeAuthority: 7 } } } } });
    expect(await tokenFacts(ONE_DEV, { rpc })).toStrictEqual({ totalSupply: null });
    rpc.mockResolvedValueOnce({ value: { data: { parsed: { type: 'account', info: {} } } } });
    expect(await tokenFacts(ONE_DEV, { rpc })).toEqual({});
    rpc.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'SOL_RPC' }));
    expect(await tokenFacts(SOL, { rpc })).toEqual({});
  });

  it('the nodes\' answers as the wallet reads them: a token\'s creation time in ms, QNC\'s supply as exact text', () => {
    const token = { contract_address: CONTRACT, standard: 'qrc20', name: 'Gold', symbol: 'GLD', decimals: 6, total_supply: '7', deployer: ME, deployed_at: '1790000000' };
    expect(WalletManager.tokenInfoOf({ success: true, token }, CONTRACT)).toMatchObject({ totalSupply: '7', deployer: ME, deployedAt: 1790000000000 });
    expect(WalletManager.tokenInfoOf({ success: true, token: { ...token, deployed_at: '' } }, CONTRACT).deployedAt).toBe(null);
    // What the token allows: read where the node gives it (a newer node), left undefined where it does not (an older
    // one) or where it is unreadable; the issuer as a canonical QNet address, null where the node names none.
    const allows = (extra) => {
      const info = WalletManager.tokenInfoOf({ success: true, token: { ...token, ...extra } }, CONTRACT);
      return [info.mintable, info.mintAuthority, info.burnable, info.metadataMutable, info.freezable];
    };
    expect(allows({})).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(allows({ mintable: true, mint_authority: ME.toUpperCase(), burnable: true, metadata_mutable: false, freezable: false }))
      .toEqual([true, ME, true, false, false]);
    expect(allows({ mintable: false, mint_authority: null, burnable: false, metadata_mutable: true, freezable: true }))
      .toEqual([false, null, false, true, true]);
    expect(allows({ mintable: 'yes', mint_authority: `${ME.slice(0, -1)}0`, burnable: 1, metadata_mutable: null, freezable: 'false' }))
      .toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(allows({ mint_authority: 'not an address' })[1]).toBe(undefined);
    expect(WalletManager.qncSupplyOf({ success: true, total_supply_raw: '10', circulating_raw: '9', holder_count: 3 }))
      .toEqual({ totalNano: '10', circulatingNano: '9', holders: 3 });
    expect(WalletManager.qncSupplyOf({ success: true, total_supply_raw: 10, circulating_raw: '9' })).toBe(null);
    expect(WalletManager.qncSupplyOf({ success: true, total_supply_raw: '10', circulating_raw: '9', holder_count: -1 }).holders).toBe(null);
    expect(WalletManager.qncSupplyOf({ success: false })).toBe(null);
  });
});

describe('the token picker', () => {
  it('lists every asset as Assets draws it (the same row), a token with its contract; the search keeps what matches; a tap chooses', async () => {
    const onPick = jest.fn();
    let tree;
    await act(async () => { tree = renderer.create(<TokenPicker t={t} assets={[QNC, GOLD]} onPick={onPick} onClose={() => {}} />); });
    expect(texts(tree)).toContain(t('tok_pick_title'));
    expect(texts(tree)).toEqual(expect.arrayContaining(['QNC', '2', 'GLD', 'Gold of the realm', '1,500', t('tok_contract_id', { id: 'c0ffee…78aa' })]));
    expect(tree.root.findAllByType(require('../src/screens/TokenScreens').AssetRow)).toHaveLength(2);
    expect([pickId(QNC), pickId(GOLD)]).toEqual(['QNC', CONTRACT.slice(0, 12)]);
    const search = tree.root.findAllByType(TextInput)[0];
    expect(search.props.placeholder).toBe(t('tok_search'));
    await act(async () => { search.props.onChangeText('realm'); });
    expect([byId(tree, 'pick-QNC'), byId(tree, `pick-${CONTRACT.slice(0, 12)}`)].map(Boolean)).toEqual([false, true]);
    await act(async () => { search.props.onChangeText('zzz'); });
    expect(texts(tree)).toContain(t('tok_empty'));
    await act(async () => { search.props.onChangeText(''); });
    await act(async () => { byId(tree, 'pick-QNC').props.onPress(); });
    expect(onPick).toHaveBeenCalledWith(QNC);
    expect([assetMatches(ONE_DEV, 'dev'), assetMatches(ONE_DEV, MINT.slice(5, 15).toLowerCase()), assetMatches(SOL, 'dev')]).toEqual([true, true, false]);
    await act(async () => { tree.unmount(); });
  });
});

describe('the wallet screen around them', () => {
  const ws = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');

  it('Android back closes the picker, then steps back from a send to the token\'s screen and from it to Assets', () => {
    const back = ws.slice(ws.indexOf('    const onBack = () => {'), ws.indexOf("BackHandler.addEventListener('hardwareBackPress', onBack)"));
    expect(back).toMatch(/if \(sendPicker\) \{ setSendPicker\(null\); return true; \}/);
    expect(back).toMatch(/if \(tokenScreen && activeTab === 'assets'\) \{ setTokenScreen\(null\); return true; \}/);
    expect(back.indexOf('if (showSendScreen)')).toBeLessThan(back.indexOf('if (tokenScreen'));
    // A transaction's detail closes only over the tab it was opened on.
    expect(back).toMatch(/if \(txDetail && activeTab === txDetail\.tab\) \{ setTxDetail\(null\); return true; \}/);
    expect(ws).toMatch(/\{txDetail && activeTab === txDetail\.tab && !txResult \? \(/);
  });

  it('another wallet starts with neither open; a token hidden while its screen is open closes the screen', () => {
    expect(ws).toMatch(/setSendingToken\(null\);\n\s+setSendPicker\(null\);\n\s+setTokenScreen\(null\);/);
    expect(ws).toMatch(/if \(tokenScreen && !heldAssets\(tokenScreen\.network\)\.some\(\(a\) => a\.key === tokenScreen\.key\)\) setTokenScreen\(null\);\n\s+\}, \[tokenScreen, qrcTokens, hiddenTokens, shownTokens, customTokens\]\);/);
  });
});

describe('a token\'s own screen', () => {
  const mount = async (props) => {
    let tree;
    const handlers = { onBack: jest.fn(), onReceive: jest.fn(), onSend: jest.fn(), onOpenTx: jest.fn(), onMore: jest.fn() };
    await act(async () => {
      tree = renderer.create(<TokenDetail t={t} entries={[]} loadFacts={async () => ({})} {...handlers} {...props} />);
    });
    await flush();
    return { tree, ...handlers };
  };

  it('a known asset: no warning, no Security, only the rows a source filled; Receive and Send do what they say', async () => {
    const { tree, onReceive, onSend, onBack } = await mount({ asset: QNC, loadFacts: async () => ({ holders: 7 }) });
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining(['QNC', '2 QNC', t('tok_balance'), t('tok_information'), t('tok_holders'), '7', 'QNet Blockchain']));
    for (const key of ['tok_unknown_warning', 'tok_security', 'tok_total_supply', 'tok_created', 'tok_address', 'tok_name']) {
      expect([key, shown.includes(t(key))]).toEqual([key, false]);
    }
    expect(shown).not.toContain('—');
    await act(async () => { byId(tree, 'token-receive').props.onPress(); });
    await act(async () => { byId(tree, 'token-send').props.onPress(); });
    await act(async () => { byId(tree, 'token-back').props.onPress(); });
    expect([onReceive, onSend, onBack].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    await act(async () => { tree.unmount(); });
  });

  it('a token with a contract: the warning, its name, its contract and creator copied by a tap, its supply and creation', async () => {
    const loadFacts = jest.fn(async () => ({ totalSupply: '1000000.5', createdAt: new Date(2026, 8, 20, 9, 30).getTime(), creator: ME }));
    const { tree } = await mount({ asset: { ...GOLD, reserved: true }, loadFacts });
    expect(loadFacts).toHaveBeenCalledTimes(1);
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining([
      t('tok_unknown_warning'), t('tok_reserved_warning'), 'Gold of the realm', 'GLD', CONTRACT, ME, '1,000,000.5 GLD', '20.09.2026, 09:30', '6',
    ]));
    await act(async () => { await byId(tree, 'token-copy-address').props.onPress(); });
    expect(Clipboard.setString).toHaveBeenLastCalledWith(CONTRACT);
    await act(async () => { await byId(tree, 'token-copy-creator').props.onPress(); });
    expect(Clipboard.setString).toHaveBeenLastCalledWith(ME);
    await act(async () => { tree.unmount(); });
  });

  it('a Solana token: who may issue more of it (an address to copy), that no one may freeze it, and the Solana scope', async () => {
    const { tree } = await mount({ asset: ONE_DEV, loadFacts: async () => ({
      totalSupply: '123456789', mint: { open: true, by: AUTHORITY }, freeze: { open: false, by: null },
    }) });
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining([t('tok_security'), t('tok_mint_open'), t('common_yes'), t('tok_mint_by'), AUTHORITY,
      t('tok_freeze_open'), t('common_no'), t('hist_solana_scope'), MINT]));
    expect(shown).not.toContain(t('tok_freeze_by'));
    expect(shown).not.toContain(t('tok_unknown_warning'));
    await act(async () => { await byId(tree, 'token-copy-mint-by').props.onPress(); });
    expect(Clipboard.setString).toHaveBeenLastCalledWith(AUTHORITY);
    await act(async () => { tree.unmount(); });
  });

  // A QNet token's Security from its node, in the rows a Solana token's take where the meaning is the same; no row says
  // whether holders may burn their own.
  it('a QNet token whose node says what it allows: more can be issued and by whom (copied by a tap), name, freeze', async () => {
    const { InfoRow } = require('../src/components/InfoRow');
    const { tree } = await mount({ asset: GOLD, loadFacts: async () => ({
      mint: { open: true, by: ME }, burn: { open: true, by: null }, metadata: { open: false, by: null }, freeze: { open: false, by: null },
    }) });
    const security = tree.root.find((n) => n.props.testID === 'token-security' && n.props.title === t('tok_security'));
    const rows = security.findAllByType(InfoRow).map((r) => [r.props.label, r.props.value, r.props.tone]);
    expect(rows).toEqual([
      [t('tok_mint_open'), t('common_yes'), 'warn'],
      [t('tok_metadata_open'), t('common_no'), 'ok'],
      [t('tok_freeze_open'), t('common_no'), 'ok'],
    ]);
    expect(require('../src/i18n').hasKey('tok_destroy_open')).toBe(false);
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining([t('tok_mint_by'), ME]));
    expect(shown).not.toContain(t('tok_freeze_by'));
    await act(async () => { await byId(tree, 'token-copy-mint-by').props.onPress(); });
    expect(Clipboard.setString).toHaveBeenLastCalledWith(ME);
    await act(async () => { tree.unmount(); });
  });

  // From the explorer index: the holders in Information, and first in Security the share the ten largest hold.
  it('a QNet token with the index\'s holders: their count in Information, the top-10 share first in Security', async () => {
    const { InfoRow } = require('../src/components/InfoRow');
    const { tree } = await mount({ asset: GOLD, loadFacts: async () => ({ holders: 1234, top10: '92.80', mint: { open: false, by: null } }) });
    const section = (id, title) => tree.root.find((n) => n.props.testID === id && n.props.title === title);
    const rows = (s) => s.findAllByType(InfoRow).map((r) => [r.props.label, r.props.value]);
    expect(rows(section('token-information', t('tok_information')))).toContainEqual([t('tok_holders'), '1,234']);
    expect(rows(section('token-security', t('tok_security')))).toEqual([[t('tok_top10'), '92.80%'], [t('tok_mint_open'), t('common_no')]]);
    expect(t('tok_top10')).toBe('Top 10 holders\' share');
    await act(async () => { tree.unmount(); });
  });

  it('a QNet token: the node\'s rows are on screen as soon as it answers, while the index\'s holders are still on their way', async () => {
    const loadFacts = (asset, shown) => { shown({ totalSupply: '1000', creator: ME }); return new Promise(() => {}); };
    const { tree } = await mount({ asset: GOLD, loadFacts });
    const shown = texts(tree);
    expect(shown).toEqual(expect.arrayContaining([t('tok_total_supply'), '1,000 GLD', ME]));
    expect(shown).not.toContain(t('tok_holders'));
    await act(async () => { tree.unmount(); });
  });

  it('a QNet token whose node says nothing of what it allows (an older node): no Security, no row, no placeholder', async () => {
    const { tree } = await mount({ asset: GOLD, loadFacts: async () => ({ totalSupply: '1000', creator: ME }) });
    const shown = texts(tree);
    for (const key of ['tok_security', 'tok_mint_open', 'tok_mint_by', 'tok_metadata_open', 'tok_freeze_open']) {
      expect([key, shown.includes(t(key))]).toEqual([key, false]);
    }
    expect(tree.root.findAll((n) => n.props.testID === 'token-security')).toHaveLength(0);
    expect(shown).not.toContain('—');
    await act(async () => { tree.unmount(); });
  });

  it('its transfers: the first few, Show all for the rest, each opening its detail; none says so', async () => {
    const entries = historyEntries([...Array.from({ length: ACTIVITY_SHOWN + 2 }, (_, i) => sent(i)), goldIn(1)]);
    const { tree, onOpenTx } = await mount({ asset: QNC, entries });
    const rows = () => tree.root.findAll((n) => n.props.testID === 'history-row' && typeof n.props.onPress === 'function', { deep: false });
    expect(rows()).toHaveLength(ACTIVITY_SHOWN);
    await act(async () => { byId(tree, 'token-show-all').props.onPress(); });
    expect(rows()).toHaveLength(ACTIVITY_SHOWN + 2);
    expect(byId(tree, 'token-show-all')).toBeUndefined();
    await act(async () => { rows()[0].props.onPress(); });
    expect(onOpenTx).toHaveBeenCalledWith(entries[0]);
    await act(async () => { tree.update(<TokenDetail t={t} asset={GOLD} entries={[]} loadFacts={async () => ({})} onBack={() => {}} onReceive={() => {}} onSend={() => {}} onOpenTx={() => {}} />); });
    expect(texts(tree)).toContain(t('hist_empty'));
    await act(async () => { tree.unmount(); });
  });
});
