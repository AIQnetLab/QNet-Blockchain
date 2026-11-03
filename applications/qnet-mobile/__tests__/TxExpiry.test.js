/**
 * The wallet on the V2 transaction form (a signed last height): which form a transaction signs (the genesis nodes'
 * account answers: tx_v2 and next_height), the one automatic re-sign a typed refusal of the form or the height asks for
 * (never more), a move of the node balance in the form its quote offers (the node's message only ever compared, never
 * signed), and the fate of a V2 transaction by height: once a node's tip passed its last height with its nonce free, it
 * failed and took nothing, in the kept list, the result card's resolver and a move in transit. No clock decides it.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => ({
  verifyDilithium: jest.fn(async () => true), isDilithiumAvailable: () => true,
  signDetached: jest.fn(async () => 'ab'.repeat(3309)), signWithDilithium: jest.fn(async () => 'cd'.repeat(3309)),
}));

const fs = require('fs');
const path = require('path');
const AsyncStorage = require('@react-native-async-storage/async-storage');
const { sha3_256 } = require('js-sha3');
const { signDetached, signWithDilithium } = require('../src/crypto/DilithiumCrypto');
const { WalletManager } = require('../src/components/WalletManager');
const Pending = require('../src/services/PendingTx');
const CT = require('../src/services/ClaimTransit');
const { NETWORK_ID } = require('../src/config/genesisConsensus');
const { GENESIS_NODES } = require('../src/config/nodes');
const { QNET_CHAIN_TAG } = require('../src/crypto/WalletIdentity');
const { refusalClass } = require('../src/utils/txRefusal');
const translations = require('../src/i18n/translations').default;

const ME = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
const TO = 'dc6e4f045e96c0bf43deon546e9f27ad8f91464e6a4f6';
const NODE = 'light_mobile_83afab763b9058fd';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const REFUSED = (code) => ({ accepted: false, error: `Failed to add transaction to mempool: ${code}: the node's words` });

beforeEach(async () => {
  await AsyncStorage.clear();
  WalletManager.nonceReads.clear();
  WalletManager.lastOwnSendAt.clear();
  WalletManager.pkBound = {};
  signDetached.mockClear();
  signWithDilithium.mockClear();
});

// The genesis account answers of `address`: `answer(base)` gives each node's, or null for no answer.
const genesisAnswers = (wm, answer) => {
  wm._getJson = jest.fn(async (base, p) => {
    if (!p.startsWith('/api/v1/account/')) throw new Error('down');
    const a = answer(base);
    if (!a) throw new Error('down');
    return a;
  });
};

describe('the genesis answers give the nonce, the form and the tip in one read', () => {
  it('V2 only when every answer of the agreed nonce says so; the highest next height to sign, the lowest to judge', async () => {
    const wm = new WalletManager();
    const heights = [1000, 1002, 1001, null, null];
    genesisAnswers(wm, (base) => {
      const i = GENESIS_NODES.indexOf(base);
      return heights[i] === null ? null : { nonce: 5, tx_v2: true, next_height: heights[i] };
    });
    await expect(wm._agreedGenesisAccount(ME)).resolves.toEqual({ nonce: 5, txV2: true, nextHeight: 1002, tip: { nonce: 5, nextHeight: 1000 } });
    await expect(wm._agreedGenesisNonce(ME)).resolves.toBe(5);
    const old = new WalletManager();
    genesisAnswers(old, (base) => (GENESIS_NODES.indexOf(base) === 1 ? { nonce: 5 } : { nonce: 5, tx_v2: true, next_height: 900 }));
    await expect(old._agreedGenesisAccount(ME)).resolves.toMatchObject({ nonce: 5, txV2: false });
  });
});

// A wallet manager that signs at nonce 6 over the genesis answers `answer`, and whose sends end as `outcomes` says.
function sender({ answer = () => ({ nonce: 5, tx_v2: true, next_height: 1000 }), outcomes = [], fresh = null } = {}) {
  const wm = new WalletManager();
  genesisAnswers(wm, answer);
  wm.resolveNonce = jest.fn(async () => ({ nonce: 6, replaces: null, confirmed: 5 }));
  const queue = [...outcomes];
  wm._sendPending = jest.fn(async () => queue.shift() || { accepted: true, data: { tx_hash: 'e'.repeat(64) } });
  wm._hedged = jest.fn(async (p) => {
    if (p === `/api/v1/account/${ME}` && fresh) return { ok: true, status: 200, data: fresh };
    throw new Error('down');
  });
  wm.loadWallet = jest.fn(async () => ({
    secretKey: [1], qnetAddress: ME, qnetKeypair: { publicKey: Array(1952).fill(1), privateKey: Array(4032).fill(2) },
  }));
  return wm;
}
const signed = () => signDetached.mock.calls.map((c) => c[0]);
const sentBodies = (wm) => wm._sendPending.mock.calls.map((c) => c[0].body);

describe('which form a transaction signs', () => {
  it('the V2 form, last height next_height + 600, when the genesis nodes say the network takes it', async () => {
    const wm = sender();
    const r = await wm.sendQNC(TO, 2, 'pw');
    expect(r.success).toBe(true);
    expect(signed()).toEqual([`${QNET_CHAIN_TAG}${NETWORK_ID}|transfer_v2:${ME}:${TO}:2000000000:6:10:10000:1600`]);
    expect(sentBodies(wm)[0]).toMatchObject({ valid_until: 1600, nonce: 6 });
    expect((await Pending.pendingEntry(ME, 6)).body.valid_until).toBe(1600);
  });

  it('the V1 form exactly as before when they do not (a node that names no form)', async () => {
    const wm = sender({ answer: () => ({ nonce: 5 }) });
    await wm.sendQNC(TO, 2, 'pw');
    expect(signed()).toEqual([`${QNET_CHAIN_TAG}transfer:${ME}:${TO}:2000000000:6:10:10000`]);
    expect(sentBodies(wm)[0]).not.toHaveProperty('valid_until');
  });

  it('a token transfer, a contract call and a deploy sign the V2 form too', async () => {
    const wm = sender();
    wm._loadContractSigner = jest.fn(async () => ({ from: ME, dilPkHex: '01'.repeat(1952), dilSkHex: '02'.repeat(4032) }));
    await wm.qrc20Transfer(TO, ME, '5', 'pw');
    await wm.callWasmContract({ contract: TO, method: 'run', args: 'ab' }, 'pw');
    await wm.deployToken({ name: 'Tok', symbol: 'TK', initialSupply: 10 }, 'pw');
    await wm.deployNftCollection({ name: 'Art', symbol: 'AR' }, 'pw');
    const texts = signed();
    expect(texts[0]).toMatch(new RegExp(`^${QNET_CHAIN_TAG.replace('|', '\\|')}${NETWORK_ID}\\|contract_call_v2:${ME}:[0-9a-f]{64}:6:10:\\d+:1600$`));
    expect(texts[1]).toMatch(/\|contract_call_v2:.*:1600$/);
    expect(texts[2]).toMatch(/\|contract_deploy_v2:.*:1600$/);
    expect(texts[3]).toMatch(/\|contract_deploy_v2:.*:1600$/);
    expect(sentBodies(wm).map((b) => b.valid_until)).toEqual([1600, 1600, 1600, 1600]);
  });
});

describe('a typed refusal of the form or the height: one re-sign, never more', () => {
  it('tx_v2_before_gate: the V1 form at the same nonce', async () => {
    const wm = sender({ outcomes: [REFUSED('tx_v2_before_gate')] });
    const r = await wm.sendQNC(TO, 2, 'pw');
    expect(r.success).toBe(true);
    expect(signed()).toEqual([
      `${QNET_CHAIN_TAG}${NETWORK_ID}|transfer_v2:${ME}:${TO}:2000000000:6:10:10000:1600`,
      `${QNET_CHAIN_TAG}transfer:${ME}:${TO}:2000000000:6:10:10000`,
    ]);
    expect((await Pending.pendingEntry(ME, 6)).body).not.toHaveProperty('valid_until'); // the re-signed one is kept
  });

  it('tx_expiry_required, tx_expired, tx_expiry_beyond_horizon: the V2 form with a fresh next height', async () => {
    for (const code of ['tx_expiry_required', 'tx_expired', 'tx_expiry_beyond_horizon']) {
      signDetached.mockClear();
      const wm = sender({ answer: () => ({ nonce: 5 }), outcomes: [REFUSED(code)], fresh: { nonce: 5, next_height: 2000 } });
      await wm.sendQNC(TO, 2, 'pw');
      expect([code, signed()]).toEqual([code, [
        `${QNET_CHAIN_TAG}transfer:${ME}:${TO}:2000000000:6:10:10000`,
        `${QNET_CHAIN_TAG}${NETWORK_ID}|transfer_v2:${ME}:${TO}:2000000000:6:10:10000:2600`,
      ]]);
    }
  });

  it('never a loop: a second refusal is the answer; no fresh height, or any other refusal, is no re-sign', async () => {
    const twice = sender({ outcomes: [REFUSED('tx_expired'), REFUSED('tx_expired')], fresh: { next_height: 2000 } });
    const r = await twice.sendQNC(TO, 2, 'pw');
    expect(r.success).toBe(false);
    expect(r.refusal).toMatch(/tx_expired/);
    expect(signed()).toHaveLength(2);

    signDetached.mockClear();
    const noHeight = sender({ outcomes: [REFUSED('tx_expiry_required')], fresh: { nonce: 5 } });
    expect((await noHeight.sendQNC(TO, 2, 'pw')).success).toBe(false);
    expect(signed()).toHaveLength(1);

    signDetached.mockClear();
    const other = sender({ outcomes: [{ accepted: false, error: 'Failed: insufficient balance' }] });
    expect((await other.sendQNC(TO, 2, 'pw')).success).toBe(false);
    expect(signed()).toHaveLength(1);
  });
});

describe('the fate of a V2 transaction by height', () => {
  const keep = (nonce, validUntil) => Pending.putSigned({
    from: ME, nonce, path: '/api/v1/transaction', body: { from: ME, nonce, ...(validUntil ? { valid_until: validUntil } : {}) },
    summary: { kind: 'transfer', to: TO, amountNano: 5 }, spend: { qncNano: '5' }, createdAt: Date.now(),
  });
  const resolver = (account) => {
    const wm = new WalletManager();
    wm._hedged = jest.fn(async () => ({ ok: true, status: 200, data: account }));
    wm.rebroadcastPending = jest.fn(async () => false);
    return wm;
  };

  it('a tip past its last height, its nonce free: failed, nothing taken, gone from the kept list and remembered', async () => {
    await keep(6, 1000);
    // The tip at its last height: a block of that height may hold it.
    let res = await resolver({ nonce: 5, next_height: 1001 }).resolveSubmitByNonce(ME, 6, { toAddress: TO, amountNano: 5 });
    expect(res.expired).toBeUndefined();
    expect(await Pending.pendingEntry(ME, 6)).not.toBe(null);
    const wm = resolver({ nonce: 5, next_height: 1002 });
    res = await wm.resolveSubmitByNonce(ME, 6, { toAddress: TO, amountNano: 5 });
    expect(res).toEqual({ landed: false, known: true, expired: true });
    expect(wm.rebroadcastPending).not.toHaveBeenCalled(); // never sent again
    expect(await Pending.pendingEntry(ME, 6)).toBe(null);
    expect(await Pending.expiredRecord(ME, 6)).toMatchObject({ nonce: 6, expired: true });
    expect((await Pending.ownSpends(ME)).has(6)).toBe(false); // it took nothing: a send check counts none of it
    // Asked again later, it stays expired.
    expect(await resolver({ nonce: 5, next_height: 1500 }).resolveSubmitByNonce(ME, 6, { toAddress: TO, amountNano: 5 }))
      .toEqual({ landed: false, known: true, expired: true });
  });

  it('a V1 transaction has no last height: no height ends it; a nonce the chain took is decided as before', async () => {
    await keep(6, null);
    const res = await resolver({ nonce: 5, next_height: 999999 }).resolveSubmitByNonce(ME, 6, { toAddress: TO, amountNano: 5 });
    expect(res.expired).toBeUndefined();
    expect(await Pending.pendingEntry(ME, 6)).not.toBe(null);
    await keep(7, 1000);
    expect(await Pending.expireByHeight(ME, { nonce: 7, nextHeight: 5000 })).toEqual([]); // nonce 7 taken: not this rule's
  });

  it('the sweep of the kept list and a site\'s status drop it at once; a stopped one can no longer land either', async () => {
    await keep(6, 1000);
    const wm = new WalletManager();
    wm._agreedGenesisAccount = jest.fn(async () => ({ nonce: 5, txV2: true, nextHeight: 1200, tip: { nonce: 5, nextHeight: 1200 } }));
    wm.rebroadcastPending = jest.fn(async () => false);
    await wm.sendDuePending(ME);
    expect(wm.rebroadcastPending).not.toHaveBeenCalled();
    expect(await Pending.pendingFor(ME)).toEqual([]);
    expect(await wm.transactionStatusAt(ME, 6)).toMatchObject({ status: 'unknown' });

    await keep(8, 3000);
    expect(await Pending.stopFrom(ME, 8)).toBe(true);
    expect(await Pending.stoppedUntil(ME, 8)).toBeGreaterThan(Date.now());
    await Pending.expireByHeight(ME, { nonce: 7, nextHeight: 3002 });
    expect(await Pending.stoppedUntil(ME, 8)).toBe(null);
  });

  it('the result card and History say so (WalletScreen): expired, nothing taken', () => {
    const screen = read('src/screens/WalletScreen.js');
    expect(screen).toContain("res.expired ? 'tx_expired_title'");
    expect(screen).toContain("res.expired ? 'tx_note_expired'");
    // History's row says Expired in the result card's word, from the same answer (utils/txHistory nonceAnswer).
    const { nonceAnswer, withNonceAnswer, historyBadge } = require('../src/utils/txHistory');
    const answer = nonceAnswer({ landed: false, known: true, expired: true }, 'h');
    const row = { hash: 'h', from: ME, to: TO, amount: 5, status: 'pending', type: 'send', timestamp: 1 };
    expect(withNonceAnswer([row], 'h', answer).map(historyBadge)).toEqual(['expired']);
    expect(require('../src/screens/HistoryTab').BADGE_KEY.expired).toBe('tx_expired_title');
    expect(screen).toContain('const answer = nonceAnswer(res, r.hash);');
    expect(screen).toContain('const answer = nonceAnswer(res, txHash);');
  });
});

describe('a move of the node balance in the form its quote offers', () => {
  const NODES = ['https://a', 'https://b', 'https://c', 'https://d', 'https://e'];
  const TS = 1790000000;
  const claimsData = JSON.stringify({ claims: [{ epoch: 5, amount: '1000000000' }, { epoch: 6, amount: '2000000000' }] });
  const v1Message = `${QNET_CHAIN_TAG}qnet_claim_v1:${ME}:${TS}:${sha3_256(claimsData)}`;
  const v2Message = (vu) => `${QNET_CHAIN_TAG}${NETWORK_ID}|qnet_claim_v2:${ME}:${vu}:${sha3_256(claimsData)}`;
  const quote = (over = {}) => ({
    success: false, needs_signature: true, claims_data: claimsData, last_claimed_epoch: 4, amount_nano: '3000000000',
    claim_timestamp: TS, epochs_claimed: 2, stopped_at_epoch: null, sign_message: v1Message, valid_until: 1600,
    sign_message_v2: v2Message(1600), ...over,
  });
  const mover = (q, submits = [], fresh = null) => {
    const wm = new WalletManager();
    wm.loadWallet = async () => ({ qnetAddress: ME });
    wm._walletDilithiumKeys = async () => ({ secretKey: 'sk', publicKey: 'pk' });
    wm.getTrustedNodes = () => NODES.slice();
    wm._hedged = jest.fn(async (p, opts) => {
      const base = opts.nodes ? opts.nodes[0] : NODES[0];
      if (p === '/api/v1/rewards/claim') return { ok: true, status: 200, data: q, base };
      if (p === `/api/v1/account/${ME}` && fresh) return { ok: true, status: 200, data: fresh, base };
      if (p.startsWith('/api/v1/rewards/pending/')) {
        return { ok: true, status: 200, data: JSON.stringify({ node_id: NODE, first_unclaimed_epoch: 5, pending_rewards_nano: '3000000000' }), base };
      }
      throw new Error('down');
    });
    const queue = [...submits];
    wm._submitClaim = jest.fn(async () => queue.shift() || { ok: true, data: { success: true, tx_hash: 'cd'.repeat(32), amount_qnc: 3 } });
    return wm;
  };
  // The claim messages signed, in order: V2 with the raw detached signature the node hex-decodes (signDetached), V1 with
  // the signature its verifier has always read (signWithDilithium).
  const claimSigns = () => [
    ...signDetached.mock.calls.map((c, i) => [signDetached.mock.invocationCallOrder[i], `raw ${c[0]}`]),
    ...signWithDilithium.mock.calls.map((c, i) => [signWithDilithium.mock.invocationCallOrder[i], `enveloped ${c[0]}`]),
  ].filter(([, m]) => /qnet_claim_v/.test(m)).sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  const clearSigns = () => { signDetached.mockClear(); signWithDilithium.mockClear(); };

  it('a quote with valid_until: the V2 message built here is signed and posted with its last height, no timestamp', async () => {
    const wm = mover(quote());
    const r = await wm.claimRewards('light', ME, 'pw', 3_000_000_000, NODE);
    expect(r).toMatchObject({ success: true, validUntil: 1600 });
    expect(claimSigns()).toEqual([`raw ${v2Message(1600)}`]);
    const body = wm._submitClaim.mock.calls[0][0];
    expect(body).toMatchObject({ valid_until: 1600, claims_data: claimsData, claims_signature: 'ab'.repeat(3309) });
    expect(body).not.toHaveProperty('claim_timestamp');
    // A move in transit keeps that height, so a block past it ends the move (ClaimTransit).
    expect(CT.transitRecord({ nodeId: NODE, result: r }).validUntil).toBe(1600);
  });

  it('a quote without one: the V1 message, exactly as before', async () => {
    const wm = mover(quote({ valid_until: null, sign_message_v2: null }));
    const r = await wm.claimRewards('light', ME, 'pw', 3_000_000_000, NODE);
    expect(r.validUntil).toBe(null);
    expect(claimSigns()).toEqual([`enveloped ${v1Message}`]);
    expect(wm._submitClaim.mock.calls[0][0]).toMatchObject({ claim_timestamp: TS, claims_signature: 'cd'.repeat(3309) });
  });

  it('the node\'s V2 message is compared, never signed: another one, or a malformed height, refuses before anything is signed', async () => {
    for (const over of [{ sign_message_v2: v2Message(1601) }, { sign_message_v2: `${QNET_CHAIN_TAG}transfer:${ME}:${TO}:1:1:10:10000` },
      { valid_until: '1600' }, { valid_until: -1 }]) {
      clearSigns();
      const wm = mover(quote(over));
      await expect(wm.claimRewards('light', ME, 'pw', 3_000_000_000, NODE)).rejects.toThrow(/refusing/);
      expect(claimSigns()).toEqual([]);
      expect(wm._submitClaim).not.toHaveBeenCalled();
    }
  });

  it('a typed refusal: one re-sign (V1 before the gate, V2 with a fresh height otherwise), then the coded answer', async () => {
    const refused = (code) => ({ ok: true, data: { success: false, error: `${code}: the node's words` } });
    let wm = mover(quote(), [refused('tx_v2_before_gate')]);
    await wm.claimRewards('light', ME, 'pw', 3_000_000_000, NODE);
    expect(claimSigns()).toEqual([`raw ${v2Message(1600)}`, `enveloped ${v1Message}`]);
    expect(wm._submitClaim.mock.calls[1][0]).toMatchObject({ claim_timestamp: TS });

    clearSigns();
    wm = mover(quote(), [refused('tx_expired'), refused('tx_expired')], { next_height: 3000 });
    await expect(wm.claimRewards('light', ME, 'pw', 3_000_000_000, NODE)).rejects.toMatchObject({ code: 'TX_EXPIRED' });
    expect(claimSigns()).toEqual([`raw ${v2Message(1600)}`, `raw ${v2Message(3600)}`]);
    expect(wm._submitClaim).toHaveBeenCalledTimes(2);
  });

  it('the claim message is the shared builder\'s: no inline copy in WalletManager', () => {
    expect(read('src/components/WalletManager.js')).not.toMatch(/qnet_claim_v1:\$\{/);
  });
});

describe('a move in transit ends as expired by height, never by the clock', () => {
  const PARTS = [[101, '2500000000'], [102, '4000000000']];
  const result = (over = {}) => ({
    success: true, amountNano: '6500000000', prevWatermark: 100, lastEpoch: 102, parts: PARTS, txHash: 'ab'.repeat(32),
    validUntil: 9000, ...over,
  });
  const held = (over) => CT.addMove(CT.emptyTransit(ME), CT.transitRecord({ nodeId: NODE, result: result(over), balanceNano: 7e9 }));

  it('a live figure of a block past its last height that shows none of it: expired, the whole amount back on the node', () => {
    const s = held();
    expect(CT.noteLiveWatermark(s, 100, 9000).settled).toEqual([]); // the block at its last height may hold it
    const r = CT.noteLiveWatermark(CT.noteLiveWatermark(s, 100, 9000).state, 100, 9001);
    expect(r.settled).toEqual([{ move: expect.objectContaining({ nodeId: NODE }), result: 'expired', returnedNano: 6.5e9 }]);
    expect([CT.transitTotal(r.state), CT.heldMove(r.state)]).toEqual([0, null]);
    expect(CT.moveOutcome(r.state, 'ab'.repeat(32))).toEqual({ result: 'expired', appliedNano: 0 });
    expect(CT.moveNote(CT.moveOutcome(r.state, 'ab'.repeat(32)))).toEqual({ key: 'claim_note_expired' });
    expect(CT.answerFloor(r.state)).toBe(null); // its watermark ended nothing that went through
    const rows = [{ hash: 'ab'.repeat(32), status: 'reported' }];
    expect(CT.withMoveStates(rows, r.state)).toBe(rows); // in no block: nothing confirms its row
  });

  it('a certified state past its last height settles it; a V1 move has no last height, so no height ends it', () => {
    const c = CT.settleMoves(held(), { lastClaimedEpoch: 100, blockHeight: 9001, now: 1 });
    expect(c.settled).toEqual([expect.objectContaining({ result: 'expired', returnedNano: 6.5e9, liveSeen: false })]);
    expect(c.state.moves).toEqual([]);
    const v1 = held({ validUntil: null });
    expect(v1.moves[0]).not.toHaveProperty('validUntil');
    expect(CT.noteLiveWatermark(v1, 100, 999999).settled).toEqual([]);
    expect(CT.settleMoves(v1, { lastClaimedEpoch: 100, blockHeight: 999999, now: 1 }).settled).toEqual([]);
  });

  it('its last height survives a restart', async () => {
    await CT.writeTransit(held());
    expect((await CT.readTransit(ME)).moves[0].validUntil).toBe(9000);
  });
});

describe('what the screens say', () => {
  it('a refusal of the height has its own reason; a move refused names not registered, rate limited and expired', () => {
    expect(refusalClass('Failed to add transaction to mempool: tx_expired: its last height 5 is below the next block 7'))
      .toBe('expired');
    expect(refusalClass('tx_expiry_beyond_horizon: its last height 9000 is past 2800')).toBe('expired');
    const code = (error) => WalletManager.claimRefusal({ success: false, error }).code;
    expect(code('Node not registered on-chain. Registration TX required before claiming rewards.')).toBe('NOT_REGISTERED');
    expect(code('Rate limit exceeded')).toBe('RATE_LIMITED');
    expect(code('tx_expired: its last height 5 is below the next block 7; sign it again')).toBe('TX_EXPIRED');
    expect(code('tx_v2_before_gate: the network takes no signed last height yet')).toBe('CLAIM_REFUSED');
    // The words of a move are one table, the Node tab's card and the QNet Link sheet alike (utils/moveText).
    expect(read('src/utils/moveText.js')).toContain("NOT_REGISTERED: 'err_NOT_REGISTERED', RATE_LIMITED: 'err_RATE_LIMITED', TX_EXPIRED: 'err_TX_EXPIRED',");
    expect(read('src/screens/WalletScreen.js')).toContain('const claimErrorText = (error) => t(claimErrorKey(error));');
  });

  it('in all 11 languages, and a move refused no longer says that nothing was submitted', () => {
    const keys = ['err_NOT_REGISTERED', 'err_RATE_LIMITED', 'err_TX_EXPIRED', 'tx_refusal_expired', 'tx_expired_title',
      'tx_note_expired', 'claim_failed', 'claim_note_expired'];
    expect(Object.keys(translations).sort()).toEqual(['ar', 'de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'zh-CN']);
    for (const [lang, table] of Object.entries(translations)) {
      for (const k of keys) {
        expect([lang, k, typeof table[k] === 'string' && table[k].length > 0]).toEqual([lang, k, true]);
        if (lang !== 'en') expect([lang, k, table[k] !== translations.en[k]]).toEqual([lang, k, true]);
      }
    }
    expect(translations.en.claim_failed).not.toMatch(/nothing was submitted/i);
  });
});
