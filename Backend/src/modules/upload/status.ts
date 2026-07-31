import { FastifyInstance } from "fastify";
import prisma from "../../config/prisma";

export async function statusRoutes(app: FastifyInstance) {
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
}
