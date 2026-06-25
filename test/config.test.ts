import { describe, expect, test } from "bun:test";
import {
  applyConfig,
  buildMemoryPromptAppendix,
  BUILTIN_SUBAGENTS,
  EXPLORE_PERMISSIONS,
  MEMORY_PROMPT_APPENDIX,
  TARGET_AGENTS,
} from "../src/config";

describe("applyConfig", () => {
  test("registers the bundled skill path", () => {
    const config: Record<string, unknown> = {};
    applyConfig(config, {
      skillsDir: "/pkg/skills",
      memoryDir: "/home/u/opencode-memory",
    });
    expect((config as { skills?: { paths?: string[] } }).skills?.paths).toEqual(["/pkg/skills"]);
  });

  test("does not duplicate the skill path on a second pass", () => {
    const config: Record<string, unknown> = {
      skills: { paths: ["/pkg/skills"] },
    };
    applyConfig(config, {
      skillsDir: "/pkg/skills",
      memoryDir: "/home/u/opencode-memory",
    });
    expect((config as { skills?: { paths?: string[] } }).skills?.paths).toEqual(["/pkg/skills"]);
  });

  test("appends to an existing skills.paths array", () => {
    const config: Record<string, unknown> = {
      skills: { paths: ["/existing"] },
    };
    applyConfig(config, {
      skillsDir: "/pkg/skills",
      memoryDir: "/home/u/opencode-memory",
    });
    expect((config as { skills?: { paths?: string[] } }).skills?.paths).toEqual(["/existing", "/pkg/skills"]);
  });

  test("adds permission rules for the memory directory", () => {
    const config: Record<string, unknown> = {};
    applyConfig(config, {
      skillsDir: undefined,
      memoryDir: "/home/u/opencode-memory",
    });
    const perm = (
      config as {
        permission?: {
          edit?: Record<string, string>;
          external_directory?: Record<string, string>;
        };
      }
    ).permission;
    expect(perm?.edit?.["/home/u/opencode-memory/**"]).toBe("allow");
    expect(perm?.external_directory?.["/home/u/opencode-memory/**"]).toBe("allow");
  });

  test("does not overwrite an existing permission entry", () => {
    const config: Record<string, unknown> = {
      permission: {
        edit: { "/home/u/opencode-memory/**": "deny" },
      },
    };
    applyConfig(config, {
      memoryDir: "/home/u/opencode-memory",
    });
    const perm = (config as { permission?: { edit?: Record<string, string> } }).permission;
    expect(perm?.edit?.["/home/u/opencode-memory/**"]).toBe("deny");
  });

  test("sets the memory prompt on the built-in subagents using the configured directory", () => {
    const config: Record<string, unknown> = {};
    const memoryDir = "/home/u/.config/opencode/memory";
    applyConfig(config, { memoryDir });
    const agent = (config as { agent?: Record<string, { prompt?: string }> }).agent;
    for (const name of BUILTIN_SUBAGENTS) {
      expect(agent?.[name]?.prompt).toBe(buildMemoryPromptAppendix(memoryDir));
      expect(agent?.[name]?.prompt).toContain("/home/u/.config/opencode/memory/{category}/{filename}.md");
      expect(agent?.[name]?.prompt).not.toContain("~/opencode-memory");
    }
  });

  test("does not fabricate non-built-in target agents that the user never defined", () => {
    const config: Record<string, unknown> = {};
    applyConfig(config, { memoryDir: "/home/u/opencode-memory" });
    const agent = (config as { agent?: Record<string, unknown> }).agent ?? {};
    // Only the real built-ins should exist; research/review/investigator must not.
    expect(Object.keys(agent).sort()).toEqual([...BUILTIN_SUBAGENTS].sort());
    for (const name of TARGET_AGENTS) {
      if (!(BUILTIN_SUBAGENTS as readonly string[]).includes(name)) {
        expect(name in agent).toBe(false);
      }
    }
  });

  test("augments a non-built-in target agent only when the user has already defined it", () => {
    const config: Record<string, unknown> = {
      agent: { research: { prompt: "find things" } },
    };
    applyConfig(config, { memoryDir: "/home/u/opencode-memory" });
    const agent = (config as { agent?: Record<string, { prompt?: string }> }).agent;
    expect(agent?.research?.prompt).toContain("find things");
    expect(agent?.research?.prompt).toContain("memory_search");
    // Still must not fabricate the other non-built-ins.
    expect("review" in (agent ?? {})).toBe(false);
    expect("investigator" in (agent ?? {})).toBe(false);
  });

  test("prepends to existing agent prompts without clobbering them", () => {
    const config: Record<string, unknown> = {
      agent: {
        general: { prompt: "do thing X always" },
      },
    };
    applyConfig(config, { memoryDir: "/home/u/opencode-memory" });
    const prompt = (config as { agent?: Record<string, { prompt?: string }> }).agent?.general?.prompt;
    expect(prompt).toContain("do thing X always");
    expect(prompt).toContain("memory_search");
    expect(prompt?.indexOf("memory_search")).toBeLessThan(prompt?.indexOf("do thing X always") ?? Infinity);
  });

  test("does not prepend if the prompt already mentions memory_search", () => {
    const preset = "custom prompt with memory_search already in it";
    const config: Record<string, unknown> = {
      agent: { general: { prompt: preset } },
    };
    applyConfig(config, { memoryDir: "/home/u/opencode-memory" });
    const prompt = (config as { agent?: Record<string, { prompt?: string }> }).agent?.general?.prompt;
    expect(prompt).toBe(preset);
  });

  test("keeps the default prompt appendix pointed at the default directory", () => {
    expect(MEMORY_PROMPT_APPENDIX).toContain("~/opencode-memory");
  });

  test("adds explore permissions for the memory/session tools", () => {
    const config: Record<string, unknown> = {};
    applyConfig(config, { memoryDir: "/home/u/opencode-memory" });
    const perms = (
      config as {
        agent?: Record<string, { permission?: Record<string, string> }>;
      }
    ).agent?.explore?.permission;
    for (const [tool, rule] of Object.entries(EXPLORE_PERMISSIONS)) {
      expect(perms?.[tool]).toBe(rule);
    }
  });

  test("gives non-explore agents an edit allowance for the normalized memory dir", () => {
    const config: Record<string, unknown> = {};
    applyConfig(config, { memoryDir: "/home/u/.config/opencode/memory/" });
    const agent = config as {
      agent?: Record<string, { permission?: { edit?: Record<string, string> } }>;
    };
    expect(agent.agent?.general?.permission?.edit?.["/home/u/.config/opencode/memory/**"]).toBe("allow");
  });
});
