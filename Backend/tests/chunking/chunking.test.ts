import { expect, test } from "bun:test";
import { chunkText, enrichChunks } from "../../src/utils/chunking";

test("keeps authors and emails in the enriched title chunk", async () => {
  const text = await Bun.file("tests/fixtures/attention.txt").text();
  const chunks = enrichChunks(chunkText(text), "attention.txt");
  const authorChunk = chunks.find((chunk) => chunk.content.includes("Ashish Vaswani"));

  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((chunk) => chunk.content.trim().length > 0)).toBe(true);
  expect(authorChunk?.content).toContain("Noam Shazeer");
  expect(authorChunk?.content).toContain("Email: avaswani@google.com");
  expect(authorChunk?.content).toContain("Content:");
});

test("does not duplicate chunks when overlap is disabled", () => {
  const chunks = chunkText("1 First\nalpha\n2 Second\nbeta");
  expect(new Set(chunks.map((chunk) => chunk.content)).size).toBe(chunks.length);
});
