/**
 * Boot-time DB init: enable pgvector BEFORE prisma db push.
 * Locally the pgvector docker image pre-enables it; managed Postgres
 * (Render/Neon/Supabase) does NOT — schema push would fail on vector(768).
 */
import prisma from "../src/config/prisma";

await prisma.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS vector");
await prisma.$disconnect();

console.log("pgvector extension ready");
