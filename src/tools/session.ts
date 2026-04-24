/**
 * Session tools: search, list, read.
 *
 * These read from the OpenCode SQLite database (WAL mode, safe to query
 * concurrently while OpenCode is running). The database path is resolved
 * lazily so tests can override it with `$OPENCODE_DB`.
 */

import { tool } from "@opencode-ai/plugin";
import { querySqlite, resolveDbPath, sqlStr } from "../lib/db";

// --- SQL builders (exported for tests) ---------------------------------

/**
 * Build an `<col> LIKE <pattern>` OR clause. When there's a single term we
 * return a bare expression; multi-term queries get parenthesized so they
 * can be composed into larger `WHERE` clauses without operator-precedence
 * surprises.
 */
export function likeOr(col: string, patterns: string[]): string {
  if (patterns.length === 0) return "0"; // always-false guard
  if (patterns.length === 1) return `${col} LIKE ${sqlStr(patterns[0])}`;
  return `(${patterns.map((p) => `${col} LIKE ${sqlStr(p)}`).join(" OR ")})`;
}

/**
 * Build a `term_hits` expression that counts how many patterns match —
 * used as a ranking signal so rows matching more terms surface first.
 */
export function termHits(col: string, patterns: string[]): string {
  if (patterns.length === 0) return "0";
  if (patterns.length === 1) return "1";
  return patterns.map((p) => `(${col} LIKE ${sqlStr(p)})`).join(" + ");
}

// --- Types returned from the DB ---------------------------------------

export interface SessionSearchRow {
  id: string;
  title: string | null;
  directory: string;
  updated: string;
  snippet: string | null;
  match_offset: number | null;
  term_hits: number;
}

export interface SessionListRow {
  id: string;
  title: string | null;
  directory: string;
  created: string;
  updated: string;
}

// --- Tools -------------------------------------------------------------

export const search = tool({
  description:
    "Search previous OpenCode sessions by keyword. Searches both session titles and message content. " +
    "Multi-term queries match sessions containing ANY search term (OR logic); sessions matching more " +
    "terms rank higher. Returns matching sessions with snippets and a match_offset you can pass to " +
    "session_read to jump directly to the relevant part of a long session.",
  args: {
    query: tool.schema.string().describe("Keyword or phrase to search for"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Max sessions to return (default 10)"),
    directory: tool.schema
      .string()
      .optional()
      .describe(
        "Filter to sessions from a specific project directory (substring match)",
      ),
  },
  async execute({ query, limit = 10, directory }, context) {
    return runSessionSearch({
      query,
      limit,
      directory,
      currentSessionId: context.sessionID,
    });
  },
});

export async function runSessionSearch(input: {
  query: string;
  limit?: number;
  directory?: string;
  currentSessionId?: string;
}): Promise<string> {
  const { query, limit = 10, directory, currentSessionId } = input;
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return "No search terms provided.";

  const patterns = terms.map((t) => `%${t}%`);
  const dirFilter = directory ? `%${directory}%` : "%";
  const db = resolveDbPath();

  // Self-exclusion is optional: tests run without a session context so the
  // "skip my own session" clause collapses to a no-op.
  const selfClause = currentSessionId
    ? `AND s.id != ${sqlStr(currentSessionId)}`
    : "";

  const titleSql = `
    SELECT s.id, s.title, s.directory,
           datetime(s.time_updated/1000,'unixepoch','localtime') AS updated,
           NULL AS snippet,
           NULL AS match_offset,
           ${termHits("s.title", patterns)} AS term_hits
    FROM session s
    WHERE ${likeOr("s.title", patterns)}
      AND s.directory LIKE ${sqlStr(dirFilter)}
      AND s.time_archived IS NULL
      ${selfClause}
    ORDER BY term_hits DESC, s.time_updated DESC
    LIMIT ${Number(limit)};`;

  // ROW_NUMBER gives the position of the match within the session so the
  // caller can pass it directly as offset= to session_read.
  const contentSql = `
    WITH ranked AS (
      SELECT p.session_id,
             json_extract(p.data,'$.text') AS text,
             ROW_NUMBER() OVER (PARTITION BY p.session_id ORDER BY p.time_created ASC) - 1 AS pos
      FROM part p
      WHERE json_extract(p.data,'$.type') = 'text'
    )
    SELECT s.id, s.title, s.directory,
           datetime(s.time_updated/1000,'unixepoch','localtime') AS updated,
           substr(r.text,1,200) AS snippet,
           r.pos AS match_offset,
           MAX(${termHits("r.text", patterns)}) AS term_hits
    FROM ranked r
    JOIN session s ON s.id = r.session_id
    WHERE ${likeOr("r.text", patterns)}
      AND s.directory LIKE ${sqlStr(dirFilter)}
      AND s.time_archived IS NULL
      ${selfClause}
    GROUP BY s.id
    ORDER BY term_hits DESC, r.pos ASC
    LIMIT ${Number(limit)};`;

  const [titleMatches, contentMatches] = await Promise.all([
    querySqlite<SessionSearchRow>(db, titleSql),
    querySqlite<SessionSearchRow>(db, contentSql),
  ]);

  // Merge, deduplicate — title matches first, attach snippet if also a content match.
  const seen = new Set<string>();
  const results: Array<SessionSearchRow & { match: string }> = [];

  for (const r of titleMatches) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      results.push({ ...r, match: "title" });
    }
  }
  for (const r of contentMatches) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      results.push({ ...r, match: "content" });
    } else {
      const existing = results.find((x) => x.id === r.id);
      if (existing) {
        existing.snippet = r.snippet;
        existing.match_offset = r.match_offset;
        existing.match = "title+content";
        existing.term_hits = Math.max(existing.term_hits, r.term_hits);
      }
    }
  }

  results.sort((a, b) => b.term_hits - a.term_hits);

  if (results.length === 0) return `No sessions found matching "${query}".`;

  const FULL_DETAIL = 3;
  const shown = results.slice(0, limit);

  const lines: string[] = [
    `## ${shown.length} session(s) matching "${query}"\n`,
  ];

  for (const [i, r] of shown.entries()) {
    if (i < FULL_DETAIL) {
      const hits =
        terms.length > 1 ? ` (${r.term_hits}/${terms.length} terms)` : "";
      lines.push(`${i + 1}. **${r.title || "(untitled)"}** [${r.match}]${hits}`);
      lines.push(`   id: ${r.id}`);
      lines.push(`   dir: ${r.directory}`);
      lines.push(`   updated: ${r.updated}`);
      if (r.snippet) {
        lines.push(
          `   snippet: ${r.snippet.replace(/\n/g, " ").slice(0, 200)}`,
        );
      }
      if (r.match_offset !== null && r.match_offset !== undefined) {
        lines.push(
          `   → \`session_read(session_id="${r.id}", offset=${r.match_offset})\``,
        );
      }
    } else {
      const offset =
        r.match_offset !== null && r.match_offset !== undefined
          ? ` (offset=${r.match_offset})`
          : "";
      lines.push(
        `${i + 1}. ${r.title || "(untitled)"} — ${r.id}${offset}`,
      );
    }
    lines.push("");
  }

  if (shown.length > 0 && shown[0].match_offset !== null) {
    lines.push(
      `_Read the top match: \`session_read(session_id="${shown[0].id}", offset=${shown[0].match_offset})\`_`,
    );
  }

  return lines.join("\n");
}

export const list = tool({
  description:
    "List OpenCode sessions ordered by most-recently-updated, optionally filtered by time range " +
    "and/or project directory. Useful for browsing recent work or finding sessions from a specific period.",
  args: {
    from: tool.schema
      .string()
      .optional()
      .describe(
        "Start of time range, inclusive (ISO 8601, e.g. '2024-01-01' or '2024-01-01T09:00:00')",
      ),
    to: tool.schema
      .string()
      .optional()
      .describe(
        "End of time range, inclusive (ISO 8601, e.g. '2024-01-31' or '2024-01-31T23:59:59')",
      ),
    directory: tool.schema
      .string()
      .optional()
      .describe(
        "Filter to sessions from a specific project directory (substring match)",
      ),
    limit: tool.schema
      .number()
      .optional()
      .describe("Max sessions to return (default 20)"),
  },
  async execute({ from, to, directory, limit = 20 }, context) {
    return runSessionList({
      from,
      to,
      directory,
      limit,
      currentSessionId: context.sessionID,
    });
  },
});

export async function runSessionList(input: {
  from?: string;
  to?: string;
  directory?: string;
  limit?: number;
  currentSessionId?: string;
}): Promise<string> {
  const { from, to, directory, limit = 20, currentSessionId } = input;
  const dirFilter = directory ? `%${directory}%` : "%";
  const db = resolveDbPath();

  const fromClause = from
    ? `AND s.time_updated >= strftime('%s', ${sqlStr(from)}) * 1000`
    : "";
  const toClause = to
    ? `AND s.time_updated <= strftime('%s', ${sqlStr(to)}) * 1000`
    : "";
  const selfClause = currentSessionId
    ? `AND s.id != ${sqlStr(currentSessionId)}`
    : "";

  const sql = `
    SELECT s.id, s.title, s.directory,
           datetime(s.time_created/1000,'unixepoch','localtime') AS created,
           datetime(s.time_updated/1000,'unixepoch','localtime') AS updated
    FROM session s
    WHERE s.directory LIKE ${sqlStr(dirFilter)}
      AND s.time_archived IS NULL
      ${selfClause}
      ${fromClause}
      ${toClause}
    ORDER BY s.time_updated DESC
    LIMIT ${Number(limit)};`;

  const rows = await querySqlite<SessionListRow>(db, sql);

  if (rows.length === 0) {
    const rangeDesc =
      from && to
        ? ` between ${from} and ${to}`
        : from
          ? ` after ${from}`
          : to
            ? ` before ${to}`
            : "";
    return `No sessions found${rangeDesc}.`;
  }

  const lines = rows.map((r) =>
    [
      r.title || "(untitled)",
      `  id:      ${r.id}`,
      `  dir:     ${r.directory}`,
      `  created: ${r.created}`,
      `  updated: ${r.updated}`,
    ].join("\n"),
  );

  return `Found ${rows.length} session(s):\n\n${lines.join("\n\n")}`;
}

export const read = tool({
  description:
    "Read the text content of a previous OpenCode session in order. Returns user and assistant text " +
    "messages. Use offset and limit to page through long sessions — session_search returns a " +
    "match_offset you can use to jump directly to relevant content.",
  args: {
    session_id: tool.schema
      .string()
      .describe("Session ID (from session_search results)"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Number of messages to return (default 30)"),
    offset: tool.schema
      .number()
      .optional()
      .describe(
        "Skip the first N text messages — use match_offset from session_search to jump to relevant content (default 0)",
      ),
    role: tool.schema
      .enum(["all", "user", "assistant"])
      .optional()
      .describe('Filter by role: "user", "assistant", or "all" (default "all")'),
  },
  async execute({ session_id, limit = 30, offset = 0, role = "all" }, context) {
    return runSessionRead({
      sessionId: session_id,
      limit,
      offset,
      role,
      currentSessionId: context.sessionID,
    });
  },
});

export async function runSessionRead(input: {
  sessionId: string;
  limit?: number;
  offset?: number;
  role?: "all" | "user" | "assistant";
  currentSessionId?: string;
}): Promise<string> {
  const {
    sessionId,
    limit = 30,
    offset = 0,
    role = "all",
    currentSessionId,
  } = input;
  if (currentSessionId && sessionId === currentSessionId) {
    return "Cannot read the current active session.";
  }

  const db = resolveDbPath();
  const roleFilter =
    role === "all" ? "" : `AND json_extract(m.data,'$.role') = ${sqlStr(role)}`;

  const metaSql = `
    SELECT title, directory FROM session
    WHERE id = ${sqlStr(sessionId)} LIMIT 1;`;

  const countSql = `
    SELECT COUNT(*) AS count
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE p.session_id = ${sqlStr(sessionId)}
      AND json_extract(p.data,'$.type') = 'text'
      ${roleFilter};`;

  const pageSql = `
    SELECT json_extract(m.data,'$.role') AS role,
           json_extract(p.data,'$.text') AS text
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE p.session_id = ${sqlStr(sessionId)}
      AND json_extract(p.data,'$.type') = 'text'
      ${roleFilter}
    ORDER BY p.time_created ASC
    LIMIT ${Number(limit)} OFFSET ${Number(offset)};`;

  type Meta = { title: string; directory: string };
  type CountRow = { count: number };
  type MsgRow = { role: string; text: string };

  const [meta, countRows, rows] = await Promise.all([
    querySqlite<Meta>(db, metaSql),
    querySqlite<CountRow>(db, countSql),
    querySqlite<MsgRow>(db, pageSql),
  ]);

  if (meta.length === 0) return `Session "${sessionId}" not found.`;

  const total = countRows[0]?.count ?? 0;

  if (rows.length === 0) {
    return offset > 0
      ? `No more messages. Session "${meta[0].title}" has ${total} text message(s) total.`
      : `Session "${meta[0].title}" has no text messages.`;
  }

  const messages = rows
    .map((r) => `[${r.role}]\n${r.text}`)
    .join("\n\n---\n\n");
  const showing = `${offset + 1}–${offset + rows.length} of ${total}`;
  const pagination =
    offset + rows.length < total
      ? `(showing ${showing} — use offset=${offset + rows.length} to continue)`
      : `(showing ${showing} — end of session)`;

  return [
    `Session: ${meta[0].title}`,
    `Directory: ${meta[0].directory}`,
    ``,
    messages,
    ``,
    pagination,
  ].join("\n");
}
