/**
 * Config hook: registers the skill path, sets agent prompts, and adds
 * permission rules so the memory tools can actually touch the memory dir.
 *
 * Everything here is **additive and non-destructive**: if the user has
 * already set a value (e.g. a custom `agent.general.prompt`), we prepend
 * or leave their value alone rather than overwriting. That lets users
 * layer this plugin on top of their own config without surprises.
 */

import { posix } from "node:path";
import { DEFAULT_MEMORY_SUBDIR } from "./constants";
import { formatMemoryDirForDisplay, normalizeDirPath, resolveMemoryDir } from "./lib/paths";

/**
 * The snippet appended to subagent prompts. Captured in one place so
 * tests can snapshot it and users can `Edit` it locally if they want a
 * different emphasis.
 *
 * Sections beyond "Memory & Sessions" / "Discoveries worth saving" are
 * generic agent-quality nudges that pair naturally with the memory
 * protocol — they describe how to deliver an answer once you've done
 * the search work. They're scoped tight enough not to crowd out the
 * memory bits but useful enough to ship as opinionated defaults.
 */
export function buildMemoryPromptAppendix(memoryDir = `~/${DEFAULT_MEMORY_SUBDIR}`): string {
  const memoryRoot = formatMemoryDirForDisplay(memoryDir);
  return `## Memory & Sessions

1. **Search once per unfamiliar durable topic:** call \`memory_search\` and \`session_search\` before substantial work when current context does not already contain relevant evidence. Use \`memory_read\` for bounded follow-up. Reuse loaded results for follow-up requests; do not repeat the bootstrap ritual merely because the user sent another message.
2. **Search again when the topic materially changes, after compaction, or when stuck:** use previous sessions to inform the approach before guessing. Skip a corpus when current session state already records that its search found nothing relevant for this topic.
3. **When you discover something reusable:** write to ${memoryRoot}/{category}/{filename}.md and \`memory_save\` immediately. Never defer, never ask.

If you can't write to memory, end your response with:
## Discoveries worth saving
- [list findings that took >1 min to figure out]

## Ground in code

NEVER answer questions about a codebase from training data. Always open the actual files first.

## Synthesis

End with: a clear conclusion (recommendation, diagnosis, or finding), your confidence level, any conflicts or open questions, and concrete next steps where applicable.

## Source age

Flag anything > 1 year old as potentially stale.`;
}

export const MEMORY_PROMPT_APPENDIX = buildMemoryPromptAppendix();

/**
 * OpenCode's real built-in subagents. These are NOT present in the raw
 * config object at config-hook time, so we create entries for them in order
 * to attach the memory prompt. Keep this list in sync with OpenCode core
 * (`packages/opencode/src/agent/agent.ts` — built-in subagents are `general`
 * and `explore`; `build`/`plan` are primary and are intentionally excluded).
 */
export const BUILTIN_SUBAGENTS = ["general", "explore"] as const;

/**
 * Subagents that should get the memory prompt appendix.
 *
 * Built-ins (see {@link BUILTIN_SUBAGENTS}) are always targeted. Any other
 * name here is only touched when the user has *already defined* an agent with
 * that name — we never fabricate an agent that doesn't exist. This is what
 * keeps `research`/`review`/`investigator` from being conjured into the
 * config (and showing up as phantom entries in the Task tool's agent list)
 * on installs that never defined them.
 */
export const TARGET_AGENTS = ["general", "explore", "research", "review", "investigator"] as const;

/**
 * Explore needs explicit permission to call memory and session search tools
 * because its built-in allowlist doesn't include them.
 */
export const EXPLORE_PERMISSIONS: Record<string, string> = {
  memory_search: "allow",
  memory_read: "allow",
  memory_list: "allow",
  memory_access: "allow",
  session_search: "allow",
  session_search_all: "allow",
  session_read: "allow",
  session_list: "allow",
};

/**
 * A single OpenCode V2 permission rule. V1 expressed the same intent as a
 * `{ pattern: effect }` map; V2 uses an ordered array where the last matching
 * rule wins, so our rules are always appended.
 */
export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/** The minimal slice of a V2 `Agent.Info` this plugin edits. */
export interface AgentLike {
  id: string;
  system?: string;
  permissions: PermissionRule[];
}

/** Edit + external-directory access to the memory tree, as V2 rules. */
export function memoryDirPermissionRules(memoryDir: string): PermissionRule[] {
  const memoryGlob = posix.join(normalizeDirPath(memoryDir), "**");
  return [
    { action: "edit", resource: memoryGlob, effect: "allow" },
    { action: "external_directory", resource: memoryGlob, effect: "allow" },
  ];
}

/** {@link EXPLORE_PERMISSIONS} expressed as V2 rules. */
export function exploreToolPermissionRules(): PermissionRule[] {
  return Object.entries(EXPLORE_PERMISSIONS).map(([action, effect]) => ({
    action,
    resource: "*",
    effect: effect as PermissionRule["effect"],
  }));
}

function appendRules(permissions: PermissionRule[], rules: PermissionRule[]): void {
  for (const rule of rules) {
    const present = permissions.some((existing) => existing.action === rule.action && existing.resource === rule.resource);
    if (!present) permissions.push(rule);
  }
}

/**
 * The V2 counterpart of {@link applyConfig}'s agent section, applied through
 * `ctx.agent.transform`. Call it for every agent: memory-directory access is
 * granted to all of them (V1 got that from the global `permission` config,
 * which V2 replaces with per-domain rules), while the prompt appendix and the
 * explore tool allowlist stay scoped to {@link TARGET_AGENTS}.
 *
 * Like the V1 path, this is additive: an existing `system` prompt is prepended
 * to rather than replaced, and duplicate rules are never appended twice.
 */
export function applyAgentConfigV2(agent: AgentLike, options: { memoryDir?: string } = {}): void {
  const memoryDir = normalizeDirPath(options.memoryDir ?? resolveMemoryDir());
  appendRules(agent.permissions, memoryDirPermissionRules(memoryDir));

  if (!(TARGET_AGENTS as readonly string[]).includes(agent.id)) return;

  const prefix = buildMemoryPromptAppendix(memoryDir);
  if (!agent.system) {
    agent.system = prefix;
  } else if (!agent.system.includes("memory_search")) {
    agent.system = `${prefix}\n\n${agent.system}`;
  }

  if (agent.id === "explore") appendRules(agent.permissions, exploreToolPermissionRules());
}

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
export function applyConfig(config: ConfigLike, options: { skillsDir?: string; memoryDir?: string }): void {
  // --- skills.paths — register the bundled skill ---
  if (options.skillsDir) {
    config.skills = config.skills || {};
    config.skills.paths = config.skills.paths || [];
    if (!config.skills.paths.includes(options.skillsDir)) {
      config.skills.paths.push(options.skillsDir);
    }
  }

  // --- permission rules — allow the tools to touch the memory dir ---
  const memoryDir = normalizeDirPath(options.memoryDir ?? resolveMemoryDir());
  const memoryGlob = posix.join(memoryDir, "**");
  config.permission = config.permission || {};

  if (typeof config.permission.edit !== "string") {
    const edit = (config.permission.edit = config.permission.edit || {});
    if (typeof edit === "object" && edit && !(memoryGlob in edit)) {
      (edit as Record<string, string>)[memoryGlob] = "allow";
    }
  }
  if (typeof config.permission.external_directory !== "string") {
    const ext = (config.permission.external_directory = config.permission.external_directory || {});
    if (typeof ext === "object" && ext && !(memoryGlob in ext)) {
      (ext as Record<string, string>)[memoryGlob] = "allow";
    }
  }

  // --- agent prompts — prepend the memory/session expectations ---
  config.agent = config.agent || {};
  const prefix = buildMemoryPromptAppendix(memoryDir);
  const builtins = BUILTIN_SUBAGENTS as readonly string[];
  for (const name of TARGET_AGENTS) {
    // Only touch real built-ins (which we create) or agents the user has
    // already defined. Never fabricate an agent that doesn't exist.
    const alreadyDefined = Object.prototype.hasOwnProperty.call(config.agent, name);
    if (!alreadyDefined && !builtins.includes(name)) continue;

    const existing = (config.agent[name] || {}) as {
      prompt?: string;
      permission?: Record<string, unknown>;
    };

    if (!existing.prompt) {
      existing.prompt = prefix;
    } else if (!existing.prompt.includes("memory_search")) {
      existing.prompt = `${prefix}\n\n${existing.prompt}`;
    }

    // Explore in particular needs its tool permissions opened.
    if (name === "explore") {
      existing.permission = {
        ...EXPLORE_PERMISSIONS,
        ...(existing.permission || {}),
      };
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
