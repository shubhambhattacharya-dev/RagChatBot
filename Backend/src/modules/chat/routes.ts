import { FastifyInstance, FastifyReply } from "fastify";
import prisma from "../../config/prisma";
import { embedText } from "../../provider/embedding/gemini";
import { streamChat } from "../../provider/llm/groq";
import { setupSSE, sendSSE, sendSSEDone } from "../../utils/sse";

interface ChatBody {
  question: string;
  documentId?: string;
}

const TOP_K = 5;
// pgvector cosine distance (`<=>`): 0 = identical, ~1 = orthogonal.
// Chunks farther than this are NOT evidence — the LLM is never called with
// weak context, so the answer cannot drift into model memory (anti-hallucination).
const MAX_DISTANCE = 0.5;

async function handleChat(question: string, reply: FastifyReply, documentId?: string) {
  setupSSE(reply);

  try {
    // Generate embedding for the user's question
    const queryEmbedding = await embedText(question);

    // Convert embedding to pgvector format
    const vector = `[${queryEmbedding.join(",")}]`;

    // Retrieve the most relevant chunks — scoped to one document when selected.
    // Join the Document filename so the UI can cite the actual source file.
    const rows = documentId
      ? await prisma.$queryRaw<{ content: string; filename: string; distance: number }[]>`
          SELECT c.content, d.filename, c.embedding <=> ${vector}::vector AS distance
          FROM "Chunk" c
          JOIN "Document" d ON d.id = c."documentId"
          WHERE c."documentId" = ${documentId}
          ORDER BY c.embedding <=> ${vector}::vector
          LIMIT ${TOP_K}
        `
      : await prisma.$queryRaw<{ content: string; filename: string; distance: number }[]>`
          SELECT c.content, d.filename, c.embedding <=> ${vector}::vector AS distance
          FROM "Chunk" c
          JOIN "Document" d ON d.id = c."documentId"
          ORDER BY c.embedding <=> ${vector}::vector
          LIMIT ${TOP_K}
        `;

    // Only chunks close enough to the question count as retrieved evidence
    const relevant = rows.filter((row) => row.distance <= MAX_DISTANCE);
    const contextChunks = relevant.map((row) => row.content);
    const sourceDocs = [...new Map(relevant.map((row) => [row.filename, row.filename])).keys()];

    // Grounded-only: no relevant context -> refuse. Never answer from LLM memory.
    if (contextChunks.length === 0) {
      sendSSE(reply, {
        type: "warning",
        message:
          "I couldn't find this in your documents. Ask something covered by an uploaded file.",
      });
      return;
    }

    // Stream LLM response token-by-token — grounded in the retrieved chunks only
    for await (const token of streamChat(question, contextChunks)) {
      sendSSE(reply, {
        type: "token",
        content: token,
      });
    }

    // Send retrieved sources (document names for citation chips)
    sendSSE(reply, {
      type: "sources",
      count: contextChunks.length,
      documents: sourceDocs,
      chunks: contextChunks,
    });
  } catch (error) {
    reply.log.error(error);

    sendSSE(reply, {
      type: "error",
      message: "Failed to process your request.",
    });
  } finally {
    sendSSEDone(reply);
  }
}

export async function chatRoutes(app: FastifyInstance) {
  // Frontend uses GET with ?question= for SSE streaming
  app.get("/chat", async (request, reply) => {
    const { question, documentId } = request.query as {
      question?: string;
      documentId?: string;
    };

    if (!question?.trim()) {
      return reply.status(400).send({
        message: "Question is required",
      });
    }

    return handleChat(question, reply, documentId);
  });

  // API clients use POST with JSON body
  app.post("/chat", async (request, reply) => {
    const { question, documentId } = (request.body ?? {}) as ChatBody;

    if (!question?.trim()) {
      return reply.status(400).send({
        message: "Question is required",
      });
    }

    return handleChat(question, reply, documentId);
  });
}
