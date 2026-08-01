import fastify from "fastify";
import cors from '@fastify/cors'
import multipart from "@fastify/multipart"
import staticFiles from '@fastify/static'
import { fileURLToPath } from "node:url";
import {env, assertRuntimeConfig} from './config/env'
import { ensureBucket } from "./config/minio";
import { uploadRoutes } from "./modules/upload/router";
import { statusRoutes } from "./modules/upload/status";
import { chatRoutes } from "./modules/chat/routes";
import { createWorker, documentQueue, redis } from "./config/redis";
import prisma from "./config/prisma";
import { processDocument } from "./modules/upload/processor";

export async function buildApp(){
    assertRuntimeConfig();
    const app=fastify({logger:{level:env.LOG_LEVEL}})
    const corsOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
    const documentWorker = createWorker("document-processing", async (job) => {
      await processDocument(job.data.documentId, job.data.fileKey);
    });
    app.addHook("onClose", async () => {
      await documentWorker.close();
      await documentQueue.close();
      await redis.quit();
      await prisma.$disconnect();
    });
    //plugin — configurable CORS origin (default: true for dev, set CORS_ORIGIN in prod)
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
    app.get("/health", async (_request, reply) => {
      const checks: Record<string, string> = {};

      // Postgres via Prisma
      try {
        await prisma.$queryRaw`SELECT 1`;
        checks.postgres = "ok";
      } catch (err: any) {
        checks.postgres = `error: ${err?.message || err}`;
      }

      // Redis
      try {
        await redis.ping();
        checks.redis = "ok";
      } catch (err: any) {
        checks.redis = `error: ${err?.message || err}`;
      }

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
await app.listen({port:env.PORT,host:"0.0.0.0"});
console.log(`🚀 Server running on http://localhost:${env.PORT}`);

//graceful shutdown

const listeners=["SIGINT","SIGTERM"] as const ;
for(const signal of listeners){
    process.on(signal,async()=>{
        console.log(`\n${signal} received — shutting down gracefully...`)
        await app.close()
        process.exit(0)
    })
}
