import { minio } from "../../config/minio";
import { env } from "../../config/env";
import prisma from "../../config/prisma";
import logger from "../../logger";

import { chunkText, detectDocumentOwner, enrichChunks, getChunkMetadata } from "../../utils/chunking";
import { embedBatch, embedText } from "../../provider/embedding/gemini";
import { extractText } from "../../services/document/extract";
import { markDeadLetter, classifyError } from "./dead-letter";

export async function processDocument(
  documentId: string,
  fileKey: string
): Promise<void> {
  try {
    logger.info({ documentId }, "Processing document");

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { filename: true, mimeType: true },
    });
    if (!document) return;

    await prisma.document.update({ where: { id: documentId }, data: { status: "PROCESSING" } });
    await prisma.chunk.deleteMany({ where: { documentId } });

    const buffer = await minio.getObject(env.MINIO_BUCKET, fileKey);

    const text = await extractText(buffer, document.mimeType, document.filename);

    if (!text.trim()) {
      throw new Error("No text extracted from document.");
    }

    const chunks = chunkText(text);

    if (chunks.length === 0) {
      throw new Error("No chunks generated.");
    }


    const filename = document.filename;

    const enriched = enrichChunks(chunks, filename);
    const owner = detectDocumentOwner(chunks);

    const chunkContents = enriched.map((c) => c.content);
    const embeddings = await embedBatch(chunkContents, "RETRIEVAL_DOCUMENT");

    for (let index = 0; index < enriched.length; index++) {
      const chunk = enriched[index]!;
      const embedding = embeddings[index]!;
      const vector = `[${embedding.join(",")}]`; // pgvector format
      const metadata = JSON.stringify(getChunkMetadata(chunks[index]!, filename, owner));

      await prisma.$executeRaw`
        INSERT INTO "Chunk" ("id", "documentId", "chunkIndex", "content", "embedding", "metadata", "createdAt")
        VALUES (gen_random_uuid(), ${documentId}, ${index}, ${chunk.content}, ${vector}::vector, ${metadata}::jsonb, NOW())
      `;
    }

    await prisma.document.update({
      where: {
        id: documentId,
      },
      data: {
        status: "READY",
      },
    });

    logger.info({ documentId, chunks: chunks.length }, "Document indexed successfully");
  } catch (error) {
    const { reason, retryable } = classifyError(error);
    logger.error({ documentId, err: error, reason, retryable }, "Failed to process document");

    await markDeadLetter(documentId, error);

    throw error;
  }
}
