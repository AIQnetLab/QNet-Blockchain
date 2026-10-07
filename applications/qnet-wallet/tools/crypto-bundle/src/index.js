// qnet-core: the one crypto module of the QNet wallet extension. Named exports and the default export
// are the same deep-frozen values; nothing a caller does can replace a primitive another caller uses.
import * as activation from './activation.js';
import * as bytes from './bytes.js';
import * as config from './config.js';
import { CoreError } from './errors.js';
import * as hashes from './hashes.js';
import * as http from './http.js';
import * as lightclient from './lightclient.js';
import * as message from './message.js';
import * as mnemonic from './mnemonic.js';
import * as node from './node.js';
import * as password from './password.js';
import * as selftest from './selftest.js';
import * as solana from './solana.js';
import * as token from './token.js';
import * as tx from './tx.js';
import * as wallet from './wallet.js';

export const CORE_VERSION = '3.1.0';

function deepFreeze(value, seen = new Set()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (seen.has(value) || ArrayBuffer.isView(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return value;
}

function assemble(...modules) {
  const api = Object.create(null);
  for (const mod of modules) {
    for (const [name, value] of Object.entries(mod)) {
      if (name in api) throw new Error(`qnet-core: duplicate export ${name}`);
      api[name] = value;
    }
  }
  return deepFreeze(api);
}

const QNetCore = assemble(
  { CORE_VERSION, CoreError },
  activation, bytes, config, hashes, http, lightclient, message, mnemonic, node, password, selftest, solana, token, tx,
  wallet,
);

export default QNetCore;
export { CoreError };
export * from './activation.js';
export * from './bytes.js';
export * from './config.js';
export * from './hashes.js';
export * from './http.js';
export * from './lightclient.js';
export * from './message.js';
export * from './mnemonic.js';
export * from './node.js';
export * from './password.js';
export * from './selftest.js';
export * from './solana.js';
export * from './token.js';
export * from './tx.js';
export * from './wallet.js';
