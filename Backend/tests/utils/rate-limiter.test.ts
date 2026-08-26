import { describe, expect, test, afterEach } from "vitest";
import { RateLimiter } from "../../src/utils/rate-limiter";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  // ── Basic functionality ────────────────────────────────────────────────

  describe("basic functionality", () => {
    test("allows requests within the limit", () => {
      limiter = new RateLimiter({ maxRequests: 3, windowMs: 10_000 });

      expect(limiter.check("192.168.1.1").allowed).toBe(true);
      expect(limiter.check("192.168.1.1").allowed).toBe(true);
      expect(limiter.check("192.168.1.1").allowed).toBe(true);
    });

    test("rejects requests exceeding the limit", () => {
      limiter = new RateLimiter({ maxRequests: 2, windowMs: 10_000 });

      limiter.check("192.168.1.1");
      limiter.check("192.168.1.1");
      const third = limiter.check("192.168.1.1");

      expect(third.allowed).toBe(false);
      expect(third.remaining).toBe(0);
      expect(third.retryAfterMs).toBeGreaterThan(0);
    });

    test("tracks remaining correctly", () => {
      limiter = new RateLimiter({ maxRequests: 5, windowMs: 10_000 });

      const r1 = limiter.check("ip1");
      expect(r1.remaining).toBe(4);

      const r2 = limiter.check("ip1");
      expect(r2.remaining).toBe(3);

      const r3 = limiter.check("ip1");
      expect(r3.remaining).toBe(2);
    });

    test("returns correct remaining on rejection", () => {
      limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });

      limiter.check("ip1");
      const rejected = limiter.check("ip1");

      expect(rejected.remaining).toBe(0);
    });
  });

  // ── Per-key isolation ──────────────────────────────────────────────────

  describe("per-key isolation", () => {
    test("different IPs have independent limits", () => {
      limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });

      expect(limiter.check("ip1").allowed).toBe(true);
      expect(limiter.check("ip1").allowed).toBe(false);
      expect(limiter.check("ip2").allowed).toBe(true);
    });

    test("different keys can have different usage counts", () => {
      limiter = new RateLimiter({ maxRequests: 3, windowMs: 10_000 });

      limiter.check("ip1");
      limiter.check("ip1");
      limiter.check("ip1");

      // ip1 is exhausted, ip2 is fresh
      expect(limiter.check("ip1").allowed).toBe(false);
      expect(limiter.check("ip2").allowed).toBe(true);
    });

    test("handles special characters in keys", () => {
      limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });

      expect(limiter.check("::1").allowed).toBe(true);
      expect(limiter.check("::1").allowed).toBe(false);
      expect(limiter.check("127.0.0.1").allowed).toBe(true);
    });
  });

  // ── Sliding window behavior ────────────────────────────────────────────

  describe("sliding window", () => {
    test("allows requests after window expires", async () => {
      limiter = new RateLimiter({ maxRequests: 1, windowMs: 100 });

      limiter.check("ip1");
      expect(limiter.check("ip1").allowed).toBe(false);

      await new Promise((r) => setTimeout(r, 150));

      expect(limiter.check("ip1").allowed).toBe(true);
    });

    test("oldest request expires first (sliding, not fixed window)", async () => {
      limiter = new RateLimiter({ maxRequests: 2, windowMs: 100 });

      limiter.check("ip1"); // t=0
      await new Promise((r) => setTimeout(r, 60));
      limiter.check("ip1"); // t=60

      // At t=60, both are within window → full
      expect(limiter.check("ip1").allowed).toBe(false);

      // Wait for first request to expire (t=0 + 100 = 100ms)
      await new Promise((r) => setTimeout(r, 60));

      // At t=120, first request expired, second is still within window
      expect(limiter.check("ip1").allowed).toBe(true);
    });

    test("retryAfterMs decreases as time passes", async () => {
      limiter = new RateLimiter({ maxRequests: 1, windowMs: 200 });

      limiter.check("ip1");
      const r1 = limiter.check("ip1");
      const retry1 = r1.retryAfterMs;

      await new Promise((r) => setTimeout(r, 100));

      const r2 = limiter.check("ip1");
      expect(r2.retryAfterMs).toBeLessThan(retry1);
    });
  });

  // ── Memory management ──────────────────────────────────────────────────

  describe("memory management", () => {
    test("evicts stale entries after window expires", async () => {
      limiter = new RateLimiter({ maxRequests: 1, windowMs: 50 });

      limiter.check("ip1");
      // Wait for window to expire
      await new Promise((r) => setTimeout(r, 60));

      // The stale entry should be evicted on next check
      // (eviction happens automatically via the filter in check())
      const result = limiter.check("ip1");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0); // maxRequests=1, used 1
    });

    test("destroy stops eviction timer", () => {
      limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });
      limiter.destroy();
      // Should not throw or leak timers
    });

    test("destroy is idempotent", () => {
      limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });
      limiter.destroy();
      limiter.destroy(); // Second call should be safe
    });
  });

  // ── Stress/edge cases ──────────────────────────────────────────────────

  describe("stress and edge cases", () => {
    test("handles rapid successive calls", () => {
      limiter = new RateLimiter({ maxRequests: 100, windowMs: 1000 });

      for (let i = 0; i < 100; i++) {
        expect(limiter.check("ip").allowed).toBe(true);
      }
      expect(limiter.check("ip").allowed).toBe(false);
    });

    test("handles maxRequests of 1", () => {
      limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });

      expect(limiter.check("ip").allowed).toBe(true);
      expect(limiter.check("ip").allowed).toBe(false);
    });

    test("handles very large window", () => {
      limiter = new RateLimiter({ maxRequests: 1000, windowMs: 3_600_000 });

      for (let i = 0; i < 1000; i++) {
        expect(limiter.check("ip").allowed).toBe(true);
      }
      expect(limiter.check("ip").allowed).toBe(false);
    });

    test("handles many different keys", () => {
      limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });

      for (let i = 0; i < 1000; i++) {
        expect(limiter.check(`ip-${i}`).allowed).toBe(true);
      }
    });

    test("retryAfterMs is never negative", () => {
      limiter = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });
      limiter.check("ip");
      const result = limiter.check("ip");
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(0);
    });
  });
});
