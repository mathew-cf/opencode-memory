# @mathew-cf/opencode-memory

Persistent cross-session memory for [OpenCode](https://opencode.ai).

This plugin gives the agent a durable knowledge base rooted at `~/opencode-memory/` — a git-tracked tree of markdown notes — plus read access to its own past sessions. A hybrid keyword + semantic search layer surfaces relevant notes before work starts, and a guard hook nudges the agent to save reusable discoveries as it goes.

## Why

LLM agents forget everything between sessions. That means rediscovering the same repo structure, tool quirks, and gotchas over and over. This plugin gives them a place to put that knowledge and a strong enough social contract (tool-call tracking, compaction-time retrospectives) that they actually use it.

## What you get

| Category           | Additions                                                                 |
| ------------------ | ------------------------------------------------------------------------- |
| **Memory tools**   | `memory_search`, `memory_list`, `memory_save`, `memory_access`, `memory_setup` |
| **Session tools**  | `session_search`, `session_read`, `session_list`                          |
| **Hooks**          | Search-first nudge at 8 tool calls; discovery nudge on subagent outputs; retrospective reminder at compaction time |
| **Skill**          | `opencode-memory` (auto-registered via the `skills.paths` config)         |
| **Agent prompts**  | Built-in subagents (`general`, `explore`, `research`, `review`, `investigator`) get a memory-aware prompt prepended non-destructively |

## Installation

```jsonc
// opencode.jsonc
{
  "plugin": ["@mathew-cf/opencode-memory@0.3.0"]
}
```

Then bootstrap the memory directory + embedding model:

```bash
bunx @mathew-cf/opencode-memory init
```

This creates `~/opencode-memory/` (git repo, 7 category subdirs) and downloads the ~90MB embedding model. Idempotent — safe to re-run. Pass `--skip-model` to defer the download.

The plugin auto-registers:

- its bundled skill under `config.skills.paths`
- edit + external-directory permissions for `~/opencode-memory/**`
- memory-aware prompt prefixes on the five built-in subagents (only when their prompt isn't already set)

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

Creates `~/opencode-memory/` (or `$MEMORY_DIR`), runs `git init`, scaffolds the 7 advisory category subdirs (`preferences/`, `repos/`, `technical/`, `people/`, `workflows/`, `snippets/`, `notes/`), and pre-caches the embedding model for semantic search.

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
memory_search("retry jitter")             # hybrid rg + rag
memory_search("auth", category="repos")   # filter to a category
memory_list()                             # browse categories + counts
memory_list("technical")                  # list files in one category
```

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
bun test             # 118 tests across 7 files
bun run build        # bundle to dist/
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
