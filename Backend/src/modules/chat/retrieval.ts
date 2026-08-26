import { Prisma } from "../../../generated/prisma/client.ts";

export type SearchResult = {
  content: string;
  filename: string;
  distance: number;
};

export const TOP_K = 8;
export const MAX_DISTANCE = 0.5;

const LEXICAL_STOP_WORDS = new Set([
  "a", "an", "and", "are", "document", "for", "from", "in", "is", "list",
  "me", "of", "on", "or", "the", "this", "to", "what", "who", "with",
]);

type ExpansionRule = {
  exact?: RegExp;
  word?: RegExp;
  expand: string | ((q: string, m?: RegExpMatchArray | null) => string);
};

const EXPANSION_RULES: ExpansionRule[] = [
  { exact: /^(information|info|resume info|tell me more|details)$/i, expand: (q) => `${q}: professional summary, experience, skills, projects, and contact information.` },
  { exact: /^(author|authors|author name|author names|writer|creators)$/i, expand: "Who are the authors or creators of this document? List all author names." },
  { word: /\b(author|authors|written by|creator|creators)\b/, expand: (q) => `${q} author names written by creators` },
  { exact: /^(contact|contact info|contact details|reach out)$/i, expand: "What is the contact information, email address, phone number, or website listed in this document?" },
  { word: /\b(contact|email|e-mail|mail|gmail)\b/, expand: (q) => `${q} email address contact details gmail mail phone` },
  { word: /\b(phone|mobile|number|contact no|telephone)\b/, expand: (q) => `${q} phone number mobile contact details` },
  { word: /\b(website|url|site|web|link)\b/, expand: (q) => `${q} website url web link homepage github profile` },
  { exact: /^(project|projects|portfolio|work samples)$/i, expand: "What projects, portfolio work, publications, hackathons, or bug bounties are listed in this document?" },
  { word: /\b(project|projects|portfolio)\b/, expand: (q) => `${q} projects portfolio publications hackathons bug bounties` },
  { exact: /^(human name|names|people|person|name)$/i, expand: "What are the names of the people or authors mentioned in this document?" },
];

const PERSON_RE = /^(?:who\s+is|(?:information|info)\s+about|tell\s+me\s+about)\s+([a-z][a-z'-]{2,})(?:\s*[?!.])?$/i;

export function expandQuery(question: string): string {
  const q = question.trim().toLowerCase();

  const person = getPersonLookupTerm(question);
  if (person) {
    return `${question}. Tell me about ${person}: professional summary, role, skills, work experience, projects, contact details, and resume profile.`;
  }

  for (const rule of EXPANSION_RULES) {
    if (rule.exact && rule.exact.test(q)) {
      return typeof rule.expand === "function" ? rule.expand(question) : rule.expand;
    }
    if (rule.word && rule.word.test(q)) {
      return typeof rule.expand === "function" ? rule.expand(question) : rule.expand;
    }
  }

  return question;
}

export function getPersonLookupTerm(question: string): string | null {
  return question.trim().match(PERSON_RE)?.[1]?.toLowerCase() ?? null;
}

export function buildLexicalTsQuery(question: string): string | null {
  const terms = [
    ...new Set(
      question
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g)
        ?.filter((term) => !LEXICAL_STOP_WORDS.has(term)) ?? []
    ),
  ];
  return terms.length > 0 ? terms.map((t) => `${t}:*`).join(" | ") : null;
}

export function buildDocFilter(documentId?: string): Prisma.Sql {
  return documentId
    ? Prisma.sql`c."documentId" = ${documentId} AND d.status = 'READY'`
    : Prisma.sql`d.status = 'READY'`;
}

export function mergeRetrievalResults(
  exactRows: SearchResult[],
  lexicalRows: SearchResult[],
  vectorRows: SearchResult[],
  maxResults = TOP_K
): SearchResult[] {
  const K = 60;
  const scores = new Map<string, { row: SearchResult; score: number }>();

  const addRanked = (rows: SearchResult[], weight: number) => {
    rows.forEach((row, rank) => {
      const key = `${row.filename}\u0000${row.content}`;
      const rrfScore = weight * (1 / (K + rank + 1));
      const existing = scores.get(key);
      if (existing) {
        existing.score += rrfScore;
        if (row.distance < existing.row.distance) existing.row = row;
      } else {
        scores.set(key, { row, score: rrfScore });
      }
    });
  };

  if (exactRows.length > 0) addRanked(exactRows, 3.0);
  if (lexicalRows.length > 0) addRanked(lexicalRows, 1.5);

  const filteredVector = exactRows.length > 0
    ? []
    : vectorRows.filter((r) => r.distance <= MAX_DISTANCE);
  if (filteredVector.length > 0) addRanked(filteredVector, 1.0);

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.row);
}
