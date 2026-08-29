import type { FastifyInstance, FastifyReply } from "fastify";
import prisma from "../../config/prisma";
import { embedText } from "../../provider/embedding/gemini";
import { streamChat, type TokenUsage } from "../../provider/llm/groq";
import { setupSSE, sendSSE, sendSSEDone } from "../../utils/sse";
import logger from "../../logger";
import { z } from "zod";
import {
  buildDocFilter,
  buildLexicalTsQuery,
  expandQuery,
  getPersonLookupTerm,
  MAX_DISTANCE,
  mergeRetrievalResults,
  type SearchResult,
  TOP_K,
  MIN_OWNER_RELEVANCE,
} from "./retrieval";
import { databaseCircuitBreaker } from "../../utils/resilience";
import { withSpan } from "../../observability";
import { getSessionId } from "../../session";
import { clearConversations, listConversations, saveConversation } from "./history";

const ChatQuerySchema = z.object({
  question: z.string().min(1, "Question is required").max(5000, "Question too long"),
  documentId: z.string().uuid().optional(),
});

const ChatBodySchema = z.object({
  question: z.string().min(1, "Question is required").max(5000, "Question too long"),
  documentId: z.string().uuid().optional(),
});

const CHAT_TIMEOUT_MS = 60_000;

async function handleChatInternal(question: string, reply: FastifyReply, sessionId: string, documentId?: string) {
  setupSSE(reply);
  const abortController = new AbortController();
  const onDisconnect = () => abortController.abort();
  reply.raw.once("close", onDisconnect);

  const cleanQ = question.trim().toLowerCase();

  if (/^(hi|hello|hey|greetings|start|help|hii|hiii|hey2)$/i.test(cleanQ)) {
    const greetingMsg = `Hello! 👋 I am your RAG Document Intelligence Assistant.

Ask me any question about your uploaded documents.

**Try asking:**
- *Who are the authors of Attention Is All You Need?*
- *What is Manish's email or phone number?*
- *What projects and skills does Shubham have?*`;

    sendSSE(reply, { type: "token", content: greetingMsg });
    sendSSE(reply, { type: "sources", count: 0, documents: [], chunks: [] });
    sendSSEDone(reply);
    await saveConversation(sessionId, question, greetingMsg, [], documentId);
    return;
  }

  const timeout = setTimeout(() => {
    abortController.abort();
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      sendSSE(reply, {
        type: "token",
        content: "> ❌ **Error**: Request timed out. Please try a simpler question or a different document.",
      });
      sendSSEDone(reply);
    }
  }, CHAT_TIMEOUT_MS);

  try {
    const startTime = Date.now();
    const expandedQuestion = expandQuery(question);

    logger.info({ question, expanded: expandedQuestion, scope: documentId || "GLOBAL" }, "📥 Query received");

    sendSSE(reply, {
      type: "status",
      step: "embedding",
      message: "🔍 Generating query embedding vector...",
    });

    const queryEmbedding = await embedText(expandedQuestion, "RETRIEVAL_QUERY", abortController.signal);
    if (abortController.signal.aborted) throw new Error("Request aborted.");

    const vector = `[${queryEmbedding.join(",")}]`;

    sendSSE(reply, {
      type: "status",
      step: "retrieval",
      message: "⚡ Searching pgvector database...",
    });

    const docFilter = buildDocFilter(documentId);
    const vectorRows = await databaseCircuitBreaker.execute(() => withSpan("db.vector_search", { "db.operation": "vector_search" }, () => prisma.$queryRaw<SearchResult[]>`
      SELECT c.content, d.filename, c.embedding <=> ${vector}::vector AS distance
      FROM "Chunk" c
      JOIN "Document" d ON d.id = c."documentId"
      WHERE ${docFilter}
      ORDER BY c.embedding <=> ${vector}::vector
      LIMIT ${TOP_K}
    `));

    if (abortController.signal.aborted) throw new Error("Request aborted.");

    const lexicalQuery = buildLexicalTsQuery(question);
    const lexicalRows: SearchResult[] = lexicalQuery
      ? await databaseCircuitBreaker.execute(() => withSpan("db.lexical_search", { "db.operation": "lexical_search" }, () => prisma.$queryRaw<SearchResult[]>`
          SELECT c.content, d.filename, 0::double precision AS distance, ts_rank(to_tsvector('simple', c.content), to_tsquery('simple', ${lexicalQuery})) AS relevance
          FROM "Chunk" c
          JOIN "Document" d ON d.id = c."documentId"
          WHERE ${docFilter}
            AND to_tsvector('simple', c.content) @@ to_tsquery('simple', ${lexicalQuery})
          ORDER BY relevance DESC
          LIMIT ${TOP_K}
        `))
      : [];

    const personTerm = getPersonLookupTerm(question);
    const ownerRows: SearchResult[] = personTerm
      ? await databaseCircuitBreaker.execute(() => withSpan("db.owner_search", { "db.operation": "owner_search" }, () => prisma.$queryRaw<SearchResult[]>`
          SELECT c.content, d.filename, 0::double precision AS distance
          FROM "Chunk" c JOIN "Document" d ON d.id = c."documentId"
          WHERE ${docFilter}
            AND (c.metadata->>'owner' ILIKE ${`%${personTerm}%`} OR d.filename ILIKE ${`%${personTerm}%`})
          ORDER BY c."chunkIndex" ASC LIMIT ${TOP_K}
        `))
      : [];

    const filteredOwnerRows = personTerm
      ? ownerRows
          .map((row) => ({
            ...row,
            relevance: row.content.toLowerCase().includes(personTerm.toLowerCase()) ? 1.0 : 0.0,
          }))
          .filter((row) => row.relevance >= MIN_OWNER_RELEVANCE)
      : ownerRows;

    const relevant = mergeRetrievalResults(filteredOwnerRows, lexicalRows, vectorRows);
    const rows = relevant;

    const contextChunks = relevant.map((row) => row.content);
    const sourceDocs = [...new Map(relevant.map((row) => [row.filename, row.filename])).keys()];

    const topDist = rows[0] ? Number(rows[0].distance).toFixed(3) : "N/A";
    logger.info(
      {
        retrieved: relevant.length,
        total: rows.length,
        maxDistance: MAX_DISTANCE,
        topSimilarity: rows[0] ? (1 - rows[0].distance).toFixed(3) : "0",
        topDistance: topDist,
        latencyMs: Date.now() - startTime,
      },
      "📊 Retrieval complete"
    );

    sendSSE(reply, {
      type: "status",
      step: "retrieval_complete",
      message: `⚡ Retrieved ${relevant.length} relevant chunks (top distance: ${topDist})`,
    });

    if (contextChunks.length === 0) {
      logger.warn({ question }, "⚠️ No context passed gate");
      sendSSE(reply, {
        type: "token",
        content: "I couldn't find relevant information in your uploaded documents. Please ask something covered by your uploaded files (e.g., author names, emails, projects, or paper details).",
      });
      await saveConversation(sessionId, question, "I couldn't find relevant information in your uploaded documents.", [], documentId);
      return;
    }

    sendSSE(reply, {
      type: "status",
      step: "generation",
      message: "🤖 Streaming AI response...",
    });

    const usageRef: { current: TokenUsage | null } = { current: null };
    let fullAnswer = "";
    for await (const token of streamChat(question, contextChunks, abortController.signal, usageRef)) {
      if (reply.raw.destroyed) break;
      fullAnswer += token;
      sendSSE(reply, {
        type: "token",
        content: token,
      });
    }

    if (!reply.raw.destroyed) {
      sendSSE(reply, {
        type: "sources",
        count: contextChunks.length,
        documents: sourceDocs,
        chunks: contextChunks,
      });
      await saveConversation(sessionId, question, fullAnswer, sourceDocs, documentId);
    }

  } catch (error: any) {
    logger.error({ err: error }, "❌ Error in handleChat");
    reply.log.error(error);

    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      // Never expose provider, database, or infrastructure error details to clients.
      const detail = "The service is temporarily unavailable";
      const userMessage = detail.includes("Failed") || detail.includes("invalid") || detail.includes("API")
        ? detail
        : `Failed to process your request: ${detail}`;
      sendSSE(reply, {
        type: "token",
        content: `> ❌ **Error**: ${userMessage}`,
      });
    }
  } finally {
    clearTimeout(timeout);
    reply.raw.removeListener("close", onDisconnect);
    if (!reply.raw.writableEnded && !reply.raw.destroyed) sendSSEDone(reply);
  }
}

function handleChat(question: string, reply: FastifyReply, sessionId: string, documentId?: string): Promise<void> {
  return withSpan("chat.pipeline", {
    "chat.document_id": documentId || "global",
    "chat.question_length": question.length,
  }, () => handleChatInternal(question, reply, sessionId, documentId));
}

export async function chatRoutes(app: FastifyInstance) {
  app.get("/chat", async (request, reply) => {
    const parsed = ChatQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        message: parsed.error.issues[0]?.message || "Invalid request",
      });
    }
    const { question, documentId } = parsed.data;
    return handleChat(question, reply, getSessionId(request, reply), documentId);
  });

  app.post("/chat", async (request, reply) => {
    const parsed = ChatBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        message: parsed.error.issues[0]?.message || "Invalid request",
      });
    }
    const { question, documentId } = parsed.data;
    return handleChat(question, reply, getSessionId(request, reply), documentId);
  });

  app.get("/conversations", async (request, reply) => {
    return reply.send(await listConversations(getSessionId(request, reply)));
  });

  app.delete("/conversations", async (request, reply) => {
    await clearConversations(getSessionId(request, reply));
    return reply.send({ message: "Conversation history cleared" });
  });
}
