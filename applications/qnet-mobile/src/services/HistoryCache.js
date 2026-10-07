/**
 * The confirmed transaction history kept on the device, per wallet, so a wallet shows its rows at once when
 * it is opened again (utils/txHistory decides which rows qualify). One AsyncStorage value holds every
 * wallet's rows, each tagged with its address, so no key name carries an address. Older builds kept one key
 * per address (qnet_tx_history_<address>); those keys move here at the first read.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const HISTORY_CACHE_KEY = 'qnet_tx_history';
const LEGACY_PREFIX = 'qnet_tx_history_';
export const MAX_WALLETS = 3; // the most recently used wallets keep a cache; one value stays small

const lc = (s) => String(s || '').toLowerCase();

let queue = Promise.resolve();
// Writes run one at a time: two refreshes finishing together must not drop each other's rows.
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

async function readAll() {
  try {
    const v = JSON.parse((await AsyncStorage.getItem(HISTORY_CACHE_KEY)) || '[]');
    return Array.isArray(v) ? v.filter((e) => e && typeof e.owner === 'string' && Array.isArray(e.rows)) : [];
  } catch (_) {
    return [];
  }
}

async function writeWallet(all, owner, rows) {
  const next = [{ owner, rows }, ...all.filter((e) => e.owner !== owner)].slice(0, MAX_WALLETS);
  await AsyncStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(next));
}

// Older builds' per-address keys: moved into the one value (this wallet's first), then removed.
async function absorbLegacy(all, owner) {
  let keys = [];
  try { keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(LEGACY_PREFIX)); } catch (_) { return all; }
  if (keys.length === 0) return all;
  const found = [];
  for (const [k, v] of await AsyncStorage.multiGet(keys)) {
    let rows = null;
    try { rows = JSON.parse(v); } catch (_) { rows = null; }
    if (Array.isArray(rows)) found.push({ owner: k.slice(LEGACY_PREFIX.length), rows });
  }
  found.sort((a, b) => (a.owner === owner ? -1 : 0) - (b.owner === owner ? -1 : 0));
  let next = all;
  for (const e of found.reverse()) {
    if (!next.some((x) => x.owner === e.owner)) next = [e, ...next];
  }
  next = next.slice(0, MAX_WALLETS);
  await AsyncStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(next));
  await AsyncStorage.multiRemove(keys);
  return next;
}

/** The cached rows of `address`, or []. */
export function loadCachedHistory(address) {
  const owner = lc(address);
  return serial(async () => {
    const all = await absorbLegacy(await readAll(), owner).catch(() => readAll());
    const hit = all.find((e) => e.owner === owner);
    return hit ? hit.rows : [];
  });
}

/** Replaces the cached rows of `address`. */
export function saveCachedHistory(address, rows) {
  const owner = lc(address);
  return serial(async () => writeWallet(await readAll(), owner, Array.isArray(rows) ? rows : []));
}
