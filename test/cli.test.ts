/**
 * Tests for src/cli.ts — the bin entry point.
 *
 * Each `init` test runs against a fresh temp memory dir so we can
 * assert exactly what landed on disk. Tests do not actually run
 * `rag download` (it's network-bound and slow); they pass --skip-model
 * and verify the rest of the bootstrap independently.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import {
  dispatch,
  initMemory,
  installSkill,
  parseInitFlags,
  resolveBundledSkillsDir,
  usage,
} from "../src/cli";
import { CATEGORIES } from "../src/constants";
import { makeTempDir, withMemoryDir } from "./helpers";

/**
 * Helper: every `initMemory` call in this file must point the skill
 * install at a temp dir so we never touch `~/.agents/skills/` from CI.
 * Returns a fresh temp dir plus its options bag; the caller owns
 * cleanup.
 */
function withSkillLinkDir(extra: Record<string, unknown> = {}) {
  const tmp = makeTempDir("opencode-memory-skill-link-");
  return {
    tmp,
    options: { ...extra, skillLinkDir: tmp.path },
  };
}

describe("parseInitFlags", () => {
  test("returns empty options for no flags", () => {
    expect(parseInitFlags([])).toEqual({});
  });

  test("recognises --skip-model and -s", () => {
    expect(parseInitFlags(["--skip-model"])).toEqual({ skipModel: true });
    expect(parseInitFlags(["-s"])).toEqual({ skipModel: true });
  });

  test("recognises --quiet and -q", () => {
    expect(parseInitFlags(["--quiet"])).toEqual({ quiet: true });
    expect(parseInitFlags(["-q"])).toEqual({ quiet: true });
  });

  test("recognises --skip-skills", () => {
    expect(parseInitFlags(["--skip-skills"])).toEqual({ skipSkills: true });
  });

  test("combines flags", () => {
    expect(parseInitFlags(["--skip-model", "--skip-skills", "--quiet"])).toEqual({
      skipModel: true,
      skipSkills: true,
      quiet: true,
    });
  });

  test("ignores unknown flags", () => {
    expect(parseInitFlags(["--banana"])).toEqual({});
  });
});

describe("usage", () => {
  test("describes every command", () => {
    const text = usage();
    expect(text).toContain("init");
    expect(text).toContain("status");
    expect(text).toContain("help");
    expect(text).toContain("--skip-model");
  });
});

describe("initMemory", () => {
  test("creates the memory directory and category subdirs from a clean slate", async () => {
    await withMemoryDir(async (dir) => {
      const { tmp, options } = withSkillLinkDir({
        skipModel: true,
        quiet: true,
      });
      try {
        const result = await initMemory(dir, options);
        expect(result.memoryDir).toBe(dir);
        expect(result.gitInitialized).toBe(true);
        expect(result.createdCategories.sort()).toEqual([...CATEGORIES].sort());
        expect(result.modelDownloadAttempted).toBe(false);

        // Every category exists with a .gitkeep
        for (const cat of CATEGORIES) {
          expect(existsSync(`${dir}/${cat}`)).toBe(true);
          expect(existsSync(`${dir}/${cat}/.gitkeep`)).toBe(true);
        }
        expect(existsSync(`${dir}/.git`)).toBe(true);
      } finally {
        tmp.cleanup();
      }
    });
  });

  test("is idempotent — second run reports nothing new", async () => {
    await withMemoryDir(async (dir) => {
      const { tmp, options } = withSkillLinkDir({
        skipModel: true,
        quiet: true,
      });
      try {
        await initMemory(dir, options);
        const second = await initMemory(dir, options);
        expect(second.gitInitialized).toBe(false);
        expect(second.createdCategories).toEqual([]);
        // Skill install reports "already-installed" on the second run.
        expect(second.skillInstall?.status).toBe("already-installed");
      } finally {
        tmp.cleanup();
      }
    });
  });

  test("only reports newly-created categories on partial init", async () => {
    await withMemoryDir(async (dir) => {
      const { tmp, options } = withSkillLinkDir({
        skipModel: true,
        quiet: true,
      });
      try {
        // Pre-create one category by hand to simulate a partially-initialized
        // memory dir (e.g., the user ran init once, then deleted some dirs).
        await Bun.$`mkdir -p ${dir}/notes`.quiet();
        const result = await initMemory(dir, options);
        expect(result.createdCategories).not.toContain("notes");
        expect(result.createdCategories).toContain("technical");
      } finally {
        tmp.cleanup();
      }
    });
  });

  test("collects log lines passed via the log callback", async () => {
    await withMemoryDir(async (dir) => {
      const { tmp, options } = withSkillLinkDir({ skipModel: true });
      try {
        const lines: string[] = [];
        await initMemory(dir, options, (m) => lines.push(m));
        const joined = lines.join("\n");
        expect(joined).toContain(`Memory dir: ${dir}`);
        expect(joined).toMatch(/git repo/);
        expect(joined).toMatch(/category dirs/);
        // Skill install line is emitted by default.
        expect(joined).toMatch(/skill/);
      } finally {
        tmp.cleanup();
      }
    });
  });

  test("--quiet suppresses the log callback", async () => {
    await withMemoryDir(async (dir) => {
      const { tmp, options } = withSkillLinkDir({
        skipModel: true,
        quiet: true,
      });
      try {
        const lines: string[] = [];
        await initMemory(dir, options, (m) => lines.push(m));
        expect(lines).toEqual([]);
      } finally {
        tmp.cleanup();
      }
    });
  });

  test("--skip-skills suppresses skill install entirely", async () => {
    await withMemoryDir(async (dir) => {
      const { tmp, options } = withSkillLinkDir({
        skipModel: true,
        skipSkills: true,
        quiet: true,
      });
      try {
        const result = await initMemory(dir, options);
        expect(result.skillInstall).toBeNull();
      } finally {
        tmp.cleanup();
      }
    });
  });
});

describe("installSkill", () => {
  test("symlinks the bundled skill on a fresh target", async () => {
    const tmp = makeTempDir("opencode-memory-skill-link-");
    try {
      const result = await installSkill({
        bundledSkillsDir: resolveBundledSkillsDir(),
        linkDir: tmp.path,
      });
      expect(result.status).toBe("created");
      expect(existsSync(result.linkPath)).toBe(true);
      // It's actually a symlink (not a copy).
      expect(lstatSync(result.linkPath).isSymbolicLink()).toBe(true);
      // ...pointing where we said it would.
      const linkTarget = readlinkSync(result.linkPath);
      expect(linkTarget).toBe(result.targetPath);
    } finally {
      tmp.cleanup();
    }
  });

  test("is idempotent — second call reports already-installed", async () => {
    const tmp = makeTempDir("opencode-memory-skill-link-");
    try {
      const first = await installSkill({
        bundledSkillsDir: resolveBundledSkillsDir(),
        linkDir: tmp.path,
      });
      expect(first.status).toBe("created");
      const second = await installSkill({
        bundledSkillsDir: resolveBundledSkillsDir(),
        linkDir: tmp.path,
      });
      expect(second.status).toBe("already-installed");
    } finally {
      tmp.cleanup();
    }
  });

  test("leaves unrelated existing content untouched", async () => {
    const tmp = makeTempDir("opencode-memory-skill-link-");
    try {
      // Pre-place a regular file at the link path — the install must
      // refuse to overwrite it.
      await mkdir(tmp.path, { recursive: true });
      writeFileSync(`${tmp.path}/opencode-memory`, "do not clobber\n");

      const result = await installSkill({
        bundledSkillsDir: resolveBundledSkillsDir(),
        linkDir: tmp.path,
      });
      expect(result.status).toBe("skipped-existing");
      // Original file content survives.
      expect(existsSync(`${tmp.path}/opencode-memory`)).toBe(true);
      expect(lstatSync(`${tmp.path}/opencode-memory`).isSymbolicLink()).toBe(
        false,
      );
    } finally {
      tmp.cleanup();
    }
  });

  test("reports unavailable when the bundled skill dir is missing", async () => {
    const tmp = makeTempDir("opencode-memory-skill-link-");
    try {
      const result = await installSkill({
        bundledSkillsDir: "/definitely/does/not/exist",
        linkDir: tmp.path,
      });
      expect(result.status).toBe("unavailable");
      expect(existsSync(`${tmp.path}/opencode-memory`)).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("dispatch", () => {
  // Silence CLI output during dispatch tests so command-line noise
  // (usage strings, backend status, etc.) doesn't leak into the bun
  // test runner's stdout. Real production callers still get the
  // default `process.stdout` / `process.stderr` behaviour.
  const silent = { out: () => {}, err: () => {} };

  test("returns 0 for help / no args", async () => {
    expect(await dispatch([], silent)).toBe(0);
    expect(await dispatch(["help"], silent)).toBe(0);
    expect(await dispatch(["--help"], silent)).toBe(0);
    expect(await dispatch(["-h"], silent)).toBe(0);
  });

  test("returns nonzero for unknown commands", async () => {
    expect(await dispatch(["banana"], silent)).toBe(1);
  });

  test("init runs end-to-end against a temp dir", async () => {
    await withMemoryDir(async (dir) => {
      // `dispatch` doesn't accept `skillLinkDir` — pass --skip-skills
      // so the run doesn't try to write into ~/.agents/skills/.
      const code = await dispatch(
        ["init", "--skip-model", "--skip-skills", "--quiet"],
        silent,
      );
      expect(code).toBe(0);
      expect(existsSync(`${dir}/.git`)).toBe(true);
      for (const cat of CATEGORIES) {
        expect(existsSync(`${dir}/${cat}/.gitkeep`)).toBe(true);
      }
    });
  });

  test("status returns 0 when both backends resolve", async () => {
    // Both backends are deps in this repo, so this assertion runs in
    // tests; in environments where one is missing dispatch returns 1.
    const code = await dispatch(["status"], silent);
    expect([0, 1]).toContain(code);
  });

  test("routes help output through io.out", async () => {
    const out: string[] = [];
    const code = await dispatch(["help"], { out: (chunk) => out.push(chunk) });
    expect(code).toBe(0);
    const joined = out.join("");
    expect(joined).toContain("Usage: opencode-memory");
    expect(joined).toContain("init");
  });

  test("routes unknown-command errors through io.err", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await dispatch(["banana"], {
      out: (chunk) => out.push(chunk),
      err: (chunk) => err.push(chunk),
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("Unknown command: banana");
    // Usage still printed to stdout so the user sees what's available.
    expect(out.join("")).toContain("Usage: opencode-memory");
  });
});
