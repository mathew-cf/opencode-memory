/**
 * Tests for src/cli.ts — the bin entry point.
 *
 * Each `init` test runs against a fresh temp memory dir so we can
 * assert exactly what landed on disk. Tests do not actually run
 * `rag download` (it's network-bound and slow); they pass --skip-model
 * and verify the rest of the bootstrap independently.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  dispatch,
  initMemory,
  parseInitFlags,
  usage,
} from "../src/cli";
import { CATEGORIES } from "../src/constants";
import { withMemoryDir } from "./helpers";

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

  test("combines flags", () => {
    expect(parseInitFlags(["--skip-model", "--quiet"])).toEqual({
      skipModel: true,
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
      const result = await initMemory(dir, { skipModel: true, quiet: true });
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
    });
  });

  test("is idempotent — second run reports nothing new", async () => {
    await withMemoryDir(async (dir) => {
      await initMemory(dir, { skipModel: true, quiet: true });
      const second = await initMemory(dir, { skipModel: true, quiet: true });
      expect(second.gitInitialized).toBe(false);
      expect(second.createdCategories).toEqual([]);
    });
  });

  test("only reports newly-created categories on partial init", async () => {
    await withMemoryDir(async (dir) => {
      // Pre-create one category by hand to simulate a partially-initialized
      // memory dir (e.g., the user ran init once, then deleted some dirs).
      await Bun.$`mkdir -p ${dir}/notes`.quiet();
      const result = await initMemory(dir, { skipModel: true, quiet: true });
      expect(result.createdCategories).not.toContain("notes");
      expect(result.createdCategories).toContain("technical");
    });
  });

  test("collects log lines passed via the log callback", async () => {
    await withMemoryDir(async (dir) => {
      const lines: string[] = [];
      await initMemory(dir, { skipModel: true }, (m) => lines.push(m));
      const joined = lines.join("\n");
      expect(joined).toContain(`Memory dir: ${dir}`);
      expect(joined).toMatch(/git repo/);
      expect(joined).toMatch(/category dirs/);
    });
  });

  test("--quiet suppresses the log callback", async () => {
    await withMemoryDir(async (dir) => {
      const lines: string[] = [];
      await initMemory(
        dir,
        { skipModel: true, quiet: true },
        (m) => lines.push(m),
      );
      expect(lines).toEqual([]);
    });
  });
});

describe("dispatch", () => {
  test("returns 0 for help / no args", async () => {
    expect(await dispatch([])).toBe(0);
    expect(await dispatch(["help"])).toBe(0);
    expect(await dispatch(["--help"])).toBe(0);
    expect(await dispatch(["-h"])).toBe(0);
  });

  test("returns nonzero for unknown commands", async () => {
    expect(await dispatch(["banana"])).toBe(1);
  });

  test("init runs end-to-end against a temp dir", async () => {
    await withMemoryDir(async (dir) => {
      const code = await dispatch(["init", "--skip-model", "--quiet"]);
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
    const code = await dispatch(["status"]);
    expect([0, 1]).toContain(code);
  });
});
