import { FastifyReply } from "fastify";

export function setupSSE(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
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