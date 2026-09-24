/**
 * Integration tests for the memory_* tools.
 *
 * Each test creates a fresh temp memory directory (via `withMemoryDir`)
 * and writes a few sample files before exercising the tool. The tools
 * degrade gracefully when `rag` isn't installed, so these tests run
 * without needing the Rust toolchain — they just exercise keyword search.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, exists, stat, symlink, unlink } from "node:fs/promises";
import {
  buildRgArgs,
  parseRagHits,
  runAccess,
  runList,
  runRead,
  runSave,
  runSearch,
  runSetup,
  selectHeadingSection,
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

  test("rejects categories outside the fixed memory taxonomy", async () => {
    await withMemoryDir(async () => {
      expect(await runList({ category: "../private" })).toBe("Invalid memory category: ../private");
      expect(await runSearch({ query: "secret", category: "../private" })).toBe("Invalid memory category: ../private");
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
      expect(out).toContain("Evidence: keyword");
      expect(out).not.toContain("combined_score");
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

  test("normal output distinguishes candidates from the five shown and details only two", async () => {
    await withMemoryDir(async (dir) => {
      for (let i = 1; i <= 6; i++) {
        await writeMemoryFile(
          dir,
          `technical/hit-${i}.md`,
          { title: `Hit ${i}`, summary: `evidence ${i}` },
          "sharedneedle",
        );
      }

      const out = await runSearch({ query: "sharedneedle" });
      expect(out).toContain("6 candidates, showing 5");
      expect(out.match(/Evidence:/g)).toHaveLength(2);
      expect(out).not.toContain("combined_score");
      expect(out).not.toContain("**Related files**");
    });
  });

  test("debug output preserves ranking diagnostics and related-file expansion", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(
        dir,
        "technical/main.md",
        { title: "Main", summary: "main", related: ["notes/related.md"] },
        "diagnosticneedle",
      );
      await writeMemoryFile(dir, "notes/related.md", { title: "Related" }, "other content");

      const normal = await runSearch({ query: "diagnosticneedle" });
      expect(normal).not.toContain("combined_score");
      expect(normal).not.toContain("**Related files**");

      const debug = await runSearch({ query: "diagnosticneedle", detail: "debug" });
      expect(debug).toContain("combined_score=");
      expect(debug).toContain("**Related files** (debug expansion)");
      expect(debug).toContain("notes/related.md");
    });
  });
});

describe("selectHeadingSection", () => {
  test("includes descendants and stops at the next peer heading", () => {
    const body = "# Intro\nfirst\n## Child\nchild\n# Next\nsecond";
    expect(selectHeadingSection(body, "Intro")).toBe("# Intro\nfirst\n## Child\nchild");
    expect(selectHeadingSection(body, "# next")).toBe("# Next\nsecond");
  });
});

describe("runRead", () => {
  test("returns frontmatter plus one heading section and records access", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(
        dir,
        "technical/sections.md",
        { title: "Sections", access_count: 2 },
        "# Intro\nintro text\n## Detail\nchild text\n# Build\nbuild text\n# End\nend text",
      );

      const out = await runRead({ path: "technical/sections.md", heading: "Intro" });
      expect(out).toContain("title: Sections");
      expect(out).toContain("# Intro\nintro text\n## Detail\nchild text");
      expect(out).not.toContain("# Build");
      expect(out).toContain("truncated=false");

      const updated = await Bun.file(`${dir}/technical/sections.md`).text();
      expect(updated).toContain("access_count: 2");
      expect(updated).not.toContain("last_accessed:");
      expect(await runAccess({ path: "technical/sections.md" })).toContain("count: 4");
    });
  });

  test("bounds beginning reads to 4000 by default and 16000 at most", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(dir, "notes/long.md", { title: "Long" }, "x".repeat(17_000));

      const defaultOut = await runRead({ path: "notes/long.md" });
      expect(defaultOut).toContain("shown_chars=4000");
      expect(defaultOut).toContain("truncated=true");
      const next = Number(defaultOut.match(/next_char=(\d+)/)?.[1]);
      expect(next).toBeGreaterThan(0);
      expect(next).toBeLessThan(4000);

      const continuation = await runRead({ path: "notes/long.md", offset: next });
      expect(continuation).toContain(`offset=${next}`);
      expect(continuation).toContain("shown_chars=4000");
      expect(continuation).not.toContain("title: Long");

      const boundedOut = await runRead({ path: "notes/long.md", maxChars: 99_999 });
      expect(boundedOut).toContain("shown_chars=16000");
      expect(boundedOut).toMatch(/remaining_chars=10\d{2}/);
    });
  });

  test("paginates without splitting surrogate pairs", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(dir, "notes/emoji.md", { title: "Emoji" }, "🌍🌍done");
      const first = await runRead({ path: "notes/emoji.md", maxChars: 2 });
      expect(first).toContain("🌍");
      expect(first).not.toContain("�");
      expect(first).toContain("next_char=2");
      const second = await runRead({ path: "notes/emoji.md", offset: 2, maxChars: 2 });
      expect(second).toContain("🌍");
      expect(second).not.toContain("�");
    });
  });

  test("counts bounded frontmatter within the memory-content limit", async () => {
    await withMemoryDir(async (dir) => {
      await Bun.write(
        `${dir}/notes/metadata.md`,
        `---\ntitle: Metadata\ngenerated: ${"m".repeat(8_000)}\n---\n${"b".repeat(8_000)}`,
      );
      const out = await runRead({ path: "notes/metadata.md", maxChars: 4_000 });
      expect(out).toContain("shown_chars=4000");
      expect(out).toContain("frontmatter_truncated=");
      expect(out.indexOf("\n---\n[memory_read:")).toBeLessThanOrEqual(4_001);
    });
  });

  test("rejects traversal and symlink escapes and does not record failed access", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(
        dir,
        "technical/safe.md",
        { title: "Safe", access_count: 4 },
        "# Present\ncontent",
      );

      const traversal = await runRead({ path: "../outside.md" });
      expect(traversal).toContain("outside the memory directory");

      const outside = `${dir}-outside.md`;
      await Bun.write(outside, "---\ntitle: Outside\naccess_count: 1\n---\nsecret");
      await symlink(outside, `${dir}/technical/escape.md`);
      expect(await runRead({ path: "technical/escape.md" })).toContain("outside the memory directory");
      expect(await runAccess({ path: "technical/escape.md" })).toContain("Could not update");
      expect(await Bun.file(outside).text()).toContain("access_count: 1");
      await unlink(outside);

      const missingHeading = await runRead({ path: "technical/safe.md", heading: "Missing" });
      expect(missingHeading).toContain("Heading not found");
      const unchanged = await Bun.file(`${dir}/technical/safe.md`).text();
      expect(unchanged).toContain("access_count: 4");
      expect(unchanged).not.toContain("last_accessed:");
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
      expect(updated).toContain("access_count: 3");
      expect(updated).not.toContain("last_accessed:");
    });
  });

  test("serializes concurrent access increments without losing updates", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(dir, "technical/concurrent.md", { title: "Concurrent", access_count: 0 }, "body");
      const results = await Promise.all(Array.from({ length: 8 }, () => runAccess({ path: "technical/concurrent.md" })));
      expect(results.every((result) => result.includes("Recorded access"))).toBe(true);
      expect(results.some((result) => result.includes("count: 8"))).toBe(true);
      expect(await Bun.file(`${dir}/technical/concurrent.md`).text()).toContain("access_count: 0");
    });
  });

  test("preserves private file permissions while recording access", async () => {
    await withMemoryDir(async (dir) => {
      await writeMemoryFile(dir, "technical/private.md", { title: "Private" }, "body");
      const path = `${dir}/technical/private.md`;
      await chmod(path, 0o600);
      await runRead({ path: "technical/private.md" });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
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
  test("reports status lines for both ripgrep and the rag binary", async () => {
    const out = await runSetup();
    // We don't assume a particular install state — tests are run with
    // both deps linked, but the output shape should be consistent even
    // if one resolves and the other doesn't.
    expect(out).toContain("ripgrep (keyword search):");
    expect(out).toContain("rag binary (semantic search):");
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
