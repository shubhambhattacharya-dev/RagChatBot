import { describe, expect, test } from "vitest";
import { buildChatMessages } from "../../src/provider/llm/groq";

// Test 6 — prompt: the exact messages that reach the LLM must contain
// the question, the retrieved chunks, the metadata, and the grounding rules.

describe("prompt construction (buildChatMessages)", () => {
  const question = "What is Manish's email?";
  const chunk = "Document: manish.pdf\nMetadata: Contact details detected\n\nEmail: bhattacharya.manish8@gmail.com";
  const messages = buildChatMessages(question, [chunk]);

  test("returns system + context + user messages", () => {
    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("system");
    expect(messages[2]!.role).toBe("user");
  });

  test("user message is the question", () => {
    expect(messages[2]!.content).toBe(question);
  });

  test("context message contains the retrieved chunk + metadata", () => {
    const context = String(messages[1]!.content);
    expect(context).toContain("Retrieved Context");
    expect(context).toContain("bhattacharya.manish8@gmail.com");
    expect(context).toContain("manish.pdf");
    expect(context).toContain("Email:");
  });

  test("system prompt enforces grounding (no memory answers)", () => {
    const system = String(messages[0]!.content);
    expect(system.toLowerCase()).toContain("document");
    expect(system.toLowerCase()).toContain("context");
    expect(system.toLowerCase()).toContain("synthesize");
  });

  test("empty context still builds (guard is in streamChat)", () => {
    const msgs = buildChatMessages("hi", []);
    expect(msgs).toHaveLength(3);
  });
});
