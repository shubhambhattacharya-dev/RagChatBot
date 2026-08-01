import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractText } from "../../src/services/document/extract";

function fixture(name: string): Buffer {
  return readFileSync(join(import.meta.dir, "..", "fixtures", name));
}

describe("PDF extraction (src/services/document/extract.ts)", () => {
  test("manish.pdf opens and extracts text", async () => {
    const text = await extractText(fixture("manish.pdf"), "application/pdf", "manish.pdf");
    expect(text.length).toBeGreaterThan(100);
  });

  test("manish.pdf contains the email", async () => {
    const text = await extractText(fixture("manish.pdf"), "application/pdf", "manish.pdf");
    expect(text).toContain("bhattacharya.manish8@gmail.com");
  });

  test("manish.pdf contains the website", async () => {
    const text = await extractText(fixture("manish.pdf"), "application/pdf", "manish.pdf");
    expect(text).toContain("manishbhattacharya.com");
  });

  test("manish.pdf contains the phone", async () => {
    const text = await extractText(fixture("manish.pdf"), "application/pdf", "manish.pdf");
    expect(text).toContain("9599178545");
  });

  test("attention.pdf opens and extracts title", async () => {
    const text = await extractText(fixture("attention.pdf"), "application/pdf", "attention.pdf");
    expect(text).toContain("Attention Is All You Need");
  });

  test("attention.pdf contains the first author", async () => {
    const text = await extractText(fixture("attention.pdf"), "application/pdf", "attention.pdf");
    expect(text).toContain("Ashish Vaswani");
  });

  test("shubham.pdf opens and contains email", async () => {
    const text = await extractText(fixture("shubham.pdf"), "application/pdf", "shubham.pdf");
    expect(text).toContain("shubhambhattacharya107@gmail.com");
  });

  test("markdown fixture extracts via mimeType", async () => {
    const text = await extractText(fixture("sample.md"), "text/markdown", "sample.md");
    expect(text).toContain("test.candidate@example.com");
  });

  test("unsupported type throws a clear error", async () => {
    await expect(extractText(fixture("manish.pdf"), "application/x-rar", "file.rar")).rejects.toThrow(
      "Unsupported document type"
    );
  });
});
