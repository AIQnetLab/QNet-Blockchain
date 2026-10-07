// A small cache for the cabinet's reads: one upstream round in flight per key, answers kept for `ttlMs` (a number, or
// one per answer: a route keeps "not registered" longer than a status that moves), a bounded size (the oldest entry
// goes). `keep` decides which answers are worth keeping (failures are asked again). `has(key)`: whether a read of the key
// now would be answered without going upstream (a kept answer still fresh, or a round in flight), so a route can charge
// only the reads that go upstream to the client.

const CACHE_ENTRIES = 5_000;

export interface Memo<T> {
  (key: string, load: () => Promise<T>, keep: (value: T) => boolean): Promise<T>;
  has(key: string): boolean;
}

export function memo<T>(ttlMs: number | ((value: T) => number), now: () => number, entries: number = CACHE_ENTRIES): Memo<T> {
  const done = new Map<string, { until: number; value: T }>();
  const pending = new Map<string, Promise<T>>();
  const ttl = typeof ttlMs === 'number' ? () => ttlMs : ttlMs;
  const fresh = (key: string) => {
    const hit = done.get(key);
    return hit !== undefined && now() < hit.until ? hit : null;
  };
  const read = async (key: string, load: () => Promise<T>, keep: (value: T) => boolean): Promise<T> => {
    const hit = fresh(key);
    if (hit) return hit.value;
    let p = pending.get(key);
    if (!p) {
      p = load().finally(() => pending.delete(key));
      pending.set(key, p);
    }
    const value = await p;
    if (keep(value)) {
      done.delete(key);
      if (done.size >= entries) done.delete(done.keys().next().value as string);
      done.set(key, { until: now() + ttl(value), value });
    }
    return value;
  };
  return Object.assign(read, { has: (key: string) => fresh(key) !== null || pending.has(key) });
}
