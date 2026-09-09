import { describe, expect, test } from "bun:test";
import { runRagSearch, type RagCommandResult } from "../src/lib/rag";

describe("runRagSearch", () => {
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
