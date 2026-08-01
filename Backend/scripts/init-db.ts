import { Client } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL must be set before database initialization.");
}

const client = new Client({ connectionString });

try {
  await client.connect();
  await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  console.log("pgvector extension is ready.");
} finally {
  await client.end().catch(() => undefined);
}
