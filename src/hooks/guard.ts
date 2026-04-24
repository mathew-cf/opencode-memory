/**
 * Memory Guard — nudge agents to follow the memory protocol.
 *
 * Responsibilities:
 *  1. Track `memory_search`, `session_search`, and `memory_save` calls per session.
 *  2. After tool calls, inject contextual reminders:
 *     - If >8 tool calls without any `memory_search` or `session_search`,
 *       remind the agent to search before going deeper.
 *     - If a subagent's output contains "Discoveries worth saving",
 *       remind the parent to actually save them.
 *  3. On session compaction, inject memory-specific context preservation
 *     rules and a retrospective reminder if no memory saves have happened.
 *
 * This file is plain logic — the tool name matching is by default suffix
 * so it works whether the tool is registered as `memory_search` (plugin
 * export), `opencode-memory_memory_search` (custom-tool filename), or some
 * other variant. That gives us one hook file that's robust to renames.
 */

export interface SessionState {
  toolCalls: number;
  memorySearched: boolean;
  sessionSearched: boolean;
  memorySaved: boolean;
  saveCount: number;
  discoveryNudged: boolean;
  searchNudged: boolean;
}

/** Initial state for a fresh session. Exported so tests can compare. */
export function makeInitialState(): SessionState {
  return {
    toolCalls: 0,
    memorySearched: false,
    sessionSearched: false,
    memorySaved: false,
    saveCount: 0,
    discoveryNudged: false,
    searchNudged: false,
  };
}

/**
 * Normalized check for whether a tool name matches one of the memory/session
 * tools. Accepts both bare names (`memory_search`) and namespaced variants
 * (`opencode-memory.memory_search` or similar). Exported for tests.
 */
export function matchesToolName(
  toolName: string,
  candidates: string[],
): boolean {
  const lower = toolName.toLowerCase();
  return candidates.some((c) => lower === c || lower.endsWith(`_${c}`) || lower.endsWith(`.${c}`));
}

/**
 * After-tool-call reducer. Updates state and returns any reminder text to
 * append to the tool's output. Returns `null` if no reminder should fire.
 *
 * Kept as a pure function on `(state, input) -> reminder | null` so tests
 * can reason about the nudge timing without plumbing through a full plugin
 * context.
 */
export function afterToolUpdate(
  state: SessionState,
  input: { tool: string; output: string },
): string | null {
  state.toolCalls++;

  if (matchesToolName(input.tool, ["memory_search"])) state.memorySearched = true;
  if (matchesToolName(input.tool, ["session_search"])) state.sessionSearched = true;
  if (matchesToolName(input.tool, ["memory_save"])) {
    state.memorySaved = true;
    state.saveCount++;
  }

  // --- Nudge: search first ---
  // After 8 tool calls without at least one of memory_search / session_search,
  // append a single reminder. Firing only once prevents spam.
  if (
    !state.searchNudged &&
    state.toolCalls >= 8 &&
    (!state.memorySearched || !state.sessionSearched)
  ) {
    state.searchNudged = true;
    const missing: string[] = [];
    if (!state.memorySearched) missing.push("memory_search");
    if (!state.sessionSearched) missing.push("session_search");
    return (
      `<system-reminder>` +
      `You have made ${state.toolCalls} tool calls without calling ${missing.join(" or ")}. ` +
      `Per the Memory & Session Protocol, you MUST search both before starting non-trivial work. ` +
      `Do it now unless this is a trivial task.` +
      `</system-reminder>`
    );
  }

  // --- Nudge: subagent discoveries ---
  // Watch the `task` tool output for "Discoveries worth saving" so the
  // parent doesn't forget to record them.
  if (
    matchesToolName(input.tool, ["task"]) &&
    !state.discoveryNudged &&
    typeof input.output === "string" &&
    input.output.includes("Discoveries worth saving")
  ) {
    state.discoveryNudged = true;
    return (
      `<system-reminder>` +
      `The subagent reported "Discoveries worth saving" above. ` +
      `Per protocol, you MUST save these to ~/opencode-memory/ now — ` +
      `don't defer to session end. Write the file, then call memory_save.` +
      `</system-reminder>`
    );
  }

  return null;
}

/**
 * Build the compaction context that should survive a session summarization
 * so the next post-compaction turn still knows about memory pointers and
 * unfinished retrospectives. Pure function, easy to snapshot in tests.
 */
export function buildCompactionContext(state: SessionState): string {
  const lines = [
    "## Memory Protocol — Preserve Through Compaction",
    "- Preserve any memory file paths referenced or read in this session",
    "- Preserve any memory_search results that informed decisions",
    "- Preserve any session_search results that provided useful context",
    "- Preserve any subagent 'Discoveries worth saving' that haven't been saved yet",
  ];

  if (!state.memorySaved && state.toolCalls > 10) {
    lines.push(
      "",
      "## MEMORY RETROSPECTIVE REQUIRED",
      `This session has made ${state.toolCalls} tool calls with ${state.saveCount} memory saves.`,
      "Before ending, you MUST run the retrospective:",
      "1. What did you discover that took >1 min? Save it now.",
      "2. Were any memories you used inaccurate? Update them.",
      "3. Did any subagent report discoveries? Save them.",
      "4. Did session_search reveal insights not yet in memory? Save them.",
      "Do NOT skip this step.",
    );
  }

  return lines.join("\n");
}

// --- Plugin-side wiring -----------------------------------------------

/**
 * Factory that returns the two hook callbacks (`tool.execute.after` and
 * `experimental.session.compacting`) plus the backing state map. The map
 * is returned so tests can introspect per-session state directly.
 */
export function createGuardHooks() {
  const sessions = new Map<string, SessionState>();

  function getState(sessionId: string): SessionState {
    let s = sessions.get(sessionId);
    if (!s) {
      s = makeInitialState();
      sessions.set(sessionId, s);
    }
    return s;
  }

  return {
    sessions,
    getState,
    toolAfter: async (
      input: { tool: string; args: unknown; sessionID?: string },
      output: { title?: string; output?: string; metadata?: unknown },
    ) => {
      const sid = input.sessionID || "_default";
      const state = getState(sid);
      const reminder = afterToolUpdate(state, {
        tool: input.tool,
        output: typeof output.output === "string" ? output.output : "",
      });
      if (reminder) {
        output.output = (output.output || "") + `\n\n${reminder}`;
      }
    },
    compacting: async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      const sid = input.sessionID || "_default";
      const state = getState(sid);
      output.context.push(buildCompactionContext(state));
    },
  };
}
