export class ScanLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now = Date.now) {}
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
