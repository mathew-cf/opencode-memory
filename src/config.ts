/**
 * Config hook: registers the skill path, sets agent prompts, and adds
 * permission rules so the memory tools can actually touch the memory dir.
 *
 * Everything here is **additive and non-destructive**: if the user has
 * already set a value (e.g. a custom `agent.general.prompt`), we prepend
 * or leave their value alone rather than overwriting. That lets users
 * layer this plugin on top of their own config without surprises.
 */

import { resolveMemoryDir } from "./lib/paths";

/**
 * The snippet appended to subagent prompts. Captured in one place so
 * tests can snapshot it and users can `Edit` it locally if they want a
 * different emphasis.
 */
export const MEMORY_PROMPT_APPENDIX = `## Memory & Sessions

1. **Before work:** call \`memory_search\` and \`session_search\` with your topic. Read results — don't just glance at summaries.
2. **When something is unfamiliar mid-task** (tool, API, pattern, build system): search both \`memory_search\` and \`session_search\` BEFORE attempting. Use previous sessions to inform your approach — don't try first, search first.
3. **When you discover something reusable:** write to ~/opencode-memory/{category}/{filename}.md and \`memory_save\` immediately. Never defer, never ask.

If you can't write to memory, end your response with:
## Discoveries worth saving
- [list findings that took >1 min to figure out]

## Ground in code

NEVER answer questions about a codebase from training data. Always open the actual files first.`;

/**
 * Subagents that should get the memory prompt appendix. These are the
 * built-in subagent names used by OpenCode — custom agents are left alone.
 */
export const TARGET_AGENTS = [
  "general",
  "explore",
  "research",
  "review",
  "investigator",
] as const;

/**
 * Explore needs explicit permission to call memory_search/session_search
 * because its built-in allowlist doesn't include them.
 */
export const EXPLORE_PERMISSIONS: Record<string, string> = {
  memory_search: "allow",
  memory_list: "allow",
  memory_access: "allow",
  session_search: "allow",
  session_read: "allow",
  session_list: "allow",
};

interface ConfigLike {
  agent?: Record<string, unknown>;
  skills?: { paths?: string[]; urls?: string[] };
  permission?: {
    edit?: Record<string, unknown> | string;
    external_directory?: Record<string, unknown> | string;
  };
}

/**
 * Apply the plugin's config additions to a raw config object. Exported
 * separately from the plugin entry so tests can feed a plain object in
 * and assert on the result without constructing a full plugin context.
 */
export function applyConfig(
  config: ConfigLike,
  options: { skillsDir?: string; memoryDir?: string },
): void {
  // --- skills.paths — register the bundled skill ---
  if (options.skillsDir) {
    config.skills = config.skills || {};
    config.skills.paths = config.skills.paths || [];
    if (!config.skills.paths.includes(options.skillsDir)) {
      config.skills.paths.push(options.skillsDir);
    }
  }

  // --- permission rules — allow the tools to touch the memory dir ---
  const memoryGlob = `${options.memoryDir ?? resolveMemoryDir()}/**`;
  config.permission = config.permission || {};

  if (typeof config.permission.edit !== "string") {
    const edit = (config.permission.edit = config.permission.edit || {});
    if (typeof edit === "object" && edit && !(memoryGlob in edit)) {
      (edit as Record<string, string>)[memoryGlob] = "allow";
    }
  }
  if (typeof config.permission.external_directory !== "string") {
    const ext = (config.permission.external_directory =
      config.permission.external_directory || {});
    if (typeof ext === "object" && ext && !(memoryGlob in ext)) {
      (ext as Record<string, string>)[memoryGlob] = "allow";
    }
  }

  // --- agent prompts — prepend the memory/session expectations ---
  config.agent = config.agent || {};
  for (const name of TARGET_AGENTS) {
    const existing = (config.agent[name] || {}) as {
      prompt?: string;
      permission?: Record<string, unknown>;
    };
    const prefix = MEMORY_PROMPT_APPENDIX;

    if (!existing.prompt) {
      existing.prompt = prefix;
    } else if (!existing.prompt.includes("memory_search")) {
      existing.prompt = `${prefix}\n\n${existing.prompt}`;
    }

    // Explore in particular needs its tool permissions opened.
    if (name === "explore") {
      existing.permission = { ...EXPLORE_PERMISSIONS, ...(existing.permission || {}) };
    } else {
      existing.permission = existing.permission || {};
      const p = existing.permission as {
        edit?: Record<string, unknown> | string;
      };
      if (typeof p.edit !== "string") {
        const editRules = (p.edit = p.edit || {}) as Record<string, unknown>;
        if (!(memoryGlob in editRules)) {
          editRules[memoryGlob] = "allow";
        }
      }
    }

    config.agent[name] = existing;
  }
}
