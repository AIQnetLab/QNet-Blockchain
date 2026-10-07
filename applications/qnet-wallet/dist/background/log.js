// The only place shipped code may reach the console. Silent in the store build; dist-dev/ turns it on.
// Callers pass codes and short tags, never secrets, addresses, amounts or activation codes (R21).
import { DEV_BUILD } from './config.js';

const noop = () => {};
const sink = DEV_BUILD ? globalThis.console : null;
const writer = (level) => (sink ? (...args) => sink[level]('[qnet-wallet]', ...args) : noop);

export const log = Object.freeze({
  debug: writer('debug'),
  info: writer('info'),
  warn: writer('warn'),
  error: writer('error'),
});
