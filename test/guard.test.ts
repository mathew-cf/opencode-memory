import { describe, expect, test } from "bun:test";
import {
  afterToolUpdate,
  buildCompactionContext,
  createGuardHooks,
  makeInitialState,
  matchesToolName,
} from "../src/hooks/guard";

describe("matchesToolName", () => {
  test("matches exact tool names", () => {
    expect(matchesToolName("memory_search", ["memory_search"])).toBe(true);
    expect(matchesToolName("something_else", ["memory_search"])).toBe(false);
  });

  test("matches namespaced variants (suffix after _)", () => {
    expect(matchesToolName("opencode-memory_memory_search", ["memory_search"])).toBe(true);
  });

  test("matches namespaced variants (suffix after .)", () => {
    expect(matchesToolName("plugin.memory_search", ["memory_search"])).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(matchesToolName("Memory_Search", ["memory_search"])).toBe(true);
  });
});

describe("afterToolUpdate", () => {
  test("increments toolCalls", () => {
    const state = makeInitialState();
    afterToolUpdate(state, { tool: "bash", output: "" });
    afterToolUpdate(state, { tool: "bash", output: "" });
    expect(state.toolCalls).toBe(2);
  });

  test("sets memorySearched on memory_search", () => {
    const state = makeInitialState();
    afterToolUpdate(state, { tool: "memory_search", output: "" });
    expect(state.memorySearched).toBe(true);
  });

  test("sets sessionSearched on session_search", () => {
    const state = makeInitialState();
    afterToolUpdate(state, { tool: "session_search", output: "" });
    expect(state.sessionSearched).toBe(true);
  });

  test("sets memorySaved and increments saveCount", () => {
    const state = makeInitialState();
    afterToolUpdate(state, { tool: "memory_save", output: "" });
    afterToolUpdate(state, { tool: "memory_save", output: "" });
    expect(state.memorySaved).toBe(true);
    expect(state.saveCount).toBe(2);
  });

  test("fires the 'search first' reminder at the 8th tool call", () => {
    const state = makeInitialState();
    for (let i = 0; i < 7; i++) {
      const out = afterToolUpdate(state, { tool: "bash", output: "" });
      expect(out).toBeNull();
    }
    const out = afterToolUpdate(state, { tool: "bash", output: "" });
    expect(out).not.toBeNull();
    expect(out).toContain("8 tool calls");
    expect(out).toContain("memory_search");
    expect(out).toContain("session_search");
    expect(state.searchNudged).toBe(true);
  });

  test("does not fire the reminder twice", () => {
    const state = makeInitialState();
    for (let i = 0; i < 8; i++) {
      afterToolUpdate(state, { tool: "bash", output: "" });
    }
    expect(state.searchNudged).toBe(true);
    const again = afterToolUpdate(state, { tool: "bash", output: "" });
    expect(again).toBeNull();
  });

  test("skips the reminder if memory_search happened early", () => {
    const state = makeInitialState();
    afterToolUpdate(state, { tool: "memory_search", output: "" });
    afterToolUpdate(state, { tool: "session_search", output: "" });
    for (let i = 0; i < 20; i++) {
      const out = afterToolUpdate(state, { tool: "bash", output: "" });
      expect(out).toBeNull();
    }
  });

  test("fires a nudge when only session_search is missing", () => {
    const state = makeInitialState();
    afterToolUpdate(state, { tool: "memory_search", output: "" });
    for (let i = 0; i < 8; i++) {
      const out = afterToolUpdate(state, { tool: "bash", output: "" });
      if (out) {
        expect(out).toContain("session_search");
        expect(out).not.toContain("memory_search or");
        return;
      }
    }
    throw new Error("expected a reminder to fire");
  });

  test("fires a discovery nudge once when a subagent reports findings", () => {
    const state = makeInitialState();
    const out = afterToolUpdate(state, {
      tool: "task",
      output:
        "subagent report\n## Discoveries worth saving\n- interesting finding",
    });
    expect(out).not.toBeNull();
    expect(out).toContain("Discoveries worth saving");
    expect(state.discoveryNudged).toBe(true);

    const again = afterToolUpdate(state, {
      tool: "task",
      output: "Discoveries worth saving in another run",
    });
    expect(again).toBeNull();
  });

  test("ignores discoveries on non-task tools", () => {
    const state = makeInitialState();
    const out = afterToolUpdate(state, {
      tool: "bash",
      output: "Discoveries worth saving",
    });
    expect(out).toBeNull();
  });
});

describe("buildCompactionContext", () => {
  test("always includes the preserve-through-compaction instructions", () => {
    const state = makeInitialState();
    const ctx = buildCompactionContext(state);
    expect(ctx).toContain("Preserve any memory file paths");
    expect(ctx).toContain("Discoveries worth saving");
  });

  test("appends a retrospective block when the session has many calls and no saves", () => {
    const state = makeInitialState();
    state.toolCalls = 15;
    state.memorySaved = false;
    const ctx = buildCompactionContext(state);
    expect(ctx).toContain("MEMORY RETROSPECTIVE REQUIRED");
    expect(ctx).toContain("15 tool calls");
    expect(ctx).toContain("0 memory saves");
  });

  test("omits the retrospective block if saves have happened", () => {
    const state = makeInitialState();
    state.toolCalls = 15;
    state.memorySaved = true;
    state.saveCount = 1;
    const ctx = buildCompactionContext(state);
    expect(ctx).not.toContain("MEMORY RETROSPECTIVE REQUIRED");
  });

  test("omits the retrospective block if the session is short", () => {
    const state = makeInitialState();
    state.toolCalls = 5;
    state.memorySaved = false;
    const ctx = buildCompactionContext(state);
    expect(ctx).not.toContain("MEMORY RETROSPECTIVE REQUIRED");
  });
});

describe("createGuardHooks", () => {
  test("tracks state per session", async () => {
    const g = createGuardHooks();
    await g.toolAfter(
      { tool: "bash", args: {}, sessionID: "s1" },
      { output: "" },
    );
    await g.toolAfter(
      { tool: "bash", args: {}, sessionID: "s2" },
      { output: "" },
    );
    await g.toolAfter(
      { tool: "memory_search", args: {}, sessionID: "s1" },
      { output: "" },
    );
    expect(g.getState("s1").toolCalls).toBe(2);
    expect(g.getState("s1").memorySearched).toBe(true);
    expect(g.getState("s2").toolCalls).toBe(1);
    expect(g.getState("s2").memorySearched).toBe(false);
  });

  test("appends reminder text to the tool output object", async () => {
    const g = createGuardHooks();
    const output = { output: "original" };
    // Drive the session to the 8-call threshold without a memory search.
    for (let i = 0; i < 7; i++) {
      await g.toolAfter(
        { tool: "bash", args: {}, sessionID: "s" },
        { output: "" },
      );
    }
    await g.toolAfter({ tool: "bash", args: {}, sessionID: "s" }, output);
    expect(output.output).toContain("original");
    expect(output.output).toContain("<system-reminder>");
  });

  test("compacting hook pushes context onto the array", async () => {
    const g = createGuardHooks();
    await g.toolAfter(
      { tool: "bash", args: {}, sessionID: "s" },
      { output: "" },
    );
    const ctx: string[] = [];
    await g.compacting({ sessionID: "s" }, { context: ctx });
    expect(ctx).toHaveLength(1);
    expect(ctx[0]).toContain("Preserve any memory file paths");
  });
});
