# RAG ChatBot — Backend + Frontend (single image, sibling structure preserved)
# Context: repo root. Run: docker build -t ragchatbot .
FROM oven/bun:1.3.14 AS base
WORKDIR /app

# 1. Install dependencies first (cache layer — only re-runs when manifests change)
COPY Backend/package.json Backend/bun.lock ./backend/
RUN cd backend && bun install

# 2. Copy source — Backend and Frontend must stay siblings:
#    src/app.ts serves ../../Frontend via fileURLToPath(new URL(...))
#    NOTE: exact case matters on Linux — the app resolves "Frontend"
COPY Backend ./backend
COPY Frontend ./Frontend

WORKDIR /app/backend

# 3. Boot sequence: enable pgvector → push schema → start server.
#    Managed Postgres (Render) needs explicit CREATE EXTENSION vector.
EXPOSE 3000
CMD ["sh", "-c", "bun run db:setup && bun src/app.ts"]
