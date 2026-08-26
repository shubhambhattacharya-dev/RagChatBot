/**
 * Centralized structured logger — singleton pino instance.
 *
 * Design rationale (Senior-level decisions):
 * - Singleton: one logger per process, configured once at boot (Twelve-Factor App §11).
 * - Structured JSON: machine-parseable logs for production observability (pino default).
 * - Human-readable in dev: pino prettifies automatically when stdout is a TTY.
 * - Request-scoped context: Fastify's request.log inherits this instance and adds
 *   request-id/method/url automatically — no manual decoration needed.
 * - All modules import this instead of console.* — keeps log format, level, and
 *   transport consistent everywhere (Clean Code: no scattered configuration).
 *
 * Reference: "Node.js Design Patterns" (Casciaro) Ch. 10 — Logging Patterns.
 * Reference: pino best practices — https://getpino.io/#/docs/api?id=logger
 */
import pino from "pino";
import { env } from "./config/env";

const logger = pino({
  level: env.LOG_LEVEL,

  // In production (Render/Cloud Run), stdout goes to the platform's log drain.
  // pino writes newline-delimited JSON — no extra transport needed.
  // In dev (TTY), pino automatically prettifies for readability.

  // Redact sensitive fields that might leak into log context.
  // Keys are matched by path across all log objects.
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "password", "secret"],
    censor: "[REDACTED]",
  },
});

export default logger;
