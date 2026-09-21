/**
 * OpenCode V2 plugin surface.
 *
 * Same behaviour as the V1 surface in `index.ts`, expressed through the V2
 * context. The mapping is:
 *
 * | V1                                  | V2                                     |
 * | ----------------------------------- | -------------------------------------- |
 * | `tool` map                          | `ctx.tool.transform` (JSON Schema)     |
 * | `config.skills.paths`               | `ctx.skill.transform`                  |
 * | `config.agent[*].prompt`            | `ctx.agent.transform` (`agent.system`) |
 * | `config.permission`                 | agent `permissions` rules              |
 * | `tool.execute.after`                | `ctx.tool.hook("execute.after")`       |
 * | `experimental.session.compacting`   | `ctx.session.hook("compaction")`       |
 *
 * Only *types* are imported from `@opencode/plugin` — `Plugin.define()` is an
 * identity function, so the built plugin carries no runtime dependency on the
 * V2 SDK and still loads under OpenCode V1.
 */

import type { Plugin, Skill } from "@opencode/plugin";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyAgentConfigV2, type AgentLike } from "./config";
import { afterToolUpdate, buildCompactionContext, createGuardHooks } from "./hooks/guard";
import { parseSkillFrontmatter } from "./lib/frontmatter";
import type { MemoryTool } from "./lib/tool-spec";
import { normPath } from "./lib/paths";
import { allTools } from "./tools";

export const PLUGIN_ID = "opencode-memory";

/**
 * Read `skills/<name>/SKILL.md` entries into the shape `ctx.skill.transform`
 * wants. V1 handed OpenCode a directory to scan; V2 expects the parsed skill,
 * so we do the scanning ourselves. Returns an empty list if the bundled
 * `skills/` directory can't be read — a missing skill must never block load.
 */
export async function loadBundledSkills(skillsDir: string | undefined): Promise<Skill.Info[]> {
  if (!skillsDir) return [];
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const skills: Skill.Info[] = [];
  for (const entry of entries) {
    const path = join(skillsDir, entry, "SKILL.md");
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const { name, description } = parseSkillFrontmatter(content);
    skills.push({
      id: entry,
      name: name ?? entry,
      description,
      path: normPath(path),
      content,
    } as unknown as Skill.Info);
  }
  return skills;
}

/** Append the guard reminder to a V2 tool result, whatever content shape it uses. */
function appendReminder(result: { content?: string | ReadonlyArray<unknown> }, reminder: string): void {
  const suffix = `\n\n${reminder}`;
  if (typeof result.content === "string" || result.content === undefined) {
    result.content = `${result.content ?? ""}${suffix}`;
    return;
  }
  result.content = [...result.content, { type: "text", text: suffix }] as ReadonlyArray<unknown>;
}

/** Read the text of a V2 tool result so the guard can scan it for discoveries. */
function resultText(result: { content?: string | ReadonlyArray<unknown> }): string {
  if (typeof result.content === "string") return result.content;
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("\n");
}

/**
 * Build the V2 plugin definition. `skillsDir` is resolved by the caller
 * (`index.ts`) because locating the bundled `skills/` directory depends on
 * `import.meta.url` of the entry module.
 */
export function createV2Plugin(options: { skillsDir?: string } = {}): Plugin.Plugin {
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      const guard = createGuardHooks();
      const tools: MemoryTool<never>[] = allTools as unknown as MemoryTool<never>[];

      await ctx.tool.transform((editor) => {
        for (const spec of tools) {
          editor.add({
            name: spec.name,
            description: spec.description,
            input: spec.input,
            async execute(input, context) {
              return {
                content: await spec.execute(input as never, { sessionID: context.sessionID }),
              };
            },
          });
        }
      });

      // Load skill files before the transform: transform callbacks must stay
      // synchronous and side-effect free so they can be replayed.
      const skills = await loadBundledSkills(options.skillsDir);
      if (skills.length > 0) {
        await ctx.skill.transform((editor) => {
          for (const skill of skills) {
            if (!editor.get(skill.id)) editor.add(skill);
          }
        });
      }

      await ctx.agent.transform((editor) => {
        for (const agent of editor.list()) {
          editor.update(String(agent.id), (draft) => {
            applyAgentConfigV2(draft as unknown as AgentLike);
          });
        }
      });

      await ctx.tool.hook("execute.after", (event) => {
        if (event.status !== "completed") return;
        const state = guard.getState(event.sessionID || "_default");
        const reminder = afterToolUpdate(state, {
          tool: event.tool,
          output: resultText(event.result),
        });
        if (reminder) appendReminder(event.result, reminder);
      });

      await ctx.session.hook("compaction", (event) => {
        const state = guard.getState(event.sessionID || "_default");
        event.system.push({ type: "text", text: buildCompactionContext(state) });
      });
    },
  };
}
