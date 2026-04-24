---
name: opencode-memory
description: Proactive memory usage — search ~/opencode-memory/ before starting work and save reusable discoveries when done. Load this skill at the start of ANY non-trivial task, whenever working in an unfamiliar repo, using an unfamiliar tool or API, debugging, or encountering a system you don't know. Past sessions frequently leave pointers that save 5–30 minutes of rediscovery. If in doubt, load it — the overhead is minimal.
---

# OpenCode Memory

Memory is OpenCode's **engine of self-improvement**. Every session that uses it well leaves the system more capable for the next one. It's a living index — not a mirror of data that APIs return live, but a map of _where to look_ and _what to watch out for_.

The goal isn't to save everything — it's to save what took >1 minute to figure out and that a future session would otherwise have to rediscover from scratch.

## Tools

| Tool                              | Purpose                                 |
| --------------------------------- | --------------------------------------- |
| `memory_search(query, category?)` | Hybrid keyword + semantic search        |
| `memory_list(category?)`          | Browse categories or list files         |
| `memory_save()`                   | Commit + re-index after writing/editing |
| `memory_access(path)`             | Mark a file as read & useful (bumps ranking) |
| `memory_setup()`                  | Check `rag` install status, print guidance |

Read search results with the Read tool on `~/opencode-memory/{path}`.

---

## The Session Loop

```
START  → memory_search("what I'm working on")
           Read relevant files; follow Related: pointers
           Verify mutable facts via live sources (not memory)

DURING → Save discoveries immediately when they happen
           (context is richest right after the discovery — don't defer)

END    → Run the Retrospective (see below)
```

The END step is the one sessions most often skip — and the one that compounds value over time.

---

## When to Search

- **Starting on any repo** — search its name for structure, build commands, gotchas
- **Using an unfamiliar tool or API** — a past session may have documented usage
- **Debugging** — a previous session may have solved the same root cause
- **People/team lookups** — check `people/` category, then verify live
- **Before saving** — search first to update existing files rather than duplicate

---

## When to Save (and When Not To)

The right question isn't "could I save this?" but "would a future session waste time without this?"

**Save:**

- Gotchas and non-obvious workarounds
- Repo structure: where things live, build/test/deploy incantations
- Tool quirks and undocumented behavior
- Debugging root causes that weren't obvious from the error message
- Pointers: "use X tool for Y task; watch out for Z"

**Don't save:**

- Data that a live API returns fresh every time (query it fresh)
- Copies of wiki pages or API docs
- Task-specific context that won't generalize
- Anything discoverable in <1 minute from first principles

### Quality filter — ask before writing

1. Would a future session rediscover this within 1 minute from scratch? → skip
2. Is this specific enough to act on? Vague notes don't get read
3. Is there an existing memory to update rather than a new file to create?

---

## Durable knowledge vs change-log (IMPORTANT)

Memory is not a work journal. The test: **will this still be useful 6 months from now?**

| Durable (save)                                                       | Change-log / ephemeral (don't save to memory)                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| How a system works, data flow, architecture                          | "PR #349 is in review, reviewers X/Y/Z assigned"              |
| Why a decision was made, design rationale                            | "RFC status: in discussion, ends YYYY-MM-DD"                  |
| Where code lives, build/test commands                                | "Current state (updated today): ticket switches X to Y"       |
| Non-obvious gotchas, workarounds, quirks                             | "What's done / what's needed / what's blocked this week"      |
| Conventions ("file names use author-slug", "errors extend AppError") | Sprint-level task lists and follow-up checklists              |
| Version/constraint requirements ("bun ^1.3.11 required")             | Version-at-time-of-writing ("we're on v1.4.6 as of today")    |

**Where ephemeral status belongs:** ticket tracker files, PR descriptions, session notes — NOT `~/opencode-memory/`.

### The change-log smell-test

If the file reads like a sprint update, status report, or "here's where we are on this ticket," it's change-log. Rewrite it so the **durable lesson** stays and the timestamped state is removed.

**Change-log entry (bad):**

> As of YYYY-MM-DD, PR #349 is open with reviewers X, Y, Z. RFC is in discussion status ending YYYY-MM-DD. Next step: get council approval, then create domain page.

**Same knowledge as durable memory (good):**

> RFC naming convention: during `discussion` status use `author-slug.md`; the RFC number is auto-assigned at approval. After approval, create `docs/<domain>.md` with if/then decision statements. New domains require Owner + Council approval per RFC-002.

One could be searched for years from now and still work. The other is stale in 5 days.

### Breadth is still fine

Don't let this discourage writing memory. A short file pointing at "here's the repo, here's where the tests live, here's one gotcha I hit" is valuable even if it's not deep. **Breadth + durability** beats deep-but-ephemeral. The goal is to remove change-log noise, not to raise the bar for saving useful knowledge.

---

## Retrospective (End of Session)

At the end of any non-trivial session, spend 1–2 minutes on this:

1. **What did I discover?** Anything that took >1 min to figure out → save it
2. **What memories did I use?** Were they accurate? Update stale ones
3. **What should have been in memory but wasn't?** Save it now
4. **Did the memory system fail me?** → log it in `notes/memory-system.md` (see below)

This only takes a couple of minutes and the value compounds across sessions.

---

## Verify Mutable Facts Against Live Sources

Memory goes stale. Re-query for anything that changes:

| Fact Type                       | Primary Source                     |
| ------------------------------- | ---------------------------------- |
| Service ownership, team info    | Your service catalog or wiki       |
| People, managers, org structure | Your directory / org chart         |
| Ticket status, assignments      | Your issue tracker                 |
| Pipeline status, CI/CD          | Your CI provider's API             |
| Error tracking                  | Your error tracking tool           |

**Trust without re-querying**: repo structure, code patterns, gotchas/workarounds, tool quirks — these are stable across sessions.

---

## Self-Improvement Loop

This is where memory becomes truly self-improving. The memory skill itself can get better based on what sessions learn about it.

When the system isn't working well — a memory was wrong, a search returned noise, something important wasn't saved when it should have been — add a note to `notes/memory-system.md`:

```markdown
## What's working

- Memories in `repos/` with specific gotchas → high reuse rate

## What's not working

- Searches for [topic] return noise → consider subcategories or better tags
- [Pattern] kept being rediscovered → should have been saved in [category] with tags [X]

## Patterns observed

- Sessions that save immediately after discovery > sessions that defer to end
```

**Escalation signal**: if you find yourself writing the same kind of memory repeatedly, or if a whole category of memories is never useful, that's a signal to propose updates to this SKILL.md. The skill should evolve based on what's actually useful in this environment — that's the point.

---

## Repo Notes — Path Convention

When saving notes about a repository, mirror the repo's location on the filesystem:

```
~/opencode-memory/repos/{host}/{org}/{repo}.md
```

Examples:

- `repos/github.com/user/project.md`
- `repos/gitlab.com/my-group/my-project.md`
- `repos/bitbucket.org/team/library.md`

That way a future session can find the file by searching on any fragment of the repo URL.

---

## Frontmatter (required — include provenance)

```yaml
---
title: Human-readable title
tags: [tag1, tag2]
summary: One-line summary
created: YYYY-MM-DD
updated: YYYY-MM-DD
importance: high | medium | low
source: URL or description of primary source
source_date: YYYY-MM-DD # when primary source was last consulted
related: [category/file.md]
---
```

`source` and `source_date` tell future sessions where to verify and how stale this might be.

Categories: `preferences` · `repos` · `technical` · `people` · `workflows` · `snippets` · `notes`

---

## Good Memory vs. Bad Memory

**Good** — pointer + actionable gotcha (still useful in a year):

```markdown
---
title: api-core uses custom error hierarchy
tags: [api-core, error-handling]
summary: All errors must extend AppError; throwing plain Error bypasses formatting
source: Code inspection of src/errors/ in api-core
source_date: 2025-06-15
importance: high
---

All errors in `src/errors/` must extend `AppError`. Throwing plain `Error` bypasses
error formatting → raw 500s. Gotcha: `AuthError` must include `realm` field or auth
middleware silently ignores it.
```

**Bad — data dump:**

```markdown
# Software Catalog

[200 lines copied from an API response]
```

Fix: "Use the catalog API. Gotcha: entity refs use `group:teams/` prefix for groups, not `group:default/`."

**Bad — change-log / status report:**

```markdown
## What's Done

- ✅ PR #349 open with reviewers X, Y, Z
- ✅ RFC in discussion status

## What's Needed

1. Get RFC approved (blocked on council)
2. Create domain page after approval
```

Fix: extract the durable convention and put sprint tracking in a ticket file.

**Bad — timestamped "current state" inside an architecture doc:**

```markdown
### Module Foo

**Target:** Route via new membership check.
**Current state (updated YYYY-MM-DD):** ticket-123 switches foo... PR #... in flight.
```

Fix: document the target architecture as if it's already the design. If you must note migration state, keep it one line: "Migration tracked in ticket-123." The architecture doc should not rot when the migration merges.

---

## Search Tips

- Be specific: `memory_search("retry jitter config")` not `memory_search("retry")`
- Multi-term = OR with ranking: `"oauth scopes"` surfaces files with both terms first
- Filter by category: `memory_search("api-core", category="repos")`
- Follow `Related:` pointers in results — connected knowledge is often more useful than the direct hit
- Set `importance: high` for frequently referenced knowledge; it affects ranking

---

## Installation — Search Backends

Both search backends ship as npm dependencies with prebuilt binaries:

| Backend                | Package                 | Provides the `<bin>` |
| ---------------------- | ----------------------- | -------------------- |
| **Keyword (ripgrep)**  | `@vscode/ripgrep`       | `rg`                 |
| **Semantic (rag-cli)** | `@mathew-cf/rag-cli`    | `rag`                |

No manual install is needed — `npm install` (or whatever installs this plugin) pulls in both and resolves them via `require.resolve` at runtime. Nothing depends on `$PATH`.

After install, run once to pre-cache the embedding model (optional but makes the first semantic search instant):

```bash
memory_setup   # reports which backends are resolvable
rag download   # downloads the MiniLM-L6 weights (~90MB)
```

If a backend fails to install (unsupported platform, etc.), the tools degrade gracefully — `memory_search` still returns whatever the available backend can find. Call `memory_setup` any time to see install guidance for the missing piece.
