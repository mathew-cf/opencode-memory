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

/** Choose by path syntax, so Windows paths also work when tested on Unix. */
function pathStyle(p: string): typeof posix {
  return /^[A-Za-z]:|^[\\/]{2}[^\\/]/.test(p) ? win32 : posix;
}

export function joinPath(root: string, ...parts: string[]): string {
  return normPath(pathStyle(root).join(root, ...parts));
}

export function relativePath(root: string, file: string): string {
  const normalizedRoot = normPath(root);
  return normPath(pathStyle(normalizedRoot).relative(normalizedRoot, normPath(file)));
}

/** Return a canonical relative key, rejecting the root itself and escapes. */
export function containedRelativePath(root: string, file: string): string {
  const relative = relativePath(root, file);
  if (relative === "." || relative === ".." || relative.startsWith("../") ||
      posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new Error("Path must resolve to a file within the configured directory");
  }
  return relative;
}

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
 * On Windows, the rag keyword command emits paths with backslashes even when invoked with
 * forward-slash arguments. When our code strips a forward-slash
 * OPENCODE_MEMORY_DIR prefix from a backslash-separated keyword output line,
 * the replace silently fails and the prefix is left in place — which
 * breaks every downstream file read. Normalizing keyword output through this
 * helper restores the invariant that paths handled inside the tool
 * always use /.
 *
 * On macOS/Linux this is a no-op: paths already use forward slashes.
 */
export function normPath(p: string): string {
  const forward = p.replaceAll(win32.sep, posix.sep);
  return pathStyle(forward).normalize(forward).replaceAll(win32.sep, posix.sep);
}

/**
 * Normalize a directory path and drop redundant trailing separators. Uses
 * the root's path style so drive roots and network shares stay absolute.
 */
export function normalizeDirPath(p: string): string {
  const normalized = normPath(p);
  const root = normPath(pathStyle(normalized).parse(normalized).root);
  return normalized === root ? normalized : normalized.replace(/\/+$/, "");
}

/**
 * Resolve a caller-provided relative path beneath a trusted root.
 *
 * This is a lexical containment check; callers that read existing files
 * should additionally compare their real paths if symlinks are in scope.
 */
export function resolveContainedPath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0")) {
    throw new Error("Path must be a non-empty relative path");
  }

  const normalizedRoot = normalizeDirPath(root);
  const normalizedRelative = normPath(relativePath);
  if (posix.isAbsolute(normalizedRelative) || /^[A-Za-z]:/.test(normalizedRelative)) {
    throw new Error("Path must be relative");
  }

  const resolved = normPath(pathStyle(normalizedRoot).resolve(normalizedRoot, normalizedRelative));
  containedRelativePath(normalizedRoot, resolved);
  return resolved;
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
    return joinPath(resolveHome(env), normalized.slice(2));
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
  return joinPath(resolveHome(env), DEFAULT_MEMORY_SUBDIR);
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
    if (relativePath(home, normalized) === ".") return "~";
    return posix.join("~", containedRelativePath(home, normalized));
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
  return joinPath(root, normPath(relPath));
}

/**
 * Convenience: the rag index directory for a given memory root.
 */
export function ragIndexDir(memoryDir: string): string {
  return joinPath(memoryDir, RAG_INDEX_SUBDIR);
}
