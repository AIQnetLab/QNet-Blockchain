// The V2 transaction form (a signed last height, valid_until) in the BUILT bundle, held to
// docs/protocols/tx-v2.vectors.json: the shared preimage builders give its signed text byte for byte, the bundle's
// signers sign that text under this build's network id and self-verify, and a malformed last height is never signed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as core from '../dist/lib/qnet-core.js';

const V = JSON.parse(readFileSync(new URL('../../../docs/protocols/tx-v2.vectors.json', import.meta.url), 'utf8'));
const T = JSON.parse(readFileSync(new URL('../../qnet-mobile/src/crypto/__vectors__/tx-vectors.json', import.meta.url), 'utf8'));
const NOBLE = new URL('../tools/crypto-bundle/node_modules/@noble/post-quantum/ml-dsa.js', import.meta.url);
const noble = existsSync(NOBLE) ? await import(NOBLE.href) : null;
const needsNoble = noble ? {} : { skip: 'run npm run bundle:install' };

const NET = V.constants.networkId;
const VU = V.constants.validUntil;
const OWN = core.genesisConsensus.NETWORK_ID;
const caseOf = (name) => V.v2.find((c) => c.case === name);
const keys = core.deriveQnetKeypair(core.mnemonicToSeed(T.wallet.mnemonic));
const TO = '4c83bc6f4c20906b81beon31e92ebc6ffccd7b973e10d';
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return error instanceof core.CoreError ? error.code : `not a CoreError: ${error}`;
  }
  return 'no error';
};

describe('tx v2 vectors: the shared builders give the node\'s signed text', () => {
  const expiry = { networkId: NET, validUntil: VU };

  it('transfer, contract call and deploy, and the V1 transfer beside them', () => {
    const t = caseOf('transfer').transaction;
    assert.equal(core.transferPreimage(t.from, t.to, t.amount, t.nonce, t.gas_price, t.gas_limit, expiry), caseOf('transfer').signedText);
    const c = caseOf('call').transaction;
    assert.equal(core.contractCallPreimage(c.from, c.data, c.nonce, c.gas_price, c.gas_limit, expiry), caseOf('call').signedText);
    const d = caseOf('deploy').transaction;
    assert.equal(core.contractDeployPreimage(d.from, JSON.parse(d.data).code_hash, d.nonce, d.gas_price, d.gas_limit, expiry),
      caseOf('deploy').signedText);
    const v1 = V.v1Transfer.transaction;
    assert.equal(core.transferPreimage(v1.from, v1.to, v1.amount, v1.nonce, v1.gas_price, v1.gas_limit), V.v1Transfer.signedText);
  });

  it('the claim: no timestamp, the last height, the payload\'s SHA3-256 (a checksummed wallet in place of the vector\'s)', () => {
    const { transaction: t, signedText } = caseOf('claim');
    assert.throws(() => core.claimPayloadPreimageV2(t.to, t.data, expiry), TypeError);
    assert.equal(core.claimPayloadPreimageV2(keys.address, t.data, expiry), signedText.split(t.to).join(keys.address));
  });

  it('the lifetimes and refusal codes are the node\'s', () => {
    assert.equal(core.MAX_TX_LIFETIME_BLOCKS, V.constants.maxLifetimeBlocks);
    assert.ok(core.TX_V2_LIFETIME_BLOCKS < core.MAX_TX_LIFETIME_BLOCKS);
    assert.deepEqual([...core.EXPIRY_REFUSALS].sort(), ['tx_expired', 'tx_expiry_beyond_horizon', 'tx_expiry_required', 'tx_v2_before_gate']);
    assert.deepEqual(core.txExpiryFromAccount({ tx_v2: true, next_height: 1000 }, OWN), { networkId: OWN, validUntil: '1600' });
    assert.equal(core.txExpiryFromAccount({ tx_v2: false, next_height: 1000 }, OWN), null);
    assert.equal(core.resignFormOf(core.expiryRefusalOf({ code: 'tx_v2_before_gate' })), 'v1');
    assert.equal(core.resignFormOf(core.expiryRefusalOf({ error: 'tx_expired: its last height 5 is below the next block 7' })), 'v2');
    assert.equal(core.validUntilOf('{"valid_until":4277400}'), 4277400);
    assert.equal(core.expiredAt(1000, 1002), true);
    assert.equal(core.expiredAt(1000, 1001), false);
  });
});

describe('tx v2 vectors: the bundle\'s signers', () => {
  const fields = { from: keys.address, to: TO, amountNano: '5', nonce: '3', gasPrice: '10', gasLimit: '10000' };

  it('sign the V2 text under this build\'s network id with validUntil, the V1 text without it', needsNoble, () => {
    const v2 = core.signTransfer({ ...fields, validUntil: '1600' }, keys.secretKey, keys.publicKey);
    assert.equal(v2.preimage, `q1337|${OWN}|transfer_v2:${keys.address}:${TO}:5:3:10:10000:1600`);
    assert.equal(noble.ml_dsa65.verify(v2.signature, new TextEncoder().encode(v2.preimage), keys.publicKey), true);
    assert.equal(core.verifyTransferSignature({ ...fields, validUntil: '1600' }, v2.signature, keys.publicKey), true);
    assert.equal(core.verifyTransferSignature(fields, v2.signature, keys.publicKey), false, 'a V2 signature is no V1 one');
    assert.equal(core.signTransfer(fields, keys.secretKey, keys.publicKey).preimage, `q1337|transfer:${keys.address}:${TO}:5:3:10:10000`);

    const token = core.signTokenTransfer({ from: keys.address, token: TO, to: keys.address, amount: '7', nonce: '4', validUntil: '1600' },
      keys.secretKey, keys.publicKey);
    assert.equal(token.tx.validUntil, '1600');
    assert.match(token.preimage, new RegExp(`^q1337\\|${OWN}\\|contract_call_v2:.*:1600$`));
    assert.equal(JSON.parse(core.contractCallRequestJson(token.tx, 'aa')).valid_until, 1600);
    const call = core.signContractCall({ from: keys.address, contract: TO, method: 'run', args: 'ab', nonce: '5', validUntil: '1600' },
      keys.secretKey, keys.publicKey);
    assert.match(call.preimage, /\|contract_call_v2:.*:1600$/);

    const claimsData = '{"claims":[{"epoch":5,"amount":"1000000000"}]}';
    const claim = core.signClaimPayload({ wallet: keys.address, ts: 1, claimsData, validUntil: 1600 }, keys.secretKey, keys.publicKey);
    assert.equal(claim.preimage, core.claimPayloadPreimageV2(keys.address, claimsData, { networkId: OWN, validUntil: 1600 }));
    assert.equal(core.signClaimPayload({ wallet: keys.address, ts: 1, claimsData }, keys.secretKey, keys.publicKey).preimage,
      core.claimPayloadPreimage(keys.address, 1, claimsData));
  });

  it('never sign a malformed last height: one check (expiryAt) for every signer', () => {
    assert.deepEqual(core.expiryAt('1600'), { networkId: OWN, validUntil: '1600' });
    assert.deepEqual(core.expiryAt(1600), { networkId: OWN, validUntil: '1600' });
    assert.equal(core.expiryAt(null), null);
    assert.equal(core.expiryAt(undefined), null);
    for (const bad of ['0', 0, '-1', '1.5', '01600', '9007199254740992', 9007199254740992, 'x']) {
      assert.equal(code(() => core.expiryAt(bad)), 'INVALID_EXPIRY', String(bad));
      assert.equal(code(() => core.signTransfer({ ...fields, validUntil: bad }, keys.secretKey, keys.publicKey)), 'INVALID_EXPIRY', String(bad));
      assert.equal(code(() => core.signTokenTransfer({ from: keys.address, token: TO, to: keys.address, amount: '7', nonce: '4',
        validUntil: bad }, keys.secretKey, keys.publicKey)), 'INVALID_EXPIRY', String(bad));
      assert.equal(code(() => core.signContractCall({ from: keys.address, contract: TO, method: 'run', args: 'ab', nonce: '5',
        validUntil: bad }, keys.secretKey, keys.publicKey)), 'INVALID_EXPIRY', String(bad));
      assert.equal(code(() => core.signClaimPayload({ wallet: keys.address, ts: 1, claimsData: '{}', validUntil: bad }, keys.secretKey,
        keys.publicKey)), 'INVALID_EXPIRY', String(bad));
    }
  });
});
