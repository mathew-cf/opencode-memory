/**
 * Shared test utilities.
 *
 * These helpers set up isolated temp directories per test and ensure
 * cleanup always runs. Tests use `MEMORY_DIR` and `OPENCODE_DB` env-var
 * overrides rather than mutating process globals because the tools read
 * the env lazily and restart fresh on every call.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDir {
  path: string;
  cleanup: () => void;
}

export function makeTempDir(prefix = "opencode-memory-test-"): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Run a function with a fresh temp memory dir and the MEMORY_DIR env var
 * pointed at it. The previous env value is restored after the callback
 * so tests don't leak state.
 */
export async function withMemoryDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const tmp = makeTempDir();
  const prev = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = tmp.path;
  try {
    return await fn(tmp.path);
  } finally {
    if (prev === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = prev;
    tmp.cleanup();
  }
}

/**
 * Write a memory file with the given frontmatter + body. `path` is
 * relative to the memory dir (e.g. `technical/foo.md`).
 */
export async function writeMemoryFile(
  memoryDir: string,
  relPath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.join(", ")}]`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---");
  lines.push(body);
  await Bun.write(`${memoryDir}/${relPath}`, lines.join("\n"));
}
