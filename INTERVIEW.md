# RAG ChatBot — Interview Preparation Guide

Use this document to walk interviewers through your project with confidence.

---

## 1. The 30-Second Elevator Pitch

> "I built a full-stack Retrieval-Augmented Generation system that lets users upload PDFs, DOCX, or text files and ask questions grounded strictly in those documents. It uses hybrid retrieval — combining vector similarity, full-text search, and metadata filtering — with a Groq LLM that streams answers in real-time. The whole thing runs on free-tier infrastructure with zero cost."

---

## 2. System Design Walkthrough (5 minutes)

### High-Level Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Upload    │────►│  Extraction  │────►│   Chunking   │
│  (handler)  │     │ (extract.ts) │     │(chunking.ts) │
└─────────────┘     └──────────────┘     └──────┬───────┘
                                                 │
                                      ┌──────────▼──────────┐
                                      │   Enrichment        │
                                      │ (enrichChunks)      │
                                      │ + Owner detection   │
                                      └──────────┬──────────┘
                                                 │
                                      ┌──────────▼──────────┐
                                      │   Embedding         │
                                      │ (gemini.ts)         │
                                      │ batchEmbedContents  │
                                      └──────────┬──────────┘
                                                 │
                                      ┌──────────▼──────────┐
                                      │   pgvector Store    │
                                      │ (Chunk table)       │
                                      └────────────┬───────┘
                                                   │
                                    ┌──────────────▼──────────────┐
                                    │       Query Time            │
                                    │                            │
                                    │  expandQuery()             │
                                    │  embedText()               │
                                    │  hybrid retrieval (3-way)  │
                                    │  RRF fusion                │
                                    │  anti-hallucination gate   │
                                    │  streamChat()              │
                                    │  SSE response              │
                                    └────────────────────────────┘
```

### Key Numbers to Remember

| Metric | Value | Why It Matters |
|--------|-------|----------------|
| Chunk max tokens | 512 | Balances context window vs. precision |
| Top-K retrieval | 8 | Enough context without overwhelming the LLM |
| Max cosine distance | 0.5 | Anti-hallucination gate — filters weak matches |
| Embedding dimensions | 768 | Gemini's output size, good balance of speed/quality |
| Batch embedding size | 50 | Maximizes throughput without hitting rate limits |
| LRU cache size | 10K entries | ~30MB, eliminates redundant API calls |
| Circuit breaker threshold | 5 failures | Prevents cascading failures |
| Circuit cooldown | 30s | Quick recovery, doesn't hammer dead services |
| Upload size limit | 20MB | Prevents abuse, fits most use cases |
| Rate limits | 120/30/10 per min | General/chat/upload — tiered protection |
| RRF weights | exact=3.0, lexical=1.5, vector=1.0 | Prioritizes precise matches |
| RRF K constant | 60 | Smoothing factor for rank fusion |

---

## 3. Top 15 Interview Questions

### Q1. Walk me through your RAG architecture. (3 min)

**Your answer:**
- **Ingestion:** Upload → MinIO/S3 → BullMQ worker → text extraction → recursive chunking (512 tokens) → Gemini embedding (768-dim) → pgvector
- **Retrieval:** Hybrid search — vector (cosine), lexical (tsquery), owner/exact metadata. Merged via Reciprocal Rank Fusion (RRF) with weights 3.0/1.5/1.0
- **Generation:** Anti-hallucination gate (distance ≤ 0.5) → Groq primary / Gemini fallback → SSE streaming → source citations
- **Why hybrid:** Vector alone misses exact values (emails, phone numbers, author names). Lexical catches keywords, owner search catches resume metadata.

---

### Q2. Why did you choose hybrid retrieval over pure vector search? (2 min)

**Your answer:**
- Vector search is semantic but fuzzy — "What is Shubham's email?" might not retrieve a chunk containing the literal email address
- Lexical full-text search catches exact keyword matches
- Owner metadata search boosts resume-style documents where names/contact info need exact matching
- RRF fusion gives the best of all three without sacrificing recall

**Follow-up:** "What's the latency overhead?" ~50ms for lexical query. Worth it for 3x better recall on exact-value queries.

---

### Q3. How does your chunking strategy work? (2 min)

**Your answer:**
- **Recursive splitter:** Numbered headings → paragraphs → lines → sentences → words (in that order)
- **Max 512 tokens** per chunk with 20-word overlap (except contact chunks to avoid duplicate emails)
- **Enrichment:** Every chunk gets `Document:`, `Owner:`, `Section:` labels. Contact chunks get explicit `Email:`, `Phone:`, `Website:` labels
- **Why it matters:** Raw embeddings of values like "bhattacharya.manish8@gmail.com" have zero context. Labels make them searchable as "Email: bhattacharya.manish8@gmail.com"

---

### Q4. How do you prevent hallucinations? (2 min)

**Your answer:**
- **Anti-hallucination gate:** LLM is only called if retrieved chunks pass the similarity distance gate (MAX_DISTANCE = 0.5 cosine)
- **Strict system prompt:** "Answer ONLY using retrieved context. If answer not present, say 'I couldn't find this in the documents.'"
- **No memory answers:** The LLM has no conversation history context — only the retrieved chunks
- **Safety rules:** Treat retrieved context as untrusted. Block prompt injection attempts. Never reveal system prompts or API keys

---

### Q5. What happens if a provider goes down? (2 min)

**Your answer:**
- **LLM failover:** Groq tries 3 models in sequence (`openai/gpt-oss-120b` → `qwen3.6-27b` → `openai/gpt-oss-20b`), then falls back to Gemini Flash (`gemini-3.7-flash` → `gemini-3.6-flash`)
- **Circuit breakers:** 5 failures → open circuit, 30s cooldown, exponential backoff up to 5x. Prevents cascading failures
- **Embedding retries:** 3 retries with exponential backoff (1s, 2s, 4s) for transient 5xx errors
- **BullMQ retries:** 3 attempts with exponential backoff (2s base) for document processing failures

---

### Q6. How do you handle document processing failures? (2 min)

**Your answer:**
- **Dead-letter classification:** Errors categorized as extraction_failed, embedding_failed, validation_error, rate_limit_exceeded, storage_error
- **Retryable vs non-retryable:** Bad files/invalid API keys = non-retryable (status → FAILED). Network/rate limits = retryable (re-queued)
- **Admin endpoints:** `/admin/dead-letters` lists failed docs, `/admin/retry/:id` re-queues them
- **Boot-time re-queue:** On startup, any documents left in QUEUED/PROCESSING state are automatically re-queued (jobId deduplication prevents double-processing)

---

### Q7. Why BullMQ + Redis? Why not just process synchronously? (2 min)

**Your answer:**
- **Async processing:** Upload returns immediately (201). Heavy work (extraction, embedding, storage) happens in background
- **Reliability:** Redis persists the queue. If the server crashes, jobs survive. Boot-time re-queue handles in-flight documents
- **Scalability:** Worker concurrency = 5. Can scale horizontally by adding more workers
- **Retries built-in:** Exponential backoff, dead-letter queue, stalled job detection
- **Why not synchronous:** Embedding a document takes 10-30 seconds. Blocking the HTTP request would timeout and give poor UX

---

### Q8. How does your embedding cache work? (2 min)

**Your answer:**
- **LRU cache** in memory: 10K entries (~30MB for 768-dim float64 vectors)
- **Cache key:** `taskType:text` (e.g., `RETRIEVAL_QUERY:what is the attention mechanism?`)
- **LRU eviction:** Map iteration order = insertion order. On cache hit, delete + re-insert to move to end (most recently used)
- **Batch embedding:** Checks cache first, only calls Gemini for uncached texts. Falls back to single `embedText` if batch fails
- **Impact:** Eliminates redundant API calls for duplicate queries and common chunks

---

### Q9. What is Reciprocal Rank Fusion and why use it? (2 min)

**Your answer:**
- **RRF formula:** `score = weight / (K + rank + 1)`, where K = 60 (smoothing constant)
- **Combines 3 retrieval strategies:** Exact matches (weight 3.0), lexical (1.5), vector (1.0)
- **Deduplication:** Same content from multiple strategies merges scores instead of duplicating
- **Why not just concatenate:** Different strategies rank differently. RRF normalizes scores across heterogeneous lists
- **Priority logic:** Exact matches always outrank lexical, which outrank vector (unless no exact/lexical hits exist)

---

### Q10. Why PostgreSQL + pgvector instead of Pinecone/Weaviate? (2 min)

**Your answer:**
- **Single database:** Already using Postgres for metadata. Adding pgvector avoids a second database
- **Cost:** Free tier. Managed services like Pinecone have usage limits
- **Hybrid search:** Can do vector + full-text (tsquery) + JSONB metadata queries in one SQL query
- **HNSW index:** pgvector supports HNSW for cosine similarity — production-grade performance
- **Tradeoff:** Less feature-rich than dedicated vector DBs, but sufficient for this scale and simpler to operate

---

### Q11. How does the frontend handle streaming responses? (2 min)

**Your answer:**
- **SSE (Server-Sent Events):** Backend sets `Content-Type: text/event-stream`, flushes headers, writes `data: {...}\n\n` for each event
- **Event types:** `token` (streaming text), `status` (embedding/retrieval/generation progress), `sources` (document citations), `[DONE]`
- **Frontend reader:** `res.body.getReader()` reads chunks, splits by newline, parses JSON events
- **AbortController:** User clicks "Stop" or request times out → aborts in-flight fetch
- **Markdown rendering:** Custom regex-based parser (no library) renders code blocks, tables, lists in real-time as tokens arrive

---

### Q12. What security measures did you implement? (2 min)

**Your answer:**
- **File validation:** Extension whitelist + MIME check + file signature validation (PDF: `%PDF-`, DOCX: `PK` zip header)
- **Filename sanitization:** Strip special chars, prevent path traversal
- **Rate limiting:** Redis sliding window (general: 120/min, chat: 30/min, upload: 10/min per IP)
- **Security headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, CSP, HSTS in production
- **Cookie security:** `httpOnly`, `sameSite: lax`, `secure` in production
- **Prompt injection protection:** System prompt explicitly tells LLM to ignore instructions from retrieved context
- **Secrets:** All API keys in env vars, never committed. `render.yaml` marks them `sync: false`

---

### Q13. If you had to scale this to 10K documents, what would change? (2 min)

**Your answer:**
- **Vector DB:** Migrate to Pinecone/Weaviate/Qdrant for better indexing at scale, or partition pgvector by document
- **Embedding cache:** Move to Redis shared cache (currently per-process in-memory)
- **Queue scaling:** Multiple BullMQ workers across processes/servers
- **Storage:** CDN for frontend, S3 with lifecycle policies for old documents
- **Retrieval:** Add hybrid search timeout budgets, pre-filter by metadata before vector search
- **Monitoring:** Add metrics (already have Prometheus endpoint), trace slow queries, alert on P99 latency

---

### Q14. What tradeoffs did you make? (2 min)

**Your answer:**
- **Hybrid retrieval complexity vs recall:** 3 retrieval strategies add complexity but dramatically improve exact-value retrieval
- **Same-origin vs CDN:** Serving frontend from Fastify simplifies deployment but adds CPU/memory overhead
- **In-container Redis vs managed:** Free and unlimited, but ephemeral (mitigated by boot-time re-queue)
- **Groq free tier vs paid:** Cost-effective but rate-limited. Gemini fallback adds latency
- **Custom markdown parser vs library:** Zero dependencies but limited feature set
- **Postgres vs dedicated vector DB:** Simpler ops but fewer vector-specific optimizations

---

### Q15. Tell me about a bug or challenge you solved. (2 min)

**Suggested stories:**
- **Email not found:** Chunks contained raw emails with zero context. Solved by adding `Email:` labels in `enrichChunks()`
- **Resume owner detection:** Two-word capitalized first line pattern distinguishes resumes from papers. Solved owner metadata search
- **Gemini rate limits:** Free tier 429s during batch embedding. Solved with retry logic + exponential backoff + LRU cache
- **Cold start orphans:** Render free tier sleeps, BullMQ jobs lost. Solved boot-time re-queue of QUEUED/PROCESSING docs
- **CORS headaches:** Serving frontend from Fastify eliminated all CORS issues

---

## 4. Deep Dive: The Retrieval Pipeline

This is the core of your system. Be ready to explain every line.

### Step-by-step flow

```
1. User question arrives
   ↓
2. expandQuery() — enrich query if needed
   ↓
3. embedText() — Gemini RETRIEVAL_QUERY, 768-dim
   ↓
4. Parallel retrieval (3 strategies):
   ├─ Vector: SELECT ... ORDER BY embedding <=> vector LIMIT 8
   ├─ Lexical: WHERE to_tsvector(content) @@ tsquery
   └─ Owner: WHERE metadata->>'owner' ILIKE '%name%'
   ↓
5. mergeRetrievalResults() — RRF fusion
   ├─ Exact matches weight: 3.0 (with MIN_OWNER_RELEVANCE filter)
   ├─ Lexical matches weight: 1.5 (with MIN_LEXICAL_RELEVANCE filter)
   ├─ Vector matches weight: 1.0 (with MAX_DISTANCE filter)
   └─ Deduplicated by content+filename
   ↓
6. Anti-hallucination gate
   ├─ If no chunks pass → "I couldn't find this in the documents."
   └─ LLM NEVER called without grounded context
   ↓
7. streamChat() → Groq primary, Gemini fallback
   ├─ System prompt: strict grounding rules
   ├─ Context: retrieved chunks with metadata labels
   └─ User: original question
   ↓
8. SSE streaming: token → status → sources → DONE
```

### Key code references

| Concept | File | Lines |
|---------|------|-------|
| Query expansion | `retrieval.ts` | 38-56 |
| Person lookup | `retrieval.ts` | 77-95 |
| Lexical query building | `retrieval.ts` | 64-74 |
| Vector search SQL | `routes.ts` | 95-102 |
| Lexical search SQL | `routes.ts` | 107-117 |
| Owner search SQL | `routes.ts` | 119-128 |
| RRF merge | `retrieval.ts` | 82-132 |
| Anti-hallucination | `routes.ts` | 155-163 |
| LLM streaming | `groq.ts` | 238-320 |
| SSE helpers | `sse.ts` | 6-33 |

---

## 5. Deep Dive: Chunking & Enrichment

### Why recursive chunking?

```
"Attention Is All You Need"
├── 1. Introduction
│   ├── paragraph about transformer architecture
│   └── paragraph about attention mechanism
├── 2. Background
│   ├── paragraph about RNNs
│   └── paragraph about attention in NLP
└── 3. Model Architecture
    ├── paragraph about encoder-decoder
    └── paragraph about multi-head attention
```

Splitting at headings first preserves semantic boundaries. If a section is still >512 tokens, split by paragraph, then line, then sentence.

### Why enrichment matters

**Before enrichment (raw chunk):**
```
Ashish Vaswani
Noam Shazeer
...
avaswani@google.com
nshazeer@google.com
```

**After enrichment:**
```
Document: attention.pdf
Owner: Ashish Vaswani
Section: Authors

Email: avaswani@google.com
Content:
Ashish Vaswani
Noam Shazeer
...
```

The embedding now contains "Email:" and "Owner:" — so "what is the email?" matches directly instead of relying on fuzzy vector similarity.

---

## 6. Deep Dive: Anti-Hallucination Mechanisms

### The grounding stack

```
Layer 1: Distance gate
  └─ Vector results with distance > 0.5 are discarded

Layer 2: Lexical relevance gate
  └─ Lexical results with ts_rank < 0.1 are discarded

Layer 3: Owner relevance gate
  └─ Owner results where content doesn't contain the person term are discarded

Layer 4: System prompt
  └─ "Answer ONLY using retrieved context"
  └─ "If answer not present, say 'I couldn't find this in the documents'"

Layer 5: No context fallback
  └─ If no chunks survive all gates → graceful refusal
```

### Why each layer matters

- **Layer 1** catches weak semantic matches
- **Layer 2** catches low-quality keyword matches
- **Layer 3** catches false owner matches
- **Layer 4** instructs the LLM to be honest
- **Layer 5** ensures the system never guesses

---

## 7. Deep Dive: Resilience Patterns

### Circuit Breakers

```
5 failures → OPEN (30s cooldown)
  ↓
Half-open probe (1 request allowed)
  ├─ Success → CLOSED
  └─ Failure → OPEN (cooldown × 2, max 5x)
```

Used for: LLM, embedding, database, Redis, storage.

### Retry Strategies

| Component | Strategy | Max Retries |
|-----------|----------|-------------|
| Embedding | Exponential backoff (1s, 2s, 4s) | 3 |
| BullMQ jobs | Exponential backoff (2s base) | 3 |
| LLM (Groq) | Model failover → retry once | 3 models |
| LLM (Gemini) | Model failover → retry with backoff | 2 models |

### Rate Limiting

- **Redis sliding window** (production) — Lua script for atomic trim/count/add
- **In-memory sliding window** (fallback)
- Separate limits: general (120/min), chat (30/min), upload (10/min)

---

## 8. Common Follow-Up Questions

### "Why not use a managed vector DB like Pinecone?"

Managed vector DBs are great, but:
- **Cost:** Free tier limits. Pinecone charges after 100k vectors.
- **Complexity:** Another service to manage, monitor, and secure.
- **Hybrid search:** pgvector + tsquery in one query is simpler than coordinating two services.
- **Sufficient for scale:** This architecture handles 100k+ chunks comfortably on a single Postgres instance.

### "How would you evaluate retrieval quality?"

- **Retrieval metrics:** Precision@K, Recall@K, MRR (Mean Reciprocal Rank)
- **Answer quality:** RAGAS framework (faithfulness, answer relevance, context precision)
- **User feedback:** Thumbs up/down on answers
- **A/B testing:** Compare hybrid vs. pure vector retrieval

### "What's the biggest bottleneck?"

- **Embedding API latency:** Gemini batch API takes 1-3s per 50 chunks. Mitigated by LRU cache and parallel processing.
- **LLM inference:** Groq is fast (~100 tokens/s), but free tier has rate limits. Gemini fallback is slower.
- **Database:** pgvector HNSW search is fast (~10ms), but scales linearly with vector count.

### "How is multi-user support implemented?"

- **Authentication:** Google OAuth 2.0 Authorization Code flow, hand-rolled on `fetch` (state parameter with timing-safe CSRF check, no auth SDK). Session = signed, httpOnly, SameSite=Lax cookie holding the user id; production refuses to boot without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.
- **Tenant isolation:** `ownerId` on Document and `userId` on Conversation. `buildDocFilter(ownerId)` injects the owner predicate into **every** retrieval strategy (vector, lexical, owner search), and document list/get/delete are ownership-scoped with 404s (not 403s) to avoid existence leaks.
- **Rate limits per user:** Currently per-IP; a natural next step is keying the limiter on `userId`
- **Scale path:** Postgres row-level security, or a server-side Redis session store for instant revocation

---

## 9. Technical Deep Dives for Senior Roles

### The Embedding Cache Implementation

```typescript
// LRU using Map iteration order
const embeddingCache = new Map<string, number[]>();

function cacheGet(key: string): number[] | undefined {
  const value = embeddingCache.get(key);
  if (value !== undefined) {
    // Move to end (most recently used)
    embeddingCache.delete(key);
    embeddingCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: number[]): void {
  // Evict oldest when full
  while (embeddingCache.size >= MAX_CACHE_SIZE) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest !== undefined) embeddingCache.delete(oldest);
  }
  embeddingCache.set(key, value);
}
```

**Why this works:** JavaScript Map maintains insertion order. Deleting and re-inserting moves an entry to the end. The oldest entry is always at the front.

### The RRF Implementation

```typescript
const K = 60; // Smoothing constant
const scores = new Map<string, { row: SearchResult; score: number }>();

const addRanked = (rows: SearchResult[], weight: number) => {
  rows.forEach((row, rank) => {
    const rrfScore = weight * (1 / (K + rank + 1));
    const existing = scores.get(key);
    if (existing) {
      existing.score += rrfScore; // Combine scores
      if (row.distance < existing.row.distance) existing.row = row; // Prefer closer match
    } else {
      scores.set(key, { row, score: rrfScore });
    }
  });
};
```

**Why K=60:** Large enough that rank 1 vs rank 2 matters, but small enough that higher ranks still contribute. This prevents any single strategy from dominating.

### The Circuit Breaker State Machine

```
CLOSED (normal)
  ├─ Success → stay CLOSED
  └─ Failure count >= 5 → OPEN

OPEN (rejecting)
  ├─ Within cooldown → reject
  └─ Cooldown elapsed → HALF-OPEN

HALF-OPEN (probing)
  ├─ Success → CLOSED
  └─ Failure → OPEN (cooldown × 2, max 5x)
```

**Why this matters:** Without circuit breakers, a dead dependency causes cascading failures. Thread pools exhaust, memory fills with pending requests, and the entire service collapses.

---

## 10. Metrics to Mention in Interviews

| Metric | Value | How Measured |
|--------|-------|--------------|
| Test coverage | 252 passing tests | Vitest + Bun test runner |
| Cold start latency | ~3s | Server boot + DB init + queue re-queue |
| Embedding throughput | 50 chunks/batch | Gemini batchEmbedContents API |
| SSE concurrent connections | 500+ | Benchmark verified |
| Memory footprint | < 120MB RSS | Active streaming load |
| Retrieval latency | ~200ms | Vector + lexical + merge |
| Document processing | 10-30s | Per document (extraction + embedding) |
| Uptime | 99.9% | Render + UptimeRobot keep-alive |

---

## 11. Questions to Ask the Interviewer

1. "What's your current RAG stack? Are you using a managed vector DB or self-hosted?"
2. "How do you currently handle hallucinations? Do you have a distance threshold or use RAGAS?"
3. "What's your scale? How many documents/queries per day?"
4. "Are you more focused on retrieval quality or latency? Or both?"
5. "Do you have existing infrastructure I'd be working with, or is this a greenfield project?"

---

## 12. Final Checklist Before Interview

- [ ] Be able to draw the architecture from memory
- [ ] Can explain hybrid retrieval in 2 sentences
- [ ] Know the key numbers (TOP_K=8, MAX_DISTANCE=0.5, 768-dim, etc.)
- [ ] Have a "bug I fixed" story ready
- [ ] Can explain the chunking + enrichment pipeline
- [ ] Know the 3 anti-hallucination layers
- [ ] Can discuss tradeoffs (Postgres vs Pinecone, etc.)
- [ ] Have questions prepared for the interviewer

---

Good luck! You've built a production-grade RAG system — now go tell that story.
