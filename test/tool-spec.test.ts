import { describe, expect, test } from "bun:test";
import { defineTool, toolArgsFromSchema, type ToolInputSchema } from "../src/lib/tool-spec";
import { allTools, v1ToolMap } from "../src/tools";

const schema: ToolInputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "What to look for" },
    limit: { type: "number", description: "How many" },
    detail: { type: "string", enum: ["compact", "normal"], description: "Verbosity" },
    force: { type: "boolean" },
  },
  required: ["query"],
  additionalProperties: false,
};

describe("toolArgsFromSchema", () => {
  test("produces one zod arg per JSON Schema property", () => {
    const args = toolArgsFromSchema(schema);
    expect(Object.keys(args).sort()).toEqual(["detail", "force", "limit", "query"]);
  });

  test("required properties stay required and the rest become optional", () => {
    const args = toolArgsFromSchema(schema) as unknown as Record<string, { safeParse(v: unknown): { success: boolean } }>;
    expect(args.query.safeParse(undefined).success).toBe(false);
    expect(args.limit.safeParse(undefined).success).toBe(true);
    expect(args.detail.safeParse(undefined).success).toBe(true);
  });

  test("enums only accept their declared values", () => {
    const args = toolArgsFromSchema(schema) as unknown as Record<string, { safeParse(v: unknown): { success: boolean } }>;
    expect(args.detail.safeParse("compact").success).toBe(true);
    expect(args.detail.safeParse("verbose").success).toBe(false);
  });

  test("types are carried across", () => {
    const args = toolArgsFromSchema(schema) as unknown as Record<string, { safeParse(v: unknown): { success: boolean } }>;
    expect(args.limit.safeParse(5).success).toBe(true);
    expect(args.limit.safeParse("5").success).toBe(false);
    expect(args.force.safeParse(true).success).toBe(true);
  });

  test("rejects unsupported property types at build time", () => {
    const bad = {
      type: "object",
      properties: { thing: { type: "object" } },
      additionalProperties: false,
    } as unknown as ToolInputSchema;
    expect(() => toolArgsFromSchema(bad)).toThrow(/Unsupported tool input type/);
  });
});

describe("defineTool", () => {
  test("keeps the spec fields and adds a V1 definition", () => {
    const spec = defineTool<{ query: string }>({
      name: "demo_tool",
      description: "Demo",
      input: schema,
      async execute(input, context) {
        return `${input.query}:${context.sessionID ?? "none"}`;
      },
    });

    expect(spec.name).toBe("demo_tool");
    expect(spec.input).toBe(schema);
    expect(spec.v1.description).toBe("Demo");
    expect(Object.keys(spec.v1.args).sort()).toEqual(["detail", "force", "limit", "query"]);
  });

  test("the V1 wrapper forwards args and sessionID to the shared execute", async () => {
    const spec = defineTool<{ query: string }>({
      name: "demo_tool",
      description: "Demo",
      input: schema,
      async execute(input, context) {
        return `${input.query}:${context.sessionID ?? "none"}`;
      },
    });

    const context = { sessionID: "ses_123" } as unknown as Parameters<typeof spec.v1.execute>[1];
    expect(await spec.v1.execute({ query: "hi" }, context)).toBe("hi:ses_123");
  });
});

describe("tool registry", () => {
  test("exposes every memory and session tool under its effective name", () => {
    expect(allTools.map((entry) => entry.name).sort()).toEqual([
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
  });

  test("every tool declares a closed object schema", () => {
    for (const entry of allTools) {
      expect(entry.input.type).toBe("object");
      expect(entry.input.additionalProperties).toBe(false);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  test("v1ToolMap keys match the registry names", () => {
    const map = v1ToolMap();
    expect(Object.keys(map).sort()).toEqual(allTools.map((entry) => entry.name).sort());
    expect(map.memory_search.description).toBe(allTools[0].description);
  });
});
