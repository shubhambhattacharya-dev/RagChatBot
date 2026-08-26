import { Client } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL must be set before vector-index initialization.");
}

const client = new Client({ connectionString });

const INDEXES = [
  {
    name: "Chunk_embedding_hnsw_idx",
    sql: `CREATE INDEX IF NOT EXISTS "Chunk_embedding_hnsw_idx" ON "Chunk" USING hnsw (embedding vector_cosine_ops)`,
  },
  {
    name: "Chunk_documentId_status_idx",
    sql: `CREATE INDEX IF NOT EXISTS "Chunk_documentId_status_idx" ON "Chunk" ("documentId") WHERE "documentId" IS NOT NULL`,
  },
];

try {
  await client.connect();
  for (const idx of INDEXES) {
    await client.query(idx.sql);
    console.log(`${idx.name} is ready.`);
  }
} finally {
  await client.end().catch(() => undefined);
}
