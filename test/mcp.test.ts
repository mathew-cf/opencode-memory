/**
 * MCP server smoke tests.
 *
 * The server's value to a user is purely behavioural — does it advertise
 * the right tools and route calls through to the same `runXxx` functions
 * the OpenCode plugin uses? These tests pair `InMemoryTransport` instances
 * with a real `Client` so we drive the protocol end-to-end without
 * spawning a subprocess or touching stdio.
 *
 * Per-tool semantics (search results, save behaviour, etc.) are covered
 * exhaustively in `memory.test.ts` against the `runXxx` functions. Here
 * we only assert the MCP boundary: the tool surface and the wiring.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp";
import { writeMemoryFile, makeTempDir, type TempDir } from "./helpers";

interface Harness {
  client: Client;
  cleanup: () => Promise<void>;
}

/**
 * Stand up a fresh client + server pair connected by an in-memory
 * transport. Returns the connected client and a cleanup function the
 * test must await — leaving transports open between tests cross-talks
 * via the SDK's shared protocol state.
 */
async function makeHarness(): Promise<Harness> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-test", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    cleanup: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

describe("MCP server", () => {
  let tmp: TempDir;
  let prevMemoryDir: string | undefined;

  beforeEach(() => {
    tmp = makeTempDir("opencode-memory-mcp-");
    prevMemoryDir = process.env.MEMORY_DIR;
    process.env.MEMORY_DIR = tmp.path;
  });

  afterEach(() => {
    if (prevMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = prevMemoryDir;
    tmp.cleanup();
  });

  test("advertises exactly the five memory tools", async () => {
    const h = await makeHarness();
    try {
      const { tools } = await h.client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "memory_access",
        "memory_list",
        "memory_save",
        "memory_search",
        "memory_setup",
      ]);
    } finally {
      await h.cleanup();
    }
  });

  test("memory_list with no category returns category summary", async () => {
    const h = await makeHarness();
    try {
      const result = await h.client.callTool({
        name: "memory_list",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const text = content.map((c) => c.text).join("\n");
      // All seven categories should appear in the summary.
      expect(text).toContain("preferences");
      expect(text).toContain("repos");
      expect(text).toContain("technical");
    } finally {
      await h.cleanup();
    }
  });

  test("memory_search finds a written file by keyword", async () => {
    const h = await makeHarness();
    try {
      await writeMemoryFile(
        tmp.path,
        "technical/widget-protocol.md",
        {
          title: "Widget protocol notes",
          tags: "[widget, protocol]",
          summary: "How the widget protocol negotiates handshake frames",
        },
        "Widget protocol uses a 3-way handshake before any data frames.",
      );
      const result = await h.client.callTool({
        name: "memory_search",
        arguments: { query: "widget" },
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const text = content.map((c) => c.text).join("\n");
      expect(text).toContain("widget-protocol.md");
    } finally {
      await h.cleanup();
    }
  });

  test("memory_setup reports backend status without throwing", async () => {
    const h = await makeHarness();
    try {
      const result = await h.client.callTool({
        name: "memory_setup",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const text = content.map((c) => c.text).join("\n");
      // Both backend lines always show up; their exact values depend on
      // the environment so we only assert presence.
      expect(text).toContain("ripgrep");
      expect(text).toContain("rag");
    } finally {
      await h.cleanup();
    }
  });

  test("unknown tool name surfaces as an MCP error result", async () => {
    const h = await makeHarness();
    try {
      // The SDK doesn't reject the promise for an unknown tool; instead
      // it returns a CallToolResult with `isError: true` so the LLM can
      // see the error inline and recover.
      const result = await h.client.callTool({
        name: "memory_bogus",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const text = content.map((c) => c.text).join("\n");
      expect(text).toContain("memory_bogus");
      expect(text).toContain("not found");
    } finally {
      await h.cleanup();
    }
  });
});
