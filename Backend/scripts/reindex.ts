/**
 * Re-index every document through the SAME pipeline used at upload time
 * (processDocument: download → extract → chunk → enrich → embed → store).
 *
 * Use after any change to chunking/enrichment/embedding so the vector DB
 * always matches the current code — e.g. the Owner: prefix enrichment.
 *
 *   bun run reindex
 *   bun scripts/reindex.ts
 *   bun scripts/reindex.ts --failed
 */
import prisma from "../src/config/prisma";
import { processDocument } from "../src/modules/upload/processor";

async function main() {
  const failedOnly = process.argv.includes("--failed");
  // READY = has chunks (re-index them); FAILED = retry the failed index.
  // PROCESSING is skipped — another job may be mid-flight on it.
  const docs = await prisma.document.findMany({
    where: { status: failedOnly ? "FAILED" : { in: ["READY", "FAILED"] } },
    select: { id: true, fileKey: true, filename: true, status: true },
    orderBy: { createdAt: "asc" },
  });

  if (docs.length === 0) {
    console.log("No documents to re-index.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Re-indexing ${docs.length} documents…`);
  let ok = 0;

  for (const doc of docs) {
    console.log(`\n[reindex] ${doc.filename} (${doc.id}) — status=${doc.status}`);
    try {
      await processDocument(doc.id, doc.fileKey);
      ok++;
    } catch (err) {
      // processDocument already marks the doc FAILED; keep going so one bad
      // document never blocks the whole re-index.
      console.error(`[reindex] FAILED ${doc.filename}:`, err);
    }
  }

  console.log(`\nDone: ${ok}/${docs.length} documents re-indexed.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Reindex aborted:", err);
  await prisma.$disconnect();
  process.exit(1);
});
