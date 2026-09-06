import type { FastifyInstance } from "fastify";
import prisma from "../../config/prisma";
import { minio } from "../../config/minio";
import { env } from "../../config/env";
import logger from "../../logger";
import { getDeadLetters, retryDeadLetter } from "./dead-letter";
import { requireUser } from "../auth/routes";

export async function statusRoutes(app: FastifyInstance) {
  app.get("/documents", { preHandler: requireUser }, async (request) => {
    const docs = await prisma.document.findMany({
      where: { ownerId: request.user!.id },
      select: {
        id: true,
        filename: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return docs;
  });

  // Ownership-scoped lookups 404 on other users' documents — same response as
  // a missing id, so document identifiers can't be probed across accounts.
  app.get("/document/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const doc = await prisma.document.findFirst({
      where: { id, ownerId: request.user!.id },
      select: { id: true, filename: true, status: true },
    });

    if (!doc) {
      return reply.status(404).send({ message: "Document not found" });
    }

    return reply.send(doc);
  });

  app.delete("/document/:id", { preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = await prisma.document.findFirst({
      where: { id, ownerId: request.user!.id },
    });
    if (!existing) {
      return reply.status(404).send({ message: "Document not found" });
    }

    await prisma.chunk.deleteMany({ where: { documentId: id } });
    await prisma.document.delete({ where: { id } });

    // Remove the original file from MinIO too (ignore failure — DB already clean)
    try {
      await minio.removeObject(env.MINIO_BUCKET, existing.fileKey);
    } catch (err) {
      logger.warn({ documentId: id, err }, "Failed to remove MinIO object");
    }

    return reply.send({ message: "Document deleted", id });
  });


  app.get("/admin/dead-letters", { preHandler: requireUser }, async () => {
    const entries = await getDeadLetters();
    return { count: entries.length, entries };
  });

  app.post<{ Params: { id: string } }>('/admin/retry/:id', { preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await retryDeadLetter(id);

    if (!result.requeued) {
      return reply.status(400).send({ message: result.reason || "Cannot retry" });
    }

    return reply.send({ message: "Document re-queued for processing", id });
  });
}
