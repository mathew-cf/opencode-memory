#!/usr/bin/env bun
/**
 * opencode-memory CLI entry point.
 *
 * Runs under Bun (matching the runtime opencode itself uses). Required
 * because the shared lib/* helpers use `Bun.$` for shell calls and
 * `Bun.spawn`/`Bun.file` for filesystem work; rather than maintaining
 * two implementations we standardize on bun. `bunx` always uses the
 * bun runtime regardless of shebang, so the canonical
 *   `bunx @mathew-cf/opencode-memory init`
 * just works. Direct invocations (`opencode-memory init` after
 * `npm install -g`) require bun to be on PATH.
 *
 * Distributed via the `bin` field in package.json so users can run
 *   `bunx @mathew-cf/opencode-memory init`
 * from a fresh machine to fully bootstrap the memory system: mkdir,
 * git init, create category subdirs, pre-cache the embedding model,
 * and report status.
 *
 * Subcommands (lazy-resolved so tests can call them with plain args
 * without spawning a subprocess):
 *
 *   init [--skip-model] [--quiet]
 *     Initialize the memory directory and download the embedding model.
 *     Idempotent — safe to run multiple times.
 *
 *   status
 *     Report which search backends (ripgrep, rag-cli) are resolvable.
 *     Same output as the `memory_setup` tool.
 *
 *   help
 *     Print usage.
 *
 * The CLI is intentionally tiny: the heavy lifting (rag download, ripgrep
 * resolution) lives in src/lib/ and is shared with the plugin tools so
 * a single bug fix benefits both surfaces.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { CATEGORIES } from "./constants";
import { resolveMemoryDir } from "./lib/paths";
import { downloadModel, resolveRagBinary } from "./lib/rag";
import { resolveRgBinary } from "./lib/ripgrep";
import { runSetup } from "./tools/memory";

interface InitOptions {
  /** Skip the rag download step. Useful in CI or for offline first-runs. */
  skipModel?: boolean;
  /** Suppress success lines (errors still print). For embedding in scripts. */
  quiet?: boolean;
}

/**
 * Result of `init`. Returned (rather than just printed) so tests can
 * assert exactly what happened on disk.
 */
export interface InitResult {
  memoryDir: string;
  /** True if `git init` actually ran (vs. the dir already being a repo). */
  gitInitialized: boolean;
  /** Categories that were created in this run. Skipped categories aren't listed. */
  createdCategories: string[];
  /** True if the rag download step ran. */
  modelDownloadAttempted: boolean;
  /** Whatever rag download printed, if it ran. */
  modelDownloadOutput?: string;
}

/**
 * Pure-ish init: takes an explicit memoryDir so tests can target a temp
 * path. The CLI wrapper passes `resolveMemoryDir()`.
 */
export async function initMemory(
  memoryDir: string,
  options: InitOptions = {},
  log: (msg: string) => void = (msg) => process.stdout.write(msg + "\n"),
): Promise<InitResult> {
  const result: InitResult = {
    memoryDir,
    gitInitialized: false,
    createdCategories: [],
    modelDownloadAttempted: false,
  };
  const note = options.quiet ? () => {} : log;

  note(`Memory dir: ${memoryDir}`);
  await mkdir(memoryDir, { recursive: true });

  // Git init (idempotent — `git init` is fine to re-run, but we skip it
  // anyway so the output stays clean).
  if (!existsSync(`${memoryDir}/.git`)) {
    await Bun.$`git -C ${memoryDir} init`.quiet();
    result.gitInitialized = true;
    note("✓ git repo initialized");
  } else {
    note("✓ git repo already exists");
  }

  // Category subdirs. Each gets a `.gitkeep` so the directory survives
  // git's empty-dir pruning even when no memories have been written yet.
  for (const cat of CATEGORIES) {
    const catDir = `${memoryDir}/${cat}`;
    if (!existsSync(catDir)) {
      await mkdir(catDir, { recursive: true });
      result.createdCategories.push(cat);
    }
    const gitkeep = `${catDir}/.gitkeep`;
    if (!existsSync(gitkeep)) {
      await writeFile(gitkeep, "");
    }
  }
  if (result.createdCategories.length > 0) {
    note(
      `✓ created category dirs: ${result.createdCategories.join(", ")}`,
    );
  } else {
    note(`✓ all ${CATEGORIES.length} category dirs already present`);
  }

  // Pre-cache the embedding model. Bypassed with --skip-model for offline
  // installs; users can still run `bunx @mathew-cf/rag-cli download` later.
  if (!options.skipModel) {
    note("");
    note("Downloading embedding model (skip with --skip-model)...");
    const out = await downloadModel();
    result.modelDownloadAttempted = true;
    result.modelDownloadOutput = out;
    note(out);
  }

  return result;
}

/**
 * Print usage to stdout. Exported so tests can compare against it.
 */
export function usage(): string {
  return [
    "Usage: opencode-memory <command>",
    "",
    "Commands:",
    "  init [--skip-model] [--quiet]",
    "      Initialize the memory directory ($MEMORY_DIR or",
    "      ~/opencode-memory): mkdir, git init, create category",
    "      subdirs, pre-cache the embedding model. Idempotent.",
    "",
    "  status",
    "      Report which search backends (ripgrep, rag-cli) are",
    "      resolvable. Same output as the memory_setup tool.",
    "",
    "  help",
    "      Show this message.",
  ].join("\n");
}

/**
 * Parse argv tail into a simple options bag. Exported for tests.
 * Recognised flags:
 *   --skip-model | -s    InitOptions.skipModel = true
 *   --quiet | -q         InitOptions.quiet = true
 */
export function parseInitFlags(argv: string[]): InitOptions {
  const opts: InitOptions = {};
  for (const arg of argv) {
    if (arg === "--skip-model" || arg === "-s") opts.skipModel = true;
    else if (arg === "--quiet" || arg === "-q") opts.quiet = true;
  }
  return opts;
}

/** CLI dispatcher. Exported so tests can drive it without exec(). */
export async function dispatch(argv: string[]): Promise<number> {
  const cmd = argv[0];
  switch (cmd) {
    case "init": {
      const opts = parseInitFlags(argv.slice(1));
      try {
        await initMemory(resolveMemoryDir(), opts);
        return 0;
      } catch (err) {
        process.stderr.write(`opencode-memory init failed: ${String(err)}\n`);
        return 1;
      }
    }
    case "status": {
      process.stdout.write((await runSetup()) + "\n");
      // Status returns nonzero when either backend is unresolvable, so
      // `bunx @mathew-cf/opencode-memory status` can be used in CI.
      const ok = resolveRagBinary() !== null && resolveRgBinary() !== null;
      return ok ? 0 : 1;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(usage() + "\n");
      return 0;
    }
    default: {
      process.stderr.write(`Unknown command: ${cmd}\n\n`);
      process.stdout.write(usage() + "\n");
      return 1;
    }
  }
}

// Direct invocation guard. When bundled to dist/cli.js and called via
// the `bin` shim, this branch fires; when imported by tests it does not.
const isDirect = (() => {
  try {
    // import.meta.main is `true` when this file is the entry point under bun.
    // process.argv[1] check is the Node-portable fallback after bundling.
    return (
      // @ts-ignore — `main` exists on Bun's import.meta, not vanilla Node.
      import.meta.main === true ||
      (typeof process.argv[1] === "string" &&
        (process.argv[1].endsWith("/cli.js") ||
          process.argv[1].endsWith("\\cli.js") ||
          process.argv[1].endsWith("/opencode-memory") ||
          process.argv[1].endsWith("\\opencode-memory")))
    );
  } catch {
    return false;
  }
})();

if (isDirect) {
  dispatch(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`opencode-memory: ${String(err)}\n`);
      process.exit(1);
    },
  );
}
