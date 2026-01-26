/**
 * QNet Explorer Cache v2.102
 * SYNCHRONOUS in-memory + sessionStorage cache for instant data display
 * 
 * v2.102: Fixed flash/flicker by using synchronous initialization
 */

// Cache TTL: 5 minutes
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_KEY = 'qnet_explorer_cache_v5';

// In-memory cache - initialized SYNCHRONOUSLY
const memoryCache: Map<string, { data: unknown; timestamp: number }> = new Map();

// Track if initialized
let initialized = false;

// Types
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

interface StoredCache {
  addresses: Record<string, CacheEntry<unknown>>;
  transactions: Record<string, CacheEntry<unknown>>;
  blocks: Record<string, CacheEntry<unknown>>;
}

// SYNCHRONOUS initialization - called on first getCache
function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  
  if (typeof window === 'undefined') return;
  
  try {
    const stored = sessionStorage.getItem(CACHE_KEY);
    if (stored) {
      const parsed: StoredCache = JSON.parse(stored);
      const now = Date.now();
      
      Object.entries(parsed.addresses || {}).forEach(([key, entry]) => {
        if (now - entry.timestamp < CACHE_TTL) {
          memoryCache.set(`address:${key}`, entry);
        }
      });
      
      Object.entries(parsed.transactions || {}).forEach(([key, entry]) => {
        if (now - entry.timestamp < CACHE_TTL) {
          memoryCache.set(`tx:${key}`, entry);
        }
      });
      
      Object.entries(parsed.blocks || {}).forEach(([key, entry]) => {
        if (now - entry.timestamp < CACHE_TTL) {
          memoryCache.set(`block:${key}`, entry);
        }
      });
    }
  } catch {
    // Ignore storage errors
  }
}

// Save to sessionStorage (debounced)
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
function saveToStorage(): void {
  if (typeof window === 'undefined') return;
  
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const addresses: Record<string, CacheEntry<unknown>> = {};
      const transactions: Record<string, CacheEntry<unknown>> = {};
      const blocks: Record<string, CacheEntry<unknown>> = {};
      
      memoryCache.forEach((entry, key) => {
        if (key.startsWith('address:')) {
          addresses[key.replace('address:', '')] = entry;
        } else if (key.startsWith('tx:')) {
          transactions[key.replace('tx:', '')] = entry;
        } else if (key.startsWith('block:')) {
          blocks[key.replace('block:', '')] = entry;
        }
      });
      
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ addresses, transactions, blocks }));
    } catch {
      // Ignore storage errors
    }
  }, 100);
}

/**
 * Get cached data instantly (sync) - ensures cache is initialized first
 */
export function getCache<T>(type: 'address' | 'tx' | 'block', key: string): T | null {
  ensureInitialized(); // CRITICAL: sync init before first read
  
  const cacheKey = `${type}:${key}`;
  const entry = memoryCache.get(cacheKey);
  
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data as T;
  }
  
  return null;
}

/**
 * Set cache data
 */
export function setCache<T>(type: 'address' | 'tx' | 'block', key: string, data: T): void {
  const cacheKey = `${type}:${key}`;
  memoryCache.set(cacheKey, { data, timestamp: Date.now() });
  
  // Debounced save to storage
  if (typeof window !== 'undefined') {
    clearTimeout((window as unknown as { _cacheSaveTimeout?: NodeJS.Timeout })._cacheSaveTimeout);
    (window as unknown as { _cacheSaveTimeout?: NodeJS.Timeout })._cacheSaveTimeout = setTimeout(saveToStorage, 100);
  }
}

/**
 * Check if cache is stale (older than TTL/2 = 2.5 min)
 * Returns true if data should be refreshed in background
 */
export function isCacheStale(type: 'address' | 'tx' | 'block', key: string): boolean {
  const cacheKey = `${type}:${key}`;
  const entry = memoryCache.get(cacheKey);
  
  if (!entry) return true;
  
  return Date.now() - entry.timestamp > CACHE_TTL / 2;
}

/**
 * Batch cache multiple items (e.g., from list views)
 */
export function batchCache<T>(type: 'address' | 'tx' | 'block', items: Array<{ key: string; data: T }>): void {
  const now = Date.now();
  
  items.forEach(({ key, data }) => {
    const cacheKey = `${type}:${key}`;
    memoryCache.set(cacheKey, { data, timestamp: now });
  });
  
  saveToStorage();
}

/**
 * Clear all cache (useful for debugging)
 */
export function clearCache(): void {
  memoryCache.clear();
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem(CACHE_KEY);
  }
}

