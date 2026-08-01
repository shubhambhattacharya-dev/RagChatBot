import type { FastifyInstance, FastifyReply } from "fastify";
import prisma from "../../config/prisma";
import { embedText } from "../../provider/embedding/gemini";
import { streamChat } from "../../provider/llm/groq";
import { setupSSE, sendSSE, sendSSEDone } from "../../utils/sse";
import { z } from "zod";

const ChatQuerySchema = z.object({
  question: z.string().min(1, "Question is required").max(5000, "Question too long"),
  documentId: z.string().uuid().optional(),
});

const ChatBodySchema = z.object({
  question: z.string().min(1, "Question is required").max(5000, "Question too long"),
  documentId: z.string().uuid().optional(),
});

const TOP_K = 8;
// pgvector cosine distance (`<=>`): 0 = identical, ~1 = orthogonal.
// Chunks farther than this are NOT evidence — the LLM is never called with
// weak context, so the answer cannot drift into model memory (anti-hallucination).
const MAX_DISTANCE = 0.5;

// Request timeout: 60 seconds for the full RAG pipeline (embed + retrieve + LLM)
const CHAT_TIMEOUT_MS = 60_000;
const LEXICAL_STOP_WORDS = new Set([
  "a", "an", "and", "are", "document", "for", "from", "in", "is", "list",
  "me", "of", "on", "or", "the", "this", "to", "what", "who", "with",
]);

type SearchResult = {
  content: string;
  filename: string;
  distance: number;
};

// Query expansion: embedding models are weak on exact-value terms.
// "email" → also search "email address contact gmail mail" so the contact
// chunk ("Email: ...") ranks higher. Kept tiny — no LLM call, no latency.
export function expandQuery(question: string): string {
  const q = question.trim().toLowerCase();

  // Person-summary questions need the profile sections of a resume, not just a
  // nearest single sentence. Keep the supplied name in the query so this also
  // works for names we have never seen before.
  const person = getPersonLookupTerm(question);
  if (person) {
    return `${question}. Tell me about ${person}: professional summary, role, skills, work experience, projects, contact details, and resume profile.`;
  }
  if (/^(information|info|resume info|tell me more|details)$/i.test(q)) {
    return `${question}: professional summary, experience, skills, projects, and contact information.`;
  }

  // Author / Creator queries
  if (/^(author|authors|author name|author names|writer|creators)$/i.test(q)) {
    return "Who are the authors or creators of this document? List all author names.";
  }
  if (/\b(author|authors|written by|creator|creators)\b/.test(q)) {
    return `${question} author names written by creators`;
  }

  // Contact / Person / Email / Phone / Address queries
  if (/^(contact|contact info|contact details|reach out)$/i.test(q)) {
    return "What is the contact information, email address, phone number, or website listed in this document?";
  }
  if (/\b(contact|email|e-mail|mail|gmail)\b/.test(q)) {
    return `${question} email address contact details gmail mail phone`;
  }
  if (/\b(phone|mobile|number|contact no|telephone)\b/.test(q)) {
    return `${question} phone number mobile contact details`;
  }
  if (/\b(website|url|site|web|link)\b/.test(q)) {
    return `${question} website url web link homepage github profile`;
  }

  // Portfolio queries should retrieve resume sections headed "PROJECTS",
  // which often also contain publications, hackathons, and bug bounties.
  if (/^(project|projects|portfolio|work samples)$/i.test(q)) {
    return "What projects, portfolio work, publications, hackathons, or bug bounties are listed in this document?";
  }
  if (/\b(project|projects|portfolio)\b/.test(q)) {
    return `${question} projects portfolio publications hackathons bug bounties`;
  }

  // Names / People queries
  if (/^(human name|names|people|person|name)$/i.test(q)) {
    return "What are the names of the people or authors mentioned in this document?";
  }

  return question;
}

/** Extract the name token from common person-summary phrasing. */
export function getPersonLookupTerm(question: string): string | null {
  const match = question.trim().match(/^(?:who\s+is|(?:information|info)\s+about|tell\s+me\s+about)\s+([a-z][a-z'-]{2,})(?:\s*[?!.])?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Build a safe OR query for PostgreSQL full-text fallback retrieval. */
export function buildLexicalTsQuery(question: string): string | null {
  const terms = [...new Set(
    question.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((term) => !LEXICAL_STOP_WORDS.has(term)) ?? []
  )];
  return terms.length > 0 ? terms.map((term) => `${term}:*`).join(" | ") : null;
}

/**
 * Combine exact lexical matches with semantic matches.
 *
 * Vector search is excellent for descriptive questions, but a short query such
 * as "who is Manish" or "projects" can receive a plausible (and unrelated)
 * vector score.  The old fallback therefore never ran and the useful resume
 * chunks were discarded. Lexical matches are still document evidence, so rank
 * them first and then fill the remaining context with gated semantic results.
 */
export function mergeRetrievalResults(
  exactRows: SearchResult[],
  lexicalRows: SearchResult[],
  vectorRows: SearchResult[],
  maxResults = TOP_K
): SearchResult[] {
  const unique = new Map<string, SearchResult>();
  // Once an owner/filename filter found a document, do not dilute a person
  // summary with semantically similar chunks from somebody else's resume.
  const semanticRows = exactRows.length > 0
    ? []
    : vectorRows.filter((row) => row.distance <= MAX_DISTANCE);
  for (const row of [...exactRows, ...lexicalRows, ...semanticRows]) {
    // A document can contain identical repeated text; keep one copy only.
    const key = `${row.filename}\u0000${row.content}`;
    if (!unique.has(key)) unique.set(key, row);
    if (unique.size >= maxResults) break;
  }
  return [...unique.values()];
}

async function handleChat(question: string, reply: FastifyReply, documentId?: string) {
  setupSSE(reply);
  const abortController = new AbortController();
  const onDisconnect = () => abortController.abort();
  reply.raw.once("close", onDisconnect);

  const cleanQ = question.trim().toLowerCase();

  // Greeting Handler: Respond warmly to greetings instead of blank vector refusal
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

  // Request timeout — abort the entire pipeline if it takes too long
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

    console.log(`[RAG Observability] 📥 Query received: "${question}" (Expanded: "${expandedQuestion}") | Document Scope: ${documentId || "GLOBAL"}`);

    sendSSE(reply, {
      type: "status",
      step: "embedding",
      message: "🔍 Generating query embedding vector...",
    });

    // Generate embedding for the user's question (expanded for exact-value
    // terms like "email"/"phone"/"website"/"author" — see expandQuery above)
    const queryEmbedding = await embedText(expandedQuestion, "RETRIEVAL_QUERY", abortController.signal);
    if (abortController.signal.aborted) throw new Error("Request aborted.");

    // Convert embedding to pgvector format
    const vector = `[${queryEmbedding.join(",")}]`;

    sendSSE(reply, {
      type: "status",
      step: "retrieval",
      message: "⚡ Searching pgvector database...",
    });

    // Retrieve the most relevant chunks — scoped to one document when selected.
    // Join the Document filename so the UI can cite the actual source file.
    const vectorRows = documentId
      ? await prisma.$queryRaw<{ content: string; filename: string; distance: number }[]>`
          SELECT c.content, d.filename, c.embedding <=> ${vector}::vector AS distance
          FROM "Chunk" c
          JOIN "Document" d ON d.id = c."documentId"
          WHERE c."documentId" = ${documentId} AND d.status = 'READY'
          ORDER BY c.embedding <=> ${vector}::vector
          LIMIT ${TOP_K}
        `
      : await prisma.$queryRaw<{ content: string; filename: string; distance: number }[]>`
          SELECT c.content, d.filename, c.embedding <=> ${vector}::vector AS distance
          FROM "Chunk" c
          JOIN "Document" d ON d.id = c."documentId"
          WHERE d.status = 'READY'
          ORDER BY c.embedding <=> ${vector}::vector
          LIMIT ${TOP_K}
        `;

    if (abortController.signal.aborted) throw new Error("Request aborted.");

    // Hybrid retrieval: semantic similarity handles meaning; full-text search
    // anchors short/exact queries (names, projects, URLs) to the right chunks.
    // Run lexical retrieval even when vector search has a weak hit; otherwise a
    // random but in-threshold vector result can hide the requested resume data.
    const lexicalQuery = buildLexicalTsQuery(question);
    let lexicalRows: SearchResult[] = [];
    if (lexicalQuery) {
      lexicalRows = documentId
        ? await prisma.$queryRaw<SearchResult[]>`
            SELECT c.content, d.filename, 0::double precision AS distance
            FROM "Chunk" c
            JOIN "Document" d ON d.id = c."documentId"
            WHERE c."documentId" = ${documentId}
              AND d.status = 'READY'
              AND to_tsvector('simple', c.content) @@ to_tsquery('simple', ${lexicalQuery})
            ORDER BY ts_rank(to_tsvector('simple', c.content), to_tsquery('simple', ${lexicalQuery})) DESC
            LIMIT ${TOP_K}
          `
        : await prisma.$queryRaw<SearchResult[]>`
            SELECT c.content, d.filename, 0::double precision AS distance
            FROM "Chunk" c
            JOIN "Document" d ON d.id = c."documentId"
            WHERE d.status = 'READY'
              AND to_tsvector('simple', c.content) @@ to_tsquery('simple', ${lexicalQuery})
            ORDER BY ts_rank(to_tsvector('simple', c.content), to_tsquery('simple', ${lexicalQuery})) DESC
            LIMIT ${TOP_K}
          `;
    }

    // A person query can also use durable document metadata (or a filename for
    // documents indexed before metadata was added). This is an exact filter,
    // not a similarity guess, so its matches are ranked above broad search.
    const personTerm = getPersonLookupTerm(question);
    const ownerRows: SearchResult[] = personTerm
      ? documentId
        ? await prisma.$queryRaw<SearchResult[]>`
            SELECT c.content, d.filename, 0::double precision AS distance
            FROM "Chunk" c JOIN "Document" d ON d.id = c."documentId"
            WHERE c."documentId" = ${documentId} AND d.status = 'READY'
              AND (c.metadata->>'owner' ILIKE ${`%${personTerm}%`} OR d.filename ILIKE ${`%${personTerm}%`})
            ORDER BY c."chunkIndex" ASC LIMIT ${TOP_K}
          `
        : await prisma.$queryRaw<SearchResult[]>`
            SELECT c.content, d.filename, 0::double precision AS distance
            FROM "Chunk" c JOIN "Document" d ON d.id = c."documentId"
            WHERE d.status = 'READY'
              AND (c.metadata->>'owner' ILIKE ${`%${personTerm}%`} OR d.filename ILIKE ${`%${personTerm}%`})
            ORDER BY c."chunkIndex" ASC LIMIT ${TOP_K}
          `
      : [];

    const relevant = mergeRetrievalResults(ownerRows, lexicalRows, vectorRows);
    const rows = relevant.length > 0 ? relevant : vectorRows;

    // Only retrieved evidence reaches the LLM.
    const contextChunks = relevant.map((row) => row.content);
    const sourceDocs = [...new Map(relevant.map((row) => [row.filename, row.filename])).keys()];

    const topDist = rows[0] ? Number(rows[0].distance).toFixed(3) : "N/A";
    console.log(
      `[RAG Observability] 📊 Retrieval complete: ${relevant.length}/${rows.length} passed gate (<= ${MAX_DISTANCE}) | Top similarity: ${rows[0] ? (1 - rows[0].distance).toFixed(3) : "0"} (distance: ${topDist}) | Latency: ${Date.now() - startTime}ms`
    );

    sendSSE(reply, {
      type: "status",
      step: "retrieval_complete",
      message: `⚡ Retrieved ${relevant.length} relevant chunks (top distance: ${topDist})`,
    });

    // Grounded-only: no relevant context -> refuse gracefully with token stream
    if (contextChunks.length === 0) {
      console.warn(`[RAG Observability] ⚠️ No context passed gate for query: "${question}"`);
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

    // Stream LLM response token-by-token — grounded in the retrieved chunks only
    // Accumulate all streamed tokens into a single response
    let answer = "";
    for await (const token of streamChat(question, contextChunks, abortController.signal)) {
      if (reply.raw.destroyed) break;
      answer += token;
    }
    // Send the combined answer as one token event
    if (!reply.raw.destroyed) {
      sendSSE(reply, {
        type: "token",
        content: answer,
      });
    }

    // Send retrieved sources (document names for citation chips)
    if (!reply.raw.destroyed) {
      sendSSE(reply, {
        type: "sources",
        count: contextChunks.length,
        documents: sourceDocs,
        chunks: contextChunks,
      });
    }
  } catch (error: any) {
    console.error("[RAG Observability] ❌ Error in handleChat:", error);
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

export async function chatRoutes(app: FastifyInstance) {
  // Frontend uses GET with ?question= for SSE streaming
  app.get("/chat", async (request, reply) => {
    const parsed = ChatQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        message: parsed.error.issues[0]?.message || "Invalid request",
      });
    }
    const { question, documentId } = parsed.data;
    return handleChat(question, reply, documentId);
  });

  // API clients use POST with JSON body
  app.post("/chat", async (request, reply) => {
    const parsed = ChatBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        message: parsed.error.issues[0]?.message || "Invalid request",
      });
    }
    const { question, documentId } = parsed.data;
    return handleChat(question, reply, documentId);
  });
}
