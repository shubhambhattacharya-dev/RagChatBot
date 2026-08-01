// Prove the fix: with CURRENT enrichChunks, does the DocNow chunk of
// shubham.pdf carry "Shubham Bhattacharya" in the SAME chunk?
import { chunkText, enrichChunks } from "../src/utils/chunking";
import { extractText } from "../src/services/document/extract";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const buffer = readFileSync(join(import.meta.dir, "fixtures", "shubham.pdf"));
const text = await extractText(buffer, "application/pdf", "shubham.pdf");
const chunks = enrichChunks(chunkText(text), "shubham.pdf");

const docnow = chunks.find((c) => c.content.includes("DocNow"));
console.log(`chunks: ${chunks.length}`);
console.log(`DocNow chunk found: ${!!docnow}`);
console.log(`has "Owner: Shubham Bhattacharya": ${docnow?.content.includes("Owner: Shubham Bhattacharya")}`);
console.log(`has "Shubham Bhattacharya" anywhere: ${docnow?.content.includes("Shubham Bhattacharya")}`);
console.log("---");
console.log(docnow?.content.slice(0, 400));
