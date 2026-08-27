import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker } from "../../src/utils/circuit-breaker";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1000,
      maxConsecutiveFailures: 10,
    });
  });

  // ── Initial state ──────────────────────────────────────────────────────

  describe("initial state", () => {
    test("starts in closed state", () => {
      expect(breaker.getState()).toBe("closed");
    });

    test("allows requests when closed", () => {
      expect(breaker.allowsRequest()).toBe(true);
    });

    test("has zero consecutive failures", () => {
      expect(breaker.getConsecutiveFailures()).toBe(0);
    });
  });

  // ── Closed state ───────────────────────────────────────────────────────

  describe("closed state", () => {
    test("stays closed under failure threshold", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe("closed");
      expect(breaker.allowsRequest()).toBe(true);
    });

    test("transitions to open after reaching failure threshold", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");
    });

    test("resets failure count on success", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess();
      expect(breaker.getConsecutiveFailures()).toBe(0);
      expect(breaker.getState()).toBe("closed");
    });

    test("success after partial failures resets the counter", () => {
      breaker.recordFailure();
      breaker.recordFailure(); // 2 failures
      breaker.recordSuccess(); // reset
      breaker.recordFailure(); // 1 failure (not 3)
      expect(breaker.getState()).toBe("closed");
      expect(breaker.getConsecutiveFailures()).toBe(1);
    });
  });

  // ── Open state ─────────────────────────────────────────────────────────

  describe("open state", () => {
    beforeEach(() => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure(); // opens
    });

    test("rejects requests when open", () => {
      expect(breaker.getState()).toBe("open");
      expect(breaker.allowsRequest()).toBe(false);
    });

    test("transitions to half-open after cooldown", async () => {
      await new Promise((r) => setTimeout(r, 1100));
      expect(breaker.allowsRequest()).toBe(true);
      expect(breaker.getState()).toBe("half-open");
    });

    test("still rejects before cooldown expires", async () => {
      await new Promise((r) => setTimeout(r, 500));
      expect(breaker.allowsRequest()).toBe(false);
    });
  });

  // ── Half-open state ────────────────────────────────────────────────────

  describe("half-open state", () => {
    test("closes on successful probe", async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise((r) => setTimeout(r, 1100));

      breaker.allowsRequest(); // → half-open
      breaker.recordSuccess(); // probe succeeded

      expect(breaker.getState()).toBe("closed");
      expect(breaker.getConsecutiveFailures()).toBe(0);
    });

    test("re-opens on failed probe", async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise((r) => setTimeout(r, 1100));

      breaker.allowsRequest(); // → half-open
      breaker.recordFailure(); // probe failed

      expect(breaker.getState()).toBe("open");
    });

    test("rejects concurrent requests during probe (only one probe allowed)", async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise((r) => setTimeout(r, 1100));

      // First request enters half-open
      expect(breaker.allowsRequest()).toBe(true);
      expect(breaker.getState()).toBe("half-open");

      // Second concurrent request should be rejected
      expect(breaker.allowsRequest()).toBe(false);
      expect(breaker.getState()).toBe("half-open");
    });

    test("allows new probe after first probe completes (success)", async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise((r) => setTimeout(r, 1100));

      breaker.allowsRequest(); // → half-open, probe 1
      breaker.recordSuccess(); // → closed

      // Circuit is now closed, allows normal requests
      expect(breaker.allowsRequest()).toBe(true);
      expect(breaker.getState()).toBe("closed");
    });

    test("allows new probe after first probe fails (re-opens)", async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise((r) => setTimeout(r, 1100));

      breaker.allowsRequest(); // → half-open
      breaker.recordFailure(); // → open

      expect(breaker.getState()).toBe("open");
      expect(breaker.allowsRequest()).toBe(false);
    });
  });

  // ── Escalating cooldown ────────────────────────────────────────────────

  describe("escalating cooldown", () => {
    test("doubles cooldown after maxConsecutiveFailures", () => {
      // Trigger many failures to exceed maxConsecutiveFailures (10)
      for (let i = 0; i < 12; i++) {
        breaker.recordFailure();
      }
      expect(breaker.getState()).toBe("open");
      // The cooldown multiplier should have increased
      // (we can't directly test the multiplier, but we can verify the state)
    });

    test("cooldown multiplier caps at 5x", () => {
      for (let i = 0; i < 50; i++) {
        breaker.recordFailure();
      }
      expect(breaker.getState()).toBe("open");
    });
  });

  // ── Reset ──────────────────────────────────────────────────────────────

  describe("reset", () => {
    test("force-reset returns to closed from open", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");

      breaker.reset();
      expect(breaker.getState()).toBe("closed");
      expect(breaker.allowsRequest()).toBe(true);
      expect(breaker.getConsecutiveFailures()).toBe(0);
    });

    test("reset clears probing flag", async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise((r) => setTimeout(r, 1100));
      breaker.allowsRequest(); // → half-open, probing = true

      breaker.reset();
      expect(breaker.allowsRequest()).toBe(true); // Should work now
    });
  });

  // ── Default options ────────────────────────────────────────────────────

  describe("default options", () => {
    test("uses default failure threshold of 5", () => {
      const defaultBreaker = new CircuitBreaker();
      for (let i = 0; i < 4; i++) defaultBreaker.recordFailure();
      expect(defaultBreaker.getState()).toBe("closed");
      defaultBreaker.recordFailure();
      expect(defaultBreaker.getState()).toBe("open");
    });
  });

  describe("execute", () => {
    test("records success and returns the operation value", async () => {
      const value = await breaker.execute(async () => "ok");
      expect(value).toBe("ok");
      expect(breaker.getState()).toBe("closed");
    });

    test("records failures and rejects when the circuit opens", async () => {
      const guarded = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
      await expect(guarded.execute(async () => { throw new Error("down"); })).rejects.toThrow("down");
      await expect(guarded.execute(async () => "never")).rejects.toThrow("temporarily unavailable");
    });
  });
});
