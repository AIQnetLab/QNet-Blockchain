// solana.js, offline: instruction bytes, the legacy message compiler against a real devnet burn, the
// signed burn transaction, the burn matcher on poisoned histories, the RPC client, and the send flow: its
// transaction bytes, a payment request's references and memo included, against vectors laid out independently here
// (associated-account addresses derived with this file's own SHA-256, curve check and base58) and against the mobile
// app's own builder, its rent rules, Max and the status it is followed by.
// Nothing here reaches the network: fetch is replaced and every Solana answer is a recorded fixture or
// built from one.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./helpers/chains-activation-loader.mjs', import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
const core = await import('../dist/lib/qnet-core.js');
const { SOLANA, LIMITS } = await import('../dist/background/config.js');
const { WalletError } = await import('../dist/background/errors.js');
const { WALLET, installEnv, installFetch, solanaRoute, routes, fakeSignature } = await import('./helpers/chains-activation-env.mjs');
const { importApp } = await import('./helpers/app-modules.mjs');
const solana = await import('../dist/background/solana.js');

const { SYSTEM, TOKEN, ASSOCIATED_TOKEN, MEMO } = core.SOLANA_PROGRAMS;
const MINT = SOLANA.ONE_DEV_MINT;
const BURN = fixture('devnet_burn_tx_nqh74h.json').result;
const WIRE = fixture('chains-activation-burn-wire.json');
const BURNER = 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR';
const BURNER_ATA = '9CZ6SkAcW7iAp3WVgwi1TVtm9qnF7gYKzeE2Z6NdXqD1';
const BLOCKHASH = 'DxsSCVwmXLXPmozkiERhuCEtEkMYpL6391F6GexS2yYM';
// A third wallet (another public test phrase), distinct from the burner and from the KAT wallet.
const OTHER = core.deriveSolanaKeypair(core.mnemonicToSeed(`${'abandon '.repeat(23)}art`)).address;
const utf8 = (s) => new TextEncoder().encode(s);
const le64 = (n) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return [...out];
};
const clone = (v) => JSON.parse(JSON.stringify(v));

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof WalletError || error?.name === 'CoreError', `${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

function readCompact(bytes, offset) {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const b = bytes[i++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [value, i];
    shift += 7;
  }
}

function decodeMessage(m) {
  const header = [m[0], m[1], m[2]];
  let [count, o] = readCompact(m, 3);
  const keys = [];
  for (let k = 0; k < count; k++, o += 32) keys.push(core.base58Encode(m.slice(o, o + 32)));
  const blockhash = core.base58Encode(m.slice(o, o + 32));
  o += 32;
  let n;
  [n, o] = readCompact(m, o);
  const instructions = [];
  for (let k = 0; k < n; k++) {
    const programIdIndex = m[o++];
    let len;
    [len, o] = readCompact(m, o);
    const accounts = [...m.slice(o, o + len)];
    o += len;
    [len, o] = readCompact(m, o);
    const data = m.slice(o, o + len);
    o += len;
    instructions.push({ program: keys[programIdIndex], accounts: accounts.map((i) => keys[i]), data });
  }
  assert.equal(o, m.length, 'message fully consumed');
  return { header, keys, blockhash, instructions };
}

function decodeWire(wire) {
  const [count, start] = readCompact(wire, 0);
  const signatures = [];
  for (let k = 0; k < count; k++) signatures.push(wire.slice(start + 64 * k, start + 64 * (k + 1)));
  const message = wire.slice(start + 64 * count);
  return { signatures, message, ...decodeMessage(message) };
}

describe('chains-activation solana: instruction bytes', () => {
  it('System Transfer: index 2 as u32 LE, then lamports u64 LE; from signs and both are writable', () => {
    const ix = solana.systemTransferInstruction({ from: WALLET.solanaAddress, to: OTHER, lamports: 1_000_000_001n });
    assert.equal(ix.programId, SYSTEM);
    assert.deepEqual([...ix.data], [2, 0, 0, 0, ...le64(1_000_000_001n)]);
    assert.deepEqual(ix.keys, [
      { pubkey: WALLET.solanaAddress, isSigner: true, isWritable: true },
      { pubkey: OTHER, isSigner: false, isWritable: true },
    ]);
  });

  it('TransferChecked: [12, amount, decimals] over [source, mint, destination, owner]', () => {
    const ix = solana.transferCheckedInstruction({
      source: BURNER_ATA, mint: MINT, destination: OTHER, owner: BURNER, amount: 2_500_000n, decimals: 6,
    });
    assert.equal(ix.programId, TOKEN);
    assert.deepEqual([...ix.data], [12, ...le64(2_500_000n), 6]);
    assert.deepEqual(ix.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]), [
      [BURNER_ATA, false, true], [MINT, false, false], [OTHER, false, true], [BURNER, true, false]]);
  });

  it('CreateIdempotent: [1] over payer, ata, owner, mint, system, token', () => {
    const ix = solana.createAtaIdempotentInstruction({ payer: BURNER, ata: BURNER_ATA, owner: OTHER, mint: MINT });
    assert.equal(ix.programId, ASSOCIATED_TOKEN);
    assert.deepEqual([...ix.data], [1]);
    assert.deepEqual(ix.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]), [
      [BURNER, true, true], [BURNER_ATA, false, true], [OTHER, false, false], [MINT, false, false],
      [SYSTEM, false, false], [TOKEN, false, false]]);
  });

  it('Burn is instruction 8 (not BurnChecked 15) over [account(w), mint(w), authority(signer)]', () => {
    const ix = solana.burnInstruction({ account: BURNER_ATA, mint: MINT, authority: BURNER, amount: 1_500_000_000n });
    assert.equal(ix.programId, TOKEN);
    assert.deepEqual([...ix.data], [8, ...le64(1_500_000_000n)]);
    assert.equal(ix.data.length, 9);
    assert.deepEqual(ix.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]), [
      [BURNER_ATA, false, true], [MINT, false, true], [BURNER, true, false]]);
    assert.throws(() => solana.burnInstruction({ account: BURNER_ATA, mint: MINT, authority: BURNER, amount: 0n }));
  });

  it('Memo lists its signer, so the memo is bound to the wallet', () => {
    const ix = solana.memoInstruction({ text: 'QNET_NODE_TYPE:SUPER', signer: BURNER });
    assert.equal(ix.programId, MEMO);
    assert.deepEqual(ix.keys, [{ pubkey: BURNER, isSigner: true, isWritable: false }]);
    assert.deepEqual(ix.data, utf8('QNET_NODE_TYPE:SUPER'));
  });

  it('refuses malformed addresses and amounts', () => {
    assert.throws(() => solana.systemTransferInstruction({ from: 'nope', to: OTHER, lamports: 1n }));
    assert.throws(() => solana.systemTransferInstruction({ from: BURNER, to: OTHER, lamports: 1 }));
    assert.throws(() => solana.systemTransferInstruction({ from: BURNER, to: OTHER, lamports: -1n }));
    assert.throws(() => solana.transferCheckedInstruction({ source: BURNER, mint: MINT, destination: OTHER, owner: BURNER, amount: 1n, decimals: 1.5 }));
  });
});

describe('chains-activation solana: legacy message and wire format', () => {
  const wire = core.base64Decode(WIRE.transaction);
  const onChain = decodeWire(wire);

  it('compiles the recorded devnet burn byte for byte and its signature verifies over our bytes', () => {
    const burnIx = solana.burnInstruction({ account: BURNER_ATA, mint: MINT, authority: BURNER, amount: 1_500_000_000n });
    // this burn wrote the memo without a signer account
    const memoIx = { programId: MEMO, keys: [], data: utf8('QNET_NODE_TYPE:LIGHT') };
    const message = solana.compileLegacyMessage({ feePayer: BURNER, recentBlockhash: BLOCKHASH, instructions: [burnIx, memoIx] });
    assert.deepEqual(message, onChain.message);
    assert.equal(core.base58Encode(onChain.signatures[0]), WIRE.signature);
    assert.equal(core.verifySolanaSignature(onChain.signatures[0], message, core.solanaAddressToBytes(BURNER)), true);
    assert.deepEqual(solana.serializeTransaction(message, onChain.signatures), wire);
    assert.deepEqual(onChain.keys, BURN.transaction.message.accountKeys.map((k) => k.pubkey));
  });

  it('orders keys signer-writable, signer-readonly, writable, readonly, fee payer first', () => {
    const message = solana.compileLegacyMessage({
      feePayer: WALLET.solanaAddress,
      recentBlockhash: BLOCKHASH,
      instructions: [
        solana.transferCheckedInstruction({ source: BURNER_ATA, mint: MINT, destination: OTHER, owner: BURNER, amount: 1n, decimals: 6 }),
        solana.systemTransferInstruction({ from: WALLET.solanaAddress, to: OTHER, lamports: 1n }),
      ],
    });
    const decoded = decodeMessage(message);
    assert.deepEqual(decoded.header, [2, 1, 3]);
    assert.equal(decoded.keys[0], WALLET.solanaAddress);
    assert.equal(decoded.keys[1], BURNER);
    assert.deepEqual(new Set(decoded.keys.slice(2, 4)), new Set([BURNER_ATA, OTHER]));
    assert.deepEqual(new Set(decoded.keys.slice(4)), new Set([MINT, TOKEN, SYSTEM]));
    assert.equal(decoded.blockhash, BLOCKHASH);
  });

  it('refuses a signature count that does not match the header', () => {
    assert.throws(() => solana.serializeTransaction(onChain.message, []));
    assert.throws(() => solana.serializeTransaction(onChain.message, [new Uint8Array(63)]));
  });
});

describe('chains-activation solana: the signed burn transaction', () => {
  beforeEach(() => installEnv());

  for (const [nodeType, memo] of [['light', 'QNET_NODE_TYPE:LIGHT'], ['super', 'QNET_NODE_TYPE:SUPER']]) {
    it(`burns price x 10^6 from the wallet ATA with the ${nodeType} memo, fee payer and signer = wallet`, async () => {
      const { transaction, signature } = await solana.buildBurnTransaction({ nodeType, amountWhole: 1500, recentBlockhash: BLOCKHASH });
      const tx = decodeWire(transaction);
      const owner = WALLET.solanaAddress;
      const ata = core.associatedTokenAddress(owner, MINT);
      assert.equal(tx.signatures.length, 1);
      assert.equal(core.base58Encode(tx.signatures[0]), signature);
      assert.equal(core.verifySolanaSignature(tx.signatures[0], tx.message, WALLET.solanaPublicKey), true);
      assert.deepEqual(tx.header, [1, 0, 2]);
      assert.equal(tx.keys[0], owner);
      assert.deepEqual(new Set(tx.keys.slice(1, 3)), new Set([ata, MINT]));
      assert.deepEqual(new Set(tx.keys.slice(3)), new Set([MEMO, TOKEN]));
      assert.equal(tx.instructions.length, 2);
      const [burnIx, memoIx] = tx.instructions;
      assert.equal(burnIx.program, TOKEN);
      assert.deepEqual(burnIx.accounts, [ata, MINT, owner]);
      assert.deepEqual([...burnIx.data], [8, ...le64(1_500_000_000n)]);
      assert.equal(memoIx.program, MEMO);
      assert.deepEqual(memoIx.accounts, [owner]);
      assert.equal(new TextDecoder().decode(memoIx.data), memo);
      assert.equal(tx.blockhash, BLOCKHASH);
    });
  }

  it('refuses a fractional, zero or oversized amount and an unknown node type before signing', async () => {
    const env = installEnv();
    for (const amountWhole of [0, 1.5, -3, 1_000_000_001, '1500']) {
      await assert.rejects(solana.buildBurnTransaction({ nodeType: 'light', amountWhole, recentBlockhash: BLOCKHASH }));
    }
    await rejectsWith(solana.buildBurnTransaction({ nodeType: 'full', amountWhole: 1500, recentBlockhash: BLOCKHASH }), 'INVALID_NODE_TYPE');
    assert.equal(env.calls.signSolanaMessage, 0);
  });

  it('refuses while locked', async () => {
    installEnv({ locked: true });
    await rejectsWith(solana.buildBurnTransaction({ nodeType: 'light', amountWhole: 1500, recentBlockhash: BLOCKHASH }), 'LOCKED');
  });
});

// ---------------------------------------------------------------- matcher

const EXPECTED = { owner: BURNER, signature: WIRE.signature, mint: MINT, ata: BURNER_ATA, decimals: 6 };
const burnIx = (tx) => tx.transaction.message.instructions.find((ix) => ix.parsed?.type === 'burn' || ix.parsed?.type === 'burnChecked');
const memoIx = (tx) => tx.transaction.message.instructions.find((ix) => ix.programId === MEMO);

function variant(mutate) {
  const tx = clone(BURN);
  mutate(tx);
  return tx;
}

describe('chains-activation solana: validateBurnTx', () => {
  it('accepts the recorded devnet burn (Burn + unsigned memo)', () => {
    assert.deepEqual(solana.validateBurnTx(BURN, EXPECTED), { nodeType: 'light', amount: 1500 });
    assert.deepEqual(solana.validateBurnTx(BURN, { owner: BURNER }), { nodeType: 'light', amount: 1500 });
  });

  it('accepts BurnChecked at the mint decimals, a v1 memo, and an extra untyped memo', () => {
    const checked = variant((tx) => {
      const ix = burnIx(tx);
      ix.parsed.type = 'burnChecked';
      ix.parsed.info.tokenAmount = { amount: '300000000', decimals: 6, uiAmount: 300, uiAmountString: '300' };
      delete ix.parsed.info.amount;
      memoIx(tx).parsed = 'QNET_NODE_TYPE:SUPER';
      memoIx(tx).programId = SOLANA.MEMO_V1_PROGRAM;
      tx.transaction.message.instructions.push({ program: 'spl-memo', programId: MEMO, parsed: 'hello', stackHeight: 1 });
    });
    assert.deepEqual(solana.validateBurnTx(checked, EXPECTED), { nodeType: 'super', amount: 300 });
  });

  const poisoned = {
    'failed transaction (meta.err set)': (tx) => { tx.meta.err = { InstructionError: [0, 'Custom'] }; },
    'another signature than the listed one': (tx) => { tx.transaction.signatures[0] = fakeSignature(1); },
    'fee payer is someone else, the wallet only signs': (tx) => {
      const keys = tx.transaction.message.accountKeys;
      keys.unshift({ pubkey: OTHER, signer: true, source: 'transaction', writable: true });
    },
    'wallet is fee payer but not a signer': (tx) => { tx.transaction.message.accountKeys[0].signer = false; },
    'wrong mint (mainnet 1DEV on the devnet channel)': (tx) => { burnIx(tx).parsed.info.mint = '4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump'; },
    'burn from another token account': (tx) => { burnIx(tx).parsed.info.account = OTHER; },
    'burn authority is not the wallet': (tx) => { burnIx(tx).parsed.info.authority = OTHER; },
    'multisig authority': (tx) => { burnIx(tx).parsed.info.multisigAuthority = OTHER; },
    'fractional 1DEV amount': (tx) => { burnIx(tx).parsed.info.amount = '1500000001'; },
    'zero amount': (tx) => { burnIx(tx).parsed.info.amount = '0'; },
    'amount not a decimal string': (tx) => { burnIx(tx).parsed.info.amount = 1500000000; },
    'BurnChecked at other decimals': (tx) => {
      const ix = burnIx(tx);
      ix.parsed.type = 'burnChecked';
      ix.parsed.info.tokenAmount = { amount: '1500000000', decimals: 9 };
    },
    'burn by Token-2022': (tx) => {
      burnIx(tx).programId = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
      burnIx(tx).program = 'spl-token-2022';
    },
    'two burns (second one inner)': (tx) => {
      tx.meta.innerInstructions = [{ index: 0, instructions: [clone(burnIx(tx))] }];
    },
    'no node-type memo': (tx) => { memoIx(tx).parsed = 'hello'; },
    'memo only mentions the prefix': (tx) => { memoIx(tx).parsed = 'see QNET_NODE_TYPE:LIGHT here'; },
    'unknown node type in the memo': (tx) => { memoIx(tx).parsed = 'QNET_NODE_TYPE:FULL'; },
    'two node-type memos': (tx) => {
      tx.transaction.message.instructions.push({ ...clone(memoIx(tx)), parsed: 'QNET_NODE_TYPE:SUPER' });
    },
  };
  for (const [name, mutate] of Object.entries(poisoned)) {
    it(`refuses: ${name}`, () => {
      assert.equal(solana.validateBurnTx(variant(mutate), EXPECTED), null);
    });
  }

  it('refuses missing pieces and a foreign owner without throwing', () => {
    for (const tx of [null, {}, { meta: { err: null } }, variant((t) => { delete t.transaction.message; })]) {
      assert.equal(solana.validateBurnTx(tx, EXPECTED), null);
    }
    assert.equal(solana.validateBurnTx(BURN, { ...EXPECTED, owner: OTHER, ata: undefined }), null);
    assert.equal(solana.validateBurnTx(BURN, { ...EXPECTED, owner: 'not-an-address' }), null);
  });
});

// R4-ESA-01: validateBurnTx stays strict (only a Light or Super burn from the associated account yields a code), but
// the one-activation guard counts every 1DEV burn the wallet itself signed and paid for: a Full node memo, or a burn
// from another of its token accounts. The node reads neither the memo nor the source account.
describe('chains-activation solana: isOwnBurn (R4-ESA-01)', () => {
  const own = {
    'the recorded Light burn': () => {},
    'a Full node memo': (tx) => { memoIx(tx).parsed = 'QNET_NODE_TYPE:FULL'; },
    'no memo at all': (tx) => { memoIx(tx).parsed = 'hello'; },
    'burn from another token account of the wallet': (tx) => { burnIx(tx).parsed.info.account = OTHER; },
    'a burn as an inner instruction': (tx) => {
      const ix = burnIx(tx);
      tx.transaction.message.instructions = tx.transaction.message.instructions.filter((i) => i !== ix);
      tx.meta.innerInstructions = [{ index: 0, instructions: [ix] }];
    },
  };
  for (const [name, mutate] of Object.entries(own)) {
    it(`counts: ${name}`, () => {
      assert.equal(solana.isOwnBurn(variant(mutate), BURNER, MINT), true);
    });
  }
  const notOwn = {
    'failed transaction': (tx) => { tx.meta.err = { InstructionError: [0, 'Custom'] }; },
    'fee payer is someone else': (tx) => {
      tx.transaction.message.accountKeys.unshift({ pubkey: OTHER, signer: true, source: 'transaction', writable: true });
    },
    'the wallet is fee payer but did not sign': (tx) => { tx.transaction.message.accountKeys[0].signer = false; },
    'burn authority is not the wallet': (tx) => { burnIx(tx).parsed.info.authority = OTHER; },
    'another mint': (tx) => { burnIx(tx).parsed.info.mint = OTHER; },
    'no burn': (tx) => { burnIx(tx).parsed.type = 'transfer'; },
  };
  for (const [name, mutate] of Object.entries(notOwn)) {
    it(`does not count: ${name}`, () => {
      assert.equal(solana.isOwnBurn(variant(mutate), BURNER, MINT), false);
    });
  }
  it('never throws on a malformed transaction', () => {
    for (const tx of [null, {}, { meta: { err: null } }, variant((t) => { delete t.transaction.message; })]) {
      assert.equal(solana.isOwnBurn(tx, BURNER, MINT), false);
    }
  });
});

// A listed entry and the jsonParsed transaction behind it, built from the recorded burn.
function burnAt(n, slot, { index = 0, mutate = null, memo = '[20] QNET_NODE_TYPE:LIGHT' } = {}) {
  const signature = fakeSignature(n);
  const tx = variant((t) => {
    t.transaction.signatures = [signature];
    t.slot = slot;
    t.blockTime = 1790000000 + (slot % 100000);
    if (mutate) mutate(t);
  });
  return { entry: { signature, slot, err: null, memo, blockTime: tx.blockTime, transactionIndex: index, confirmationStatus: 'finalized' }, tx };
}

// Untagged entries are never fetched, so a cheap unique string stands in for their signature.
const plain = (n, slot) => ({ signature: `plain-${n}`, slot, err: null, memo: null, blockTime: 1790000000, transactionIndex: 0 });

/**
 * The wallet's 1DEV account history as getSignaturesForAddress serves it: `entries` newest first (at
 * 'finalized'), `before` and `until` exclusive, at most `limit`; `recent` is the newest page at 'confirmed'.
 * Asserts the search lists the token account, never the wallet address.
 */
function historyRpc(entries, txs, { decimals = 6, recent = [], confirmedTxs = {} } = {}) {
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'getTokenSupply') return { context: { slot: 1 }, value: { amount: '1', decimals, uiAmountString: '0.000001' } };
    if (method === 'getSignaturesForAddress') {
      assert.equal(params[0], BURNER_ATA, 'the search lists the wallet\'s 1DEV account');
      const { limit, before, until, commitment } = params[1];
      if (commitment === 'confirmed') {
        const from = before ? recent.findIndex((e) => e.signature === before) + 1 : 0;
        return before && from === 0 ? [] : recent.slice(from, from + limit);
      }
      assert.equal(commitment, 'finalized');
      let start = before ? entries.findIndex((e) => e.signature === before) + 1 : 0;
      if (before && start === 0) return [];
      const stop = until ? entries.findIndex((e) => e.signature === until) : -1;
      const end = stop >= 0 ? stop : entries.length;
      if (start > end) start = end;
      return entries.slice(start, Math.min(end, start + limit));
    }
    if (method === 'getTransaction') {
      assert.equal(params[1].encoding, 'jsonParsed');
      const table = params[1].commitment === 'confirmed' ? { ...txs, ...confirmedTxs } : txs;
      return Object.hasOwn(table, params[0]) ? table[params[0]] : null;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { call, calls };
}

// A store as the vault keeps it (vault.readBurnScan / writeBurnScan), in memory.
function memoryStore() {
  const store = {
    value: null,
    saves: 0,
    load: async () => (store.value === null ? null : structuredClone(store.value)),
    save: async (state) => {
      store.saves += 1;
      store.value = structuredClone(state);
    },
  };
  return store;
}

const txsOf = (...burns) => Object.fromEntries(burns.map((b) => [b.entry.signature, b.tx]));

describe('chains-activation solana: findWalletBurns (port of mobile BurnMatcher)', () => {
  it('pages past 1000 signatures of the 1DEV account with the before-cursor and finds a burn on the second page', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => plain(i, 600_000_000 - i));
    const foreign = burnAt(5000, 599_000_000, {
      mutate: (t) => { t.transaction.message.accountKeys.unshift({ pubkey: OTHER, signer: true, writable: true }); },
      memo: '[20] QNET_NODE_TYPE:LIGHT',
    });
    const real = burnAt(5001, 503_002_048);
    const page2 = [foreign.entry, ...Array.from({ length: 298 }, (_, i) => plain(2000 + i, 580_000_000 - i)), real.entry];
    const { call, calls } = historyRpc([...page1, ...page2], txsOf(foreign, real));
    const result = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0 });
    const listings = calls.filter((c) => c.method === 'getSignaturesForAddress');
    assert.equal(listings.length, 2);
    assert.equal(listings[0].params[1].limit, 1000);
    assert.equal(listings[0].params[1].before, undefined);
    assert.equal(listings[1].params[1].before, page1[999].signature);
    assert.equal(result.listingComplete, true);
    assert.equal(result.complete, true);
    assert.equal(result.exhausted, false);
    assert.deepEqual(result.burns.map((b) => b.signature), [real.entry.signature]);
    assert.deepEqual(result.canonical, {
      signature: real.entry.signature, nodeType: 'light', amount: 1500, slot: 503_002_048, blockTime: real.tx.blockTime, finalized: true,
    });
    assert.deepEqual(result.inFlight, []);
  });

  it('with the confirmed page, names a valid burn that has not finalized yet as in flight (EXT-CHAINS-03)', async () => {
    const final = burnAt(40, 505_000_000);
    const young = burnAt(41, 506_000_000);
    young.entry.confirmationStatus = 'confirmed';
    const { call } = historyRpc([final.entry], txsOf(final), { recent: [young.entry, final.entry], confirmedTxs: txsOf(young) });
    const result = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0, confirmed: true });
    assert.deepEqual(result.burns.map((b) => [b.signature, b.finalized]), [[final.entry.signature, true]]);
    assert.deepEqual(result.inFlight.map((b) => [b.signature, b.finalized]), [[young.entry.signature, false]]);
    assert.equal(result.canonical.signature, final.entry.signature, 'only a finalized burn is ever the code');
    const without = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0 });
    assert.deepEqual(without.inFlight, [], 'nothing in flight is looked up unless asked');
  });

  it('several valid burns: the OLDEST is canonical; inside one slot the later listed is the older (R2-ESA-03)', async () => {
    const newest = burnAt(1, 510_000_000);
    // one slot, listed [sameSlotNewer, sameSlotOlder]: the listing runs newest first
    const sameSlotNewer = burnAt(2, 505_000_000, { index: 2 });
    const sameSlotOlder = burnAt(3, 505_000_000, { index: 9, mutate: (t) => { memoIx(t).parsed = 'QNET_NODE_TYPE:SUPER'; } });
    const { call } = historyRpc([newest.entry, sameSlotNewer.entry, sameSlotOlder.entry], txsOf(newest, sameSlotNewer, sameSlotOlder));
    const result = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0 });
    assert.deepEqual(result.burns.map((b) => b.signature),
      [sameSlotOlder.entry.signature, sameSlotNewer.entry.signature, newest.entry.signature], 'transactionIndex is not used');
    assert.equal(result.canonical.signature, sameSlotOlder.entry.signature);
    assert.equal(result.canonical.nodeType, 'super');
  });

  // XP-R4-05: the shared burnOrder vectors (docs/protocols/qnet-link-v1.vectors.json) through the real search, not a
  // copy of its sort: every entry a valid burn, listed in the vector's pages, in one call and resumed page by page.
  it('orders burns as the shared burnOrder vectors say, in one call and across resumed calls (XP-R4-05)', async () => {
    const vectors = JSON.parse(readFileSync(path.join(HERE, '../../../docs/protocols/qnet-link-v1.vectors.json'), 'utf8'));
    assert.ok(vectors.burnOrder.cases.length >= 4);
    for (const { name, pages, oldestFirst } of vectors.burnOrder.cases) {
      const burns = pages.flat().map(({ signature, slot }) => {
        const tx = variant((t) => {
          t.transaction.signatures = [signature];
          t.slot = slot;
          t.blockTime = 1790000000 + slot;
        });
        return {
          entry: { signature, slot, err: null, memo: '[20] QNET_NODE_TYPE:LIGHT', blockTime: tx.blockTime, confirmationStatus: 'finalized' },
          tx,
        };
      });
      const pageSize = pages[0].length;
      assert.ok(pages.slice(0, -1).every((page) => page.length === pageSize), `${name}: the vector's pages are full pages`);
      const { call } = historyRpc(burns.map((b) => b.entry), txsOf(...burns));
      const once = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0, pageSize });
      assert.deepEqual(once.burns.map((b) => b.signature), oldestFirst, name);
      assert.equal(once.canonical.signature, oldestFirst[0], name);
      // one page of the history per call (a resumed call first lists the range above its kept head), kept between calls:
      // the places still count across the pages
      const store = memoryStore();
      let resumed = null;
      let rounds = 0;
      for (; rounds <= pages.length + 1 && !resumed?.complete; rounds++) {
        resumed = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0, pageSize, store, maxPages: rounds === 0 ? 1 : 2 });
      }
      assert.ok(rounds >= 2, `${name}: resumed at least once`);
      assert.equal(resumed.complete, true, name);
      assert.deepEqual(resumed.burns.map((b) => b.signature), oldestFirst, `${name}, resumed`);
      assert.equal(resumed.canonical.signature, oldestFirst[0], `${name}, resumed`);
    }
    await rejectsWith(solana.findWalletBurns(BURNER, { rpc: historyRpc([], {}).call, pageSize: LIMITS.BURN_SCAN_PAGE_SIZE + 1 }), 'INTERNAL');
  });

  it('only fetches memo-tagged successful entries, and ignores poisoned candidates', async () => {
    const wrongMint = burnAt(10, 520_000_000, { mutate: (t) => { burnIx(t).parsed.info.mint = OTHER; } });
    const fractional = burnAt(11, 519_000_000, { mutate: (t) => { burnIx(t).parsed.info.amount = '1500000500'; } });
    const failedEntry = { ...burnAt(12, 518_000_000).entry, err: { InstructionError: [0, 'Custom'] } };
    const untagged = { ...burnAt(13, 517_000_000).entry, memo: null };
    const { call, calls } = historyRpc([wrongMint.entry, fractional.entry, failedEntry, untagged], txsOf(wrongMint, fractional));
    const result = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0 });
    assert.deepEqual(result.burns, []);
    assert.equal(result.canonical, null);
    assert.equal(result.complete, true);
    assert.equal(calls.filter((c) => c.method === 'getTransaction').length, 2);
  });

  // R4-ESA-01: a Full-node burn yields no code, but it is the wallet's burn: kept apart as `unusable`, in
  // the kept search too, never dropped as "not a burn"; a foreign one is still ignored.
  it('keeps the wallet\'s own burns no code derives from apart, finalized and in flight (R4-ESA-01)', async () => {
    const full = burnAt(60, 540_000_000, { mutate: (t) => { memoIx(t).parsed = 'QNET_NODE_TYPE:FULL'; }, memo: '[19] QNET_NODE_TYPE:FULL' });
    const foreignFull = burnAt(61, 541_000_000, {
      mutate: (t) => {
        memoIx(t).parsed = 'QNET_NODE_TYPE:FULL';
        t.transaction.message.accountKeys.unshift({ pubkey: OTHER, signer: true, writable: true });
      },
      memo: '[19] QNET_NODE_TYPE:FULL',
    });
    const young = burnAt(62, 542_000_000, { mutate: (t) => { memoIx(t).parsed = 'QNET_NODE_TYPE:FULL'; }, memo: '[19] QNET_NODE_TYPE:FULL' });
    young.entry.confirmationStatus = 'confirmed';
    const { call } = historyRpc([foreignFull.entry, full.entry], txsOf(full, foreignFull),
      { recent: [young.entry, foreignFull.entry, full.entry], confirmedTxs: txsOf(young) });
    const store = memoryStore();
    const result = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0, store, confirmed: true });
    assert.deepEqual(result.burns, []);
    assert.equal(result.canonical, null);
    assert.equal(result.complete, true);
    assert.deepEqual(result.unusable.map((b) => [b.signature, b.finalized]), [[full.entry.signature, true], [young.entry.signature, false]]);
    // resumed from the kept search: still there
    const again = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0, store });
    assert.deepEqual(again.unusable.map((b) => b.signature), [full.entry.signature]);
  });

  it('a listed transaction the RPC cannot serve is an error, never "no burn"', async () => {
    const b = burnAt(20, 530_000_000);
    const { call } = historyRpc([b.entry], {});
    await rejectsWith(solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0 }), 'SOLANA_UNAVAILABLE');
  });

  it('an unreadable listing is an error', async () => {
    const call = async (method) => (method === 'getTokenSupply' ? { value: { decimals: 6 } } : { not: 'a list' });
    await rejectsWith(solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0 }), 'SOLANA_UNAVAILABLE');
  });

  it('stops when the mint does not report 6 decimals', async () => {
    const { call } = historyRpc([], {}, { decimals: 9 });
    await rejectsWith(solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0 }), 'SOLANA_UNAVAILABLE');
  });

  it('no fixed candidate cap: 60 poisoned mentions and then a burn still give the burn and a complete answer (R2-ESA-01)', async () => {
    const spam = Array.from({ length: 60 }, (_, i) => burnAt(300 + i, 550_000_000 - i * 10, {
      mutate: (t) => { t.transaction.message.accountKeys[0].pubkey = OTHER; },
    }));
    const own = burnAt(999, 560_000_000);
    const { call } = historyRpc([own.entry, ...spam.map((b) => b.entry)], txsOf(own, ...spam));
    const result = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0 });
    assert.equal(result.complete, true);
    assert.deepEqual(result.burns.map((b) => b.signature), [own.entry.signature]);
    assert.equal(result.canonical.signature, own.entry.signature);
  });

  it('a history longer than one call\'s budget says so (exhausted) and the next call resumes from what was kept', async () => {
    const b = burnAt(99_999, 540_000_000);
    const entries = [...Array.from({ length: 2500 }, (_, i) => plain(100_000 + i, 700_000_000 - i)), b.entry];
    const { call, calls } = historyRpc(entries, txsOf(b));
    const store = memoryStore();
    const first = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0, store, maxPages: 2 });
    assert.equal(first.exhausted, true);
    assert.equal(first.canonical, null);
    assert.equal(first.complete, false);
    assert.ok(store.saves > 0);
    const listed = calls.filter((c) => c.method === 'getSignaturesForAddress').length;
    const second = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0, store, maxPages: 2 });
    const resumed = calls.filter((c) => c.method === 'getSignaturesForAddress').slice(listed);
    assert.equal(resumed[0].params[1].until, entries[0].signature, 'first what is new above the kept head');
    assert.equal(resumed[1].params[1].before, entries[1999].signature, 'then on below the kept tail');
    assert.equal(second.exhausted, false);
    assert.equal(second.complete, true);
    assert.equal(second.canonical.signature, b.entry.signature);
  });

  it('the kept search takes in what is new above its head, and the same-slot order holds across calls (R2-ESA-03)', async () => {
    const older = burnAt(1, 600_000_000);
    const entries = [plain(1, 600_000_010), older.entry];
    const { call } = historyRpc(entries, txsOf(older));
    const store = memoryStore();
    const first = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0, store });
    assert.equal(first.canonical.signature, older.entry.signature);
    // two burns land in one later slot: listed newest first [a, b], so b executed first
    const a = burnAt(2, 600_000_500);
    const b2 = burnAt(3, 600_000_500);
    entries.unshift(a.entry, b2.entry);
    const later = historyRpc(entries, txsOf(older, a, b2));
    const second = await solana.findWalletBurns(BURNER, { rpc: later.call, spacingMs: 0, store });
    assert.deepEqual(second.burns.map((x) => x.signature), [older.entry.signature, b2.entry.signature, a.entry.signature]);
    const fresh = await solana.findWalletBurns(BURNER, { rpc: later.call, spacingMs: 0 });
    assert.deepEqual(fresh.burns.map((x) => x.signature), second.burns.map((x) => x.signature), 'a fresh search orders them alike');
    assert.equal(later.calls.filter((c) => c.method === 'getTransaction').length, 2 + 3, 'the resumed search checked only the new ones');
  });

  it('a kept search of another owner or of a malformed shape is ignored', async () => {
    const b = burnAt(7, 500_000_000);
    const { call } = historyRpc([b.entry], txsOf(b));
    const store = memoryStore();
    store.value = { v: 1, owner: OTHER, mint: SOLANA.ONE_DEV_MINT, ata: BURNER_ATA, head: null, tail: null, reachedStart: true,
      headSeq: 0, tailSeq: 0, unchecked: [], found: [] };
    const result = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0, store });
    assert.equal(result.canonical.signature, b.entry.signature);
    store.value = { ...store.value, owner: BURNER, found: [{ signature: 'x', slot: 'bad' }] };
    assert.equal((await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0, store })).canonical.signature, b.entry.signature);
  });

  it('refuses an invalid owner', async () => {
    await rejectsWith(solana.findWalletBurns('not-an-address', { rpc: async () => [] }), 'INVALID_ADDRESS');
  });

  // R3-ESA-01: pages of 999 tagged mentions and 1 untagged one; the listing pauses mid-page at the cap, so a kept
  // search is never longer than the cap (which a resumed call would refuse and start over), and resumed calls
  // with a budget of a few hundred checks go on and finally complete.
  it('the listing pauses mid-page at the candidate cap, and resumed calls make progress and complete (R3-ESA-01)', async () => {
    const entries = [];
    const txs = {};
    for (let p = 0; p < 5; p++) {
      for (let i = 0; i < 1000; i++) {
        const n = 10_000 + p * 1000 + i;
        const slot = 800_000_000 - n;
        if (i === 999) {
          entries.push(plain(n, slot));
          continue;
        }
        // an ordinary wallet's transaction that mentions the account and carries the memo: not a burn
        const spam = burnAt(n, slot, { mutate: (t) => { t.transaction.message.accountKeys[0].pubkey = OTHER; } });
        entries.push(spam.entry);
        txs[spam.entry.signature] = spam.tx;
      }
    }
    const own = burnAt(99_000, 700_000_000);
    entries.push(own.entry);
    txs[own.entry.signature] = own.tx;
    const { call } = historyRpc(entries, txs);
    const store = memoryStore();
    // each call checks at most 600 candidates before its deadline
    let clock = 0;
    const now = () => clock;
    const counting = async (method, params) => {
      if (method === 'getTransaction') clock += 150;
      return call(method, params);
    };
    let result = null;
    let calls = 0;
    const lengths = [];
    do {
      calls += 1;
      clock = 0;
      result = await solana.findWalletBurns(BURNER, { rpc: counting, now, spacingMs: 0, store, deadlineMs: 90_000 });
      lengths.push(store.value.unchecked.length);
      assert.ok(store.value.unchecked.length <= 4000, `kept ${store.value.unchecked.length} candidates`);
    } while (!result.complete && calls < 20);
    assert.equal(result.complete, true, `calls ${calls}, kept ${lengths.join(',')}`);
    assert.ok(calls > 2, 'the budget split the work over several calls');
    assert.equal(result.canonical.signature, own.entry.signature);
  });

  // R3-ESA-02: a kept search, then more new signatures above its head than one call can list: the range resumes
  // where it stopped instead of starting again from the newest signature, and the head moves once it is listed.
  it('a range above the kept head longer than one call resumes across calls and completes (R3-ESA-02)', async () => {
    const older = burnAt(1, 600_000_000);
    const entries = [plain(1, 600_000_010), older.entry];
    const first = historyRpc(entries, txsOf(older));
    const store = memoryStore();
    assert.equal((await solana.findWalletBurns(BURNER, { rpc: first.call, spacingMs: 0, store })).canonical.signature, older.entry.signature);
    const head = store.value.head;
    // 3,500 new signatures above the head, a burn among the oldest of them
    const newer = burnAt(2, 650_000_000);
    const flood = Array.from({ length: 3500 }, (_, i) => plain(50_000 + i, 700_000_000 - i));
    const later = historyRpc([...flood, newer.entry, ...entries], txsOf(older, newer));
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await solana.findWalletBurns(BURNER, { rpc: later.call, spacingMs: 0, store, maxPages: 2 }));
    }
    const listings = later.calls.filter((c) => c.method === 'getSignaturesForAddress').map((c) => c.params[1]);
    assert.equal(listings[0].until, head);
    assert.equal(listings[0].before, undefined, 'the first call starts the range at the newest signature');
    assert.equal(listings[2].until, head);
    assert.equal(listings[2].before, flood[1999].signature, 'the second call goes on below what the first listed');
    assert.equal(results[0].listingComplete, false);
    assert.equal(results[0].canonical.signature, older.entry.signature, 'a burn below the head stays canonical meanwhile');
    assert.equal(results[1].listingComplete, true);
    assert.equal(results[1].complete, true);
    assert.equal(store.value.head, flood[0].signature, 'the head moved to the range\'s top once it reached the old head');
    assert.deepEqual(results[1].burns.map((b) => b.signature), [older.entry.signature, newer.entry.signature]);
  });

  it('a burn inside an open range above the head is never canonical (R3-ESA-02)', async () => {
    const entries = [plain(1, 600_000_010)];
    const first = historyRpc(entries, {});
    const store = memoryStore();
    assert.equal((await solana.findWalletBurns(BURNER, { rpc: first.call, spacingMs: 0, store })).complete, true);
    // the range: a new burn listed first, then 2,000 entries above the head the budget does not reach
    const young = burnAt(3, 650_000_000);
    const flood = Array.from({ length: 2500 }, (_, i) => plain(60_000 + i, 640_000_000 - i));
    const later = historyRpc([young.entry, ...flood, ...entries], txsOf(young));
    const result = await solana.findWalletBurns(BURNER, { rpc: later.call, spacingMs: 0, store, maxPages: 1 });
    assert.deepEqual(result.burns.map((b) => b.signature), [young.entry.signature]);
    assert.equal(result.canonical, null, 'an older burn may still lie in the unlisted part of the range');
    assert.equal(result.listingComplete, false);
    assert.equal(result.exhausted, true);
  });

  // R3-ESA-03 / XP-R3-01 / R3-XPD-05: the in-flight check pages the confirmed listing down to the kept head and
  // counts a burn that finalized after the finalized snapshot was listed; one it cannot reach fails closed.
  it('a burn that finalized between the finalized listing and the confirmed check is in flight (R3-ESA-03)', async () => {
    const b = burnAt(80, 900_000_000);
    const { call } = historyRpc([], {}, { recent: [b.entry], confirmedTxs: txsOf(b) });
    const result = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0, confirmed: true });
    assert.equal(result.complete, true);
    assert.deepEqual(result.burns, []);
    assert.deepEqual(result.inFlight.map((x) => x.signature), [b.entry.signature], 'finalized, not in the snapshot: in flight');
  });

  it('a burn in flight below 1000 newer confirmed entries is found, and a check that cannot reach the head fails closed (R3-ESA-03)', async () => {
    const final = burnAt(90, 800_000_000);
    const young = burnAt(91, 900_000_000);
    young.entry.confirmationStatus = 'confirmed';
    const newer = Array.from({ length: 1500 }, (_, i) => plain(70_000 + i, 950_000_000 - i));
    const recent = [...newer, young.entry, final.entry];
    const { call, calls } = historyRpc([final.entry], txsOf(final), { recent, confirmedTxs: txsOf(young) });
    const result = await solana.findWalletBurns(BURNER, { rpc: call, spacingMs: 0, confirmed: true });
    assert.deepEqual(result.inFlight.map((x) => x.signature), [young.entry.signature]);
    assert.equal(calls.filter((c) => c.method === 'getSignaturesForAddress' && c.params[1].commitment === 'confirmed').length, 2);
    // the head is never reached within the page cap: no answer rather than "nothing in flight"
    const endless = historyRpc([final.entry], txsOf(final), {
      recent: [...Array.from({ length: 3000 }, (_, i) => plain(80_000 + i, 990_000_000 - i)), final.entry],
    });
    await rejectsWith(solana.findWalletBurns(BURNER, { rpc: endless.call, spacingMs: 0, confirmed: true, inFlightMaxPages: 2 }), 'SOLANA_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------- RPC and flows

const rpcOk = (id, result) => ({ body: { jsonrpc: '2.0', id, result } });

describe('chains-activation solana: rpc', () => {
  it('posts JSON-RPC 2.0 to the cluster URL only, without credentials or redirects', async () => {
    const requests = installFetch(async (r) => rpcOk(1, 42));
    assert.equal(await solana.rpc('getSlot', []), 42);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, SOLANA.RPC_URLS[0]);
    assert.equal(requests[0].init.credentials, 'omit');
    assert.equal(requests[0].init.redirect, 'error');
    assert.deepEqual(JSON.parse(requests[0].body), { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] });
  });

  it('retries 429/5xx and transient JSON-RPC errors, then answers', async () => {
    const answers = [{ status: 503, body: 'busy' }, { status: 429, body: '' }, { body: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'behind' } } }, rpcOk(1, 'ok')];
    installFetch(async () => answers.shift());
    assert.equal(await solana.rpc('getSlot', [], { attempts: 4, backoffMs: 1 }), 'ok');
  });

  it('a request error is final and carries its JSON-RPC code; exhausted retries are SOLANA_UNAVAILABLE', async () => {
    installFetch(async () => ({ body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } } }));
    await assert.rejects(solana.rpc('getSlot', [], { backoffMs: 1 }), (e) => e.code === 'SOLANA_UNAVAILABLE' && e.rpcCode === -32602);
    installFetch(async () => {
      throw new TypeError('network down');
    });
    await rejectsWith(solana.rpc('getSlot', [], { backoffMs: 1 }), 'SOLANA_UNAVAILABLE');
    installFetch(async () => ({ status: 200, body: 'not json' }));
    await rejectsWith(solana.rpc('getSlot', [], { backoffMs: 1 }), 'SOLANA_UNAVAILABLE');
  });
});

// A devnet with the KAT wallet: balances, blockhash, fees, rent, accounts, and a send pipeline.
function devnet({ lamports = 50_000_000, oneDev = '5000000000', decimals = 6, accounts = {}, status = 'confirmed' } = {}) {
  const owner = WALLET.solanaAddress;
  const ata = core.associatedTokenAddress(owner, MINT);
  const tokenAccountValue = (holder, amount) => ({
    owner: TOKEN, lamports: 2039280, executable: false,
    data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { mint: MINT, owner: holder, state: 'initialized', tokenAmount: { amount, decimals: 6 } } } },
  });
  const book = { [ata]: oneDev === null ? null : tokenAccountValue(owner, oneDev), ...accounts };
  const seen = { simulated: [], sent: [] };
  const methods = {
    getBalance: ([address]) => ({ context: { slot: 1 }, value: address === owner ? lamports : 0 }),
    getTokenSupply: () => ({ context: { slot: 1 }, value: { amount: '1', decimals } }),
    getAccountInfo: ([address]) => ({ context: { slot: 1 }, value: Object.hasOwn(book, address) ? book[address] : null }),
    getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }),
    getFeeForMessage: () => ({ context: { slot: 1 }, value: 5000 }),
    getMinimumBalanceForRentExemption: ([space]) => (space === 165 ? 2039280 : 0),
    simulateTransaction: ([b64, options]) => {
      seen.simulated.push({ b64, options });
      return { context: { slot: 1 }, value: { err: null, logs: [] } };
    },
    sendTransaction: ([b64, options]) => {
      seen.sent.push({ b64, options });
      return core.base58Encode(core.base64Decode(b64).slice(1, 65));
    },
    getSignatureStatuses: () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: status }] }),
  };
  return { methods, seen, owner, ata, tokenAccountValue };
}

describe('chains-activation solana: balances', () => {
  it('refuses a mint that does not report 6 decimals', async () => {
    installEnv();
    installFetch(solanaRoute(devnet({ decimals: 9 }).methods));
    await rejectsWith(solana.getBalances(), 'SOLANA_UNAVAILABLE');
  });

  it('reads SOL and 1DEV of the session address at finalized commitment', async () => {
    installEnv();
    const net = devnet();
    const requests = installFetch(solanaRoute(net.methods));
    assert.deepEqual(await solana.getBalances(), {
      address: net.owner, lamports: '50000000', oneDev: { mint: MINT, ata: net.ata, exists: true, raw: '5000000000', decimals: 6 },
    });
    for (const r of requests) {
      const { method, params } = JSON.parse(r.body);
      if (method !== 'getTokenSupply') assert.equal(params[1].commitment, 'finalized', method);
    }
  });

  it('a missing token account reads as zero; a foreign account at the ATA address is refused', async () => {
    installEnv();
    installFetch(solanaRoute(devnet({ oneDev: null }).methods));
    assert.deepEqual((await solana.getBalances()).oneDev.exists, false);
    const net = devnet();
    const hijacked = net.tokenAccountValue(OTHER, '1');
    installFetch(solanaRoute(devnet({ accounts: { [net.ata]: hijacked } }).methods));
    await rejectsWith(solana.getBalances(), 'SOLANA_UNAVAILABLE');
  });

  it('refuses while locked', async () => {
    installEnv({ locked: true });
    await rejectsWith(solana.getBalances(), 'LOCKED');
  });
});

describe('chains-activation solana: quote and send', () => {
  it('SOL: quote, then a send simulated with sigVerify that sends exactly the simulated bytes', async () => {
    installEnv();
    const net = devnet();
    installFetch(solanaRoute(net.methods));
    const q = await solana.quote({ asset: 'sol', to: OTHER, amount: '0.01' });
    assert.deepEqual(q, {
      asset: 'sol', to: OTHER, mint: null, decimals: 9, amountRaw: '10000000', feeLamports: '5000', createsRecipientAccount: false,
      rentLamports: '0', totalLamports: '10005000', balanceLamports: '50000000', tokenRaw: null, rentFloorLamports: '0', shortfall: null,
      references: [], memo: null, recipient: { known: false, lookalike: false },
    });
    const result = await solana.send({ asset: 'sol', to: OTHER, amount: '0.01', expectedFeeLamports: '5000', expectedRentLamports: '0' });
    assert.equal(net.seen.simulated.length, 1);
    assert.equal(net.seen.simulated[0].options.sigVerify, true);
    assert.equal(net.seen.simulated[0].options.replaceRecentBlockhash, false);
    assert.equal(net.seen.sent.length, 1);
    assert.equal(net.seen.sent[0].b64, net.seen.simulated[0].b64);
    assert.equal(net.seen.sent[0].options.skipPreflight, false);
    const tx = decodeWire(core.base64Decode(net.seen.sent[0].b64));
    assert.equal(core.verifySolanaSignature(tx.signatures[0], tx.message, WALLET.solanaPublicKey), true);
    assert.deepEqual([...tx.instructions[0].data], [2, 0, 0, 0, ...le64(10_000_000n)]);
    assert.deepEqual(result, { signature: core.base58Encode(tx.signatures[0]), status: 'confirmed', lastValidBlockHeight: 100 });
  });

  it('1DEV to a wallet without a token account: CreateIdempotent + TransferChecked, rent in the quote', async () => {
    installEnv();
    const net = devnet();
    installFetch(solanaRoute(net.methods));
    const q = await solana.quote({ asset: '1dev', to: OTHER, amount: '2.5' });
    assert.deepEqual(q, {
      asset: '1dev', to: OTHER, mint: MINT, decimals: 6, amountRaw: '2500000', feeLamports: '5000', createsRecipientAccount: true,
      rentLamports: '2039280', totalLamports: '2044280', balanceLamports: '50000000', tokenRaw: '5000000000', rentFloorLamports: '0',
      shortfall: null, references: [], memo: null, recipient: { known: false, lookalike: false },
    });
    await solana.send({ asset: '1dev', to: OTHER, amount: '2.5', expectedFeeLamports: '5000', expectedRentLamports: '2039280' });
    const tx = decodeWire(core.base64Decode(net.seen.sent[0].b64));
    assert.deepEqual(tx.instructions.map((ix) => ix.program), [ASSOCIATED_TOKEN, TOKEN]);
    const destination = core.associatedTokenAddress(OTHER, MINT);
    assert.deepEqual(tx.instructions[1].accounts, [net.ata, MINT, destination, net.owner]);
    assert.deepEqual([...tx.instructions[1].data], [12, ...le64(2_500_000n), 6]);
  });

  it('refuses a changed fee or rent, a token account as recipient, and missing funds', async () => {
    installEnv();
    const net = devnet({ lamports: 6000 });
    const recipientAta = core.associatedTokenAddress(OTHER, MINT);
    installFetch(solanaRoute(net.methods));
    await rejectsWith(solana.send({ asset: 'sol', to: OTHER, amount: '1', expectedFeeLamports: '4999', expectedRentLamports: '0' }), 'FEE_CHANGED');
    await rejectsWith(solana.send({ asset: '1dev', to: OTHER, amount: '1', expectedFeeLamports: '5000', expectedRentLamports: '0' }), 'FEE_CHANGED');
    await rejectsWith(solana.send({ asset: 'sol', to: OTHER, amount: '1', expectedFeeLamports: '5000', expectedRentLamports: '0' }), 'INSUFFICIENT_SOL');
    installFetch(solanaRoute(devnet({ accounts: { [recipientAta]: net.tokenAccountValue(OTHER, '0') } }).methods));
    await rejectsWith(solana.quote({ asset: '1dev', to: recipientAta, amount: '1' }), 'INVALID_ADDRESS');
    await rejectsWith(solana.quote({ asset: 'sol', to: recipientAta, amount: '1' }), 'INVALID_ADDRESS');
    installFetch(solanaRoute(devnet({ oneDev: '999999' }).methods));
    await rejectsWith(solana.send({ asset: '1dev', to: OTHER, amount: '1', expectedFeeLamports: '5000', expectedRentLamports: '2039280' }), 'INSUFFICIENT_TOKENS');
    await rejectsWith(solana.quote({ asset: '1dev', to: OTHER, amount: '0.0000001' }), 'INVALID_AMOUNT');
    await rejectsWith(solana.quote({ asset: 'sol', to: OTHER, amount: '0' }), 'INVALID_AMOUNT');
  });

  it('1DEV never goes to a program address, not even a system-owned one (EXT-CHAINS-05)', async () => {
    installEnv();
    // a program's SOL vault: system-owned, off the curve, so no key can ever sign for its token account
    const { address } = core.findProgramAddress([core.utf8Encode('vault')], core.solanaAddressToBytes(ASSOCIATED_TOKEN));
    const pda = core.base58Encode(address);
    assert.equal(core.isOnEd25519Curve(address), false);
    const systemAccount = { owner: '11111111111111111111111111111111', lamports: 5_000_000, executable: false, data: ['', 'base64'] };
    for (const accounts of [{ [pda]: systemAccount }, {}]) {
      installFetch(solanaRoute(devnet({ accounts }).methods));
      await rejectsWith(solana.quote({ asset: '1dev', to: pda, amount: '1' }), 'INVALID_ADDRESS');
      await rejectsWith(solana.send({ asset: '1dev', to: pda, amount: '1', expectedFeeLamports: '5000', expectedRentLamports: '2039280' }),
        'INVALID_ADDRESS');
    }
    // a wallet (on the curve) still receives 1DEV, and SOL may still go to a program's vault
    installFetch(solanaRoute(devnet({ accounts: { [pda]: systemAccount } }).methods));
    assert.equal((await solana.quote({ asset: '1dev', to: OTHER, amount: '1' })).to, OTHER);
    assert.equal((await solana.quote({ asset: 'sol', to: pda, amount: '0.01' })).to, pda);
  });

  // R3-EXT-UI-03: the Solana side of the address-poisoning defence: the addresses this wallet signed SOL or 1DEV
  // transfers to are kept in the vault, and the quote names a first-time recipient and a look-alike of a known one.
  it('names a first-time Solana recipient and a look-alike of one this wallet paid (R3-EXT-UI-03)', async () => {
    const env = installEnv();
    const net = devnet();
    installFetch(solanaRoute(net.methods));
    assert.deepEqual((await solana.quote({ asset: 'sol', to: OTHER, amount: '0.01' })).recipient, { known: false, lookalike: false });
    await solana.send({ asset: 'sol', to: OTHER, amount: '0.01', expectedFeeLamports: '5000', expectedRentLamports: '0' });
    assert.deepEqual(env.state().solanaRecipients, [OTHER], 'the recipient the user signed for is kept');
    assert.deepEqual((await solana.quote({ asset: 'sol', to: OTHER, amount: '0.01' })).recipient, { known: true, lookalike: false });
    // a vanity address with the same first and last four characters as OTHER
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let lookalike = null;
    for (let i = 8; i < OTHER.length - 8 && lookalike === null; i += 1) {
      for (const c of alphabet) {
        const candidate = `${OTHER.slice(0, i)}${c}${OTHER.slice(i + 1)}`;
        if (candidate !== OTHER && core.isValidSolanaAddress(candidate)) {
          lookalike = candidate;
          break;
        }
      }
    }
    assert.ok(lookalike);
    assert.deepEqual((await solana.quote({ asset: 'sol', to: lookalike, amount: '0.01' })).recipient, { known: false, lookalike: true });
    // a transfer to the wallet itself adds nothing
    await solana.send({ asset: 'sol', to: WALLET.solanaAddress, amount: '0.01', expectedFeeLamports: '5000', expectedRentLamports: '0' });
    assert.deepEqual(env.state().solanaRecipients, [OTHER]);
  });

  it('a failed simulation sends nothing', async () => {
    installEnv();
    const net = devnet();
    net.methods.simulateTransaction = () => ({ context: { slot: 1 }, value: { err: { InstructionError: [0, 'Custom'] } } });
    installFetch(solanaRoute(net.methods));
    await rejectsWith(solana.send({ asset: 'sol', to: OTHER, amount: '0.01', expectedFeeLamports: '5000', expectedRentLamports: '0' }), 'SIMULATION_FAILED');
    assert.equal(net.seen.sent.length, 0);
  });
});

describe('chains-activation solana: sendAndConfirm', () => {
  const signed = async () => {
    installEnv();
    return solana.buildBurnTransaction({ nodeType: 'light', amountWhole: 1500, recentBlockhash: BLOCKHASH });
  };

  it('waits for the requested commitment', async () => {
    const { transaction, signature } = await signed();
    const statuses = ['processed', 'confirmed', 'finalized'];
    const net = devnet();
    net.methods.getSignatureStatuses = ([sigs]) => {
      assert.deepEqual(sigs, [signature]);
      return { context: { slot: 1 }, value: [{ err: null, confirmationStatus: statuses.shift() ?? 'finalized' }] };
    };
    installFetch(solanaRoute(net.methods));
    const started = Date.now();
    assert.deepEqual(await solana.sendAndConfirm(transaction, { commitment: 'confirmed', timeoutMs: 10000 }), { signature, status: 'confirmed' });
    assert.ok(Date.now() - started < 5000);
  });

  it('a preflight refusal the chain never saw is SIMULATION_FAILED; an on-chain error is TX_FAILED', async () => {
    const { transaction } = await signed();
    const net = devnet();
    net.methods.sendTransaction = () => ({ rpcError: { code: -32002, message: 'Transaction simulation failed' } });
    net.methods.getSignatureStatuses = () => ({ context: { slot: 1 }, value: [null] });
    installFetch(solanaRoute(net.methods));
    await rejectsWith(solana.sendAndConfirm(transaction, { timeoutMs: 1000 }), 'SIMULATION_FAILED');
    const failing = devnet();
    failing.methods.getSignatureStatuses = () => ({ context: { slot: 1 }, value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] });
    installFetch(solanaRoute(failing.methods));
    await rejectsWith(solana.sendAndConfirm(transaction, { timeoutMs: 1000 }), 'TX_FAILED');
  });

  it('"already processed" after a lost reply is not a refusal', async () => {
    const { transaction, signature } = await signed();
    const net = devnet({ status: 'finalized' });
    net.methods.sendTransaction = () => ({ rpcError: { code: -32002, message: 'AlreadyProcessed' } });
    installFetch(solanaRoute(net.methods));
    assert.deepEqual(await solana.sendAndConfirm(transaction, { timeoutMs: 1000 }), { signature, status: 'finalized' });
  });

  it('a refusal after an attempt whose answer was lost is uncertain: polled, never "cannot land"', async () => {
    const { transaction, signature } = await signed();
    const net = devnet();
    let sends = 0;
    net.methods.getSignatureStatuses = () => ({ context: { slot: 1 }, value: [null] });
    installFetch(routes(async (r) => {
      if (JSON.parse(r.body).method !== 'sendTransaction') return undefined;
      sends++;
      if (sends === 1) throw new TypeError('connection reset');
      return { body: { jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Transaction simulation failed: AlreadyProcessed' } } };
    }, solanaRoute(net.methods)));
    assert.deepEqual(await solana.sendAndConfirm(transaction, { timeoutMs: 50 }), { signature, status: 'pending' });
    assert.equal(sends, 2);
  });

  it('a send nobody answered is polled, and ends pending at the deadline', async () => {
    const { transaction, signature } = await signed();
    const net = devnet();
    net.methods.getSignatureStatuses = () => ({ context: { slot: 1 }, value: [null] });
    installFetch(routes(async (r) => {
      if (JSON.parse(r.body).method === 'sendTransaction') throw new TypeError('connection reset');
      return undefined;
    }, solanaRoute(net.methods)));
    assert.deepEqual(await solana.sendAndConfirm(transaction, { timeoutMs: 50 }), { signature, status: 'pending' });
  });

  it('signatureStatus maps the ledger status', async () => {
    const net = devnet();
    const answers = [null, { err: { x: 1 }, confirmationStatus: 'finalized' }, { err: null, confirmationStatus: 'finalized' }, { err: null, confirmationStatus: 'processed' }];
    net.methods.getSignatureStatuses = ([, options]) => {
      assert.equal(options.searchTransactionHistory, true);
      return { context: { slot: 1 }, value: [answers.shift()] };
    };
    installFetch(solanaRoute(net.methods));
    const sig = WIRE.signature;
    assert.equal(await solana.signatureStatus(sig), 'unknown');
    assert.equal(await solana.signatureStatus(sig), 'failed');
    assert.equal(await solana.signatureStatus(sig), 'finalized');
    assert.equal(await solana.signatureStatus(sig), 'processed');
    await rejectsWith(solana.signatureStatus('nope'), 'INVALID_BURN_TX');
  });

  // XP-R3-04 (as mobile MOBLINK-R2-01): an error at 'processed' may come from a fork that is dropped while the
  // same transaction lands on the chain that wins; only an error at confirmed or finalized is a failure.
  it('an error at processed is not a failure: polled on, and the status reads processed (XP-R3-04)', async () => {
    const { transaction, signature } = await signed();
    const net = devnet();
    const answers = [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' }, { err: null, confirmationStatus: 'finalized' }];
    net.methods.getSignatureStatuses = () => ({ context: { slot: 1 }, value: [answers.length > 1 ? answers.shift() : answers[0]] });
    installFetch(solanaRoute(net.methods));
    assert.deepEqual(await solana.sendAndConfirm(transaction, { timeoutMs: 10000 }), { signature, status: 'finalized' });
    const ledger = devnet();
    ledger.methods.getSignatureStatuses = () => ({ context: { slot: 1 }, value: [{ err: { x: 1 }, confirmationStatus: 'processed' }] });
    installFetch(solanaRoute(ledger.methods));
    assert.equal(await solana.signatureStatus(WIRE.signature), 'processed');
    assert.deepEqual(await solana.sendAndConfirm(transaction, { timeoutMs: 50 }), { signature, status: 'pending' }, 'never TX_FAILED');
  });
});

// ---------------------------------------------------------------- sends: independent vectors

// Base58, SHA-256, the Ed25519 curve check and the program-address search, written out here without the bundle, so
// the send's accounts are checked against a second implementation (the curve check decompresses the point as the
// chain's does: y reduced mod p, x² = (y² - 1) / (d·y² + 1) must be a square).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(text) {
  let n = 0n;
  for (const c of text) {
    const digit = B58.indexOf(c);
    assert.ok(digit >= 0, c);
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}
const P = 2n ** 255n - 19n;
const modPow = (base, exp) => {
  let result = 1n;
  let b = ((base % P) + P) % P;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
};
const ED_D = ((-121665n * modPow(121666n, P - 2n)) % P + P) % P;
function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y %= P;
  const yy = (y * y) % P;
  const x2 = (((yy - 1n + P) % P) * modPow((ED_D * yy + 1n) % P, P - 2n)) % P;
  return x2 === 0n || modPow(x2, (P - 1n) / 2n) === 1n;
}
function programAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = createHash('sha256');
    for (const seed of seeds) hash.update(seed);
    hash.update(Uint8Array.of(bump)).update(b58decode(programId)).update('ProgramDerivedAddress');
    const candidate = new Uint8Array(hash.digest());
    if (!onCurve(candidate)) return b58encode(candidate);
  }
  throw new Error('no program address');
}
// The associated token account: seeds [wallet, token program, mint] under the associated-token program.
const ataOf = (wallet, mint) => programAddress([b58decode(wallet), b58decode(TOKEN), b58decode(mint)], ASSOCIATED_TOKEN);

// A compact-u16 below 2^14: seven bits a byte, low first, the high bit set on every byte but the last.
const compact = (n) => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, n >> 7]);
// A legacy message laid out by hand: header, keys, blockhash, instructions by key index. A send's keys come, within one
// class (signer, writable), in the order its instructions name them, program ids after every instruction's accounts:
// the app's layout (the runtime accepts any order; byte identity with the app is what the vectors check).
function layout({ header, keys, blockhash, instructions }) {
  const index = (key) => {
    const at = keys.indexOf(key);
    assert.ok(at >= 0, key);
    return at;
  };
  const out = [...header, ...compact(keys.length)];
  for (const key of keys) out.push(...b58decode(key));
  out.push(...b58decode(blockhash), ...compact(instructions.length));
  for (const ix of instructions) {
    out.push(index(ix.program), ...compact(ix.accounts.length), ...ix.accounts.map(index), ...compact(ix.data.length), ...ix.data);
  }
  return Uint8Array.from(out);
}
// Payment request references: five distinct addresses (a request carries at most four).
const REFS = [1, 2, 3, 4, 5].map((n) => b58encode(new Uint8Array(32).fill(0x60 + n)));
// Each key's flags as the header gives them.
function flags(message) {
  const { header, keys } = decodeMessage(message);
  const [signers, readonlySigned, readonlyUnsigned] = header;
  return Object.fromEntries(keys.map((key, i) => [key, {
    signer: i < signers,
    writable: i < signers ? i < signers - readonlySigned : i < keys.length - readonlyUnsigned,
  }]));
}
const TOKEN_2022_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const verifiesWith = (publicKey, message, signature) => verifyEd25519(null, message, createPublicKey({
  key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey).toString('base64url') }, format: 'jwk',
}), signature);
const hasBurn = (message) => decodeMessage(message).instructions
  .some((ix) => (ix.program === TOKEN || ix.program === TOKEN_2022_ID) && (ix.data[0] === 8 || ix.data[0] === 15));

describe('chains-activation solana: send transaction bytes (independent vectors)', () => {
  const owner = WALLET.solanaAddress;

  it('derives the associated token account as the chain does: the recorded devnet burn\'s account, and the bundle\'s', () => {
    assert.equal(ataOf(BURNER, MINT), BURNER_ATA, 'the account the recorded devnet burn burned from');
    assert.deepEqual(BURN.transaction.message.accountKeys.map((k) => k.pubkey).filter((k) => k === BURNER_ATA), [BURNER_ATA]);
    for (const wallet of [owner, OTHER, BURNER]) assert.equal(core.associatedTokenAddress(wallet, MINT), ataOf(wallet, MINT), wallet);
    assert.equal(onCurve(b58decode(owner)), true, 'a wallet key is on the curve');
    assert.equal(onCurve(b58decode(ataOf(owner, MINT))), false, 'a program address is not');
  });

  it('SOL: one System Transfer, the owner the only signer and fee payer, the recipient writable', () => {
    const lamports = 1_234_567_890n;
    const message = solana.transferMessage({ owner, to: OTHER, amountRaw: lamports, decimals: 9, recentBlockhash: BLOCKHASH });
    assert.deepEqual(message, layout({
      header: [1, 0, 1], keys: [owner, OTHER, SYSTEM], blockhash: BLOCKHASH,
      instructions: [{ program: SYSTEM, accounts: [owner, OTHER], data: [2, 0, 0, 0, ...le64(lamports)] }],
    }));
    assert.deepEqual(flags(message), {
      [owner]: { signer: true, writable: true }, [OTHER]: { signer: false, writable: true }, [SYSTEM]: { signer: false, writable: false },
    });
  });

  it('SPL to an existing account: TransferChecked [12, amount, decimals] over [source, mint, destination, owner]', () => {
    const amount = 2_500_000n;
    const source = ataOf(owner, MINT);
    const destination = ataOf(OTHER, MINT);
    const message = solana.transferMessage({ owner, to: OTHER, mint: MINT, amountRaw: amount, decimals: 6, recentBlockhash: BLOCKHASH });
    assert.deepEqual(message, layout({
      header: [1, 0, 2], keys: [owner, source, destination, MINT, TOKEN], blockhash: BLOCKHASH,
      instructions: [{ program: TOKEN, accounts: [source, MINT, destination, owner], data: [12, ...le64(amount), 6] }],
    }));
    assert.deepEqual(flags(message), {
      [owner]: { signer: true, writable: true },
      [source]: { signer: false, writable: true },
      [destination]: { signer: false, writable: true },
      [MINT]: { signer: false, writable: false },
      [TOKEN]: { signer: false, writable: false },
    });
    assert.equal(decodeMessage(message).keys.includes(OTHER), false, 'the recipient wallet itself is not an account of it');
  });

  it('SPL to a wallet without the account: CreateIdempotent [1] (the owner pays) then TransferChecked', () => {
    const amount = 1n;
    const source = ataOf(owner, MINT);
    const destination = ataOf(OTHER, MINT);
    const message = solana.transferMessage({
      owner, to: OTHER, mint: MINT, amountRaw: amount, decimals: 6, createAccount: true, recentBlockhash: BLOCKHASH,
    });
    assert.deepEqual(message, layout({
      header: [1, 0, 5],
      keys: [owner, destination, source, OTHER, MINT, SYSTEM, TOKEN, ASSOCIATED_TOKEN],
      blockhash: BLOCKHASH,
      instructions: [
        { program: ASSOCIATED_TOKEN, accounts: [owner, destination, OTHER, MINT, SYSTEM, TOKEN], data: [1] },
        { program: TOKEN, accounts: [source, MINT, destination, owner], data: [12, ...le64(amount), 6] },
      ],
    }));
    const f = flags(message);
    assert.deepEqual(f[owner], { signer: true, writable: true }, 'payer of the rent and the fee, authority of the transfer');
    assert.deepEqual(f[destination], { signer: false, writable: true });
    assert.deepEqual(f[OTHER], { signer: false, writable: false }, 'the new account\'s owner is only named');
    for (const program of [SYSTEM, TOKEN, ASSOCIATED_TOKEN, MINT]) assert.deepEqual(f[program], { signer: false, writable: false }, program);
    assert.equal(hasBurn(message), false);
  });

  it('SOL with a payment request\'s references: read-only, unsigned accounts after the recipient, in the request\'s order', () => {
    const lamports = 1_000_000n;
    const references = [REFS[2], REFS[0], REFS[1]];
    const message = solana.transferMessage({ owner, to: OTHER, amountRaw: lamports, decimals: 9, references, recentBlockhash: BLOCKHASH });
    assert.deepEqual(message, layout({
      header: [1, 0, 4], keys: [owner, OTHER, ...references, SYSTEM], blockhash: BLOCKHASH,
      instructions: [{ program: SYSTEM, accounts: [owner, OTHER, ...references], data: [2, 0, 0, 0, ...le64(lamports)] }],
    }));
    for (const reference of references) assert.deepEqual(flags(message)[reference], { signer: false, writable: false }, reference);
  });

  it('1DEV with references and a memo: the memo (no account, its UTF-8) right before TransferChecked, the references after its owner', () => {
    const amount = 1_500_000_000n;
    const source = ataOf(owner, MINT);
    const destination = ataOf(OTHER, MINT);
    const references = REFS.slice(0, 2);
    const memo = 'Order 2026-09-29/0042 — café ☕';
    const message = solana.transferMessage({
      owner, to: OTHER, mint: MINT, amountRaw: amount, decimals: 6, references, memo, recentBlockhash: BLOCKHASH,
    });
    assert.deepEqual(message, layout({
      header: [1, 0, 5], keys: [owner, source, destination, MINT, ...references, MEMO, TOKEN], blockhash: BLOCKHASH,
      instructions: [
        { program: MEMO, accounts: [], data: [...utf8(memo)] },
        { program: TOKEN, accounts: [source, MINT, destination, owner, ...references], data: [12, ...le64(amount), 6] },
      ],
    }));
    const f = flags(message);
    for (const key of [MINT, ...references, MEMO, TOKEN]) assert.deepEqual(f[key], { signer: false, writable: false }, key);
    assert.equal(hasBurn(message), false);
  });

  it('a new recipient account with four references and a 200-byte memo: create, memo, TransferChecked; 753 bytes signed, within 1232', () => {
    const amount = 1n;
    const source = ataOf(owner, MINT);
    const destination = ataOf(OTHER, MINT);
    const references = REFS.slice(0, 4);
    const memo = 'é'.repeat(100);
    assert.equal(utf8(memo).length, 200);
    const message = solana.transferMessage({
      owner, to: OTHER, mint: MINT, amountRaw: amount, decimals: 6, createAccount: true, references, memo, recentBlockhash: BLOCKHASH,
    });
    assert.deepEqual(message, layout({
      header: [1, 0, 10],
      keys: [owner, destination, source, OTHER, MINT, SYSTEM, TOKEN, ...references, ASSOCIATED_TOKEN, MEMO],
      blockhash: BLOCKHASH,
      instructions: [
        { program: ASSOCIATED_TOKEN, accounts: [owner, destination, OTHER, MINT, SYSTEM, TOKEN], data: [1] },
        { program: MEMO, accounts: [], data: [...utf8(memo)] },
        { program: TOKEN, accounts: [source, MINT, destination, owner, ...references], data: [12, ...le64(amount), 6] },
      ],
    }));
    // the largest request a send takes: the signature count, one signature and the message
    assert.equal(1 + 64 + message.length, 753);
    assert.ok(1 + 64 + message.length <= SOLANA.TRANSACTION_MAX_BYTES);
  });

  it('a transaction larger than a Solana node accepts is TX_TOO_LARGE, before anything is signed', () => {
    assert.equal(SOLANA.TRANSACTION_MAX_BYTES, 1232);
    assert.doesNotThrow(() => solana.assertTransactionSize(new Uint8Array(1232 - 65)));
    for (const message of [new Uint8Array(1232 - 64), new Uint8Array(4096), null, [1, 2, 3]]) {
      assert.throws(() => solana.assertTransactionSize(message), (e) => e.code === 'TX_TOO_LARGE', String(message?.length));
    }
  });

  // The app's own builder (applications/qnet-mobile/src/crypto/SolanaTx.js), imported read-only, and the vector its own
  // tests lay out by hand: one request gives the same bytes in both wallets.
  it('one request, the same bytes as the app: its recorded vector, and its builder over every shape', async (t) => {
    const raw = (byte) => b58encode(new Uint8Array(32).fill(byte));
    const [from, to, hash, reference] = [0x11, 0x22, 0x33, 0x66].map(raw);
    const memo = 'order-42';
    const recorded = Uint8Array.from([
      1, 0, 3, 5, ...b58decode(from), ...b58decode(to), ...b58decode(reference), ...b58decode(MEMO), ...b58decode(SYSTEM),
      ...b58decode(hash), 2, 3, 0, memo.length, ...utf8(memo), 4, 3, 0, 1, 2, 12, 2, 0, 0, 0, ...le64(5n),
    ]);
    assert.deepEqual(solana.transferMessage({ owner: from, to, amountRaw: 5n, decimals: 9, references: [reference], memo, recentBlockhash: hash }),
      recorded, 'the app\'s recorded vector');
    const app = await importApp('crypto/SolanaTx.js');
    if (app === null) {
      t.skip('the app\'s modules do not load in this checkout (its dependencies are not installed)');
      return;
    }
    assert.equal(app.PACKET_DATA_SIZE, SOLANA.TRANSACTION_MAX_BYTES);
    let shapes = 0;
    for (const mint of [null, MINT]) {
      for (const createAccount of mint === null ? [false] : [false, true]) {
        for (const count of [0, 1, 4]) {
          for (const text of [null, 'order 42', 'é'.repeat(100)]) {
            const references = REFS.slice(0, count);
            const amountRaw = mint === null ? 1_234_567n : 2_500_000n;
            const ours = solana.transferMessage({
              owner, to: OTHER, mint, amountRaw, decimals: mint === null ? 9 : 6, createAccount, references, memo: text,
              recentBlockhash: BLOCKHASH,
            });
            const plan = mint === null
              ? { kind: 'sol', from: owner, to: OTHER, amount: amountRaw, references, memo: text }
              : {
                kind: 'token', from: owner, to: OTHER, mint, decimals: 6, amount: amountRaw, source: ataOf(owner, mint),
                destination: ataOf(OTHER, mint), createDestination: createAccount, references, memo: text,
              };
            assert.deepEqual(ours, app.transferMessage(plan, BLOCKHASH), JSON.stringify({ mint, createAccount, count, text }));
            shapes += 1;
          }
        }
      }
    }
    assert.equal(shapes, 27);
  });

  it('a send is only ever a transfer with exactly its request\'s references and memo: anything else is refused before it is compiled', () => {
    const source = ataOf(owner, MINT);
    const destination = ataOf(OTHER, MINT);
    const transfer = solana.systemTransferInstruction({ from: owner, to: OTHER, lamports: 1n });
    const checked = solana.transferCheckedInstruction({ source, mint: MINT, destination, owner, amount: 1n, decimals: 6 });
    const create = solana.createAtaIdempotentInstruction({ payer: owner, ata: destination, owner: OTHER, mint: MINT });
    const burn = solana.burnInstruction({ account: source, mint: MINT, authority: owner, amount: 1n });
    const burnChecked = { ...burn, data: Uint8Array.of(15, ...le64(1n), 6) };
    const memo = solana.memoInstruction({ text: 'QNET_NODE_TYPE:LIGHT', signer: owner });
    const unchecked = { ...checked, data: Uint8Array.of(3, ...le64(1n)) };
    const createAccount = { ...transfer, data: Uint8Array.of(0, 0, 0, 0, ...le64(1n)) };
    const token2022 = { ...checked, programId: TOKEN_2022_ID };
    const approve = { ...checked, data: Uint8Array.of(4, ...le64(1n)) };
    const approveChecked = { ...checked, data: Uint8Array.of(13, ...le64(1n), 6) };
    const refused = (list, request) => assert.throws(() => solana.assertSendInstructions(list, request), (e) => e.code === 'INTERNAL',
      `${JSON.stringify(list.map((ix) => [ix.programId.slice(0, 4), ix.data[0], ix.keys.length]))} ${JSON.stringify(request)}`);
    for (const list of [[transfer], [checked], [create, checked]]) assert.doesNotThrow(() => solana.assertSendInstructions(list));
    for (const list of [[burn], [burnChecked], [checked, burn], [create, burn], [memo], [transfer, memo], [create, checked, memo],
      [checked, create], [transfer, transfer], [create], [], [unchecked], [createAccount], [token2022], [create, transfer], [approve],
      [create, approveChecked]]) {
      refused(list);
    }

    // with a payment request: its references on the transfer, its memo right before it
    const references = REFS.slice(0, 2);
    const text = 'order 42';
    const request = { references, memo: text };
    const withRefs = (ix, refs = references, meta = {}) => ({
      ...ix, keys: [...ix.keys, ...refs.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false, ...meta }))],
    });
    const asked = solana.requestMemoInstruction(text);
    for (const list of [[asked, withRefs(transfer)], [asked, withRefs(checked)], [create, asked, withRefs(checked)]]) {
      assert.doesNotThrow(() => solana.assertSendInstructions(list, request));
    }
    for (const list of [[withRefs(transfer)], [withRefs(checked)], [create, withRefs(checked)]]) {
      assert.doesNotThrow(() => solana.assertSendInstructions(list, { references }));
      refused(list);
      refused(list, request);
    }
    for (const list of [[asked, transfer], [asked, checked], [create, asked, checked]]) {
      assert.doesNotThrow(() => solana.assertSendInstructions(list, { memo: text }));
      refused(list);
      refused(list, request);
    }
    const other = solana.requestMemoInstruction('order 43');
    const signed = { ...asked, keys: [{ pubkey: owner, isSigner: true, isWritable: false }] };
    const v1 = { ...asked, programId: SOLANA.MEMO_V1_PROGRAM };
    for (const list of [
      [withRefs(transfer), asked], [asked, asked, withRefs(transfer)], [other, withRefs(transfer)], [signed, withRefs(transfer)],
      [v1, withRefs(transfer)], [asked, create, withRefs(checked)], [create, asked, asked, withRefs(checked)], [asked, create],
      [asked, withRefs(transfer, [references[1], references[0]])], [asked, withRefs(transfer, [...references, REFS[2]])],
      [asked, withRefs(transfer, [references[0], REFS[2]])], [asked, withRefs(transfer, references.slice(0, 1))],
      [asked, withRefs(transfer, references, { isWritable: true })], [asked, withRefs(transfer, references, { isSigner: true })],
      [asked, withRefs(burn)], [create, asked, withRefs(approveChecked)], [asked, withRefs(approve)], [asked], [create, asked],
    ]) {
      refused(list, request);
    }
    // the request itself: at most four distinct addresses, a memo of the request rule
    for (const bad of [{ references: REFS }, { references: [REFS[0], REFS[0]] }, { references: ['nope'] }, { references: 'x' },
      { memo: '' }, { memo: 'x'.repeat(201) }, { memo: 'a‮b' }, { memo: 7 }]) {
      refused([withRefs(transfer, [])], bad);
    }
  });

  it('the signed send is those bytes: one Ed25519 signature of the owner over the message, verified here with Node\'s own Ed25519', async () => {
    const env = installEnv();
    const net = devnet();
    installFetch(solanaRoute(net.methods));
    await solana.send({ asset: '1dev', to: OTHER, amount: '2.5', expectedFeeLamports: '5000', expectedRentLamports: '2039280' });
    const wire = decodeWire(core.base64Decode(net.seen.sent[0].b64));
    assert.equal(env.calls.signSolanaMessage, 1);
    assert.equal(wire.signatures.length, 1);
    assert.deepEqual(wire.message, solana.transferMessage({
      owner, to: OTHER, mint: MINT, amountRaw: 2_500_000n, decimals: 6, createAccount: true, recentBlockhash: BLOCKHASH,
    }));
    assert.equal(verifiesWith(WALLET.solanaPublicKey, wire.message, wire.signatures[0]), true);
    assert.equal(hasBurn(wire.message), false, 'never a burn');
    for (const asset of ['sol', '1dev']) {
      installFetch(solanaRoute(devnet({ accounts: { [ataOf(OTHER, MINT)]: net.tokenAccountValue(OTHER, '1') } }).methods));
      const quoted = await solana.quote({ asset, to: OTHER, amount: '1' });
      assert.equal(quoted.createsRecipientAccount, false, asset);
    }
  });

  it('a payment request\'s references and memo: quoted, signed in the app\'s layout, and taken only as the request rule allows', async () => {
    installEnv();
    const net = devnet();
    installFetch(solanaRoute(net.methods));
    const references = REFS.slice(0, 3);
    const memo = 'order 42';
    const q = await solana.quote({ asset: '1dev', to: OTHER, amount: '2.5', references, memo });
    assert.deepEqual([q.references, q.memo, q.createsRecipientAccount], [references, memo, true]);
    await solana.send({
      asset: '1dev', to: OTHER, amount: '2.5', references, memo, expectedFeeLamports: '5000', expectedRentLamports: '2039280',
    });
    const wire = decodeWire(core.base64Decode(net.seen.sent[0].b64));
    assert.deepEqual(wire.message, solana.transferMessage({
      owner, to: OTHER, mint: MINT, amountRaw: 2_500_000n, decimals: 6, createAccount: true, references, memo, recentBlockhash: BLOCKHASH,
    }));
    assert.deepEqual(wire.instructions.map((ix) => ix.program), [ASSOCIATED_TOKEN, MEMO, TOKEN]);
    assert.deepEqual(wire.instructions[1].accounts, [], 'the memo lists no account');
    assert.equal(new TextDecoder().decode(wire.instructions[1].data), memo);
    assert.deepEqual(wire.instructions[2].accounts, [net.ata, MINT, ataOf(OTHER, MINT), owner, ...references]);
    assert.equal(verifiesWith(WALLET.solanaPublicKey, wire.message, wire.signatures[0]), true);
    assert.equal(hasBurn(wire.message), false);

    const sol = devnet();
    installFetch(solanaRoute(sol.methods));
    assert.deepEqual((await solana.quote({ asset: 'sol', to: OTHER, amount: '0.01', references: [REFS[4]] })).references, [REFS[4]]);
    await solana.send({ asset: 'sol', to: OTHER, amount: '0.01', references: [REFS[4]], expectedFeeLamports: '5000', expectedRentLamports: '0' });
    const solWire = decodeWire(core.base64Decode(sol.seen.sent[0].b64));
    assert.deepEqual(solWire.instructions.map((ix) => [ix.program, ix.accounts]), [[SYSTEM, [owner, OTHER, REFS[4]]]]);
    // what the router refuses first, the worker refuses again
    for (const bad of [{ references: REFS }, { references: [REFS[0], REFS[0]] }, { references: ['nope'] }, { references: REFS[0] },
      { memo: '' }, { memo: 'é'.repeat(101) }, { memo: 'a⁦b' }, { memo: 42 }]) {
      await rejectsWith(solana.quote({ asset: 'sol', to: OTHER, amount: '0.01', ...bad }), 'INVALID_PARAMS');
      await rejectsWith(solana.send({ asset: 'sol', to: OTHER, amount: '0.01', ...bad, expectedFeeLamports: '5000', expectedRentLamports: '0' }),
        'INVALID_PARAMS');
    }
    assert.equal(sol.seen.sent.length, 1, 'nothing more was sent');
  });
});

// ---------------------------------------------------------------- sends: rent, Max, expiry and status

// The rent floor of a plain account on the real clusters (the exemption of 0 bytes), and a devnet that answers it.
const FLOOR = 890880;
function rentDevnet(options = {}) {
  const net = devnet(options);
  net.methods.getMinimumBalanceForRentExemption = ([space]) => (space === 165 ? 2039280 : FLOOR);
  return net;
}

describe('chains-activation solana: send rent rules and Max', () => {
  it('SOL to an address with no account: at least the rent floor, else AMOUNT_BELOW_RENT, and nothing is signed', async () => {
    const env = installEnv();
    installFetch(solanaRoute(rentDevnet().methods));
    const low = await solana.quote({ asset: 'sol', to: OTHER, amount: '0.0001' });
    assert.equal(low.shortfall, 'AMOUNT_BELOW_RENT');
    assert.equal(low.rentFloorLamports, String(FLOOR));
    await rejectsWith(solana.send({ asset: 'sol', to: OTHER, amount: '0.0001', expectedFeeLamports: '5000', expectedRentLamports: '0' }),
      'AMOUNT_BELOW_RENT');
    assert.equal(env.calls.signSolanaMessage, 0);
    assert.equal((await solana.quote({ asset: 'sol', to: OTHER, amount: '0.00089088' })).shortfall, null, 'the floor itself is enough');
    // an existing account takes any amount
    const funded = { owner: SYSTEM, lamports: 5_000_000, executable: false, data: ['', 'base64'] };
    installFetch(solanaRoute(rentDevnet({ accounts: { [OTHER]: funded } }).methods));
    assert.equal((await solana.quote({ asset: 'sol', to: OTHER, amount: '0.000001' })).shortfall, null);
  });

  it('what stays must be the floor or nothing: SOL_BELOW_RENT, for SOL and for a token send\'s fee and rent', async () => {
    const env = installEnv();
    const funded = { owner: SYSTEM, lamports: 5_000_000, executable: false, data: ['', 'base64'] };
    installFetch(solanaRoute(rentDevnet({ lamports: 1_000_000, accounts: { [OTHER]: funded } }).methods));
    assert.equal((await solana.quote({ asset: 'sol', to: OTHER, amount: '0.0001' })).shortfall, null, '895000 stay');
    assert.equal((await solana.quote({ asset: 'sol', to: OTHER, amount: '0.0005' })).shortfall, 'SOL_BELOW_RENT', '495000 would stay');
    assert.equal((await solana.quote({ asset: 'sol', to: OTHER, amount: '0.000995' })).shortfall, null, 'all of it: nothing stays');
    assert.equal((await solana.quote({ asset: 'sol', to: OTHER, amount: '0.000996' })).shortfall, 'INSUFFICIENT_SOL');
    await rejectsWith(solana.send({ asset: 'sol', to: OTHER, amount: '0.0005', expectedFeeLamports: '5000', expectedRentLamports: '0' }),
      'SOL_BELOW_RENT');
    // a token send pays the fee and the new account's rent in SOL
    installFetch(solanaRoute(rentDevnet({ lamports: 2_500_000 }).methods));
    const token = await solana.quote({ asset: '1dev', to: OTHER, amount: '1' });
    assert.deepEqual([token.createsRecipientAccount, token.shortfall], [true, 'SOL_BELOW_RENT']);
    installFetch(solanaRoute(rentDevnet({ lamports: 2_044_280 }).methods));
    assert.equal((await solana.quote({ asset: '1dev', to: OTHER, amount: '1' })).shortfall, null, 'fee and rent take all of it');
    installFetch(solanaRoute(rentDevnet({ lamports: 2_044_279 }).methods));
    assert.equal((await solana.quote({ asset: '1dev', to: OTHER, amount: '1' })).shortfall, 'INSUFFICIENT_SOL');
    installFetch(solanaRoute(rentDevnet({ oneDev: '999999' }).methods));
    const short = await solana.quote({ asset: '1dev', to: OTHER, amount: '1' });
    assert.deepEqual([short.shortfall, short.tokenRaw], ['INSUFFICIENT_TOKENS', '999999']);
    installFetch(solanaRoute(rentDevnet({ oneDev: null }).methods));
    assert.deepEqual((await solana.quote({ asset: '1dev', to: OTHER, amount: '1' })).tokenRaw, '0', 'no token account holds nothing');
    assert.equal(env.calls.signSolanaMessage, 0);
  });

  it('the fee is taken first: a balance just above the floor can send nothing (SOL_BELOW_RENT)', async () => {
    installEnv();
    installFetch(solanaRoute(rentDevnet({ lamports: 893_000 }).methods));
    assert.equal((await solana.quote({ asset: 'sol', to: WALLET.solanaAddress, amount: '0.000888' })).shortfall, 'SOL_BELOW_RENT');
    await rejectsWith(solana.maxAmount({ asset: 'sol' }), 'SOL_BELOW_RENT');
  });

  it('Max: SOL is the balance less this transfer\'s fee; a token is its whole balance', async () => {
    installEnv();
    installFetch(solanaRoute(rentDevnet().methods));
    assert.deepEqual(await solana.maxAmount({ asset: 'sol' }), { amount: '0.049995', amountRaw: '49995000' });
    assert.deepEqual(await solana.maxAmount({ asset: 'sol', to: OTHER }), { amount: '0.049995', amountRaw: '49995000' });
    assert.deepEqual(await solana.maxAmount({ asset: '1dev' }), { amount: '5000', amountRaw: '5000000000' });
    const quoted = await solana.quote({ asset: 'sol', to: OTHER, amount: '0.049995' });
    assert.deepEqual([quoted.shortfall, quoted.totalLamports, quoted.balanceLamports], [null, '50000000', '50000000']);
    installFetch(solanaRoute(rentDevnet({ lamports: 5000, oneDev: null }).methods));
    await rejectsWith(solana.maxAmount({ asset: 'sol' }), 'INSUFFICIENT_SOL');
    await rejectsWith(solana.maxAmount({ asset: '1dev' }), 'INSUFFICIENT_TOKENS');
    // all of a small balance is still less than a new account needs
    installFetch(solanaRoute(rentDevnet({ lamports: 600_000 }).methods));
    await rejectsWith(solana.maxAmount({ asset: 'sol', to: OTHER }), 'AMOUNT_BELOW_RENT');
    const recipientAta = core.associatedTokenAddress(OTHER, MINT);
    installFetch(solanaRoute(rentDevnet({ accounts: { [recipientAta]: devnet().tokenAccountValue(OTHER, '0') } }).methods));
    await rejectsWith(solana.maxAmount({ asset: 'sol', to: recipientAta }), 'INVALID_ADDRESS');
    installEnv({ locked: true });
    await rejectsWith(solana.maxAmount({ asset: 'sol' }), 'LOCKED');
  });
});

describe('chains-activation solana: after the send', () => {
  it('a blockhash the cluster no longer knows is BLOCKHASH_EXPIRED: nothing sent, nothing recorded', async () => {
    const env = installEnv();
    const net = devnet();
    net.methods.simulateTransaction = () => ({ context: { slot: 1 }, value: { err: 'BlockhashNotFound', logs: [] } });
    installFetch(solanaRoute(net.methods));
    await rejectsWith(solana.send({ asset: 'sol', to: OTHER, amount: '0.01', expectedFeeLamports: '5000', expectedRentLamports: '0' }),
      'BLOCKHASH_EXPIRED');
    assert.equal(net.seen.sent.length, 0);
    assert.deepEqual(env.state().solanaRecipients, []);
  });

  it('a send no status names yet comes back submitted with its lastValidBlockHeight, after one status read', async () => {
    installEnv();
    const net = devnet();
    let reads = 0;
    net.methods.getSignatureStatuses = () => {
      reads += 1;
      return { context: { slot: 1 }, value: [null] };
    };
    installFetch(solanaRoute(net.methods));
    const started = Date.now();
    const result = await solana.send({ asset: 'sol', to: OTHER, amount: '0.01', expectedFeeLamports: '5000', expectedRentLamports: '0' });
    assert.deepEqual([result.status, result.lastValidBlockHeight], ['submitted', 100]);
    assert.equal(reads, 1);
    assert.ok(Date.now() - started < 2000, 'the popup follows it; the send does not wait');
  });

  it('status: pending, confirmed, finalized, failed at confirmed, and expired once the finalized height passed its blockhash', async () => {
    installEnv();
    const net = devnet();
    let answer = null;
    let height = 90;
    let lookups = 0;
    net.methods.getSignatureStatuses = ([, options]) => {
      assert.equal(options.searchTransactionHistory, true);
      lookups += 1;
      return { context: { slot: 1 }, value: [typeof answer === 'function' ? answer() : answer] };
    };
    net.methods.getBlockHeight = ([options]) => {
      assert.equal(options.commitment, 'finalized');
      return height;
    };
    installFetch(solanaRoute(net.methods));
    const signature = WIRE.signature;
    const status = (lastValidBlockHeight = 100) => solana.transferStatus({ signature, lastValidBlockHeight });
    assert.deepEqual(await status(), { status: 'pending' }, 'unknown before its blockhash expires');
    answer = { err: null, confirmationStatus: 'processed' };
    assert.deepEqual(await status(), { status: 'pending' });
    answer = { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' };
    assert.deepEqual(await status(), { status: 'pending' }, 'an error at processed may be a dropped fork (XP-R3-04)');
    answer = { err: null, confirmationStatus: 'confirmed' };
    assert.deepEqual(await status(), { status: 'confirmed' });
    answer = { err: null, confirmationStatus: 'finalized' };
    assert.deepEqual(await status(), { status: 'finalized' });
    answer = { err: { InstructionError: [1, 'Custom'] }, confirmationStatus: 'confirmed' };
    assert.deepEqual(await status(), { status: 'failed' });
    answer = null;
    height = 101;
    lookups = 0;
    assert.deepEqual(await status(), { status: 'expired' });
    assert.equal(lookups, 2, 'looked up again after the height was read');
    // it landed between the two reads: not expired
    let first = true;
    answer = () => {
      const seen = first ? null : { err: null, confirmationStatus: 'confirmed' };
      first = false;
      return seen;
    };
    assert.deepEqual(await status(), { status: 'confirmed' });
    // without the height the wallet cannot tell expired from slow
    answer = null;
    assert.deepEqual(await status(null), { status: 'pending' });
    installEnv({ locked: true });
    await rejectsWith(status(), 'LOCKED');
  });
});

// The popup's Solana History (decision 39): the wallet's own transactions, newest first, at confirmed; what moved for the
// wallet, 1DEV first; each transaction read once.
describe('chains-activation solana: history', () => {
  const OWNER = WALLET.solanaAddress;
  const OWNER_ATA = core.associatedTokenAddress(OWNER, MINT);
  const OTHER_ATA = core.associatedTokenAddress(OTHER, MINT);
  const parsed = ({ keys, pre, post, fee = 5000, err = null, instructions = [], preTokens = [], postTokens = [], blockTime = 1_790_000_000 }) => ({
    blockTime,
    slot: 7,
    meta: { err, fee, preBalances: pre, postBalances: post, preTokenBalances: preTokens, postTokenBalances: postTokens, innerInstructions: [] },
    transaction: { signatures: ['s'], message: { accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: true })), instructions } },
  });
  const solTransfer = (source, destination, lamports) => ({
    program: 'system', programId: SYSTEM, parsed: { type: 'transfer', info: { source, destination, lamports } },
  });
  const tokenTransfer = (source, destination, authority, amount) => ({
    program: 'spl-token', programId: TOKEN,
    parsed: { type: 'transferChecked', info: { source, destination, authority, mint: MINT, tokenAmount: { amount, decimals: 6 } } },
  });
  const tokens = (entries) => entries.map(([accountIndex, owner, amount]) => ({ accountIndex, mint: MINT, owner, uiTokenAmount: { amount } }));
  const SOL_OUT = parsed({ keys: [OWNER, OTHER, SYSTEM], pre: [10e9, 0, 1], post: [10e9 - 1e9 - 5000, 1e9, 1], instructions: [solTransfer(OWNER, OTHER, 1e9)] });
  const SOL_IN = parsed({ keys: [OTHER, OWNER, SYSTEM], pre: [5e9, 0, 1], post: [5e9 - 2e9 - 5000, 2e9, 1], instructions: [solTransfer(OTHER, OWNER, 2e9)] });
  const DEV_IN = parsed({
    keys: [OTHER, OTHER_ATA, OWNER_ATA, TOKEN], pre: [1e9, 2e6, 2e6, 1], post: [1e9 - 5000, 2e6, 2e6, 1],
    instructions: [tokenTransfer(OTHER_ATA, OWNER_ATA, OTHER, '1500000')],
    preTokens: tokens([[1, OTHER, '5000000'], [2, OWNER, '0']]), postTokens: tokens([[1, OTHER, '3500000'], [2, OWNER, '1500000']]),
  });

  it('reads what moved for the wallet: SOL out and in, 1DEV in, a burn, a failed send, a send to itself', () => {
    assert.deepEqual(solana.historyItem('a', SOL_OUT, OWNER, OWNER_ATA), {
      signature: 'a', asset: 'sol', direction: 'out', counterparty: OTHER, amountRaw: '1000000000', feeLamports: '5000',
      timestamp: 1_790_000_000_000, status: 'confirmed', burn: false,
    });
    assert.deepEqual(solana.historyItem('b', SOL_IN, OWNER, OWNER_ATA), {
      signature: 'b', asset: 'sol', direction: 'in', counterparty: OTHER, amountRaw: '2000000000', feeLamports: null,
      timestamp: 1_790_000_000_000, status: 'confirmed', burn: false,
    });
    const devIn = solana.historyItem('c', DEV_IN, OWNER, OWNER_ATA);
    assert.deepEqual([devIn.asset, devIn.direction, devIn.amountRaw, devIn.counterparty, devIn.feeLamports], ['1dev', 'in', '1500000', OTHER, null]);
    // the recorded devnet burn, from its burner's side: 1DEV out, a burn, no counterparty
    const burn = solana.historyItem('d', BURN, BURNER, BURNER_ATA);
    assert.deepEqual([burn.asset, burn.direction, burn.burn, burn.counterparty, burn.status], ['1dev', 'out', true, null, 'confirmed']);
    assert.equal(burn.amountRaw, String(1500n * 10n ** 6n));
    // a failed send charged only its fee: what it asked to move, marked failed
    const failed = solana.historyItem('e', { ...SOL_OUT, meta: { ...SOL_OUT.meta, err: { InstructionError: [0, 'Custom'] }, postBalances: [10e9 - 5000, 0, 1] } },
      OWNER, OWNER_ATA);
    assert.deepEqual([failed.status, failed.direction, failed.asset, failed.amountRaw], ['failed', 'out', 'sol', '1000000000']);
    // to itself: only the fee left the wallet
    const self = solana.historyItem('f', parsed({ keys: [OWNER, SYSTEM], pre: [10e9, 1], post: [10e9 - 5000, 1], instructions: [solTransfer(OWNER, OWNER, 1e9)] }),
      OWNER, OWNER_ATA);
    assert.deepEqual([self.direction, self.amountRaw, self.counterparty, self.feeLamports], ['self', '1000000000', null, '5000']);
    // someone else's transaction that only names the wallet, and one that does not read, are no row
    assert.equal(solana.historyItem('g', parsed({ keys: [OTHER, OWNER], pre: [1e9, 5], post: [1e9 - 5000, 5] }), OWNER, OWNER_ATA), null);
    assert.equal(solana.historyItem('h', { meta: null }, OWNER, OWNER_ATA), null);
  });

  // The owner's listing holds S3 (newest) and S1; the 1DEV account's holds S2 and S1 (a send it signed lists in both).
  const [S1, S2, S3] = [fakeSignature(31), fakeSignature(32), fakeSignature(33)];
  function chain() {
    const listings = {
      [OWNER]: [{ signature: S3, slot: 30 }, { signature: S1, slot: 10 }],
      [OWNER_ATA]: [{ signature: S2, slot: 20 }, { signature: S1, slot: 10 }],
    };
    const txs = { [S1]: SOL_OUT, [S2]: DEV_IN, [S3]: SOL_IN };
    const reads = [];
    const methods = {
      getSignaturesForAddress: ([address, query]) => {
        assert.equal(query.commitment, 'confirmed');
        const all = listings[address] ?? [];
        const from = query.before === undefined ? 0 : all.findIndex((entry) => entry.signature === query.before) + 1;
        return all.slice(from, from + query.limit).map((entry) => ({ ...entry, err: null, blockTime: 1_790_000_000 }));
      },
      getTransaction: ([signature, options]) => {
        reads.push(signature);
        assert.deepEqual(options, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        return clone(txs[signature]);
      },
    };
    return { methods, reads };
  }

  it('merges the two listings by slot, pages with a cursor to the end, and reads each transaction once', async () => {
    installEnv();
    const net = chain();
    installFetch(solanaRoute(net.methods));
    const first = await solana.getHistory({ limit: 2 });
    assert.deepEqual(first.items.map((item) => [item.signature, item.asset, item.direction]), [[S3, 'sol', 'in'], [S2, '1dev', 'in']]);
    assert.equal(first.cursor, `${S3}.${S2}`);
    const second = await solana.getHistory({ cursor: first.cursor, limit: 2 });
    assert.deepEqual(second.items.map((item) => item.signature), [S1]);
    assert.equal(second.cursor, null, 'both listings at their end');
    assert.deepEqual(net.reads, [S3, S2, S1]);
    // read again from the newest: no transaction is fetched twice
    assert.deepEqual((await solana.getHistory({ limit: 2 })).items.map((item) => item.signature), [S3, S2]);
    assert.deepEqual(net.reads, [S3, S2, S1]);
    // a page the session's view cache holds is not read again after a worker restart either
    const env = installEnv();
    env.views.solanaHistory = { items: first.items, cursor: first.cursor };
    const fresh = await import(`../dist/background/solana.js?restart=${Date.now()}`);
    const again = chain();
    installFetch(solanaRoute(again.methods));
    assert.deepEqual((await fresh.getHistory({ limit: 2 })).items.map((item) => item.signature), [S3, S2]);
    assert.deepEqual(again.reads, []);
  });

  it('a malformed cursor is INVALID_PARAMS, an RPC failure SOLANA_UNAVAILABLE, and it refuses while locked', async () => {
    installEnv();
    installFetch(solanaRoute(chain().methods));
    await rejectsWith(solana.getHistory({ cursor: 'nope' }), 'INVALID_PARAMS');
    await rejectsWith(solana.getHistory({ cursor: 'a.b.c' }), 'INVALID_PARAMS');
    installFetch(solanaRoute({ getSignaturesForAddress: () => ({ rpcError: { code: -32602, message: 'bad' } }) }));
    await rejectsWith(solana.getHistory({}), 'SOLANA_UNAVAILABLE');
    installEnv({ locked: true });
    await rejectsWith(solana.getHistory({}), 'LOCKED');
  });
});
