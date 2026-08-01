import { describe, expect, test } from "bun:test";
import { buildLexicalTsQuery, expandQuery } from "../../src/modules/chat/routes";

describe("RAG query expansion", () => {
  test("adds resume project-section terms to a project query", () => {
    const expanded = expandQuery("projects").toLowerCase();
    expect(expanded).toContain("projects");
    expect(expanded).toContain("publications");
    expect(expanded).toContain("bug bounties");
  });

  test("builds a safe exact-term fallback query", () => {
    expect(buildLexicalTsQuery("What projects are listed?")).toBe("projects:* | listed:*");
  });
});
