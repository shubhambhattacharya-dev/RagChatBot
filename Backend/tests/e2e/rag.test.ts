import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Test 8 — end-to-end against the LIVE API (server must be running on :3000).
// Verifies the full chain: upload → extract → chunk → embed → store → retrieve → prompt → LLM → answer.
// Questions come from tests/e2e/questions.json (regression set).

const BASE = process.env.API_BASE ?? "http://localhost:3000";
const describeLive = process.env.RUN_E2E_TESTS === "1" ? describe : describe.skip;

interface Q {
  question: string;
  expected?: string;
  expected_refusal?: boolean;
}

const questions: Q[] = JSON.parse(
  readFileSync(join(import.meta.dir, "questions.json"), "utf8")
);

// Collect SSE events from GET /chat?question=...
async function chat(question: string): Promise<{ tokens: string; sources: string[]; warnings: string[] }> {
  const res = await fetch(`${BASE}/chat?question=${encodeURIComponent(question)}`);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let tokens = "";
  const sources: string[] = [];
  const warnings: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const evt of events) {
      const line = evt.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        const data = JSON.parse(line.slice(5));
        if (data.type === "token") tokens += data.content ?? "";
        if (data.type === "sources" && Array.isArray(data.documents)) sources.push(...data.documents);
        if (data.type === "warning") warnings.push(data.message ?? "");
      } catch {
        // ignore malformed frames
      }
    }
  }
  return { tokens, sources, warnings };
}

describeLive("e2e RAG pipeline (live API)", () => {
  test("server is up", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
  });

  test("answers the email question with a source chip", async () => {
    const { tokens, sources } = await chat("What is Manish's email?");
    expect(tokens.toLowerCase()).toContain("bhattacharya.manish8@gmail.com");
    expect(sources.length).toBeGreaterThan(0);
  });

  test("refuses out-of-document questions (no hallucination)", async () => {
    const { tokens, warnings } = await chat("What is the capital of France?");
    // Either a warning event, or an honest refusal in tokens — never an answer.
    const refused =
      warnings.length > 0 ||
      tokens.toLowerCase().includes("couldn't find") ||
      tokens.toLowerCase().includes("not found") ||
      tokens.toLowerCase().includes("don't have");
    expect(refused).toBe(true);
    expect(tokens.toLowerCase()).not.toContain("paris");
  });

  // Regression set — every question must hit its expected value.
  for (const q of questions.filter((x) => x.expected)) {
    test(`regression: "${q.question}" → contains "${q.expected}"`, async () => {
      const { tokens } = await chat(q.question);
      expect(tokens.toLowerCase()).toContain((q.expected as string).toLowerCase());
    });
  }

  test("regression: refusal case stays a refusal", async () => {
    const q = questions.find((x) => x.expected_refusal)!;
    const { tokens } = await chat(q.question);
    const refused =
      tokens.toLowerCase().includes("couldn't find") ||
      tokens.toLowerCase().includes("not found") ||
      tokens.toLowerCase().includes("don't have");
    expect(refused).toBe(true);
  });
});
