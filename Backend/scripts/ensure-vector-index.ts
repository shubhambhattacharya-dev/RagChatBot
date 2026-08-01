import { Client } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL must be set before vector-index initialization.");
}

const client = new Client({ connectionString });

try {
  await client.connect();
  await client.query(`
    CREATE INDEX IF NOT EXISTS "Chunk_embedding_hnsw_idx"
    ON "Chunk" USING hnsw (embedding vector_cosine_ops)
  `);
  console.log("Chunk HNSW vector index is ready.");
} finally {
  await client.end().catch(() => undefined);
}
