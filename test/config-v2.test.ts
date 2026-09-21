import { describe, expect, test } from "bun:test";
import { applyAgentConfigV2, exploreToolPermissionRules, memoryDirPermissionRules, type AgentLike } from "../src/config";

const MEMORY_DIR = "/home/u/opencode-memory";
const GLOB = "/home/u/opencode-memory/**";

function agent(id: string, overrides: Partial<AgentLike> = {}): AgentLike {
  return { id, permissions: [], ...overrides };
}

describe("memoryDirPermissionRules", () => {
  test("grants edit and external_directory access to the memory tree", () => {
    expect(memoryDirPermissionRules(MEMORY_DIR)).toEqual([
      { action: "edit", resource: GLOB, effect: "allow" },
      { action: "external_directory", resource: GLOB, effect: "allow" },
    ]);
  });

  test("normalizes a trailing separator", () => {
    expect(memoryDirPermissionRules(`${MEMORY_DIR}/`)[0].resource).toBe(GLOB);
  });
});

describe("exploreToolPermissionRules", () => {
  test("allows every memory and session tool", () => {
    const rules = exploreToolPermissionRules();
    expect(rules.map((rule) => rule.action).sort()).toEqual([
      "memory_access",
      "memory_list",
      "memory_read",
      "memory_search",
      "session_list",
      "session_read",
      "session_search",
      "session_search_all",
    ]);
    expect(rules.every((rule) => rule.effect === "allow" && rule.resource === "*")).toBe(true);
  });
});

describe("applyAgentConfigV2", () => {
  test("grants memory-dir access to any agent, targeted or not", () => {
    const build = agent("build");
    applyAgentConfigV2(build, { memoryDir: MEMORY_DIR });
    expect(build.permissions).toEqual(memoryDirPermissionRules(MEMORY_DIR));
    expect(build.system).toBeUndefined();
  });

  test("sets the memory prompt on a targeted agent with no prompt", () => {
    const general = agent("general");
    applyAgentConfigV2(general, { memoryDir: MEMORY_DIR });
    expect(general.system).toContain("memory_search");
    expect(general.system).toContain(MEMORY_DIR);
  });

  test("prepends to an existing prompt rather than replacing it", () => {
    const general = agent("general", { system: "Original instructions." });
    applyAgentConfigV2(general, { memoryDir: MEMORY_DIR });
    expect(general.system?.endsWith("Original instructions.")).toBe(true);
    expect(general.system).toContain("memory_search");
  });

  test("leaves a prompt that already mentions memory_search alone", () => {
    const general = agent("general", { system: "Call memory_search first." });
    applyAgentConfigV2(general, { memoryDir: MEMORY_DIR });
    expect(general.system).toBe("Call memory_search first.");
  });

  test("opens explore's tool allowlist", () => {
    const explore = agent("explore");
    applyAgentConfigV2(explore, { memoryDir: MEMORY_DIR });
    const actions = explore.permissions.map((rule) => rule.action);
    expect(actions).toContain("memory_search");
    expect(actions).toContain("session_search_all");
  });

  test("does not add tool rules to non-explore agents", () => {
    const general = agent("general");
    applyAgentConfigV2(general, { memoryDir: MEMORY_DIR });
    expect(general.permissions.map((rule) => rule.action)).toEqual(["edit", "external_directory"]);
  });

  test("appends rules so they win over earlier, broader ones", () => {
    const general = agent("general", {
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    });
    applyAgentConfigV2(general, { memoryDir: MEMORY_DIR });
    expect(general.permissions[0]).toEqual({ action: "*", resource: "*", effect: "ask" });
    expect(general.permissions.at(-1)).toEqual({
      action: "external_directory",
      resource: GLOB,
      effect: "allow",
    });
  });

  test("is idempotent — a second pass adds nothing", () => {
    const explore = agent("explore");
    applyAgentConfigV2(explore, { memoryDir: MEMORY_DIR });
    const afterFirst = JSON.stringify(explore);
    applyAgentConfigV2(explore, { memoryDir: MEMORY_DIR });
    expect(JSON.stringify(explore)).toBe(afterFirst);
  });

  test("respects a user rule already covering the same action and resource", () => {
    const general = agent("general", {
      permissions: [{ action: "edit", resource: GLOB, effect: "deny" }],
    });
    applyAgentConfigV2(general, { memoryDir: MEMORY_DIR });
    expect(general.permissions.filter((rule) => rule.action === "edit")).toEqual([
      { action: "edit", resource: GLOB, effect: "deny" },
    ]);
  });
});
