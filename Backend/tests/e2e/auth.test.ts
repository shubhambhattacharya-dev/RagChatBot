import { describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";

// End-to-end authentication gate tests against the LIVE API (server running).
// Verifies the unauthenticated behaviour of every protected route and the
// public ones. Authenticated (cookie-carrying) flows are covered by the
// database integration suite plus manual/eval runs.
//
//   RUN_E2E_TESTS=1 API_BASE=http://localhost:3001 bun test tests/e2e/auth.test.ts

const BASE = process.env.API_BASE ?? "http://localhost:3000";
const describeLive = process.env.RUN_E2E_TESTS === "1" ? describe : describe.skip;

async function get(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, { redirect: "manual", ...init });
}

describeLive("authentication gates (live API)", () => {
  test("health stays public for Render probes", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
  });

  test("frontend login page stays public", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
  });

  test("documents list requires a session", async () => {
    const res = await get("/documents");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toBeTruthy();
  });

  test("single document lookup requires a session (404-equivalent, no leak)", async () => {
    const res = await get(`/document/${randomUUID()}`);
    expect([401, 404]).toContain(res.status);
  });

  test("chat (GET SSE) requires a session", async () => {
    const res = await get("/chat?question=hello");
    expect(res.status).toBe(401);
  });

  test("chat (POST) requires a session", async () => {
    const res = await get("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  test("conversation list, clear, and single delete require a session", async () => {
    expect((await get("/conversations")).status).toBe(401);
    expect((await get("/conversations", { method: "DELETE" })).status).toBe(401);
    expect((await get(`/conversations/${randomUUID()}`, { method: "DELETE" })).status).toBe(401);
  });

  test("upload requires a session", async () => {
    const form = new FormData();
    form.append("file", new Blob(["%PDF-fake"]), "x.pdf");
    const res = await get("/upload", { method: "POST", body: form });
    expect(res.status).toBe(401);
  });

  test("admin dead-letter endpoints require a session", async () => {
    expect((await get("/admin/dead-letters")).status).toBe(401);
    expect((await get(`/admin/retry/${randomUUID()}`, { method: "POST" })).status).toBe(401);
  });

  test("/auth/me reports signed-out state as 401", async () => {
    const res = await get("/auth/me");
    expect(res.status).toBe(401);
  });

  test("forged session cookie is rejected (signature check)", async () => {
    const res = await get("/documents", {
      headers: { Cookie: `rag_user=${randomUUID()}.forged-signature` },
    });
    expect(res.status).toBe(401);
  });

  test("auth flow start redirects to Google consent or reports missing config", async () => {
    const res = await get("/auth/google");
    if (res.status === 302) {
      const location = res.headers.get("location") ?? "";
      const url = new URL(location);
      expect(url.host).toBe("accounts.google.com");
      expect(url.searchParams.get("client_id")).toBeTruthy();
      expect(url.searchParams.get("state")).toBeTruthy();
      // State cookie must be set so the callback can validate the round-trip.
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("rag_oauth_state=");
    } else {
      // Dev environment without Google credentials — must fail loudly, not silently.
      expect(res.status).toBe(503);
    }
  });

  test("OAuth callback with bad state is rejected (CSRF guard)", async () => {
    const res = await get(`/auth/google/callback?code=fake&state=${randomUUID()}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("auth=invalid_state");
  });
});
