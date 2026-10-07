/**
 * Which nodes the wallet may ask for what.
 *
 * A validator list is whatever the answering node says it is, and every endpoint in it was chosen by that
 * node's operator, so no list is ever trusted wholesale:
 *  - The five genesis names are compiled in and are always in the pool; no answer can remove them.
 *  - Another endpoint joins only when at least two genesis nodes list it, each answer counted once. The
 *    pool is never seeded from itself, so one bad answer cannot take it over, now or on a later round.
 *  - Server reputation is ignored and a node's last_seen is clamped to this device's clock; an endpoint
 *    stays only while the genesis nodes keep listing it.
 *  - An endpoint must be https on the default port under a DNS name (config/nodes canonicalNodeUrl).
 *
 * A listed third-party endpoint is used only for reads the wallet checks against a committee-certified
 * checkpoint (balance and token proofs, macroblock proofs, registry snapshots): a lying node there can make
 * a check fail, never pass. Writes, registration, token refresh, ping answers, anything that carries a
 * device identifier, and every read nothing proves go to the genesis names only.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GENESIS_NODES_HTTPS, canonicalNodeUrl, isGenesisNodeUrl } from '../config/nodes';

export const POOL_KEY = 'qnet_node_pool';
export const LEGACY_POOL_KEY = 'qnet_discovered_nodes'; // older builds: a pool one node's answer could replace
export const MIN_GENESIS_AGREEMENT = 2;
export const MAX_DISCOVERED = 64;
export const LIVE_SECS = 600;                 // a row last seen longer ago than this is not listed
export const ENDPOINT_TTL_SECS = 6 * 3600;    // an endpoint no round re-confirms drops out after this
export const DISCOVERY_INTERVAL_MS = 30 * 60 * 1000;

const nowSecs = () => Math.floor(Date.now() / 1000);

/** A validator row's endpoint as the app would call it, or null: inactive, not HTTPS by name, or a genesis. */
export function endpointOf(v, nowSec = nowSecs()) {
  if (!v || typeof v !== 'object' || v.is_active === false || v.is_synced === false) return null;
  const lastSeen = Math.min(Number(v.last_seen) || 0, nowSec);
  if (nowSec - lastSeen > LIVE_SECS) return null;
  const url = canonicalNodeUrl(v.address);
  if (!url || isGenesisNodeUrl(url)) return null;
  return url;
}

/**
 * Endpoints that at least `min` of the genesis answers list. `answers` are the /validators/proof bodies
 * returned by distinct genesis nodes; an answer listing an endpoint twice counts once.
 */
export function agreedEndpoints(answers, nowSec = nowSecs(), min = MIN_GENESIS_AGREEMENT) {
  const counts = new Map();
  for (const a of answers || []) {
    const rows = a && Array.isArray(a.validators) ? a.validators : [];
    const listed = new Set();
    for (const v of rows) {
      const url = endpointOf(v, nowSec);
      if (url) listed.add(url);
    }
    for (const url of listed) counts.set(url, (counts.get(url) || 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= min).map(([url]) => ({ url, confirmedAt: nowSec }));
}

/** Stored endpoints still fit to use: well-formed, not a genesis, confirmed recently by this device. */
export function freshEndpoints(list, nowSec = nowSecs()) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    const url = e && canonicalNodeUrl(e.url);
    const at = Math.min(Number(e && e.confirmedAt) || 0, nowSec);
    if (!url || url !== e.url || isGenesisNodeUrl(url) || seen.has(url) || nowSec - at >= ENDPOINT_TTL_SECS) continue;
    seen.add(url);
    out.push({ url, confirmedAt: at });
  }
  return out;
}

/** A round's agreed endpoints merged into what the device already holds; newest confirmations win the cap. */
export function mergeEndpoints(prev, agreed, nowSec = nowSecs()) {
  const byUrl = new Map();
  for (const e of freshEndpoints(prev, nowSec)) byUrl.set(e.url, e);
  for (const e of freshEndpoints(agreed, nowSec)) byUrl.set(e.url, e);
  return [...byUrl.values()].sort((a, b) => b.confirmedAt - a.confirmedAt).slice(0, MAX_DISCOVERED);
}

/** Every node a proof-checked read may go to: the genesis names first, then the agreed endpoints. */
export function readPoolUrls(discovered, nowSec = nowSecs()) {
  return [...GENESIS_NODES_HTTPS, ...freshEndpoints(discovered, nowSec).map((e) => e.url)];
}

export async function loadDiscovered() {
  try {
    const legacy = await AsyncStorage.getItem(LEGACY_POOL_KEY);
    if (legacy !== null) await AsyncStorage.removeItem(LEGACY_POOL_KEY);
    return freshEndpoints(JSON.parse((await AsyncStorage.getItem(POOL_KEY)) || '[]'));
  } catch (_) {
    return [];
  }
}

export async function saveDiscovered(list) {
  try {
    await AsyncStorage.setItem(POOL_KEY, JSON.stringify(freshEndpoints(list)));
  } catch (_) { /* the next round writes it again */ }
}
