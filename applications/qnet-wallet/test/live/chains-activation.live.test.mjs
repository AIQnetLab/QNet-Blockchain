// Read-only checks of qnet.js, solana.js and activation.js against Solana devnet and the pinned QNet
// nodes (npm run test:live). Only GETs and read RPC methods; nothing is signed or sent.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../helpers/chains-activation-loader.mjs', import.meta.url);

const core = await import('../../dist/lib/qnet-core.js');
const solana = await import('../../dist/background/solana.js');
const qnet = await import('../../dist/background/qnet.js');
const activation = await import('../../dist/background/activation.js');

const KAT_BURN = core.KAT.activation;
const GENESIS_WALLET_001 = '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d';

describe('chains-activation live: Solana devnet (read-only)', () => {
  it('the burn matcher finds the KAT burn as the burner\'s canonical burn and its code is the KAT code', async () => {
    const result = await solana.findWalletBurns(KAT_BURN.solanaAddress);
    assert.equal(result.listingComplete, true);
    assert.equal(result.complete, true);
    assert.equal(result.canonical.signature, KAT_BURN.burnTx);
    assert.equal(result.canonical.nodeType, KAT_BURN.nodeType);
    assert.equal(result.canonical.amount, KAT_BURN.burnAmount);
    const { nodeType, signature, amount } = result.canonical;
    assert.equal(core.generateActivationCode(nodeType, KAT_BURN.solanaAddress, signature, amount), KAT_BURN.code);
  });

  it('a wallet without burns is complete and has no canonical burn', async () => {
    const result = await solana.findWalletBurns(core.KAT.solanaAddress);
    assert.equal(result.complete, true);
    assert.equal(result.canonical, null);
  });
});

describe('chains-activation live: QNet nodes (read-only)', () => {
  it('the activation price is an integer quote of phase 1 or 2', async () => {
    const quote = await activation.getPrice();
    assert.ok(quote.phase === 1 || quote.phase === 2);
    assert.ok(Number.isSafeInteger(quote.light.cost) && quote.light.cost > 0);
    assert.ok(Number.isSafeInteger(quote.super.cost) && quote.super.cost > 0);
  });

  it('a genesis wallet reads as verified against the committee certificate, with an exact u64 balance', async () => {
    const account = await qnet.readAccount(GENESIS_WALLET_001);
    assert.equal(account.verified, true);
    assert.equal(account.verification, 'proof');
    assert.match(account.balanceNano, /^[0-9]+$/);
    assert.match(account.nonce, /^[0-9]+$/);
  });
});
