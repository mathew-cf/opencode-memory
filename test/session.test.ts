/**
 * Integration tests for the session_* tools.
 *
 * Builds a temp SQLite database that mirrors the schema of the real
 * opencode.db (just the columns we touch). The SQL these tools emit is
 * exercised end-to-end so we catch regressions in quoting, JOINs, and
 * pagination.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  centerSnippet,
  escapeLikeTerm,
  likeOr,
  normalizeSessionInteger,
  runSessionList,
  runSessionRead,
  runAllSessionSearch,
  runSessionSearch,
  sessionTermHits,
  termHits,
} from "../src/tools/session";
import type { SessionSearchProvider } from "../src/lib/session-fanout";
import { searchCodexSessions } from "../src/lib/codex-session-search";
import { searchPiSessions } from "../src/lib/pi-session-search";
import { sqlStr } from "../src/lib/db";

describe("sqlStr", () => {
  test("escapes embedded single quotes by doubling them", () => {
    expect(sqlStr("O'Brien")).toBe("'O''Brien'");
  });

  test("handles the empty string", () => {
    expect(sqlStr("")).toBe("''");
  });
});

describe("likeOr", () => {
  test("returns a constant-false guard for zero patterns", () => {
    expect(likeOr("col", [])).toBe("0");
  });

  test("returns a bare expression for one pattern", () => {
    expect(likeOr("col", ["%x%"])).toBe("col LIKE '%x%' ESCAPE '\\'");
  });

  test("returns a parenthesized OR for multiple patterns", () => {
    expect(likeOr("col", ["%a%", "%b%"])).toBe(
      "(col LIKE '%a%' ESCAPE '\\' OR col LIKE '%b%' ESCAPE '\\')",
    );
  });
});

describe("termHits", () => {
  test("returns 0 for empty, 1 for one term, a sum for many", () => {
    expect(termHits("col", [])).toBe("0");
    expect(termHits("col", ["%a%"])).toBe("1");
    expect(termHits("col", ["%a%", "%b%"])).toBe(
      "(col LIKE '%a%' ESCAPE '\\') + (col LIKE '%b%' ESCAPE '\\')",
    );
  });

  test("builds session-wide distinct-term checks", () => {
    const sql = sessionTermHits("s.title", "s.id", "ranked", ["%a%", "%b%"]);
    expect(sql).toContain("s.title LIKE '%a%'");
    expect(sql).toContain("h.session_id = s.id");
    expect(sql).toContain("h.text LIKE '%b%'");
  });
});

describe("escapeLikeTerm", () => {
  test("makes SQL LIKE metacharacters literal", () => {
    expect(escapeLikeTerm("50%_done\\later")).toBe("50\\%\\_done\\\\later");
  });
});

describe("centerSnippet", () => {
  test("centers around the earliest match regardless of query-term order", () => {
    const text = `${"x".repeat(130)}early${"y".repeat(80)}later${"z".repeat(80)}`;
    const snippet = centerSnippet(text, ["later", "early"], 100);
    expect(snippet).toContain("early");
    expect(snippet).not.toContain("later");
    expect(snippet.startsWith("…")).toBe(true);
  });
});

describe("normalizeSessionInteger", () => {
  test("defaults non-finite values and truncates/clamps finite values", () => {
    expect(normalizeSessionInteger(Number.NaN, 20, 1, 100)).toBe(20);
    expect(normalizeSessionInteger(Number.POSITIVE_INFINITY, 20, 1, 100)).toBe(20);
    expect(normalizeSessionInteger(-4, 20, 1, 100)).toBe(1);
    expect(normalizeSessionInteger(12.9, 20, 1, 100)).toBe(12);
    expect(normalizeSessionInteger(1_000, 20, 1, 100)).toBe(100);
  });
});

// --- Integration: temp database ---------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "opencode-memory-sessiontest-"));
const DB_PATH = join(tmp, "opencode.db");

/**
 * Build a minimal opencode-shaped SQLite database and insert a few
 * synthetic sessions/messages/parts.
 *
 * Schema notes:
 *  - `time_created` / `time_updated` are stored in **milliseconds**.
 *  - `message.data` and `part.data` are JSON blobs; we only touch the
 *    `$.role`, `$.type`, and `$.text` fields.
 */
async function initDb() {
  await Bun.$`rm -f ${DB_PATH}`.quiet();
  const schema = `
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      slug TEXT,
      title TEXT,
      directory TEXT,
      parent_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
  `;
  await Bun.$`sqlite3 ${DB_PATH} ${schema}`.quiet();

  // Milliseconds-since-epoch for a few deterministic timestamps.
  const t1 = 1_700_000_000_000; // ~2023-11-14
  const t2 = 1_700_000_100_000;
  const t3 = 1_700_000_200_000;
  const t4 = 1_700_000_300_000;

  const inserts = [
    // Session A: two text messages, neither matches our search.
    `INSERT INTO session VALUES ('ses-a','p','a','Morning chat','/tmp/projA',NULL,${t1},${t1 + 500},NULL);`,
    `INSERT INTO message VALUES ('m1','ses-a',${t1},'{"role":"user"}');`,
    `INSERT INTO part VALUES ('p1','m1','ses-a',${t1},'{"type":"text","text":"good morning"}');`,
    `INSERT INTO message VALUES ('m2','ses-a',${t1 + 100},'{"role":"assistant"}');`,
    `INSERT INTO part VALUES ('p2','m2','ses-a',${t1 + 100},'{"type":"text","text":"hello there"}');`,

    // Session B: title matches "retry", body contains "exponential".
    `INSERT INTO session VALUES ('ses-b','p','b','Retry policy notes','/tmp/projB',NULL,${t2},${t2 + 500},NULL);`,
    `INSERT INTO message VALUES ('m3','ses-b',${t2},'{"role":"user"}');`,
    `INSERT INTO part VALUES ('p3','m3','ses-b',${t2},'{"type":"text","text":"how should we retry?"}');`,
    `INSERT INTO message VALUES ('m4','ses-b',${t2 + 100},'{"role":"assistant"}');`,
    `INSERT INTO part VALUES ('p4','m4','ses-b',${t2 + 100},'{"type":"text","text":"use exponential backoff"}');`,

    // Session C: the strongest representative is its second matching part.
    `INSERT INTO session VALUES ('ses-c','p','c','Implementation','/tmp/projB',NULL,${t3},${t3 + 500},NULL);`,
    `INSERT INTO message VALUES ('m5','ses-c',${t3},'{"role":"user"}');`,
    `INSERT INTO part VALUES ('p5','m5','ses-c',${t3},'{"type":"text","text":"lets add retry"}');`,
    `INSERT INTO message VALUES ('m7','ses-c',${t3 + 100},'{"role":"assistant"}');`,
    `INSERT INTO part VALUES ('p7','m7','ses-c',${t3 + 100},'{"type":"text","text":"BEGIN-OF-LONG-PART ${"x".repeat(140)} jitter and retry end"}');`,

    // Session D: archived — should never appear.
    `INSERT INTO session VALUES ('ses-d','p','d','Archived discussion','/tmp/projB',NULL,${t4},${t4 + 500},${t4 + 600});`,
    `INSERT INTO message VALUES ('m6','ses-d',${t4},'{"role":"user"}');`,
    `INSERT INTO part VALUES ('p6','m6','ses-d',${t4},'{"type":"text","text":"this is hidden: retry jitter"}');`,

    // Archived only to keep it out of list/search fixtures; session_read can
    // still exercise continuation within one oversized historical message.
    `INSERT INTO session VALUES ('ses-long','p','long','Long message','/tmp/projLong',NULL,${t4 + 1_000},${t4 + 1_500},${t4 + 2_000});`,
    `INSERT INTO message VALUES ('m-long','ses-long',${t4 + 1_000},'{"role":"assistant"}');`,
    `INSERT INTO part VALUES ('p-long','m-long','ses-long',${t4 + 1_000},'{"type":"text","text":"${"x".repeat(15_999)}🌍tail"}');`,
  ];

  for (const sql of inserts) {
    await Bun.$`sqlite3 ${DB_PATH} ${sql}`.quiet();
  }
}

beforeAll(async () => {
  await initDb();
  process.env.OPENCODE_DB = DB_PATH;
});

afterAll(() => {
  delete process.env.OPENCODE_DB;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("runSessionList", () => {
  test("lists non-archived sessions ordered by most-recently-updated", async () => {
    const out = await runSessionList({});
    expect(out).toContain("Found 3 session(s)");

    // ses-c is most recent; ses-a is oldest. Verify ordering.
    const cIdx = out.indexOf("ses-c");
    const bIdx = out.indexOf("ses-b");
    const aIdx = out.indexOf("ses-a");
    expect(cIdx).toBeGreaterThan(-1);
    expect(cIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(aIdx);

    // Archived session D must not appear.
    expect(out).not.toContain("ses-d");
  });

  test("filters by directory substring", async () => {
    const out = await runSessionList({ directory: "projB" });
    expect(out).toContain("ses-b");
    expect(out).toContain("ses-c");
    expect(out).not.toContain("ses-a");
  });

  test("excludes the caller's current session", async () => {
    const out = await runSessionList({ currentSessionId: "ses-c" });
    expect(out).not.toContain("ses-c");
    expect(out).toContain("ses-b");
  });

  test("reports an empty range descriptively", async () => {
    // Far-future window → no results.
    const out = await runSessionList({ from: "2099-01-01" });
    expect(out).toContain("No sessions found");
    expect(out).toContain("2099-01-01");
  });

  test("normalizes and clamps list limits", async () => {
    expect(await runSessionList({ limit: Number.NaN })).toContain("Found 3 session(s)");
    expect(await runSessionList({ limit: -10 })).toContain("Found 1 session(s)");
    expect(await runSessionList({ limit: 10_000 })).toContain("Found 3 session(s)");
  });
});

describe("runSessionSearch", () => {
  test("matches by title", async () => {
    const out = await runSessionSearch({ query: "Retry" });
    expect(out).toContain("ses-b");
    // Session B has "Retry" in its title and "retry" in the body, so the
    // dedupe step combines the match into "title+content". We accept
    // either label here so the test doesn't over-pin the merging logic.
    expect(out).toMatch(/\[title(\+content)?\]/);
  });

  test("matches by content and produces a match_offset", async () => {
    const out = await runSessionSearch({ query: "exponential" });
    expect(out).toContain("ses-b");
    expect(out).toMatch(/offset=\d+/);
  });

  test("multi-term ranks more-matches higher", async () => {
    const out = await runSessionSearch({ query: "retry jitter" });
    const cIdx = out.indexOf("ses-c");
    const bIdx = out.indexOf("ses-b");
    // Session C matches both terms; Session B matches only "retry".
    expect(cIdx).toBeGreaterThan(-1);
    if (bIdx > -1) expect(cIdx).toBeLessThan(bIdx);
  });

  test("counts distinct terms across different messages session-wide", async () => {
    const out = await runSessionSearch({ query: "good hello" });
    expect(out).toContain("ses-a");
    expect(out).toContain("(2/2 terms)");
    expect(out).toContain('session_read(session_id="ses-a", offset=0)');
  });

  test("uses the best matching part and centers its snippet on the earliest match", async () => {
    const out = await runSessionSearch({ query: "retry jitter" });
    expect(out).toContain('session_read(session_id="ses-c", offset=1)');
    expect(out).toContain("jitter and retry");
  });

  test("archived sessions are excluded from search", async () => {
    const out = await runSessionSearch({ query: "jitter" });
    expect(out).not.toContain("ses-d");
  });

  test("preserves literal fallback searches filtered by the memory term parser", async () => {
    expect(await runSessionSearch({ query: "C" })).toContain("session(s) matching");
    expect(await runSessionSearch({ query: "the" })).toContain("ses-a");
  });

  test("treats SQL LIKE metacharacters literally", async () => {
    expect(await runSessionSearch({ query: "retry_" })).toContain('No sessions found matching "retry_"');
    expect(await runSessionSearch({ query: "retry%" })).toContain('No sessions found matching "retry%"');
  });

  test("normalizes invalid and oversized limits", async () => {
    expect(await runSessionSearch({ query: "retry", limit: Number.NaN })).toContain("session(s) matching");
    expect(await runSessionSearch({ query: "retry", limit: -1 })).toContain("1 session(s) matching");
    expect(await runSessionSearch({ query: "retry", limit: 10_000 })).toContain("session(s) matching");
  });

  test("returns a friendly message for empty query", async () => {
    const out = await runSessionSearch({ query: "   " });
    expect(out).toContain("No search terms");
  });

  test("returns a friendly message when nothing matches", async () => {
    const out = await runSessionSearch({ query: "unicorn" });
    expect(out).toContain('No sessions found matching "unicorn"');
  });
});

describe("unified session search", () => {
  test("starts OpenCode, Pi, and Codex searches concurrently", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const providers = (["OpenCode", "Pi", "Codex"] as const).map((source): SessionSearchProvider => ({
      source,
      search: async () => {
        started.push(source);
        await new Promise<void>((resolve) => releases.set(source, resolve));
        return `${source} result`;
      },
    }));

    const pending = runAllSessionSearch({ query: "retry" }, providers);
    await Promise.resolve();
    expect(started).toEqual(["OpenCode", "Pi", "Codex"]);
    for (const release of releases.values()) release();

    const output = await pending;
    expect(output).toContain("### OpenCode\n\nOpenCode result");
    expect(output).toContain("### Pi\n\nPi result");
    expect(output).toContain("### Codex\n\nCodex result");
  });

  test("keeps successful results when another harness is unavailable", async () => {
    const providers: SessionSearchProvider[] = [
      { source: "OpenCode", search: async () => "OpenCode result" },
      { source: "Pi", search: async () => { throw new Error("Pi is not installed"); } },
      { source: "Codex", search: async () => "Codex result" },
    ];

    const output = await runAllSessionSearch({ query: "retry" }, providers);
    expect(output).toContain("OpenCode result");
    expect(output).toContain("Codex result");
    expect(output).toContain("Unavailable sources: Pi: Pi is not installed");
  });

  test("isolates a provider that throws before returning a promise", async () => {
    const providers: SessionSearchProvider[] = [
      { source: "OpenCode", search: (() => { throw new Error("OpenCode unavailable"); }) as SessionSearchProvider["search"] },
      { source: "Pi", search: async () => "Pi result" },
      { source: "Codex", search: async () => "Codex result" },
    ];

    const output = await runAllSessionSearch({ query: "retry" }, providers);
    expect(output).toContain("Pi result");
    expect(output).toContain("Codex result");
    expect(output).toContain("Unavailable sources: OpenCode: OpenCode unavailable");
  });

  test("searches Pi JSONL history", async () => {
    const root = join(tmp, "pi-sessions");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "fixture.jsonl"), [
      JSON.stringify({ type: "session", id: "pi-fixture", cwd: "/tmp/proj", timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "investigate retry jitter" } }),
      JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "use exponential backoff" }] } }),
    ].join("\n"));
    const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = root;
    try {
      const output = await searchPiSessions({ query: "retry jitter", directory: "proj", limit: 5 });
      expect(output).toContain("pi-fixture");
      expect(output).toContain("(2/2 terms)");
      expect(output).toContain("investigate retry jitter");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    }
  });

  test("reports a missing Codex executable without crashing other callers", async () => {
    const previous = process.env.CODEX_SESSION_TOOLS_CLI;
    process.env.CODEX_SESSION_TOOLS_CLI = join(tmp, "missing-codex");
    try {
      await expect(searchCodexSessions({ query: "retry", limit: 5 })).rejects.toThrow(
        "Codex is not installed or is not on PATH",
      );
    } finally {
      if (previous === undefined) delete process.env.CODEX_SESSION_TOOLS_CLI;
      else process.env.CODEX_SESSION_TOOLS_CLI = previous;
    }
  });
});

describe("runSessionRead", () => {
  test("returns all text messages by default", async () => {
    const out = await runSessionRead({ sessionId: "ses-a" });
    expect(out).toContain("Session: Morning chat");
    expect(out).toContain("[user]");
    expect(out).toContain("good morning");
    expect(out).toContain("[assistant]");
    expect(out).toContain("hello there");
    expect(out).toContain("1–2 of 2");
    expect(out).toContain("end of session");
  });

  test("filters by role", async () => {
    const out = await runSessionRead({ sessionId: "ses-a", role: "user" });
    expect(out).toContain("good morning");
    expect(out).not.toContain("hello there");
  });

  test("paginates with offset", async () => {
    const out = await runSessionRead({
      sessionId: "ses-a",
      offset: 1,
      limit: 1,
    });
    expect(out).toContain("hello there");
    expect(out).not.toContain("good morning");
  });

  test("normalizes and clamps read limit and offset", async () => {
    const clamped = await runSessionRead({ sessionId: "ses-a", limit: -5, offset: -20 });
    expect(clamped).toContain("good morning");
    expect(clamped).not.toContain("hello there");
    expect(clamped).toContain("use offset=1 to continue");

    const defaults = await runSessionRead({
      sessionId: "ses-a",
      limit: Number.NaN,
      offset: Number.POSITIVE_INFINITY,
    });
    expect(defaults).toContain("good morning");
    expect(defaults).toContain("hello there");
  });

  test("bounds oversized messages and continues at a UTF-safe character offset", async () => {
    const first = await runSessionRead({ sessionId: "ses-long" });
    expect(first.length).toBeLessThan(16_500);
    expect(first).not.toContain("🌍");
    expect(first).not.toContain("�");
    expect(first).toContain("message_char_offset=15999");

    const continuation = await runSessionRead({
      sessionId: "ses-long",
      offset: 0,
      messageCharOffset: 15_999,
    });
    expect(continuation).toContain("🌍tail");
    expect(continuation).not.toContain("�");
    expect(continuation).toContain("end of session");

    // An offset in the middle of the surrogate pair is moved back to its
    // code-point boundary rather than emitting U+FFFD or dropping content.
    const unsafeInput = await runSessionRead({
      sessionId: "ses-long",
      messageCharOffset: 16_000,
    });
    expect(unsafeInput).toContain("🌍tail");
    expect(unsafeInput).not.toContain("�");
  });

  test("reports when session is missing", async () => {
    const out = await runSessionRead({ sessionId: "ses-missing" });
    expect(out).toContain('not found');
  });

  test("refuses to read the current session", async () => {
    const out = await runSessionRead({
      sessionId: "ses-a",
      currentSessionId: "ses-a",
    });
    expect(out).toContain("Cannot read the current active session");
  });

  test("reports 'no more messages' when past the end", async () => {
    const out = await runSessionRead({ sessionId: "ses-a", offset: 99 });
    expect(out).toContain("No more messages");
  });

  test("handles single-quoted session IDs safely (SQL injection guard)", async () => {
    // Not an injection, but validates sqlStr() is correctly applied.
    const out = await runSessionRead({ sessionId: "ses-a' OR 1=1--" });
    expect(out).toContain("not found");
  });
});
