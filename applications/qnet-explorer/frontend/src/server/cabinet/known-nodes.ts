// The node ids this process has seen the network list as registered (SITE M-12): their reads go on the `readKnown`
// budget of each genesis node, every other id on the small `readUnknown` one (upstream.ts), so made-up ids, which cost
// nothing, can drain only the reads of ids nobody has seen registered yet. An id is kept KNOWN_MS after it was last seen
// registered, at most KNOWN_MAX of them (the one seen longest ago goes first), with nothing of who read it. In memory
// only, a day at most, as the privacy policy says of the server's request details: after a restart every id reads as
// unknown until the network lists it again.

export const KNOWN_MS = 86_400_000;
export const KNOWN_MAX = 200_000;

export interface KnownNodes {
  has(nodeId: string): boolean;
  // The network listed it as registered now.
  note(nodeId: string): void;
}

export function createKnownNodes({ now = Date.now, max = KNOWN_MAX, ttlMs = KNOWN_MS }: { now?: () => number; max?: number; ttlMs?: number } = {}): KnownNodes {
  // Insertion order is the order ids were last seen.
  const seen = new Map<string, number>();
  return {
    has(nodeId) {
      const at = seen.get(nodeId);
      if (at === undefined) return false;
      if (now() - at < ttlMs) return true;
      seen.delete(nodeId);
      return false;
    },
    note(nodeId) {
      seen.delete(nodeId);
      if (seen.size >= max) seen.delete(seen.keys().next().value as string);
      seen.set(nodeId, now());
    },
  };
}

// The process's set, on globalThis so the node and wallet routes share one.
const GLOBAL_KEY = Symbol.for('qnet.cabinetKnownNodes');

export function knownNodes(): KnownNodes {
  const holder = globalThis as unknown as Record<symbol, KnownNodes | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const created = createKnownNodes();
  holder[GLOBAL_KEY] = created;
  return created;
}
