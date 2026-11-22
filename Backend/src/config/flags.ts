/**
 * RAG ChatBot v2.0 - Central Feature Flags
 * 
 * Governs the progressive rollout of v2 features (Agentic Core, Contextual Chunks, Strategy Router).
 * Defaults remain safe/off so v1 production behavior is completely preserved until tests pass.
 */

export interface FeatureFlags {
  /** If true, activates the 6-state Agentic RAG loop (router, planner, grader, rewriter) */
  AGENTIC_MODE: boolean;

  /** If true, prepends LLM-generated situating headers to chunks during ingestion */
  CONTEXTUAL_CHUNKS: boolean;

  /** Token threshold below which whole documents are placed directly in long context */
  STUFF_MAX_TOKENS: number;

  /** Maximum query rewrite/correction loops allowed before forcing refusal */
  MAX_CORRECTION_ROUNDS: number;

  /** Optional listwise reranker for the 30k-150k token middle band */
  RERANK: boolean;
}

export const flags: FeatureFlags = {
  AGENTIC_MODE: process.env.AGENTIC_MODE === "true" || false,
  CONTEXTUAL_CHUNKS: process.env.CONTEXTUAL_CHUNKS === "true" || false,
  STUFF_MAX_TOKENS: Number(process.env.STUFF_MAX_TOKENS) || 30_000,
  MAX_CORRECTION_ROUNDS: Number(process.env.MAX_CORRECTION_ROUNDS) || 2,
  RERANK: process.env.RERANK === "true" || false,
};
