/**
 * Assemble a self-contained plugin payload for manual installation.
 *
 * OpenCode discovers plugin directories under `.opencode/plugins/` and
 * `~/.config/opencode/plugins/`, but it looks for an `index.js` / `index.ts`
 * at the directory root — a `package.json` `main` pointing at `dist/` is not
 * enough. So the payload ships a one-line loader alongside the build.
 *
 * Layout produced in `build/`:
 *
 *   build/
 *     opencode-memory/            <- drop this into a plugins/ directory
 *       index.js                  <- loader: re-exports dist/index.js
 *       dist/
 *       skills/
 *       package.json
 *     opencode-memory-plugin-<version>.tar.gz
 *     opencode-memory-plugin-<version>.zip
 *
 * `node_modules/` is deliberately NOT included: ripgrep and rag-cli ship
 * platform-specific binaries, so the payload stays portable and the user
 * runs one install command to pull the right ones for their machine.
 *
 * Run `bun run build` first — this script only assembles, it never compiles.
 */

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BUILD = join(ROOT, "build");
const PAYLOAD_NAME = "opencode-memory";

const LOADER = `// OpenCode plugin entrypoint.
// Directory plugins are discovered by their root index.js, so this file
// re-exports the bundled build.
export { default } from "./dist/index.js"
`;

export async function packPlugin(): Promise<{ dir: string; version: string }> {
  const pkg = await Bun.file(join(ROOT, "package.json")).json();
  const version: string = pkg.version;

  if (!existsSync(join(ROOT, "dist", "index.js"))) {
    throw new Error("dist/index.js is missing — run `bun run build` first");
  }

  const payload = join(BUILD, PAYLOAD_NAME);
  await rm(BUILD, { recursive: true, force: true });
  await mkdir(payload, { recursive: true });

  await cp(join(ROOT, "dist"), join(payload, "dist"), { recursive: true });
  await cp(join(ROOT, "skills"), join(payload, "skills"), { recursive: true });
  await cp(join(ROOT, "package.json"), join(payload, "package.json"));
  await writeFile(join(payload, "index.js"), LOADER);

  const base = `${PAYLOAD_NAME}-plugin-${version}`;
  await Bun.$`tar -czf ${join(BUILD, `${base}.tar.gz`)} -C ${BUILD} ${PAYLOAD_NAME}`.quiet();
  await Bun.$`zip -qr ${join(BUILD, `${base}.zip`)} ${PAYLOAD_NAME}`.cwd(BUILD).quiet();

  return { dir: payload, version };
}

if (import.meta.main) {
  const { dir, version } = await packPlugin();
  console.log(`Packed opencode-memory v${version} -> ${dir}`);
}
