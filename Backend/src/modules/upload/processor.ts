import { minio } from "../../config/minio";
import { env } from "../../config/env";
import prisma from "../../config/prisma";

import { chunkText } from "../../utils/chunking";
import { embedText } from "../../provider/embedding/gemini";

const {PDFParse } = await import("pdf-parse");

export async function processDocument(
  documentId: string,
  fileKey: string
): Promise<void> {
  try {
    console.log(`Processing document: ${documentId}`);

    // 1. Download PDF from object storage (returns Buffer — S3-compatible)
    const buffer = await minio.getObject(env.MINIO_BUCKET, fileKey);

    // 2. Extract text
    const parser = new PDFParse({ data: buffer });
    const { text } = await parser.getText();

    if (!text.trim()) {
      throw new Error("No text extracted from document.");
    }

    // 3. Split into chunks
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      throw new Error("No chunks generated.");
    }

    // 4. Generate embeddings and store them
       // 4. Generate embeddings and store them (raw SQL — Prisma can't write vector columns)
    for (const [index, chunk] of chunks.entries()) {
      const embedding = await embedText(chunk.content);
      const vector = `[${embedding.join(",")}]`;  // pgvector format

      await prisma.$executeRaw`
        INSERT INTO "Chunk" ("id", "documentId", "chunkIndex", "content", "embedding", "createdAT")
        VALUES (gen_random_uuid(), ${documentId}, ${index}, ${chunk.content}, ${vector}::vector, NOW())
      `;
    }

    // 5. Mark document as indexed
    await prisma.document.update({
      where: {
        id: documentId,
      },
      data: {
        status: "READY",
      },
    });

    console.log(
      `Document ${documentId} indexed successfully (${chunks.length} chunks)`
    );
  } catch (error) {
    console.error(`Failed to process document ${documentId}:`, error);

    await prisma.document.update({
      where: {
        id: documentId,
      },
      data: {
        status: "FAILED",
      },
    });

    throw error;
  }
}
