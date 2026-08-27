import { SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
import { JaegerExporter } from "@opentelemetry/exporter-jaeger";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { env } from "./config/env";
import logger from "./logger";

let sdk: NodeSDK | undefined;

/** Starts one process-wide OTel provider. Langfuse and Jaeger are independently optional. */
export function initializeObservability(): void {
  if (sdk) return;

  const spanProcessors: SpanProcessor[] = [];
  if (env.JAEGER_ENDPOINT) {
    spanProcessors.push(new BatchSpanProcessor(new JaegerExporter({ endpoint: env.JAEGER_ENDPOINT })));
  }
  if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) {
    spanProcessors.push(new LangfuseSpanProcessor({
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_BASE_URL,
      environment: env.LANGFUSE_ENVIRONMENT || env.NODE_ENV,
      mediaUploadEnabled: false,
    }));
  }

  const candidate = new NodeSDK({ serviceName: env.OTEL_SERVICE_NAME, spanProcessors });
  try {
    candidate.start();
    sdk = candidate;
  } catch (error) {
    // Telemetry must never take the application down. The API remains usable
    // with the OpenTelemetry no-op provider when credentials/exporters fail.
    sdk = undefined;
    logger.error({ err: error }, "OpenTelemetry initialization failed; continuing without exporters");
  }
  logger.info({ langfuse: Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY), jaeger: Boolean(env.JAEGER_ENDPOINT) }, "OpenTelemetry initialized");
}

export async function withSpan<T>(name: string, attributes: Attributes, operation: () => Promise<T>): Promise<T> {
  const span = trace.getTracer(env.OTEL_SERVICE_NAME).startSpan(name, { attributes });
  try {
    const result = await operation();
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    span.end();
  }
}

export async function shutdownObservability(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}
