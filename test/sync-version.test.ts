import { describe, expect, test } from "bun:test";
import { syncVersionText } from "../scripts/sync-version";

const PKG = "@mathew-cf/opencode-memory";

const README = [
  '{ "plugins": ["@mathew-cf/opencode-memory@1.2.1"] }',
  '{ "plugin": ["@mathew-cf/opencode-memory@1.2.1"] }',
  "tar -xzf ~/Downloads/opencode-memory-plugin-1.2.1.tar.gz -C ~/.config/opencode/plugins",
  "unzip opencode-memory-plugin-1.2.1.zip",
].join("\n");

describe("syncVersionText", () => {
  test("rewrites package coordinates and archive names", () => {
    const out = syncVersionText(README, PKG, "1.3.0");
    expect(out).toContain(`${PKG}@1.3.0`);
    expect(out).toContain("opencode-memory-plugin-1.3.0.tar.gz");
    expect(out).toContain("opencode-memory-plugin-1.3.0.zip");
    expect(out).not.toContain("1.2.1");
  });

  test("handles prerelease versions", () => {
    const out = syncVersionText(README, PKG, "1.3.0-rc.1");
    expect(out).toContain(`${PKG}@1.3.0-rc.1`);
    expect(out).toContain("opencode-memory-plugin-1.3.0-rc.1.tar.gz");
  });

  test("never swallows the archive extension", () => {
    const out = syncVersionText(README, PKG, "1.3.0-rc.1");
    expect(out).toContain(".tar.gz");
    expect(out).toContain(".zip");
    expect(out).not.toMatch(/opencode-memory-plugin-[^\s]*\.tar\.gz\.tar/);
  });

  // The regression that motivated the rewrite: `npm version` runs this on
  // every bump, so a second pass over prerelease output must be a no-op.
  test("is idempotent for prerelease versions", () => {
    const once = syncVersionText(README, PKG, "1.3.0-rc.1");
    const twice = syncVersionText(once, PKG, "1.3.0-rc.1");
    expect(twice).toBe(once);
    expect(twice).not.toContain("rc.1-rc.1");
  });

  test("is idempotent for stable versions", () => {
    const once = syncVersionText(README, PKG, "2.0.0");
    expect(syncVersionText(once, PKG, "2.0.0")).toBe(once);
  });

  test("moves from a prerelease back to a stable version", () => {
    const rc = syncVersionText(README, PKG, "1.3.0-rc.1");
    const stable = syncVersionText(rc, PKG, "1.3.0");
    expect(stable).toContain(`${PKG}@1.3.0`);
    expect(stable).not.toContain("rc.1");
    expect(stable).toContain("opencode-memory-plugin-1.3.0.tar.gz");
  });

  test("leaves unrelated version-like text alone", () => {
    const input = "requires bun 1.4.2 and node 22.0.0";
    expect(syncVersionText(input, PKG, "1.3.0")).toBe(input);
  });
});
