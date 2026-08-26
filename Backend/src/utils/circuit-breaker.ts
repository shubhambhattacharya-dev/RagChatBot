export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  maxConsecutiveFailures?: number;
}

const DEFAULTS: Required<CircuitBreakerOptions> = {
  failureThreshold: 5,
  cooldownMs: 60_000,
  maxConsecutiveFailures: 20,
};

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private cooldownMultiplier = 1;
  private probing = false;
  private readonly opts: Required<CircuitBreakerOptions>;

  constructor(options?: Partial<CircuitBreakerOptions>) {
    this.opts = { ...DEFAULTS, ...options };
  }

  allowsRequest(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.opts.cooldownMs * this.cooldownMultiplier) {
        this.state = "half-open";
        this.probing = true;
        return true;
      }
      return false;
    }

    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.cooldownMultiplier = 1;
    this.state = "closed";
    this.probing = false;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    this.probing = false;

    if (this.consecutiveFailures >= this.opts.maxConsecutiveFailures) {
      this.cooldownMultiplier = Math.min(this.cooldownMultiplier * 2, 5);
    }

    if (
      this.consecutiveFailures >= this.opts.failureThreshold ||
      this.state === "half-open"
    ) {
      this.state = "open";
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.cooldownMultiplier = 1;
    this.probing = false;
  }
}
