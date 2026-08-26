/**
 * Langfuse tracing helpers — following official Langfuse skill best practices.
 *
 * Design rationale (from Langfuse instrumentation guide):
 *
 * 1. Verb-first naming: "retrieve-context", "generate-response" — makes the
 *    trace tree read like a description of what the app did.
 *
 * 2. Correct observation types: retriever for lookup, generation for LLM —
 *    enables model-specific analytics and the Agent Graph.
 *
 * 3. Session grouping: Each chat turn is its own trace, but session_id ties
 *    multi-turn conversations together in the Sessions view.
 *
 * 4. Token tracking: Generation observations capture input/output tokens
 *    for automatic cost calculation in Langfuse dashboards.
 *
 * 5. No-op fallback: Every function returns null when Langfuse is disabled.
 *    Callers don't need conditionals — zero cognitive load.
 *
 * References:
 * - Langfuse skill instrumentation guide: references/instrumentation.md
 * - Best practices: https://langfuse.com/docs/observability/best-practices
 * - Observation types: https://langfuse.com/docs/observability/features/observation-types
 */
import { langfuseEnabled } from "../instrumentation";
import logger from "../logger";

// Lazy import — only load when Langfuse is enabled.
let langfuseClient: any = null;

async function getClient() {
  if (!langfuseClient) {
    const mod = await import("@langfuse/tracing");
    langfuseClient = mod;
  }
  return langfuseClient;
}

/**
 * Create a top-level RAG trace for a chat query.
 *
 * Each chat turn = one trace. Multi-turn conversations are grouped by session_id.
 * The trace captures: input (user question), output (LLM answer), and metadata.
 */
export async function traceRagQuery(params: {
  question: string;
  documentId?: string;
  sessionId?: string;
}) {
  if (!langfuseEnabled) return null;

  const { startActiveObservation } = await getClient();
  const trace = await startActiveObservation("query-rag", async (root: any) => {
    root.update({
      input: params.question,
      metadata: {
        documentId: params.documentId ?? "GLOBAL",
        pipeline: "rag-chat",
      },
      sessionId: params.sessionId,
      tags: ["rag", "chat"],
    });
    return root;
  });

  return trace;
}

/**
 * Create a retriever observation inside a trace — tracks pgvector + lexical search.
 *
 * Uses asType: "retriever" so it shows up correctly in the Agent Graph
 * and can be targeted by LLM-as-a-judge evaluators.
 */
export async function traceRetrieval(trace: any, params: {
  chunksFound: number;
  topDistance: number;
  latencyMs: number;
  query: string;
  sourceDocuments?: string[];
}) {
  if (!trace) return;

  try {
    const span = trace.span({
      name: "retrieve-context",
      input: params.query,
      output: {
        chunksFound: params.chunksFound,
        topDistance: params.topDistance,
        sourceDocuments: params.sourceDocuments,
      },
      metadata: {
        latencyMs: params.latencyMs,
        maxDistanceThreshold: 0.5,
      },
    });
    span.end();
  } catch (err) {
    logger.debug({ err }, "Langfuse retriever span failed (non-fatal)");
  }
}

/**
 * Create a generation observation — auto-calculates tokens + cost.
 *
 * Follows best practices:
 * - Captures model name for pricing lookup
 * - Accepts usage details for token tracking
 * - Uses verb-first naming ("generate-response")
 */
export async function traceGeneration(trace: any, params: {
  model: string;
  input: unknown;
  usage?: { input: number; output: number; total: number };
  output?: string;
  metadata?: Record<string, unknown>;
}) {
  if (!trace) return null;

  try {
    return trace.generation({
      name: "generate-response",
      model: params.model,
      input: params.input,
      output: params.output,
      usage: params.usage,
      metadata: {
        provider: params.model.includes("llama") ? "groq" : "gemini",
        ...params.metadata,
      },
    });
  } catch (err) {
    logger.debug({ err }, "Langfuse generation span failed (non-fatal)");
    return null;
  }
}

/**
 * Create a document processing trace for the upload/index pipeline.
 */
export async function traceDocumentProcessing(params: {
  documentId: string;
  filename: string;
}) {
  if (!langfuseEnabled) return null;

  const { startActiveObservation } = await getClient();
  return startActiveObservation("index-document", async (root: any) => {
    root.update({
      input: params.filename,
      metadata: {
        documentId: params.documentId,
        pipeline: "document-indexing",
      },
      tags: ["upload", "indexing"],
    });
    return root;
  });
}

/**
 * Flush buffered events to Langfuse. Call before closing connections.
 * Non-fatal: never throws, never blocks the event loop.
 */
export async function flushLangfuse(): Promise<void> {
  if (!langfuseEnabled || !langfuseClient) return;
  try {
    await langfuseClient.flushAsync();
  } catch (err) {
    logger.debug({ err }, "Langfuse flush failed (non-fatal)");
  }
}
