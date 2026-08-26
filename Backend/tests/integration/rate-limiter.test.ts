import { describe, expect, test, afterEach } from "vitest";
import Fastify from "fastify";
import { rateLimit, RateLimiter } from "../../src/utils/rate-limiter";

describe("Rate Limiter Integration (Fastify)", () => {
  let app: any;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  async function createApp(opts = { maxRequests: 3, windowMs: 10_000 }) {
    app = Fastify({ logger: false });
    app.addHook("preHandler", rateLimit(opts));
    app.get("/test", async () => ({ ok: true }));
    return app;
  }

  test("allows requests within limit", async () => {
    const server = await createApp();
    await server.ready();

    const r1 = await server.inject({ method: "GET", url: "/test" });
    const r2 = await server.inject({ method: "GET", url: "/test" });
    const r3 = await server.inject({ method: "GET", url: "/test" });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);
  });

  test("returns 429 when limit exceeded", async () => {
    const server = await createApp();
    await server.ready();

    await server.inject({ method: "GET", url: "/test" });
    await server.inject({ method: "GET", url: "/test" });
    await server.inject({ method: "GET", url: "/test" });
    const r4 = await server.inject({ method: "GET", url: "/test" });

    expect(r4.statusCode).toBe(429);
    const body = JSON.parse(r4.payload);
    expect(body.message).toContain("Too many requests");
  });

  test("sets RateLimit-Limit header", async () => {
    const server = await createApp({ maxRequests: 5, windowMs: 10_000 });
    await server.ready();

    const r = await server.inject({ method: "GET", url: "/test" });
    expect(r.headers["ratelimit-limit"]).toBe("5");
  });

  test("sets RateLimit-Remaining header", async () => {
    const server = await createApp({ maxRequests: 5, windowMs: 10_000 });
    await server.ready();

    const r1 = await server.inject({ method: "GET", url: "/test" });
    expect(r1.headers["ratelimit-remaining"]).toBe("4");

    const r2 = await server.inject({ method: "GET", url: "/test" });
    expect(r2.headers["ratelimit-remaining"]).toBe("3");
  });

  test("sets Retry-After header on 429", async () => {
    const server = await createApp({ maxRequests: 1, windowMs: 10_000 });
    await server.ready();

    await server.inject({ method: "GET", url: "/test" });
    const r = await server.inject({ method: "GET", url: "/test" });

    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
  });

  test("recovers after window expires", async () => {
    const server = await createApp({ maxRequests: 1, windowMs: 100 });
    await server.ready();

    await server.inject({ method: "GET", url: "/test" });
    const blocked = await server.inject({ method: "GET", url: "/test" });
    expect(blocked.statusCode).toBe(429);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 150));

    const allowed = await server.inject({ method: "GET", url: "/test" });
    expect(allowed.statusCode).toBe(200);
  });
});
