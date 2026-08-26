/**
 * OpenTelemetry initialization with Langfuse export.
 *
 * Design rationale (Senior-level decisions):
 *
 * 1. Separate module: OTel must be initialized BEFORE any other imports that
 *    use HTTP clients (OpenAI SDK, fetch, pg). This file is imported first
 *    in app.ts — a pattern recommended by both OpenTelemetry and Langfuse docs.
 *
 * 2. Conditional setup: When LANGFUSE_PUBLIC_KEY is empty, the processor is
 *    a no-op. This means dev/test environments get zero overhead, and the app
 *    works identically without Langfuse configured. No try/catch gymnastics.
 *
 * 3. Graceful degradation: If Langfuse credentials are invalid or the service
 *    is down, the SDK buffers events and logs warnings — it NEVER throws or
 *    breaks the application. This is baked into Langfuse's design.
 *
 * 4. Shutdown: sdk.shutdown() flushes buffered events. Called in app.ts
 *    onClose hook so no traces are lost on deployment/restart.
 *
 * References:
 * - Langfuse TypeScript SDK v5: https://langfuse.com/docs/sdk/typescript
 * - OpenTelemetry Node SDK: https://opentelemetry.io/docs/languages/js/
 * - "Distributed Tracing in Practice" (O'Reilly) — Chapter on span processors
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { env } from "./config/env";

const langfuseEnabled =
  env.LANGFUSE_PUBLIC_KEY.trim() !== "" &&
  env.LANGFUSE_SECRET_KEY.trim() !== "";

const sdk = new NodeSDK({
  spanProcessors: langfuseEnabled
    ? [new LangfuseSpanProcessor()]
    : [], // No processor = no overhead when Langfuse is disabled
});

export function startInstrumentation(): void {
  if (!langfuseEnabled) {
    // Silent no-op — developer experience stays clean in local dev.
    return;
  }
  sdk.start();
}

export async function shutdownInstrumentation(): Promise<void> {
  if (!langfuseEnabled) return;
  try {
    await sdk.shutdown();
  } catch (err) {
    // Never let observability failure crash the server shutdown.
    console.error("Langfuse shutdown error:", err);
  }
}

export { langfuseEnabled };
