import { describe, expect, test } from "bun:test";
import plugin from "../src/index";

describe("default export", () => {
  test("carries the V1 and V2 entrypoints side by side", () => {
    expect(plugin.id).toBe("opencode-memory");
    expect(typeof plugin.server).toBe("function");
    expect(typeof plugin.setup).toBe("function");
  });

  test("the V1 surface returns the tools, config hook, and both hooks", async () => {
    const hooks = await plugin.server({} as never);
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
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
    expect(typeof hooks.config).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
    expect(typeof hooks["experimental.session.compacting"]).toBe("function");
  });
});
