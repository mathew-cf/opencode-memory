/**
 * Shared constants for the opencode-memory plugin.
 *
 * Kept in one place so tests can import the same canonical values.
 */

/**
 * Categories are the top-level folders under the memory directory. They are
 * advisory — users are free to create additional categories — but the search
 * and list tools surface these by default, so they also double as the shape
 * of the knowledge base we document and nudge agents toward.
 */
export const CATEGORIES = [
  "preferences",
  "repos",
  "technical",
  "people",
  "workflows",
  "snippets",
  "notes",
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * Default directory, relative to the user's home, where memory files live.
 * The `MEMORY_DIR` env var overrides this (primarily for tests).
 */
export const DEFAULT_MEMORY_SUBDIR = "opencode-memory";

/**
 * Name of the ripgrep-invisible subdirectory used to store the semantic search
 * index (if `rag` is installed). Bundled inside the memory root so that the
 * index travels with whatever sync mechanism backs the knowledge base.
 */
export const RAG_INDEX_SUBDIR = ".rag";

/**
 * Short words filtered out of search queries so a stray "the" doesn't
 * dominate ranking. Intentionally minimal — better to let the user decide
 * what's meaningful than to over-filter.
 */
export const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "of",
  "to",
  "in",
  "for",
  "on",
  "and",
  "or",
]);
