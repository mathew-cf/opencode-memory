# @mathew-cf/opencode-memory

Persistent cross-session memory for [OpenCode](https://opencode.ai).

A git-tracked memory store rooted at `~/opencode-memory/`, plus optional read-only search over named knowledge bases. The OpenCode plugin provides tools, hooks, auto-applied config, and a bundled skill.

## Why

LLM agents forget everything between sessions. That means rediscovering the same repo structure, tool quirks, and gotchas over and over. This plugin gives them a place to put that knowledge and a strong enough social contract (tool-call tracking, compaction-time retrospectives) that they actually use it.

## What you get

| Category           | Additions                                                                 |
| ------------------ | ------------------------------------------------------------------------- |
| **Memory tools**   | `memory_search`, `memory_read`, `memory_list`, `memory_save`, `memory_access`, `memory_setup` |
| **Knowledge tools** | `knowledge_list`, `knowledge_base_search`, `knowledge_base_read` for separately indexed source repositories |
| **Session tools**  | `session_search_all` across OpenCode, Pi, and Codex; `session_search`, `session_read`, and `session_list` for OpenCode history |
| **Hooks**          | Search-first nudge at 8 tool calls; discovery nudge on subagent outputs; retrospective reminder at compaction time (OpenCode only) |
| **Skill**          | `opencode-memory` — auto-registered in OpenCode, dropped at `~/.agents/skills/opencode-memory` for Zed & Pi |
| **Agent prompts**  | Built-in subagents (`general`, `explore`, `research`, `review`, `investigator`) get a memory-aware prompt prepended non-destructively (OpenCode only) |

## Installation

### OpenCode

The package root is the OpenCode v1 plugin. OpenCode v2 loads the package's
`./server` export, which provides the v2 plugin. Both use the same tool definitions
and search v1 and v2 OpenCode session history. The v1 entry adapts the tools and
registers its hooks and config through the v1 plugin API.

OpenCode v2:

```jsonc
// opencode.jsonc
{
  "plugins": ["@mathew-cf/opencode-memory"]
}
```

OpenCode v1:

```jsonc
// opencode.jsonc
{
  "plugin": ["@mathew-cf/opencode-memory@2.0.0"]
}
```

Then bootstrap the memory directory + embedding model + skill:

```bash
bunx @mathew-cf/opencode-memory init
```

This creates `~/opencode-memory/` (git repo, 7 category subdirs), downloads the ~90MB embedding model, and symlinks the bundled skill into `~/.agents/skills/opencode-memory` (where Zed and Pi look). Idempotent — safe to re-run. Pass `--skip-model` to defer the download, `--skip-skills` to skip the symlink.

The plugin also auto-registers (OpenCode only):

- its bundled skill under `config.skills.paths`
- edit + external-directory permissions for `~/opencode-memory/**`
- memory-aware prompt prefixes on the five built-in subagents (only when their prompt isn't already set)

### Search backends

`memory_search` combines two complementary signals:

| Signal | Command | Purpose |
| ------ | ------- | ------- |
| Keyword | `rag keyword` | Live text search over memory files |
| Semantic | `rag search` | Similarity search via local embeddings |

Both commands come from the required `@mathew-cf/rag-cli` package, which installs a prebuilt binary on supported platforms. No Rust toolchain or `$PATH` setup is needed.

Pre-cache the embedding model once (~90MB) to make the first semantic search instant:

```bash
rag download
```

`memory_setup` reports whether the binary and its keyword command are available. Semantic search also needs an index and the cached embedding model.

## Usage

### First-time setup

```bash
bunx @mathew-cf/opencode-memory init
```

Creates `~/opencode-memory/` (or `$OPENCODE_MEMORY_DIR`), runs `git init`, scaffolds the 7 advisory category subdirs (`preferences/`, `repos/`, `technical/`, `people/`, `workflows/`, `snippets/`, `notes/`), writes a `rag.toml` for the `memory` index, and pre-caches the embedding model for semantic search. Existing `rag.toml` files are preserved.

The generated config is:

```toml
[[index]]
name = "memory"
path = "."
output = ".rag"
exclude = ["rag.toml", ".rag.toml"]
```

`memory_search` uses this entry for live keyword file selection and semantic search; `memory_save` rebuilds only this entry. Add `exclude`, `include`, `no_ignore`, or `hidden` to control file selection, following rag-cli's `rag.toml` rules. Keep the entry named `memory`. Other entries, if present, do not enter memory search. The plugin combines keyword and semantic results with its own frontmatter-aware ranking, so `[search] hybrid` is overridden for its semantic call. For direct CLI search, rag-cli's own `[search]` settings still apply. Stores without `rag.toml` retain path-based search and indexing.

If an existing `.rag` index predates rag-cli 2.0, rebuild it once with `rag index --config ~/opencode-memory/rag.toml --only memory` (adjust the path when using `$OPENCODE_MEMORY_DIR`).

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
memory_search("retry jitter")             # compact keyword + semantic results (up to 5)
memory_search("auth", category="repos")   # filter to a category
memory_read("repos/example.md")            # frontmatter + first 4,000 body chars
memory_read("repos/example.md", heading="Build") # retrieve one heading section
memory_list()                              # browse categories + counts
memory_list("technical")                   # list files in one category
```

### Knowledge bases

Knowledge bases are separate from the writable memory store. Configure their
names and directories in `~/.config/opencode-memory/config.toml`:

```toml
[[knowledge_base]]
name = "reference"
path = "~/opencode-knowledge-base"
default = true

[[knowledge_base]]
name = "project"
path = "~/projects/my-project/knowledge"
```

Each directory must contain `rag.toml` (or `.rag.toml`) with one or more
`[[index]]` source entries. Index those sources with `rag index --config
<knowledge-base>/rag.toml`; `knowledge_base_search` uses `rag search --config` and
honors that file's `[search]` settings, including `hybrid = true`. The plugin
does not build knowledge-base indexes or write to source repositories.

Names must be unique. With one configured base it becomes the default
automatically. With several, mark one `default = true` or pass `base` on each
call. Relative directory paths in this config resolve from the config file's
directory. Set `OPENCODE_MEMORY_CONFIG` to use another config file.

```
knowledge_list()                                      # names and default
knowledge_base_search(query="cache retries")              # default base
knowledge_base_search(query="cache retries", base="project")
knowledge_base_search(query="cache retries", all=true)    # results grouped by base
knowledge_base_read(base="reference", index="docs", source="guide.md")
```

Search results carry the base name, index name, and source path. Pass those
fields to `knowledge_base_read`; it reads a bounded portion of the original file
under that index's configured source directory, even when the source repo is
outside the knowledge-base directory.

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

The plugin installs two hooks:

### `tool.execute.after`
Tracks tool usage per session and injects short reminders into tool output when:

- **8 tool calls deep with no search**: reminds the agent to call `memory_search` and `session_search` before going further.
- **A subagent's output contains "Discoveries worth saving"**: reminds the parent to actually save them, not defer to session end.

Reminders fire at most once per session each to avoid spam.

### `experimental.session.compacting`
Injects memory-specific preservation rules so references to saved files and search results survive summarization. If the session is >10 tool calls and never called `memory_save`, adds a retrospective reminder.

## Development

```bash
bun install
bun run typecheck    # tsc --noEmit
bun test
bun run build        # bundle to dist/
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
