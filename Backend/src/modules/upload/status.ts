import { FastifyInstance } from "fastify";
import prisma from "../../config/prisma";
import { minio } from "../../config/minio";
import { env } from "../../config/env";

export async function statusRoutes(app: FastifyInstance) {
  // List all documents (for the knowledge-base sidebar)
  app.get("/documents", async () => {
    const docs = await prisma.document.findMany({
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

  // Single document status (frontend polls after upload)
  app.get("/document/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const doc = await prisma.document.findUnique({
      where: { id },
      select: { id: true, filename: true, status: true },
    });

    if (!doc) {
      return reply.status(404).send({ message: "Document not found" });
    }

    return reply.send(doc);
  });

  // Delete a document (chunks cascade first — FK is RESTRICT)
  app.delete("/document/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = await prisma.document.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ message: "Document not found" });
    }

    await prisma.chunk.deleteMany({ where: { documentId: id } });
    await prisma.document.delete({ where: { id } });

    // Remove the original file from MinIO too (ignore failure — DB already clean)
    try {
      await minio.removeObject(env.MINIO_BUCKET, existing.fileKey);
    } catch (err) {
      reply.log.warn(`Failed to remove MinIO object for ${id}: ${err}`);
    }

    return reply.send({ message: "Document deleted", id });
  });
}
