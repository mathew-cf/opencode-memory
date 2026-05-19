import { describe, expect, test } from "bun:test";
import {
  expandHomePath,
  formatMemoryDirForDisplay,
  formatMemoryPathForDisplay,
  normPath,
  normalizeDirPath,
  ragIndexDir,
  resolveHome,
  resolveMemoryDir,
} from "../src/lib/paths";

describe("normPath", () => {
  test("converts backslashes to forward slashes", () => {
    expect(normPath("C:\\Users\\mat\\foo")).toBe("C:/Users/mat/foo");
  });

  test("leaves forward-slash paths unchanged", () => {
    expect(normPath("/home/mat/foo")).toBe("/home/mat/foo");
  });
});

describe("resolveHome", () => {
  test("prefers HOME over USERPROFILE", () => {
    const got = resolveHome({ HOME: "/home/mat", USERPROFILE: "C:/Users/mat" });
    expect(got).toBe("/home/mat");
  });

  test("falls back to USERPROFILE when HOME is missing", () => {
    const got = resolveHome({ USERPROFILE: "C:\\Users\\mat" });
    expect(got).toBe("C:/Users/mat");
  });

  test("treats empty HOME as unset", () => {
    const got = resolveHome({ HOME: "", USERPROFILE: "C:/Users/mat" });
    expect(got).toBe("C:/Users/mat");
  });

  test("throws when neither is set", () => {
    expect(() => resolveHome({})).toThrow();
  });
});

describe("normalizeDirPath", () => {
  test("drops redundant trailing separators", () => {
    expect(normalizeDirPath("/tmp/mem///")).toBe("/tmp/mem");
  });

  test("preserves filesystem roots", () => {
    expect(normalizeDirPath("/")).toBe("/");
  });
});

describe("expandHomePath", () => {
  test("expands a leading tilde", () => {
    const got = expandHomePath("~/.config/opencode/memory", {
      HOME: "/home/mat",
    });
    expect(got).toBe("/home/mat/.config/opencode/memory");
  });

  test("leaves non-tilde paths unchanged", () => {
    expect(expandHomePath("/tmp/mem", { HOME: "/home/mat" })).toBe("/tmp/mem");
  });
});

describe("resolveMemoryDir", () => {
  test("uses OPENCODE_MEMORY_DIR override when set", () => {
    const got = resolveMemoryDir({
      HOME: "/home/mat",
      OPENCODE_MEMORY_DIR: "/tmp/mem",
    });
    expect(got).toBe("/tmp/mem");
  });

  test("normalizes the OPENCODE_MEMORY_DIR override", () => {
    const got = resolveMemoryDir({
      HOME: "/home/mat",
      OPENCODE_MEMORY_DIR: "C:\\Custom\\Memory\\",
    });
    expect(got).toBe("C:/Custom/Memory");
  });

  test("expands tilde in the OPENCODE_MEMORY_DIR override", () => {
    const got = resolveMemoryDir({
      HOME: "/home/mat",
      OPENCODE_MEMORY_DIR: "~/.config/opencode/memory",
    });
    expect(got).toBe("/home/mat/.config/opencode/memory");
  });

  test("defaults to $HOME/opencode-memory", () => {
    const got = resolveMemoryDir({ HOME: "/home/mat" });
    expect(got).toBe("/home/mat/opencode-memory");
  });

  test("treats empty OPENCODE_MEMORY_DIR as unset", () => {
    const got = resolveMemoryDir({
      HOME: "/home/mat",
      OPENCODE_MEMORY_DIR: "",
    });
    expect(got).toBe("/home/mat/opencode-memory");
  });

  test("ignores legacy MEMORY_DIR (no backward compat)", () => {
    // Pre-rename consumers used $MEMORY_DIR. This is a clean break:
    // the bare name is too generic and collides with other tooling, so
    // we deliberately do NOT fall back to it.
    const got = resolveMemoryDir({
      HOME: "/home/mat",
      MEMORY_DIR: "/should/be/ignored",
    });
    expect(got).toBe("/home/mat/opencode-memory");
  });
});

describe("formatMemoryDirForDisplay", () => {
  test("collapses paths under HOME to tilde", () => {
    expect(
      formatMemoryDirForDisplay("/home/mat/.config/opencode/memory", {
        HOME: "/home/mat",
      }),
    ).toBe("~/.config/opencode/memory");
  });

  test("leaves paths outside HOME absolute", () => {
    expect(formatMemoryDirForDisplay("/srv/shared/memory", { HOME: "/home/mat" })).toBe("/srv/shared/memory");
  });
});

describe("formatMemoryPathForDisplay", () => {
  test("joins display roots with relative memory paths", () => {
    expect(
      formatMemoryPathForDisplay("/home/mat/.config/opencode/memory", "technical/foo.md", { HOME: "/home/mat" }),
    ).toBe("~/.config/opencode/memory/technical/foo.md");
  });
});

describe("ragIndexDir", () => {
  test("appends .rag to the memory dir", () => {
    expect(ragIndexDir("/tmp/mem")).toBe("/tmp/mem/.rag");
  });
});
