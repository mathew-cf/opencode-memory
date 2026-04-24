/**
 * Thin wrappers around the `rag` CLI (https://github.com/mathew-cf/rag-cli).
 *
 * The design principle here is: semantic search is optional. `rag` is a
 * Rust binary that needs to be installed separately; it may not be available
 * in every environment. None of the memory tools require it — they just
 * degrade gracefully to keyword-only ranking when it's absent.
 *
 * These helpers also centralize the fallback install attempt (`cargo install
 * rag-cli`) and the user-facing install guidance, so the message stays
 * consistent everywhere.
 */

export interface RagStatus {
  /** True if the `rag` binary is currently on PATH. */
  installed: boolean;
  /** True if `cargo` is on PATH (and we could attempt an auto-install). */
  cargoAvailable: boolean;
}

/**
 * Check whether the `rag` and `cargo` binaries are currently available.
 * Does not side-effect — pure probe.
 */
export async function probeRag(): Promise<RagStatus> {
  const [ragOk, cargoOk] = await Promise.all([
    Bun.$`which rag`
      .quiet()
      .then(() => true)
      .catch(() => false),
    Bun.$`which cargo`
      .quiet()
      .then(() => true)
      .catch(() => false),
  ]);
  return { installed: ragOk, cargoAvailable: cargoOk };
}

/**
 * Make sure `rag` is callable. If it's not installed but `cargo` is, attempt
 * a one-time install. Returns true on success, false otherwise. Callers
 * should treat `false` as "semantic search is unavailable" — never as a
 * hard error.
 *
 * The auto-install path is intentionally silent: we don't want to spam the
 * user's terminal mid-search with cargo output. If they want visibility,
 * they can run `rag-cli-install` explicitly (see `installGuidance()`).
 */
export async function ensureRag(): Promise<boolean> {
  const status = await probeRag();
  if (status.installed) return true;
  if (!status.cargoAvailable) return false;

  try {
    await Bun.$`cargo install rag-cli`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Human-readable guidance for installing `rag` manually. Called from error
 * paths and from `memory_setup` so the message lives in one place.
 */
export function installGuidance(): string {
  return [
    "Semantic search is unavailable: the `rag` binary is not installed.",
    "",
    "To enable it:",
    "  1. Install Rust (if you don't have it): https://rustup.rs",
    "  2. Install rag-cli:",
    "       cargo install rag-cli",
    "  3. Pre-download the default embedding model (optional but faster first search):",
    "       rag download",
    "",
    "Without rag, keyword search (ripgrep) still works — you just won't get",
    "semantic/similarity-based results.",
  ].join("\n");
}

/**
 * Run `rag search` against an index. Returns the raw JSON text so callers
 * can parse it themselves. Any failure (missing binary, missing index,
 * parse error upstream) resolves to the empty string — again, degrading
 * gracefully.
 */
export async function ragSearch(args: {
  query: string;
  indexDir: string;
  topK?: number;
}): Promise<string> {
  const k = String(args.topK ?? 15);
  return Bun.$`rag search ${args.query} -i ${args.indexDir} -k ${k} --json`
    .text()
    .catch(() => "");
}

/**
 * Spawn `rag index` as a detached background process. The caller does not
 * block on the index build because it can be slow on large corpora and
 * users don't want their save operations to stall.
 */
export function spawnRagIndex(args: {
  memoryDir: string;
  indexDir: string;
}): void {
  Bun.spawn(["rag", "index", args.memoryDir, "-o", args.indexDir], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

/**
 * Pre-download the embedding model by running `rag download`. Returns a
 * human-readable status string. If rag is missing, returns the install
 * guidance instead of attempting to download.
 */
export async function downloadModel(): Promise<string> {
  const status = await probeRag();
  if (!status.installed) return installGuidance();

  try {
    const out = await Bun.$`rag download`.text();
    return out.trim() || "Model downloaded.";
  } catch (err) {
    return `rag download failed: ${String(err)}`;
  }
}
