// The transaction builders of the BUILT bundle (compiled from the mobile crypto/TxBuilders.js) against the known answers
// the app and the SDK check too (qnet-mobile/src/crypto/__vectors__/tx-vectors.json): calldata, deploy payload, gas,
// contract address, the signed preimage and the exact request body; the vector signatures verify with the node's
// empty-context ML-DSA-65 relation, and the bundle's signers produce signatures that do too.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as core from '../dist/lib/qnet-core.js';

const V = JSON.parse(readFileSync(new URL('../../qnet-mobile/src/crypto/__vectors__/tx-vectors.json', import.meta.url), 'utf8'));
const NOBLE = new URL('../tools/crypto-bundle/node_modules/@noble/post-quantum/ml-dsa.js', import.meta.url);
const noble = existsSync(NOBLE) ? await import(NOBLE.href) : null;
const needsNoble = noble ? {} : { skip: 'run npm run bundle:install' };

const vector = (name) => V.vectors.find((v) => v.name === name);
const { bytesToHex: hex, hexToBytes } = core;
const utf8 = (s) => new TextEncoder().encode(s);
const keys = core.deriveQnetKeypair(core.mnemonicToSeed(V.wallet.mnemonic));
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return error instanceof core.CoreError ? error.code : `not a CoreError: ${error}`;
  }
  return 'no error';
};

const built = (v) => ({
  transfer: () => core.buildTransfer(v.input),
  tokenTransfer: () => core.buildTokenTransfer(v.input),
  contractCall: () => core.buildContractCall(v.input),
  contractCallDefaultFuel: () => core.buildContractCall(v.input),
  contractDeploy: () => core.buildContractDeploy({ ...v.input, code: hexToBytes(v.input.codeHex) }),
})[v.name]();

describe('transaction builders (compiled from the mobile source)', () => {
  it('belong to the golden wallet', () => {
    assert.equal(keys.address, V.wallet.address);
    assert.equal(hex(keys.publicKey), V.wallet.publicKey);
    assert.equal(core.QNET_CHAIN_TAG, V.chainTag);
    assert.equal(String(core.MAX_WASM_CODE_BYTES), V.limits.maxWasmCodeBytes);
    assert.equal(String(core.MAX_GAS_LIMIT), V.limits.maxGasLimit);
    assert.equal(String(core.WASM_DEFAULT_FUEL), V.limits.wasmDefaultFuel);
    assert.equal(String(core.WASM_MIN_FUEL), V.limits.wasmMinFuel);
  });

  for (const v of V.vectors) {
    it(`reproduces the ${v.name} vector: fields, preimage and request body`, async () => {
      const tx = built(v);
      assert.equal(tx.preimage, v.preimage);
      assert.equal(tx.path, v.requestPath);
      assert.equal(tx.maxFeeNano, v.maxFeeNano);
      for (const key of ['callData', 'intrinsicGas', 'gasLimit', 'fuel', 'codeHash', 'codeBase64', 'deployData', 'contractAddress']) {
        if (v[key] !== undefined) assert.equal(tx[key], v[key], key);
      }
      const pk = v.attachPublicKey ? V.wallet.publicKey : null;
      const body = tx.kind === 'transfer' ? core.transferRequestJson(tx, v.signature, pk)
        : tx.kind === 'contractDeploy' ? core.contractDeployRequestJson(tx, v.signature, pk)
          : core.contractCallRequestJson(tx, v.signature, pk);
      assert.equal(body, v.requestJson);
      assert.equal(await core.verifyConsensusSignature(v.preimage, v.signature, V.wallet.publicKey), true);
    });
  }

  it('the vector signatures are FIPS 204 deterministic signatures of the golden key', needsNoble, () => {
    for (const v of V.vectors) {
      const again = noble.ml_dsa65.sign(utf8(v.preimage), keys.secretKey, { extraEntropy: false });
      assert.equal(hex(again), v.signature, v.name);
    }
  });

  it('signs a token transfer and a contract call over the built preimage, checked under the account key', async () => {
    for (const [sign, v] of [[core.signTokenTransfer, vector('tokenTransfer')], [core.signContractCall, vector('contractCall')]]) {
      const signed = sign(v.input, keys.secretKey, keys.publicKey);
      assert.equal(signed.preimage, v.preimage);
      assert.equal(signed.tx.preimage, v.preimage);
      assert.equal(signed.signature.length, 3309);
      assert.equal(await core.verifyConsensusSignature(v.preimage, hex(signed.signature), V.wallet.publicKey), true);
      const other = core.deriveQnetKeypair(new Uint8Array(64).fill(7));
      assert.equal(code(() => sign(v.input, other.secretKey, other.publicKey)), 'KEY_ADDRESS_MISMATCH');
    }
  });

  it('reports refusals as CoreError codes', () => {
    const t = vector('transfer').input;
    const c = vector('contractCall').input;
    assert.equal(code(() => core.buildTransfer({ ...t, to: t.to.toUpperCase() })), 'INVALID_ADDRESS');
    assert.equal(code(() => core.buildTransfer({ ...t, nonce: '0' })), 'INVALID_NONCE');
    assert.equal(code(() => core.buildTransfer({ ...t, amountNano: '01' })), 'INVALID_INTEGER');
    assert.equal(code(() => core.buildContractCall({ ...c, fuel: 1 })), 'INVALID_FUEL');
    assert.equal(code(() => core.buildContractCall({ ...c, args: '0' })), 'INVALID_ARGS');
    assert.equal(code(() => core.buildContractCall({ ...c, method: 'a-b' })), 'INVALID_METHOD');
    assert.equal(code(() => core.buildContractDeploy({ from: t.from, code: new Uint8Array(8), nonce: 1 })), 'INVALID_CODE');
    assert.equal(code(() => core.contractCallData('', 'run', null)), 'INVALID_CALL');
    assert.equal(code(() => core.signTokenTransfer({ ...vector('tokenTransfer').input, amount: 0 }, keys.secretKey, keys.publicKey)),
      'INVALID_AMOUNT');
    // the transfer signer keeps its own field rules and the shared u64 reading
    assert.equal(code(() => core.signTransfer({ ...t, amountNano: '-1' }, keys.secretKey, keys.publicKey)), 'INVALID_INTEGER');
  });
});
