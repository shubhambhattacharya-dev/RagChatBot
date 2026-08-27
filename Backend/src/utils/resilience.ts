import { CircuitBreaker } from "./circuit-breaker";

const options = { failureThreshold: 5, cooldownMs: 30_000 };
export const llmCircuitBreaker = new CircuitBreaker(options);
export const embeddingCircuitBreaker = new CircuitBreaker(options);
export const databaseCircuitBreaker = new CircuitBreaker(options);
export const redisCircuitBreaker = new CircuitBreaker(options);
export const storageCircuitBreaker = new CircuitBreaker(options);
