/**
 * RagChatBot Evaluation Harness
 * --------------------------------
 * Runs the golden test set against the LIVE API and produces RAG quality
 * metrics: answer correctness, groundedness (refusal correctness), source
 * attribution, per-request latency, plus LLM-as-judge faithfulness and
 * answer relevance (RAGAS-style, when GROQ_API is configured).
 *
 * /chat requires a signed-in session, so pass the signed session cookie:
 *
 *   API_BASE=https://ragchatbot-61jh.onrender.com \
 *   EVAL_COOKIE="rag_user=<value>.<signature>" \
 *   bun tests/eval/run-eval.ts
 *
 * Output: tests/eval/results/eval-<date>.json + printed metrics table.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.API_BASE ?? "http://localhost:3000";
const EVAL_COOKIE = process.env.EVAL_COOKIE ?? "";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "openai/gpt-oss-120b";
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 90_000);

interface GoldenCase {
  id: string;
  category: string;
  question: string;
  documentId: string | null;
  expected_answer_terms: string[];
  expected_source?: string | null;
  expected_refusal?: boolean;
  notes?: string;
}

interface CaseResult {
  id: string;
  category: string;
  question: string;
  status: "pass" | "fail";
  latency_ms: number;
  latency_breakdown_ms: { ttfb: number; total: number };
  answer_snippet: string;
  refused: boolean;
  expected_refusal: boolean;
  sources: string[];
  source_correct: boolean | null;
  context_chunks_count: number;
  faithfulness: number | null;
  answer_relevance: number | null;
  judge_reason: string | null;
  terms_hit: string[];
  terms_missed: string[];
  error?: string;
}

// ---------- SSE client (mirrors Frontend/app.js parsing) ----------
async function chatOnce(question: string, documentId?: string) {
  const t0 = Date.now();
  const url = new URL(`${BASE}/chat`);
  url.searchParams.set("question", question);
  if (documentId) url.searchParams.set("documentId", documentId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let ttfb = 0;

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: EVAL_COOKIE ? { Cookie: EVAL_COOKIE } : {},
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}${res.status === 401 ? " — is EVAL_COOKIE set?" : ""}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let tokens = "";
    let refusal = false;
    const sources: string[] = [];
    const contextChunks: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ttfb) ttfb = Date.now() - t0;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "token") tokens += evt.content;
          if (evt.type === "sources") {
            sources.push(...(evt.documents ?? []));
            if (Array.isArray(evt.chunks)) contextChunks.push(...evt.chunks);
          }
        } catch {
          /* keep-alive or malformed — ignore */
        }
      }
    }

    const lowered = tokens.toLowerCase();
    // Refusals can come from two places: the empty-context branch (no chunks
    // passed the gate) OR the LLM prompt instructing it to decline when
    // evidence is weak. Both are valid grounded refusals.
    if (
      lowered.includes("couldn't find relevant information") ||
      lowered.includes("could not find relevant information") ||
      lowered.includes("couldn't find this in the documents") ||
      lowered.includes("could not find this in the documents") ||
      lowered.includes("don't have information") ||
      lowered.includes("not covered by") ||
      lowered.includes("uploaded documents do not")
    ) {
      refusal = true;
    }
    return { tokens, sources, contextChunks, refusal, ttfb, total: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Scoring ----------
/** Normalize text for term matching: strip diacritics/unicode punctuation so
 * "self‑attention" (non-ASCII hyphen) matches "self-attention". */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u2010-\u2015\u2212]/g, "-") // unicode hyphens → ascii
    .replace(/[^\p{L}\p{N}@.\-+ ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreAnswer(answer: string, terms: string[]) {
  const normalized = normalize(answer);
  const hit = terms.filter((t) => normalized.includes(normalize(t)));
  return { hit, missed: terms.filter((t) => !hit.includes(t)) };
}

// ---------- LLM-as-judge (RAGAS-style faithfulness + relevance) ----------
export interface JudgeVerdict {
  faithful: number | null;
  relevant: number | null;
  reason: string | null;
}

const JUDGE_SYSTEM_PROMPT = `You are a strict evaluation judge for a Retrieval-Augmented Generation system.
You receive: (1) the user's question, (2) the retrieved document context the
answer was generated from, and (3) the assistant's answer.

Score two properties:
- "faithful": true if EVERY factual claim in the answer is directly supported
  by the retrieved context. Any claim that is absent from, contradicted by, or
  extrapolated beyond the context makes it false.
- "relevant": true if the answer actually addresses what the user asked.

Reply with ONLY a JSON object, no markdown:
{"faithful": <true|false>, "relevant": <true|false>, "reason": "<one short sentence>"}`;

export async function judgeAnswer(
  question: string,
  contextChunks: string[],
  answer: string
): Promise<JudgeVerdict> {
  if (!process.env.GROQ_API || contextChunks.length === 0) {
    return { faithful: null, relevant: null, reason: null };
  }

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.GROQ_API, baseURL: "https://api.groq.com/openai/v1" });
    const completion = await client.chat.completions.create({
      model: JUDGE_MODEL,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `QUESTION: ${question}\n\nCONTEXT:\n${contextChunks.map((c, i) => `[${i + 1}] ${c}`).join("\n\n").slice(0, 12_000)}\n\nANSWER: ${answer.slice(0, 2_000)}`,
        },
      ],
    });

    const raw = completion.choices.at(0)?.message?.content ?? "";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
    return {
      faithful: typeof parsed.faithful === "boolean" ? (parsed.faithful ? 1 : 0) : null,
      relevant: typeof parsed.relevant === "boolean" ? (parsed.relevant ? 1 : 0) : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
    };
  } catch (e: any) {
    console.log(`\n     ⚠️  judge unavailable: ${String(e?.message ?? e).slice(0, 80)}`);
    return { faithful: null, relevant: null, reason: null };
  }
}

// ---------- Main ----------
async function main() {
  const goldenPath = join(import.meta.dir, "golden_test_set.json");
  const cases: GoldenCase[] = JSON.parse(readFileSync(goldenPath, "utf-8"));

  console.log(`\n🧪 RagChatBot Eval Harness — ${cases.length} golden cases`);
  console.log(`   Target: ${BASE}\n`);

  // Warm the dyno first (Render free tier sleeps)
  console.log("☀️  Warming deployment (Render free tier)…");
  const warm = await fetch(`${BASE}/health`).catch(() => null);
  console.log(`   Health: ${warm?.status === 200 ? "ok" : "FAILED — check API_BASE"}\n`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    process.stdout.write(`  ${c.id} [${c.category}] … `);
    try {
      const r = await chatOnce(c.question, c.documentId ?? undefined);
      const terms = scoreAnswer(r.tokens, c.expected_answer_terms);
      const refused = r.refusal;
      const expectedRefusal = Boolean(c.expected_refusal);

      let pass: boolean;
      if (expectedRefusal) {
        pass = refused; // must refuse out-of-corpus questions
      } else {
        pass = !refused && terms.hit.length > 0; // must answer with expected evidence
      }

      let sourceCorrect: boolean | null = null;
      if (c.expected_source) {
        sourceCorrect = r.sources.some((s) => s.toLowerCase().includes(c.expected_source!.toLowerCase()));
      }

      const judge = refused
        ? ({ faithful: 1, relevant: 1, reason: "grounded refusal" } as JudgeVerdict) // refusing without evidence IS the desired behavior
        : await judgeAnswer(c.question, r.contextChunks, r.tokens);

      results.push({
        id: c.id,
        category: c.category,
        question: c.question,
        status: pass ? "pass" : "fail",
        latency_ms: r.total,
        latency_breakdown_ms: { ttfb: r.ttfb, total: r.total },
        answer_snippet: r.tokens.slice(0, 160),
        refused,
        expected_refusal: expectedRefusal,
        sources: r.sources,
        source_correct: sourceCorrect,
        context_chunks_count: r.contextChunks.length,
        faithfulness: judge.faithful,
        answer_relevance: judge.relevant,
        judge_reason: judge.reason,
        terms_hit: terms.hit,
        terms_missed: terms.missed,
      });
      const judgeTag = judge.faithful === null ? "" : judge.faithful === 1 ? " | faithful" : " | UNFAITHFUL";
      console.log(`${pass ? "✅ PASS" : "❌ FAIL"}  ${r.total}ms  ${refused ? "(refused)" : terms.hit.join(",")}${judgeTag}`);
    } catch (e: any) {
      results.push({
        id: c.id,
        category: c.category,
        question: c.question,
        status: "fail",
        latency_ms: TIMEOUT_MS,
        latency_breakdown_ms: { ttfb: TIMEOUT_MS, total: TIMEOUT_MS },
        answer_snippet: "",
        refused: false,
        expected_refusal: Boolean(c.expected_refusal),
        sources: [],
        source_correct: null,
        context_chunks_count: 0,
        faithfulness: null,
        answer_relevance: null,
        judge_reason: null,
        terms_hit: [],
        terms_missed: c.expected_answer_terms,
        error: String(e?.message ?? e),
      });
      console.log(`❌ ERROR  ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }

  // ---------- Aggregate metrics ----------
  const answered = results.filter((r) => !r.expected_refusal);
  const refusals = results.filter((r) => r.expected_refusal);
  const sourceScored = results.filter((r) => r.source_correct !== null);
  const faithScored = results.filter((r) => r.faithfulness !== null);
  const relScored = results.filter((r) => r.answer_relevance !== null);
  const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  const answerAccuracy = answered.length ? answered.filter((r) => r.status === "pass").length / answered.length : 0;
  const refusalAccuracy = refusals.length ? refusals.filter((r) => r.status === "pass").length / refusals.length : 0;
  const sourceAttribution = sourceScored.length ? sourceScored.filter((r) => r.source_correct).length / sourceScored.length : 0;
  const faithfulness = mean(faithScored.map((r) => r.faithfulness as number));
  const answerRelevance = mean(relScored.map((r) => r.answer_relevance as number));
  const latencies = results.map((r) => r.latency_ms).sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.floor((p / 100) * Math.max(latencies.length - 1, 0))] ?? 0;

  const metrics = {
    evaluated_at: new Date().toISOString(),
    api_base: BASE,
    total_cases: results.length,
    answer_accuracy: Number(answerAccuracy.toFixed(3)),
    refusal_accuracy_grounding: Number(refusalAccuracy.toFixed(3)),
    source_attribution: Number(sourceAttribution.toFixed(3)),
    faithfulness: faithScored.length ? Number(faithfulness.toFixed(3)) : null,
    answer_relevance: relScored.length ? Number(answerRelevance.toFixed(3)) : null,
    judge_cases: faithScored.length,
    latency_p50_ms: pct(50),
    latency_p95_ms: pct(95),
    mean_latency_ms: Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(latencies.length, 1)),
    failures: results.filter((r) => r.status === "fail").map((r) => r.id),
  };

  // ---------- Report ----------
  console.log(`\n📊 METRICS`);
  console.log(`  Answer accuracy:        ${(metrics.answer_accuracy * 100).toFixed(0)}%  (${answered.filter((r) => r.status === "pass").length}/${answered.length})`);
  console.log(`  Grounding (refusals):   ${(metrics.refusal_accuracy_grounding * 100).toFixed(0)}%  (${refusals.filter((r) => r.status === "pass").length}/${refusals.length} out-of-corpus refused)`);
  console.log(`  Source attribution:     ${(metrics.source_attribution * 100).toFixed(0)}%  (${sourceScored.filter((r) => r.source_correct).length}/${sourceScored.length})`);
  if (metrics.faithfulness !== null) {
    console.log(`  Faithfulness (judge):   ${(metrics.faithfulness * 100).toFixed(0)}%  (${faithScored.filter((r) => r.faithfulness === 0).length} unfaithful of ${faithScored.length} judged)`);
    console.log(`  Relevance (judge):      ${(metrics.answer_relevance! * 100).toFixed(0)}%  (${relScored.filter((r) => r.answer_relevance === 0).length} irrelevant of ${relScored.length} judged)`);
  } else {
    console.log(`  Faithfulness (judge):   skipped — set GROQ_API to enable LLM-as-judge`);
  }
  console.log(`  Latency p50 / p95 / mean: ${metrics.latency_p50_ms}ms / ${metrics.latency_p95_ms}ms / ${metrics.mean_latency_ms}ms`);
  if (metrics.failures.length) console.log(`  ❌ Failures: ${metrics.failures.join(", ")}`);

  const outDir = join(import.meta.dir, "results");
  if (!existsSync(outDir)) mkdirSync(outDir);
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(join(outDir, `eval-${stamp}.json`), JSON.stringify({ metrics, results }, null, 2));
  console.log(`\n📁 Full results: tests/eval/results/eval-${stamp}.json`);
  console.log(`\n${metrics.failures.length ? "⚠️  Fix failures, then re-run." : "✅ All green — update README benchmark table."}\n`);
}

// Only execute when run directly (bun tests/eval/run-eval.ts) — importing the
// module (e.g. to unit-test judgeAnswer/scoreAnswer) must stay side-effect free.
if (import.meta.main) {
  main();
}
