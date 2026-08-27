import { expect, test } from "vitest";
import { chunkText, enrichChunks, estimateTokens } from "../../src/utils/chunking";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(__dirname, "..", "fixtures", "attention.txt"), "utf8");

test("keeps authors and emails in the enriched title chunk", async () => {
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

test("estimates CJK and Indic text conservatively", () => {
  expect(estimateTokens("你好世界" )).toBeGreaterThan(estimateTokens("hello"));
  expect(estimateTokens("नमस्ते दुनिया")).toBeGreaterThan(1);
});
