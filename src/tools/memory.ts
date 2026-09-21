/**
 * Memory tools: search, list, save, access.
 *
 * The memory root is resolved lazily via `resolveMemoryDir()` so that
 * tests can point the whole plugin at a temp directory by setting
 * `$OPENCODE_MEMORY_DIR` before importing.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { posix } from "node:path";
import { CATEGORIES } from "../constants";
import { parseFrontmatter, todayISO, type FrontMatter } from "../lib/frontmatter";
import {
  formatMemoryDirForDisplay,
  formatMemoryPathForDisplay,
  normPath,
  ragIndexDir,
  resolveContainedPath,
  resolveMemoryDir,
} from "../lib/paths";
import { installGuidance, ragAvailable, ragSearch, resolveRagBinary, spawnRagIndex } from "../lib/rag";
import { resolveRgBinary, rgInstallGuidance } from "../lib/ripgrep";
import { countTermMatches, parseSearchTerms, scoreCandidate } from "../lib/search-terms";
import { defineTool } from "../lib/tool-spec";

// --- Internal helpers ---------------------------------------------------

function validCategory(category: string | undefined): category is (typeof CATEGORIES)[number] {
  return category !== undefined && (CATEGORIES as readonly string[]).includes(category);
}

function withAccessDatabase<T>(memoryDir: string, run: (database: Database) => T): T {
  const indexDir = ragIndexDir(memoryDir);
  mkdirSync(indexDir, { recursive: true });
  const database = new Database(posix.join(indexDir, "access-telemetry.sqlite"), { create: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(
      "CREATE TABLE IF NOT EXISTS memory_access (path TEXT PRIMARY KEY, access_count INTEGER NOT NULL, last_accessed TEXT NOT NULL)",
    );
    return run(database);
  } finally {
    database.close();
  }
}

function accessCounts(memoryDir: string): Map<string, number> {
  return withAccessDatabase(memoryDir, (database) => new Map(
    database.query<{ path: string; access_count: number }, []>("SELECT path, access_count FROM memory_access").all()
      .map((row) => [row.path, row.access_count]),
  ));
}

/**
 * Build a ripgrep argument list for OR-matching multiple terms.
 * Kept as a pure function so tests can verify the exact args shape.
 */
export function buildRgArgs(terms: string[]): string[] {
  const args = ["-il", "--glob", "*.md", "--glob", "!.git", "--glob", "!.rag", "--glob", "!**/INDEX.md"];
  for (const term of terms) {
    args.push("-e", term);
  }
  return args;
}

/**
 * Parse the output of a `rag search --json` invocation. Returns an empty
 * array on any failure. Exported for tests.
 */
export function parseRagHits(ragText: string): Array<{ source: string; score: number; text: string }> {
  if (!ragText) return [];
  try {
    const parsed = JSON.parse(ragText);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (hit) => hit && typeof hit.source === "string" && typeof hit.score === "number" && typeof hit.text === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Relative path from the memory root, with backslashes normalized.
 * Exposed for tests that need to assert the exact key written into the
 * result map.
 */
export function toRelPath(memoryDir: string, absPath: string): string {
  return posix.relative(memoryDir, normPath(absPath));
}

function configuredMemoryDirLabel(memoryDir?: string): string {
  try {
    return formatMemoryDirForDisplay(memoryDir ?? resolveMemoryDir());
  } catch {
    return "the configured memory directory";
  }
}

function configuredMemoryPathLabel(relPath: string, memoryDir?: string): string {
  try {
    return formatMemoryPathForDisplay(memoryDir ?? resolveMemoryDir(), relPath);
  } catch {
    return `the configured memory directory/${relPath}`;
  }
}

export function memorySearchDescription(memoryDir?: string): string {
  const memoryRoot = configuredMemoryDirLabel(memoryDir);
  const memoryPath = configuredMemoryPathLabel("{path}", memoryDir);
  return (
    `Search memories in ${memoryRoot} using both keyword (rg) and semantic (rag) search. ` +
    "Results are concise pointers (path, importance, summary, and short evidence). " +
    "Use memory_read on a result to retrieve only the relevant content.\n\n" +
    "Multi-term queries match files containing ANY search term (OR logic); files matching more terms rank higher. " +
    "For example, 'errors retries' finds files mentioning 'errors' OR 'retries', with files containing both ranked first.\n\n" +
    "WHEN TO SEARCH (do this BEFORE starting work):\n" +
    "- Starting work on any repo — there may be saved context about structure, conventions, or gotchas\n" +
    "- Using an external tool or API with non-obvious usage patterns\n" +
    "- Encountering an unfamiliar codebase, service, or system\n" +
    "- Debugging a problem you or a previous session may have solved before\n" +
    "- Looking up a person, team, or ownership information\n" +
    "- Before writing new memory — check if a file already exists to update instead of duplicate\n\n" +
    "FOLLOW-UP SEARCHES (do when results seem incomplete):\n" +
    `- Use memory_read(path) instead of reading all of ${memoryPath}\n` +
    "- If few/no results, try broader terms or search without the category filter\n" +
    "- Use detail=debug only when ranking diagnostics or related-file expansion is needed"
  );
}

export function memoryListDescription(memoryDir?: string): string {
  const memoryRoot = configuredMemoryDirLabel(memoryDir);
  return (
    `Browse memories in ${memoryRoot}. Without a category, lists all categories with file counts. ` +
    "With a category, lists files in that category with their summaries."
  );
}

export function memoryAccessPathDescription(memoryDir?: string): string {
  const memoryRoot = configuredMemoryDirLabel(memoryDir);
  return `Relative path within ${memoryRoot} (e.g. 'technical/build-tooling.md')`;
}

export function memorySaveDescription(memoryDir?: string): string {
  const memoryPath = configuredMemoryPathLabel("{category}/{filename}.md", memoryDir);
  return (
    "Commit and re-index all pending memory changes. " +
    `Call AFTER using Write/Edit tools on ${memoryPath}. ` +
    "Handles: git add -A, commit (message derived from changed files), RAG re-indexing.\n\n" +
    "WHEN TO SAVE (always save when you discover something reusable):\n" +
    "- Learned a non-obvious API pattern, tool quirk, or workaround\n" +
    "- Discovered repo structure, conventions, or gotchas that future sessions would benefit from\n" +
    "- Found external tool usage patterns that weren't documented\n" +
    "- Resolved a tricky debugging problem with a non-obvious root cause\n" +
    "- Learned team/ownership/contact information not easily found elsewhere\n" +
    "DO NOT save: one-off answers, things in public docs, or context only relevant to the current task\n\n" +
    "WORKFLOW:\n" +
    "1. memory_search first — check if a file already exists to update\n" +
    `2. Write/Edit files at ${memoryPath}\n` +
    "3. Call this tool to sync all changes\n\n" +
    "REPO NOTES: for repository-related memory, use the path structure\n" +
    "`repos/{host}/{org}/{repo}.md` — e.g. `repos/github.com/user/project.md`.\n" +
    "This makes it easy to find later by repo URL fragments.\n\n" +
    "CATEGORIES: preferences, repos, technical, people, workflows, snippets, notes\n\n" +
    "FRONTMATTER FORMAT (include at top of file):\n" +
    "---\n" +
    "title: Human-readable title\n" +
    "tags: [tag1, tag2]\n" +
    "summary: One-line summary\n" +
    "created: YYYY-MM-DD\n" +
    "updated: YYYY-MM-DD\n" +
    "importance: high | medium | low\n" +
    "related: [category/file.md]\n" +
    "---"
  );
}

// --- Tools --------------------------------------------------------------

export const search = defineTool<{
  query: string;
  category?: string;
  detail?: MemorySearchDetail;
}>({
  name: "memory_search",
  description: memorySearchDescription(),
  input: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search terms or natural language query" },
      category: {
        type: "string",
        enum: CATEGORIES,
        description: "Filter to a specific memory category",
      },
      detail: {
        type: "string",
        enum: ["compact", "normal", "debug"],
        description: 'Output detail: "compact", "normal" (default), or "debug" for ranking diagnostics',
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute({ query, category, detail = "normal" }) {
    return runSearch({ query, category, detail });
  },
});

/**
 * Pure entry point for memory search. Exposed separately from the `tool()`
 * wrapper so tests can call it with plain arguments and assert against the
 * returned string without constructing a full tool context.
 */
export type MemorySearchDetail = "compact" | "normal" | "debug";

export async function runSearch(input: {
  query: string;
  category?: string;
  detail?: MemorySearchDetail;
}): Promise<string> {
  const { query, category, detail = "normal" } = input;
  if (category !== undefined && !validCategory(category)) return `Invalid memory category: ${category}`;
  const memoryDir = resolveMemoryDir();
  const indexDir = ragIndexDir(memoryDir);
  const searchDir = category ? posix.join(memoryDir, category) : memoryDir;
  const terms = parseSearchTerms(query);
  const rgTerms = terms.length > 0 ? terms : [query];

  const hasRag = ragAvailable();
  const rgBin = resolveRgBinary();

  const [rgResult, ragResultText] = await Promise.all([
    rgBin ? Bun.$`${rgBin} ${buildRgArgs(rgTerms)} ${searchDir}`.text().catch(() => "") : Promise.resolve(""),
    hasRag ? ragSearch({ query, indexDir, topK: 15 }) : Promise.resolve(""),
  ]);

  const resultMap = new Map<string, { rgMatch: boolean; ragScore?: number; ragText?: string }>();

  const rgText = rgResult.trim();
  if (rgText) {
    for (const line of rgText.split("\n")) {
      const rel = toRelPath(memoryDir, line);
      if (rel.endsWith(".md") && !rel.startsWith(".")) {
        resultMap.set(rel, { rgMatch: true });
      }
    }
  }

  const ragHits = parseRagHits(ragResultText);
  for (const hit of ragHits) {
    if (hit.source.endsWith("INDEX.md")) continue;
    if (category && !hit.source.startsWith(category + "/")) continue;
    const existing = resultMap.get(hit.source) || { rgMatch: false };
    if (!existing.ragScore || hit.score > existing.ragScore) {
      existing.ragScore = hit.score;
      existing.ragText = hit.text;
    }
    resultMap.set(hit.source, existing);
  }

  let crossCategoryFallback = false;
  if (resultMap.size === 0 && category) {
    crossCategoryFallback = true;
    const globalRgText = rgBin ? await Bun.$`${rgBin} ${buildRgArgs(rgTerms)} ${memoryDir}`.text().catch(() => "") : "";
    if (globalRgText.trim()) {
      for (const line of globalRgText.trim().split("\n")) {
        const rel = toRelPath(memoryDir, line);
        if (rel.endsWith(".md") && !rel.startsWith(".")) {
          resultMap.set(rel, { rgMatch: true });
        }
      }
    }
    for (const hit of ragHits) {
      if (hit.source.endsWith("INDEX.md")) continue;
      const existing = resultMap.get(hit.source) || { rgMatch: false };
      if (!existing.ragScore || hit.score > existing.ragScore) {
        existing.ragScore = hit.score;
        existing.ragText = hit.text;
      }
      resultMap.set(hit.source, existing);
    }
  }

  if (resultMap.size === 0) {
    const scanDir = category ? posix.join(memoryDir, category) : memoryDir;
    const suggestions: string[] = [];
    try {
      const fnGlob = new Bun.Glob("**/*.md");
      for await (const f of fnGlob.scan({ cwd: scanDir, dot: false })) {
        if (f.includes("INDEX.md")) continue;
        const nameLower = f.toLowerCase().replace(/[-_/.]/g, " ");
        if (terms.some((t) => nameLower.includes(t.toLowerCase()))) {
          suggestions.push(category ? `${category}/${f}` : f);
        }
      }
    } catch {
      // scan failed — fall through to "no memories"
    }

    if (suggestions.length > 0) {
      return (
        `No content matches for: "${query}"\n\n` +
        `Files with matching names:\n${suggestions
          .slice(0, 5)
          .map((s) => `  - ${formatMemoryPathForDisplay(memoryDir, s)}`)
          .join("\n")}\n\n` +
        `Use the Read tool to check these.`
      );
    }
    return `No memories found for: "${query}"`;
  }

  // Build ranked results by reading each match's frontmatter.
  const results: Array<{
    path: string;
    meta: FrontMatter;
    rgMatch: boolean;
    ragScore?: number;
    ragText?: string;
    termMatches: number;
    score: number;
  }> = [];

  const telemetryCounts = accessCounts(memoryDir);
  for (const [path, info] of resultMap) {
    try {
      const content = await Bun.file(posix.join(memoryDir, path)).text();
      const { meta } = parseFrontmatter(content);
      const termMatches = terms.length > 0 ? countTermMatches(content, terms) : info.rgMatch ? 1 : 0;

      const score = scoreCandidate({
        rgMatch: info.rgMatch,
        ragScore: info.ragScore,
        termMatches,
        totalTerms: terms.length,
        tags: meta.tags,
        path,
        importance: meta.importance,
        accessCount: (meta.access_count ?? 0) + (telemetryCounts.get(path) ?? 0),
        terms,
      });

      results.push({ path, meta, score, termMatches, ...info });
    } catch {
      // file read failed — skip
    }
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  // Filter out low-relevance results. If every candidate is below the
  // threshold, retain a few fallbacks rather than returning an empty result.
  const filtered = results.filter((r) => r.score >= 0.2);
  const topResults = filtered.length > 0 ? filtered : results.slice(0, 3);
  const shown = topResults.slice(0, 5);
  const lines = [`## Results for "${query}" (${results.length} candidates, showing ${shown.length})\n`];

  if (crossCategoryFallback) {
    lines.push(`_No results in **${category}/** — showing matches from all categories:_\n`);
  }
  if (terms.length > 1) {
    lines.push(`_Searching for: ${terms.join(", ")}_\n`);
  }

  for (const [i, r] of shown.entries()) {
    const isDirectHit =
      r.rgMatch && r.ragScore !== undefined && r.ragScore > 0.4 && r.termMatches === terms.length;
    const hitLabel = isDirectHit ? " ★ DIRECT HIT" : "";
    const summary = r.meta.summary ? ` — ${r.meta.summary}` : "";

    if (detail === "compact" || i >= 2) {
      lines.push(`${i + 1}. **${r.path}** [${r.meta.importance || "medium"}]${summary}`);
      continue;
    }

    lines.push(`${i + 1}. **${r.path}** [${r.meta.importance || "medium"}]${hitLabel}`);
    if (r.meta.summary) lines.push(`   ${r.meta.summary}`);

    const sources: string[] = [];
    if (r.rgMatch) {
      const termInfo = terms.length > 1 ? ` (${r.termMatches}/${terms.length} terms)` : "";
      sources.push(`keyword${termInfo}`);
    }
    if (r.ragScore !== undefined) sources.push("semantic");
    if (sources.length > 0) lines.push(`   Evidence: ${sources.join(" + ")}`);
    if (r.ragText) lines.push(`   Preview: "...${r.ragText.slice(0, 160).trim()}..."`);

    if (detail === "debug") {
      const semantic = r.ragScore === undefined ? "n/a" : r.ragScore.toFixed(3);
      lines.push(
        `   Diagnostics: keyword=${r.rgMatch}; term_hits=${r.termMatches}/${terms.length}; ` +
          `semantic=${semantic}; combined_score=${r.score.toFixed(3)}`,
      );
      if (r.meta.tags?.length) lines.push(`   Tags: ${r.meta.tags.join(", ")}`);
      if (r.meta.related?.length) lines.push(`   Related: ${r.meta.related.join(", ")}`);
    }
    lines.push("");
  }

  if (shown.length > 0) {
    lines.push(`_Read the top result: \`memory_read(path="${shown[0].path}")\`_`);
  }

  // Related-file verification and expansion is intentionally debug-only:
  // it is useful for ranker investigation but too noisy for normal retrieval.
  if (detail === "debug") {
    const shownPaths = new Set(shown.map((r) => r.path));
    const relatedSuggestions: string[] = [];
    for (const r of shown) {
      for (const rel of r.meta.related || []) {
        if (!shownPaths.has(rel) && !relatedSuggestions.includes(rel)) relatedSuggestions.push(rel);
      }
    }

    const verified: string[] = [];
    for (const rel of relatedSuggestions) {
      try {
        const relatedPath = resolveContainedPath(memoryDir, rel);
        if (await Bun.file(relatedPath).exists()) verified.push(rel);
      } catch {
        // Ignore invalid or missing related-file pointers.
      }
    }

    if (verified.length > 0) {
      lines.push("", "---", "**Related files** (debug expansion):");
      for (const rel of verified) lines.push(`  - ${rel}`);
    }
  }

  return lines.join("\n");
}

export const list = defineTool<{ category?: string }>({
  name: "memory_list",
  description: memoryListDescription(),
  input: {
    type: "object",
    properties: {
      category: { type: "string", enum: CATEGORIES, description: "Memory category to list" },
    },
    additionalProperties: false,
  },
  async execute({ category }) {
    return runList({ category });
  },
});

export async function runList(input: { category?: string }): Promise<string> {
  const memoryDir = resolveMemoryDir();
  const { category } = input;

  if (!category) {
    const lines = ["## Memory Categories\n"];
    for (const cat of CATEGORIES) {
      const glob = new Bun.Glob("**/*.md");
      let count = 0;
      try {
        for await (const _ of glob.scan({
          cwd: posix.join(memoryDir, cat),
          dot: false,
        })) {
          count++;
        }
      } catch {
        // directory doesn't exist — treat as empty
      }
      lines.push(`- **${cat}/** (${count} files)`);
    }
    return lines.join("\n");
  }

  if (!validCategory(category)) return `Invalid memory category: ${category}`;
  const catDir = posix.join(memoryDir, category);
  const glob = new Bun.Glob("**/*.md");
  const files: Array<{
    path: string;
    title: string;
    summary: string;
    importance: string;
    updated: string;
  }> = [];

  try {
    for await (const f of glob.scan({ cwd: catDir, dot: false })) {
      try {
        const content = await Bun.file(posix.join(catDir, f)).text();
        const { meta } = parseFrontmatter(content);
        files.push({
          path: `${category}/${f}`,
          title: meta.title || f.replace(".md", ""),
          summary: meta.summary || "",
          importance: meta.importance || "medium",
          updated: meta.updated || "",
        });
      } catch {
        // skip unreadable file
      }
    }
  } catch {
    return `Category not found: ${category}`;
  }

  if (files.length === 0) {
    return `No memories in category: ${category}`;
  }

  files.sort((a, b) => b.updated.localeCompare(a.updated));

  const lines = [`## ${category}/ (${files.length} files)\n`];
  for (const f of files) {
    lines.push(`- **${f.path}** [${f.importance}] ${f.updated ? `(${f.updated})` : ""}`);
    if (f.summary) lines.push(`  ${f.summary}`);
  }
  return lines.join("\n");
}

const MAX_READ_CHARS = 16_000;
const DEFAULT_READ_CHARS = 4_000;

function sliceCodePointSafe(text: string, start: number, maxChars: number): string {
  let safeStart = Math.min(start, text.length);
  if (safeStart > 0 && safeStart < text.length) {
    const current = text.charCodeAt(safeStart);
    const previous = text.charCodeAt(safeStart - 1);
    if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) safeStart++;
  }
  let end = Math.min(text.length, safeStart + maxChars);
  if (end > safeStart && end < text.length) {
    const previous = text.charCodeAt(end - 1);
    const current = text.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) end--;
  }
  return text.slice(safeStart, end);
}

function normalizeHeading(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .trim()
    .toLowerCase();
}

/** Select an ATX heading and its descendants, stopping at the next peer/parent. */
export function selectHeadingSection(body: string, heading: string): string | undefined {
  const wanted = normalizeHeading(heading);
  if (!wanted) return undefined;

  const lines = body.split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match && normalizeHeading(match[2]) === wanted) {
      start = i;
      level = match[1].length;
      break;
    }
  }
  if (start < 0) return undefined;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

async function resolveRealPathContained(memoryDir: string, filePath: string): Promise<string> {
  const [realRoot, realFile] = await Promise.all([realpath(memoryDir), realpath(filePath)]);
  const root = normPath(realRoot);
  const file = normPath(realFile);
  const relative = posix.relative(root, file);
  if (relative === "" || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) {
    throw new Error("Resolved path is outside the memory directory");
  }
  return realFile;
}

export const read = defineTool<{
  path: string;
  heading?: string;
  offset?: number;
  max_chars?: number;
}>({
  name: "memory_read",
  description:
    "Read a bounded portion of one memory file and automatically record successful access. " +
    "Returns frontmatter plus either the named Markdown heading section or the beginning of the body, " +
    "with truncation/continuation metadata. Prefer this over the general Read tool after memory_search.",
  input: {
    type: "object",
    properties: {
      path: { type: "string", description: memoryAccessPathDescription() },
      heading: {
        type: "string",
        description: 'Optional Markdown heading text to select (for example, "Build and test")',
      },
      offset: {
        type: "number",
        description: "Character offset within the selected body or heading section (default 0)",
      },
      max_chars: {
        type: "number",
        description:
          "Maximum memory-content characters to return, including bounded frontmatter (default 4000, maximum 16000)",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute({ path, heading, offset = 0, max_chars = DEFAULT_READ_CHARS }) {
    return runRead({ path, heading, offset, maxChars: max_chars });
  },
});

export async function runRead(input: {
  path: string;
  heading?: string;
  offset?: number;
  maxChars?: number;
}): Promise<string> {
  const memoryDir = resolveMemoryDir();
  let filePath: string;
  try {
    filePath = await resolveRealPathContained(memoryDir, resolveContainedPath(memoryDir, input.path));
  } catch {
    return `Could not read ${input.path}: path is missing or outside the memory directory`;
  }

  let content: string;
  try {
    content = await Bun.file(filePath).text();
  } catch {
    return `Could not read ${input.path}`;
  }

  const frontmatterMatch = content.match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
  const frontmatter = frontmatterMatch?.[1] ?? "";
  const body = frontmatterMatch?.[2] ?? content;
  const selected = input.heading ? selectHeadingSection(body, input.heading) : body;
  if (selected === undefined) {
    return `Heading not found in ${input.path}: ${input.heading}`;
  }

  const requestedMax = Number.isFinite(input.maxChars) ? Math.trunc(input.maxChars!) : DEFAULT_READ_CHARS;
  const maxChars = Math.max(2, Math.min(MAX_READ_CHARS, requestedMax));
  const requestedOffset = Number.isFinite(input.offset) ? Math.trunc(input.offset!) : 0;
  const offset = Math.max(0, requestedOffset);
  if (offset > selected.length) return `Offset ${offset} is beyond the selected content (${selected.length} characters)`;

  // Frontmatter is useful routing context on the first page, but it must not
  // defeat the total memory-content budget. Reserve at least 75% for body.
  const frontmatterBudget = offset === 0 ? Math.min(frontmatter.length, Math.floor(maxChars / 4), 1_000) : 0;
  const shownFrontmatter = sliceCodePointSafe(frontmatter, 0, frontmatterBudget);
  const bodyBudget = maxChars - shownFrontmatter.length;
  const excerpt = sliceCodePointSafe(selected, offset, bodyBudget);
  const safeOffset = offset < selected.length && excerpt.length > 0 ? selected.indexOf(excerpt, offset) : offset;
  const nextOffset = safeOffset + excerpt.length;
  const truncated = nextOffset < selected.length;
  const selection = input.heading ? `heading=${JSON.stringify(input.heading)}` : "body";
  const metadata =
    `[memory_read: path=${JSON.stringify(input.path)}; selection=${selection}; offset=${safeOffset}; ` +
    `shown_chars=${shownFrontmatter.length + excerpt.length}; total_chars=${selected.length}; truncated=${truncated}` +
    (frontmatter.length > shownFrontmatter.length && offset === 0 ? `; frontmatter_truncated=${frontmatter.length - shownFrontmatter.length}` : "") +
    (truncated ? `; next_char=${nextOffset}; remaining_chars=${selected.length - nextOffset}` : "") +
    "]";

  // Retrieval and section selection succeeded. Record usage in the ignored
  // sidecar database; telemetry must never rewrite the source memory.
  await recordAccessAtPath(filePath, input.path, memoryDir);

  const memoryContent = `${shownFrontmatter}${excerpt}`;
  return `${memoryContent}${memoryContent.endsWith("\n") ? "" : "\n"}\n---\n${metadata}`;
}

export const access = defineTool<{ path: string }>({
  name: "memory_access",
  description:
    "Record that a memory file was accessed (read and used). Updates sidecar access telemetry " +
    "without rewriting the memory file. Call this AFTER reading a memory file " +
    "that you actually used to inform your work — not for casual browsing.\n\n" +
    "This helps the memory system track which memories are actively useful vs. stale.",
  input: {
    type: "object",
    properties: {
      path: { type: "string", description: memoryAccessPathDescription() },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute({ path }) {
    return runAccess({ path });
  },
});

async function recordAccessAtPath(filePath: string, displayPath: string, memoryDir: string): Promise<string> {
  try {
    const content = await Bun.file(filePath).text();
    const { meta } = parseFrontmatter(content);
    if (!content.startsWith("---\n")) return `No frontmatter in ${displayPath} — skipped`;
    const increment = withAccessDatabase(memoryDir, (database) => database.transaction(() => {
      database.query(
        `INSERT INTO memory_access(path, access_count, last_accessed) VALUES (?, 1, ?)
         ON CONFLICT(path) DO UPDATE SET access_count = access_count + 1, last_accessed = excluded.last_accessed`,
      ).run(displayPath, todayISO());
      return database.query<{ access_count: number }, [string]>(
        "SELECT access_count FROM memory_access WHERE path = ?",
      ).get(displayPath)?.access_count ?? 0;
    })());
    return `Recorded access for ${displayPath} (count: ${(meta.access_count ?? 0) + increment})`;
  } catch {
    return `Could not update ${displayPath}`;
  }
}

export async function runAccess(input: { path: string }): Promise<string> {
  const memoryDir = resolveMemoryDir();
  try {
    const filePath = await resolveRealPathContained(memoryDir, resolveContainedPath(memoryDir, input.path));
    return recordAccessAtPath(filePath, input.path, memoryDir);
  } catch {
    return `Could not update ${input.path}`;
  }
}

export const save = defineTool<Record<string, never>>({
  name: "memory_save",
  description: memorySaveDescription(),
  input: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    return runSave();
  },
});

export async function runSave(): Promise<string> {
  const memoryDir = resolveMemoryDir();
  const indexDir = ragIndexDir(memoryDir);
  let changed: string[] = [];

  try {
    await Bun.$`git -C ${memoryDir} add -A`.quiet();
    const diff = await Bun.$`git -C ${memoryDir} diff --name-only --cached`.text().catch(() => "");
    changed = diff.trim().split("\n").filter(Boolean);

    if (changed.length === 0) {
      return "No changes to sync";
    }

    const msg = `memory: sync ${changed.join(", ")}`;
    await Bun.$`git -C ${memoryDir} commit -m ${msg}`.quiet();
  } catch {
    // nothing to commit, or memory dir isn't a git repo — continue to
    // re-indexing so at least semantic search stays fresh.
  }

  const kickedOffIndex = spawnRagIndex({ memoryDir, indexDir });

  if (changed.length === 0) {
    return "No changes to sync";
  }

  const result = `Synced: ${changed.join(", ")}`;
  return kickedOffIndex ? result : `${result}\n\n${installGuidance()}`;
}

export const setup = defineTool<Record<string, never>>({
  name: "memory_setup",
  description:
    "Reports whether `@mathew-cf/rag-cli` is resolvable from this plugin's " +
    "node_modules and prints installation guidance if not. Safe to run at " +
    "any time — does not modify anything.",
  input: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    return runSetup();
  },
});

export async function runSetup(): Promise<string> {
  const ragShim = resolveRagBinary();
  const rgBin = resolveRgBinary();
  const lines: string[] = [];
  lines.push(`ripgrep (keyword search): ${rgBin ?? "NOT resolvable"}`);
  lines.push(`rag shim (semantic search): ${ragShim ?? "NOT resolvable"}`);
  lines.push("");

  if (ragShim && rgBin) {
    lines.push(
      "All set — both search backends are available. Run `rag download` " +
        "once to pre-cache the embedding model if you haven't already " +
        "(subsequent semantic searches are fast).",
    );
  } else {
    if (!rgBin) {
      lines.push(rgInstallGuidance());
      lines.push("");
    }
    if (!ragShim) {
      lines.push(installGuidance());
    }
  }
  return lines.join("\n");
}
