import type { Redis } from "ioredis";
import { redisCircuitBreaker } from "./resilience";
import { withSpan } from "../observability";

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

export class RedisSlidingWindowRateLimiter {
  constructor(private readonly redis: Redis, private readonly options: RateLimiterOptions) {}

  async check(key: string): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
    const now = Date.now();
    const redisKey = `ratelimit:${key}`;
    // One Lua transaction makes the trim/count/add sequence safe across replicas.
    const result = await redisCircuitBreaker.execute(() => withSpan("redis.rate_limit", { "db.operation": "sliding_window" }, () => this.redis.eval(
      `local cutoff = tonumber(ARGV[1]) - tonumber(ARGV[2])
       redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
       local count = redis.call('ZCARD', KEYS[1])
       if count >= tonumber(ARGV[3]) then
         local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
         return {0, 0, tonumber(first[2]) + tonumber(ARGV[2]) - tonumber(ARGV[1])}
       end
       redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
       redis.call('PEXPIRE', KEYS[1], ARGV[2])
       return {1, tonumber(ARGV[3]) - count - 1, 0}`,
      1,
      redisKey,
      now,
      this.options.windowMs,
      this.options.maxRequests,
      `${now}:${crypto.randomUUID()}`,
    ) as Promise<[number, number, number]>));

    return { allowed: result[0] === 1, remaining: Number(result[1]), retryAfterMs: Math.max(Number(result[2]), 0) };
  }
}

export function rateLimit(opts: RateLimiterOptions & { redis?: Redis }) {
  const limiter = opts.redis ? new RedisSlidingWindowRateLimiter(opts.redis, opts) : new RateLimiter(opts);

  return async function rateLimitHandler(request: any, reply: any) {
    const ip = request.ip || request.socket?.remoteAddress || "unknown";
    const { allowed, remaining, retryAfterMs } = await limiter.check(ip);

    reply.header("RateLimit-Limit", opts.maxRequests);
    reply.header("RateLimit-Remaining", remaining);

    if (!allowed) {
      const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
      reply.hijack();
      reply.raw.statusCode = 429;
      reply.raw.setHeader("Content-Type", "application/json; charset=utf-8");
      reply.raw.setHeader("Retry-After", String(retryAfter));
      reply.raw.setHeader("RateLimit-Limit", String(opts.maxRequests));
      reply.raw.setHeader("RateLimit-Remaining", "0");
      reply.raw.setHeader("RateLimit-Reset", String(Math.ceil((Date.now() + retryAfterMs) / 1000)));
      reply.raw.end(JSON.stringify({ message: "Too many requests. Please slow down.", retryAfterMs }));
      return;
    }
  };
}
