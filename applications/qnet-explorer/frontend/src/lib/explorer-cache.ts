/**
 * Explorer record cache: the addresses, transactions and blocks a visitor opened, kept in this tab's memory
 * for 5 minutes so client-side navigation shows them at once. Memory only: nothing is written to the
 * browser's storage, so a shared computer keeps no trace of what was looked up once the tab is closed or
 * reloaded (the privacy policy says the site stores only the address-view preference).
 */

// Cache TTL: 5 minutes
const CACHE_TTL = 5 * 60 * 1000;
// The sessionStorage key earlier versions wrote; removed once from a tab still holding it.
const LEGACY_STORAGE_KEY = 'qnet_explorer_cache_v5';

type CacheType = 'address' | 'tx' | 'block';

const memoryCache: Map<string, { data: unknown; timestamp: number }> = new Map();
let legacyCleared = false;

function clearLegacyStorage(): void {
  if (legacyCleared || typeof window === 'undefined') return;
  legacyCleared = true;
  try {
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing was kept there either.
  }
}

/**
 * Cached data, or null when absent or older than the TTL.
 */
export function getCache<T>(type: CacheType, key: string): T | null {
  clearLegacyStorage();
  const entry = memoryCache.get(`${type}:${key}`);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data as T;
  }
  return null;
}

export function setCache<T>(type: CacheType, key: string, data: T): void {
  clearLegacyStorage();
  memoryCache.set(`${type}:${key}`, { data, timestamp: Date.now() });
}

/**
 * Check if cache is stale (older than TTL/2 = 2.5 min)
 * Returns true if data should be refreshed in background
 */
export function isCacheStale(type: CacheType, key: string): boolean {
  const entry = memoryCache.get(`${type}:${key}`);
  if (!entry) return true;
  return Date.now() - entry.timestamp > CACHE_TTL / 2;
}

/**
 * Batch cache multiple items (e.g., from list views)
 */
export function batchCache<T>(type: CacheType, items: Array<{ key: string; data: T }>): void {
  clearLegacyStorage();
  const now = Date.now();
  items.forEach(({ key, data }) => {
    memoryCache.set(`${type}:${key}`, { data, timestamp: now });
  });
}

export function clearCache(): void {
  memoryCache.clear();
}

// ============================================================================
// Activity-list cache (in-memory; survives client-side navigation, not reload).
// Stale-while-revalidate: callers render cached rows INSTANTLY, then refresh.
// Keyed by the query signature: `${sort}|${filters}|${page}`.
// ============================================================================
const listCache = new Map<string, { data: unknown; total: number; height: number; timestamp: number }>();
let lastChainHeight = 0;

export function getListCache(key: string): { data: unknown; total: number; height: number } | null {
  const e = listCache.get(key);
  if (!e || Date.now() - e.timestamp > CACHE_TTL) return null;
  return { data: e.data, total: e.total, height: e.height };
}

export function setListCache(key: string, data: unknown, total: number, height: number): void {
  listCache.set(key, { data, total, height, timestamp: Date.now() });
}

// Detect a chain reset (DB wiped to 0 / fresh genesis): if the live height drops
// below what we've seen, every cached row/balance is stale — wipe ALL caches.
// Returns true when a reset is detected so the caller can render fresh data.
export function noteChainHeight(height: number): boolean {
  if (height <= 0) return false;
  // Reset = a big drop (to ~0). A bounded reorg/jitter is a few blocks — ignore those.
  if (lastChainHeight > 100 && height < lastChainHeight - 100) {
    listCache.clear();
    clearCache();
    lastChainHeight = height;
    return true;
  }
  if (height > lastChainHeight) lastChainHeight = height;
  return false;
}
