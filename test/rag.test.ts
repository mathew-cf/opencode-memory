import { describe, expect, test } from "bun:test";
import { ragProcessEnv, resolveRagBinary, runRagKeywordFiles, runRagSearch, type RagCommandResult } from "../src/lib/rag";

describe("rag executable", () => {
  test("resolves the Windows native executable instead of the JavaScript shim", () => {
    const requested: string[] = [];
    const binary = resolveRagBinary("win32", "x64", (specifier) => {
      requested.push(specifier);
      return "C:\\rag-cli\\bin\\rag.exe";
    });
    expect(requested).toEqual(["@mathew-cf/rag-cli-win32-x64/bin/rag.exe"]);
    expect(binary).toBe("C:\\rag-cli\\bin\\rag.exe");
  });

  test("reports an absent platform package as unavailable", () => {
    expect(resolveRagBinary("win32", "arm64", () => {
      throw new Error("package not installed");
    })).toBeNull();
  });

  test("passes USERPROFILE as HOME to the Rust process", () => {
    expect(ragProcessEnv({ HOME: "", USERPROFILE: "C:\\Users\\mat", PATH: "bin" })).toEqual({
      HOME: "C:\\Users\\mat",
      USERPROFILE: "C:\\Users\\mat",
      PATH: "bin",
    });
    expect(ragProcessEnv({ HOME: "/chosen", USERPROFILE: "C:\\Users\\mat" }).HOME).toBe("/chosen");
  });
});

describe("runRagKeywordFiles", () => {
  test("passes live glob and OR patterns to rag keyword", async () => {
    let command: string[] = [];
    const files = await runRagKeywordFiles(
      "/bin/rag",
      { root: "/memory", patterns: ["foo", "bar"], globs: ["*.md", "!INDEX.md"] },
      async (argv) => {
        command = argv;
        return { exitCode: 0, stdout: "/memory/a.md\n/memory/b.md\n", stderr: "" };
      },
    );
    expect(files).toEqual(["/memory/a.md", "/memory/b.md"]);
    expect(command).toEqual([
      "/bin/rag", "keyword", "--files-with-matches", "--ignore-case",
      "--glob", "*.md", "--glob", "!INDEX.md", "-e", "foo", "-e", "bar", "/memory",
    ]);
  });

  test("distinguishes no matches from command failure", async () => {
    const request = { root: "/sessions", patterns: ["a.b"], globs: ["*.jsonl"], fixedStrings: true };
    const noMatches = await runRagKeywordFiles("rag", request, async () => ({ exitCode: 1, stdout: "", stderr: "" }));
    const failed = await runRagKeywordFiles("rag", request, async () => ({ exitCode: 2, stdout: "", stderr: "failed" }));
    expect(noMatches).toEqual([]);
    expect(failed).toBeUndefined();
  });

  test("uses the memory entry and its file rules when a config exists", async () => {
    let command: string[] = [];
    await runRagKeywordFiles("rag", {
      root: "/memory", configPath: "/memory/rag.toml", patterns: ["cache"], globs: ["*.md"],
    }, async (argv) => {
      command = argv;
      return { exitCode: 1, stdout: "", stderr: "" };
    });
    expect(command).toEqual([
      "rag", "keyword", "--files-with-matches", "--ignore-case", "--glob", "*.md",
      "-e", "cache", "--config", "/memory/rag.toml", "--only", "memory",
    ]);
  });
});

describe("runRagSearch", () => {
  test("uses only memory and disables rag-cli hybrid ranking", async () => {
    let command: string[] = [];
    await runRagSearch("rag", {
      query: "cache", indexDir: "/memory/.rag", configPath: "/memory/rag.toml",
    }, async (argv) => {
      command = argv;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });
    expect(command).toEqual([
      "rag", "search", "cache", "--config", "/memory/rag.toml", "--only", "memory",
      "--no-hybrid", "-k", "15", "--json", "--group-by-source",
    ]);
  });
  test("requests one result per source from current rag-cli versions", async () => {
    const calls: string[][] = [];
    const output = await runRagSearch(
      "/bin/rag",
      { query: "retry policy", indexDir: "/tmp/index", topK: 7 },
      async (argv): Promise<RagCommandResult> => {
        calls.push(argv);
        return { exitCode: 0, stdout: '[{"source":"one.md"}]', stderr: "" };
      },
    );

    expect(output).toBe('[{"source":"one.md"}]');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "/bin/rag",
      "search",
      "retry policy",
      "-i",
      "/tmp/index",
      "-k",
      "7",
      "--json",
      "--group-by-source",
    ]);
  });

  test("retries without group-by-source for an older installed rag-cli", async () => {
    const calls: string[][] = [];
    const output = await runRagSearch(
      "/bin/rag",
      { query: "query", indexDir: "/tmp/index" },
      async (argv): Promise<RagCommandResult> => {
        calls.push(argv);
        if (argv.includes("--group-by-source")) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "error: unexpected argument '--group-by-source' found",
          };
        }
        return { exitCode: 0, stdout: "legacy-json", stderr: "" };
      },
    );

    expect(output).toBe("legacy-json");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--group-by-source");
    expect(calls[1]).not.toContain("--group-by-source");
  });

  test("does not retry unrelated rag search failures", async () => {
    const calls: string[][] = [];
    const output = await runRagSearch(
      "/bin/rag",
      { query: "query", indexDir: "/missing" },
      async (argv): Promise<RagCommandResult> => {
        calls.push(argv);
        return { exitCode: 1, stdout: "", stderr: "index not found" };
      },
    );

    expect(output).toBe("");
    expect(calls).toHaveLength(1);
  });
});
