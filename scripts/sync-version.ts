#!/usr/bin/env bun
/**
 * Sync the version from package.json into README.md so users copy the
 * exact published version when they follow the installation snippet.
 * Run with: bun run sync-version
 *
 * Two things are rewritten:
 *   - the package coordinate, e.g. `@mathew-cf/opencode-memory@1.3.0`
 *   - the manual-install archive name, e.g. `opencode-memory-plugin-1.3.0`
 *
 * Both must tolerate prerelease versions (`1.3.0-rc.1`). A naive
 * `\d+\.\d+\.\d+` matches only the numeric core, so re-running the script
 * would append the prerelease suffix a second time and produce
 * `1.3.0-rc.1-rc.1`. The patterns below consume the whole version and are
 * bounded so they can't swallow a following `.tar.gz`.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

/** Semver core plus an optional prerelease suffix, matched lazily. */
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*?)?`;

const ARCHIVE_PREFIX = "opencode-memory-plugin-";

/**
 * Rewrite every version reference in `readme`. Pure so the prerelease and
 * idempotency behaviour can be tested without touching the filesystem.
 */
export function syncVersionText(readme: string, packageName: string, version: string): string {
  // Bounded by a negative lookahead so `@1.3.0-rc.1` is consumed whole
  // rather than leaving `-rc.1` behind to be duplicated.
  const versionPattern = new RegExp(
    `${packageName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}@${SEMVER}(?![0-9A-Za-z.-])`,
    "g",
  );
  // Bounded by the archive extension so the suffix stops before `.tar.gz`.
  const archivePattern = new RegExp(`${ARCHIVE_PREFIX}${SEMVER}(?=\\.(?:tar|zip))`, "g");

  return readme
    .replace(versionPattern, `${packageName}@${version}`)
    .replace(archivePattern, `${ARCHIVE_PREFIX}${version}`);
}

if (import.meta.main) {
  const rootDir = join(import.meta.dir, "..");
  const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8"));
  const readmePath = join(rootDir, "README.md");

  let readme: string;
  try {
    readme = readFileSync(readmePath, "utf-8");
  } catch {
    console.log("README.md not present — skipping version sync");
    process.exit(0);
  }

  const updated = syncVersionText(readme, packageJson.name, packageJson.version);
  if (readme !== updated) {
    writeFileSync(readmePath, updated);
    console.log(`Updated README.md to version ${packageJson.version}`);
  } else {
    console.log(`README.md already at version ${packageJson.version}`);
  }
}
