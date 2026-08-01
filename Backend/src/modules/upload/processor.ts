import { minio } from "../../config/minio";
import { env } from "../../config/env";
import prisma from "../../config/prisma";

import { chunkText, detectDocumentOwner, enrichChunks, getChunkMetadata } from "../../utils/chunking";
import { embedText } from "../../provider/embedding/gemini";
import { extractText } from "../../services/document/extract";

export async function processDocument(
  documentId: string,
  fileKey: string
): Promise<void> {
  try {
    console.log(`Processing document: ${documentId}`);

    // 1. Download PDF from object storage (returns Buffer — S3-compatible)
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { filename: true, mimeType: true },
    });
    if (!document) return;

    await prisma.document.update({ where: { id: documentId }, data: { status: "PROCESSING" } });
    await prisma.chunk.deleteMany({ where: { documentId } });

    const buffer = await minio.getObject(env.MINIO_BUCKET, fileKey);

    // 2. Extract text
    const text = await extractText(buffer, document.mimeType, document.filename);

    if (!text.trim()) {
      throw new Error("No text extracted from document.");
    }

    // 3. Split into chunks
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      throw new Error("No chunks generated.");
    }

    // 3b. Enrich with metadata: Document name + Section labels + labeled
    // contact fields (Email:/Phone:/Website:). The embedding now contains
    // the WORDS "email", "phone", "website" next to the values — so
    // "what is the email?" matches the chunk semantically (raw values like
    // "bhattacharya.manish8@gmail.com" alone embed poorly against queries).
    const filename = document.filename;

    const enriched = enrichChunks(chunks, filename);
    const owner = detectDocumentOwner(chunks);

    // 4. Generate embeddings and store them
       // 4. Generate embeddings and store them (raw SQL — Prisma can't write vector columns)
    for (const [index, chunk] of enriched.entries()) {
      const embedding = await embedText(chunk.content, "RETRIEVAL_DOCUMENT");
      const vector = `[${embedding.join(",")}]`;  // pgvector format
      const metadata = JSON.stringify(getChunkMetadata(chunks[index]!, filename, owner));

      await prisma.$executeRaw`
        INSERT INTO "Chunk" ("id", "documentId", "chunkIndex", "content", "embedding", "metadata", "createdAT")
        VALUES (gen_random_uuid(), ${documentId}, ${index}, ${chunk.content}, ${vector}::vector, ${metadata}::jsonb, NOW())
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

    await prisma.chunk.deleteMany({ where: { documentId } });
    await prisma.document
      .update({ where: { id: documentId }, data: { status: "FAILED" } })
      .catch(() => undefined);

    throw error;
  }
}
