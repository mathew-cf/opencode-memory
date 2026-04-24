/**
 * Helpers for locating the OpenCode session database and running read-only
 * SQL queries against it.
 *
 * The session tools wrap these helpers so they can be pointed at a temp DB
 * during tests by setting `$OPENCODE_DB`.
 */

import { resolveHome } from "./paths";

/**
 * Resolve the path to the OpenCode SQLite database.
 *
 * OpenCode uses `xdg-basedir@5.1.0` which joins `os.homedir()` with
 * `.local/share` on every platform (including Windows, where it resolves
 * under `%USERPROFILE%`). So once HOME resolves correctly, the layout is
 * identical cross-platform.
 *
 * Tests and power users can override the path with `$OPENCODE_DB`.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_DB && env.OPENCODE_DB.length > 0) return env.OPENCODE_DB;
  return `${resolveHome(env)}/.local/share/opencode/opencode.db`;
}

/**
 * Escape a value for use in a SQLite single-quoted string literal.
 * Exported for tests — the exact quoting rules matter for ensuring we
 * don't construct SQL injection vectors when building queries from user
 * input.
 */
export function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Run a SQLite statement against the given db and return the parsed JSON
 * result. Returns an empty array on any error — callers then present a
 * graceful "no results" response instead of propagating an exception.
 */
export async function querySqlite<T = unknown>(
  dbPath: string,
  sql: string,
): Promise<T[]> {
  const raw = await Bun.$`sqlite3 -json ${dbPath} ${sql}`
    .text()
    .catch(() => "[]");
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed) as T[];
  } catch {
    return [];
  }
}
