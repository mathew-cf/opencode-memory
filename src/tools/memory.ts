/**
 * Memory tools: search, list, save, access.
 *
 * The memory root is resolved lazily via `resolveMemoryDir()` so that
 * tests can point the whole plugin at a temp directory by setting
 * `$MEMORY_DIR` before importing.
 */

import { tool } from "@opencode-ai/plugin";
import { CATEGORIES } from "../constants";
import {
  bumpAccessFields,
  parseFrontmatter,
  todayISO,
  type FrontMatter,
} from "../lib/frontmatter";
import { normPath, ragIndexDir, resolveMemoryDir } from "../lib/paths";
import {
  ensureRag,
  installGuidance,
  probeRag,
  ragSearch,
  spawnRagIndex,
} from "../lib/rag";
import {
  countTermMatches,
  parseSearchTerms,
  scoreCandidate,
} from "../lib/search-terms";

// --- Internal helpers ---------------------------------------------------

/**
 * Build a ripgrep argument list for OR-matching multiple terms.
 * Kept as a pure function so tests can verify the exact args shape.
 */
export function buildRgArgs(terms: string[]): string[] {
  const args = [
    "-il",
    "--glob",
    "*.md",
    "--glob",
    "!.git",
    "--glob",
    "!.rag",
    "--glob",
    "!**/INDEX.md",
  ];
  for (const term of terms) {
    args.push("-e", term);
  }
  return args;
}

/**
 * Parse the output of a `rag search --json` invocation. Returns an empty
 * array on any failure. Exported for tests.
 */
export function parseRagHits(
  ragText: string,
): Array<{ source: string; score: number; text: string }> {
  if (!ragText) return [];
  try {
    const parsed = JSON.parse(ragText);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (hit) =>
        hit &&
        typeof hit.source === "string" &&
        typeof hit.score === "number" &&
        typeof hit.text === "string",
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
  return normPath(absPath).replace(`${memoryDir}/`, "");
}

// --- Tools --------------------------------------------------------------

export const search = tool({
  description:
    "Search memories in ~/opencode-memory/ using both keyword (rg) and semantic (rag) search. " +
    "Results are summaries only (path, tags, importance, short context). " +
    "Use the Read tool on ~/opencode-memory/{path} to get the full content.\n\n" +
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
    "- Results include Related: files — use the Read tool on ~/opencode-memory/{path} for connected knowledge\n" +
    "- If few/no results, try broader terms or search without the category filter\n" +
    "- Check the 'Related files' section at the bottom of results for cross-references worth exploring",
  args: {
    query: tool.schema
      .string()
      .describe("Search terms or natural language query"),
    category: tool.schema
      .string()
      .optional()
      .describe(
        "Filter to a specific category: preferences, repos, technical, people, workflows, snippets, notes",
      ),
  },
  async execute({ query, category }) {
    return runSearch({ query, category });
  },
});

/**
 * Pure entry point for memory search. Exposed separately from the `tool()`
 * wrapper so tests can call it with plain arguments and assert against the
 * returned string without constructing a full tool context.
 */
export async function runSearch(input: {
  query: string;
  category?: string;
}): Promise<string> {
  const { query, category } = input;
  const memoryDir = resolveMemoryDir();
  const indexDir = ragIndexDir(memoryDir);
  const searchDir = category ? `${memoryDir}/${category}` : memoryDir;
  const terms = parseSearchTerms(query);
  const rgTerms = terms.length > 0 ? terms : [query];

  const hasRag = await ensureRag();

  const [rgResult, ragResultText] = await Promise.all([
    Bun.$`rg ${buildRgArgs(rgTerms)} ${searchDir}`.text().catch(() => ""),
    hasRag
      ? ragSearch({ query, indexDir, topK: 15 })
      : Promise.resolve(""),
  ]);

  const resultMap = new Map<
    string,
    { rgMatch: boolean; ragScore?: number; ragText?: string }
  >();

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
    const globalRgText = await Bun.$`rg ${buildRgArgs(rgTerms)} ${memoryDir}`
      .text()
      .catch(() => "");
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
    const scanDir = category ? `${memoryDir}/${category}` : memoryDir;
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
          .map((s) => `  - ~/opencode-memory/${s}`)
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

  for (const [path, info] of resultMap) {
    try {
      const content = await Bun.file(`${memoryDir}/${path}`).text();
      const { meta } = parseFrontmatter(content);
      const termMatches =
        terms.length > 0
          ? countTermMatches(content, terms)
          : info.rgMatch
            ? 1
            : 0;

      const score = scoreCandidate({
        rgMatch: info.rgMatch,
        ragScore: info.ragScore,
        termMatches,
        totalTerms: terms.length,
        tags: meta.tags,
        path,
        importance: meta.importance,
        accessCount: meta.access_count,
        terms,
      });

      results.push({ path, meta, score, termMatches, ...info });
    } catch {
      // file read failed — skip
    }
  }

  results.sort((a, b) => b.score - a.score);

  const lines = [`## Results for "${query}" (${results.length} matches)\n`];
  if (crossCategoryFallback) {
    lines.push(
      `_No results in **${category}/** — showing matches from all categories:_\n`,
    );
  }
  if (terms.length > 1) {
    lines.push(`_Searching for: ${terms.join(", ")}_\n`);
  }
  // Filter out low-relevance results — raised threshold to reduce noise.
  const filtered = results.filter((r) => r.score >= 0.2);
  const topResults = filtered.length > 0 ? filtered : results.slice(0, 3);

  const FULL_DETAIL_COUNT = 3;
  const MAX_RESULTS = 7;

  for (const [i, r] of topResults.slice(0, MAX_RESULTS).entries()) {
    const isDirectHit =
      r.rgMatch &&
      r.ragScore !== undefined &&
      r.ragScore > 0.4 &&
      r.termMatches === terms.length;
    const hitLabel = isDirectHit ? " ★ DIRECT HIT" : "";

    if (i < FULL_DETAIL_COUNT) {
      lines.push(
        `${i + 1}. **${r.path}** [${r.meta.importance || "medium"}]${hitLabel}`,
      );
      if (r.meta.tags?.length) lines.push(`   Tags: ${r.meta.tags.join(", ")}`);
      if (r.meta.summary) lines.push(`   ${r.meta.summary}`);
      const sources: string[] = [];
      if (r.rgMatch) {
        const termInfo =
          terms.length > 1 ? ` (${r.termMatches}/${terms.length} terms)` : "";
        sources.push(`keyword${termInfo}`);
      }
      if (r.ragScore) sources.push(`semantic: ${r.ragScore.toFixed(2)}`);
      lines.push(`   Match: ${sources.join(" + ")} | score: ${r.score.toFixed(2)}`);
      if (r.meta.related?.length)
        lines.push(`   Related: ${r.meta.related.join(", ")}`);
      if (r.ragText) {
        lines.push(`   Preview: "...${r.ragText.slice(0, 200).trim()}..."`);
      }
    } else {
      const summary = r.meta.summary ? ` — ${r.meta.summary}` : "";
      lines.push(
        `${i + 1}. **${r.path}** [${r.meta.importance || "medium"}]${summary}`,
      );
    }
    lines.push("");
  }

  if (topResults.length > 0) {
    lines.push(
      `_Read the top result: \`~/opencode-memory/${topResults[0].path}\`_`,
    );
    lines.push("");
  }

  // Collect Related: files that weren't in the primary result set so the
  // caller can pursue interesting cross-references.
  const shownPaths = new Set(topResults.slice(0, 7).map((r) => r.path));
  const relatedSuggestions: string[] = [];
  for (const r of topResults.slice(0, 7)) {
    for (const rel of r.meta.related || []) {
      if (!shownPaths.has(rel) && !relatedSuggestions.includes(rel)) {
        relatedSuggestions.push(rel);
      }
    }
  }

  const verified: string[] = [];
  for (const rel of relatedSuggestions) {
    try {
      if (await Bun.file(`${memoryDir}/${rel}`).exists()) verified.push(rel);
    } catch {
      // ignore — file doesn't exist
    }
  }

  if (verified.length > 0) {
    lines.push("---");
    lines.push(
      "**Related files** (not in results — use the Read tool on ~/opencode-memory/{path}):",
    );
    for (const rel of verified) {
      lines.push(`  - ${rel}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export const list = tool({
  description:
    "Browse memories in ~/opencode-memory/. Without a category, lists all categories with file counts. " +
    "With a category, lists files in that category with their summaries.",
  args: {
    category: tool.schema
      .string()
      .optional()
      .describe(
        "Category to list: preferences, repos, technical, people, workflows, snippets, notes",
      ),
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
          cwd: `${memoryDir}/${cat}`,
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

  const catDir = `${memoryDir}/${category}`;
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
        const content = await Bun.file(`${catDir}/${f}`).text();
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
    lines.push(
      `- **${f.path}** [${f.importance}] ${f.updated ? `(${f.updated})` : ""}`,
    );
    if (f.summary) lines.push(`  ${f.summary}`);
  }
  return lines.join("\n");
}

export const access = tool({
  description:
    "Record that a memory file was accessed (read and used). Updates last_accessed date " +
    "and increments access_count in frontmatter. Call this AFTER reading a memory file " +
    "that you actually used to inform your work — not for casual browsing.\n\n" +
    "This helps the memory system track which memories are actively useful vs. stale.",
  args: {
    path: tool.schema
      .string()
      .describe(
        "Relative path within ~/opencode-memory/ (e.g. 'technical/build-tooling.md')",
      ),
  },
  async execute({ path }) {
    return runAccess({ path });
  },
});

export async function runAccess(input: { path: string }): Promise<string> {
  const memoryDir = resolveMemoryDir();
  const { path } = input;
  const filePath = `${memoryDir}/${path}`;
  try {
    const content = await Bun.file(filePath).text();
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fmMatch) return `No frontmatter in ${path} — skipped`;

    const yaml = fmMatch[1];
    const body = fmMatch[2];
    const dateStr = todayISO();
    const { yaml: updatedYaml, newCount } = bumpAccessFields(yaml, dateStr);

    await Bun.write(filePath, `---\n${updatedYaml}\n---\n${body}`);
    return `Recorded access for ${path} (count: ${newCount})`;
  } catch {
    return `Could not update ${path}`;
  }
}

export const save = tool({
  description:
    "Commit and re-index all pending memory changes. " +
    "Call AFTER using Write/Edit tools on ~/opencode-memory/{category}/{filename}.md. " +
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
    "2. Write/Edit files at ~/opencode-memory/{category}/{filename}.md\n" +
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
    "---",
  args: {},
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
    const diff = await Bun.$`git -C ${memoryDir} diff --name-only --cached`
      .text()
      .catch(() => "");
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

  const hasRag = await ensureRag();
  if (hasRag) {
    spawnRagIndex({ memoryDir, indexDir });
  }

  if (changed.length === 0) {
    return "No changes to sync";
  }

  const result = `Synced: ${changed.join(", ")}`;
  return hasRag ? result : `${result}\n\n${installGuidance()}`;
}

export const setup = tool({
  description:
    "One-time setup helper: reports whether the `rag` binary and `cargo` are " +
    "available, and prints installation guidance if semantic search isn't " +
    "wired up yet. Safe to run at any time — does not modify anything.",
  args: {},
  async execute() {
    return runSetup();
  },
});

export async function runSetup(): Promise<string> {
  const status = await probeRag();
  const lines: string[] = [];
  lines.push(
    `rag binary: ${status.installed ? "installed" : "NOT installed"}`,
  );
  lines.push(
    `cargo (Rust toolchain): ${status.cargoAvailable ? "installed" : "NOT installed"}`,
  );
  lines.push("");
  if (status.installed) {
    lines.push(
      "All set — semantic search is available. Run `rag download` to pre-cache the embedding model if you haven't already.",
    );
  } else {
    lines.push(installGuidance());
  }
  return lines.join("\n");
}
