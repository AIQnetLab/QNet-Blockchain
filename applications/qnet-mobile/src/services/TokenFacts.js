/**
 * A token's facts for its own screen (screens/TokenScreens), each from the source the app already reads that asset from;
 * a part with no readable answer is left out, never guessed. Amounts are exact decimal text in the token's units.
 */
import { solanaRpc } from './SolanaSend';
import { SOL_DECIMALS, decodeKey, fromBaseUnits } from '../crypto/SolanaTx';
import { EXPLORER_API, FIRST_CONTACT_MS } from '../config/nodes';
import { boundedGetJson } from '../utils/boundedFetch';
import logger from '../utils/logger';

const QNC_DECIMALS = 9;
// The ten largest holders the explorer index lists, and the most its answer for them can take.
const TOP_HOLDERS = 10;
const HOLDERS_MAX_BYTES = 16384;

// Base units as decimal text: a digit string, or a whole number a JSON answer kept exact.
const digits = (v) => (typeof v === 'string' && /^\d{1,40}$/.test(v) ? v : (Number.isSafeInteger(v) && v >= 0 ? String(v) : null));
const scaled = (base, decimals) => (base === null ? null : fromBaseUnits(BigInt(base), decimals));
// A mint's authority: its address, null when the mint has none (no one can), undefined when the answer is unreadable.
const authority = (v) => {
  if (v === null) return null;
  return typeof v === 'string' && decodeKey(v) ? v : undefined;
};
// What a token allows, one shape for both networks, for the parts its source answered: { [what]: { open, by } }, `by`
// the address that may do it, null when the source names none; a part whose `open` is no boolean is left out.
const allowed = (parts) => Object.fromEntries(Object.entries(parts)
  .filter(([, [open]]) => typeof open === 'boolean')
  .map(([what, [open, by]]) => [what, { open, by: open && by ? by : null }]));

async function qncFacts(walletManager) {
  const s = await walletManager.getQncSupply();
  if (!s) return {};
  return { totalSupply: scaled(s.totalNano, QNC_DECIMALS), circulating: scaled(s.circulatingNano, QNC_DECIMALS), holders: s.holders };
}

// A QNet token's holders as the explorer index History reads replays its transfers: their count and the share of the
// supply the ten largest hold, in percent to two decimals ('87.53'); neither when the index cut its replay short, knows
// no holder or gave no readable answer, the share alone left out when its balances do not add up.
async function indexHolders(contract, getJson) {
  let body = null;
  try {
    body = await getJson(`${EXPLORER_API}/api/token/${encodeURIComponent(contract)}/holders?limit=${TOP_HOLDERS}`,
      { timeoutMs: FIRST_CONTACT_MS, maxBytes: HOLDERS_MAX_BYTES });
  } catch (_) {
    return {};
  }
  const d = body && body.success === true ? body.data : null;
  if (!d || d.truncated !== false || !Number.isSafeInteger(d.holder_count) || d.holder_count < 1) return {};
  const supply = digits(d.circulating_raw);
  const top = Array.isArray(d.holders) ? d.holders.map((h) => digits(h && h.balance_raw)) : [];
  if (supply === null || supply === '0' || top.includes(null) || top.length !== Math.min(TOP_HOLDERS, d.holder_count)) {
    return { holders: d.holder_count };
  }
  const held = top.reduce((sum, v) => sum + BigInt(v), 0n);
  if (held > BigInt(supply)) return { holders: d.holder_count };
  const bp = (held * 10000n) / BigInt(supply);
  return { holders: d.holder_count, top10: `${bp / 100n}.${String(bp % 100n).padStart(2, '0')}` };
}

// Scaled by the decimals the wallet's token list holds for it, as every figure of the token. A transfer to the burn
// address destroys any token, so whether holders may burn their own says nothing and is not read. The node's facts go
// to `onFacts` as soon as it answers: the index's holders, read meanwhile, never hold them back.
async function qnetTokenFacts(walletManager, asset, getJson, onFacts) {
  const held = indexHolders(asset.contract, getJson);
  const info = await walletManager.getTokenInfo(asset.contract);
  let node = {};
  if (info) {
    const decimals = Number.isInteger(asset.decimals) ? asset.decimals : info.decimals;
    node = {
      totalSupply: scaled(digits(info.totalSupply), decimals),
      createdAt: info.deployedAt,
      creator: info.deployer,
      ...allowed({
        mint: [info.mintable, info.mintAuthority],
        metadata: [info.metadataMutable],
        freeze: [info.freezable],
      }),
    };
  }
  if (onFacts) onFacts(node);
  return { ...node, ...(await held) };
}

async function solFacts(rpc) {
  const r = await rpc('getSupply', [{ commitment: 'confirmed', excludeNonCirculatingAccountsList: true }]);
  const v = r && r.value;
  if (!v) return {};
  return { totalSupply: scaled(digits(v.total), SOL_DECIMALS), circulating: scaled(digits(v.circulating), SOL_DECIMALS) };
}

async function mintFacts(rpc, asset) {
  const r = await rpc('getAccountInfo', [asset.mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const parsed = r && r.value && r.value.data && r.value.data.parsed;
  const info = parsed && parsed.type === 'mint' ? parsed.info : null;
  if (!info || typeof info !== 'object') return {};
  const mint = authority(info.mintAuthority);
  const freeze = authority(info.freezeAuthority);
  return {
    totalSupply: scaled(digits(info.supply), asset.decimals),
    ...allowed({
      mint: [mint === undefined ? undefined : mint !== null, mint],
      freeze: [freeze === undefined ? undefined : freeze !== null, freeze],
    }),
  };
}

/**
 * The facts of `asset`: { totalSupply, circulating, holders, top10, createdAt (ms), creator, mint, metadata, freeze },
 * each only when a source gave it. mint (more issued), metadata (name and symbol changed), freeze: { open, by }, `by`
 * who may. `getJson` reads the explorer index (utils/boundedFetch boundedGetJson). `onFacts`, when given, hears a QNet
 * token's node facts as soon as they come, before the index's holders.
 */
export async function tokenFacts(asset, { walletManager, rpc = solanaRpc, getJson = boundedGetJson, onFacts = null } = {}) {
  try {
    if (asset.network === 'solana') return asset.mint ? await mintFacts(rpc, asset) : await solFacts(rpc);
    return asset.contract ? await qnetTokenFacts(walletManager, asset, getJson, onFacts) : await qncFacts(walletManager);
  } catch (e) {
    logger.warn(`[WARN][TOKEN] facts_read_failed network=${asset.network} err=${e && e.message}`);
    return {};
  }
}
