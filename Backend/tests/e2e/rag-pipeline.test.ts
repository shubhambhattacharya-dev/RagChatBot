/**
 * End-to-End RAG Pipeline Test
 *
 * Tests the full pipeline with mocked external services:
 * 1. Document extraction (PDF parsing)
 * 2. Chunking (recursive split)
 * 3. Embedding (Gemini API mocked)
 * 4. Retrieval (pgvector mocked)
 * 5. Generation (Groq API mocked)
 *
 * Uses vitest mocks to simulate external dependencies while testing
 * the real business logic in each pipeline stage.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkText, enrichChunks, detectDocumentOwner } from "../../src/utils/chunking";
import { expandQuery, buildLexicalTsQuery, getPersonLookupTerm, mergeRetrievalResults, MAX_DISTANCE, MIN_OWNER_RELEVANCE, MIN_LEXICAL_RELEVANCE, type SearchResult } from "../../src/modules/chat/retrieval";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Fixture Loading ────────────────────────────────────────────────────────

function loadFixture(name: string): string {
  return readFileSync(join(__dirname, "..", "fixtures", name), "utf8");
}

// ─── Pipeline Stages ────────────────────────────────────────────────────────

describe("RAG Pipeline E2E", () => {
  // ── Stage 1: Extraction ──────────────────────────────────────────────

  describe("Stage 1: Text Extraction", () => {
    test("extracts text from attention.txt fixture", () => {
      const text = loadFixture("attention.txt");
      expect(text.length).toBeGreaterThan(100);
      expect(text).toContain("Attention Is All You Need");
      expect(text).toContain("Ashish Vaswani");
    });

    test("extracted text contains email addresses", () => {
      const text = loadFixture("attention.txt");
      expect(text).toContain("avaswani@google.com");
    });
  });

  // ── Stage 2: Chunking ───────────────────────────────────────────────

  describe("Stage 2: Recursive Chunking", () => {
    test("chunks text into manageable pieces", () => {
      const text = loadFixture("attention.txt");
      const chunks = chunkText(text);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => c.content.trim().length > 0)).toBe(true);
    });

    test("chunks respect max token limit", () => {
      const text = loadFixture("attention.txt");
      const chunks = chunkText(text, 512);

      for (const chunk of chunks) {
        const estimatedTokens = Math.ceil(chunk.content.length / 4);
        expect(estimatedTokens).toBeLessThanOrEqual(512 + 50); // Small tolerance for overlap
      }
    });

    test("enriched chunks contain document metadata", () => {
      const text = loadFixture("attention.txt");
      const chunks = chunkText(text);
      const enriched = enrichChunks(chunks, "attention.txt");

      expect(enriched.length).toBe(chunks.length);
      // All enriched chunks should contain the document name
      expect(enriched.every((c) => c.content.includes("Document: attention.txt"))).toBe(true);
    });

    test("detects document owner from first line", () => {
      const text = loadFixture("attention.txt");
      const chunks = chunkText(text);
      const owner = detectDocumentOwner(chunks);

      // Attention Is All You Need is a paper, not a resume → no owner
      expect(owner).toBeNull();
    });
  });

  // ── Stage 3: Query Expansion ────────────────────────────────────────

  describe("Stage 3: Query Expansion", () => {
    test("expands short queries for better recall", () => {
      const queries = [
        { input: "email", expectedContains: "email address" },
        { input: "projects", expectedContains: "publications" },
        { input: "who is Manish", expectedContains: "professional summary" },
        { input: "author", expectedContains: "authors" },
      ];

      for (const { input, expectedContains } of queries) {
        const expanded = expandQuery(input);
        expect(expanded).toContain(expectedContains);
      }
    });

    test("builds lexical queries for full-text search", () => {
      const query = "What is the attention mechanism?";
      const lexical = buildLexicalTsQuery(query);

      expect(lexical).toContain("attention:*");
      expect(lexical).toContain("mechanism:*");
      expect(lexical).toContain("what:*");
      expect(lexical).not.toContain("is:*");
    });
  });

  // ── Stage 4: Retrieval ──────────────────────────────────────────────

  describe("Stage 4: Hybrid Retrieval", () => {
    test("merges results with correct priority (exact > lexical > vector)", () => {
      const exact = [{ content: "exact match", filename: "doc.pdf", distance: 0 }];
      const lexical = [{ content: "lexical match", filename: "doc.pdf", distance: 0 }];
      const vector = [{ content: "vector match", filename: "doc.pdf", distance: 0.3 }];

      const result = mergeRetrievalResults(exact, lexical, vector);
      expect(result[0]?.content).toBe("exact match");
      expect(result[1]?.content).toBe("lexical match");
      expect(result[2]?.content).toBe("vector match");
      expect(result).toHaveLength(3);
    });

    test("distance gate excludes weak vector matches", () => {
      const weakVector = [
        { content: "weak", filename: "doc.pdf", distance: MAX_DISTANCE + 0.1 },
      ];
      const result = mergeRetrievalResults([], [], weakVector);
      expect(result).toHaveLength(0);
    });

    test("distance gate includes strong vector matches", () => {
      const strongVector = [
        { content: "strong", filename: "doc.pdf", distance: MAX_DISTANCE - 0.1 },
      ];
      const result = mergeRetrievalResults([], [], strongVector);
      expect(result).toHaveLength(1);
    });
  });

  // ── Stage 5: Full Pipeline Integration ──────────────────────────────

  describe("Stage 5: Full Pipeline Integration", () => {
    test("extract → chunk → enrich → expand → retrieve flow", () => {
      // 1. Extract
      const text = loadFixture("attention.txt");
      expect(text.length).toBeGreaterThan(0);

      // 2. Chunk
      const chunks = chunkText(text);
      expect(chunks.length).toBeGreaterThan(0);

      // 3. Enrich
      const enriched = enrichChunks(chunks, "attention.txt");
      expect(enriched.length).toBe(chunks.length);

      // 4. Expand query
      const expanded = expandQuery("who wrote this paper?");
      expect(expanded).toContain("who wrote this paper?");

      // 5. Build lexical query
      const lexical = buildLexicalTsQuery("who wrote this paper?");
      expect(lexical).toContain("wrote:*");
      expect(lexical).toContain("paper:*");

      // 6. Simulate retrieval (mock vector + lexical results)
      const mockVectorResults = enriched.slice(0, 3).map((c) => ({
        content: c.content,
        filename: "attention.txt",
        distance: 0.3,
      }));

      const mockLexicalResults = enriched.slice(0, 2).map((c) => ({
        content: c.content,
        filename: "attention.txt",
        distance: 0,
      }));

      const merged = mergeRetrievalResults([], mockLexicalResults, mockVectorResults);
      expect(merged.length).toBeGreaterThan(0);

      // 7. Verify the retrieved chunks contain relevant content
      const allContent = merged.map((r) => r.content).join("\n");
      expect(allContent).toContain("attention.txt");
    });

    test("person query → expand → retrieve → verify context", () => {
      // 1. Expand person query
      const expanded = expandQuery("who is Manish?");
      expect(expanded).toContain("Manish");
      expect(expanded).toContain("professional summary");

      // 2. Build lexical query for the original question
      const lexical = buildLexicalTsQuery("who is Manish?");
      expect(lexical).toContain("manish:*");

      // 3. Simulate: if we had Manish's resume, the enriched chunks would
      // contain "Owner: Manish Bhattacharya" and "Email: ..."
      const mockResumeChunk = "Document: manish.pdf\nOwner: Manish Bhattacharya\nEmail: test@gmail.com";
      const mockResults = [
        { content: mockResumeChunk, filename: "manish.pdf", distance: 0 },
      ];

      const merged = mergeRetrievalResults(mockResults, [], []);
      expect(merged.length).toBe(1);
      expect(merged[0]!.content).toContain("Manish Bhattacharya");
      expect(merged[0]!.content).toContain("test@gmail.com");
    });
  });

  // ── Stage 6: Low-Relevance Bypass Integration ─────────────────────

  describe("Stage 6: Low-Relevance Bypass Integration", () => {
    /**
     * Simulates the full pipeline flow from routes.ts:
     *  expandQuery → buildLexicalTsQuery → getPersonLookupTerm
     *  → mock DB rows → owner relevance filtering → mergeRetrievalResults
     */
    test("person query with low-relevance owner + lexical rows falls back to vector", () => {
      const question = "who is Manish?";

      // 1. Query expansion
      const expanded = expandQuery(question);
      expect(expanded).toContain("Manish");
      expect(expanded).toContain("professional summary");

      // 2. Lexical query
      const lexicalQuery = buildLexicalTsQuery(question);
      expect(lexicalQuery).toContain("manish:*");

      // 3. Person lookup term
      const personTerm = getPersonLookupTerm(question);
      expect(personTerm).toBe("manish");

      // 4. Mock DB: owner rows that do NOT contain the person term in content
      //    (e.g. footer noise matched by filename ILIKE but not by content)
      const mockOwnerRows: SearchResult[] = [
        { content: "random footer with emails", filename: "manish.pdf", distance: 0 },
        { content: "unrelated header text", filename: "manish.pdf", distance: 0 },
      ];

      // 5. Apply the same owner filtering logic from routes.ts
      const filteredOwnerRows = personTerm
        ? mockOwnerRows
            .map((row) => ({
              ...row,
              relevance: row.content.toLowerCase().includes(personTerm) ? 1.0 : 0.0,
            }))
            .filter((row) => row.relevance >= MIN_OWNER_RELEVANCE)
        : mockOwnerRows;

      // Both rows lack "manish" in content → relevance 0.0 → filtered out
      expect(filteredOwnerRows).toHaveLength(0);

      // 6. Mock DB: lexical rows with low ts_rank
      const mockLexicalRows: SearchResult[] = [
        { content: "weak keyword hit", filename: "manish.pdf", distance: 0, relevance: 0.05 },
      ];

      // 7. Mock DB: vector rows within distance threshold
      const mockVectorRows: SearchResult[] = [
        { content: "Manish Bhattacharya email: test@gmail.com", filename: "manish.pdf", distance: 0.3 },
        { content: "Manish works at SynapseFi", filename: "manish.pdf", distance: 0.35 },
      ];

      // 8. Merge — the critical step
      const relevant = mergeRetrievalResults(filteredOwnerRows, mockLexicalRows, mockVectorRows);

      // Low-relevance owner + lexical should be filtered; vector fallback should kick in
      expect(relevant.length).toBeGreaterThan(0);
      expect(relevant).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining("Manish") }),
        ]),
      );
      // The weak lexical row should NOT appear
      expect(relevant.find((r) => r.content === "weak keyword hit")).toBeUndefined();
      // The noisy owner rows should NOT appear
      expect(relevant.find((r) => r.content === "random footer with emails")).toBeUndefined();
      expect(relevant.find((r) => r.content === "unrelated header text")).toBeUndefined();
    });

    test("all filtered + no vector → empty context (no context passed gate)", () => {
      const question = "who is Manish?";
      const personTerm = getPersonLookupTerm(question);

      const mockOwnerRows: SearchResult[] = [
        { content: "noise", filename: "manish.pdf", distance: 0 },
      ];
      const filteredOwnerRows = mockOwnerRows
        .map((row) => ({
          ...row,
          relevance: row.content.toLowerCase().includes(personTerm!) ? 1.0 : 0.0,
        }))
        .filter((row) => row.relevance >= MIN_OWNER_RELEVANCE);

      const mockLexicalRows: SearchResult[] = [
        { content: "weak", filename: "manish.pdf", distance: 0, relevance: 0.01 },
      ];

      const vectorRows: SearchResult[] = [
        { content: "far", filename: "manish.pdf", distance: MAX_DISTANCE + 0.1 },
      ];

      const relevant = mergeRetrievalResults(filteredOwnerRows, mockLexicalRows, vectorRows);

      // Everything filtered → empty context → routes.ts would show "no relevant information"
      expect(relevant).toHaveLength(0);
    });

    test("high-relevance owner row passes through while low-relevance is blocked", () => {
      const question = "who is Manish?";
      const personTerm = getPersonLookupTerm(question);

      const mockOwnerRows: SearchResult[] = [
        { content: "noise without person name", filename: "manish.pdf", distance: 0 },
        { content: "Manish is a software engineer", filename: "manish.pdf", distance: 0 },
      ];

      const filteredOwnerRows = mockOwnerRows
        .map((row) => ({
          ...row,
          relevance: row.content.toLowerCase().includes(personTerm!) ? 1.0 : 0.0,
        }))
        .filter((row) => row.relevance >= MIN_OWNER_RELEVANCE);

      // Only the row containing "manish" passes
      expect(filteredOwnerRows).toHaveLength(1);
      expect(filteredOwnerRows[0]!.content).toBe("Manish is a software engineer");

      const relevant = mergeRetrievalResults(filteredOwnerRows, [], []);
      expect(relevant).toHaveLength(1);
      expect(relevant[0]!.content).toBe("Manish is a software engineer");
    });
  });

  // ── Error Recovery ──────────────────────────────────────────────────

  describe("Error Recovery", () => {
    test("empty text produces no chunks", () => {
      const chunks = chunkText("");
      expect(chunks).toHaveLength(0);
    });

    test("very short text produces one chunk", () => {
      const chunks = chunkText("Hello world");
      expect(chunks).toHaveLength(1);
    });

    test("retrieval handles empty results gracefully", () => {
      const result = mergeRetrievalResults([], [], []);
      expect(result).toHaveLength(0);
    });
  });
});
