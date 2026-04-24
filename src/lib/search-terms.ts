/**
 * Search-term tokenization and scoring helpers.
 *
 * All the logic in this file is pure — no filesystem, no shell, no
 * timestamps. That lets tests pin down ranking behaviour deterministically
 * without setting up a temp directory or spawning `rg`.
 */

import { STOP_WORDS } from "../constants";

/**
 * Split a query into individual search terms.
 * - Quoted phrases become a single term (with the quotes stripped).
 * - Whitespace-separated words become individual terms.
 * - Very short words (<2 chars) and common stop words are filtered out.
 *
 * The original casing is preserved in the return value; downstream callers
 * lowercase when they need to compare. That's intentional: a future ranker
 * might want to treat `SQL` differently from `sql`.
 */
export function parseSearchTerms(query: string): string[] {
  const terms: string[] = [];
  // Match quoted phrases or individual words
  const regex = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(query)) !== null) {
    const original = match[1] || match[2];
    const lower = original.toLowerCase();
    // Skip very short terms and common words
    if (lower.length < 2) continue;
    if (STOP_WORDS.has(lower)) continue;
    terms.push(original);
  }
  return terms;
}

/**
 * Count how many of the given search terms appear anywhere in the text
 * (case-insensitive). Used as one of the ranking signals in the memory
 * search scorer.
 */
export function countTermMatches(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lowerText = text.toLowerCase();
  return terms.filter((t) => lowerText.includes(t.toLowerCase())).length;
}

/**
 * Structured inputs for the memory ranker. Kept as a record of primitives
 * so callers can fill in whatever subset of signals they have — e.g. tests
 * can exercise just the importance weighting without constructing a full
 * ripgrep/rag result.
 */
export interface ScoreInputs {
  /** True if ripgrep found a keyword match in this file. */
  rgMatch: boolean;
  /** Cosine similarity from the semantic index, if available. */
  ragScore?: number;
  /** Per-file count of how many search terms appeared in the body. */
  termMatches: number;
  /** Total number of search terms in the query. */
  totalTerms: number;
  /** Frontmatter tags (used for tag-match bonus). */
  tags?: string[];
  /** Relative path (used for filename-match bonus). */
  path: string;
  /** Importance bucket: `high`, `medium`, or `low`. */
  importance?: string;
  /** Historical access count (frequently-used memories get a bump). */
  accessCount?: number;
  /** The original search terms. */
  terms: string[];
}

/**
 * Deterministic scorer for a single candidate memory file. The weights were
 * tuned against a real corpus, but the key insight is that they're all
 * bounded — no single signal can dominate. `rg` gives coarse recall; `rag`
 * gives semantic discrimination; the metadata bonuses reward curation.
 *
 * Exported so tests can verify the exact ranking under mixed signals
 * without going through the full `memory_search` tool.
 */
export function scoreCandidate(input: ScoreInputs): number {
  let score = 0;

  // Keyword match — lowered base so rag can discriminate between candidates
  // that all matched some keyword.
  if (input.rgMatch) {
    const termCoverage =
      input.totalTerms > 0 ? input.termMatches / input.totalTerms : 1;
    score += 0.15 + 0.35 * termCoverage; // 0.15-0.50
  }

  // Semantic match — boosted because rag scores already live on [0, 1] and
  // tend to be the most informative signal when they're available.
  if (input.ragScore) score += input.ragScore * 1.4;

  // Hybrid synergy — matching both signals is a strong confidence bump.
  if (input.rgMatch && input.ragScore) score += 0.1;

  // Tag match — curated metadata is a strong signal that the author
  // considered this file relevant to this topic.
  if (input.tags && input.tags.length > 0 && input.terms.length > 0) {
    const lowerTags = input.tags.map((t) => t.toLowerCase());
    const tagHits = input.terms.filter((t) =>
      lowerTags.some((tag) => tag.includes(t.toLowerCase())),
    ).length;
    if (tagHits > 0) score += 0.2 * (tagHits / input.terms.length);
  }

  // Filename/path match — words in the path are usually meaningful.
  const pathLower = input.path.toLowerCase().replace(/[-_/.]/g, " ");
  const pathHits = input.terms.filter((t) =>
    pathLower.includes(t.toLowerCase()),
  ).length;
  if (pathHits > 0 && input.terms.length > 0) {
    score += 0.15 * (pathHits / input.terms.length);
  }

  // Importance — editorial override. `high` wins close ties; `low` is a
  // gentle penalty so low-importance memories have to earn the top slot.
  if (input.importance === "high") score += 0.15;
  else if (input.importance === "low") score -= 0.1;

  // Access frequency — memories that keep getting read are more likely to
  // be relevant than ones that are written and never touched again.
  if (input.accessCount && input.accessCount >= 5) score += 0.1;
  else if (input.accessCount && input.accessCount >= 2) score += 0.05;

  return score;
}
