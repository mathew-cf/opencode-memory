/**
 * Cross-platform path helpers.
 *
 * The memory and session tools were originally written for macOS/Linux where
 * paths use forward slashes and process.env.HOME is always set. On Windows,
 * both assumptions break. These helpers centralize the compatibility shim so
 * the rest of the plugin can assume a single canonical path shape.
 */

import { posix, win32 } from "node:path";
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
  return normalizeDirPath(raw);
}

/**
 * Normalize a filesystem path to use forward slashes.
 *
 * On Windows, ripgrep emits paths with backslashes even when invoked with
 * forward-slash arguments. When our code strips a forward-slash
 * OPENCODE_MEMORY_DIR prefix from a backslash-separated rg output line,
 * the replace silently fails and the prefix is left in place — which
 * breaks every downstream file read. Normalizing rg output through this
 * helper restores the invariant that paths handled inside the tool
 * always use /.
 *
 * On macOS/Linux this is a no-op: paths already use forward slashes.
 */
export function normPath(p: string): string {
  return posix.normalize(p.replaceAll(win32.sep, posix.sep));
}

/**
 * Normalize a directory path and drop redundant trailing separators. Uses
 * `path.posix.join` so the result keeps the plugin's forward-slash invariant.
 */
export function normalizeDirPath(p: string): string {
  return posix.join(normPath(p), ".");
}

/**
 * Expand a leading `~` in user-provided paths. Shells usually expand
 * this before setting OPENCODE_MEMORY_DIR, but JSON-based host configs
 * often pass it through literally. Supporting it here lets users write
 * the same intuitive value in either place.
 */
export function expandHomePath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalized = normPath(p);
  if (normalized === "~") return resolveHome(env);
  if (normalized.startsWith(`~${posix.sep}`)) {
    return posix.join(resolveHome(env), normalized.slice(2));
  }
  return normalized;
}

/**
 * Resolve the root memory directory. Honors `$OPENCODE_MEMORY_DIR` (used
 * by tests and by users who keep their knowledge base in a non-default
 * location), falling back to `$HOME/opencode-memory`.
 *
 * The env var is namespaced with the package's prefix to avoid collisions
 * with generic `MEMORY_DIR` values that other tools or LLM frameworks
 * sometimes set.
 */
export function resolveMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_MEMORY_DIR && env.OPENCODE_MEMORY_DIR.length > 0) {
    return normalizeDirPath(expandHomePath(env.OPENCODE_MEMORY_DIR, env));
  }
  return posix.join(resolveHome(env), DEFAULT_MEMORY_SUBDIR);
}

/**
 * Render a memory root for LLM-facing prompts and tool output. If the path
 * lives under the user's home, collapse that prefix to `~` so custom dirs
 * like `/Users/alex/.config/opencode/memory` become the concise, accurate
 * `~/.config/opencode/memory` instead of the misleading default path.
 */
export function formatMemoryDirForDisplay(memoryDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalized = normalizeDirPath(memoryDir);
  try {
    const home = resolveHome(env);
    const relativeToHome = posix.relative(home, normalized);
    if (relativeToHome === "") return "~";
    if (relativeToHome && !relativeToHome.startsWith("..") && !posix.isAbsolute(relativeToHome)) {
      return posix.join("~", relativeToHome);
    }
  } catch {
    // If HOME is unavailable, the absolute/normalized memoryDir is still
    // better than falling back to a hard-coded default.
  }
  return normalized;
}

/**
 * Render a memory file path for LLM-facing prompts and tool output.
 */
export function formatMemoryPathForDisplay(
  memoryDir: string,
  relPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = formatMemoryDirForDisplay(memoryDir, env);
  if (!relPath) return root;
  return posix.join(root, normPath(relPath));
}

/**
 * Convenience: the rag index directory for a given memory root.
 */
export function ragIndexDir(memoryDir: string): string {
  return posix.join(memoryDir, RAG_INDEX_SUBDIR);
}
