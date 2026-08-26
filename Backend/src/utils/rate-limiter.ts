export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
}

interface RequestRecord {
  timestamps: number[];
}

export class RateLimiter {
  private store = new Map<string, RequestRecord>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RateLimiterOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;

    this.evictionTimer = setInterval(() => this.evictStale(), 60_000);
    if (this.evictionTimer?.unref) {
      this.evictionTimer.unref();
    }
  }

  check(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let record = this.store.get(key);
    if (!record) {
      record = { timestamps: [] };
      this.store.set(key, record);
    }

    record.timestamps = record.timestamps.filter((t) => t > cutoff);

    if (record.timestamps.length >= this.maxRequests) {
      const oldestInWindow = record.timestamps[0]!;
      const retryAfterMs = oldestInWindow + this.windowMs - now;
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    record.timestamps.push(now);
    return {
      allowed: true,
      remaining: this.maxRequests - record.timestamps.length,
      retryAfterMs: 0,
    };
  }

  private evictStale(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, record] of this.store) {
      record.timestamps = record.timestamps.filter((t) => t > cutoff);
      if (record.timestamps.length === 0) this.store.delete(key);
    }
  }

  destroy(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
  }
}

export function rateLimit(opts: RateLimiterOptions) {
  const limiter = new RateLimiter(opts);

  return async function rateLimitHandler(request: any, reply: any) {
    const ip = request.ip || request.socket?.remoteAddress || "unknown";
    const { allowed, remaining, retryAfterMs } = limiter.check(ip);

    reply.header("RateLimit-Limit", opts.maxRequests);
    reply.header("RateLimit-Remaining", remaining);

    if (!allowed) {
      reply.hijack();
      reply.raw.writeHead(429, {
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
        "RateLimit-Limit": String(opts.maxRequests),
        "RateLimit-Remaining": "0",
        "RateLimit-Reset": String(Math.ceil(retryAfterMs / 1000)),
      });
      reply.raw.end(JSON.stringify({ message: "Too many requests. Please slow down.", retryAfterMs }));
    }
  };
}
