/**
 * Which websites this wallet is connected to (the in-app browser's per-origin grants). One record under
 * AsyncStorage `qnet_dapp_sites`, sealed under the vault's data key (WalletManager.putSealedRecord: AES-GCM
 * with the vault id and its purpose in the AAD), so nothing written to storage by anyone else can pose as a
 * grant, and a record of another wallet does not open. Wallet-scoped: cleared when the wallet on the phone
 * changes or is deleted (WalletManager.WALLET_SCOPED_KEYS).
 *
 * Record: { v: 1, sites: { [origin]: { grantedAt, chains: ['qnet', 'solana'], walletId } } }.
 */
import { canonicalOrigin } from './url';

export const SITES_KEY = 'qnet_dapp_sites';
export const SITES_PURPOSE = 'dapp-sites';
const MAX_SITES = 200;

function validEntry(origin, entry, dev) {
  return canonicalOrigin(origin, { dev }) === origin && entry && typeof entry === 'object'
    && Number.isSafeInteger(entry.grantedAt) && entry.grantedAt > 0
    && Array.isArray(entry.chains) && entry.chains.join(',') === 'qnet,solana'
    && typeof entry.walletId === 'string' && entry.walletId.length > 0;
}

/**
 * Grants of this wallet. `wm` is the WalletManager, `credential()` returns the open session's token; every
 * call needs the wallet unlocked and throws otherwise.
 */
export function createGrantStore(wm, credential, { dev = false, now = () => Date.now() } = {}) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function readAll() {
    const rec = await wm.getSealedRecord(SITES_KEY, SITES_PURPOSE, credential());
    const sites = {};
    if (rec && rec.v === 1 && rec.sites && typeof rec.sites === 'object') {
      for (const [origin, entry] of Object.entries(rec.sites)) {
        if (validEntry(origin, entry, dev)) {
          sites[origin] = { grantedAt: entry.grantedAt, chains: ['qnet', 'solana'], walletId: entry.walletId };
        }
      }
    }
    return sites;
  }

  async function writeAll(sites) {
    const ok = await wm.putSealedRecord(SITES_KEY, { v: 1, sites }, SITES_PURPOSE, credential());
    if (!ok) throw new Error('The wallet changed');
  }

  return {
    async get(origin) {
      const sites = await readAll();
      return Object.prototype.hasOwnProperty.call(sites, origin) ? sites[origin] : null;
    },
    put(origin, walletId) {
      return serial(async () => {
        if (canonicalOrigin(origin, { dev }) !== origin) throw new Error('Not an origin');
        const sites = await readAll();
        sites[origin] = { grantedAt: now(), chains: ['qnet', 'solana'], walletId };
        const kept = Object.entries(sites).sort((a, b) => b[1].grantedAt - a[1].grantedAt).slice(0, MAX_SITES);
        await writeAll(Object.fromEntries(kept));
      });
    },
    remove(origin) {
      return serial(async () => {
        const sites = await readAll();
        if (!Object.prototype.hasOwnProperty.call(sites, origin)) return false;
        delete sites[origin];
        await writeAll(sites);
        return true;
      });
    },
    /** [{ origin, grantedAt }], newest first. */
    async list() {
      const sites = await readAll();
      return Object.entries(sites).map(([origin, e]) => ({ origin, grantedAt: e.grantedAt }))
        .sort((a, b) => b.grantedAt - a.grantedAt);
    },
  };
}
