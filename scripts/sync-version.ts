#!/usr/bin/env bun
/**
 * Sync the version from package.json into README.md so users copy the
 * exact published version when they follow the installation snippet.
 * Run with: bun run sync-version
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const rootDir = join(import.meta.dir, "..");
const packageJsonPath = join(rootDir, "package.json");
const readmePath = join(rootDir, "README.md");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const version = packageJson.version;
const packageName = packageJson.name;

let readme: string;
try {
  readme = readFileSync(readmePath, "utf-8");
} catch {
  console.log("README.md not present — skipping version sync");
  process.exit(0);
}

// Match @scope/pkg@X.Y.Z — don't be greedy with the version number.
const versionPattern = new RegExp(
  `${packageName.replace("/", "\\/")}@\\d+\\.\\d+\\.\\d+`,
  "g",
);

const newVersionString = `${packageName}@${version}`;
const updatedReadme = readme.replace(versionPattern, newVersionString);

if (readme !== updatedReadme) {
  writeFileSync(readmePath, updatedReadme);
  console.log(`Updated README.md to version ${version}`);
} else {
  console.log(`README.md already at version ${version}`);
}
