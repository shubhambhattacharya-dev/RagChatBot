import { FastifyReply } from "fastify";

export function setupSSE(reply: FastifyReply) {
  const origin = reply.request.headers.origin;

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Keep CORS headers — writeHead replaces the whole header set,
    // so re-add what @fastify/cors would have set.
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
  });

  reply.raw.flushHeaders?.();
}

export function sendSSE(
  reply: FastifyReply,
  data: unknown
) {
  reply.raw.write(
    `data: ${JSON.stringify(data)}\n\n`
  );
}

export function sendSSEDone(reply: FastifyReply) {
  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
}