/**
 * Cross-platform path helpers.
 *
 * The memory and session tools were originally written for macOS/Linux where
 * paths use forward slashes and process.env.HOME is always set. On Windows,
 * both assumptions break. These helpers centralize the compatibility shim so
 * the rest of the plugin can assume a single canonical path shape.
 */

import { DEFAULT_MEMORY_SUBDIR, RAG_INDEX_SUBDIR } from "../constants";

/**
 * Resolve the user's home directory across platforms.
 *
 * Unix conventionally exposes the home via $HOME; Windows exposes it via
 * %USERPROFILE%. When both are set, HOME wins so explicit overrides work
 * on either platform. Backslashes in the resolved value are normalized to
 * forward slashes so downstream string operations behave uniformly.
 *
 * Empty-string values are treated as unset (so an inherited-but-blank
 * HOME on Windows falls through to USERPROFILE). Throws if neither
 * variable resolves to a non-empty string — silently returning an empty
 * path would cause every downstream file operation to resolve against
 * the filesystem root, which is both surprising and extremely hard to
 * debug.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HOME || env.USERPROFILE;
  if (!raw) {
    throw new Error(
      "Cannot resolve home directory: neither HOME nor USERPROFILE is set. " +
        "On Windows, add `if (-not $env:HOME) { $env:HOME = $env:USERPROFILE }` to your PowerShell profile.",
    );
  }
  return normPath(raw);
}

/**
 * Normalize a filesystem path to use forward slashes.
 *
 * On Windows, ripgrep emits paths with backslashes even when invoked with
 * forward-slash arguments. When our code strips a forward-slash MEMORY_DIR
 * prefix from a backslash-separated rg output line, the replace silently
 * fails and the prefix is left in place — which breaks every downstream
 * file read. Normalizing rg output through this helper restores the
 * invariant that paths handled inside the tool always use /.
 *
 * On macOS/Linux this is a no-op: paths already use forward slashes.
 */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Resolve the root memory directory. Honors `$MEMORY_DIR` (used by tests
 * and by users who keep their knowledge base in a non-default location),
 * falling back to `$HOME/opencode-memory`.
 */
export function resolveMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MEMORY_DIR && env.MEMORY_DIR.length > 0) return normPath(env.MEMORY_DIR);
  return `${resolveHome(env)}/${DEFAULT_MEMORY_SUBDIR}`;
}

/**
 * Convenience: the rag index directory for a given memory root.
 */
export function ragIndexDir(memoryDir: string): string {
  return `${memoryDir}/${RAG_INDEX_SUBDIR}`;
}
