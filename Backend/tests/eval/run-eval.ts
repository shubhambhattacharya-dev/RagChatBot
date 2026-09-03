/**
 * RagChatBot Evaluation Harness
 * --------------------------------
 * Runs the golden test set against the LIVE deployed API and produces
 * RAG quality metrics: answer correctness, groundedness (refusal
 * correctness), source attribution, and per-request latency.
 *
 * Usage:
 *   API_BASE=https://ragchatbot-61jh.onrender.com \
 *   GROQ_API_KEY=... GEMINI_API_KEY=... \
 *   bun tests/eval/run-eval.ts
 *
 * Output: tests/eval/results.json + printed metrics table.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.API_BASE ?? "http://localhost:3000";
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
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let tokens = "";
    let refusal = false;
    const sources: string[] = [];

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
          if (evt.type === "sources") sources.push(...(evt.documents ?? []));
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
    return { tokens, sources, refusal, ttfb, total: Date.now() - t0 };
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
        terms_hit: terms.hit,
        terms_missed: terms.missed,
      });
      console.log(`${pass ? "✅ PASS" : "❌ FAIL"}  ${r.total}ms  ${refused ? "(refused)" : terms.hit.join(",")}`);
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

  const answerAccuracy = answered.length ? answered.filter((r) => r.status === "pass").length / answered.length : 0;
  const refusalAccuracy = refusals.length ? refusals.filter((r) => r.status === "pass").length / refusals.length : 0;
  const sourceAttribution = sourceScored.length ? sourceScored.filter((r) => r.source_correct).length / sourceScored.length : 0;
  const latencies = results.map((r) => r.latency_ms).sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.floor((p / 100) * Math.max(latencies.length - 1, 0))] ?? 0;

  const metrics = {
    evaluated_at: new Date().toISOString(),
    api_base: BASE,
    total_cases: results.length,
    answer_accuracy: Number(answerAccuracy.toFixed(3)),
    refusal_accuracy_grounding: Number(refusalAccuracy.toFixed(3)),
    source_attribution: Number(sourceAttribution.toFixed(3)),
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
  console.log(`  Latency p50 / p95 / mean: ${metrics.latency_p50_ms}ms / ${metrics.latency_p95_ms}ms / ${metrics.mean_latency_ms}ms`);
  if (metrics.failures.length) console.log(`  ❌ Failures: ${metrics.failures.join(", ")}`);

  const outDir = join(import.meta.dir, "results");
  if (!existsSync(outDir)) mkdirSync(outDir);
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(join(outDir, `eval-${stamp}.json`), JSON.stringify({ metrics, results }, null, 2));
  console.log(`\n📁 Full results: tests/eval/results/eval-${stamp}.json`);
  console.log(`\n${metrics.failures.length ? "⚠️  Fix failures, then re-run." : "✅ All green — update README benchmark table."}\n`);
}

main();
