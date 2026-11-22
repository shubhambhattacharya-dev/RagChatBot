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

describeLive("authentication gates (live API — open sandbox mode)", () => {
  test("health stays public for Render probes", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
  });

  test("frontend landing page stays public", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
  });

  test("/auth/me automatically provisions a guest session and signed cookie", async () => {
    const res = await get("/auth/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string; isGuest?: boolean };
    expect(body.id).toBeTruthy();
    expect(body.isGuest).toBe(true);
    expect(res.headers.get("set-cookie") ?? "").toContain("rag_user=");
  });

  test("documents list attaches a guest session instead of 401", async () => {
    const res = await get("/documents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("single document lookup returns 404 for unknown uuid (no existence leak)", async () => {
    const res = await get(`/document/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  test("conversation list and clear succeed with automatic guest session", async () => {
    expect((await get("/conversations")).status).toBe(200);
    expect((await get("/conversations", { method: "DELETE" })).status).toBe(200);
    expect((await get(`/conversations/${randomUUID()}`, { method: "DELETE" })).status).toBe(404);
  });

  test("forged session cookie falls back to a fresh guest session (signature check)", async () => {
    const forgedId = randomUUID();
    const res = await get("/auth/me", {
      headers: { Cookie: `rag_user=${forgedId}.forged-signature` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string };
    expect(body.id).toBeTruthy();
    expect(body.id).not.toBe(forgedId);
  });

  test("legacy Google OAuth endpoints return 404", async () => {
    expect((await get("/auth/google")).status).toBe(404);
    expect((await get(`/auth/google/callback?code=fake&state=${randomUUID()}`)).status).toBe(404);
  });
});
