# @mathew-cf/opencode-memory

Persistent cross-session memory for [OpenCode](https://opencode.ai).

A durable knowledge base rooted at `~/opencode-memory/` — a git-tracked tree of markdown notes — paired with a hybrid keyword + semantic search layer. The OpenCode plugin provides tools, hooks, auto-applied config, and a bundled skill.

## Why

LLM agents forget everything between sessions. That means rediscovering the same repo structure, tool quirks, and gotchas over and over. This plugin gives them a place to put that knowledge and a strong enough social contract (tool-call tracking, compaction-time retrospectives) that they actually use it.

## What you get

| Category           | Additions                                                                 |
| ------------------ | ------------------------------------------------------------------------- |
| **Memory tools**   | `memory_search`, `memory_read`, `memory_list`, `memory_save`, `memory_access`, `memory_setup` |
| **Session tools**  | `session_search_all` across OpenCode, Pi, and Codex; `session_search`, `session_read`, and `session_list` for OpenCode history |
| **Hooks**          | Search-first nudge at 8 tool calls; discovery nudge on subagent outputs; retrospective reminder at compaction time (OpenCode only) |
| **Skill**          | `opencode-memory` — auto-registered in OpenCode, dropped at `~/.agents/skills/opencode-memory` for Zed & Pi |
| **Agent prompts**  | Built-in subagents (`general`, `explore`, `research`, `review`, `investigator`) get a memory-aware prompt prepended non-destructively (OpenCode only) |

## Installation

### OpenCode

OpenCode 2:

```jsonc
// opencode.jsonc
{
  "plugins": ["@mathew-cf/opencode-memory@1.3.0-rc.1"]
}
```

OpenCode 1:

```jsonc
// opencode.jsonc
{
  "plugin": ["@mathew-cf/opencode-memory@1.3.0-rc.1"]
}
```

One package serves both: the default export exposes a V1 `server()` and a V2 `setup()`, so the same version works on either release.

### Manual install (from a GitHub release)

Use this when you don't want to install from npm — for example to run a build straight off a fork or a branch.

Every release built by the **Build** workflow attaches `opencode-memory-plugin-<version>.tar.gz` (and a `.zip`). It contains `index.js`, `dist/`, `skills/`, and `package.json` — everything except the platform-specific binaries, which are installed on your machine.

#### Scripted

`scripts/install.sh` does the whole thing — downloads the newest release, installs the backends, places the payload, creates the memory directory, and fetches the embedding model:

```bash
curl -fsSL https://raw.githubusercontent.com/nedy13/opencode-memory/main/scripts/install.sh | bash
```

It needs `curl`, `tar`, `git`, and either `bun` or `npm`. Useful options:

```bash
./install.sh --tag v1.3.0          # pin a release
./install.sh --project /path/repo  # install into one project instead of globally
./install.sh --skip-model          # defer the ~90MB embedding model
./install.sh --help
```

#### By hand

> **Install the dependencies _before_ moving the plugin into place.** OpenCode watches its plugin
> directories and loads a plugin the moment it appears. If it loads before `node_modules/` exists, Bun
> caches a failed module resolution for that directory and the search backends stay unavailable until the
> server is restarted — `memory_search` then returns nothing even when memories exist. Staging first
> avoids the problem entirely.

**1. Extract into a staging directory** — anywhere *outside* a plugins directory:

```bash
tar -xzf ~/Downloads/opencode-memory-plugin-1.3.0-rc.1.tar.gz -C /tmp
```

**2. Install the search backends.** ripgrep and rag-cli ship per-platform binaries, so they're pulled for your machine rather than baked into the archive:

```bash
cd /tmp/opencode-memory
bun install --production --omit=peer --omit=dev
```

Skipping `--omit=peer` pulls in the optional typing peers and inflates the directory from ~46MB to ~640MB. If you'd rather use npm: `npm install --omit=dev --omit=peer`.

**3. Move it into a plugins directory.** Global (all projects):

```bash
mkdir -p ~/.config/opencode/plugins
mv /tmp/opencode-memory ~/.config/opencode/plugins/
```

Or per project, if you only want it in one repo:

```bash
mkdir -p .opencode/plugins
mv /tmp/opencode-memory .opencode/plugins/
```

Either way you end up with a directory named `opencode-memory/` containing `index.js`. OpenCode discovers plugin directories by that root `index.js`, so don't flatten or rename it.

**4. Verify it loaded:**

```bash
opencode plugin list
```

You should see `opencode-memory` listed as active — no restart needed, since the plugin arrived complete. Then run the bootstrap step below to create the memory directory.

If you installed in the wrong order and `memory_setup` reports the backends as `NOT resolvable`, run `opencode service restart` once; the cached resolution failure clears with the process.

To update, delete the `opencode-memory/` directory and repeat from step 1. To uninstall, delete it and restart the service.

### Manual install (from source)

If you have the repository checked out, build it and point a loader file at the result:

```bash
bun install && bun run build
mkdir -p ~/.config/opencode/plugins
echo 'export { default } from "/absolute/path/to/opencode-memory/dist/index.js"' \
  > ~/.config/opencode/plugins/opencode-memory.ts
opencode service restart
```

A single `.ts` or `.js` file works as well as a directory. This route reuses the repository's own `node_modules`, so there's no second install step — but the plugin breaks if you move, delete, or `git checkout` away from that build.

Then bootstrap the memory directory + embedding model + skill:

```bash
bunx @mathew-cf/opencode-memory init
```

If you installed manually from a release (so the package isn't on npm), run the bundled CLI instead:

```bash
bun ~/.config/opencode/plugins/opencode-memory/dist/cli.js init
```

This creates `~/opencode-memory/` (git repo, 7 category subdirs), downloads the ~90MB embedding model, and symlinks the bundled skill into `~/.agents/skills/opencode-memory` (where Zed and Pi look). Idempotent — safe to re-run. Pass `--skip-model` to defer the download, `--skip-skills` to skip the symlink.

If you deferred the model, fetch it later with the bundled rag shim:

```bash
cd ~/.config/opencode/plugins/opencode-memory
bun node_modules/@mathew-cf/rag-cli/bin/rag.js download
```

The plugin also auto-registers (OpenCode only):

- its bundled skill (V1: `config.skills.paths`; V2: a skill transform)
- edit + external-directory permissions for `~/opencode-memory/**`
- memory-aware prompt prefixes on the five built-in subagents (only when their prompt isn't already set)

On OpenCode 2 the memory-directory permissions are attached to every agent, because V2 replaces the single global `permission` block with per-domain rules.

### Search backends

`memory_search` combines two complementary signals:

| Backend                | Package                     | Purpose                              |
| ---------------------- | --------------------------- | ------------------------------------ |
| **Keyword (ripgrep)**  | `@vscode/ripgrep`           | Exact-match + phrase lookup over files |
| **Semantic (rag-cli)** | `@mathew-cf/rag-cli`        | Similarity search via local embeddings |

Both are declared as **required dependencies**: installing the plugin pulls in prebuilt binaries for your platform automatically (macOS ARM64/x64, Linux x64/ARM64; ripgrep additionally covers Windows and FreeBSD). No Rust toolchain, no `brew install`, no `$PATH` plumbing.

Pre-cache the embedding model once (~90MB) to make the first semantic search instant:

```bash
rag download
```

If either dependency fails to install (unusual — usually indicates an unsupported platform), the plugin transparently degrades. `memory_setup` reports which backends are resolvable and prints targeted install guidance for each.

## Usage

### First-time setup

```bash
bunx @mathew-cf/opencode-memory init
```

Creates `~/opencode-memory/` (or `$OPENCODE_MEMORY_DIR`), runs `git init`, scaffolds the 7 advisory category subdirs (`preferences/`, `repos/`, `technical/`, `people/`, `workflows/`, `snippets/`, `notes/`), and pre-caches the embedding model for semantic search.

Subcommands:

| Command                                         | Purpose                                                |
| ----------------------------------------------- | ------------------------------------------------------ |
| `bunx @mathew-cf/opencode-memory init`          | Create + git-init memory dir, download embedding model |
| `bunx @mathew-cf/opencode-memory init --skip-model` | Same, but skip the ~90MB download                  |
| `bunx @mathew-cf/opencode-memory status`        | Report which search backends are resolvable           |

### Writing memory

Memory files are plain markdown with a small frontmatter block:

```markdown
---
title: Framework uses custom error hierarchy
tags: [framework, error-handling]
summary: All errors must extend AppError; plain Error bypasses formatting
created: 2025-01-15
updated: 2025-01-15
importance: high
source: Code inspection of src/errors/
source_date: 2025-01-15
---

All errors in `src/errors/` must extend `AppError`. Throwing plain `Error`
bypasses the error formatter → raw 500s. Gotcha: `AuthError` must include a
`realm` field or auth middleware silently ignores it.
```

After writing or editing files, call `memory_save` — it runs `git add -A` + commit and kicks off a background `rag index` re-build.

### Searching

```
memory_search("retry jitter")             # compact hybrid rg + rag results (up to 5)
memory_search("auth", category="repos")   # filter to a category
memory_read("repos/example.md")            # frontmatter + first 4,000 body chars
memory_read("repos/example.md", heading="Build") # retrieve one heading section
memory_list()                              # browse categories + counts
memory_list("technical")                   # list files in one category
```

### Reading session history

`session_search_all` queries OpenCode, Pi, and Codex concurrently and labels each
source. Missing harnesses are reported without failing the available searches.
The `limit` applies per source. Results include IDs and snippets; when a harness's
native reader is installed, use it to open that source's session.
Pi discovery scans its JSONL history, including historical branches; use Pi's
native reader when you need its active-branch and compaction-aware view.

The OpenCode-only `session_search` returns a message `offset` for each content
match. Pass that to `session_read` to jump to the relevant message. Session reads normalize invalid
pagination values, cap `limit` at 100 messages, and expose at most about 16,000
message-text characters per call. If that bound falls within one oversized
message, the response provides both `offset` and `message_char_offset`; pass
both back to continue at a UTF-safe boundary without skipping content.

See the bundled skill (`skills/opencode-memory/SKILL.md`) for the full protocol.

## How the guard hook works

The plugin installs two hooks (V1 names first, V2 equivalents in parentheses):

### `tool.execute.after` (V2: `ctx.tool.hook("execute.after")`)
Tracks tool usage per session and injects short reminders into tool output when:

- **8 tool calls deep with no search**: reminds the agent to call `memory_search` and `session_search` before going further.
- **A subagent's output contains "Discoveries worth saving"**: reminds the parent to actually save them, not defer to session end.

Reminders fire at most once per session each to avoid spam.

### `experimental.session.compacting` (V2: `ctx.session.hook("compaction")`)
Injects memory-specific preservation rules so references to saved files and search results survive summarization. If the session is >10 tool calls and never called `memory_save`, adds a retrospective reminder.

## Development

```bash
bun install
bun run typecheck    # tsc --noEmit
bun test             # 236 tests across 14 files
bun run build        # bundle to dist/
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
