import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

import prisma from "../../config/prisma";
import { env, isGoogleOAuthConfigured } from "../../config/env";
import logger from "../../logger";
import {
  buildGoogleAuthUrl,
  exchangeCodeForToken,
  fetchGoogleProfile,
  isStateValid,
} from "./google";

export const USER_COOKIE = "rag_user";
export const OAUTH_STATE_COOKIE = "rag_oauth_state";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const STATE_MAX_AGE_SECONDS = 600; // 10 minutes to finish the Google round-trip

const USER_COOKIE_OPTIONS = {
  signed: true,
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_MAX_AGE_SECONDS,
} as const;

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
};

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

/** PreHandler guard: attaches request.user or rejects with 401. */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionUser = await readSessionUser(request);
  if (!sessionUser) {
    reply.clearCookie(USER_COOKIE, { path: "/" });
    return reply.status(401).send({ message: "Sign in with Google to continue" });
  }
  request.user = sessionUser;
}

async function readSessionUser(request: FastifyRequest): Promise<SessionUser | null> {
  const unsigned = request.unsignCookie(request.cookies[USER_COOKIE] || "");
  if (!unsigned.valid || !unsigned.value) return null;

  const user = await prisma.user.findUnique({
    where: { id: unsigned.value },
    select: { id: true, email: true, name: true, picture: true },
  });
  return user ?? null;
}

function callbackUri(request: FastifyRequest): string {
  // Render terminates TLS at its proxy, but the app may see the proxy-to-app
  // connection as HTTP. Google requires the public HTTPS callback URI.
  const protocol = env.NODE_ENV === "production" ? "https" : request.protocol;
  return `${protocol}://${request.headers.host}/auth/google/callback`;
}

function setOAuthState(reply: FastifyReply, state: string): void {
  reply.setCookie(OAUTH_STATE_COOKIE, state, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: STATE_MAX_AGE_SECONDS,
  });
}

function readOAuthState(request: FastifyRequest): string | undefined {
  const unsigned = request.unsignCookie(request.cookies[OAUTH_STATE_COOKIE] || "");
  return unsigned.valid ? unsigned.value : undefined;
}

export async function authRoutes(app: FastifyInstance) {
  app.get("/auth/google", async (request, reply) => {
    if (!isGoogleOAuthConfigured()) {
      return reply.status(503).send({
        message: "Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      });
    }
    const state = randomUUID();
    setOAuthState(reply, state);
    return reply.redirect(
      buildGoogleAuthUrl({
        clientId: env.GOOGLE_CLIENT_ID,
        redirectUri: callbackUri(request),
        state,
      })
    );
  });

  app.get("/auth/google/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };

    if (query.error) {
      logger.warn({ error: query.error }, "Google OAuth was cancelled by the user");
      return reply.redirect("/?auth=cancelled");
    }

    if (!isStateValid(readOAuthState(request), query.state)) {
      logger.warn("Google OAuth state mismatch — possible CSRF attempt");
      return reply.redirect("/?auth=invalid_state");
    }

    if (!query.code) {
      return reply.redirect("/?auth=missing_code");
    }

    try {
      const accessToken = await exchangeCodeForToken(query.code, callbackUri(request));
      const profile = await fetchGoogleProfile(accessToken);

      const user = await prisma.user.upsert({
        where: { googleId: profile.googleId },
        create: profile,
        update: { email: profile.email, name: profile.name, picture: profile.picture },
        select: { id: true },
      });

      reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });
      reply.setCookie(USER_COOKIE, user.id, USER_COOKIE_OPTIONS);
      return reply.redirect("/");
    } catch (error) {
      logger.error({ err: error }, "Google OAuth callback failed");
      return reply.redirect("/?auth=failed");
    }
  });

  app.get("/auth/me", async (request, reply) => {
    const sessionUser = await readSessionUser(request);
    if (!sessionUser) return reply.status(401).send({ message: "Not signed in" });
    return reply.send(sessionUser);
  });

  app.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie(USER_COOKIE, { path: "/" });
    return reply.send({ message: "Signed out" });
  });
}
