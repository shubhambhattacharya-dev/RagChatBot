import { Prisma } from "../../../generated/prisma/client.ts";

export type SearchResult = {
  content: string;
  filename: string;
  distance: number;
  relevance?: number;
};

export const TOP_K = 8;
export const MAX_DISTANCE = 0.5;
export const MIN_LEXICAL_RELEVANCE = 0.1;
export const MIN_OWNER_RELEVANCE = 0.5;

const LEXICAL_STOP_WORDS = new Set([
  "a", "an", "and", "are", "for", "from", "in", "is", "me", "of", "on", "or",
  "the", "this", "to", "with",
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

const PERSON_RE = /^(?:who\s+is|(?:information|info)\s+about|tell\s+me\s+about)\s+(.+?)(?:\s*[?!.,]+)?$/i;

const NAME_STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "out", "off",
  "over", "under", "again", "further", "then", "once", "here", "there",
  "when", "where", "why", "how", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not", "only",
  "own", "same", "so", "than", "too", "very", "just", "because", "but",
  "and", "or", "if", "while", "although", "though", "even", "that", "this",
  "these", "those", "what", "which", "who", "whom", "whose", "best",
  "engineer", "about", "list", "tell", "information", "info", "my", "your",
  "his", "her", "its", "our", "their", "me", "him", "us", "them",
]);

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

const NAME_TITLES = new Set(["mr", "mrs", "ms", "dr", "prof", "sr", "jr"]);

export function getPersonLookupTerm(question: string): string | null {
  const match = question.trim().match(PERSON_RE);
  if (!match) return null;
  const name = match[1]?.trim().toLowerCase();
  if (!name) return null;
  if (name.length < 3) return null;
  let words = name.split(/\s+/);
  while (words.length > 0 && NAME_TITLES.has(words[0]!.replace(/[.,]/g, ""))) {
    words = words.slice(1);
  }
  if (words.length === 0 || words.length > 5) return null;
  const rejoined = words.join(" ");
  if (words.some((w) => NAME_STOP_WORDS.has(w.replace(/[.,]/g, "")))) return null;
  if (!/^[a-z]/.test(rejoined)) return null;
  if (words.some((w) => /\d/.test(w))) return null;
  return rejoined;
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
  const scores = new Map<string, { row: SearchResult; score: number; sourceWeight: number }>();

  const addRanked = (rows: SearchResult[], weight: number) => {
    rows.forEach((row, rank) => {
      const key = `${row.filename}\u0000${row.content}`;
      const rrfScore = weight * (1 / (K + rank + 1));
      const existing = scores.get(key);
      if (existing) {
        existing.score += rrfScore;
        existing.sourceWeight = Math.max(existing.sourceWeight, weight);
        if (existing.sourceWeight === weight && row.distance < existing.row.distance) {
          existing.row = row;
        }
      } else {
        scores.set(key, { row, score: rrfScore, sourceWeight: weight });
      }
    });
  };

  const filteredExact = exactRows.filter(
    (r) => (r.relevance ?? 1.0) >= MIN_OWNER_RELEVANCE
  );
  if (filteredExact.length > 0) addRanked(filteredExact, 3.0);

  const filteredLexical = lexicalRows.filter(
    (r) => (r.relevance ?? 1.0) >= MIN_LEXICAL_RELEVANCE
  );
  if (filteredLexical.length > 0) addRanked(filteredLexical, 1.5);

  const filteredVector = vectorRows.filter((r) => r.distance <= MAX_DISTANCE);
  if (filteredVector.length > 0) addRanked(filteredVector, 1.0);

  const results = [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.row);

  if (results.length === 0 && vectorRows.length > 0) {
    return vectorRows
      .filter((r) => r.distance <= MAX_DISTANCE)
      .slice(0, maxResults);
  }

  return results;
}
