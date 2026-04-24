import { describe, expect, test } from "bun:test";
import {
  normPath,
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

describe("resolveMemoryDir", () => {
  test("uses MEMORY_DIR override when set", () => {
    const got = resolveMemoryDir({
      HOME: "/home/mat",
      MEMORY_DIR: "/tmp/mem",
    });
    expect(got).toBe("/tmp/mem");
  });

  test("normalizes the MEMORY_DIR override", () => {
    const got = resolveMemoryDir({
      HOME: "/home/mat",
      MEMORY_DIR: "C:\\Custom\\Memory",
    });
    expect(got).toBe("C:/Custom/Memory");
  });

  test("defaults to $HOME/opencode-memory", () => {
    const got = resolveMemoryDir({ HOME: "/home/mat" });
    expect(got).toBe("/home/mat/opencode-memory");
  });

  test("treats empty MEMORY_DIR as unset", () => {
    const got = resolveMemoryDir({ HOME: "/home/mat", MEMORY_DIR: "" });
    expect(got).toBe("/home/mat/opencode-memory");
  });
});

describe("ragIndexDir", () => {
  test("appends .rag to the memory dir", () => {
    expect(ragIndexDir("/tmp/mem")).toBe("/tmp/mem/.rag");
  });
});
