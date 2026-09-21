import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { createV2Plugin, loadBundledSkills, PLUGIN_ID } from "../src/v2";
import { makeTempDir } from "./helpers";

/**
 * A recording stand-in for the V2 plugin context. It captures the editors,
 * hooks, and definitions the plugin registers so tests can drive them
 * directly without a running OpenCode server.
 */
function fakeContext() {
  const tools: Record<string, { description: string; input: unknown; execute: Function }> = {};
  const skills: Record<string, unknown> = {};
  const agents = new Map<string, { id: string; system?: string; permissions: unknown[] }>();
  const hooks: Record<string, Function> = {};
  const registration = { dispose: async () => {} };

  const ctx = {
    tool: {
      transform: async (cb: Function) => {
        cb({
          add: (tool: { name: string; description: string; input: unknown; execute: Function }) => {
            tools[tool.name] = tool;
          },
          namespace: () => {},
          list: () => Object.values(tools),
          get: (id: string) => tools[id],
          update: () => {},
          remove: (id: string) => delete tools[id],
        });
        return registration;
      },
      hook: async (name: string, cb: Function) => {
        hooks[`tool.${name}`] = cb;
        return registration;
      },
    },
    skill: {
      transform: async (cb: Function) => {
        cb({
          add: (skill: { id: string }) => {
            skills[skill.id] = skill;
          },
          get: (id: string) => skills[id],
          list: () => Object.values(skills),
          update: () => {},
          remove: () => {},
        });
        return registration;
      },
    },
    agent: {
      transform: async (cb: Function) => {
        cb({
          list: () => [...agents.values()],
          get: (id: string) => agents.get(id),
          update: (id: string, update: Function) => {
            const agent = agents.get(id);
            if (agent) update(agent);
          },
          default: () => {},
          remove: () => {},
        });
        return registration;
      },
    },
    session: {
      hook: async (name: string, cb: Function) => {
        hooks[`session.${name}`] = cb;
        return registration;
      },
    },
  };

  return { ctx: ctx as unknown as Plugin.Context, tools, skills, agents, hooks };
}

async function setupPlugin(options: { skillsDir?: string } = {}) {
  const harness = fakeContext();
  harness.agents.set("build", { id: "build", permissions: [] });
  harness.agents.set("general", { id: "general", permissions: [] });
  harness.agents.set("explore", { id: "explore", permissions: [] });
  await createV2Plugin(options).setup(harness.ctx);
  return harness;
}

describe("createV2Plugin", () => {
  test("uses a stable plugin id", () => {
    expect(createV2Plugin().id).toBe(PLUGIN_ID);
    expect(PLUGIN_ID).toBe("opencode-memory");
  });

  test("registers every tool with a JSON Schema input", async () => {
    const { tools } = await setupPlugin();
    expect(Object.keys(tools).sort()).toEqual([
      "memory_access",
      "memory_list",
      "memory_read",
      "memory_save",
      "memory_search",
      "memory_setup",
      "session_list",
      "session_read",
      "session_search",
      "session_search_all",
    ]);
    expect((tools.memory_search.input as { type: string }).type).toBe("object");
  });

  test("tool execution returns structured content", async () => {
    const { tools } = await setupPlugin();
    const result = await tools.memory_setup.execute({}, { sessionID: "ses_1" });
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("ripgrep");
  });

  test("registers the bundled skill", async () => {
    const { skills } = await setupPlugin({ skillsDir: join(import.meta.dir, "..", "skills") });
    const skill = skills["opencode-memory"] as { name: string; description?: string; content: string };
    expect(skill.name).toBe("opencode-memory");
    expect(skill.description).toContain("memory");
    expect(skill.content).toContain("# OpenCode Memory");
  });

  test("applies memory config to the agents that exist", async () => {
    const { agents } = await setupPlugin();
    expect(agents.get("general")?.system).toContain("memory_search");
    expect(agents.get("explore")?.permissions).toContainEqual({
      action: "memory_search",
      resource: "*",
      effect: "allow",
    });
    // Primary agents get memory-dir access but not the subagent prompt.
    expect(agents.get("build")?.system).toBeUndefined();
    expect(agents.get("build")?.permissions.length).toBe(2);
  });

  test("the tool guard appends a search nudge after 8 calls", async () => {
    const { hooks } = await setupPlugin();
    const after = hooks["tool.execute.after"];
    let result = { content: "ok" };
    for (let i = 0; i < 8; i++) {
      result = { content: "ok" };
      await after({ status: "completed", tool: "read", sessionID: "ses_1", result });
    }
    expect(result.content).toContain("memory_search");
    expect(result.content).toContain("<system-reminder>");
  });

  test("the tool guard ignores failed tool calls", async () => {
    const { hooks } = await setupPlugin();
    const after = hooks["tool.execute.after"];
    const event = { status: "error", tool: "read", sessionID: "ses_1", error: { message: "boom" } };
    await after(event);
    expect(event).not.toHaveProperty("result");
  });

  test("the tool guard tracks sessions independently", async () => {
    const { hooks } = await setupPlugin();
    const after = hooks["tool.execute.after"];
    for (let i = 0; i < 8; i++) {
      await after({ status: "completed", tool: "read", sessionID: "ses_1", result: { content: "ok" } });
    }
    const other = { content: "ok" };
    await after({ status: "completed", tool: "read", sessionID: "ses_2", result: other });
    expect(other.content).toBe("ok");
  });

  test("compaction pushes the memory protocol into the system prompt", async () => {
    const { hooks } = await setupPlugin();
    const event = { sessionID: "ses_1", system: [] as Array<{ type: string; text: string }> };
    await hooks["session.compaction"](event);
    expect(event.system).toHaveLength(1);
    expect(event.system[0].type).toBe("text");
    expect(event.system[0].text).toContain("Preserve Through Compaction");
  });
});

describe("loadBundledSkills", () => {
  test("returns nothing without a skills directory", async () => {
    expect(await loadBundledSkills(undefined)).toEqual([]);
  });

  test("returns nothing when the directory is missing", async () => {
    expect(await loadBundledSkills("/nope/does/not/exist")).toEqual([]);
  });

  test("skips directories without a SKILL.md", async () => {
    const tmp = makeTempDir();
    try {
      mkdirSync(join(tmp.path, "not-a-skill"));
      expect(await loadBundledSkills(tmp.path)).toEqual([]);
    } finally {
      tmp.cleanup();
    }
  });

  test("falls back to the directory name when frontmatter has no name", async () => {
    const tmp = makeTempDir();
    try {
      mkdirSync(join(tmp.path, "plain"));
      await Bun.write(join(tmp.path, "plain", "SKILL.md"), "Just a body, no frontmatter.\n");
      const [skill] = await loadBundledSkills(tmp.path);
      expect(skill.name).toBe("plain");
      expect(skill.description).toBeUndefined();
    } finally {
      tmp.cleanup();
    }
  });
});
