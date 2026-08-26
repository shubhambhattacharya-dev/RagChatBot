import { describe, expect, test, vi } from "vitest";
import { setupSSE, sendSSE, sendSSEDone } from "../../src/utils/sse";

// ─── Mock Factory ───────────────────────────────────────────────────────────

function createMockReply(headers: Record<string, string> = {}) {
  const written: string[] = [];
  return {
    raw: {
      writeHead: vi.fn(),
      write: vi.fn((data: string) => written.push(data)),
      end: vi.fn(),
      flushHeaders: vi.fn(),
      destroyed: false,
      writableEnded: false,
    },
    request: { headers },
    written,
  };
}

// ─── setupSSE ───────────────────────────────────────────────────────────────

describe("setupSSE", () => {
  test("sets Content-Type to text/event-stream", () => {
    const reply = createMockReply() as any;
    setupSSE(reply);

    expect(reply.raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "text/event-stream; charset=utf-8",
      })
    );
  });

  test("sets Cache-Control to no-cache", () => {
    const reply = createMockReply() as any;
    setupSSE(reply);

    const headers = reply.raw.writeHead.mock.calls[0]![1]!;
    expect(headers["Cache-Control"]).toBe("no-cache");
  });

  test("sets Connection to keep-alive", () => {
    const reply = createMockReply() as any;
    setupSSE(reply);

    const headers = reply.raw.writeHead.mock.calls[0]![1]!;
    expect(headers["Connection"]).toBe("keep-alive");
  });

  test("includes CORS headers when origin is present", () => {
    const reply = createMockReply({ origin: "http://localhost:5500" }) as any;
    setupSSE(reply);

    const headers = reply.raw.writeHead.mock.calls[0]![1]!;
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5500");
    expect(headers["Vary"]).toBe("Origin");
  });

  test("omits CORS headers when no origin", () => {
    const reply = createMockReply() as any;
    setupSSE(reply);

    const headers = reply.raw.writeHead.mock.calls[0]![1]!;
    expect(headers).not.toHaveProperty("Access-Control-Allow-Origin");
  });

  test("calls flushHeaders if available", () => {
    const reply = createMockReply() as any;
    setupSSE(reply);
    expect(reply.raw.flushHeaders).toHaveBeenCalled();
  });

  test("handles missing flushHeaders gracefully", () => {
    const reply = createMockReply() as any;
    reply.raw.flushHeaders = undefined;
    expect(() => setupSSE(reply)).not.toThrow();
  });
});

// ─── sendSSE ────────────────────────────────────────────────────────────────

describe("sendSSE", () => {
  test("writes JSON-encoded data with data: prefix", () => {
    const reply = createMockReply() as any;
    sendSSE(reply, { type: "token", content: "hello" });

    expect(reply.raw.write).toHaveBeenCalledWith(
      'data: {"type":"token","content":"hello"}\n\n'
    );
  });

  test("handles string data", () => {
    const reply = createMockReply() as any;
    sendSSE(reply, "plain text");

    expect(reply.raw.write).toHaveBeenCalledWith(
      'data: "plain text"\n\n'
    );
  });

  test("handles number data", () => {
    const reply = createMockReply() as any;
    sendSSE(reply, 42);

    expect(reply.raw.write).toHaveBeenCalledWith(
      'data: 42\n\n'
    );
  });

  test("handles null data", () => {
    const reply = createMockReply() as any;
    sendSSE(reply, null);

    expect(reply.raw.write).toHaveBeenCalledWith(
      'data: null\n\n'
    );
  });

  test("handles nested objects", () => {
    const reply = createMockReply() as any;
    sendSSE(reply, { type: "sources", count: 3, documents: ["a.pdf", "b.pdf"] });

    const written: string = reply.raw.write.mock.calls[0]![0];
    expect(written).toContain('"type":"sources"');
    expect(written).toContain('"count":3');
    expect(written).toContain('"a.pdf"');
    expect(written.startsWith("data: ")).toBe(true);
    expect(written.endsWith("\n\n")).toBe(true);
  });

  test("handles objects with special characters", () => {
    const reply = createMockReply() as any;
    sendSSE(reply, { content: "line1\nline2\ttab" });

    const written: string = reply.raw.write.mock.calls[0]![0];
    expect(written).toContain("\\n");
    expect(written).toContain("\\t");
  });

  test("handles empty object", () => {
    const reply = createMockReply() as any;
    sendSSE(reply, {});

    const written: string = reply.raw.write.mock.calls[0]![0];
    expect(written).toBe("data: {}\n\n");
  });
});

// ─── sendSSEDone ────────────────────────────────────────────────────────────

describe("sendSSEDone", () => {
  test("writes [DONE] marker", () => {
    const reply = createMockReply() as any;
    sendSSEDone(reply);

    expect(reply.raw.write).toHaveBeenCalledWith("data: [DONE]\n\n");
  });

  test("ends the response", () => {
    const reply = createMockReply() as any;
    sendSSEDone(reply);

    expect(reply.raw.end).toHaveBeenCalled();
  });

  test("calls end exactly once", () => {
    const reply = createMockReply() as any;
    sendSSEDone(reply);

    expect(reply.raw.end).toHaveBeenCalledTimes(1);
  });
});

// ─── Full SSE flow ──────────────────────────────────────────────────────────

describe("full SSE flow", () => {
  test("setup → send tokens → send sources → done produces correct sequence", () => {
    const reply = createMockReply() as any;
    setupSSE(reply);
    sendSSE(reply, { type: "token", content: "Hel" });
    sendSSE(reply, { type: "token", content: "lo" });
    sendSSE(reply, { type: "sources", count: 1, documents: ["doc.pdf"] });
    sendSSEDone(reply);

    // 2 token events + 1 sources event + 1 done = 4 writes
    expect(reply.raw.write).toHaveBeenCalledTimes(4);

    const calls: string[] = reply.raw.write.mock.calls.map((c: any[]) => c[0]);
    expect(calls[0]).toContain('"content":"Hel"');
    expect(calls[1]).toContain('"content":"lo"');
    expect(calls[2]).toContain('"type":"sources"');
    expect(calls[3]).toBe("data: [DONE]\n\n");
    expect(reply.raw.end).toHaveBeenCalledTimes(1);
  });

  test("setup → status → error → done", () => {
    const reply = createMockReply() as any;
    setupSSE(reply);
    sendSSE(reply, { type: "status", step: "embedding", message: "Embedding..." });
    sendSSE(reply, { type: "token", content: "> ❌ Error: timeout" });
    sendSSEDone(reply);

    expect(reply.raw.write).toHaveBeenCalledTimes(3);
    const calls: string[] = reply.raw.write.mock.calls.map((c: any[]) => c[0]);
    expect(calls[0]).toContain('"step":"embedding"');
    expect(calls[1]).toContain("Error");
    expect(calls[2]).toBe("data: [DONE]\n\n");
  });

  test("empty stream (just done)", () => {
    const reply = createMockReply() as any;
    setupSSE(reply);
    sendSSEDone(reply);

    expect(reply.raw.write).toHaveBeenCalledTimes(1);
    expect(reply.raw.write).toHaveBeenCalledWith("data: [DONE]\n\n");
    expect(reply.raw.end).toHaveBeenCalled();
  });

  test("many tokens (streaming simulation)", () => {
    const reply = createMockReply() as any;
    setupSSE(reply);

    const tokens = "Hello, world!".split("");
    for (const char of tokens) {
      sendSSE(reply, { type: "token", content: char });
    }
    sendSSEDone(reply);

    expect(reply.raw.write).toHaveBeenCalledTimes(tokens.length + 1);
    // Verify each token is correctly formatted
    for (let i = 0; i < tokens.length; i++) {
      expect(reply.raw.write.mock.calls[i]![0]).toContain(`"${tokens[i]}"`);
    }
  });
});
