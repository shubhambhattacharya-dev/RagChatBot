import { describe, expect, test } from "vitest";
import {
  expandQuery,
  getPersonLookupTerm,
  buildLexicalTsQuery,
  mergeRetrievalResults,
  TOP_K,
  MAX_DISTANCE,
  type SearchResult,
} from "../../src/modules/chat/retrieval";

// ─── Helpers ────────────────────────────────────────────────────────────────

function row(content: string, distance = 0, filename = "doc.pdf"): SearchResult {
  return { content, filename, distance };
}

// ─── expandQuery ────────────────────────────────────────────────────────────

describe("expandQuery", () => {
  describe("person-summary queries", () => {
    test("expands 'who is X' with resume sections", () => {
      const result = expandQuery("who is Manish");
      expect(result).toContain("professional summary");
      expect(result).toContain("skills");
      expect(result).toContain("work experience");
      expect(result).toContain("Manish");
    });

    test("expands 'information about X' phrasing", () => {
      const result = expandQuery("info about Shubham");
      expect(result).toContain("Shubham");
      expect(result).toContain("professional summary");
    });

    test("expands 'tell me about X' phrasing", () => {
      const result = expandQuery("tell me about Alice");
      expect(result).toContain("Alice");
      expect(result).toContain("contact details");
    });

    test("preserves original casing in the question", () => {
      const result = expandQuery("Who is JOHN?");
      expect(result).toContain("Who is JOHN?");
      expect(result).toContain("john");
    });

    test("handles names with apostrophes", () => {
      const result = expandQuery("who is O'Brien");
      expect(result).toContain("O'Brien");
    });
  });

  describe("contact/email queries", () => {
    test("expands bare 'email' query", () => {
      const result = expandQuery("email");
      expect(result).toContain("email address");
      expect(result).toContain("contact details");
    });

    test("expands 'what is the email?'", () => {
      const result = expandQuery("what is the email?");
      expect(result).toContain("email address");
      expect(result).toContain("gmail");
    });

    test("expands 'contact info' bare query", () => {
      const result = expandQuery("contact info");
      expect(result).toContain("email address");
      expect(result).toContain("phone number");
    });

    test("expands phone queries", () => {
      const result = expandQuery("phone number");
      expect(result).toContain("phone number");
      expect(result).toContain("mobile");
    });

    test("expands website queries", () => {
      const result = expandQuery("website url");
      expect(result).toContain("website");
      expect(result).toContain("homepage");
    });
  });

  describe("portfolio/project queries", () => {
    test("expands bare 'projects' query", () => {
      const result = expandQuery("projects");
      expect(result).toContain("publications");
      expect(result).toContain("hackathons");
      expect(result).toContain("bug bounties");
    });

    test("expands 'portfolio' query", () => {
      const result = expandQuery("portfolio");
      expect(result).toContain("portfolio work");
    });

    test("expands project queries with additional context", () => {
      const result = expandQuery("what projects did they build?");
      expect(result).toContain("projects");
      expect(result).toContain("portfolio");
    });
  });

  describe("author queries", () => {
    test("expands bare 'author' query", () => {
      const result = expandQuery("author");
      expect(result).toContain("authors");
      expect(result).toContain("creators");
    });

    test("expands 'written by' query", () => {
      const result = expandQuery("who wrote this?");
      // "wrote" doesn't match any pattern, passes through
      expect(result).toBe("who wrote this?");
    });

    test("expands 'authors' plural query", () => {
      const result = expandQuery("authors");
      expect(result).toContain("author names");
    });
  });

  describe("names/people queries", () => {
    test("expands bare 'names' query", () => {
      const result = expandQuery("names");
      expect(result).toContain("names of the people");
    });

    test("expands 'people' query", () => {
      const result = expandQuery("people");
      expect(result).toContain("people or authors");
    });
  });

  describe("generic info queries", () => {
    test("expands bare 'info' query", () => {
      const result = expandQuery("info");
      expect(result).toContain("professional summary");
      expect(result).toContain("experience");
    });

    test("expands 'details' query", () => {
      const result = expandQuery("details");
      expect(result).toContain("skills");
    });
  });

  describe("passthrough (non-matching)", () => {
    test("passes through descriptive questions unchanged", () => {
      const q = "What is the attention mechanism?";
      expect(expandQuery(q)).toBe(q);
    });

    test("passes through technical questions unchanged", () => {
      const q = "How does backpropagation work?";
      expect(expandQuery(q)).toBe(q);
    });

    test("passes through compound questions unchanged", () => {
      const q = "What are the main contributions of this paper?";
      expect(expandQuery(q)).toBe(q);
    });
  });

  describe("edge cases", () => {
    test("handles empty string", () => {
      expect(expandQuery("")).toBe("");
    });

    test("handles whitespace-only input", () => {
      expect(expandQuery("   ")).toBe("   ");
    });

    test("handles single character input", () => {
      expect(expandQuery("a")).toBe("a");
    });

    test("handles very long input", () => {
      const long = "x".repeat(5000);
      expect(expandQuery(long)).toBe(long);
    });
  });
});

// ─── getPersonLookupTerm ────────────────────────────────────────────────────

describe("getPersonLookupTerm", () => {
  describe("valid patterns", () => {
    test("'who is X' → name", () => {
      expect(getPersonLookupTerm("who is Manish")).toBe("manish");
    });

    test("'Who is X?' with question mark", () => {
      expect(getPersonLookupTerm("Who is Shubham?")).toBe("shubham");
    });

    test("'Who is X.' with period", () => {
      expect(getPersonLookupTerm("Who is Alice.")).toBe("alice");
    });

    test("'Who is X!' with exclamation", () => {
      expect(getPersonLookupTerm("Who is Bob!")).toBe("bob");
    });

    test("'information about X'", () => {
      expect(getPersonLookupTerm("information about Alice")).toBe("alice");
    });

    test("'info about X'", () => {
      expect(getPersonLookupTerm("info about Bob")).toBe("bob");
    });

    test("'tell me about X'", () => {
      expect(getPersonLookupTerm("tell me about Carol")).toBe("carol");
    });

    test("handles hyphenated names", () => {
      expect(getPersonLookupTerm("who is Jean-Pierre")).toBe("jean-pierre");
    });

    test("handles names with apostrophes", () => {
      expect(getPersonLookupTerm("who is O'Brien")).toBe("o'brien");
    });

    test("handles 3-char minimum names", () => {
      expect(getPersonLookupTerm("who is Ali")).toBe("ali");
    });
  });

  describe("invalid patterns (returns null)", () => {
    test("non-person queries", () => {
      expect(getPersonLookupTerm("what is the email?")).toBeNull();
      expect(getPersonLookupTerm("projects")).toBeNull();
      expect(getPersonLookupTerm("hello")).toBeNull();
    });

    test("names shorter than 3 chars", () => {
      expect(getPersonLookupTerm("who is Al")).toBeNull();
    });

    test("names with numbers", () => {
      expect(getPersonLookupTerm("who is Agent007")).toBeNull();
    });

    test("multiple words after 'who is'", () => {
      expect(getPersonLookupTerm("who is the best engineer")).toBeNull();
    });

    test("random text", () => {
      expect(getPersonLookupTerm("random question")).toBeNull();
    });
  });
});

// ─── buildLexicalTsQuery ────────────────────────────────────────────────────

describe("buildLexicalTsQuery", () => {
  describe("basic functionality", () => {
    test("builds OR query from meaningful terms", () => {
      const result = buildLexicalTsQuery("What projects are listed?");
      expect(result).toContain("projects:*");
      expect(result).toContain("listed:*");
      expect(result).toContain(" | ");
    });

    test("returns null when all terms are stop words", () => {
      expect(buildLexicalTsQuery("the is a")).toBeNull();
    });

    test("returns null for empty input", () => {
      expect(buildLexicalTsQuery("")).toBeNull();
    });
  });

  describe("stop word filtering", () => {
    test("filters common stop words", () => {
      const result = buildLexicalTsQuery("what is the document about?");
      // Stop words filtered: what, is, the, document. "about" remains.
      expect(result).toBe("about:*");
    });

    test("filters all stop words in a sentence", () => {
      const result = buildLexicalTsQuery("who is the author of this?");
      // Stop words: who, is, the, this → all filtered
      expect(result).toBe("author:*");
    });
  });

  describe("term extraction", () => {
    test("filters short terms (< 3 chars)", () => {
      const result = buildLexicalTsQuery("my IP is 192");
      // "my" (2 chars), "IP" → "ip" (2 chars), "192" (3 chars) → only "192:*"
      expect(result).toBe("192:*");
    });

    test("extracts numeric terms", () => {
      const result = buildLexicalTsQuery("version 314 released");
      // "314" is 3+ chars → included. "version" and "released" are not stop words.
      expect(result).toContain("version:*");
      expect(result).toContain("314:*");
      expect(result).toContain("released:*");
    });

    test("lowercases all terms", () => {
      const result = buildLexicalTsQuery("Email Address PHONE");
      expect(result).toContain("email:*");
      expect(result).toContain("address:*");
      expect(result).toContain("phone:*");
    });
  });

  describe("deduplication", () => {
    test("deduplicates identical terms", () => {
      const result = buildLexicalTsQuery("project project projects");
      // "project" appears twice → deduped to one. "projects" is a different word.
      expect(result).toBe("project:* | projects:*");
    });

    test("deduplicates across cases", () => {
      const result = buildLexicalTsQuery("Project PROJECT project");
      expect(result).toBe("project:*");
    });
  });
});

// ─── mergeRetrievalResults (RRF) ────────────────────────────────────────────

describe("mergeRetrievalResults", () => {
  describe("priority ordering", () => {
    test("exact matches rank highest when present", () => {
      const exact = [row("exact match", 0)];
      const lexical = [row("lexical match", 0)];
      const vector = [row("vector match", 0.3)];

      const result = mergeRetrievalResults(exact, lexical, vector);
      expect(result[0]?.content).toBe("exact match");
    });

    test("lexical matches rank above vector when no exact matches", () => {
      const lexical = [row("lexical match", 0)];
      const vector = [row("vector match", 0.3)];

      const result = mergeRetrievalResults([], lexical, vector);
      expect(result[0]?.content).toBe("lexical match");
    });

    test("vector results rank when no exact or lexical matches", () => {
      const vector = [row("vector match", 0.3)];
      const result = mergeRetrievalResults([], [], vector);
      expect(result[0]?.content).toBe("vector match");
    });
  });

  describe("distance gating", () => {
    test("excludes vector results beyond MAX_DISTANCE", () => {
      const farVector = [row("far match", MAX_DISTANCE + 0.1)];
      const result = mergeRetrievalResults([], [], farVector);
      expect(result).toHaveLength(0);
    });

    test("includes vector results within threshold", () => {
      const nearVector = [row("near match", MAX_DISTANCE - 0.01)];
      const result = mergeRetrievalResults([], [], nearVector);
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe("near match");
    });

    test("includes vector results at exact threshold", () => {
      const atThreshold = [row("at threshold", MAX_DISTANCE)];
      const result = mergeRetrievalResults([], [], atThreshold);
      expect(result).toHaveLength(1);
    });

    test("excludes vector results when exact matches exist (even if within threshold)", () => {
      const exact = [row("exact", 0)];
      const vector = [row("vector", 0.1)];
      const result = mergeRetrievalResults(exact, [], vector);
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe("exact");
    });
  });

  describe("deduplication", () => {
    test("deduplicates identical content across strategies", () => {
      const exact = [row("same content", 0, "doc.pdf")];
      const lexical = [row("same content", 0, "doc.pdf")];
      const result = mergeRetrievalResults(exact, lexical, []);
      expect(result).toHaveLength(1);
    });

    test("keeps different content as separate results", () => {
      const exact = [row("content A", 0)];
      const lexical = [row("content B", 0)];
      const result = mergeRetrievalResults(exact, lexical, []);
      expect(result).toHaveLength(2);
    });

    test("keeps same content from different files as separate results", () => {
      const exact = [row("same content", 0, "file1.pdf")];
      const lexical = [row("same content", 0, "file2.pdf")];
      const result = mergeRetrievalResults(exact, lexical, []);
      expect(result).toHaveLength(2);
    });

    test("prefers lower distance when same content appears multiple times", () => {
      const exact = [row("same", 0.4)];
      const lexical = [row("same", 0.2)];
      const result = mergeRetrievalResults(exact, lexical, []);
      expect(result).toHaveLength(1);
      expect(result[0]?.distance).toBe(0.2);
    });
  });

  describe("maxResults limiting", () => {
    test("respects maxResults limit", () => {
      const many = Array.from({ length: 20 }, (_, i) => row(`row ${i}`, 0.1));
      const result = mergeRetrievalResults([], [], many, 5);
      expect(result).toHaveLength(5);
    });

    test("defaults to TOP_K when maxResults not specified", () => {
      const many = Array.from({ length: TOP_K + 10 }, (_, i) => row(`row ${i}`, 0.1));
      const result = mergeRetrievalResults([], [], many);
      expect(result).toHaveLength(TOP_K);
    });

    test("returns all results when fewer than maxResults", () => {
      const few = [row("a", 0.1), row("b", 0.2)];
      const result = mergeRetrievalResults([], [], few, 10);
      expect(result).toHaveLength(2);
    });
  });

  describe("RRF score combination", () => {
    test("combines scores across strategies for same content", () => {
      const exact = [row("combined", 0)];
      const lexical = [row("combined", 0)];
      const other = [row("other", 0)];
      const result = mergeRetrievalResults(exact, lexical, other);
      expect(result[0]?.content).toBe("combined");
    });

    test("ranks by combined RRF score, not individual strategy", () => {
      // "A" appears in exact (weight 3.0) and lexical (weight 1.5)
      // "B" appears only in exact (weight 3.0)
      const exact = [row("A", 0), row("B", 0)];
      const lexical = [row("A", 0)];
      const result = mergeRetrievalResults(exact, lexical, []);
      expect(result[0]?.content).toBe("A"); // Higher combined score
      expect(result[1]?.content).toBe("B");
    });
  });

  describe("empty inputs", () => {
    test("handles all empty inputs", () => {
      const result = mergeRetrievalResults([], [], []);
      expect(result).toHaveLength(0);
    });

    test("handles empty exact + lexical with vector results", () => {
      const vector = [row("v", 0.3)];
      const result = mergeRetrievalResults([], [], vector);
      expect(result).toHaveLength(1);
    });

    test("handles empty vector with exact results", () => {
      const exact = [row("e", 0)];
      const result = mergeRetrievalResults(exact, [], []);
      expect(result).toHaveLength(1);
    });
  });

  describe("stress/edge cases", () => {
    test("handles 100+ results efficiently", () => {
      const many = Array.from({ length: 100 }, (_, i) => row(`row ${i}`, 0.1 + i * 0.001));
      const start = Date.now();
      const result = mergeRetrievalResults([], [], many);
      const elapsed = Date.now() - start;
      expect(result).toHaveLength(TOP_K);
      expect(elapsed).toBeLessThan(100); // Should be fast
    });

    test("handles empty content strings", () => {
      const exact = [row("", 0)];
      const result = mergeRetrievalResults(exact, [], []);
      expect(result).toHaveLength(1);
    });

    test("handles very long content strings", () => {
      const longContent = "x".repeat(10000);
      const exact = [row(longContent, 0)];
      const result = mergeRetrievalResults(exact, [], []);
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe(longContent);
    });
  });
});
