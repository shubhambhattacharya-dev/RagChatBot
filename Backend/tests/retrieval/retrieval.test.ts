import { describe, expect, test } from "bun:test";
import prisma from "../../src/config/prisma";
import { embedText } from "../../src/provider/embedding/gemini";

const TOP_K = 8;
const describeLive = process.env.RUN_LIVE_RETRIEVAL_TESTS === "1" ? describe : describe.skip;

type SearchResult = {
  content: string;
  filename: string;
  distance: number;
};

// Expanded query matching the production expandQuery helper in routes.ts
function expandQuery(question: string): string {
  const q = question.trim().toLowerCase();
  if (/^(author|authors|author name|author names|writer|creators)$/i.test(q)) {
    return "Who are the authors or creators of this document? List all author names.";
  }
  if (/^(human name|names|people|person)$/i.test(q)) {
    return "What are the names of the people or authors mentioned in this document?";
  }
  if (/\b(author|authors|written by|creator)\b/.test(q)) {
    return `${question} author names written by creators`;
  }
  if (/\b(email|e-mail|mail|gmail)\b/.test(q)) {
    return `${question} email address contact gmail mail`;
  }
  if (/\b(phone|mobile|number|contact no)\b/.test(q)) {
    return `${question} phone number mobile contact`;
  }
  if (/\b(website|url|site|web)\b/.test(q)) {
    return `${question} website url web link`;
  }
  return question;
}

const TEST_CASES = [
  // --- attention.pdf ---
  {
    name: "Attention PDF - Authors Query (Full)",
    question: "Who are the authors of Attention Is All You Need?",
    expected: "Ashish Vaswani",
    file: "attention",
  },
  {
    name: "Attention PDF - Author Keyword (Single Word)",
    question: "author",
    expected: "Ashish Vaswani",
    file: "attention",
  },
  {
    name: "Attention PDF - Optimizer",
    question: "What optimizer is used?",
    expected: "Adam",
    file: "attention",
  },
  {
    name: "Attention PDF - Attention Heads",
    question: "How many attention heads?",
    expected: "h = 8",
    file: "attention",
  },
  {
    name: "Attention PDF - Positional Encoding",
    question: "What is positional encoding?",
    expected: "positional encodings",
    file: "attention",
  },

  // --- shubham.pdf ---
  {
    name: "Shubham PDF - Email",
    question: "What is Shubham's email?",
    expected: "shubhambhattacharya107@gmail.com",
    file: "shubham",
  },
  {
    name: "Shubham PDF - Projects (DocNow)",
    question: "Who built DocNow?",
    expected: "DocNow",
    file: "shubham",
  },
  {
    name: "Shubham PDF - Tech Stack",
    question: "What languages does Shubham use?",
    expected: "TypeScript",
    file: "shubham",
  },

  // --- manish.pdf ---
  {
    name: "Manish PDF - Website",
    question: "What is Manish's website?",
    expected: "manishbhattacharya.com",
    file: "manish",
  },
  {
    name: "Manish PDF - Email",
    question: "What is Manish's email?",
    expected: "bhattacharya.manish8@gmail.com",
    file: "manish",
  },
  {
    name: "Manish PDF - Work Experience",
    question: "Where did Manish work?",
    expected: "SynapseFi",
    file: "manish",
  },
];

async function retrieve(question: string): Promise<SearchResult[]> {
  const expanded = expandQuery(question);
  const embedding = await embedText(expanded, "RETRIEVAL_QUERY");
  const vector = `[${embedding.join(",")}]`;

  return prisma.$queryRaw<SearchResult[]>`
    SELECT
      c.content,
      d.filename,
      c.embedding <=> ${vector}::vector AS distance
    FROM "Chunk" c
    JOIN "Document" d
      ON d.id = c."documentId"
    WHERE d.status='READY'
    ORDER BY c.embedding <=> ${vector}::vector
    LIMIT ${TOP_K}
  `;
}

function printResults(question: string, rows: SearchResult[]) {
  console.log("\n==================================================");
  console.log(`QUERY: "${question}" (Expanded: "${expandQuery(question)}")`);
  console.log("==================================================");

  console.table(
    rows.map((r, i) => ({
      Rank: i + 1,
      Similarity: (1 - r.distance).toFixed(3),
      Distance: r.distance.toFixed(3),
      File: r.filename,
      Preview: r.content.replace(/\n/g, " ").slice(0, 90),
    }))
  );
}

describeLive("RAG Retrieval Quality across 3 Documents (attention.pdf, shubham.pdf, manish.pdf)", () => {
  for (const tc of TEST_CASES) {
    test(
      tc.name,
      async () => {
        // 1.5s rate limit spacing for free-tier embedding API
        await new Promise((r) => setTimeout(r, 1500));

        const rows = await retrieve(tc.question);

        printResults(tc.question, rows);

        expect(rows.length).toBeGreaterThan(0);

        // Expected answer must exist in Top-K
        const match = rows.find((r) => r.content.includes(tc.expected));

        expect(match).toBeDefined();

        // Should come from expected document
        expect(match!.filename.toLowerCase()).toContain(tc.file);

        // Calculate rank
        const rank = rows.findIndex((r) => r.content.includes(tc.expected)) + 1;

        console.log(`✅ Found at Rank ${rank}`);

        // Expect answer within Top 3
        expect(rank).toBeLessThanOrEqual(3);

        // Cosine distance should be within acceptable threshold (<= 0.5)
        expect(match!.distance).toBeLessThan(0.5);
      },
      { timeout: 30000 }
    );
  }
});
