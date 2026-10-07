// The new-password rule of both wallets: at least PASSWORD_MIN_LENGTH characters, typed twice (each screen compares
// the two). Nothing else is checked. The password of an existing wallet is never checked again: it keeps opening the
// wallet it was made for, whatever its length.
// The one copy: the app imports it and the extension's qnet-core bundle compiles it.

export const PASSWORD_MIN_LENGTH = 8;

/**
 * Whether `password` is too short to seal a new wallet.
 * @param {string} password
 * @returns {boolean}
 */
export function passwordTooShort(password) {
  return typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH;
}
