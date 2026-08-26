import { afterAll, beforeAll, describe, expect, test } from "vitest";
import prisma from "../../src/config/prisma";

const TEST_DOC_ID = "test-db-doc-0001";
const describeIntegration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;

describeIntegration("database storage", () => {
  beforeAll(async () => {
    await prisma.document.create({
      data: {
        id: TEST_DOC_ID,
        filename: "db-test.pdf",
        status: "READY",
        mimeType: "application/pdf",
        fileKey: `${TEST_DOC_ID}/db-test.pdf`,
      },
    });
  });

  afterAll(async () => {
    await prisma.chunk.deleteMany({ where: { documentId: TEST_DOC_ID } });
    await prisma.document.deleteMany({ where: { id: TEST_DOC_ID } });
  });

  test("chunk with embedding and metadata inserts via raw SQL", async () => {
    const vector = `[${Array.from({ length: 768 }, () => 0.1).join(",")}]`;
    await prisma.$executeRaw`
      INSERT INTO "Chunk" ("id", "documentId", "chunkIndex", "content", "embedding", "metadata", "createdAt")
      VALUES (gen_random_uuid(), ${TEST_DOC_ID}, 0, ${"Document: db-test.pdf\nSection: Test"}, ${vector}::vector, ${JSON.stringify({ filename: "db-test.pdf", chunkIndex: 0 })}::jsonb, NOW())
    `;

    const rows = await prisma.$queryRaw<{ content: string; metadata: unknown; dims: number }[]>`
      SELECT content, metadata, vector_dims(embedding) AS dims
      FROM "Chunk" WHERE "documentId" = ${TEST_DOC_ID}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toContain("Document: db-test.pdf");
    expect(rows[0]?.dims).toBe(768);
    expect(JSON.stringify(rows[0]?.metadata)).toContain("db-test.pdf");
  });

  test("vector similarity query returns an identical vector at distance zero", async () => {
    const queryVector = `[${Array.from({ length: 768 }, () => 0.1).join(",")}]`;
    const rows = await prisma.$queryRaw<{ distance: number }[]>`
      SELECT c.embedding <=> ${queryVector}::vector AS distance
      FROM "Chunk" c WHERE c."documentId" = ${TEST_DOC_ID}
      ORDER BY c.embedding <=> ${queryVector}::vector
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.distance).toBeCloseTo(0, 1);
  });
});
