import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import prisma from "../../config/prisma";
import { embedText } from "../../provider/embedding/gemini";
import { streamChat, type TokenUsage } from "../../provider/llm/groq";
import { setupSSE, sendSSE, sendSSEDone } from "../../utils/sse";
import logger from "../../logger";
import { traceRagQuery, traceRetrieval, traceGeneration, flushLangfuse } from "../../config/langfuse";
import { z } from "zod";
import {
  expandQuery,
  getPersonLookupTerm,
  buildLexicalTsQuery,
  buildDocFilter,
  mergeRetrievalResults,
  TOP_K,
  MAX_DISTANCE,
  type SearchResult,
} from "./retrieval";

const SESSION_COOKIE = "rag_session_id";

const ChatQuerySchema = z.object({
  question: z.string().min(1, "Question is required").max(5000, "Question too long"),
  documentId: z.string().uuid().optional(),
});

const ChatBodySchema = z.object({
  question: z.string().min(1, "Question is required").max(5000, "Question too long"),
  documentId: z.string().uuid().optional(),
});

const CHAT_TIMEOUT_MS = 60_000;

async function handleChat(question: string, reply: FastifyReply, documentId?: string, sessionId?: string) {
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

    const trace = await traceRagQuery({ question, documentId, sessionId });

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
    const vectorRows = await prisma.$queryRaw<SearchResult[]>`
      SELECT c.content, d.filename, c.embedding <=> ${vector}::vector AS distance
      FROM "Chunk" c
      JOIN "Document" d ON d.id = c."documentId"
      WHERE ${docFilter}
      ORDER BY c.embedding <=> ${vector}::vector
      LIMIT ${TOP_K}
    `;

    if (abortController.signal.aborted) throw new Error("Request aborted.");

    const lexicalQuery = buildLexicalTsQuery(question);
    const lexicalRows: SearchResult[] = lexicalQuery
      ? await prisma.$queryRaw<SearchResult[]>`
          SELECT c.content, d.filename, 0::double precision AS distance
          FROM "Chunk" c
          JOIN "Document" d ON d.id = c."documentId"
          WHERE ${docFilter}
            AND to_tsvector('simple', c.content) @@ to_tsquery('simple', ${lexicalQuery})
          ORDER BY ts_rank(to_tsvector('simple', c.content), to_tsquery('simple', ${lexicalQuery})) DESC
          LIMIT ${TOP_K}
        `
      : [];

    const personTerm = getPersonLookupTerm(question);
    const ownerRows: SearchResult[] = personTerm
      ? await prisma.$queryRaw<SearchResult[]>`
          SELECT c.content, d.filename, 0::double precision AS distance
          FROM "Chunk" c JOIN "Document" d ON d.id = c."documentId"
          WHERE ${docFilter}
            AND (c.metadata->>'owner' ILIKE ${`%${personTerm}%`} OR d.filename ILIKE ${`%${personTerm}%`})
          ORDER BY c."chunkIndex" ASC LIMIT ${TOP_K}
        `
      : [];

    const relevant = mergeRetrievalResults(ownerRows, lexicalRows, vectorRows);
    const rows = relevant.length > 0 ? relevant : vectorRows;

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

    await traceRetrieval(trace, {
      chunksFound: relevant.length,
      topDistance: rows[0] ? Number(rows[0].distance) : 0,
      latencyMs: Date.now() - startTime,
      query: expandedQuestion,
      sourceDocuments: sourceDocs,
    });

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
      return;
    }

    sendSSE(reply, {
      type: "status",
      step: "generation",
      message: "🤖 Streaming AI response...",
    });

    const usageRef: { current: TokenUsage | null } = { current: null };
    const genSpan = await traceGeneration(trace, {
      model: "llama-3.1-8b-instant",
      input: [
        { role: "system", content: `Retrieved ${contextChunks.length} chunks from ${sourceDocs.join(", ") || "documents"}` },
        { role: "user", content: question },
      ],
    });

    let fullAnswer = "";
    for await (const token of streamChat(question, contextChunks, abortController.signal, usageRef)) {
      if (reply.raw.destroyed) break;
      fullAnswer += token;
      sendSSE(reply, {
        type: "token",
        content: token,
      });
    }

    if (genSpan) {
      const genUpdate: { output: string; usage?: { input: number; output: number; total: number } } = { output: fullAnswer };
      if (usageRef.current) {
        genUpdate.usage = usageRef.current;
      }
      genSpan.end(genUpdate);
    }

    if (!reply.raw.destroyed) {
      sendSSE(reply, {
        type: "sources",
        count: contextChunks.length,
        documents: sourceDocs,
        chunks: contextChunks,
      });
    }

    if (trace) {
      trace.update({ output: fullAnswer });
    }
    await flushLangfuse();
  } catch (error: any) {
    logger.error({ err: error }, "❌ Error in handleChat");
    reply.log.error(error);

    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      const detail = error?.message || "Unknown error";
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

function getOrCreateSessionId(request: any, reply: FastifyReply): string {
  const existing = request.cookies?.[SESSION_COOKIE];
  if (existing && typeof existing === "string") return existing;

  const sessionId = randomUUID();
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return sessionId;
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
    const sessionId = getOrCreateSessionId(request, reply);
    return handleChat(question, reply, documentId, sessionId);
  });

  app.post("/chat", async (request, reply) => {
    const parsed = ChatBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        message: parsed.error.issues[0]?.message || "Invalid request",
      });
    }
    const { question, documentId } = parsed.data;
    const sessionId = getOrCreateSessionId(request, reply);
    return handleChat(question, reply, documentId, sessionId);
  });
}
