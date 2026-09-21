/**
 * OpenCode Memory Plugin — persistent cross-session memory.
 *
 * Wires up:
 *  - 6 memory tools (search / read / list / save / access / setup)
 *  - Session tools (cross-harness search plus OpenCode search / read / list)
 *  - 2 hooks (tool-call guard + compaction context injection)
 *  - Config modifications (skill registration, agent prompts, permissions)
 *
 * The default export serves both plugin APIs: OpenCode V1 calls `server()`,
 * OpenCode V2 reads `id` + `setup()`. See `src/v2.ts` for the V2 wiring.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyConfig } from "./config";
import { createGuardHooks } from "./hooks/guard";
import { v1ToolMap } from "./tools";
import { createV2Plugin, PLUGIN_ID } from "./v2";

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

  return {
    // Tool names come from the registry, so agents call `memory_search`
    // rather than `opencode-memory_search` etc.
    tool: v1ToolMap(),

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
 * Default export supports both plugin APIs from one entrypoint.
 *
 * OpenCode V1's loader first tries `readV1Plugin`: if `default` is a record
 * with `id`/`server`/`tui`, it uses only those. Otherwise it falls back to
 * "legacy" detection which iterates EVERY named export and requires each to
 * be a function — so a single non-function re-export (e.g. the
 * `MEMORY_PROMPT_APPENDIX` string below) would abort plugin load with a
 * TypeError. Shipping the record form keeps the named helper re-exports safe
 * because the loader never iterates them.
 *
 * OpenCode V2 reads `id` + `setup()` from the same record and ignores
 * `server()`.
 */
export default {
  ...createV2Plugin({ skillsDir: resolveSkillsDir() }),
  id: PLUGIN_ID,
  server: MemoryPlugin,
};

// Re-exports for power users who want to wire pieces into their own plugin.
export {
  applyAgentConfigV2,
  applyConfig,
  BUILTIN_SUBAGENTS,
  exploreToolPermissionRules,
  MEMORY_PROMPT_APPENDIX,
  memoryDirPermissionRules,
  TARGET_AGENTS,
  type AgentLike,
  type PermissionRule,
} from "./config";
export {
  afterToolUpdate,
  buildCompactionContext,
  createGuardHooks,
  makeInitialState,
  matchesToolName,
  type SessionState,
} from "./hooks/guard";
export { defineTool, type MemoryTool, type ToolSpec } from "./lib/tool-spec";
export { allTools, v1ToolMap } from "./tools";
export * as memoryTools from "./tools/memory";
export * as sessionTools from "./tools/session";
export { createV2Plugin, loadBundledSkills, PLUGIN_ID } from "./v2";
