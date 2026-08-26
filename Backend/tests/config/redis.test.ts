import { describe, expect, it } from "vitest";
import { createRedis } from "../../src/config/redis";

// Construction is lazy (no network until the first command), so these tests
// verify the TLS decision without touching a live Redis.
describe("createRedis", () => {
  it("enables TLS for Upstash redis:// URLs", () => {
    const r = createRedis("redis://default:secret@abc123.upstash.io:6379");
    expect(r.options.tls).toBeDefined();
    r.disconnect();
  });

  it("normalizes rediss:// to redis:// with TLS", () => {
    const r = createRedis("rediss://default:secret@example.com:6379");
    expect(r.options.tls).toBeDefined();
    expect(r.options.host).toBe("example.com");
    r.disconnect();
  });

  it("keeps plaintext for localhost dev Redis", () => {
    const r = createRedis("redis://localhost:6379");
    expect(r.options.tls).toBeUndefined();
    r.disconnect();
  });
});
