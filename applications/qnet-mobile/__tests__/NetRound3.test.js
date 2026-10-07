// Round-3 network findings: a refused transaction is not sent again days later (MOBNET-R3-01), a size cap that holds
// on Android's XHR (MOBNET-R3-02), accepted sends settled by nonce (MOBNET-R3-03), a lower balance two genesis nodes
// agree on shows (MOBNET-R3-04), token amounts scaled by the recorded decimals only (MOBNET-R3-05), one registry
// snapshot per root (MOBNET-R3-06), and look-alike token names in the history (MOBNET-R3-08).
jest.mock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { sha3_256 } = require('js-sha3');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { WalletManager } = require('../src/components/WalletManager');
const P = require('../src/services/PendingTx');
const { boundedGetJson, ResponseTooLargeError } = require('../src/utils/boundedFetch');
const { mergeTokenBalances } = require('../src/utils/balanceMerge');
const { resolvePubkeys, recomputeRegistryRoot, quorumSize, clearQcCache } = require('../src/crypto/QcLightClient');
const { usesReservedName } = require('../src/utils/tokenSafety');
const { GENESIS_NODES } = require('../src/config/nodes');

jest.setTimeout(60000);

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const FROM = '02dca74ef2eae3be97feon499504db891ae0c60e364a8';
const TO = '02dca74ef2eae3be97feon499504db891ae0c60e36aaa';

beforeEach(async () => { await AsyncStorage.clear(); });

describe('MOBNET-R3-01: a kept transaction has a lifetime', () => {
  const entry = (nonce, over = {}) => ({
    from: FROM, nonce, path: '/api/v1/transaction', body: { nonce, to: TO }, pk: null,
    summary: { kind: 'transfer', to: TO, amountNano: 300_000_000_000, method: null }, createdAt: Date.now(), ...over,
  });

  it('only a refusal that waiting can heal is sent again by itself', () => {
    expect(P.refusalHeals('gas_price 10 below current floor 20 (rises with mempool backlog)')).toBe(true);
    expect(P.refusalHeals('Invalid nonce: expected 5, got 6 (anti-replay protection)')).toBe(true);
    expect(P.refusalHeals('HTTP 503')).toBe(true);
    expect(P.refusalHeals(null)).toBe(true);
    expect(P.refusalHeals('Insufficient balance: have 1, need 2')).toBe(false);
    expect(P.refusalHeals('Invalid signature')).toBe(false);
    expect(P.refusalHeals('something this build does not know')).toBe(false);
  });

  it('a transaction refused for the gas floor is not sent again after half an hour, and says so', async () => {
    const wm = new WalletManager();
    wm._sendPending = jest.fn(async () => ({ accepted: false, error: 'gas_price 10 below current floor 20' }));
    const old = Date.now() - P.AUTO_SEND_MS - 60_000;
    await P.putSigned(entry(5, { createdAt: old, refusal: 'gas_price 10 below current floor 20', lastSentAt: old }));
    expect(await wm.rebroadcastPending(FROM, 5)).toBe(false);
    expect(wm._sendPending).not.toHaveBeenCalled();
    expect(await P.pendingEntry(FROM, 5)).toMatchObject({ stopped: 'expired' });
    // Within the half hour it is still sent again.
    await P.putSigned(entry(6, { refusal: 'gas_price 10 below current floor 20', lastSentAt: 0 }));
    await wm.rebroadcastPending(FROM, 6);
    expect(wm._sendPending).toHaveBeenCalledTimes(1);
  });

  it('a refusal waiting cannot heal stops every automatic send at once', async () => {
    const wm = new WalletManager();
    wm.getTrustedNodes = () => GENESIS_NODES.slice();
    wm._hedged = jest.fn(async (p, o) => ({ ok: false, status: 400, data: { error: 'Insufficient balance: have 1, need 2' }, base: o.nodes[0] }));
    await P.putSigned(entry(5));
    const kept = await P.pendingEntry(FROM, 5);
    const out = await wm._sendPending(kept);
    expect(out).toMatchObject({ accepted: false });
    expect(await P.pendingEntry(FROM, 5)).toMatchObject({ stopped: 'refused', refusal: 'Insufficient balance: have 1, need 2' });
    wm._sendPending = jest.fn();
    await AsyncStorage.setItem(P.PENDING_KEY, JSON.stringify({ [FROM]: [{ ...(await P.pendingEntry(FROM, 5)), lastSentAt: 0 }] }));
    expect(await wm.rebroadcastPending(FROM, 5)).toBe(false);
    expect(wm._sendPending).not.toHaveBeenCalled();
  });

  it('"Stop sending" deletes the kept bytes and those above them, never while a node holds one of them', async () => {
    const wm = new WalletManager();
    await P.putSigned(entry(5));
    await P.putSigned(entry(6));
    await P.updateEntry(FROM, 6, { state: 'accepted', acceptedAt: Date.now() });
    let views = await wm.keptTransactions(FROM);
    expect(views.map((v) => [v.nonce, v.held, v.canStop, v.sending])).toEqual([[5, false, false, true], [6, true, false, true]]);
    expect(await wm.stopPendingTransaction(FROM, 5, views[0].bodyHash)).toBe(false);
    await P.updateEntry(FROM, 6, { acceptedAt: Date.now() - P.HELD_MS - 1000 }); // no node is sure to hold it any more
    views = await wm.keptTransactions(FROM);
    expect(views.every((v) => v.canStop)).toBe(true);
    expect(await wm.stopPendingTransaction(FROM, 5, 'another-body')).toBe(false); // not the bytes the user saw
    expect(await wm.stopPendingTransaction(FROM, 5, views[0].bodyHash)).toBe(true);
    expect(await P.pendingFor(FROM)).toEqual([]);
  });

  it('the screens stop promising a re-send the wallet will not make', () => {
    const screen = read('src/screens/WalletScreen.js');
    // Not sent any more: "has not gone through" only once no node can hold it either (MOBNET-R4-02).
    expect(screen).toMatch(/res\.sending === false \? \(landing > 0 \? t\('tx_note_stopped_may_land', \{ minutes: landing \}\) : t\('tx_note_stopped'\)\)/);
    expect(screen).toMatch(/refusalHeals\(u\.refusal\) \|\| u\.refusalUncertain \? 'tx_note_refused' : 'tx_note_refused_final'/);
    expect(screen).toMatch(/t\('kept_title', \{ count: keptTxs\.length \}\)/);
    const en = require('../src/i18n/translations').default.en;
    expect(en.tx_note_refused).not.toMatch(/keeps sending/);
    expect(en.tx_note_still_queued).toMatch(/half an hour after it was signed/);
  });
});

describe('MOBNET-R3-02: the size cap holds when the progress figure is useless', () => {
  function fakeXhr({ loaded, gzipLength }) {
    return class FakeXHR {
      constructor() { FakeXHR.instance = this; this.readyState = 0; this.responseText = ''; this.aborted = false; this.chunks = 0; }
      open() {}
      setRequestHeader() {}
      getResponseHeader(h) { return h === 'content-length' && gzipLength ? String(gzipLength) : null; }
      abort() { this.aborted = true; }
      send() {
        setTimeout(() => {
          this.readyState = 2;
          this.onreadystatechange();
          for (let i = 0; i < 200 && !this.aborted; i++) {
            this.responseText += 'x'.repeat(8192);
            this.chunks += 1;
            this.readyState = 3;
            this.onreadystatechange();
            if (this.aborted) break;
            this.onprogress({ loaded });
          }
          if (!this.aborted) { this.readyState = 4; this.status = 200; this.onload(); }
        }, 0);
      }
    };
  }

  afterEach(() => { delete global.XMLHttpRequest; });

  it.each([[0, null], [-1, 1024]])('aborts at the first chunk past the cap (progress loaded=%p, gzip length %p)', async (loaded, gzipLength) => {
    global.XMLHttpRequest = fakeXhr({ loaded, gzipLength });
    const err = await boundedGetJson('https://node.example/api/v1/registry/height/90', { maxBytes: 64 * 1024 }).catch((e) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(global.XMLHttpRequest.instance.aborted).toBe(true);
    expect(global.XMLHttpRequest.instance.chunks).toBe(9); // 8 x 8 KiB fit, the 9th passes the cap
  });
});

describe('MOBNET-R3-03: an accepted send is settled by its nonce too', () => {
  it('an accepted reply carries its nonce, out of what a site is handed', () => {
    const data = WalletManager._acceptedOrUnknown({ accepted: true, data: { tx_hash: 'h1', success: true }, nonce: 7 }, 'call');
    expect(data.submitNonce).toBe(7);
    expect(JSON.parse(JSON.stringify(data))).toEqual({ tx_hash: 'h1', success: true });
  });

  it('the copy that landed under another hash is the one the card and the history show', async () => {
    const wm = new WalletManager();
    wm._hedged = jest.fn(async (p) => {
      if (p.startsWith('/api/v1/account/')) return { ok: true, data: { nonce: 7 } };
      return { ok: true, data: { transactions: [{ from: FROM, to: TO, nonce: 7, type: 'transfer', amount: 5_000_000_000, hash: 'landed-copy' }] } };
    });
    expect(await wm.resolveSubmitByNonce(FROM, 7, { toAddress: TO, amountNano: 5_000_000_000 }))
      .toEqual({ landed: true, known: true, txHash: 'landed-copy' });
    const screen = read('src/screens/WalletScreen.js');
    const poll = screen.slice(screen.indexOf('const startTxConfirmationPolling'), screen.indexOf('const startUnknownOutcomeResolution'));
    expect(poll).toMatch(/walletManager\.resolveSubmitByNonce\(settleWith\.from, settleWith\.nonce/);
    // The row under the handed hash goes whether it is still pending or was marked not found (L-10).
    expect(poll).toMatch(/if \(landedHash !== txHash\) setTxHistory\(prev => prev\.filter\(r => !\(unsettledRow\(r\) && r\.hash === txHash\)\)\)/);
    expect(screen).toMatch(/const unsettledRow = \(r\) => r\.status === 'pending' \|\| r\.status === 'dropped';/);
    expect(poll).toMatch(/res\.replaced \? 'tx_not_applied_title' : 'tx_unbound_title'/);
    expect(screen).toMatch(/const settle = \{\s*from: result\.from, nonce: result\.nonce, kind: 'transfer'/);
    expect(screen).toMatch(/startTxConfirmationPolling\(result\.txHash, settle\);/);
    expect(screen).toMatch(/from: senderQnet, nonce: result\.submitNonce, kind: 'call'/);
  });
});

describe('MOBNET-R3-04: a lower balance two genesis nodes agree on is shown', () => {
  it('one unproven lower read keeps the figure; an agreed one lowers it', () => {
    const prev = { owner: FROM, qnc: 1000, sol: 0, '1dev': 0 };
    expect(mergeTokenBalances(prev, { owner: FROM, qnc: 100, verified: false }).qnc).toBe(1000);
    expect(mergeTokenBalances(prev, { owner: FROM, qnc: 100, verified: false, agreed: true }).qnc).toBe(100);
  });

  it('agreedGenesisBalance needs two genesis nodes on one value, read exactly', async () => {
    const wm = new WalletManager();
    const answer = (bal) => ({ ok: true, text: async () => `{"balance":${bal},"nonce":3}` });
    const run = async (bals) => {
      WalletManager.genesisBalanceReads.clear();
      global.fetch = jest.fn(async (url) => {
        const i = GENESIS_NODES.findIndex((g) => url.startsWith(g));
        return bals[i] === null ? { ok: false, text: async () => '' } : answer(bals[i]);
      });
      return wm.agreedGenesisBalance(FROM);
    };
    expect(await run(['100000000000', '100000000000', null, null, null])).toBe(100);
    expect(await run(['100000000000', '999000000000', null, null, null])).toBeNull();
    expect(await run(['9007199254740993000', '9007199254740993000', null, null, '1'])).toBeCloseTo(9007199254.740993, 3);
    // M14: three genesis names are asked first, the other two only without two alike; the same read is then shared.
    expect(await run(Array(5).fill('100000000000'))).toBe(100);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(await wm.agreedGenesisBalance(FROM)).toBe(100);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    const screen = read('src/screens/WalletScreen.js');
    expect(screen).toMatch(/const agreedQnc = await walletManager\.agreedGenesisBalance\(qnetAddr\)/);
    // Read now, in nano, and refused when no certified proof gave it (MB-R2-02): never the figure on screen.
    expect(screen).toMatch(/const \[qncCheck, held, recipientProblem, keptNow, sentTo\] = await Promise\.all\(\[\s*isQnetSend \? freshQncNano\(\) : null,/);
    expect(screen).toMatch(/const qncNano = isQnetSend \? String\(qncCheck\.balanceNano\) : null;/);
    // The optimistic figure after a send drops the proof mark in the same update.
    expect(screen).toMatch(/setBalanceVerified\(false\);\s*setTokenBalances\(prev => \(\{\s*\.\.\.prev,\s*qnc: expectedBalance/);
  });
});

describe('MOBNET-R3-05: a token amount is scaled by the decimals the user recorded', () => {
  it('holdings hand over the raw base units, and the screen scales and signs with the record', async () => {
    const wm = new WalletManager();
    const contract = 'c'.repeat(64);
    wm._hedged = jest.fn(async () => ({ ok: true, data: `[{"contract_address":"${contract}","balance":"5000000000000000","name":"T","symbol":"TK","decimals":12}]` }));
    const [h] = await wm.getTokenHoldings(FROM);
    expect(h).toMatchObject({ decimals: 12, balanceBase: '5000000000000000' });
    expect(wm._formatBaseUnits(h.balanceBase, 9)).toBe('5000000');
    const screen = read('src/screens/WalletScreen.js');
    expect(screen).toMatch(/balance: walletManager\._formatBaseUnits\(held\.balanceBase \|\| '0', dec\),\s*decimalsTrusted: true/);
    expect(screen).toMatch(/tokenVisible\(tk\.contract, \{ hidden: hiddenTokens, added, shown: shownTokensRef\.current \}\)\s*&& tk\.decimalsTrusted/);
    expect(screen).toMatch(/if \(!recorded \|\| Number\(recorded\.decimals\) !== Number\(sendingToken\.decimals\)\) \{\s*setTxResult\(\{ success: false, title: t\('send_cannot_title'\), error: t\('send_token_unrecorded'\) \}\);/);
  });
});

describe('MOBNET-R3-06: one registry snapshot per certified root', () => {
  const entry = (nodeId, pkHex, i) => ({
    node_id: nodeId, wallet: `w_${nodeId}`, reg_height: 90, reg_index: i, node_type: 'super', burn: '',
    vrf_pk_sha3: sha3_256(Buffer.from(pkHex, 'hex')),
  });
  const COMMITTEE = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const PKS = Object.fromEntries(COMMITTEE.map((id, i) => [id, String(i + 1).repeat(2).repeat(16)]));
  const entries = COMMITTEE.map((id, i) => entry(id, PKS[id], i));
  const root = recomputeRegistryRoot(entries);

  beforeEach(() => clearQcCache());

  it('a second step at the same root downloads and hashes nothing', async () => {
    const fetchRegistry = jest.fn(async () => ({ entries }));
    const need = quorumSize(COMMITTEE.length);
    expect(await resolvePubkeys(COMMITTEE, root, 90, PKS, fetchRegistry, need)).not.toBeNull();
    const offline = jest.fn(async () => { throw new Error('offline'); });
    expect(Object.keys(await resolvePubkeys(COMMITTEE, root, 180, PKS, offline, need)).sort()).toEqual(COMMITTEE);
    expect(offline).not.toHaveBeenCalled();
    // Another root is fetched and bound again.
    const more = [...entries, entry('n6', '66'.repeat(16), 5)];
    const fetchMore = jest.fn(async () => ({ entries: more }));
    expect(await resolvePubkeys(COMMITTEE, recomputeRegistryRoot(more), 270, PKS, fetchMore, need)).not.toBeNull();
    expect(fetchMore).toHaveBeenCalledTimes(1);
  });
});

describe('MOBNET-R3-08: look-alike names and unasked tokens in the history', () => {
  it('Cyrillic and Greek letters that pass for Latin ones are folded', () => {
    expect(usesReservedName('QNС', '')).toBe(true);      // Cyrillic Es
    expect(usesReservedName('QΝC', '')).toBe(true);      // Greek Nu
    expect(usesReservedName('ԚNC', '')).toBe(true);      // Cyrillic Qa
    expect(usesReservedName('', 'QΝЕТ Coin')).toBe(true); // Greek Nu, Cyrillic Ie and Te
    expect(usesReservedName('GLD', 'Guild gold')).toBe(false);
    expect(usesReservedName('НЕТ', 'Сеть')).toBe(false);
  });

  it('history rows of tokens not added are named by contract id, marked, and hidden until shown', () => {
    const screen = read('src/screens/WalletScreen.js');
    const rows = read('src/screens/HistoryTab.js');
    // The symbol written through tokenLabel (M-5), so no hidden or format character in it reorders the row.
    expect(rows).toMatch(/const tokenSymbol = tokenLabel\(tx\.tokenSymbol\);/);
    expect(rows).toMatch(/tx\.tokenMetaTrusted \? tokenSymbol : `\$\{tokenSymbol\} \(\$\{contractShortId\(tx\.tokenContract\)\}\)`/);
    // Marked on the row (⚠ before the symbol) and said in words on the detail screen.
    expect(rows).toMatch(/symbol: reserved \? `⚠ \$\{symbol\}` : symbol/);
    expect(rows).toMatch(/if \(d\.reserved\) fields\.push\(<Text key="reserved" style=\{styles\.txDetailWarning\}>\{t\('tok_reserved_warning'\)\}<\/Text>\);/);
    expect(screen).toMatch(/\? txHistory\.filter\(rowVisible\)/);
    expect(screen).toMatch(/t\('hist_unasked_hidden', \{ count: unaskedRows \}\)/);
  });
});
