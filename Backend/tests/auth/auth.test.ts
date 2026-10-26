import { describe, expect, test } from "vitest";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  authRoutes,
  requireUser,
  USER_COOKIE,
  USER_COOKIE_OPTIONS,
} from "../../src/modules/auth/routes";

const TEST_SECRET = "super-secret-test-session-key-at-least-32-chars";

async function buildTestApp() {
  const app = fastify();
  await app.register(cookie, { secret: TEST_SECRET });
  await app.register(authRoutes);

  // A protected sandbox route to verify requireUser behavior
  app.get("/test/protected", { preHandler: requireUser }, async (request) => {
    return { user: request.user };
  });

  await app.ready();
  return app;
}

describe("Open Sandbox / Guest Session Authentication", () => {
  test("new visitor calling /auth/me automatically gets a guest session and cookie", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.name).toBe("Guest Sandbox");
    expect(body.isGuest).toBe(true);

    const cookies = res.cookies;
    const sessionCookie = cookies.find((c) => c.name === USER_COOKIE);
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.value).toBeDefined();
    await app.close();
  });

  test("protected routes never reject visitors with 401 and seamlessly attach guest user", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/test/protected",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user).toBeDefined();
    expect(body.user.id).toBeDefined();
    expect(body.user.isGuest).toBe(true);
    await app.close();
  });

  test("returning visitor with signed session cookie preserves their identity", async () => {
    const app = await buildTestApp();
    // First request
    const firstRes = await app.inject({
      method: "GET",
      url: "/auth/me",
    });
    const firstUser = JSON.parse(firstRes.body);
    const sessionCookie = firstRes.cookies.find((c) => c.name === USER_COOKIE);
    expect(sessionCookie).toBeDefined();

    // Subsequent request with the same signed cookie
    const secondRes = await app.inject({
      method: "GET",
      url: "/test/protected",
      cookies: {
        [USER_COOKIE]: sessionCookie!.value,
      },
    });

    expect(secondRes.statusCode).toBe(200);
    const secondUser = JSON.parse(secondRes.body).user;
    expect(secondUser.id).toBe(firstUser.id);
    await app.close();
  });

  test("POST /auth/logout and /auth/reset clear the session cookie", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
    });

    expect(res.statusCode).toBe(200);
    const cleared = res.cookies.find((c) => c.name === USER_COOKIE);
    expect(cleared?.value).toBe("");
    await app.close();
  });

  test("Google OAuth routes (/auth/google and /auth/google/callback) are completely removed (404)", async () => {
    const app = await buildTestApp();
    const resGoogle = await app.inject({
      method: "GET",
      url: "/auth/google",
    });
    expect(resGoogle.statusCode).toBe(404);

    const resCallback = await app.inject({
      method: "GET",
      url: "/auth/google/callback",
    });
    expect(resCallback.statusCode).toBe(404);
    await app.close();
  });

  test("google.ts file has been completely removed from source tree", () => {
    const googlePath = resolve(__dirname, "../../src/modules/auth/google.ts");
    expect(existsSync(googlePath)).toBe(false);
  });
});
