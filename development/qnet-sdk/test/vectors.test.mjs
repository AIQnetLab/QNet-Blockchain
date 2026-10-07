// The BUILT SDK against the known answers the app and the extension check too (qnet-mobile/src/crypto/__vectors__/
// tx-vectors.json): the golden key, every builder's fields, preimage and exact request body, and signatures the node's
// empty-context ML-DSA-65 relation accepts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as sdk from '../dist/index.js';
import { ROOT, V, vector } from './helpers.mjs';

const keys = sdk.keypairFromRecoveryPhrase(V.wallet.mnemonic);
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return error instanceof sdk.QNetError ? error.code : `not a QNetError: ${error}`;
  }
  return 'no error';
};

const built = (v) => ({
  transfer: () => sdk.buildTransfer(v.input),
  tokenTransfer: () => sdk.buildTokenTransfer(v.input),
  contractCall: () => sdk.buildContractCall(v.input),
  contractCallDefaultFuel: () => sdk.buildContractCall(v.input),
  contractDeploy: () => sdk.buildContractDeploy({ ...v.input, code: hexToBytes(v.input.codeHex) }),
})[v.name]();

describe('transaction builders compiled from the app source', () => {
  it('derive the golden wallet from its recovery phrase', () => {
    assert.equal(keys.address, V.wallet.address);
    assert.equal(bytesToHex(keys.publicKey), V.wallet.publicKey);
    assert.equal(sdk.addressFromPublicKey(keys.publicKey), V.wallet.address);
    assert.equal(sdk.CHAIN_TAG, V.chainTag);
    assert.equal(String(sdk.MAX_GAS_LIMIT), V.limits.maxGasLimit);
    assert.equal(String(sdk.MAX_WASM_CODE_BYTES), V.limits.maxWasmCodeBytes);
    assert.equal(String(sdk.WASM_DEFAULT_FUEL), V.limits.wasmDefaultFuel);
    assert.equal(String(sdk.WASM_MIN_FUEL), V.limits.wasmMinFuel);
  });

  for (const v of V.vectors) {
    it(`reproduce the ${v.name} vector: fields, preimage, request body and signature`, () => {
      const tx = built(v);
      assert.equal(tx.preimage, v.preimage);
      assert.equal(tx.path, v.requestPath);
      assert.equal(tx.maxFeeNano, v.maxFeeNano);
      for (const key of ['callData', 'intrinsicGas', 'gasLimit', 'fuel', 'codeHash', 'codeBase64', 'deployData', 'contractAddress']) {
        if (v[key] !== undefined) assert.equal(tx[key], v[key], key);
      }
      const signature = hexToBytes(v.signature);
      assert.equal(sdk.requestBody(tx, signature, v.attachPublicKey ? keys.publicKey : null), v.requestJson);
      assert.equal(sdk.verifyTransactionSignature(tx, signature, keys.publicKey), true);
      assert.equal(ml_dsa65.verify(signature, utf8ToBytes(v.preimage), keys.publicKey), true);
    });
  }

  it('the vector signatures are the FIPS 204 deterministic signatures of the golden key', () => {
    for (const v of V.vectors) {
      assert.equal(bytesToHex(ml_dsa65.sign(utf8ToBytes(v.preimage), keys.secretKey, { extraEntropy: false })), v.signature, v.name);
    }
  });

  it('sign over the builder preimage only, with the sender\'s key, and the node relation accepts it', () => {
    const tx = sdk.buildContractCall(vector('contractCall').input);
    const signature = sdk.signTransaction(tx, keys.secretKey, keys.publicKey);
    assert.equal(signature.length, 3309);
    assert.equal(ml_dsa65.verify(signature, utf8ToBytes(tx.preimage), keys.publicKey), true);
    const other = sdk.keypairFromEntropy(new Uint8Array(32).fill(7));
    assert.equal(code(() => sdk.signTransaction(tx, other.secretKey, other.publicKey)), 'KEY_ADDRESS_MISMATCH');
    assert.equal(sdk.verifyTransactionSignature(tx, signature, other.publicKey), false);
    assert.equal(code(() => sdk.signTransaction({ ...tx, preimage: 'transfer:anything' }, keys.secretKey, keys.publicKey)), 'INVALID_CALL');
    // A field changed after building: the text to sign no longer matches the fields, so nothing is signed.
    const transfer = sdk.buildTransfer(vector('transfer').input);
    assert.equal(code(() => sdk.signTransaction({ ...transfer, amountNano: '1' }, keys.secretKey, keys.publicKey)), 'INVALID_CALL');
    const deploy = sdk.buildContractDeploy({ ...vector('contractDeploy').input, code: hexToBytes(vector('contractDeploy').input.codeHex) });
    assert.equal(sdk.verifyTransactionSignature(deploy, sdk.signTransaction(deploy, keys.secretKey, keys.publicKey), keys.publicKey), true);
  });

  // DEV-R1-04: the check rebuilds the transaction from its fields, as the node does, so a valid signature of one
  // transaction cannot vouch for fields that say something else.
  it('verify a signature only for the fields that were signed', () => {
    const small = sdk.buildTransfer({ ...vector('transfer').input, amountNano: '1' });
    const signature = sdk.signTransaction(small, keys.secretKey, keys.publicKey);
    assert.equal(sdk.verifyTransactionSignature(small, signature, keys.publicKey), true);
    // The signed text of a 1-nano transfer with the amount field of 1000 QNC.
    assert.equal(sdk.verifyTransactionSignature({ ...small, amountNano: '1000000000000' }, signature, keys.publicKey), false);
    assert.equal(sdk.verifyTransactionSignature({ ...small, to: sdk.CANONICAL_BURN_ADDRESS }, signature, keys.publicKey), false);
    assert.equal(sdk.verifyTransactionSignature({ ...small, maxFeeNano: '0' }, signature, keys.publicKey), false);
    const token = sdk.buildTokenTransfer({ ...vector('tokenTransfer').input });
    const tokenSig = sdk.signTransaction(token, keys.secretKey, keys.publicKey);
    assert.equal(sdk.verifyTransactionSignature(token, tokenSig, keys.publicKey), true);
    assert.equal(sdk.verifyTransactionSignature({ ...token, amount: '999999999' }, tokenSig, keys.publicKey), false);
    assert.equal(sdk.verifyTransactionSignature({ ...token, args: [token.to, '999999999'] }, tokenSig, keys.publicKey), false);
    // A text without the chain tag, even with fields that rebuild to it, is not what a node checks.
    assert.equal(sdk.verifyTransactionSignature({ ...small, preimage: small.preimage.slice('q1337|'.length) }, signature, keys.publicKey), false);
  });

  it('report refusals as QNetError codes', () => {
    const t = vector('transfer').input;
    const c = vector('contractCall').input;
    assert.equal(code(() => sdk.buildTransfer({ ...t, to: t.to.toUpperCase() })), 'INVALID_ADDRESS');
    assert.equal(code(() => sdk.buildTransfer({ ...t, nonce: '0' })), 'INVALID_NONCE');
    assert.equal(code(() => sdk.buildTransfer({ ...t, amountNano: '01' })), 'INVALID_INTEGER');
    assert.equal(code(() => sdk.buildTransfer({ ...t, amountNano: '18446744073709551616' })), 'INVALID_INTEGER');
    assert.equal(code(() => sdk.buildTransfer({ ...t, gasPrice: 9 })), 'INVALID_GAS_PRICE');
    assert.equal(code(() => sdk.buildContractCall({ ...c, fuel: 1 })), 'INVALID_FUEL');
    assert.equal(code(() => sdk.buildContractCall({ ...c, args: '0' })), 'INVALID_ARGS');
    assert.equal(code(() => sdk.buildContractCall({ ...c, method: 'a-b' })), 'INVALID_METHOD');
    assert.equal(code(() => sdk.buildContractDeploy({ from: t.from, code: new Uint8Array(8), nonce: 1 })), 'INVALID_CODE');
    const big = new Uint8Array(sdk.MAX_WASM_CODE_BYTES + 1);
    big.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    assert.equal(code(() => sdk.buildContractDeploy({ from: t.from, code: big, nonce: 1 })), 'CODE_TOO_LARGE');
    assert.equal(code(() => sdk.requestBody(sdk.buildTransfer(t), new Uint8Array(10), null)), 'INVALID_SIGNATURE');
    assert.equal(code(() => sdk.keypairFromRecoveryPhrase('abandon abandon abandon')), 'INVALID_MNEMONIC');
  });

  it('read a recovery phrase in any spacing or case as the wallets do', () => {
    const messy = `  ${V.wallet.mnemonic.toUpperCase().split(' ').join('   ')}\n`;
    assert.equal(sdk.keypairFromRecoveryPhrase(messy).address, V.wallet.address);
  });

  it('carry no copy of a preimage template: every signed text comes from the shared builders', () => {
    const src = path.join(ROOT, 'development/qnet-sdk/src');
    for (const file of readdirSync(src, { recursive: true }).filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts'))) {
      const text = readFileSync(path.join(src, file), 'utf8');
      assert.doesNotMatch(text, /transfer:\$\{|contract_call:|contract_deploy:|qnet_contract_v1/, file);
    }
  });
});

describe('amounts', () => {
  it('convert decimals to base units exactly and back', () => {
    assert.equal(sdk.parseUnits('1.5'), 1_500_000_000n);
    assert.equal(sdk.parseUnits('0.000000001'), 1n);
    assert.equal(sdk.parseUnits('18446744073.709551615'), (1n << 64n) - 1n);
    assert.equal(sdk.formatUnits(1_500_000_000n), '1.5');
    assert.equal(sdk.formatUnits('2909459674650000'), '2909459.67465');
    assert.equal(sdk.formatUnits(12345n, 0), '12345');
    for (const bad of ['0', '1.0000000001', '-1', '1e3', ' 1', '01', '.5', '18446744073.709551616']) {
      assert.equal(code(() => sdk.parseUnits(bad)), 'INVALID_AMOUNT', bad);
    }
  });
});
