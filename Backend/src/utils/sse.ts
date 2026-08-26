import type { FastifyReply } from "fastify";
import { env } from "../config/env";

const ALLOWED_ORIGINS = env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);

export function setupSSE(reply: FastifyReply) {
  const origin = reply.request.headers.origin;
  let allowedOrigin: string | undefined = undefined;

  if (origin) {
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
      allowedOrigin = origin;
    }
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" } : {}),
  });

  reply.raw.flushHeaders?.();
}

export function sendSSE(reply: FastifyReply, data: unknown) {
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function sendSSEDone(reply: FastifyReply) {
  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
}
