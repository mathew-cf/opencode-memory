/**
 * Thin wrapper around the `@vscode/ripgrep` package.
 *
 * `@vscode/ripgrep` is a required dependency of this plugin. On install,
 * its postinstall script downloads the platform's prebuilt `rg` binary
 * and exposes its absolute path via `rgPath`. We import it via a dynamic
 * `require` so tests (and code paths where the dep happens to be missing)
 * can still execute — returning `null` from `resolveRgBinary` so callers
 * surface a clean error rather than crashing on import.
 *
 * We resolve at call time rather than at module-top-level so a broken
 * install doesn't prevent the plugin from loading at all. `memory_search`
 * will then fall through to the "no results" branch with a helpful message.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Resolve the absolute path to the `rg` binary shipped by the
 * `@vscode/ripgrep` package. Returns `null` if the package isn't
 * installed (unusual — should never happen in practice because it's
 * a required dep) or if its published layout changes.
 *
 * Exported for tests and for `memory_setup`.
 */
export function resolveRgBinary(): string | null {
  try {
    // The module exposes `{ rgPath: string }` on both CJS and ESM entry
    // points. `require` works from our ESM context thanks to createRequire.
    const mod = require("@vscode/ripgrep") as { rgPath?: unknown };
    if (typeof mod.rgPath === "string" && mod.rgPath.length > 0) {
      return mod.rgPath;
    }
    return null;
  } catch {
    return null;
  }
}

/** True iff a usable `rg` binary is resolvable. */
export function rgAvailable(): boolean {
  return resolveRgBinary() !== null;
}

/**
 * Human-readable guidance for when ripgrep can't be resolved. Mirrors the
 * shape of `rag.installGuidance()` so `memory_setup` can surface either
 * message consistently.
 */
export function rgInstallGuidance(): string {
  return [
    "Keyword search is unavailable: the `@vscode/ripgrep` package could",
    "not be resolved from this plugin's node_modules. Ripgrep ships a",
    "prebuilt binary per platform; the download runs during install.",
    "",
    "Remedies:",
    "  1. Reinstall the plugin. If using OpenCode, delete",
    "     `~/.cache/opencode/node_modules` and restart.",
    "  2. If your platform isn't supported, install `rg` manually and",
    "     make sure it's on your $PATH:",
    "       brew install ripgrep         # macOS",
    "       sudo apt install ripgrep     # Debian/Ubuntu",
    "       cargo install ripgrep        # anywhere with Rust",
    "",
    "Without `rg`, memory_search will return 'no memories' even when",
    "files exist. Semantic search (via rag-cli) may still produce",
    "results but won't be complemented by keyword hits.",
  ].join("\n");
}
