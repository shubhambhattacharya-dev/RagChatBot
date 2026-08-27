import { env } from "../../config/env";
import logger from "../../logger";
import { withSpan } from "../../observability";
import { embeddingCircuitBreaker } from "../../utils/resilience";

const EMBED_MODEL = "models/gemini-embedding-001";
const API_URL = "https://generativelanguage.googleapis.com/v1beta";

interface EmbedResponse {
  embedding?: {
    values?: number[];
  };
}

export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export function validateEmbedding(embedding: number[], dimension = 768): number[] {
  if (embedding.length !== dimension) {
    throw new Error(`Expected an embedding with ${dimension} dimensions, received ${embedding.length}.`);
  }
  if (embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding contains a non-finite value.");
  }
  return embedding;
}

function parseRetryDelay(errorBody: string): number {
  try {
    const textMatch = errorBody.match(/retry in ([0-9.]+)/i);
    if (textMatch && textMatch[1]) {
      const sec = parseFloat(textMatch[1]);
      if (!isNaN(sec)) {
        return Math.min(Math.ceil(sec * 1000) + 1500, 65000);
      }
    }

    const delayMatch = errorBody.match(/retryDelay["']?:\s*["']?([0-9.]+)/i);
    if (delayMatch && delayMatch[1]) {
      const sec = parseFloat(delayMatch[1]);
      if (!isNaN(sec)) {
        return Math.min(Math.ceil(sec * 1000) + 1500, 65000);
      }
    }
  } catch {}
  return 5000;
}

// ── LRU Embedding Cache ──────────────────────────────────────────────
// Caps memory at ~10K entries (~30 MB for 768-dim float64 vectors).
// Map iteration order == insertion order → delete+re-insert = LRU touch.
const embeddingCache = new Map<string, number[]>();
const MAX_CACHE_SIZE = 10_000;
const MAX_RETRY_WAIT_MS = 10_000;

function isTransientEmbeddingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Google can intermittently return a 5xx HTML error page while otherwise
  // accepting the same embedding request seconds later.
  return /Gemini API Error \((408|425|500|502|503|504)\)|fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(message);
}

function transientRetryDelay(attempt: number): number {
  // 1s, 2s, 4s — fast enough for interactive uploads, but avoids instantly
  // repeating a request while Google's service is recovering.
  return Math.min(1_000 * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

function cacheGet(key: string): number[] | undefined {
  const value = embeddingCache.get(key);
  if (value !== undefined) {
    // Move to end (most recently used) for LRU eviction
    embeddingCache.delete(key);
    embeddingCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: number[]): void {
  // Remove first so re-insert goes to end
  if (embeddingCache.has(key)) embeddingCache.delete(key);
  // Evict oldest entries when cache is full
  while (embeddingCache.size >= MAX_CACHE_SIZE) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest !== undefined) embeddingCache.delete(oldest);
    else break;
  }
  embeddingCache.set(key, value);
}

export async function embedText(
  text: string,
  taskType: EmbeddingTaskType,
  signal?: AbortSignal
): Promise<number[]> {
  if (!text.trim()) {
    throw new Error("Text cannot be empty.");
  }

  const cacheKey = `${taskType}:${text.trim().toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    logger.debug({ text: text.slice(0, 80) }, "[Embedding Cache] ⚡ Cache HIT (0ms)");
    return cached;
  }

  const maxRetries = 3;
  let lastError: Error | null = null;

  return embeddingCircuitBreaker.execute(async () => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await withSpan("embedding.gemini.request", { "gen_ai.system": "google_generativeai", "gen_ai.request.model": EMBED_MODEL }, () => fetch(
        `${API_URL}/${EMBED_MODEL}:embedContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API,
          },
          body: JSON.stringify({
            model: EMBED_MODEL,
            content: {
              parts: [{ text }],
            },
            taskType,
            outputDimensionality: 768,
          }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(env.REQUEST_TIMEOUT_MS)])
            : AbortSignal.timeout(env.REQUEST_TIMEOUT_MS),
        }
      ));

      if (response.status === 429) {
        const errorBody = await response.text();
        if (attempt < maxRetries) {
          const delayMs = parseRetryDelay(errorBody);
          if (delayMs > MAX_RETRY_WAIT_MS) {
            throw new Error(`Gemini API rate limit exceeded (429). Please retry in about ${Math.ceil(delayMs / 1000)} seconds.`);
          }
          logger.warn({ attempt: attempt + 1, maxRetries: maxRetries + 1, delaySec: (delayMs / 1000).toFixed(0) }, "Gemini embedding rate-limited, retrying");
          await waitForRetry(delayMs, signal);
          continue;
        }
        throw new Error(`Gemini API rate limit exceeded (429): ${errorBody}`);
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Gemini API Error (${response.status}): ${errorBody}`);
      }

      const data = (await response.json()) as EmbedResponse;
      if (!data.embedding?.values) {
        throw new Error("Embedding not found in Gemini response.");
      }

      const embedding = validateEmbedding(data.embedding.values);
      // ✅ Cache successful embedding for future hits
      cacheSet(cacheKey, embedding);
      return embedding;
    } catch (error: any) {
      if (attempt < maxRetries && (error?.message?.includes("429") || error?.message?.includes("RESOURCE_EXHAUSTED"))) {
        const delayMs = parseRetryDelay(error?.message || "");
        if (delayMs > MAX_RETRY_WAIT_MS) {
          lastError = error;
          break;
        }
        logger.warn({ attempt: attempt + 1, maxRetries: maxRetries + 1, delaySec: (delayMs / 1000).toFixed(0) }, "Gemini embedding rate-limited, retrying");
        await waitForRetry(delayMs, signal);
        continue;
      }
      if (attempt < maxRetries && isTransientEmbeddingError(error)) {
        const delayMs = transientRetryDelay(attempt);
        logger.warn(
          { attempt: attempt + 1, maxRetries: maxRetries + 1, delaySec: (delayMs / 1000).toFixed(0) },
          "Gemini embedding temporary failure, retrying"
        );
        await waitForRetry(delayMs, signal);
        continue;
      }
      lastError = error;
      break;
    }
  }

  const error = lastError;
  logger.error({ err: error }, "Embedding generation failed");
  if (error?.message?.includes("API_KEY_INVALID") || error?.message?.includes("API key not valid")) {
    throw new Error("Gemini API key is invalid. Get a new key from https://aistudio.google.com/apikey");
  }
  if (error?.message?.includes("429") || error?.message?.includes("RESOURCE_EXHAUSTED")) {
    throw new Error("Gemini API rate limit exceeded. Please try again later.");
  }
  throw new Error(`Gemini embedding failed: ${error?.message || error}`);
  });
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  if (signal.aborted) return Promise.reject(new Error("Request aborted."));

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const resolveAfterDelay = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(resolveAfterDelay, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Request aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * High-throughput batch embedding generation.
 * Batches requests to Gemini batchEmbedContents API with LRU cache integration and rate-limit retries.
 */
export async function embedBatch(
  texts: string[],
  taskType: EmbeddingTaskType,
  signal?: AbortSignal,
  batchSize = 50
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  const uncachedIndices: number[] = [];
  const uncachedTexts: string[] = [];

  // Check cache first
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!.trim();
    if (!text) {
      results[i] = new Array(768).fill(0);
      continue;
    }
    const cacheKey = `${taskType}:${text.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
      uncachedTexts.push(text);
    }
  }

  if (uncachedTexts.length === 0) {
    return results as number[][];
  }

  // Chunk uncached texts into batches
  for (let b = 0; b < uncachedTexts.length; b += batchSize) {
    const batchSlice = uncachedTexts.slice(b, b + batchSize);
    const indexSlice = uncachedIndices.slice(b, b + batchSize);

    const maxRetries = 3;
    let batchSucceeded = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await withSpan("embedding.gemini.batch", { "gen_ai.system": "google_generativeai", "gen_ai.request.model": EMBED_MODEL }, () => fetch(
          `${API_URL}/${EMBED_MODEL}:batchEmbedContents`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API },
            body: JSON.stringify({
              requests: batchSlice.map((t) => ({
                model: EMBED_MODEL,
                content: { parts: [{ text: t }] },
                taskType,
                outputDimensionality: 768,
              })),
            }),
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(env.REQUEST_TIMEOUT_MS)])
              : AbortSignal.timeout(env.REQUEST_TIMEOUT_MS),
          }
        ));

        if (response.status === 429) {
          const errorBody = await response.text();
          if (attempt < maxRetries) {
            const delayMs = parseRetryDelay(errorBody);
            await waitForRetry(delayMs, signal);
            continue;
          }
          throw new Error(`Gemini batch embedding rate limit exceeded: ${errorBody}`);
        }

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Gemini batch API error (${response.status}): ${errorBody}`);
        }

        const data = (await response.json()) as { embeddings?: { values?: number[] }[] };
        const embeddings = data.embeddings;
        if (!embeddings || embeddings.length !== batchSlice.length) {
          throw new Error("Mismatch in batch embeddings response count.");
        }

        for (let i = 0; i < batchSlice.length; i++) {
          const rawValues = embeddings[i]?.values;
          if (!rawValues) throw new Error("Missing embedding in batch response.");
          const validated = validateEmbedding(rawValues, 768);
          const originalIdx = indexSlice[i]!;
          results[originalIdx] = validated;
          cacheSet(`${taskType}:${batchSlice[i]!.toLowerCase()}`, validated);
        }

        batchSucceeded = true;
        break;
      } catch (err: any) {
        if (attempt < maxRetries && (isTransientEmbeddingError(err) || err?.message?.includes("429"))) {
          const delayMs = transientRetryDelay(attempt);
          await waitForRetry(delayMs, signal);
          continue;
        }

        // Fallback: process this batch slice one by one via embedText
        for (let i = 0; i < batchSlice.length; i++) {
          const originalIdx = indexSlice[i]!;
          results[originalIdx] = await embedText(batchSlice[i]!, taskType, signal);
        }
        batchSucceeded = true;
        break;
      }
    }

    if (!batchSucceeded) {
      throw new Error(`Failed to generate batch embeddings for slice starting at index ${b}`);
    }
  }

  return results as number[][];
}
