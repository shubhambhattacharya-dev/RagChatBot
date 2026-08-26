import prisma from "../../config/prisma";
import logger from "../../logger";

export type DeadLetterReason =
  | "extraction_failed"
  | "embedding_failed"
  | "storage_error"
  | "validation_error"
  | "rate_limit_exceeded"
  | "unknown_error";

export interface DeadLetterEntry {
  documentId: string;
  filename: string;
  reason: DeadLetterReason;
  errorMessage: string;
  failedAt: Date;
  retryable: boolean;
}

type ClassificationRule = {
  pattern: RegExp;
  reason: DeadLetterReason;
  retryable: boolean;
};

const CLASSIFICATION_RULES: ClassificationRule[] = [
  { pattern: /No text extracted/i, reason: "extraction_failed", retryable: false },
  { pattern: /No chunks generated/i, reason: "extraction_failed", retryable: false },
  { pattern: /PDFParse|mammoth|\bparse\b|\bextraction\b/i, reason: "extraction_failed", retryable: false },
  { pattern: /Unsupported document type/i, reason: "validation_error", retryable: false },
  { pattern: /API key is invalid/i, reason: "validation_error", retryable: false },
  { pattern: /invalid.*signature|signature.*invalid|corrupted|file is empty/i, reason: "validation_error", retryable: false },
  { pattern: /429|RESOURCE_EXHAUSTED|rate.?limit/i, reason: "rate_limit_exceeded", retryable: true },
  { pattern: /fetch failed|ECONNRESET|ETIMEDOUT|network|5\d{2}/i, reason: "storage_error", retryable: true },
  { pattern: /embedding|embed/i, reason: "embedding_failed", retryable: true },
];

export function classifyError(error: unknown): { reason: DeadLetterReason; retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error);

  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(message)) {
      return { reason: rule.reason, retryable: rule.retryable };
    }
  }

  return { reason: "unknown_error", retryable: true };
}

export async function markDeadLetter(documentId: string, error: unknown): Promise<void> {
  const { reason, retryable } = classifyError(error);
  const message = error instanceof Error ? error.message : String(error);

  logger.error({ documentId, reason, retryable, errorMessage: message.slice(0, 500) }, "☠️ Document moved to dead letter queue");

  await prisma.document.update({ where: { id: documentId }, data: { status: "FAILED" } }).catch(() => undefined);
  await prisma.chunk.deleteMany({ where: { documentId } }).catch(() => undefined);
}

export async function getDeadLetters(): Promise<DeadLetterEntry[]> {
  const failed = await prisma.document.findMany({
    where: { status: "FAILED" },
    select: { id: true, filename: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });

  return failed.map((doc) => ({
    documentId: doc.id,
    filename: doc.filename,
    reason: "unknown_error" as DeadLetterReason,
    errorMessage: "Document processing failed",
    failedAt: doc.updatedAt,
    retryable: true,
  }));
}

export async function retryDeadLetter(documentId: string): Promise<{ requeued: boolean; reason?: string }> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, status: true, fileKey: true },
  });

  if (!doc) return { requeued: false, reason: "Document not found" };
  if (doc.status !== "FAILED") return { requeued: false, reason: `Document status is ${doc.status}, not FAILED` };

  try {
    const { documentQueue } = await import("../../config/redis");
    await documentQueue.add("index-document", { documentId: doc.id, fileKey: doc.fileKey }, { jobId: doc.id });
    await prisma.document.update({ where: { id: documentId }, data: { status: "QUEUED" } });
    logger.info({ documentId }, "♻️ Dead-letter document re-queued for processing");
    return { requeued: true };
  } catch (error) {
    logger.error({ documentId, err: error }, "Failed to re-queue dead-letter document");
    return { requeued: false, reason: "Failed to enqueue" };
  }
}
