import { expect, test } from "bun:test";
import plugin from "../src/v2";
import { withMemoryDir } from "./helpers";

test("v2 entry registers tools, skill, prompt, permissions and guard hooks", async () => {
  await withMemoryDir(async (memoryDir) => {
    const tools = new Map<string, any>();
    const agents = new Map<string, any>([
      ["general", { system: "Existing instructions" }],
      ["explore", { system: "" }],
    ]);
    const skills: any[] = [];
    const hooks = new Map<string, (event: any) => void>();
    const context = {
      tool: {
        transform: async (callback: (editor: any) => void) => callback({ add: (item: any) => tools.set(item.name, item) }),
        hook: async (name: string, callback: (event: any) => void) => hooks.set(`tool.${name}`, callback),
      },
      session: { hook: async (name: string, callback: (event: any) => void) => hooks.set(`session.${name}`, callback) },
      agent: {
        transform: async (callback: (editor: any) => void) => callback({
          update: (name: string, update: (agent: any) => void) => {
            const agent = agents.get(name);
            if (agent) update(agent);
          },
        }),
      },
      permission: { hook: async (name: string, callback: (event: any) => void) => hooks.set(`permission.${name}`, callback) },
      skill: { transform: async (callback: (editor: any) => void) => callback({ add: (item: any) => skills.push(item) }) },
    };

    await plugin.setup(context as any);
    expect(tools.size).toBe(13);
    expect(tools.get("knowledge_search").input.safeParse({ query: "test" }).success).toBe(true);
    expect(tools.get("memory_list").input.safeParse({}).success).toBe(true);
    const result = await tools.get("memory_list").execute({}, { sessionID: "test" });
    expect(result.content).toContain("Memory");
    expect(agents.get("general").system).toContain("## Memory & Sessions");
    expect(agents.get("general").system).toContain("Existing instructions");
    expect(skills[0].content).toContain("# OpenCode Memory");

    const permission = { effect: "ask", action: "edit", resources: [`${memoryDir}/technical/example.md`] };
    hooks.get("permission.evaluate")!(permission);
    expect(permission.effect).toBe("allow");
    const outside = { effect: "ask", action: "edit", resources: ["/tmp/elsewhere.md"] };
    hooks.get("permission.evaluate")!(outside);
    expect(outside.effect).toBe("ask");

    for (let i = 0; i < 11; i++) {
      const event = { tool: "read", sessionID: "test", status: "completed", result: { content: "file" } };
      hooks.get("tool.execute.after")!(event);
      if (i === 7) expect(event.result.content).toContain("memory_search");
    }
    const subagent = {
      tool: "subagent", sessionID: "test", status: "completed",
      result: { content: "## Discoveries worth saving\n- A reusable fact" },
    };
    hooks.get("tool.execute.after")!(subagent);
    expect(subagent.result.content).toContain("memory_save");
    const compact = { sessionID: "test", system: [] as any[] };
    hooks.get("session.compaction")!(compact);
    expect(compact.system[0].text).toContain("MEMORY RETROSPECTIVE");
  });
});
