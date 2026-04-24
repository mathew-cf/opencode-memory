/**
 * Integration tests for the memory_* tools.
 *
 * Each test creates a fresh temp memory directory (via `withMemoryDir`)
 * and writes a few sample files before exercising the tool. The tools
 * degrade gracefully when `rag` isn't installed, so these tests run
 * without needing the Rust toolchain — they just exercise keyword search.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { exists } from "node:fs/promises";
import {
  buildRgArgs,
  parseRagHits,
  runAccess,
  runList,
  runSave,
  runSearch,
  runSetup,
  toRelPath,
} from "../src/tools/memory";
import { withMemoryDir, writeMemoryFile } from "./helpers";

describe("buildRgArgs", () => {
  test("produces -e flags for each term in order", () => {
    const args = buildRgArgs(["alpha", "beta"]);
    expect(args).toContain("-e");
    expect(args[args.length - 4]).toBe("-e");
    expect(args[args.length - 3]).toBe("alpha");
    expect(args[args.length - 2]).toBe("-e");
    expect(args[args.length - 1]).toBe("beta");
  });

  test("always excludes .git, .rag, and INDEX.md", () => {
    const args = buildRgArgs(["x"]);
    const joined = args.join(" ");
    expect(joined).toContain("!.git");
    expect(joined).toContain("!.rag");
    expect(joined).toContain("!**/INDEX.md");
    expect(joined).toContain("*.md");
  });
});

describe("parseRagHits", () => {
  test("returns empty array for empty input", () => {
    expect(parseRagHits("")).toEqual([]);
  });

  test("returns empty array for non-JSON input", () => {
    expect(parseRagHits("not json")).toEqual([]);
  });

  test("returns empty array when root is not an array", () => {
    expect(parseRagHits(`{"source":"a.md","score":0.5,"text":"t"}`)).toEqual([]);
  });

  test("filters out malformed hit objects", () => {
    const raw = JSON.stringify([
      { source: "ok.md", score: 0.5, text: "hello" },
      { source: "no-score.md", text: "hello" },
      { score: 0.9, text: "hello" }, // missing source
      null,
      "a string",
    ]);
    const hits = parseRagHits(raw);
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("ok.md");
  });

  test("preserves well-formed hits", () => {
    const raw = JSON.stringify([
      { source: "a.md", score: 0.8, text: "one" },
      { source: "b.md", score: 0.6, text: "two" },
    ]);
    expect(parseRagHits(raw)).toEqual([
      { source: "a.md", score: 0.8, text: "one" },
      { source: "b.md", score: 0.6, text: "two" },
    ]);
  });
});

describe("toRelPath", () => {
  test("strips the memory dir prefix", () => {
    expect(toRelPath("/tmp/mem", "/tmp/mem/technical/foo.md")).toBe(
      "technical/foo.md",
    );
  });

  test("normalizes backslashes in rg output", () => {
    expect(toRelPath("/tmp/mem", "\\tmp\\mem\\technical\\foo.md")).toBe(
      "/tmp/mem/technical/foo.md".replace("/tmp/mem/", ""),
    );
  });
});

describe("runList", () => {
  test("lists all categories with counts when no category is provided", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(
        dir,
        "technical/alpha.md",
        { title: "Alpha", summary: "First" },
        "body",
      );
      await writeMemoryFile(
        dir,
        "technical/beta.md",
        { title: "Beta", summary: "Second" },
        "body",
      );
      await writeMemoryFile(
        dir,
        "notes/one.md",
        { title: "Note" },
        "body",
      );

      const out = await runList({});
      expect(out).toContain("## Memory Categories");
      expect(out).toContain("**technical/** (2 files)");
      expect(out).toContain("**notes/** (1 files)");
      expect(out).toContain("**preferences/** (0 files)");
    });
  });

  test("lists files in a specific category with summaries", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(
        dir,
        "technical/alpha.md",
        {
          title: "Alpha Framework",
          summary: "The alpha framework is...",
          importance: "high",
          updated: "2025-02-01",
        },
        "body",
      );
      await writeMemoryFile(
        dir,
        "technical/beta.md",
        {
          title: "Beta",
          summary: "Beta details",
          importance: "low",
          updated: "2025-01-01",
        },
        "body",
      );

      const out = await runList({ category: "technical" });
      expect(out).toContain("## technical/ (2 files)");
      expect(out).toContain("technical/alpha.md");
      expect(out).toContain("[high]");
      expect(out).toContain("The alpha framework is...");
      expect(out).toContain("[low]");

      // Sorted by `updated` descending — alpha (2025-02) should appear
      // before beta (2025-01).
      const alphaIdx = out.indexOf("technical/alpha.md");
      const betaIdx = out.indexOf("technical/beta.md");
      expect(alphaIdx).toBeLessThan(betaIdx);
    });
  });

  test("reports a helpful message for an empty category", async () => {
    await withMemoryDir(async () => {
      const out = await runList({ category: "workflows" });
      // The category dir does not exist in the temp tree, so the tool
      // reports it as not-found.
      expect(out.toLowerCase()).toMatch(/not found|no memories/);
    });
  });
});

describe("runSearch", () => {
  test("returns a 'no memories' message when the directory is empty", async () => {
    await withMemoryDir(async () => {
      const out = await runSearch({ query: "alpha" });
      expect(out).toContain("No memories found");
    });
  });

  test("finds a file by body content", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(
        dir,
        "technical/framework.md",
        {
          title: "Framework notes",
          tags: ["framework"],
          summary: "notes",
          importance: "medium",
        },
        "The retry policy uses exponential backoff with jitter.",
      );

      const out = await runSearch({ query: "jitter" });
      expect(out).toContain("technical/framework.md");
      expect(out).toMatch(/score:\s*\d/);
    });
  });

  test("ranks tag matches higher than body-only matches", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(
        dir,
        "technical/tagged.md",
        { title: "T", tags: ["jitter"], summary: "T" },
        "This file mentions retries once.",
      );
      await writeMemoryFile(
        dir,
        "technical/body.md",
        { title: "B", tags: ["unrelated"], summary: "B" },
        "jitter jitter jitter",
      );

      const out = await runSearch({ query: "jitter" });
      const taggedIdx = out.indexOf("technical/tagged.md");
      const bodyIdx = out.indexOf("technical/body.md");
      expect(taggedIdx).toBeGreaterThan(-1);
      // Both files should appear; the one with a matching tag gets a
      // deliberate bump in score.
      if (bodyIdx > -1) {
        expect(taggedIdx).toBeLessThan(bodyIdx);
      }
    });
  });

  test("filters by category and falls back cross-category when empty", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(
        dir,
        "notes/loose.md",
        { title: "Loose note", summary: "s" },
        "retries retries retries",
      );
      const inCategory = await runSearch({
        query: "retries",
        category: "notes",
      });
      expect(inCategory).toContain("notes/loose.md");

      // No match in `technical/` — the tool should fall back to a
      // cross-category search and surface the hit anyway.
      const fallback = await runSearch({
        query: "retries",
        category: "technical",
      });
      expect(fallback).toContain("notes/loose.md");
      expect(fallback).toContain("No results in");
    });
  });

  test("surfaces filename suggestions when no content matches", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(
        dir,
        "technical/retry-policy.md",
        { title: "Retry Policy", summary: "s" },
        "unrelated content",
      );
      const out = await runSearch({ query: "retry" });
      // Body doesn't mention `retry`, but the filename does.
      expect(out).toContain("technical/retry-policy.md");
    });
  });
});

describe("runAccess", () => {
  test("increments access_count and updates last_accessed", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(
        dir,
        "technical/foo.md",
        { title: "Foo", access_count: 3 },
        "body",
      );
      const out = await runAccess({ path: "technical/foo.md" });
      expect(out).toContain("count: 4");

      const updated = await Bun.file(`${dir}/technical/foo.md`).text();
      expect(updated).toContain("access_count: 4");
      expect(updated).toMatch(/last_accessed: \d{4}-\d{2}-\d{2}/);
    });
  });

  test("reports a friendly message when frontmatter is missing", async () => {
    await withMemoryDir(async (dir) => {
      await Bun.write(`${dir}/technical/plain.md`, "just body, no frontmatter");
      const out = await runAccess({ path: "technical/plain.md" });
      expect(out).toContain("No frontmatter");
    });
  });

  test("reports a failure when the file doesn't exist", async () => {
    await withMemoryDir(async () => {
      const out = await runAccess({ path: "technical/missing.md" });
      expect(out).toContain("Could not update");
    });
  });
});

describe("runSave", () => {
  test("reports 'No changes to sync' when the dir is not a git repo", async () => {
    await withMemoryDir(async () => {
      const out = await runSave();
      // `git add` fails silently, then diff returns nothing, so we land
      // on the no-changes branch.
      expect(out).toContain("No changes to sync");
    });
  });

  test("commits changes when the memory dir is a git repo", async () => {
    await withMemoryDir(async (dir) => {
      await Bun.$`git init`.cwd(dir).quiet();
      await Bun.$`git config user.email "t@example.com"`.cwd(dir).quiet();
      await Bun.$`git config user.name "Tester"`.cwd(dir).quiet();

      await writeMemoryFile(
        dir,
        "technical/foo.md",
        { title: "Foo" },
        "body",
      );

      const out = await runSave();
      expect(out).toContain("Synced");
      expect(out).toContain("technical/foo.md");

      // Verify the commit landed.
      const log = await Bun.$`git log --oneline`.cwd(dir).text();
      expect(log).toContain("memory: sync");
    });
  });
});

describe("runSetup", () => {
  test("reports status lines for both ripgrep and the rag shim", async () => {
    const out = await runSetup();
    // We don't assume a particular install state — tests are run with
    // both deps linked, but the output shape should be consistent even
    // if one resolves and the other doesn't.
    expect(out).toContain("ripgrep (keyword search):");
    expect(out).toContain("rag shim (semantic search):");
  });

  test("reports 'All set' when both resolve, or guidance when one is missing", async () => {
    const out = await runSetup();
    const bothResolved = !out.includes("NOT resolvable");
    if (bothResolved) {
      expect(out).toContain("All set");
    } else {
      // At least one guidance message should appear.
      const hasGuidance =
        out.includes("Keyword search is unavailable") ||
        out.includes("Semantic search is unavailable");
      expect(hasGuidance).toBe(true);
    }
  });
});

// Best-effort cleanup — temp dirs are cleaned per-test but verify none leaked.
afterAll(async () => {
  const tmp = "/tmp";
  const leftovers = await Bun.$`ls ${tmp}`
    .text()
    .then((s) =>
      s
        .split("\n")
        .filter((n) => n.startsWith("opencode-memory-test-")),
    )
    .catch(() => []);
  if (leftovers.length > 5) {
    // Not a test failure, just a warning in the output.
    console.warn(
      `[memory.test.ts] ${leftovers.length} leftover temp dirs in ${tmp}`,
    );
  }
  // Avoid unused-import warning on `exists`.
  void exists;
});
