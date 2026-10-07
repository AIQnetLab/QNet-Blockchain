// MOBNET-R1-02: the value a proof is verified over and the value the screen shows come from one strict parse of the
// answer. JSON.parse keeps the last of two equal keys and a regex takes the first textual match, so an answer with a
// nested or repeated "token_balance" could otherwise show one number beside a proof of another.
jest.mock('../src/crypto/DilithiumCrypto', () => ({ verifyDilithium: jest.fn(), isDilithiumAvailable: () => true }));

const { parseStrictJson, u64Text, StrictJsonError } = require('../src/utils/strictJson');
const { WalletManager } = require('../src/components/WalletManager');

describe('the strict reader', () => {
  it('refuses a repeated key at any depth, keeps nested ones apart, and allows nothing after the value', () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(StrictJsonError);
    expect(() => parseStrictJson('{"x":{"b":1,"b":1}}')).toThrow(StrictJsonError);
    expect(parseStrictJson('{"x":{"a":1},"a":2}')).toEqual({ x: { a: 1 }, a: 2 });
    expect(() => parseStrictJson('{"a":1} {"a":2}')).toThrow(StrictJsonError);
    expect(() => parseStrictJson("{'a':1}")).toThrow(StrictJsonError);
    expect(() => parseStrictJson('{"a":01}')).toThrow(StrictJsonError);
    expect(parseStrictJson('[1, "two", true, null, {"k": [ ]}]')).toEqual([1, 'two', true, null, { k: [] }]);
  });

  it('keeps an integer beyond 2^53 as its exact text, and a "__proto__" key as plain data', () => {
    const v = parseStrictJson('{"balance":18446744073709551615,"small":42,"f":1.5,"__proto__":{"polluted":true}}');
    expect(v.balance).toBe('18446744073709551615');
    expect(v.small).toBe(42);
    expect(v.f).toBe(1.5);
    expect(Object.prototype.hasOwnProperty.call(v, '__proto__')).toBe(true);
    expect({}.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(u64Text(v.balance)).toBe('18446744073709551615');
    expect(u64Text('18446744073709551616')).toBeNull();
    expect(u64Text(-1)).toBeNull();
    expect(u64Text(1.5)).toBeNull();
    expect(u64Text('007')).toBeNull();
  });
});

describe('a proof answer shows only what it proves', () => {
  const C = 'c'.repeat(64);
  const H = 'd9fa370374e24333242eon847d1d354dcd87fe873823e';
  const proofFields = `"contract_address":"${C}","holder":"${H}","storage_proof":[],"storage_root":"${'0'.repeat(64)}",`
    + `"account_proof":[],"account_balance":"0","account_nonce":0,"state_root":"${'a'.repeat(64)}","block_height":1000`;
  const answering = (text) => {
    const wm = new WalletManager();
    wm._hedged = jest.fn(async () => ({ ok: true, status: 200, data: text }));
    wm.verifyTokenBalanceProof = jest.fn(async () => true); // the proof checks out for the value it is given
    wm._certifiedFresh = jest.fn(async () => true);
    return wm;
  };

  it('a nested "token_balance" is not shown: the balance shown is the one the proof was verified over', async () => {
    const wm = answering(`{"x":{"token_balance":"500000000000"},"token_balance":"7",${proofFields}}`);
    const r = await wm.getTokenBalanceWithProof(C, H, 0);
    expect(r).toMatchObject({ ok: true, balance: '7', balanceBase: '7', verified: true });
    expect(wm.verifyTokenBalanceProof.mock.calls[0][0].token_balance).toBe('7');
  });

  it('a repeated "token_balance" refuses the whole answer', async () => {
    const wm = answering(`{"token_balance":"500000000000","token_balance":"7",${proofFields}}`);
    const r = await wm.getTokenBalanceWithProof(C, H, 0);
    expect(r).toMatchObject({ ok: false, verified: false });
    expect(wm.verifyTokenBalanceProof).not.toHaveBeenCalled();
  });

  it('the account balance proof reads its balance and nonce from the same parse, exactly past 2^53', async () => {
    const wm = new WalletManager();
    wm._hedged = jest.fn(async () => ({
      ok: true, status: 200,
      data: `{"x":{"balance":999,"nonce":999},"balance":9007199254740993,"nonce":3,"merkle_proof":[{"sibling":"00","is_right":true}],"state_root":"ab","block_height":90}`,
    }));
    wm.verifyMerkleProof = jest.fn(async () => true);
    wm._certifiedFresh = jest.fn(async () => true);
    const r = await wm.getQNCBalanceWithProof('addr');
    expect(r).toMatchObject({ ok: true, balanceNano: '9007199254740993', nonce: '3', verified: true });
    expect(wm.verifyMerkleProof.mock.calls[0].slice(1, 3)).toEqual(['9007199254740993', '3']);
    wm._hedged = jest.fn(async () => ({ ok: true, status: 200, data: '{"balance":1,"balance":2,"nonce":0}' }));
    expect(await wm.getQNCBalanceWithProof('addr')).toMatchObject({ ok: false });
  });
});
