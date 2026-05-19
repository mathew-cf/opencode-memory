#!/usr/bin/env bun
/**
 * MCP stdio server entry point.
 *
 * Wraps the same four memory tools the OpenCode plugin exposes
 * (`memory_search`, `memory_list`, `memory_save`, `memory_access`,
 * `memory_setup`) as a Model Context Protocol server speaking JSON-RPC
 * over stdio. Any MCP-aware host can mount it:
 *
 *   - Zed's native agent panel (`context_servers` in settings.json)
 *   - Pi via `pi-mcp-adapter`
 *   - Claude Code, Cursor, etc.
 *
 * The plugin entry point in `src/index.ts` is unaffected — OpenCode still
 * loads memory tools natively with the hook/skill/permission machinery.
 * The MCP server is a separate distribution channel for the *tools only*,
 * for hosts that don't speak the OpenCode plugin API.
 *
 * Session tools (`session_search`, `session_read`, `session_list`) are
 * intentionally NOT exposed here — they read OpenCode's SQLite schema
 * and would mislead non-OpenCode hosts about what data is available.
 *
 * Runtime is Bun (see `src/cli.ts` for the same reasoning — the
 * underlying tools use `Bun.$`, `Bun.spawn`, `Bun.file`). Hosts should
 * launch via `bunx`:
 *
 *   command: bunx
 *   args:    ["@mathew-cf/opencode-memory", "opencode-memory-mcp"]
 *
 * or with an absolute `bunx` path (Zed launched from Dock has no PATH).
 *
 * IMPORTANT: stdout is reserved for the JSON-RPC frame stream the SDK
 * writes. Everything diagnostic must go to stderr. The tool `runXxx`
 * functions all return strings without writing to stdout directly, and
 * background work (e.g. `rag index` in `runSave`) is spawned with
 * `stdout: "ignore"`, so this invariant holds.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import { CATEGORIES } from "./constants";
import {
  runAccess,
  runList,
  runSave,
  runSearch,
  runSetup,
} from "./tools/memory";

/**
 * MCP tool result shape — small subset of CallToolResult we actually use.
 * Typing this ourselves avoids importing the SDK's deeply-generic
 * `CallToolResult` type, which (combined with `McpServer.registerTool`'s
 * dual `OutputArgs`/`InputArgs` generics) triggers TS2589 "Type
 * instantiation is excessively deep" when more than a couple of tools
 * register against the same server. The runtime shape matches the spec.
 */
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [extra: string]: unknown;
}

/**
 * Local helper that wraps `McpServer.registerTool` while erasing the
 * inferred generic parameters. Each call independently widens to plain
 * `Record<string, unknown>` so the type checker doesn't try to track a
 * cumulative shape across registrations.
 */
function register<S extends ZodRawShape>(
  server: McpServer,
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema?: S;
  },
  cb: (args: { [K in keyof S]: z.infer<S[K]> }) => Promise<ToolResult>,
): void {
  // The SDK's overload set creates an excessively deep instantiation
  // when more than ~2 tools accumulate on the same server in strict
  // mode. We've reproduced the bug locally — pinning the callback type
  // via this helper avoids the deep inference path entirely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(name, config, cb);
}

// Pulled in lazily so this module doesn't pay the require cost when only
// `createMcpServer()` is being inspected from tests.
function packageVersion(): string {
  try {
    // The build emits dist/mcp.js next to dist/index.js with the original
    // package.json one directory up — same layout as src/ during dev.
    // import.meta.url is reliable in both cases.
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // fall through
  }
  return "0.0.0";
}

const wrapResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

const wrapError = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
  isError: true,
});

const categoryEnum = `One of: ${CATEGORIES.join(", ")}`;

/**
 * Build an `McpServer` with the four memory tools registered. Pure
 * function — no transport, no stdio. Tests link a pair of
 * `InMemoryTransport` instances and exercise the server end-to-end.
 *
 * Each tool's `description` mirrors the OpenCode plugin's tool prompt
 * so MCP hosts surface the same usage guidance the LLM sees in OpenCode.
 * Keep the two in sync when editing — the plugin description lives in
 * `src/tools/memory.ts`.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "opencode-memory",
    version: packageVersion(),
  });

  register(
    server,
    "memory_search",
    {
      title: "Search memory",
      description:
        "Search memories in ~/opencode-memory/ using both keyword (rg) and semantic (rag) search. " +
        "Results are summaries only (path, tags, importance, short context). " +
        "Use the Read tool on ~/opencode-memory/{path} to get the full content.\n\n" +
        "Multi-term queries match files containing ANY search term (OR logic); files matching more terms rank higher. " +
        "For example, 'errors retries' finds files mentioning 'errors' OR 'retries', with files containing both ranked first.\n\n" +
        "WHEN TO SEARCH (do this BEFORE starting work):\n" +
        "- Starting work on any repo — there may be saved context about structure, conventions, or gotchas\n" +
        "- Using an external tool or API with non-obvious usage patterns\n" +
        "- Encountering an unfamiliar codebase, service, or system\n" +
        "- Debugging a problem you or a previous session may have solved before\n" +
        "- Looking up a person, team, or ownership information\n" +
        "- Before writing new memory — check if a file already exists to update instead of duplicate",
      inputSchema: {
        query: z
          .string()
          .describe("Search terms or natural language query"),
        category: z
          .string()
          .optional()
          .describe(`Filter to a specific category. ${categoryEnum}`),
      },
    },
    async ({ query, category }) => {
      try {
        return wrapResult(await runSearch({ query, category }));
      } catch (err) {
        return wrapError(err);
      }
    },
  );

  register(
    server,
    "memory_list",
    {
      title: "List memory categories or files",
      description:
        "Browse memories in ~/opencode-memory/. Without a category, lists all categories with file counts. " +
        "With a category, lists files in that category with their summaries.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe(`Category to list. ${categoryEnum}`),
      },
    },
    async ({ category }) => {
      try {
        return wrapResult(await runList({ category }));
      } catch (err) {
        return wrapError(err);
      }
    },
  );

  register(
    server,
    "memory_save",
    {
      title: "Commit + re-index memory changes",
      description:
        "Commit and re-index all pending memory changes. " +
        "Call AFTER writing/editing files at ~/opencode-memory/{category}/{filename}.md. " +
        "Handles: git add -A, commit (message derived from changed files), RAG re-indexing.\n\n" +
        "WHEN TO SAVE (always save when you discover something reusable):\n" +
        "- Learned a non-obvious API pattern, tool quirk, or workaround\n" +
        "- Discovered repo structure, conventions, or gotchas that future sessions would benefit from\n" +
        "- Resolved a tricky debugging problem with a non-obvious root cause\n" +
        "- Learned team/ownership/contact information not easily found elsewhere\n" +
        "DO NOT save: one-off answers, things in public docs, or context only relevant to the current task\n\n" +
        "REPO NOTES: for repository-related memory, use the path structure\n" +
        "`repos/{host}/{org}/{repo}.md` — e.g. `repos/github.com/user/project.md`.\n\n" +
        `CATEGORIES: ${CATEGORIES.join(", ")}\n\n` +
        "FRONTMATTER (include at top of every file):\n" +
        "---\n" +
        "title: Human-readable title\n" +
        "tags: [tag1, tag2]\n" +
        "summary: One-line summary\n" +
        "created: YYYY-MM-DD\n" +
        "updated: YYYY-MM-DD\n" +
        "importance: high | medium | low\n" +
        "related: [category/file.md]\n" +
        "---",
      inputSchema: {},
    },
    async () => {
      try {
        return wrapResult(await runSave());
      } catch (err) {
        return wrapError(err);
      }
    },
  );

  register(
    server,
    "memory_access",
    {
      title: "Record memory file access",
      description:
        "Record that a memory file was accessed (read and used). Updates last_accessed date " +
        "and increments access_count in frontmatter. Call this AFTER reading a memory file " +
        "that you actually used to inform your work — not for casual browsing.\n\n" +
        "This helps the memory system track which memories are actively useful vs. stale.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Relative path within ~/opencode-memory/ (e.g. 'technical/build-tooling.md')",
          ),
      },
    },
    async ({ path }) => {
      try {
        return wrapResult(await runAccess({ path }));
      } catch (err) {
        return wrapError(err);
      }
    },
  );

  register(
    server,
    "memory_setup",
    {
      title: "Report search-backend status",
      description:
        "Reports whether ripgrep and `@mathew-cf/rag-cli` are resolvable from this package's " +
        "node_modules, and prints installation guidance if either is missing. " +
        "Safe to run at any time — does not modify anything.",
      inputSchema: {},
    },
    async () => {
      try {
        return wrapResult(await runSetup());
      } catch (err) {
        return wrapError(err);
      }
    },
  );

  return server;
}

/**
 * Connect a fresh `McpServer` to stdio and block. Intended for direct
 * invocation as the `opencode-memory-mcp` bin. Tests call
 * `createMcpServer()` and wire their own transport instead.
 */
export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Direct invocation guard. Fires when bundled to dist/mcp.js and invoked
// via the bin shim; suppressed when imported by tests.
const isDirect = (() => {
  try {
    return (
      // @ts-ignore — `main` exists on Bun's import.meta, not vanilla Node.
      import.meta.main === true ||
      (typeof process.argv[1] === "string" &&
        (process.argv[1].endsWith("/mcp.js") ||
          process.argv[1].endsWith("\\mcp.js") ||
          process.argv[1].endsWith("/opencode-memory-mcp") ||
          process.argv[1].endsWith("\\opencode-memory-mcp")))
    );
  } catch {
    return false;
  }
})();

if (isDirect) {
  runMcpServer().catch((err) => {
    process.stderr.write(`opencode-memory-mcp: ${String(err)}\n`);
    process.exit(1);
  });
}
