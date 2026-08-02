import { describe, expect, it } from "bun:test";
import { TimeoutError, withTimeout } from "../../src/utils/timeout";

describe("withTimeout", () => {
  it("resolves with the value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });

  it("rejects with TimeoutError when the promise never settles", async () => {
    // This is the bug that broke /health on Render: redis.ping() never
    // settles (ioredis retries forever against a dead localhost), so the
    // handler never replied. withTimeout must reject at the deadline.
    const never = new Promise<string>(() => {});
    const started = Date.now();
    await expect(withTimeout(never, 50)).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it("propagates the original rejection", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 1000)
    ).rejects.toThrow("boom");
  });

  it("does not keep the timer alive after settling", async () => {
    const start = Date.now();
    await withTimeout(Promise.resolve("fast"), 500);
    // The 500ms timer must have been cleared — settling took far less.
    expect(Date.now() - start).toBeLessThan(100);
  });
});
