# AGENTS.md — opencode-memory

Conventions for agents working on the `@mathew-cf/opencode-memory` codebase.

## Quick Reference

| Command              | Purpose                                   |
| -------------------- | ----------------------------------------- |
| `bun test`           | Run all tests (`bun:test`)                |
| `bun run typecheck`  | TypeScript check (`tsc --noEmit`)         |
| `bun run build`      | Bundle to `dist/` + emit `.d.ts`          |

Run all three before committing:

```bash
bun run typecheck && bun test && bun run build
```

## Directory Structure

```
src/
  index.ts              # Plugin entry — wires tools, hooks, config
  config.ts             # applyConfig() — skills.paths, agent prompts, permissions
  constants.ts          # CATEGORIES, DEFAULT_MEMORY_SUBDIR, STOP_WORDS
  lib/
    paths.ts            # resolveHome, resolveMemoryDir, normPath, ragIndexDir
    frontmatter.ts      # parseFrontmatter, bumpAccessFields, todayISO
    search-terms.ts     # parseSearchTerms, countTermMatches, scoreCandidate
    rag.ts              # ensureRag, ragSearch, spawnRagIndex, downloadModel
    db.ts               # resolveDbPath, sqlStr, querySqlite
  tools/
    memory.ts           # search / list / save / access / setup
    session.ts          # search / read / list (reads opencode.db)
  hooks/
    guard.ts            # tool-call tracking, nudges, compaction context
test/
  helpers.ts            # withMemoryDir, writeMemoryFile, makeTempDir
  frontmatter.test.ts   # YAML parser + access-field mutation
  search-terms.test.ts  # Tokenization + scoring
  paths.test.ts         # Cross-platform home + memory dir resolution
  memory.test.ts        # Integration tests against temp memory dirs
  session.test.ts       # Integration tests against a temp SQLite db
  guard.test.ts         # Hook state machine + compaction output
  config.test.ts        # applyConfig() additive behaviour
skills/
  opencode-memory/
    SKILL.md            # The bundled skill, auto-registered at plugin load
scripts/
  sync-version.ts       # Sync package.json version into README.md
```

## Architecture

### Plugin entry (`src/index.ts`)

Exports a default `Plugin` function. On load it returns:

- **`tool`** — 8 custom tools, keyed with the `memory_` / `session_` prefixes so names match what skills and prompts already reference
- **`config`** — calls `applyConfig()` to register the bundled skill directory, add edit/external_directory permissions for `~/opencode-memory/**`, and prepend the memory-awareness appendix to the built-in subagent prompts
- **`tool.execute.after`** — `guard.toolAfter`, tracks memory/session tool usage, fires nudges
- **`experimental.session.compacting`** — `guard.compacting`, injects preserve-through-compaction context

### Separation of concerns

Every tool has two layers:

1. **`runXxx(input)`** — pure TypeScript function, no `tool()` wrapper. Takes plain arguments, reads env lazily, returns a string. Covered directly by integration tests.
2. **`tool({ description, args, execute })`** — thin wrapper that calls `runXxx` from the `execute` handler. Encodes the LLM-facing schema and docs.

This lets tests cover the real behaviour without constructing a fake OpenCode context.

### Env-driven configuration

The lib layer never reads config statically. Both `resolveMemoryDir()` and `resolveDbPath()` read `process.env` fresh on each call. That's how tests inject temp directories (`withMemoryDir` sets `MEMORY_DIR`) and temp databases (`session.test.ts` sets `OPENCODE_DB` in `beforeAll`).

### Graceful degradation around `rag`

The `rag` CLI is optional. `ensureRag()` silently tries a `cargo install` fallback if cargo is present; if not, everything downgrades to keyword-only search. No tool path ever hard-fails on missing `rag`.

## Coding Conventions

- **Runtime**: Bun. No Node-only APIs in src or test.
- **Imports**: `node:` prefix for Node builtins (`node:path`, `node:fs/promises`, `node:os`).
- **Tool definitions**: use `tool()` from `@opencode-ai/plugin` with `tool.schema` arg descriptors. Keep descriptions actionable — they're the LLM's only spec.
- **Error handling**: tool execute paths catch exceptions and return strings. Never throw to the caller; the agent reads whatever you return.
- **Types**: keep shared types in the file that owns the logic (e.g. `SessionState` in `hooks/guard.ts`). Only hoist to a top-level `types.ts` when two unrelated modules need the same shape.
- **Pure helpers live in `src/lib/`**. If a helper uses the filesystem or the shell, it belongs in the tool that calls it.
- **No organization- or environment-specific references.** This is a public plugin — examples should be generic (no internal hostnames, team names, proprietary tools, or ticket IDs).

## Test Patterns

- `test/helpers.ts` provides `withMemoryDir(cb)` which creates a fresh temp dir, points `$MEMORY_DIR` at it, runs the callback, then cleans up and restores the env.
- Pure-logic tests (`frontmatter.test.ts`, `search-terms.test.ts`, `paths.test.ts`, `guard.test.ts`, `config.test.ts`) take <100ms in aggregate — they don't hit the filesystem at all.
- `memory.test.ts` and `session.test.ts` are integration tests. `session.test.ts` builds a temp SQLite DB with the minimum schema we actually touch; `memory.test.ts` runs rg shell-outs against real files so bugs in the rg arg assembly get caught.
- Ranking assertions are **relative, not absolute** — e.g. `expect(aIdx).toBeLessThan(bIdx)`. Pinning exact scores makes the ranker impossible to tune.

## Adding a New Tool

1. Add a file (or new exports) under `src/tools/`.
2. Write the pure `runXxx(input)` function first. It should be callable from a test with plain arguments and return a string.
3. Wrap it with `tool({ description, args, execute })`. Keep the description opinionated — tell the agent when to call it and what to look for in the output.
4. Re-export it from `src/index.ts` under the appropriate namespace (`memory_xxx` or `session_xxx`).
5. Write tests for both the pure helpers **and** the integration path.
6. If the tool needs a new permission or a new agent prompt, update `src/config.ts` and `test/config.test.ts`.

## Publishing

Versions are synced into README.md automatically via `scripts/sync-version.ts`:

```bash
npm version patch    # or minor / major — triggers the version npm script
git push --follow-tags
npm publish --access public
```
