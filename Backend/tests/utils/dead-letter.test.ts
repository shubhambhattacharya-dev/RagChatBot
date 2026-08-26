import { describe, expect, test } from "vitest";
import { classifyError } from "../../src/modules/upload/dead-letter";

describe("classifyError", () => {
  // ── Priority 1: Non-retryable validation errors ────────────────────────

  describe("validation errors (non-retryable)", () => {
    test("classifies unsupported document type", () => {
      const result = classifyError(new Error("Unsupported document type: application/x-rar"));
      expect(result).toEqual({ reason: "validation_error", retryable: false });
    });

    test("classifies invalid API key", () => {
      const result = classifyError(new Error("Gemini API key is invalid. Get a new key."));
      expect(result).toEqual({ reason: "validation_error", retryable: false });
    });

    test("classifies invalid PDF signature", () => {
      const result = classifyError(new Error("The uploaded PDF signature is invalid."));
      expect(result).toEqual({ reason: "validation_error", retryable: false });
    });

    test("classifies corrupted file", () => {
      const result = classifyError(new Error("The file is corrupted."));
      expect(result).toEqual({ reason: "validation_error", retryable: false });
    });

    test("classifies empty file", () => {
      const result = classifyError(new Error("The uploaded file is empty."));
      expect(result).toEqual({ reason: "validation_error", retryable: false });
    });
  });

  // ── Priority 1: Non-retryable extraction errors ────────────────────────

  describe("extraction errors (non-retryable)", () => {
    test("classifies no text extracted", () => {
      const result = classifyError(new Error("No text extracted from document."));
      expect(result).toEqual({ reason: "extraction_failed", retryable: false });
    });

    test("classifies no chunks generated", () => {
      const result = classifyError(new Error("No chunks generated."));
      expect(result).toEqual({ reason: "extraction_failed", retryable: false });
    });
  });

  // ── Priority 2: Retryable transient errors ─────────────────────────────

  describe("rate limit errors (retryable)", () => {
    test("classifies HTTP 429", () => {
      const result = classifyError(new Error("Gemini API Error (429): rate limit exceeded"));
      expect(result).toEqual({ reason: "rate_limit_exceeded", retryable: true });
    });

    test("classifies RESOURCE_EXHAUSTED", () => {
      const result = classifyError(new Error("RESOURCE_EXHAUSTED: quota exceeded"));
      expect(result).toEqual({ reason: "rate_limit_exceeded", retryable: true });
    });

    test("classifies rate limit text", () => {
      const result = classifyError(new Error("rate limit exceeded, try again later"));
      expect(result).toEqual({ reason: "rate_limit_exceeded", retryable: true });
    });
  });

  describe("storage/network errors (retryable)", () => {
    test("classifies fetch failed", () => {
      const result = classifyError(new Error("fetch failed"));
      expect(result).toEqual({ reason: "storage_error", retryable: true });
    });

    test("classifies ECONNRESET", () => {
      const result = classifyError(new Error("read ECONNRESET"));
      expect(result).toEqual({ reason: "storage_error", retryable: true });
    });

    test("classifies ETIMEDOUT", () => {
      const result = classifyError(new Error("connect ETIMEDOUT"));
      expect(result).toEqual({ reason: "storage_error", retryable: true });
    });

    test("classifies network error", () => {
      const result = classifyError(new Error("network error"));
      expect(result).toEqual({ reason: "storage_error", retryable: true });
    });

    test("classifies 5xx server error", () => {
      const result = classifyError(new Error("Gemini API Error (500): Internal Server Error"));
      expect(result).toEqual({ reason: "storage_error", retryable: true });
    });

    test("classifies 502 bad gateway", () => {
      const result = classifyError(new Error("Gemini API Error (502): Bad Gateway"));
      expect(result).toEqual({ reason: "storage_error", retryable: true });
    });

    test("classifies 503 service unavailable", () => {
      const result = classifyError(new Error("Gemini API Error (503): Service Unavailable"));
      expect(result).toEqual({ reason: "storage_error", retryable: true });
    });
  });

  // ── Priority 3: Domain-specific errors ─────────────────────────────────

  describe("domain-specific errors", () => {
    test("classifies embedding errors as retryable", () => {
      const result = classifyError(new Error("Embedding generation failed: timeout"));
      expect(result).toEqual({ reason: "embedding_failed", retryable: true });
    });

    test("classifies extract/parse errors as non-retryable", () => {
      const result = classifyError(new Error("PDF parse failed: invalid structure"));
      expect(result).toEqual({ reason: "extraction_failed", retryable: false });
    });

    test("classifies mammoth errors as non-retryable", () => {
      const result = classifyError(new Error("mammoth error: corrupt document"));
      expect(result).toEqual({ reason: "extraction_failed", retryable: false });
    });
  });

  // ── Priority ordering verification ─────────────────────────────────────

  describe("priority ordering", () => {
    test("non-retryable validation takes precedence over retryable rate limit", () => {
      // This error matches both patterns but should be classified as validation
      const result = classifyError(new Error("Unsupported document type: 429"));
      expect(result.retryable).toBe(false);
    });

    test("non-retryable extraction takes precedence over retryable network", () => {
      const result = classifyError(new Error("No text extracted: fetch failed"));
      expect(result.retryable).toBe(false);
    });
  });

  // ── Fallback / edge cases ──────────────────────────────────────────────

  describe("fallback and edge cases", () => {
    test("classifies unknown errors as retryable", () => {
      const result = classifyError(new Error("Something completely unexpected"));
      expect(result).toEqual({ reason: "unknown_error", retryable: true });
    });

    test("handles string errors", () => {
      const result = classifyError("string error");
      expect(result).toEqual({ reason: "unknown_error", retryable: true });
    });

    test("handles null errors", () => {
      const result = classifyError(null);
      expect(result).toEqual({ reason: "unknown_error", retryable: true });
    });

    test("handles undefined errors", () => {
      const result = classifyError(undefined);
      expect(result).toEqual({ reason: "unknown_error", retryable: true });
    });

    test("handles number errors", () => {
      const result = classifyError(42);
      expect(result).toEqual({ reason: "unknown_error", retryable: true });
    });

    test("handles empty string errors", () => {
      const result = classifyError("");
      expect(result).toEqual({ reason: "unknown_error", retryable: true });
    });

    test("handles Error objects with no message", () => {
      const result = classifyError(new Error());
      expect(result).toEqual({ reason: "unknown_error", retryable: true });
    });

    test("handles very long error messages", () => {
      const longMsg = "x".repeat(10000);
      const result = classifyError(new Error(longMsg));
      expect(result).toEqual({ reason: "unknown_error", retryable: true });
    });
  });
});
