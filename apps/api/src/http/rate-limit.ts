export class ScanLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now = Date.now) {}
  /** Forgets every attempt. The debug reset uses it; production never calls it. */
  clear(): void { this.hits.clear(); }
  check(ip: string, email: string): { allowed: boolean; retryAfter: number } {
    const now = this.now();
    for (const [key, hits] of this.hits) {
      const fresh = hits.filter(t => now - t < 3_600_000);
      if (!fresh.length) this.hits.delete(key); else this.hits.set(key, fresh);
    }
    const limits = [[`ip:${ip}`, 10], [`email:${email.toLowerCase()}`, 3]] as const;
    let retryAfter = 0;
    for (const [key, limit] of limits) {
      const hits = this.hits.get(key) ?? [];
      if (hits.length >= limit) retryAfter = Math.max(retryAfter, Math.ceil((hits[0]! + 3_600_000 - now) / 1000));
    }
    if (retryAfter) return { allowed: false, retryAfter };
    for (const [key] of limits) this.hits.set(key, [...(this.hits.get(key) ?? []), now]);
    return { allowed: true, retryAfter: 0 };
  }
}

/**
 * Counts attempts per key over a sliding window, in memory per process like ScanLimiter (production is one process, DN-13 §7.4).
 * An attempt counts against every key it names, and only when all of them still had room.
 */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  /** Forgets every attempt. The debug reset uses it; production never calls it. */
  clear(): void { this.hits.clear(); }
  check(limits: ReadonlyArray<readonly [key: string, max: number]>): { allowed: boolean; retryAfter: number } {
    const now = this.now();
    for (const [key, hits] of this.hits) {
      const fresh = hits.filter(t => now - t < this.windowMs);
      if (!fresh.length) this.hits.delete(key); else this.hits.set(key, fresh);
    }
    let retryAfter = 0;
    for (const [key, max] of limits) {
      const hits = this.hits.get(key) ?? [];
      if (hits.length >= max) retryAfter = Math.max(retryAfter, Math.ceil((hits[hits.length - max]! + this.windowMs - now) / 1000));
    }
    if (retryAfter) return { allowed: false, retryAfter: Math.max(1, retryAfter) };
    for (const [key] of limits) this.hits.set(key, [...(this.hits.get(key) ?? []), now]);
    return { allowed: true, retryAfter: 0 };
  }
}
