/**
 * Thin wrappers around the `rag` CLI (https://github.com/mathew-cf/rag-cli).
 *
 * `@mathew-cf/rag-cli` is declared as a runtime dependency of this plugin,
 * so its JS shim is always available in `node_modules/@mathew-cf/rag-cli/
 * bin/rag.js` after installation. The shim handles platform detection and
 * execs the platform-specific prebuilt binary published alongside it.
 *
 * We resolve the shim's absolute path via `require.resolve` at call time
 * rather than trusting `$PATH`, because:
 *   - opencode installs plugins into a cache dir whose `node_modules/.bin`
 *     is NOT on $PATH when the plugin's code runs.
 *   - An absolute path also fails loudly if the dep is missing, which is
 *     easier to diagnose than a confusing "command not found".
 *
 * Semantic search is still optional: if resolution fails for any reason
 * (broken install, unusual layout, native binary missing for the host
 * platform), every public helper here degrades gracefully. Callers see
 * `null` from `resolveRagBinary()` and fall back to keyword-only search.
 */

import { createRequire } from "node:module";

// ESM → CommonJS bridge. `import.meta.url` works both in the source tree
// and in the bundled dist/index.js output (bun build preserves it).
const require = createRequire(import.meta.url);

export interface RagStatus {
  /** Absolute path to the JS shim, if resolvable. `null` otherwise. */
  shimPath: string | null;
}

/**
 * Locate the rag shim via node module resolution. Returns `null` when the
 * package isn't installed (usually indicates the user added the plugin
 * via a non-standard loader that skipped optionalDependencies or the
 * rag-cli package failed to install for their platform).
 *
 * Exported so tests can assert the resolution behaviour directly.
 */
export function resolveRagBinary(): string | null {
  try {
    return require.resolve("@mathew-cf/rag-cli/bin/rag.js");
  } catch {
    return null;
  }
}

/**
 * Probe once for the installation status. Kept as a separate function
 * (even though it's currently a thin wrapper) so future logic around
 * caching, version checks, or alternate lookup paths has a single home.
 */
export function probeRag(): RagStatus {
  return { shimPath: resolveRagBinary() };
}

/** True iff the shim is resolvable. */
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
    "Semantic search is unavailable: the `@mathew-cf/rag-cli` package",
    "could not be resolved from this plugin's node_modules.",
    "",
    "Usually this means one of:",
    "  - Your host platform isn't covered by the prebuilt binaries",
    "    (supported: macOS ARM64/x64, Linux x64/ARM64).",
    "  - `npm install` or the equivalent plugin install skipped",
    "    optionalDependencies.",
    "",
    "Remedies:",
    "  1. Reinstall the plugin. If using OpenCode, delete",
    "     `~/.cache/opencode/node_modules` and restart.",
    "  2. On an unsupported platform, install rag-cli from source:",
    "       cargo install rag-cli",
    "",
    "Without rag, keyword search (ripgrep) still works — you just won't",
    "get semantic/similarity-based results.",
  ].join("\n");
}

/**
 * Run `rag search` against an index. Returns the raw JSON text so callers
 * can parse it themselves. Any failure (missing shim, missing index,
 * parse error upstream) resolves to the empty string — degrading
 * gracefully rather than propagating shell exceptions.
 */
export async function ragSearch(args: {
  query: string;
  indexDir: string;
  topK?: number;
}): Promise<string> {
  const shim = resolveRagBinary();
  if (!shim) return "";
  const k = String(args.topK ?? 15);
  return Bun.$`${shim} search ${args.query} -i ${args.indexDir} -k ${k} --json`
    .text()
    .catch(() => "");
}

/**
 * Spawn `rag index` as a detached background process. The caller does
 * not block on the index build because it can be slow on large corpora
 * and users don't want their save operations to stall.
 *
 * Returns `true` if we kicked off an index build, `false` if the shim
 * couldn't be resolved.
 */
export function spawnRagIndex(args: {
  memoryDir: string;
  indexDir: string;
}): boolean {
  const shim = resolveRagBinary();
  if (!shim) return false;
  Bun.spawn([shim, "index", args.memoryDir, "-o", args.indexDir], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return true;
}

/**
 * Pre-download the embedding model by running `rag download`. Returns a
 * human-readable status string — either the command's output or the
 * installation guidance if the shim isn't resolvable.
 */
export async function downloadModel(): Promise<string> {
  const shim = resolveRagBinary();
  if (!shim) return installGuidance();

  try {
    const out = await Bun.$`${shim} download`.text();
    return out.trim() || "Model downloaded.";
  } catch (err) {
    return `rag download failed: ${String(err)}`;
  }
}
