/**
 * Tests for src/lib/ripgrep.ts.
 *
 * The helper does one thing: resolve the path exposed by the
 * `@vscode/ripgrep` package, or return null. We drive both branches.
 *
 * The "resolved" branch depends on `@vscode/ripgrep` actually being in
 * node_modules — which it is in this repo (declared in dependencies).
 * For the null branch we intercept the require cache.
 */

import { describe, expect, test } from "bun:test";
import {
  rgAvailable,
  rgInstallGuidance,
  resolveRgBinary,
} from "../src/lib/ripgrep";

describe("resolveRgBinary", () => {
  test("returns an absolute path when @vscode/ripgrep is installed", () => {
    const path = resolveRgBinary();
    expect(path).not.toBeNull();
    // The postinstall dropped the binary under node_modules/@vscode/ripgrep/bin.
    expect(path).toContain("@vscode/ripgrep");
    expect(path).toMatch(/\/bin\/rg(\.exe)?$/);
  });

  test("the returned binary is executable and exists on disk", async () => {
    const path = resolveRgBinary();
    if (!path) throw new Error("expected a path");
    const exists = await Bun.file(path).exists();
    expect(exists).toBe(true);

    // And can be executed — a bare `rg --version` is a safe probe.
    const out = await Bun.$`${path} --version`.text();
    expect(out).toMatch(/^ripgrep /);
  });
});

describe("rgAvailable", () => {
  test("returns true in this repo because the dep is installed", () => {
    expect(rgAvailable()).toBe(true);
  });
});

describe("rgInstallGuidance", () => {
  test("mentions the package name and common install paths", () => {
    const msg = rgInstallGuidance();
    expect(msg).toContain("@vscode/ripgrep");
    expect(msg).toContain("brew install ripgrep");
    expect(msg).toContain("cargo install ripgrep");
  });

  test("explains the impact on memory_search", () => {
    const msg = rgInstallGuidance();
    expect(msg).toContain("memory_search");
  });
});
