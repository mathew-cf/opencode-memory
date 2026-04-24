/**
 * Integration tests for the session_* tools.
 *
 * Builds a temp SQLite database that mirrors the schema of the real
 * opencode.db (just the columns we touch). The SQL these tools emit is
 * exercised end-to-end so we catch regressions in quoting, JOINs, and
 * pagination.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  likeOr,
  runSessionList,
  runSessionRead,
  runSessionSearch,
  termHits,
} from "../src/tools/session";
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
    expect(likeOr("col", ["%x%"])).toBe("col LIKE '%x%'");
  });

  test("returns a parenthesized OR for multiple patterns", () => {
    expect(likeOr("col", ["%a%", "%b%"])).toBe(
      "(col LIKE '%a%' OR col LIKE '%b%')",
    );
  });
});

describe("termHits", () => {
  test("returns 0 for empty, 1 for one term, a sum for many", () => {
    expect(termHits("col", [])).toBe("0");
    expect(termHits("col", ["%a%"])).toBe("1");
    expect(termHits("col", ["%a%", "%b%"])).toBe(
      "(col LIKE '%a%') + (col LIKE '%b%')",
    );
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

    // Session C: body mentions both "retry" and "jitter" — should rank first for multi-term queries.
    `INSERT INTO session VALUES ('ses-c','p','c','Implementation','/tmp/projB',NULL,${t3},${t3 + 500},NULL);`,
    `INSERT INTO message VALUES ('m5','ses-c',${t3},'{"role":"user"}');`,
    `INSERT INTO part VALUES ('p5','m5','ses-c',${t3},'{"type":"text","text":"lets add retry with jitter"}');`,

    // Session D: archived — should never appear.
    `INSERT INTO session VALUES ('ses-d','p','d','Archived discussion','/tmp/projB',NULL,${t4},${t4 + 500},${t4 + 600});`,
    `INSERT INTO message VALUES ('m6','ses-d',${t4},'{"role":"user"}');`,
    `INSERT INTO part VALUES ('p6','m6','ses-d',${t4},'{"type":"text","text":"this is hidden: retry jitter"}');`,
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

  test("archived sessions are excluded from search", async () => {
    const out = await runSessionSearch({ query: "jitter" });
    expect(out).not.toContain("ses-d");
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
