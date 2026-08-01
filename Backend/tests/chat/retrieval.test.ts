import { expect, test } from "bun:test";
import { buildLexicalTsQuery, expandQuery, getPersonLookupTerm, mergeRetrievalResults } from "../../src/modules/chat/routes";

test("builds a lexical query from a person lookup", () => {
  expect(buildLexicalTsQuery("Who is Manish?")).toBe("manish:*");
  expect(getPersonLookupTerm("Who is Manish?")).toBe("manish");
});

test("normalizes case and supports word variants in lexical search", () => {
  expect(buildLexicalTsQuery("WORD words Words")).toBe("word:* | words:*");
  expect(expandQuery("PROJECTS").toLowerCase()).toContain("projects, portfolio");
});

test("keeps exact resume matches when a weaker vector match exists", () => {
  const results = mergeRetrievalResults(
    [],
    [{ content: "Owner: Manish Bhattacharya\nEXPERIENCE", filename: "manish.pdf", distance: 0 }],
    [{ content: "Unrelated paper section", filename: "attention.pdf", distance: 0.42 }],
  );

  expect(results).toHaveLength(2);
  expect(results[0]?.filename).toBe("manish.pdf");
  expect(results[0]?.content).toContain("Manish Bhattacharya");
});

test("does not mix another resume into a metadata-filtered person result", () => {
  const results = mergeRetrievalResults(
    [{ content: "Owner: Manish Bhattacharya", filename: "manish.pdf", distance: 0 }],
    [],
    [{ content: "Owner: Shubham Bhattacharya", filename: "shubham.pdf", distance: 0.1 }],
  );

  expect(results.map((result) => result.filename)).toEqual(["manish.pdf"]);
});
