/**
 * OpenCode Memory Plugin — persistent cross-session memory.
 *
 * Wires up:
 *  - 4 memory tools (search / list / save / access / setup)
 *  - 3 session tools (search / read / list)
 *  - 2 hooks (tool.execute.after guard + compaction context injection)
 *  - Config modifications (skill path, agent prompts, permission rules)
 */

import type { Plugin } from "@opencode-ai/plugin";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyConfig } from "./config";
import { createGuardHooks } from "./hooks/guard";
import * as memory from "./tools/memory";
import * as session from "./tools/session";

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
          (typeof __dirname !== "undefined" ? __dirname : undefined);
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
    memory_search: memory.search,
    memory_list: memory.list,
    memory_save: memory.save,
    memory_access: memory.access,
    memory_setup: memory.setup,
    session_search: session.search,
    session_read: session.read,
    session_list: session.list,
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
export { applyConfig, MEMORY_PROMPT_APPENDIX, TARGET_AGENTS } from "./config";
export {
  afterToolUpdate,
  buildCompactionContext,
  createGuardHooks,
  makeInitialState,
  matchesToolName,
  type SessionState,
} from "./hooks/guard";
export * as memoryTools from "./tools/memory";
export * as sessionTools from "./tools/session";
