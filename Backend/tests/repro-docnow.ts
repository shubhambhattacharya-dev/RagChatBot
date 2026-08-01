// Repro: exact chat-path retrieval for the failing E2E question.
// Mirrors src/modules/chat/routes.ts handleChat() — same embedding task type,
// same SQL, same TOP_K, same MAX_DISTANCE gate — then prints the FULL content
// of every chunk that would reach the LLM.
import prisma from "../src/config/prisma";
import { embedText } from "../src/provider/embedding/gemini";

const TOP_K = 8;
const MAX_DISTANCE = 0.5;

const question = "Who built DocNow?";

const embedding = await embedText(question, "RETRIEVAL_QUERY");
const vector = `[${embedding.join(",")}]`;

const rows = await prisma.$queryRaw<{ content: string; filename: string; distance: number }[]>`
  SELECT c.content, d.filename, c.embedding <=> ${vector}::vector AS distance
  FROM "Chunk" c
  JOIN "Document" d ON d.id = c."documentId"
  WHERE d.status = 'READY'
  ORDER BY c.embedding <=> ${vector}::vector
  LIMIT ${TOP_K}
`;

console.log(`Q: "${question}"`);
console.log("=".repeat(80));
rows.forEach((row, i) => {
  const pass = Number(row.distance) <= MAX_DISTANCE;
  console.log(`#${i + 1} d=${Number(row.distance).toFixed(4)} gate=${pass ? "PASS" : "FAIL"} | ${row.filename}`);
  console.log(`   ${row.content.slice(0, 300).replace(/\n/g, " ⏎ ")}`);
  console.log(`   [contains "DocNow"=${row.content.includes("DocNow")} "Shubham Bhattacharya"=${row.content.includes("Shubham Bhattacharya")} "Owner:"=${row.content.includes("Owner:")}]`);
});

const relevant = rows.filter((r) => Number(r.distance) <= MAX_DISTANCE);
console.log("=".repeat(80));
console.log(`Gate result: ${relevant.length}/${rows.length} chunks pass (≤ ${MAX_DISTANCE})`);
console.log(`→ chat path would ${relevant.length === 0 ? "REFUSE at route (no LLM call)" : "call LLM with " + relevant.length + " chunks"}`);
await prisma.$disconnect();
