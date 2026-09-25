/**
 * OpenCode Memory Plugin — persistent cross-session memory.
 *
 * Wires up:
 *  - 6 memory tools (search / read / list / save / access / setup)
 *  - Session tools (cross-harness search plus OpenCode search / read / list)
 *  - 2 hooks (tool.execute.after guard + compaction context injection)
 *  - Config modifications (skill path, agent prompts, permission rules)
 */

import { tool, type Plugin, type ToolDefinition as V1ToolDefinition } from "@opencode-ai/plugin";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyConfig } from "./config";
import { createGuardHooks } from "./hooks/guard";
import type { ToolDefinition } from "./lib/tool-definition";
import * as memory from "./tools/memory";
import * as knowledge from "./tools/knowledge";
import * as session from "./tools/session";

function adaptTool(definition: ToolDefinition): V1ToolDefinition {
  return tool({
    description: definition.description,
    args: definition.input.shape as unknown as Parameters<typeof tool>[0]["args"],
    async execute(input, context) {
      return (await definition.execute(input, context)).content;
    },
  });
}

type AdaptedTools<Source, Keys extends keyof Source> = Omit<Source, Keys> & Record<Keys, V1ToolDefinition>;

const memoryTools: AdaptedTools<typeof memory, "search" | "read" | "list" | "save" | "access" | "setup"> = {
  ...memory,
  search: adaptTool(memory.search),
  read: adaptTool(memory.read),
  list: adaptTool(memory.list),
  save: adaptTool(memory.save),
  access: adaptTool(memory.access),
  setup: adaptTool(memory.setup),
};

const sessionTools: AdaptedTools<typeof session, "search" | "searchAll" | "read" | "list"> = {
  ...session,
  search: adaptTool(session.search),
  searchAll: adaptTool(session.searchAll),
  read: adaptTool(session.read),
  list: adaptTool(session.list),
};

const knowledgeTools: AdaptedTools<typeof knowledge, "search" | "read" | "list"> = {
  ...knowledge,
  search: adaptTool(knowledge.search),
  read: adaptTool(knowledge.read),
  list: adaptTool(knowledge.list),
};

/**
 * Locate the `skills/` directory that ships with this package. Works
 * whether the plugin is loaded from source (src/index.ts), from a
 * bundled dist (dist/index.js), or from an npm install under
 * node_modules/.
 */
function resolveSkillsDir(): string | undefined {
  try {
    const here =
      // ESM
      typeof import.meta !== "undefined" && import.meta.url
        ? dirname(fileURLToPath(import.meta.url))
        : // CJS fallback
          typeof __dirname !== "undefined"
          ? __dirname
          : undefined;
    if (!here) return undefined;
    return resolve(here, "..", "skills");
  } catch {
    return undefined;
  }
}

const MemoryPlugin: Plugin = async () => {
  const guard = createGuardHooks();

  // Tool names — each export becomes `<prefix>_<exportname>`. We use
  // the `memory_` and `session_` prefixes directly via the namespaced
  // tool map so agents can call `memory_search` rather than
  // `opencode-memory_search` etc.
  const tools = {
    memory_search: memoryTools.search,
    memory_read: memoryTools.read,
    memory_list: memoryTools.list,
    memory_save: memoryTools.save,
    memory_access: memoryTools.access,
    memory_setup: memoryTools.setup,
    knowledge_search: knowledgeTools.search,
    knowledge_read: knowledgeTools.read,
    knowledge_list: knowledgeTools.list,
    session_search: sessionTools.search,
    session_search_all: sessionTools.searchAll,
    session_read: sessionTools.read,
    session_list: sessionTools.list,
  };

  return {
    tool: tools,

    config: async (config: Record<string, unknown>) => {
      const skillsDir = resolveSkillsDir();
      applyConfig(config as Parameters<typeof applyConfig>[0], {
        skillsDir,
      });
    },

    "tool.execute.after": guard.toolAfter,
    "experimental.session.compacting": guard.compacting,
  };
};

/**
 * Default export uses the V1 plugin format — a record with `id` + `server`.
 *
 * OpenCode's plugin loader first tries V1 (`readV1Plugin`): if `default` is
 * a record with `id`/`server`/`tui`, it uses only those. Otherwise it falls
 * back to "legacy" detection which iterates EVERY named export and requires
 * each to be a function — so a single non-function re-export (e.g. the
 * `MEMORY_PROMPT_APPENDIX` string below) would abort plugin load with a
 * TypeError. Shipping V1 keeps the named helper re-exports safe because the
 * loader never iterates them.
 */
export default {
  id: "opencode-memory",
  server: MemoryPlugin,
};

// Re-exports for power users who want to wire pieces into their own plugin.
export { applyConfig, BUILTIN_SUBAGENTS, MEMORY_PROMPT_APPENDIX, TARGET_AGENTS } from "./config";
export {
  afterToolUpdate,
  buildCompactionContext,
  createGuardHooks,
  makeInitialState,
  matchesToolName,
  type SessionState,
} from "./hooks/guard";
export { memoryTools, knowledgeTools, sessionTools };
