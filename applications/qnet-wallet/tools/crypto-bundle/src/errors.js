// Every failure the core reports carries a stable code and a generic message: no key material, mnemonic
// word, address or amount is ever placed in an error.
export class CoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CoreError';
    this.code = code;
  }
}

export const fail = (code) => {
  throw new CoreError(code);
};
