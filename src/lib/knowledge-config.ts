import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expandHomePath, resolveHome } from "./paths";

export interface KnowledgeBase {
  name: string;
  path: string;
  default: boolean;
}

export interface KnowledgeConfig {
  bases: KnowledgeBase[];
  defaultName?: string;
  configPath: string;
}

export function knowledgeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCODE_MEMORY_CONFIG
    ? resolve(expandHomePath(env.OPENCODE_MEMORY_CONFIG, env))
    : join(resolveHome(env), ".config", "opencode-memory", "config.toml");
}

export function resolveKnowledgePath(path: string, configPath: string): string {
  const expanded = expandHomePath(path);
  return resolve(isAbsolute(expanded) ? expanded : join(dirname(configPath), expanded));
}

/** Names and paths live outside the memory corpus; every base owns its rag.toml. */
export async function loadKnowledgeConfig(path = knowledgeConfigPath()): Promise<KnowledgeConfig> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { bases: [], configPath: path };
    }
    throw error;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(content) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid knowledge config ${path}: ${String(error)}`);
  }
  const entries = parsed.knowledge_base;
  if (entries === undefined) return { bases: [], configPath: path };
  if (!Array.isArray(entries)) throw new Error("knowledge_base must be an array of TOML tables");

  const names = new Set<string>();
  const bases = entries.map((entry, index): KnowledgeBase => {
    if (!entry || typeof entry !== "object") throw new Error(`knowledge_base entry ${index + 1} must be a table`);
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(row.name)) {
      throw new Error(`knowledge_base entry ${index + 1} needs a name using letters, digits, _ or -`);
    }
    if (names.has(row.name)) throw new Error(`Duplicate knowledge base name: ${row.name}`);
    names.add(row.name);
    if (typeof row.path !== "string" || !row.path.trim()) {
      throw new Error(`knowledge_base ${row.name} needs a directory path`);
    }
    if (row.default !== undefined && typeof row.default !== "boolean") {
      throw new Error(`knowledge_base ${row.name}: default must be true or false`);
    }
    return { name: row.name, path: resolveKnowledgePath(row.path, path), default: row.default === true };
  });
  const defaults = bases.filter((base) => base.default);
  if (defaults.length > 1) throw new Error("Only one knowledge base can have default = true");
  return {
    bases,
    defaultName: defaults[0]?.name ?? (bases.length === 1 ? bases[0].name : undefined),
    configPath: path,
  };
}
