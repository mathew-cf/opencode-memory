/**
 * Thin wrappers around the `rag` CLI (https://github.com/mathew-cf/rag-cli).
 *
 * `@mathew-cf/rag-cli` is declared as a runtime dependency of this plugin,
 * so its JS shim and a native binary for supported platforms are installed.
 *
 * We resolve the native binary from the shim's package context at call time
 * rather than trusting `$PATH`, because:
 *   - opencode installs plugins into a cache dir whose `node_modules/.bin`
 *     is NOT on $PATH when the plugin's code runs.
 *   - An absolute path also fails loudly if the dep is missing, which is
 *     easier to diagnose than a confusing "command not found".
 *
 * If resolution fails (broken install or unsupported platform), public
 * helpers return empty results and setup reports the missing binary.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ESM → CommonJS bridge. `import.meta.url` works both in the source tree
// and in the bundled dist/index.js output (bun build preserves it).
const require = createRequire(import.meta.url);

export interface RagStatus {
  /** Absolute path to the native executable, if resolvable. */
  binaryPath: string | null;
}

/**
 * Resolve the native executable relative to rag-cli's shim. Resolving from
 * there also works when the platform package is nested under rag-cli rather
 * than hoisted next to this plugin. A JS shim cannot be spawned directly on
 * Windows, so a missing platform package must return null.
 *
 * Exported so tests can assert the resolution behaviour directly.
 */
export function resolveRagBinary(
  platform = process.platform,
  arch = process.arch,
  resolveFromShim?: (specifier: string) => string,
): string | null {
  if (!resolveFromShim && platform === process.platform && arch === process.arch && process.env.OPENCODE_MEMORY_RAG_BINARY) {
    return process.env.OPENCODE_MEMORY_RAG_BINARY;
  }
  try {
    const shim = require.resolve("@mathew-cf/rag-cli/bin/rag.js");
    const resolve = resolveFromShim ?? createRequire(shim).resolve;
    const filename = platform === "win32" ? "rag.exe" : "rag";
    return resolve(`@mathew-cf/rag-cli-${platform}-${arch}/bin/${filename}`);
  } catch {
    return null;
  }
}

export interface KeywordFilesRequest {
  root: string;
  configPath?: string;
  patterns: string[];
  globs: string[];
  fixedStrings?: boolean;
}

/** Live file search; exit 1 means no matches, while errors permit caller fallback. */
export async function runRagKeywordFiles(
  binary: string,
  request: KeywordFilesRequest,
  runner: RagCommandRunner = runRagCommand,
): Promise<string[] | undefined> {
  const args = [binary, "keyword", "--files-with-matches", "--ignore-case"];
  if (request.fixedStrings) args.push("--fixed-strings");
  for (const glob of request.globs) args.push("--glob", glob);
  for (const pattern of request.patterns) args.push("-e", pattern);
  if (request.configPath) args.push("--config", request.configPath, "--only", "memory");
  else args.push(request.root);
  const result = await runner(args);
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) return undefined;
  return result.stdout.split("\n").filter(Boolean);
}

export async function ragKeywordFiles(request: KeywordFilesRequest): Promise<string[] | undefined> {
  const binary = resolveRagBinary();
  if (!binary) return undefined;
  return runRagKeywordFiles(binary, request).catch(() => undefined);
}

export async function keywordAvailable(): Promise<boolean> {
  const binary = resolveRagBinary();
  if (!binary) return false;
  return runRagCommand([binary, "keyword", "--help"])
    .then((result) => result.exitCode === 0)
    .catch(() => false);
}

/**
 * Probe once for the installation status. Kept as a separate function
 * (even though it's currently a thin wrapper) so future logic around
 * caching, version checks, or alternate lookup paths has a single home.
 */
export function probeRag(): RagStatus {
  return { binaryPath: resolveRagBinary() };
}

/** True iff the native executable is resolvable. */
export function ragAvailable(): boolean {
  return resolveRagBinary() !== null;
}

/**
 * Human-readable guidance for when `rag` can't be resolved. Called from
 * error paths and from `memory_setup` so the message lives in one place.
 *
 * With rag-cli as a declared dependency, the expected remedy is a
 * reinstall — not a separate `cargo install` dance.
 */
export function installGuidance(): string {
  return [
    "Semantic search is unavailable: the native `@mathew-cf/rag-cli` binary",
    "could not be resolved from this plugin's node_modules.",
    "",
    "Usually this means one of:",
    "  - Your host platform isn't covered by the prebuilt binaries",
    "    (supported: macOS ARM64/x64, Linux x64/ARM64, Windows x64).",
    "  - `npm install` or the equivalent plugin install skipped",
    "    optionalDependencies.",
    "",
    "Remedies:",
    "  1. Reinstall the plugin. If using OpenCode, delete",
    "     `~/.cache/opencode/node_modules` and restart.",
    "  2. On an unsupported platform, install rag-cli from source:",
    "       cargo install rag-cli",
    "",
    "Without rag, keyword and semantic search are unavailable.",
  ].join("\n");
}

/**
 * Run `rag search` against an index. Returns the raw JSON text so callers
 * can parse it themselves. Any failure (missing binary, missing index,
 * parse error upstream) resolves to the empty string — degrading
 * gracefully rather than propagating shell exceptions.
 */
export interface RagCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RagCommandRunner = (argv: string[]) => Promise<RagCommandResult>;

/** Native model libraries can append diagnostics to stdout after rag's JSON. */
export function parseRagJsonArray(output: string): unknown[] {
  const text = output.trimStart();
  if (!text.startsWith("[")) return [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === "[") {
      depth++;
    } else if (char === "]" && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(text.slice(0, i + 1));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
  }
  return [];
}

/** Use the memory store's config when present; older stores retain path-based commands. */
export function memoryRagConfigPath(memoryDir: string): string | undefined {
  for (const name of ["rag.toml", ".rag.toml"]) {
    const path = join(memoryDir, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** Rust's home-directory lookup needs HOME even on Windows. */
export function ragProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = env.HOME || env.USERPROFILE;
  return home ? { ...env, HOME: home } : { ...env };
}

async function runRagCommand(argv: string[]): Promise<RagCommandResult> {
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: ragProcessEnv() });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function groupBySourceUnsupported(stderr: string): boolean {
  return (
    stderr.includes("--group-by-source") &&
    /unexpected argument|unknown (?:argument|option)|unrecognized option/i.test(stderr)
  );
}

/**
 * Execute a semantic search with source diversification. Exported with an
 * injectable runner so compatibility behavior can be tested without spawning
 * the installed binary.
 */
export async function runRagSearch(
  binary: string,
  args: { query: string; indexDir: string; configPath?: string; topK?: number },
  runner: RagCommandRunner = runRagCommand,
): Promise<string> {
  const base = [
    binary,
    "search",
    args.query,
    ...(args.configPath
      ? ["--config", args.configPath, "--only", "memory", "--no-hybrid"]
      : ["-i", args.indexDir]),
    "-k",
    String(args.topK ?? 15),
    "--json",
  ];
  const grouped = await runner([...base, "--group-by-source"]);
  if (grouped.exitCode === 0) return grouped.stdout;

  // rag-cli releases before --group-by-source should remain usable. Retry
  // only the specific CLI-argument failure; real search failures still degrade
  // normally instead of doing duplicate work.
  if (groupBySourceUnsupported(grouped.stderr)) {
    const legacy = await runner(base);
    if (legacy.exitCode === 0) return legacy.stdout;
  }
  return "";
}

export async function ragSearch(args: {
  query: string;
  indexDir: string;
  configPath?: string;
  topK?: number;
}): Promise<string> {
  const binary = resolveRagBinary();
  if (!binary) return "";
  return runRagSearch(binary, args).catch(() => "");
}

/** Search every source in one knowledge base, honoring its rag.toml search settings. */
export async function runRagKnowledgeSearch(
  binary: string,
  configPath: string,
  query: string,
  topK: number,
  runner: RagCommandRunner = runRagCommand,
): Promise<RagCommandResult> {
  return runner([
    binary, "search", query, "--config", configPath,
    "--group-by-source", "--json", "-k", String(topK),
  ]);
}

/**
 * Spawn `rag index` as a detached background process. The caller does
 * not block on the index build because it can be slow on large corpora
 * and users don't want their save operations to stall.
 *
 * Returns `true` if we kicked off an index build, `false` if the binary
 * couldn't be resolved.
 */
export function spawnRagIndex(args: {
  memoryDir: string;
  indexDir: string;
  configPath?: string;
}): boolean {
  const binary = resolveRagBinary();
  if (!binary) return false;
  try {
    Bun.spawn(args.configPath
      ? [binary, "index", "--config", args.configPath, "--only", "memory"]
      : [binary, "index", args.memoryDir, "-o", args.indexDir], {
      stdout: "ignore",
      stderr: "ignore",
      env: ragProcessEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-download the embedding model by running `rag download`. Returns a
 * human-readable status string — either the command's output or the
 * installation guidance if the binary isn't resolvable.
 */
export async function downloadModel(): Promise<string> {
  const binary = resolveRagBinary();
  if (!binary) return installGuidance();

  try {
    const result = await runRagCommand([binary, "download"]);
    if (result.exitCode !== 0) {
      return `rag download failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`;
    }
    return result.stdout.trim() || "Model downloaded.";
  } catch (err) {
    return `rag download failed: ${String(err)}`;
  }
}
