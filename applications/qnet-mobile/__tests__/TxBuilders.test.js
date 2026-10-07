/**
 * The shared transaction builders (src/crypto/TxBuilders.js, compiled into the extension's qnet-core bundle and the
 * SDK too) against the known answers in src/crypto/__vectors__/tx-vectors.json. The vectors were built apart from the
 * code under test: js-sha3 for the hashes, the node's format strings as templates, and ML-DSA-65 in its deterministic
 * mode for the signatures. The app's own senders produce the same bytes through the same builders.
 */
jest.mock('../src/crypto/DilithiumCrypto', () => {
  const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');
  return {
    isDilithiumAvailable: () => true,
    // the native signer's output for these inputs, in FIPS 204's deterministic mode
    signDetached: jest.fn(async (message, skHex) => Buffer.from(ml_dsa65.sign(new TextEncoder().encode(message),
      Uint8Array.from(Buffer.from(skHex, 'hex')), { extraEntropy: false })).toString('hex')),
  };
});

const { ml_dsa65 } = require('@noble/post-quantum/ml-dsa.js');
const { sha3_256, shake256 } = require('js-sha3');
const V = require('../src/crypto/__vectors__/tx-vectors.json');
const kat = require('./fixtures/wallet_kat.json');
const T = require('../src/crypto/TxBuilders');
const { transferPreimage, contractCallPreimage, contractDeployPreimage, isValidQnetAddress, QNET_CHAIN_TAG } =
  require('../src/crypto/WalletIdentity');
const { GAS_PRICE, TRANSFER_GAS_LIMIT } = require('../src/config/fees');
const { WalletManager } = require('../src/components/WalletManager');

const vector = (name) => V.vectors.find((v) => v.name === name);
const hexBytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const utf8 = (s) => new TextEncoder().encode(s);
const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e instanceof T.TxBuildError ? e.code : `not a TxBuildError: ${e}`;
  }
  return 'no error';
};
// The typed builder of each vector, from its input.
const built = (v) => ({
  transfer: () => T.buildTransfer(v.input),
  tokenTransfer: () => T.buildTokenTransfer(v.input),
  contractCall: () => T.buildContractCall(v.input),
  contractCallDefaultFuel: () => T.buildContractCall(v.input),
  contractDeploy: () => T.buildContractDeploy({ ...v.input, code: hexBytes(v.input.codeHex) }),
})[v.name]();
const requestOf = (tx, v) => {
  const pk = v.attachPublicKey ? V.wallet.publicKey : null;
  if (tx.kind === 'transfer') return T.transferRequestJson(tx, v.signature, pk);
  if (tx.kind === 'contractDeploy') return T.contractDeployRequestJson(tx, v.signature, pk);
  return T.contractCallRequestJson(tx, v.signature, pk);
};

describe('the known answers', () => {
  it('belong to the golden wallet, whose key the node pins', () => {
    expect(V.chainTag).toBe(QNET_CHAIN_TAG);
    expect(V.wallet.address).toBe(kat.eon_address);
    expect(V.wallet.publicKey).toBe(kat.pk_hex);
    expect(sha3_256(hexBytes(V.wallet.publicKey))).toBe(kat.pk_sha3_256);
    expect(V.vectors.map((v) => v.name)).toEqual(['transfer', 'tokenTransfer', 'contractCall', 'contractCallDefaultFuel', 'contractDeploy']);
    expect(V.limits).toEqual({
      maxGasLimit: String(T.MAX_GAS_LIMIT), maxWasmCodeBytes: String(T.MAX_WASM_CODE_BYTES),
      wasmDefaultFuel: String(T.WASM_DEFAULT_FUEL), wasmMinFuel: String(T.WASM_MIN_FUEL),
    });
  });

  it('every signature verifies under the golden key over its preimage, and signing again gives the same bytes', () => {
    const { secretKey, publicKey } = ml_dsa65.keygen(hexBytes(shake256(kat.seed_string, 256)));
    expect(Buffer.from(publicKey).toString('hex')).toBe(kat.pk_hex);
    for (const v of V.vectors) {
      expect(sha3_256(v.preimage)).toBe(v.preimageSha3);
      expect([v.name, ml_dsa65.verify(hexBytes(v.signature), utf8(v.preimage), publicKey)]).toEqual([v.name, true]);
      const again = ml_dsa65.sign(utf8(v.preimage), secretKey, { extraEntropy: false });
      expect([v.name, Buffer.from(again).toString('hex')]).toEqual([v.name, v.signature]);
    }
  });
});

describe('the typed builders reproduce every vector', () => {
  for (const v of V.vectors) {
    it(v.name, () => {
      const tx = built(v);
      expect(Object.isFrozen(tx)).toBe(true);
      expect(tx.preimage).toBe(v.preimage);
      expect(tx.path).toBe(v.requestPath);
      expect(tx.maxFeeNano).toBe(v.maxFeeNano);
      for (const key of ['callData', 'intrinsicGas', 'gasLimit', 'fuel', 'codeHash', 'codeBase64', 'deployData', 'contractAddress']) {
        if (v[key] !== undefined) expect([key, tx[key]]).toEqual([key, v[key]]);
      }
      expect(requestOf(tx, v)).toBe(v.requestJson);
      // the node reads each body back into the same fields
      const body = JSON.parse(v.requestJson);
      expect(body.from).toBe(V.wallet.address);
      expect(body.dilithium_signature).toBe(v.signature);
      expect(body.dilithium_public_key).toBe(v.attachPublicKey ? V.wallet.publicKey : undefined);
    });
  }

  it('the preimage functions alone give the same bytes', () => {
    const t = vector('transfer').input;
    expect(transferPreimage(t.from, t.to, t.amountNano, t.nonce, t.gasPrice, t.gasLimit)).toBe(vector('transfer').preimage);
    for (const name of ['tokenTransfer', 'contractCall', 'contractCallDefaultFuel']) {
      const v = vector(name);
      expect(sha3_256(v.callData)).toBe(v.callDataSha3);
      expect(contractCallPreimage(v.input.from, v.callData, v.input.nonce, v.input.gasPrice, v.gasLimit)).toBe(v.preimage);
      expect(T.contractCallIntrinsicGas(v.callData)).toBe(Number(v.intrinsicGas));
    }
    const d = vector('contractDeploy');
    expect(T.wasmCodeHash(hexBytes(d.input.codeHex))).toBe(d.codeHash);
    expect(T.contractDeployData(hexBytes(d.input.codeHex))).toBe(d.deployData);
    expect(T.contractDeployIntrinsicGas(d.deployData)).toBe(Number(d.intrinsicGas));
    expect(contractDeployPreimage(d.input.from, d.codeHash, d.input.nonce, d.input.gasPrice, d.gasLimit)).toBe(d.preimage);
    expect(T.deriveContractAddress(d.input.from, d.input.nonce)).toBe(d.contractAddress);
    expect(T.deriveContractAddress(d.input.from, 1)).toBe(vector('tokenTransfer').input.token);
    expect(isValidQnetAddress(d.contractAddress)).toBe(true);
  });
});

describe('what the builders refuse', () => {
  const FROM = V.wallet.address;
  const TO = vector('transfer').input.to;
  const TOKEN = vector('tokenTransfer').input.token;
  const WASM = vector('contractCall').input.contract;
  const flip = (a) => `${a.slice(0, 44)}${a[44] === '0' ? '1' : '0'}`;
  const transfer = (over) => () => T.buildTransfer({ ...vector('transfer').input, ...over });
  const call = (over) => () => T.buildContractCall({ from: FROM, contract: WASM, method: 'run', args: null, nonce: 1, ...over });

  it('addresses without their checksum, in upper case or as 64 hex', () => {
    for (const bad of [flip(TO), TO.toUpperCase(), 'c'.repeat(64), '', null]) {
      expect(codeOf(transfer({ to: bad }))).toBe('INVALID_ADDRESS');
      expect(codeOf(() => T.buildTokenTransfer({ from: FROM, token: TOKEN, to: bad, amount: 1, nonce: 1 }))).toBe('INVALID_ADDRESS');
      expect(codeOf(call({ contract: bad }))).toBe('INVALID_ADDRESS');
    }
    expect(isValidQnetAddress(T.CANONICAL_BURN_ADDRESS)).toBe(true);
  });

  it('amounts, nonces and gas the node would refuse', () => {
    expect(codeOf(transfer({ amountNano: '0' }))).toBe('INVALID_AMOUNT');
    expect(codeOf(transfer({ amountNano: '18446744073709551616' }))).toBe('INVALID_INTEGER');
    expect(codeOf(transfer({ amountNano: '01' }))).toBe('INVALID_INTEGER');
    expect(codeOf(transfer({ amountNano: 1.5 }))).toBe('INVALID_INTEGER');
    expect(codeOf(transfer({ amountNano: 2 ** 53 }))).toBe('INVALID_INTEGER');
    expect(T.buildTransfer({ ...vector('transfer').input, amountNano: 18446744073709551615n }).amountNano).toBe('18446744073709551615');
    expect(codeOf(transfer({ nonce: 0 }))).toBe('INVALID_NONCE');
    expect(codeOf(transfer({ gasPrice: GAS_PRICE - 1 }))).toBe('INVALID_GAS_PRICE');
    expect(codeOf(transfer({ gasLimit: TRANSFER_GAS_LIMIT - 1 }))).toBe('INVALID_GAS_LIMIT');
    expect(codeOf(transfer({ gasLimit: T.MAX_GAS_LIMIT + 1 }))).toBe('INVALID_GAS_LIMIT');
    expect(codeOf(() => T.buildTokenTransfer({ from: FROM, token: TOKEN, to: TO, amount: 0, nonce: 1 }))).toBe('INVALID_AMOUNT');
    const intrinsic = Number(vector('tokenTransfer').intrinsicGas);
    expect(codeOf(() => T.buildTokenTransfer({ ...vector('tokenTransfer').input, gasLimit: intrinsic - 1 }))).toBe('INVALID_GAS_LIMIT');
    expect(T.buildTokenTransfer({ ...vector('tokenTransfer').input, gasLimit: intrinsic + 1 }).gasLimit).toBe(String(intrinsic + 1));
  });

  it('a WASM call always has fuel to run on, and never more gas than a transaction may carry', () => {
    const intrinsic = Number(call({})().intrinsicGas);
    expect(call({})().fuel).toBe(String(T.WASM_DEFAULT_FUEL));
    expect(codeOf(call({ gasLimit: intrinsic }))).toBe('INVALID_GAS_LIMIT'); // zero fuel traps every call
    expect(codeOf(call({ gasLimit: intrinsic + T.WASM_MIN_FUEL - 1 }))).toBe('INVALID_GAS_LIMIT');
    expect(call({ gasLimit: intrinsic + T.WASM_MIN_FUEL })().fuel).toBe(String(T.WASM_MIN_FUEL));
    expect(codeOf(call({ fuel: T.WASM_MIN_FUEL - 1 }))).toBe('INVALID_FUEL');
    expect(codeOf(call({ fuel: T.MAX_GAS_LIMIT }))).toBe('INVALID_FUEL');
    expect(codeOf(call({ fuel: 20000, gasLimit: 300000 }))).toBe('INVALID_FUEL');
    expect(call({ fuel: T.MAX_GAS_LIMIT - intrinsic })().gasLimit).toBe(String(T.MAX_GAS_LIMIT));
    // large input: the default budget shrinks to what is left under the cap, and a body the route cannot read is refused
    const big = call({ args: 'ab'.repeat(30000) })();
    expect(Number(big.gasLimit)).toBeLessThanOrEqual(T.MAX_GAS_LIMIT);
    expect(Number(big.fuel)).toBeGreaterThanOrEqual(T.WASM_MIN_FUEL);
    expect(codeOf(call({ args: 'ab'.repeat(70000) }))).toMatch(/^(INVALID_GAS_LIMIT|REQUEST_TOO_LARGE)$/);
    expect(call({ args: 'ABCD' })().args).toBe('abcd');
    for (const args of ['abc', 'zz', ['00'], 5]) expect(codeOf(call({ args }))).toBe('INVALID_ARGS');
    for (const method of ['', '1run', 'run-it', 'a'.repeat(65), 'rün', null]) expect(codeOf(call({ method }))).toBe('INVALID_METHOD');
  });

  it('only a WASM module within the deploy cap', () => {
    const deploy = (code) => () => T.buildContractDeploy({ from: FROM, code, nonce: 1 });
    expect(codeOf(deploy(hexBytes('0061736d')))).toBe('INVALID_CODE');
    expect(codeOf(deploy(hexBytes('0061736e01000000')))).toBe('INVALID_CODE');
    expect(codeOf(deploy('0061736d01000000'))).toBe('INVALID_CODE');
    const max = new Uint8Array(T.MAX_WASM_CODE_BYTES);
    max.set([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    expect(T.MAX_WASM_CODE_BYTES).toBe(24949);
    const tx = deploy(max)();
    expect(tx.deployData.length).toBe(2 * T.MAX_WASM_CODE_BYTES + 102);
    expect(tx.gasLimit).toBe(String(T.MAX_GAS_LIMIT)); // 500,000 + 10 × 50,000: exactly the cap
    expect(codeOf(deploy(new Uint8Array([...max, 0])))).toBe('CODE_TOO_LARGE');
    expect(codeOf(() => T.contractDeployRequestJson(tx, vector('contractDeploy').signature, null))).toBe('INVALID_PUBLIC_KEY');
  });

  it('call arguments that serde would write back differently', () => {
    for (const args of [{ a: 1 }, [1.5], [{}], ['\ud800'], [2 ** 53], [true]]) {
      expect(codeOf(() => T.contractCallData(TOKEN, 'transfer', args))).toBe('INVALID_ARGS');
    }
    expect(T.contractCallData(TOKEN, 'transfer', undefined)).toBe(`{"args":null,"contract":"${TOKEN}","method":"transfer"}`);
    expect(T.contractCallData(TOKEN, 'x', ['a"b\\c\n', 'ü😀', 7])).toBe(`{"args":["a\\"b\\\\c\\n","ü😀",7],"contract":"${TOKEN}","method":"x"}`);
  });
});

describe('the app signs and sends through the same builders', () => {
  const FROM = V.wallet.address;
  let captured;

  function wallet() {
    const { secretKey, publicKey } = ml_dsa65.keygen(hexBytes(shake256(kat.seed_string, 256)));
    const wm = new WalletManager();
    wm.loadWallet = jest.fn(async () => ({
      secretKey: new Uint8Array(64), qnetAddress: FROM, qnetKeypair: { publicKey: [...publicKey], privateKey: [...secretKey] },
    }));
    // The nonce plan is not what is under test here: sign at the vector's nonce and keep what would be sent.
    wm._signAndSubmit = jest.fn(async (from, sign, extra) => {
      const nonce = Number(captured.nonce);
      captured = { from, extra, ...(await sign(nonce)) };
      return { accepted: true, data: { success: true, tx_hash: 'ab'.repeat(32) }, nonce, replaced: false };
    });
    return wm;
  }

  beforeEach(() => {
    WalletManager.pkBound = {};
  });

  it('a QNC transfer: the vector\'s preimage, signature and body, key attached until the chain holds it', async () => {
    const v = vector('transfer');
    captured = { nonce: v.input.nonce };
    const r = await wallet().sendQNC(v.input.to, 1.5, 'pw');
    expect(r).toMatchObject({ success: true, nonce: 1, amountNano: 1500000000 });
    expect(require('../src/crypto/DilithiumCrypto').signDetached.mock.calls.at(-1)[0]).toBe(v.preimage);
    expect(captured.path).toBe(v.requestPath);
    expect(JSON.stringify(captured.body)).toBe(v.requestJson);
    expect(captured.pk).toBe(V.wallet.publicKey);
  });

  it('a token transfer: the vector\'s calldata, gas and body, key elided once the chain holds it', async () => {
    const v = vector('tokenTransfer');
    captured = { nonce: v.input.nonce };
    WalletManager.pkBound[FROM] = true;
    const wm = wallet();
    const r = await wm.qrc20Transfer(v.input.token, v.input.to, v.input.amount, 'pw');
    expect(r.submitNonce).toBe(2);
    expect(captured.path).toBe(v.requestPath);
    expect(JSON.stringify(captured.body)).toBe(v.requestJson);
    expect(captured.extra).toMatchObject({ kind: 'call', to: v.input.token, method: 'transfer', recipient: v.input.to, amountBase: v.input.amount });
    expect(wm.qrc20TransferFeeNano(v.input.token, v.input.to, v.input.amount)).toBe(Number(v.maxFeeNano));
    // amounts reach the calldata as the canonical u64 digits, whatever form they came in
    expect(wm._amt(1000000000n)).toBe('1000000000');
    expect(wm._amt('0001000000000')).toBe('1000000000');
    for (const bad of ['-1', '1.5', '18446744073709551616', 2 ** 53, -1, null]) expect(() => wm._amt(bad)).toThrow(/u64/);
  });
});
