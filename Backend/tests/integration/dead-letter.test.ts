import { describe, expect, test, vi, beforeEach } from "vitest";
import { classifyError, markDeadLetter, getDeadLetters, retryDeadLetter } from "../../src/modules/upload/dead-letter";

// Mock Prisma and Redis
vi.mock("../../src/config/prisma", () => ({
  default: {
    document: {
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    chunk: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

vi.mock("../../src/config/redis", () => ({
  documentQueue: {
    add: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../../src/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import prisma from "../../src/config/prisma";
import { documentQueue } from "../../src/config/redis";

describe("Dead-Letter Queue Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── classifyError → markDeadLetter flow ────────────────────────────────

  describe("classifyError → markDeadLetter flow", () => {
    test("marks document as FAILED with validation error", async () => {
      const error = new Error("Unsupported document type: application/x-rar");
      const { reason, retryable } = classifyError(error);

      expect(reason).toBe("validation_error");
      expect(retryable).toBe(false);

      await markDeadLetter("doc-123", error);

      expect(prisma.document.update).toHaveBeenCalledWith({
        where: { id: "doc-123" },
        data: { status: "FAILED" },
      });
      expect(prisma.chunk.deleteMany).toHaveBeenCalledWith({
        where: { documentId: "doc-123" },
      });
    });

    test("marks document as FAILED with extraction error", async () => {
      const error = new Error("No text extracted from document.");
      await markDeadLetter("doc-456", error);

      expect(prisma.document.update).toHaveBeenCalledWith({
        where: { id: "doc-456" },
        data: { status: "FAILED" },
      });
    });

    test("marks document as FAILED with rate limit error", async () => {
      const error = new Error("RESOURCE_EXHAUSTED: quota exceeded");
      await markDeadLetter("doc-789", error);

      expect(prisma.document.update).toHaveBeenCalledWith({
        where: { id: "doc-789" },
        data: { status: "FAILED" },
      });
    });

    test("cleans up partial chunks on failure", async () => {
      await markDeadLetter("doc-abc", new Error("embedding failed"));

      expect(prisma.chunk.deleteMany).toHaveBeenCalledWith({
        where: { documentId: "doc-abc" },
      });
    });
  });

  // ── getDeadLetters ─────────────────────────────────────────────────────

  describe("getDeadLetters", () => {
    test("returns empty array when no failed documents", async () => {
      (prisma.document.findMany as any).mockResolvedValue([]);
      const entries = await getDeadLetters();
      expect(entries).toEqual([]);
    });

    test("returns failed documents", async () => {
      (prisma.document.findMany as any).mockResolvedValue([
        { id: "doc-1", filename: "test.pdf", createdAt: new Date(), updatedAt: new Date() },
      ]);
      const entries = await getDeadLetters();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.documentId).toBe("doc-1");
      expect(entries[0]!.filename).toBe("test.pdf");
    });
  });

  // ── retryDeadLetter ────────────────────────────────────────────────────

  describe("retryDeadLetter", () => {
    test("returns error when document not found", async () => {
      (prisma.document.findUnique as any).mockResolvedValue(null);
      const result = await retryDeadLetter("nonexistent");
      expect(result.requeued).toBe(false);
      expect(result.reason).toBe("Document not found");
    });

    test("returns error when document is not in FAILED state", async () => {
      (prisma.document.findUnique as any).mockResolvedValue({
        id: "doc-1",
        status: "READY",
        fileKey: "key",
      });
      const result = await retryDeadLetter("doc-1");
      expect(result.requeued).toBe(false);
      expect(result.reason).toContain("READY");
    });

    test("re-queues a FAILED document for processing", async () => {
      (prisma.document.findUnique as any).mockResolvedValue({
        id: "doc-1",
        status: "FAILED",
        fileKey: "doc-1/test.pdf",
      });

      const result = await retryDeadLetter("doc-1");

      expect(result.requeued).toBe(true);
      expect(documentQueue.add).toHaveBeenCalledWith(
        "index-document",
        { documentId: "doc-1", fileKey: "doc-1/test.pdf" },
        { jobId: "doc-1" }
      );
      expect(prisma.document.update).toHaveBeenCalledWith({
        where: { id: "doc-1" },
        data: { status: "QUEUED" },
      });
    });
  });

  // ── End-to-end classification flow ─────────────────────────────────────

  describe("end-to-end classification flow", () => {
    test("processes multiple error types in sequence", async () => {
      const errors = [
        { error: new Error("Unsupported document type"), expectedReason: "validation_error" },
        { error: new Error("No text extracted"), expectedReason: "extraction_failed" },
        { error: new Error("429 rate limit"), expectedReason: "rate_limit_exceeded" },
        { error: new Error("fetch failed"), expectedReason: "storage_error" },
        { error: new Error("Embedding generation failed"), expectedReason: "embedding_failed" },
      ];

      for (const { error, expectedReason } of errors) {
        const { reason } = classifyError(error);
        expect(reason).toBe(expectedReason);
      }
    });
  });
});
