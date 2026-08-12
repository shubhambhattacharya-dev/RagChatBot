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

# 3. Redis for BullMQ — runs IN the container.
#    Free-tier friendly: no metered external Redis (Upstash's 500k req/month
#    quota is burned by BullMQ's blocking-wait polling). Memory-only, so a
#    restart loses the queue — src/app.ts re-queues stranded documents on boot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends redis-server \
 && rm -rf /var/lib/apt/lists/*

# 4. Boot sequence: start Redis → enable pgvector → push schema → start server.
#    Managed Postgres (Render) needs explicit CREATE EXTENSION vector.
EXPOSE 3000
CMD ["sh", "-c", "redis-server --daemonize yes --save '' --appendonly no && bun run db:setup && bun src/app.ts"]
