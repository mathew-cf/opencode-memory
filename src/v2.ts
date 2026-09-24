/** OpenCode v2 entry point. The v1 entry remains at `.`. */
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin, Skill } from "@opencode/plugin";
import { buildMemoryPromptAppendix } from "./config";
import { createGuardHooks, afterToolUpdate, buildCompactionContext } from "./hooks/guard";
import { normalizeDirPath, resolveMemoryDir } from "./lib/paths";
import type { ToolDefinition } from "./lib/tool-definition";
import * as memory from "./tools/memory";
import * as session from "./tools/session";

const definitions: Record<string, ToolDefinition> = {
  memory_search: memory.search,
  memory_read: memory.read,
  memory_list: memory.list,
  memory_save: memory.save,
  memory_access: memory.access,
  memory_setup: memory.setup,
  session_search: session.search,
  session_search_all: session.searchAll,
  session_read: session.read,
  session_list: session.list,
};

function insideMemoryDir(resource: string, memoryDir: string): boolean {
  const path = resolve(resource);
  return path === memoryDir || path.startsWith(memoryDir + "/");
}

export default Plugin.define({
  id: "opencode-memory",
  async setup(ctx) {
    const guard = createGuardHooks();
    const memoryDir = normalizeDirPath(resolveMemoryDir());

    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(definitions)) {
        editor.add({
          name,
          ...definition,
        });
      }
    });

    await ctx.tool.hook("execute.after", (event) => {
      const state = guard.getState(event.sessionID);
      const output = event.status === "completed" ? event.result.content : "";
      const text = typeof output === "string" ? output : "";
      const reminder = afterToolUpdate(state, {
        tool: event.tool === "subagent" ? "task" : event.tool,
        output: text,
      });
      if (reminder && event.status === "completed") {
        event.result = { ...event.result, content: `${text}\n\n${reminder}` };
      }
    });

    await ctx.session.hook("compaction", (event) => {
      event.system.push({ type: "text", text: buildCompactionContext(guard.getState(event.sessionID)) });
    });

    await ctx.agent.transform((editor) => {
      for (const name of ["general", "explore", "research", "review", "investigator"]) {
        editor.update(name, (agent) => {
          const appendix = buildMemoryPromptAppendix(memoryDir);
          if (!agent.system?.includes("## Memory & Sessions")) {
            agent.system = agent.system ? `${appendix}\n\n${agent.system}` : appendix;
          }
        });
      }
    });

    await ctx.permission.hook("evaluate", (event) => {
      if (event.effect !== "ask") return;
      if (
        (event.action === "edit" || event.action === "external_directory") &&
        event.resources.length > 0 &&
        event.resources.every((resource) => insideMemoryDir(resource, memoryDir))
      ) {
        event.effect = "allow";
      }
      if (event.agent === "explore" && /^(memory_(search|read|list|access)|session_(search|search_all|read|list))$/.test(event.action)) {
        event.effect = "allow";
      }
    });

    const skillPath = join(dirname(await realpath(fileURLToPath(import.meta.url))), "..", "skills", "opencode-memory", "SKILL.md");
    const content = await readFile(skillPath, "utf8");
    const description = content.match(/^description:\s*(.+)$/m)?.[1] ?? "Search and save durable memories.";
    await ctx.skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make("opencode-memory"),
        name: Skill.Name.make("opencode-memory"),
        description,
        path: skillPath as Parameters<typeof editor.add>[0]["path"],
        content,
      });
    });
  },
});
