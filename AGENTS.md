# AGENTS.md — opencode-memory

Conventions for agents working on the `@mathew-cf/opencode-memory` codebase.

## Quick Reference

| Command              | Purpose                                   |
| -------------------- | ----------------------------------------- |
| `bun test`           | Run all tests (`bun:test`)                |
| `bun run typecheck`  | TypeScript check (`tsc --noEmit`)         |
| `bun run build`      | Bundle to `dist/` + emit `.d.ts`          |
| `bun run pack:plugin`| Assemble `build/` payload + archives      |

Run all three before committing:

```bash
bun run typecheck && bun test && bun run build
```

## Directory Structure

```
src/
  index.ts              # Dual entry — V1 `server()` + V2 `setup()` in one default export
  v2.ts                 # OpenCode V2 surface: tool/skill/agent transforms + hooks
  cli.ts                # `opencode-memory` bin: init / status / help
  config.ts             # applyConfig() (V1) + applyAgentConfigV2() / permission rules (V2)
  constants.ts          # CATEGORIES, DEFAULT_MEMORY_SUBDIR, STOP_WORDS
  lib/
    paths.ts            # resolveHome, resolveMemoryDir, normPath, ragIndexDir
    frontmatter.ts      # parseFrontmatter, parseSkillFrontmatter, bumpAccessFields, todayISO
    search-terms.ts     # parseSearchTerms, countTermMatches, scoreCandidate
    tool-spec.ts        # defineTool() — one spec, both plugin surfaces
    rag.ts              # ensureRag, ragSearch, spawnRagIndex, downloadModel
    db.ts               # resolveDbPath, sqlStr, querySqlite
  tools/
    index.ts            # allTools registry + v1ToolMap()
    memory.ts           # search / read / list / save / access / setup
    session.ts          # search / read / list (reads opencode.db)
  hooks/
    guard.ts            # tool-call tracking, nudges, compaction context
test/
  helpers.ts            # withMemoryDir, writeMemoryFile, makeTempDir
  frontmatter.test.ts   # YAML parser + access-field mutation
  search-terms.test.ts  # Tokenization + scoring
  paths.test.ts         # Cross-platform home + memory dir resolution
  tool-spec.test.ts     # JSON Schema → zod derivation + tool registry
  memory.test.ts        # Integration tests against temp memory dirs
  session.test.ts       # Integration tests against a temp SQLite db
  guard.test.ts         # Hook state machine + compaction output
  config.test.ts        # applyConfig() additive behaviour (V1)
  config-v2.test.ts     # applyAgentConfigV2() + permission rules (V2)
  v2.test.ts            # V2 setup() against a recording fake context
  index.test.ts         # Dual default export shape
  cli.test.ts           # CLI dispatcher + skill-symlink install
skills/
  opencode-memory/
    SKILL.md            # The bundled skill, auto-registered at plugin load
scripts/
  sync-version.ts       # Sync package.json version into README.md
  pack-plugin.ts        # Assemble build/ payload for manual installs
  install.sh            # End-user installer for a GitHub release payload
```

## Architecture

This package ships two independent surfaces against the same shared core:

| Surface           | Entry point    | Audience                               |
| ----------------- | -------------- | -------------------------------------- |
| OpenCode plugin   | `src/index.ts` | OpenCode (tools + hooks + auto-config) |
| `opencode-memory` | `src/cli.ts`   | Humans (`init`, `status`) + post-install |

Both share `src/tools/*` and `src/lib/*`. Adding a new memory tool means changing `tools/memory.ts` and adding it to the `allTools` registry in `tools/index.ts` — both plugin versions pick it up from there.

### OpenCode plugin entry (`src/index.ts`)

The default export is a record that serves **both** OpenCode major versions:

- **V1** calls `server()`, which returns the classic hook object
- **V2** reads `id` + `setup()`, built by `createV2Plugin()` in `src/v2.ts`

V1 `server()` returns:

- **`tool`** — `v1ToolMap()`, keyed with the `memory_` / `session_` prefixes so names match what skills and prompts already reference
- **`config`** — calls `applyConfig()` to register the bundled skill directory, add edit/external_directory permissions for `~/opencode-memory/**`, and prepend the memory-awareness appendix to the built-in subagent prompts
- **`tool.execute.after`** — `guard.toolAfter`, tracks memory/session tool usage, fires nudges
- **`experimental.session.compacting`** — `guard.compacting`, injects preserve-through-compaction context

### OpenCode V2 surface (`src/v2.ts`)

`createV2Plugin()` returns `{ id, setup }`. `setup(ctx)` performs the same work through V2's domain APIs:

| V1                                | V2                                     |
| --------------------------------- | -------------------------------------- |
| `tool` map                        | `ctx.tool.transform` (JSON Schema)     |
| `config.skills.paths`             | `ctx.skill.transform`                  |
| `config.agent[*].prompt`          | `ctx.agent.transform` → `agent.system` |
| `config.permission`               | agent `permissions` rules              |
| `tool.execute.after`              | `ctx.tool.hook("execute.after")`       |
| `experimental.session.compacting` | `ctx.session.hook("compaction")`       |

Two rules keep this workable:

- **Only types are imported from `@opencode/plugin`.** `Plugin.define()` is an identity function, so skipping it keeps the bundle free of a runtime dependency on the V2 SDK — which matters because the same file has to load under V1. `@opencode/plugin` is an *optional* peer dependency for that reason.
- **Transform callbacks stay synchronous.** V2 replays them on every registry rebuild. Anything async (reading `SKILL.md`, for example) happens in `setup` before the transform and is captured by the callback.

Because V2 has no single global permission object, memory-directory rules are applied to every agent rather than once globally. V2 permission arrays are last-match-wins, so rules are always appended, and never appended twice for the same `action` + `resource`.

### Separation of concerns

Every tool has three layers:

1. **`runXxx(input)`** — pure TypeScript function. Takes plain arguments, reads env lazily, returns a string. Covered directly by integration tests.
2. **`defineTool({ name, description, input, execute })`** — the LLM-facing spec. `input` is JSON Schema (V2's native format) and is the single source of truth; `execute` calls `runXxx`.
3. **`.v1`** — the `tool()` definition `defineTool` derives from that spec, with the zod `args` shape built by `toolArgsFromSchema`.

This lets tests cover the real behaviour without constructing a fake OpenCode context, and keeps one description per tool instead of one per plugin version.

### Env-driven configuration

The lib layer never reads config statically. Both `resolveMemoryDir()` and `resolveDbPath()` read `process.env` fresh on each call. That's how tests inject temp directories (`withMemoryDir` sets `OPENCODE_MEMORY_DIR`) and temp databases (`session.test.ts` sets `OPENCODE_DB` in `beforeAll`).

### Graceful degradation around `rag`

The `rag` CLI is optional. `ensureRag()` silently tries a `cargo install` fallback if cargo is present; if not, everything downgrades to keyword-only search. No tool path ever hard-fails on missing `rag`.

## Coding Conventions

- **Runtime**: Bun. No Node-only APIs in src or test.
- **Imports**: `node:` prefix for Node builtins (`node:path`, `node:fs/promises`, `node:os`).
- **Tool definitions**: use `defineTool()` from `src/lib/tool-spec.ts`. Declare the schema once as JSON Schema; the V1 zod `args` shape is derived from it. Keep descriptions actionable — they're the LLM's only spec.
- **Error handling**: tool execute paths catch exceptions and return strings. Never throw to the caller; the agent reads whatever you return.
- **Types**: keep shared types in the file that owns the logic (e.g. `SessionState` in `hooks/guard.ts`). Only hoist to a top-level `types.ts` when two unrelated modules need the same shape.
- **Pure helpers live in `src/lib/`**. If a helper uses the filesystem or the shell, it belongs in the tool that calls it.
- **No organization- or environment-specific references.** This is a public plugin — examples should be generic (no internal hostnames, team names, proprietary tools, or ticket IDs).

## Test Patterns

- `test/helpers.ts` provides `withMemoryDir(cb)` which creates a fresh temp dir, points `$OPENCODE_MEMORY_DIR` at it, runs the callback, then cleans up and restores the env.
- Pure-logic tests (`frontmatter.test.ts`, `search-terms.test.ts`, `paths.test.ts`, `guard.test.ts`, `config.test.ts`, `config-v2.test.ts`, `tool-spec.test.ts`) take <100ms in aggregate — they don't hit the filesystem at all.
- `v2.test.ts` drives `setup()` against a recording fake context: the fake's editors collect whatever the plugin registers, and the captured hooks are then invoked directly. Extend the fake when you register a new domain rather than mocking the whole V2 SDK.
- `memory.test.ts` and `session.test.ts` are integration tests. `session.test.ts` builds a temp SQLite DB with the minimum schema we actually touch; `memory.test.ts` runs rg shell-outs against real files so bugs in the rg arg assembly get caught.
- Ranking assertions are **relative, not absolute** — e.g. `expect(aIdx).toBeLessThan(bIdx)`. Pinning exact scores makes the ranker impossible to tune.

## Adding a New Tool

1. Add a file (or new exports) under `src/tools/`.
2. Write the pure `runXxx(input)` function first. It should be callable from a test with plain arguments and return a string.
3. Wrap it with `defineTool({ name, description, input, execute })`. `name` is the effective tool name (`memory_xxx` / `session_xxx`), `input` is JSON Schema. Keep the description opinionated — tell the agent when to call it and what to look for in the output.
4. Add it to `allTools` in `src/tools/index.ts`. Both plugin surfaces register from that list; no other wiring is needed.
5. Write tests for both the pure helpers **and** the integration path.
6. If the tool needs a new permission or a new agent prompt, update `src/config.ts` plus `test/config.test.ts` (V1) and `test/config-v2.test.ts` (V2).

## Publishing

Two independent distribution paths:

| Path | Workflow | Trigger | Output |
| ---- | -------- | ------- | ------ |
| npm | `.github/workflows/release.yml` | manual, pick a bump | published package (trusted publishing + provenance) |
| GitHub release | `.github/workflows/build.yml` | manual, pick a tag | `opencode-memory-plugin-<version>.tar.gz` / `.zip` for manual installs |

Neither runs on push. `dist/` and `build/` are gitignored, so a plain `git push` produces no installable artifact.

The GitHub-release payload exists because a `github:` dependency install does **not** build: the fetched repo has no `dist/`, and Bun blocks lifecycle scripts for git dependencies, so a `prepare` script can't cover for it.

### Plugin dependency resolution

`resolveRgBinary()` and `resolveRagBinary()` use `createRequire(import.meta.url)`, so the two search backends are found by walking up from the loaded module to the nearest `node_modules`. Two consequences worth knowing:

- **Bun caches module resolution per directory for the life of the process.** If a plugin is loaded before its `node_modules` exists — which is what happens when you extract an archive straight into a watched `plugins/` directory — the failed lookup is cached, and neither a plugin reload nor a `dist/node_modules` symlink clears it. Only restarting the server does. Manual installs must therefore install dependencies *before* the payload is moved into place.
- A degraded install fails quietly: `memory_search` reports no results rather than erroring. `memory_setup` is the diagnostic — it prints the resolved paths or the install guidance.

A fallback that resolves the binaries through `import.meta.dir`-relative filesystem paths would make this ordering irrelevant; the current code relies on module resolution alone.

Versions are synced into README.md automatically via `scripts/sync-version.ts`:

```bash
npm version patch    # or minor / major — triggers the version npm script
git push --follow-tags
npm publish --access public
```
