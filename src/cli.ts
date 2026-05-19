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

import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, DEFAULT_MEMORY_SUBDIR } from "./constants";
import { resolveMemoryDir } from "./lib/paths";
import { downloadModel, resolveRagBinary } from "./lib/rag";
import { resolveRgBinary } from "./lib/ripgrep";
import { runSetup } from "./tools/memory";

interface InitOptions {
  /** Skip the rag download step. Useful in CI or for offline first-runs. */
  skipModel?: boolean;
  /**
   * Skip installing the bundled skill into `~/.agents/skills/`. By
   * default `init` symlinks the skill there so Zed (`crates/agent_skills`)
   * and Pi (`packages/coding-agent/docs/skills.md`) — both of which
   * auto-discover that path — pick the skill up on next launch.
   */
  skipSkills?: boolean;
  /**
   * Override the directory where `installSkill` drops the symlink.
   * Defaults to `~/.agents/skills`. Test-only escape hatch.
   */
  skillLinkDir?: string;
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
  /**
   * Outcome of the optional skill-symlink step. `null` when
   * `skipSkills` was set. Otherwise see `SkillInstallResult` for the
   * three valid resting states.
   */
  skillInstall: SkillInstallResult | null;
}

/**
 * Result of installing the bundled `opencode-memory` skill into
 * `~/.agents/skills/`. Captures the three valid resting states:
 *  - `"created"`: a fresh symlink was placed at the target path
 *  - `"already-installed"`: the target was already a symlink to our skill dir
 *  - `"skipped-existing"`: a non-matching file/dir/symlink was already there
 *    (we never overwrite — user-owned content wins)
 *  - `"unavailable"`: the bundled skill dir wasn't resolvable on disk
 *    (unusual; usually means the package layout was tampered with)
 */
export interface SkillInstallResult {
  status: "created" | "already-installed" | "skipped-existing" | "unavailable";
  /** Absolute path of the link we attempted to create. */
  linkPath: string;
  /** Absolute path the link points at (or would point at). */
  targetPath: string;
}

/**
 * Locate the bundled skills directory next to this file's package root.
 *
 * In src layout: `src/cli.ts` → `<repo>/skills`.
 * In dist layout: `dist/cli.js` → `<pkg>/skills` (the `skills` folder
 * is shipped in the npm package via `package.json` `files`).
 *
 * Exported so tests can monkey-patch the lookup if needed.
 */
export function resolveBundledSkillsDir(): string | undefined {
  try {
    const here =
      typeof import.meta !== "undefined" && import.meta.url
        ? dirname(fileURLToPath(import.meta.url))
        : typeof __dirname !== "undefined"
          ? __dirname
          : undefined;
    if (!here) return undefined;
    const candidate = resolvePath(here, "..", "skills");
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Install (idempotent) the bundled `opencode-memory` skill into
 * `~/.agents/skills/opencode-memory` — the directory Zed and Pi both
 * auto-discover. Never overwrites a non-matching entry already at the
 * target; users who manually placed something there keep ownership.
 *
 * Implementation: symlink rather than copy. Symlinks let plugin upgrades
 * (`bun add @mathew-cf/opencode-memory@latest`) pick up new skill content
 * without re-running `init`. The link points at the bundled skill
 * directory inside the installed package.
 *
 * `linkDir` defaults to `~/.agents/skills` but is parameterised so tests
 * can target a temp directory.
 */
export async function installSkill(options: {
  bundledSkillsDir: string | undefined;
  linkDir?: string;
}): Promise<SkillInstallResult> {
  const linkDir = options.linkDir ?? `${homedir()}/.agents/skills`;
  const linkPath = `${linkDir}/opencode-memory`;

  if (!options.bundledSkillsDir) {
    return {
      status: "unavailable",
      linkPath,
      targetPath: "",
    };
  }
  const targetPath = `${options.bundledSkillsDir}/opencode-memory`;
  if (!existsSync(targetPath)) {
    return { status: "unavailable", linkPath, targetPath };
  }

  await mkdir(linkDir, { recursive: true });

  // Inspect the existing entry without resolving symlinks — we want to
  // know if it's *our* link vs. unrelated user content.
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(linkPath);
  } catch {
    existing = undefined;
  }

  if (existing) {
    if (existing.isSymbolicLink()) {
      try {
        const current = readlinkSync(linkPath);
        // Compare resolved paths so a relative link with the right
        // ultimate target counts as a match.
        const resolved = resolvePath(linkDir, current);
        if (resolved === targetPath) {
          return { status: "already-installed", linkPath, targetPath };
        }
      } catch {
        // unreadable link — treat as non-matching, don't touch it
      }
    }
    return { status: "skipped-existing", linkPath, targetPath };
  }

  await symlink(targetPath, linkPath);
  return { status: "created", linkPath, targetPath };
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
    skillInstall: null,
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
    note(`✓ created category dirs: ${result.createdCategories.join(", ")}`);
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

  // Drop the bundled skill into ~/.agents/skills/ — the directory both
  // Zed and Pi auto-discover. Idempotent; never overwrites user content.
  if (!options.skipSkills) {
    note("");
    const install = await installSkill({
      bundledSkillsDir: resolveBundledSkillsDir(),
      linkDir: options.skillLinkDir,
    });
    result.skillInstall = install;
    switch (install.status) {
      case "created":
        note(`✓ skill installed: ${install.linkPath} → ${install.targetPath}`);
        note(
          "  Zed (~/.agents/skills) and Pi (~/.agents/skills, ~/.pi/agent/skills) auto-discover this path on next launch.",
        );
        break;
      case "already-installed":
        note(`✓ skill already installed at ${install.linkPath}`);
        break;
      case "skipped-existing":
        note(`⚠ ${install.linkPath} already exists (not our symlink) — left untouched`);
        break;
      case "unavailable":
        note("⚠ bundled skill directory not resolvable — skill install skipped (unusual; check package layout)");
        break;
    }
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
    "  init [--skip-model] [--skip-skills] [--quiet]",
    "      Initialize the memory directory ($OPENCODE_MEMORY_DIR or",
    `      ~/${DEFAULT_MEMORY_SUBDIR} by default): mkdir, git init, create category`,
    "      subdirs, pre-cache the embedding model, install the",
    "      bundled skill into ~/.agents/skills/ (used by Zed and",
    "      Pi). Idempotent.",
    "",
    "  status",
    "      Report which search backends (ripgrep, rag-cli) are",
    "      resolvable. Same output as the memory_setup tool.",
    "",
    "  help",
    "      Show this message.",
    "",
    "MCP server (for Zed / Pi / Claude Code / any MCP host):",
    "  bunx @mathew-cf/opencode-memory opencode-memory-mcp",
    "",
    "  Speaks MCP over stdio. Exposes the five memory_* tools.",
    "  Wire it into your host's MCP config (see README).",
  ].join("\n");
}

/**
 * Parse argv tail into a simple options bag. Exported for tests.
 * Recognised flags:
 *   --skip-model | -s    InitOptions.skipModel = true
 *   --skip-skills        InitOptions.skipSkills = true
 *   --quiet | -q         InitOptions.quiet = true
 */
export function parseInitFlags(argv: string[]): InitOptions {
  const opts: InitOptions = {};
  for (const arg of argv) {
    if (arg === "--skip-model" || arg === "-s") opts.skipModel = true;
    else if (arg === "--skip-skills") opts.skipSkills = true;
    else if (arg === "--quiet" || arg === "-q") opts.quiet = true;
  }
  return opts;
}

/**
 * Writer functions for `dispatch`. Each receives a chunk of text exactly
 * as it would be passed to `process.stdout.write` / `process.stderr.write`
 * — including any trailing newlines. Callers must include their own
 * newlines so passing `process.stdout.write.bind(process.stdout)` reads
 * naturally.
 *
 * Exists primarily so tests can silence the CLI output without
 * monkey-patching `process.stdout`, but the same shape lets embedders
 * (e.g. a wrapping daemon) capture or redirect output cleanly.
 */
export interface DispatchIO {
  /** Defaults to `process.stdout.write` bound to stdout. */
  out?: (chunk: string) => void;
  /** Defaults to `process.stderr.write` bound to stderr. */
  err?: (chunk: string) => void;
}

/**
 * CLI dispatcher. Exported so tests can drive it without exec().
 *
 * Output is routed through the optional `io.out` / `io.err` writers so
 * tests (and any embedder) can capture or silence the chatter without
 * having to monkey-patch global stdio. Defaults preserve the standalone
 * bin behaviour exactly.
 */
export async function dispatch(argv: string[], io: DispatchIO = {}): Promise<number> {
  const out = io.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const err = io.err ?? ((chunk: string) => void process.stderr.write(chunk));
  const cmd = argv[0];
  switch (cmd) {
    case "init": {
      const opts = parseInitFlags(argv.slice(1));
      try {
        // Route initMemory's log lines through the same `out` writer so
        // a silenced dispatch silences init progress too. initMemory
        // expects a no-newline `log(msg)`, so we add the newline here.
        await initMemory(resolveMemoryDir(), opts, (msg) => out(msg + "\n"));
        return 0;
      } catch (e) {
        err(`opencode-memory init failed: ${String(e)}\n`);
        return 1;
      }
    }
    case "status": {
      out((await runSetup()) + "\n");
      // Status returns nonzero when either backend is unresolvable, so
      // `bunx @mathew-cf/opencode-memory status` can be used in CI.
      const ok = resolveRagBinary() !== null && resolveRgBinary() !== null;
      return ok ? 0 : 1;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      out(usage() + "\n");
      return 0;
    }
    default: {
      err(`Unknown command: ${cmd}\n\n`);
      out(usage() + "\n");
      return 1;
    }
  }
}

// Direct invocation guard. When bundled to dist/cli.js and called via
// the `bin` shim, this branch fires; when imported by tests it does not.
//
// We deliberately do NOT use `import.meta.main` here. Bun's
// `--target node` bundler transpiles it to
//   __require.main == __require.module === true
// which evaluates to `true` under dynamic `import()` because both
// values are undefined. If `cli.js` ever gets bundled into another
// entry (or imported indirectly), the bug would auto-execute
// `dispatch(process.argv.slice(2))` and call `process.exit()` — killing
// the host process. See the symmetric fix in `src/mcp.ts`.
//
// Argv-based detection covers every actual direct-invocation case:
//   - `bunx @mathew-cf/opencode-memory` / `opencode-memory` bin
//   - `bun dist/cli.js` / `node dist/cli.js`
//   - `bun src/cli.ts`
const isDirect = (() => {
  try {
    const arg = process.argv[1];
    if (typeof arg !== "string" || arg.length === 0) return false;
    return (
      arg.endsWith("/cli.js") ||
      arg.endsWith("\\cli.js") ||
      arg.endsWith("/cli.ts") ||
      arg.endsWith("\\cli.ts") ||
      arg.endsWith("/opencode-memory") ||
      arg.endsWith("\\opencode-memory")
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
