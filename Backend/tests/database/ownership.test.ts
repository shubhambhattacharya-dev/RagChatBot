import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import prisma from "../../src/config/prisma";
import { buildDocFilter } from "../../src/modules/chat/retrieval";
import { deleteConversation } from "../../src/modules/chat/history";

// Runs the chat pipeline's ACTUAL raw SQL (the same queries routes.ts executes)
// against a real PostgreSQL + pgvector instance. This is the layer that catches
// bugs typecheck cannot see: identifier casing in raw SQL, pgvector behaviour,
// and cross-user isolation through the exact filter the production code uses.
//
//   RUN_INTEGRATION_TESTS=1 bun test tests/database

const describeIntegration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const USER_A = randomUUID();
const USER_B = randomUUID();
const DOC_A = `test-own-doc-a-${randomUUID()}`;
const DOC_B = `test-own-doc-b-${randomUUID()}`;

function vector(center: number): string {
  return `[${Array.from({ length: 768 }, () => center).join(",")}]`;
}

async function insertChunk(documentId: string, chunkIndex: number, content: string, center: number, owner: string) {
  await prisma.$executeRaw`
    INSERT INTO "Chunk" ("id", "documentId", "chunkIndex", "content", "embedding", "metadata", "createdAt")
    VALUES (gen_random_uuid(), ${documentId}, ${chunkIndex}, ${content}, ${vector(center)}::vector,
            ${JSON.stringify({ owner })}::jsonb, NOW())
  `;
}

/** The exact vector-search query chat/routes.ts runs (same shape, same filter). */
function vectorSearch(ownerId: string, documentId?: string) {
  const docFilter = buildDocFilter(ownerId, documentId);
  return prisma.$queryRaw<{ content: string; filename: string; distance: number }[]>`
    SELECT c.content, d.filename, c.embedding <=> ${vector(0.1)}::vector AS distance
    FROM "Chunk" c
    JOIN "Document" d ON d.id = c."documentId"
    WHERE ${docFilter}
    ORDER BY c.embedding <=> ${vector(0.1)}::vector
    LIMIT 8
  `;
}

/** The exact lexical-search query chat/routes.ts runs. */
function lexicalSearch(ownerId: string) {
  const docFilter = buildDocFilter(ownerId);
  return prisma.$queryRaw<{ content: string; relevance: number }[]>`
    SELECT c.content, 0::double precision AS distance,
           ts_rank(to_tsvector('simple', c.content), to_tsquery('simple', ${"secret:*"})) AS relevance
    FROM "Chunk" c
    JOIN "Document" d ON d.id = c."documentId"
    WHERE ${docFilter}
      AND to_tsvector('simple', c.content) @@ to_tsquery('simple', ${"secret:*"})
    ORDER BY relevance DESC
    LIMIT 8
  `;
}

/** The exact owner-search query chat/routes.ts runs. */
function ownerSearch(ownerId: string, personTerm: string) {
  const docFilter = buildDocFilter(ownerId);
  return prisma.$queryRaw<{ content: string }[]>`
    SELECT c.content, d.filename, 0::double precision AS distance
    FROM "Chunk" c JOIN "Document" d ON d.id = c."documentId"
    WHERE ${docFilter}
      AND (c.metadata->>'owner' ILIKE ${`%${personTerm}%`} OR d.filename ILIKE ${`%${personTerm}%`})
    ORDER BY c."chunkIndex" ASC LIMIT 8
  `;
}

describeIntegration("chat retrieval ownership isolation (real SQL)", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: USER_A, googleId: `ga-${USER_A}`, email: `a-${USER_A}@test.local`, name: "User A" } });
    await prisma.user.create({ data: { id: USER_B, googleId: `gb-${USER_B}`, email: `b-${USER_B}@test.local`, name: "User B" } });

    await prisma.document.create({
      data: { id: DOC_A, filename: "alice-resume.pdf", mimeType: "application/pdf", status: "READY", fileKey: `${DOC_A}/a.pdf`, ownerId: USER_A },
    });
    await prisma.document.create({
      data: { id: DOC_B, filename: "bob-resume.pdf", mimeType: "application/pdf", status: "READY", fileKey: `${DOC_B}/b.pdf`, ownerId: USER_B },
    });

    await insertChunk(DOC_A, 0, "Alice secret profile: vector search engineer in Paris", 0.1, "alice");
    await insertChunk(DOC_B, 0, "Bob secret profile: database administrator in Berlin", 0.1, "bob");
  });

  afterAll(async () => {
    await prisma.chunk.deleteMany({ where: { documentId: { in: [DOC_A, DOC_B] } } });
    await prisma.document.deleteMany({ where: { id: { in: [DOC_A, DOC_B] } } });
    await prisma.conversation.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
  });

  test("vector search returns only the caller's chunks", async () => {
    const rowsA = await vectorSearch(USER_A);
    const rowsB = await vectorSearch(USER_B);
    expect(rowsA.map((r) => r.filename)).toEqual(["alice-resume.pdf"]);
    expect(rowsB.map((r) => r.filename)).toEqual(["bob-resume.pdf"]);
    expect(rowsA[0]?.distance).toBeCloseTo(0, 1);
  });

  test("lexical search returns only the caller's chunks", async () => {
    const rowsA = await lexicalSearch(USER_A);
    const rowsB = await lexicalSearch(USER_B);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.content).toContain("Alice");
    expect(rowsB.every((r) => !r.content.includes("Alice"))).toBe(true);
  });

  test("owner metadata search cannot cross the tenant boundary", async () => {
    const rowsAsA = await ownerSearch(USER_A, "bob");
    expect(rowsAsA).toHaveLength(0); // bob's chunks exist but belong to user B
    const rowsAsB = await ownerSearch(USER_B, "bob");
    expect(rowsAsB).toHaveLength(1);
  });

  test("scoping to a foreign documentId returns zero rows, not an error or leak", async () => {
    const rows = await vectorSearch(USER_A, DOC_B);
    expect(rows).toHaveLength(0);
  });

  test("non-owner and unknown ids both yield zero rows (no existence leak)", async () => {
    const rows = await vectorSearch(randomUUID());
    expect(rows).toHaveLength(0);
  });

  test("conversation deletion is owner-scoped", async () => {
    const convA = await prisma.conversation.create({
      data: { userId: USER_A, messages: { create: [{ role: "user", content: "hi" }] } },
    });
    const convB = await prisma.conversation.create({
      data: { userId: USER_B, messages: { create: [{ role: "user", content: "hi" }] } },
    });

    expect(await deleteConversation(USER_A, convB.id)).toBe(false); // foreign id → no-op
    expect(await deleteConversation(USER_A, randomUUID())).toBe(false); // unknown id → no-op
    expect(await deleteConversation(USER_A, convA.id)).toBe(true); // own id → deleted
    expect(await prisma.conversation.findUnique({ where: { id: convA.id } })).toBeNull();
    expect(await prisma.conversation.findUnique({ where: { id: convB.id } })).not.toBeNull();
  });
});
