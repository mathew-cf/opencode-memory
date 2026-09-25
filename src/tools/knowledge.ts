/** Read-only search across named knowledge bases. Each base owns its rag.toml. */
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import { loadKnowledgeConfig, resolveKnowledgePath, type KnowledgeBase, type KnowledgeConfig } from "../lib/knowledge-config";
import { normPath, resolveContainedPath } from "../lib/paths";
import { installGuidance, parseRagJsonArray, resolveRagBinary, runRagKnowledgeSearch, type RagCommandResult } from "../lib/rag";
import { defineTool } from "../lib/tool-definition";

const DEFAULT_RESULTS = 5;
const DEFAULT_READ_CHARS = 4000;

export interface KnowledgeHit {
  index_name: string;
  source: string;
  score: number;
  text: string;
}

export function parseKnowledgeHits(text: string): KnowledgeHit[] {
  return parseRagJsonArray(text).filter((hit): hit is KnowledgeHit => {
    if (!hit || typeof hit !== "object") return false;
    const row = hit as Partial<KnowledgeHit>;
    return typeof row.index_name === "string" && typeof row.source === "string" &&
      typeof row.score === "number" && Number.isFinite(row.score) &&
      typeof row.text === "string";
  });
}

export function ragConfigForBase(base: KnowledgeBase): string | undefined {
  for (const name of ["rag.toml", ".rag.toml"]) {
    const path = join(base.path, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

function selectBases(config: KnowledgeConfig, base?: string, all?: boolean): KnowledgeBase[] {
  if (base && all) throw new Error("Use either base or all, not both");
  if (config.bases.length === 0) {
    throw new Error(`No knowledge bases configured. Add [[knowledge_base]] entries to ${config.configPath}`);
  }
  if (all) return config.bases;
  if (base) {
    const found = config.bases.find((candidate) => candidate.name === base);
    if (!found) throw new Error(`Unknown knowledge base: ${base}. Available: ${config.bases.map((item) => item.name).join(", ")}`);
    return [found];
  }
  if (!config.defaultName) {
    throw new Error(`Multiple knowledge bases are configured. Choose base (${config.bases.map((item) => item.name).join(", ")}) or all=true`);
  }
  return [config.bases.find((item) => item.name === config.defaultName)!];
}

export const list = defineTool({
  description: "List configured knowledge bases, their names, and which one is the default. Call before knowledge_search when the available bases are unknown.",
  input: z.object({}),
  async execute() { return { content: await runKnowledgeList() }; },
});

export async function runKnowledgeList(): Promise<string> {
  try {
    const config = await loadKnowledgeConfig();
    if (!config.bases.length) return `No knowledge bases configured. Add [[knowledge_base]] entries to ${config.configPath}`;
    return config.bases.map((base) =>
      `${base.name}${base.name === config.defaultName ? " (default)" : ""}: ${base.path}${ragConfigForBase(base) ? "" : " (rag.toml missing)"}`,
    ).join("\n");
  } catch (error) {
    return `Knowledge config error: ${String(error)}`;
  }
}

export type KnowledgeSearchRunner = (
  binary: string, configPath: string, query: string, topK: number,
) => Promise<RagCommandResult>;

export const search = defineTool({
  description: "Search a named knowledge base's indexed sources using its rag.toml search settings. Omit base for the default; set all=true to search every configured base. Use knowledge_read with a result's base, index, and source for full text.",
  input: z.object({
    query: z.string().describe("Search query"),
    base: z.string().optional().describe("Knowledge base name; omit for the default"),
    all: z.boolean().optional().describe("Search every configured knowledge base"),
    limit: z.number().optional().describe("Results per knowledge base (default 5, maximum 20)"),
  }),
  async execute(input) { return { content: await runKnowledgeSearch(input) }; },
});

export async function runKnowledgeSearch(
  input: { query: string; base?: string; all?: boolean; limit?: number },
  runner: KnowledgeSearchRunner = runRagKnowledgeSearch,
  binary: string | null = resolveRagBinary(),
): Promise<string> {
  if (!input.query.trim()) return "Provide a knowledge search query.";
  if (!binary) return installGuidance();
  try {
    const config = await loadKnowledgeConfig();
    const bases = selectBases(config, input.base, input.all);
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(20, Math.trunc(input.limit!))) : DEFAULT_RESULTS;
    // Each rag process loads the embedding model and its indexes. Search bases
    // one at a time so `all` does not multiply peak memory use.
    const sections: string[] = [];
    for (const base of bases) {
      const ragConfig = ragConfigForBase(base);
      if (!ragConfig) {
        sections.push(`## ${base.name}\nMissing rag.toml in ${base.path}`);
        continue;
      }
      try {
        const result = await runner(binary, ragConfig, input.query, limit);
        if (result.exitCode !== 0) {
          sections.push(`## ${base.name}\nSearch failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
          continue;
        }
        const hits = parseKnowledgeHits(result.stdout).slice(0, limit);
        if (!hits.length) {
          sections.push(`## ${base.name}\nNo matches.`);
          continue;
        }
        sections.push(`## ${base.name}\n` + hits.map((hit, index) => {
          const snippet = hit.text.replace(/\s+/g, " ").trim().slice(0, 300);
          return `${index + 1}. ${hit.index_name}/${hit.source} (score ${hit.score.toFixed(3)})\n   ${snippet}\n   knowledge_read(base="${base.name}", index="${hit.index_name}", source="${hit.source}")`;
        }).join("\n"));
      } catch (error) {
        sections.push(`## ${base.name}\nSearch failed: ${String(error)}`);
      }
    }
    return sections.join("\n\n");
  } catch (error) {
    return `Knowledge search error: ${String(error)}`;
  }
}

async function indexedSource(base: KnowledgeBase, indexName: string, source: string): Promise<string> {
  const ragConfig = ragConfigForBase(base);
  if (!ragConfig) throw new Error(`Missing rag.toml in ${base.path}`);
  const parsed = Bun.TOML.parse(await readFile(ragConfig, "utf8")) as Record<string, unknown>;
  const indexes = parsed.index;
  if (!Array.isArray(indexes)) throw new Error(`No indexes in ${ragConfig}`);
  const entry = indexes.find((row) => row && typeof row === "object" && (row as Record<string, unknown>).name === indexName) as Record<string, unknown> | undefined;
  if (!entry || typeof entry.path !== "string") throw new Error(`Unknown index ${indexName} in ${base.name}`);
  const root = resolveKnowledgePath(entry.path, ragConfig);
  const output = entry.output === undefined
    ? join(base.path, ".rag", indexName)
    : typeof entry.output === "string"
      ? resolveKnowledgePath(entry.output, ragConfig)
      : undefined;
  if (!output) throw new Error(`Invalid output for index ${indexName}`);
  const meta = JSON.parse(await readFile(join(output, "meta.json"), "utf8")) as {
    file_hashes?: Record<string, unknown>;
    source_root_from_index?: string;
  };
  const relativeSource = normPath(source);
  if (!meta.file_hashes || !Object.prototype.hasOwnProperty.call(meta.file_hashes, relativeSource)) {
    throw new Error(`Source is not indexed in ${base.name}/${indexName}: ${source}`);
  }
  if (typeof meta.source_root_from_index !== "string") throw new Error(`Index ${indexName} has no source root`);
  const [configuredRoot, indexedRoot] = await Promise.all([
    realpath(root), realpath(resolve(output, meta.source_root_from_index)),
  ]);
  if (configuredRoot !== indexedRoot) throw new Error(`Index ${indexName} was built from a different source directory`);
  return root;
}

export const read = defineTool({
  description: "Read a bounded section of a knowledge search result from its source file. Pass the base, index, and source exactly as returned by knowledge_search.",
  input: z.object({
    base: z.string().optional().describe("Knowledge base name; omit for the default"),
    index: z.string().describe("Index name returned by knowledge_search"),
    source: z.string().describe("Source path returned by knowledge_search, relative to its index root"),
    offset: z.number().optional().describe("Character offset for continuation (default 0)"),
    max_chars: z.number().optional().describe("Maximum characters (default 4000, maximum 16000)"),
  }),
  async execute(input) { return { content: await runKnowledgeRead(input) }; },
});

export async function runKnowledgeRead(input: {
  base?: string; index: string; source: string; offset?: number; max_chars?: number;
}): Promise<string> {
  try {
    const base = selectBases(await loadKnowledgeConfig(), input.base)[0];
    const root = await indexedSource(base, input.index, input.source);
    const file = resolveContainedPath(root, input.source);
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    const rel = relative(realRoot, realFile);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("source escapes its configured root");
    }
    const content = await readFile(realFile, "utf8");
    const offset = Number.isFinite(input.offset) ? Math.max(0, Math.trunc(input.offset!)) : 0;
    const maxChars = Number.isFinite(input.max_chars) ? Math.max(1, Math.min(16000, Math.trunc(input.max_chars!))) : DEFAULT_READ_CHARS;
    let position = 0;
    let excerpt = "";
    let more = false;
    for (const char of content) {
      if (position >= offset + maxChars) {
        more = true;
        break;
      }
      if (position >= offset) excerpt += char;
      position++;
    }
    return `${base.name}/${input.index}/${input.source}\n\n${excerpt}${more ? `\n\n[Continue with offset=${position}]` : ""}`;
  } catch (error) {
    return `Could not read knowledge source: ${String(error)}`;
  }
}
