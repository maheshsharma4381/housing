// A per-key sliding-window limit, kept in the server's memory. It is a guard against a script hammering
// a route that calls a third-party service, not an exact quota: each server instance counts on its own.

const MAX_KEYS = 10_000;

/** `take(key)` is true when the key may go ahead now (and counts it), false when it has used its `limit` this window. */
export function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now: number = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter(t => t > now - windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > MAX_KEYS) {
      // forget keys with nothing recent, so the map cannot grow without end
      for (const [k, times] of hits) if (!times.some(t => t > now - windowMs)) hits.delete(k);
    }
    return true;
  };
}
