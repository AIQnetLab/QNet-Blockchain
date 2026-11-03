// A small cache for the cabinet's reads: one upstream round in flight per key, answers kept for `ttlMs` (a number, or
// one per answer: a route keeps "not registered" longer than a status that moves), a bounded size (the oldest entry
// goes). `keep` decides which answers are worth keeping (failures are asked again). `has(key)`: whether a read of the key
// now would be answered without going upstream (a kept answer still fresh, or a round in flight), so a route can charge
// only the reads that go upstream to the client. `refresh`: a new round whatever is kept or in flight, for a read that
// must not be answered from before it was asked; its answer takes the kept one's place, and an older round's never does.

const CACHE_ENTRIES = 5_000;

export interface Memo<T> {
  (key: string, load: () => Promise<T>, keep: (value: T) => boolean): Promise<T>;
  has(key: string): boolean;
  refresh(key: string, load: () => Promise<T>, keep: (value: T) => boolean): Promise<T>;
}

export function memo<T>(ttlMs: number | ((value: T) => number), now: () => number, entries: number = CACHE_ENTRIES): Memo<T> {
  type Round = { at: number; value: Promise<T> };
  const done = new Map<string, { until: number; value: T; at: number }>();
  const pending = new Map<string, Round>();
  const ttl = typeof ttlMs === 'number' ? () => ttlMs : ttlMs;
  const fresh = (key: string) => {
    const hit = done.get(key);
    return hit !== undefined && now() < hit.until ? hit : null;
  };
  const start = (key: string, load: () => Promise<T>): Round => {
    const round: Round = {
      at: now(),
      value: load().finally(() => {
        if (pending.get(key) === round) pending.delete(key);
      }),
    };
    pending.set(key, round);
    return round;
  };
  const settle = async (key: string, round: Round, keep: (value: T) => boolean): Promise<T> => {
    const value = await round.value;
    const kept = done.get(key);
    if (keep(value) && !(kept !== undefined && kept.at > round.at)) {
      done.delete(key);
      if (done.size >= entries) done.delete(done.keys().next().value as string);
      done.set(key, { until: now() + ttl(value), value, at: round.at });
    }
    return value;
  };
  const read = async (key: string, load: () => Promise<T>, keep: (value: T) => boolean): Promise<T> => {
    const hit = fresh(key);
    if (hit) return hit.value;
    return settle(key, pending.get(key) ?? start(key, load), keep);
  };
  const refresh = (key: string, load: () => Promise<T>, keep: (value: T) => boolean): Promise<T> => settle(key, start(key, load), keep);
  return Object.assign(read, { has: (key: string) => fresh(key) !== null || pending.has(key), refresh });
}
