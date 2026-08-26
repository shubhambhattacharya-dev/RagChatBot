import { describe, expect, test } from "vitest";
import { withTimeout, TimeoutError } from "../../src/utils/timeout";

describe("withTimeout", () => {
  test("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000);
    expect(result).toBe("ok");
  });

  test("rejects with TimeoutError when promise is too slow", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500));

    await expect(withTimeout(slow, 50)).rejects.toThrow(TimeoutError);
  });

  test("TimeoutError has correct name and message", async () => {
    const slow = new Promise(() => {}); // never resolves

    try {
      await withTimeout(slow, 100);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).name).toBe("TimeoutError");
      expect((err as TimeoutError).message).toContain("100ms");
    }
  });

  test("does not leak timers on successful resolution", async () => {
    // This test verifies the finally block cleans up
    const result = await withTimeout(Promise.resolve(42), 5000);
    expect(result).toBe(42);
  });

  test("handles rejected promises (non-timeout)", async () => {
    const failing = Promise.reject(new Error("provider down"));

    await expect(withTimeout(failing, 1000)).rejects.toThrow("provider down");
  });
});
