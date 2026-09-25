import { expect, test } from "bun:test";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import plugin, { knowledgeTools, memoryTools } from "../src/index";
import { withMemoryDir } from "./helpers";

test("v1 entry adapts the shared tools", async () => {
  await withMemoryDir(async () => {
    const hooks = await plugin.server({} as never);
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(13);
    expect(hooks.tool).toHaveProperty("knowledge_base_search");
    expect(hooks.tool).toHaveProperty("knowledge_base_read");
    expect(hooks.tool).not.toHaveProperty("knowledge_search");
    expect(hooks.tool).not.toHaveProperty("knowledge_read");
    for (const definition of Object.values(hooks.tool ?? {}) as ToolDefinition[]) {
      expect(tool.schema.toJSONSchema(tool.schema.object(definition.args))).toHaveProperty("type", "object");
    }
    const schema = tool.schema.object(memoryTools.search.args);
    expect(schema.safeParse({ query: "test" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(await memoryTools.list.execute({}, { sessionID: "test" } as never)).toContain("Memory");
    expect(tool.schema.object(knowledgeTools.search.args).safeParse({ query: "test" }).success).toBe(true);
  });
});
