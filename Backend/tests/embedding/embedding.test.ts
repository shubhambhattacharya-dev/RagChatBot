import { describe, expect, test } from "bun:test";
import { embedText, validateEmbedding } from "../../src/provider/embedding/gemini";

const liveTest = process.env.RUN_LIVE_EMBEDDING_TESTS === "1" ? test : test.skip;

// Offline unit tests — no network needed
describe("validateEmbedding (offline)", () => {
  test("accepts a finite 768-dimension vector", () => {
    const embedding = Array.from({ length: 768 }, () => 0.25);
    expect(validateEmbedding(embedding)).toHaveLength(768);
  });

  test("rejects wrong dimension", () => {
    expect(() => validateEmbedding([1, 2])).toThrow("768 dimensions");
  });

  test("rejects NaN values", () => {
    expect(() => validateEmbedding([...Array(767).fill(0), Number.NaN])).toThrow("non-finite");
  });
});

// Test 3 — embedding (live Gemini call, needs .env GEMINI_API + RUN_LIVE_EMBEDDING_TESTS=1)
describe("embedding generation", () => {
  liveTest("embedText returns a 768-dim finite vector (live)", async () => {
    const v = await embedText("what is the email", "RETRIEVAL_QUERY");
    expect(v.length).toBe(768);
    expect(v.every((n) => Number.isFinite(n))).toBe(true);
    expect(v.some((n) => n !== 0)).toBe(true); // not all-zero
  });

  liveTest("RETRIEVAL_DOCUMENT task type also works", async () => {
    const v = await embedText("Document: test\nEmail: a@b.com", "RETRIEVAL_DOCUMENT");
    expect(validateEmbedding(v)).toHaveLength(768);
  });

  test("rejects empty text", async () => {
    await expect(embedText("   ", "RETRIEVAL_QUERY")).rejects.toThrow();
  });

  test("cancels a rate-limit retry when the request is aborted", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    controller.abort();

    try {
      await expect(embedText("abort-test-unique", "RETRIEVAL_QUERY", controller.signal))
        .rejects.toThrow("Request aborted");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
