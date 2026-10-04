/** Fixed-window counters, bounded. `hit` returns the seconds to wait when the key is over its limit, else 0. */
export class RateLimiter {
  private windows = new Map<string, { resetAt: number; count: number }>();
  constructor(private readonly maxKeys = 20_000) {}

  hit(key: string, limit: number, windowMs: number, now = Date.now()): number {
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) this.prune(now);
      // Still full of live windows (a flood from many addresses): treat the newcomer as limited rather than forget anyone.
      if (this.windows.size >= this.maxKeys) return Math.ceil(windowMs / 1000);
      this.windows.set(key, (w = { resetAt: now + windowMs, count: 0 }));
    }
    w.count++;
    return w.count > limit ? Math.max(1, Math.ceil((w.resetAt - now) / 1000)) : 0;
  }
  /** How many hits this key has in its current window (without counting one). */
  count(key: string, now = Date.now()): number {
    const w = this.windows.get(key);
    return w && w.resetAt > now ? w.count : 0;
  }
  prune(now = Date.now()) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }
}
