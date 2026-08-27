import fastify from "fastify";
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import multipart from "@fastify/multipart"
import staticFiles from '@fastify/static'
import { fileURLToPath } from "node:url";
import {env, assertRuntimeConfig} from './config/env'
import logger from './logger'
import { ensureBucket } from "./config/minio";
import { uploadRoutes } from "./modules/upload/router";
import { statusRoutes } from "./modules/upload/status";
import { chatRoutes } from "./modules/chat/routes";
import { createWorker, documentQueue, redis } from "./config/redis";
import prisma from "./config/prisma";
import { processDocument } from "./modules/upload/processor";
import { withTimeout } from "./utils/timeout";

/** A slow dependency must never hang /health — the UI status dot and Render's
 *  own health checks both depend on it answering quickly. */
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

async function dependencyCheck(
  label: string,
  probe: () => Promise<unknown>
): Promise<[string, string]> {
  try {
    await withTimeout(probe(), HEALTH_CHECK_TIMEOUT_MS);
    return [label, "ok"];
  } catch (err: any) {
    return [label, `error: ${err?.message || err}`];
  }
}

export async function buildApp(){
    assertRuntimeConfig();
    const app=fastify({logger:{level:env.LOG_LEVEL}})
    const corsOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
    const documentWorker = createWorker("document-processing", async (job) => {
      await processDocument(job.data.documentId, job.data.fileKey);
    });

    // In-container Redis is ephemeral — a restart wipes the queue. Re-queue any
    // documents a previous run left stranded in QUEUED/PROCESSING so they still
    // get indexed (jobId dedupes — no double-processing). Non-fatal: a transient
    // DB/Redis outage at boot must not prevent the server from starting.
    try {
      const stranded = await prisma.document.findMany({
        where: { status: { in: ["QUEUED", "PROCESSING"] } },
        select: { id: true, fileKey: true },
      });
      await Promise.allSettled(
        stranded.map((doc) =>
          documentQueue.add(
            "index-document",
            { documentId: doc.id, fileKey: doc.fileKey },
            { jobId: doc.id }
          )
        )
      );
      if (stranded.length > 0) {
        logger.info({ count: stranded.length }, `Re-queued ${stranded.length} document(s) left over from a previous run`);
      }
    } catch (error) {
      logger.warn({ err: error }, "Failed to re-queue leftover documents");
    }
    app.addHook("onClose", async () => {
      await documentWorker.close();
      await documentQueue.close();
      await redis.quit();
      await prisma.$disconnect();
    });
    //plugin — configurable CORS origin (default: true for dev, set CORS_ORIGIN in prod)
    await app.register(cookie)
    await app.register(cors, {
      origin: corsOrigins.length > 0 ? corsOrigins : false,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    })
    await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
    // serve frontend from ../Frontend (same origin — no CORS)
    await app.register(staticFiles, {
      root: fileURLToPath(new URL("../../Frontend", import.meta.url)),
      prefix: "/",
    });
    await app.register(uploadRoutes)
    await app.register(statusRoutes)
    await app.register(chatRoutes)

    // ── Health check ──────────────────────────────────────────────────
    // Verifies DB + Redis are reachable (not just "server is up").
    // Each probe races a timeout — a dead dependency reports fast instead
    // of hanging the endpoint (frontend aborts at 4s and Render probes too).
    app.get("/health", async (_request, reply) => {
      const checks: Record<string, string> = Object.fromEntries([
        await dependencyCheck("postgres", () => prisma.$queryRaw`SELECT 1`),
        await dependencyCheck("redis", () => redis.ping()),
      ]);

      const healthy = Object.values(checks).every((v) => v === "ok");
      const status = healthy ? 200 : 503;

      return reply.status(status).send({
        status: healthy ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        checks,
      });
    });

    //ensure minio bucket exist
    await ensureBucket();

return app;

}

const app=await buildApp();

async function startServer(port: number): Promise<void> {
  try {
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`🚀 Server running on http://localhost:${port}`);
  } catch (err: any) {
    if (err.code === "EADDRINUSE") {
      throw new Error(`Port ${port} is already in use. Stop the existing process or choose a different PORT.`);
    }
    throw err;
  }
}

await startServer(env.PORT);

//graceful shutdown

const listeners=["SIGINT","SIGTERM"] as const ;
for(const signal of listeners){
    process.on(signal,async()=>{
        logger.info(`\n${signal} received — shutting down gracefully...`)
        await app.close()
        process.exit(0)
    })
}
