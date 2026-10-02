import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadKnowledgeConfig } from "../src/lib/knowledge-config";
import { resolveRagBinary } from "../src/lib/rag";
import { runKnowledgeList, runKnowledgeRead, runKnowledgeSearch } from "../src/tools/knowledge";
import { makeTempDir } from "./helpers";

async function withKnowledgeConfig<T>(
  config: string,
  run: (root: string) => Promise<T>,
): Promise<T> {
  const temp = makeTempDir("opencode-knowledge-test-");
  const previous = process.env.OPENCODE_MEMORY_CONFIG;
  process.env.OPENCODE_MEMORY_CONFIG = join(temp.path, "config.toml");
  try {
    await writeFile(process.env.OPENCODE_MEMORY_CONFIG, config);
    return await run(temp.path);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_MEMORY_CONFIG;
    else process.env.OPENCODE_MEMORY_CONFIG = previous;
    temp.cleanup();
  }
}

test("a single named knowledge base becomes the default", async () => {
  await withKnowledgeConfig('[[knowledge_base]]\nname = "reference"\npath = "./reference"\n', async (root) => {
    await mkdir(join(root, "reference"));
    await writeFile(join(root, "reference", "rag.toml"), '[[index]]\nname = "docs"\npath = "."\n');
    const config = await loadKnowledgeConfig();
    expect(config.defaultName).toBe("reference");
    expect(config.bases[0].path).toBe(join(root, "reference"));
    expect(await runKnowledgeList()).toContain("reference (default)");
    expect(await runKnowledgeList({ base: "reference" })).toContain("Indexes: docs");
    expect(await runKnowledgeList({ base: "missing" })).toContain("Unknown knowledge base: missing");
  });
});

test("multiple bases require a default or explicit selection", async () => {
  const config = '[[knowledge_base]]\nname = "reference"\npath = "./reference"\n' +
    '[[knowledge_base]]\nname = "project"\npath = "./project"\n';
  await withKnowledgeConfig(config, async () => {
    const result = await runKnowledgeSearch({ query: "cache" }, async () => ({ exitCode: 0, stdout: "[]", stderr: "" }), "rag");
    expect(result).toContain("Choose base (reference, project)");
  });
});

test("search selects one base or all and preserves base and index identities", async () => {
  const config = '[[knowledge_base]]\nname = "reference"\npath = "./reference"\ndefault = true\n' +
    '[[knowledge_base]]\nname = "project"\npath = "./project"\n';
  await withKnowledgeConfig(config, async (root) => {
    for (const base of ["reference", "project"]) {
      await mkdir(join(root, base));
      await writeFile(join(root, base, "rag.toml"), '[[index]]\nname = "docs"\npath = "."\n');
    }
    const calls: string[] = [];
    const runner = async (_binary: string, path: string) => {
      calls.push(path);
      return { exitCode: 0, stderr: "", stdout: JSON.stringify([
        { index_name: "docs", source: "same.md", score: 0.8, text: `Found in ${path}` },
      ]) };
    };
    const defaultResult = await runKnowledgeSearch({ query: "cache" }, runner, "rag");
    expect(calls).toEqual([join(root, "reference", "rag.toml")]);
    expect(defaultResult).toContain("## reference");
    expect(defaultResult).toContain('knowledge_base_read(base="reference", index="docs", source="same.md")');
    calls.length = 0;
    const allResult = await runKnowledgeSearch({ query: "cache", all: true }, runner, "rag");
    expect(calls).toHaveLength(2);
    expect(allResult).toContain("## reference");
    expect(allResult).toContain("## project");
    expect(allResult).toContain('knowledge_base_read(base="project", index="docs", source="same.md")');
  });
});

test("search limits a base to one configured index and preserves the hit location", async () => {
  await withKnowledgeConfig('[[knowledge_base]]\nname = "reference"\npath = "./reference"\n', async (root) => {
    await mkdir(join(root, "reference"));
    await writeFile(join(root, "reference", "rag.toml"),
      '[[index]]\nname = "docs"\npath = "."\n[[index]]\nname = "api"\npath = "."\n');
    expect(await runKnowledgeList({ base: "reference" })).toContain("Indexes: docs, api");
    const selected: Array<string | undefined> = [];
    const runner = async (_binary: string, _config: string, _query: string, _limit: number, index?: string) => {
      selected.push(index);
      return { exitCode: 0, stderr: "", stdout: JSON.stringify([
        { index_name: "api", source: "reference.md", score: 0.9, text: "matched passage", byte_offset: 12 },
      ]) };
    };
    const result = await runKnowledgeSearch({ query: "endpoint", index: "api" }, runner, "rag");
    expect(selected).toEqual(["api"]);
    expect(result).toContain('knowledge_base_read(base="reference", index="api", source="reference.md", byte_offset=12)');
    expect(await runKnowledgeSearch({ query: "endpoint", index: "missing" }, runner, "rag"))
      .toContain("Unknown index missing. Available: docs, api");
    expect(selected).toEqual(["api"]);
    expect(await runKnowledgeSearch({ query: "endpoint", index: "api", all: true }, runner, "rag"))
      .toContain("Use either index or all");
  });
});

test("knowledge_base_read uses the selected index root outside the knowledge-base directory", async () => {
  await withKnowledgeConfig('[[knowledge_base]]\nname = "reference"\npath = "./reference"\n', async (root) => {
    await mkdir(join(root, "reference"));
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "reference", ".rag", "docs"), { recursive: true });
    await writeFile(join(root, "reference", "rag.toml"), '[[index]]\nname = "docs"\npath = "../repo"\n');
    await writeFile(join(root, "reference", ".rag", "docs", "meta.json"), JSON.stringify({
      source_root_from_index: relative(join(root, "reference", ".rag", "docs"), join(root, "repo")),
      file_hashes: { "note.md": "hash", "escape.md": "hash" },
    }));
    await writeFile(join(root, "repo", "note.md"), "alpha 🦊 beta gamma");
    await writeFile(join(root, "repo", ".env"), "secret");
    const result = await runKnowledgeRead({ index: "docs", source: "note.md", max_chars: 8 });
    expect(result).toContain("reference/docs/note.md");
    expect(result).toContain("alpha 🦊 ");
    expect(result).toContain("Continue with offset=8");
    const continuation = await runKnowledgeRead({ index: "docs", source: "note.md", offset: 8 });
    expect(continuation).toContain("eta gamma");
    const matched = await runKnowledgeRead({ index: "docs", source: "note.md", byte_offset: 11, max_chars: 4 });
    expect(matched).toContain("beta\n\n[Continue with offset=12]");
    expect(await runKnowledgeRead({ index: "docs", source: "note.md", offset: 12 })).toContain(" gamma");
    expect(await runKnowledgeRead({ index: "docs", source: "note.md", byte_offset: 7 }))
      .toContain("Could not read knowledge source");
    expect(await runKnowledgeRead({ index: "docs", source: "note.md", byte_offset: 100 }))
      .toContain("byte_offset exceeds source length");
    expect(await runKnowledgeRead({ index: "docs", source: "note.md", byte_offset: 11, offset: 8 }))
      .toContain("Use either offset or byte_offset");
    expect(await runKnowledgeRead({ index: "docs", source: "../outside.md" })).toContain("Could not read knowledge source");
    expect(await runKnowledgeRead({ index: "docs", source: ".env" })).toContain("Source is not indexed");
    if (process.platform !== "win32") {
      await writeFile(join(root, "outside.md"), "outside");
      await symlink(join(root, "outside.md"), join(root, "repo", "escape.md"));
      expect(await runKnowledgeRead({ index: "docs", source: "escape.md" })).toContain("source escapes its configured root");
    }
  });
});

test("duplicate names and multiple defaults are rejected", async () => {
  await withKnowledgeConfig('[[knowledge_base]]\nname = "same"\npath = "a"\n[[knowledge_base]]\nname = "same"\npath = "b"\n', async () => {
    await expect(loadKnowledgeConfig()).rejects.toThrow("Duplicate knowledge base name");
  });
  await withKnowledgeConfig('[[knowledge_base]]\nname = "a"\npath = "a"\ndefault = true\n[[knowledge_base]]\nname = "b"\npath = "b"\ndefault = true\n', async () => {
    await expect(loadKnowledgeConfig()).rejects.toThrow("Only one knowledge base");
  });
});

const modelIntegrationTest = process.env.OPENCODE_MEMORY_TEST_RAG_INTEGRATION === "1" ? test : test.skip;
modelIntegrationTest("indexes, searches, and reads a real knowledge source", async () => {
  await withKnowledgeConfig('[[knowledge_base]]\nname = "fixture"\npath = "./base"\n', async (root) => {
    const binary = resolveRagBinary();
    if (!binary) throw new Error("rag binary is unavailable");
    await mkdir(join(root, "base"));
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "other"));
    await writeFile(join(root, "base", "rag.toml"),
      '[[index]]\nname = "docs"\npath = "../repo"\n' +
      '[[index]]\nname = "other"\npath = "../other"\n');
    await writeFile(join(root, "repo", "guide.md"), "# Retry policy\nUse jitter to avoid retry storms.\n");
    await writeFile(join(root, "other", "note.md"), "# Other retry policy\nAvoid retry storms.\n");
    const indexed = Bun.spawnSync([binary, "index", "--config", join(root, "base", "rag.toml")]);
    expect(indexed.exitCode).toBe(0);
    const found = await runKnowledgeSearch({ query: "retry storms", index: "docs" });
    expect(found).toContain("docs/guide.md");
    expect(found).not.toContain("other/note.md");
    const match = found.match(/byte_offset=(\d+)/);
    expect(match).not.toBeNull();
    const read = await runKnowledgeRead({ index: "docs", source: "guide.md", byte_offset: Number(match![1]) });
    expect(read).toContain("Use jitter to avoid retry storms.");
  });
});
