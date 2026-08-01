import { describe, expect, test } from "bun:test";
import { streamChat } from "../../src/provider/llm/groq";

const describeLive = process.env.RUN_LIVE_LLM_TESTS === "1" ? describe : describe.skip;

// Test 7 — LLM with FIXED context (isolates generation from retrieval).
// If these fail, the model/prompt is the problem, not the retriever.

const EMAIL_CONTEXT = [
  "Document: manish.pdf\nMetadata: Contact details detected\n\nEmail: bhattacharya.manish8@gmail.com\nPhone: +91-9599178545\nWebsite: https://manishbhattacharya.com/",
];

async function ask(question: string, context: string[]) {
  let answer = "";
  for await (const token of streamChat(question, context)) {
    answer += token;
  }
  return answer;
}

describeLive("LLM generation (fixed context, live Groq/OpenRouter)", () => {
  test("answers the email from provided context", async () => {
    const answer = await ask("What is the email?", EMAIL_CONTEXT);
    expect(answer.toLowerCase()).toContain("bhattacharya.manish8");
  });

  test("refuses to answer without context (no memory answers)", async () => {
    await expect(ask("What is the capital of France?", [])).rejects.toThrow("No relevant context");
  });

  test("does not answer out-of-context questions from memory", async () => {
    const answer = await ask("What is the capital of France?", EMAIL_CONTEXT);
    expect(answer.toLowerCase()).not.toContain("paris");
  });
});
