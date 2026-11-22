import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

import prisma from "../../config/prisma";
import { env } from "../../config/env";
import logger from "../../logger";

export const USER_COOKIE = "rag_user";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export const USER_COOKIE_OPTIONS = {
  signed: true,
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_MAX_AGE_SECONDS,
} as const;

export type SessionUser = {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  isGuest?: boolean;
};

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export async function readSessionUser(request: FastifyRequest): Promise<SessionUser | null> {
  const unsigned = request.unsignCookie(request.cookies[USER_COOKIE] || "");
  if (!unsigned.valid || !unsigned.value) return null;

  const isUuid = /^[0-9a-fA-F-]{36}$/.test(unsigned.value);

  try {
    const user = await prisma.user.findUnique({
      where: { id: unsigned.value },
      select: { id: true, email: true, name: true, picture: true, isGuest: true },
    });
    if (user) return user;

    // Signed cookie is valid but the User row is missing in Postgres (e.g. DB was
    // reset, or initial guest creation happened during a cold-start blip).
    // Upsert the guest row now so FK constraints on Document.ownerId and
    // Conversation.userId never fail with P2003 (HTTP 500) during /upload or /chat.
    if (isUuid) {
      const guestId = unsigned.value;
      return await prisma.user.upsert({
        where: { id: guestId },
        update: {},
        create: {
          id: guestId,
          googleId: `guest_${guestId}`,
          name: "Guest Sandbox",
          email: `guest_${guestId}@sandbox.local`,
          isGuest: true,
        },
        select: { id: true, email: true, name: true, picture: true, isGuest: true },
      });
    }
  } catch (err) {
    logger.warn({ err }, "Database lookup/upsert for session user failed; falling back to ephemeral guest session");
  }

  // If signed cookie value looks like a valid uuid, construct a fallback session user
  if (isUuid) {
    return {
      id: unsigned.value,
      name: "Guest Sandbox",
      email: `guest_${unsigned.value}@sandbox.local`,
      picture: null,
      isGuest: true,
    };
  }
  return null;
}

/** PreHandler guard: ensures every visitor has a guest/sandbox session user attached. */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await getOrCreateGuestUser(request, reply);
  request.user = user;
}

export async function getOrCreateGuestUser(request: FastifyRequest, reply: FastifyReply): Promise<SessionUser> {
  const existing = await readSessionUser(request);
  if (existing) {
    return existing;
  }

  const guestId = randomUUID();
  let guestUser: SessionUser = {
    id: guestId,
    name: "Guest Sandbox",
    email: `guest_${guestId}@sandbox.local`,
    picture: null,
    isGuest: true,
  };

  try {
    const created = await prisma.user.create({
      data: {
        id: guestId,
        googleId: `guest_${guestId}`,
        name: guestUser.name,
        email: guestUser.email,
        isGuest: true,
      },
      select: { id: true, email: true, name: true, picture: true, isGuest: true },
    });
    guestUser = created;
  } catch (err) {
    logger.warn({ err }, "Could not persist guest user to DB; proceeding with signed session cookie");
  }

  reply.setCookie(USER_COOKIE, guestUser.id, USER_COOKIE_OPTIONS);
  return guestUser;
}

export async function authRoutes(app: FastifyInstance) {
  // Returns current guest session details; automatically initializes one if new visitor
  app.get("/auth/me", async (request, reply) => {
    const user = await getOrCreateGuestUser(request, reply);
    return reply.send(user);
  });

  // Resets the guest sandbox session: clears cookie and initializes fresh state
  app.post("/auth/reset", async (_request, reply) => {
    reply.clearCookie(USER_COOKIE, { path: "/" });
    return reply.send({ message: "Guest session reset" });
  });

  app.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie(USER_COOKIE, { path: "/" });
    return reply.send({ message: "Guest session reset" });
  });
}
