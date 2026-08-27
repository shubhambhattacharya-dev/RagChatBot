import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { env } from "./config/env";

export const SESSION_COOKIE = "rag_session";

export function getSessionId(request: FastifyRequest, reply: FastifyReply): string {
  const existing = request.unsignCookie(request.cookies[SESSION_COOKIE] || "");
  if (existing.valid && existing.value) return existing.value;

  const id = randomUUID();
  reply.setCookie(SESSION_COOKIE, id, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return id;
}
