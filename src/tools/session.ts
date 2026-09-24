/**
 * Session tools: search, list, read.
 *
 * The core search/read/list tools use OpenCode's SQLite database (WAL mode,
 * safe to query concurrently while OpenCode is running). `searchAll` fans out
 * to optional Pi and Codex providers as well. Paths are resolved lazily so
 * tests can override them.
 */

import { existsSync } from "node:fs";
import { z } from "zod/v4";
import { searchCodexSessions } from "../lib/codex-session-search";
import { querySqlite, resolveDbPaths, sqlStr } from "../lib/db";
import { searchPiSessions } from "../lib/pi-session-search";
import { parseSearchTerms } from "../lib/search-terms";
import { defineTool } from "../lib/tool-definition";
import {
  searchSessionProviders,
  type SessionSearchProvider,
} from "../lib/session-fanout";

// --- SQL builders (exported for tests) ---------------------------------

/**
 * Build an `<col> LIKE <pattern>` OR clause. When there's a single term we
 * return a bare expression; multi-term queries get parenthesized so they
 * can be composed into larger `WHERE` clauses without operator-precedence
 * surprises.
 */
export function likeOr(col: string, patterns: string[]): string {
  if (patterns.length === 0) return "0"; // always-false guard
  if (patterns.length === 1) return `${col} LIKE ${sqlStr(patterns[0])} ESCAPE '\\'`;
  return `(${patterns.map((p) => `${col} LIKE ${sqlStr(p)} ESCAPE '\\'`).join(" OR ")})`;
}

/**
 * Build a `term_hits` expression that counts how many patterns match —
 * used as a ranking signal so rows matching more terms surface first.
 */
export function termHits(col: string, patterns: string[]): string {
  if (patterns.length === 0) return "0";
  if (patterns.length === 1) return "1";
  return patterns.map((p) => `(${col} LIKE ${sqlStr(p)} ESCAPE '\\')`).join(" + ");
}

export function escapeLikeTerm(term: string): string {
  return term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** Count distinct query terms found in either the title or any session part. */
export function sessionTermHits(
  titleCol: string,
  sessionIdCol: string,
  partsCte: string,
  patterns: string[],
): string {
  if (patterns.length === 0) return "0";
  return patterns
    .map(
      (pattern) =>
        `(COALESCE(${titleCol} LIKE ${sqlStr(pattern)} ESCAPE '\\', 0) OR EXISTS (` +
        `SELECT 1 FROM ${partsCte} h WHERE h.session_id = ${sessionIdCol} ` +
        `AND h.text LIKE ${sqlStr(pattern)} ESCAPE '\\'))`,
    )
    .join(" + ");
}

/** Return short context centered around the earliest case-insensitive term match. */
export function centerSnippet(text: string, terms: string[], maxChars = 200): string {
  if (text.length <= maxChars) return text;
  const lower = text.toLowerCase();
  const indexes = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0);
  const earliest = indexes.length > 0 ? Math.min(...indexes) : 0;
  const start = Math.max(0, Math.min(text.length - maxChars, earliest - Math.floor(maxChars / 2)));
  const excerpt = text.slice(start, start + maxChars);
  return `${start > 0 ? "…" : ""}${excerpt}${start + maxChars < text.length ? "…" : ""}`;
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

interface SessionSearchDbRow extends Omit<SessionSearchRow, "snippet"> {
  match_text: string | null;
  title_match: number;
  content_match: number;
  part_term_hits: number | null;
  time_updated: number;
}

export interface SessionListRow {
  id: string;
  title: string | null;
  directory: string;
  created: string;
  updated: string;
  time_updated: number;
}

type Schema = "v1" | "v2";
type Source = { db: string; schema: Schema };

async function sessionSources(): Promise<Source[]> {
  const sources: Source[] = [];
  for (const db of resolveDbPaths()) {
    if (!existsSync(db)) continue;
    const tables = await querySqlite<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session','message','part','session_v2','session_message');",
    );
    const names = new Set(tables.map((row) => row.name));
    if (names.has("session_v2") && names.has("session_message")) sources.push({ db, schema: "v2" });
    if (names.has("session") && names.has("message") && names.has("part")) sources.push({ db, schema: "v1" });
  }
  return sources;
}

async function migratedSessionIds(sources: Source[]): Promise<Set<string>> {
  const ids = await Promise.all(sources.filter((source) => source.schema === "v2")
    .map((source) => querySqlite<{ id: string }>(source.db, "SELECT id FROM session_v2;")));
  return new Set(ids.flat().map((row) => row.id));
}

/** V2 stores one user text or multiple assistant content items per message. */
function rankedText(schema: Schema): string {
  if (schema === "v1") return `
    SELECT p.id AS part_id, p.session_id, json_extract(p.data,'$.text') AS text,
           json_extract(m.data,'$.role') AS role,
           ROW_NUMBER() OVER (PARTITION BY p.session_id ORDER BY p.time_created, p.id) - 1 AS pos
    FROM part p JOIN message m ON m.id = p.message_id
    WHERE json_extract(p.data,'$.type') = 'text'`;
  return `
    SELECT part_id, session_id, text, role,
           ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq, item_index, part_id) - 1 AS pos
    FROM (
      SELECT m.id || ':user' AS part_id, m.session_id, json_extract(m.data,'$.text') AS text,
             'user' AS role, m.seq, -1 AS item_index
      FROM session_message m WHERE m.type = 'user' AND json_type(m.data,'$.text') = 'text'
      UNION ALL
      SELECT m.id || ':' || item.key AS part_id, m.session_id,
             json_extract(item.value,'$.text') AS text, 'assistant' AS role,
             m.seq, CAST(item.key AS INTEGER) AS item_index
      FROM session_message m, json_each(m.data,'$.content') item
      WHERE m.type = 'assistant' AND json_extract(item.value,'$.type') = 'text'
        AND json_type(item.value,'$.text') = 'text'
    )`;
}

function preferV2<T extends { id: string }>(rows: Array<T & { schema: Schema }>): T[] {
  const byId = new Map<string, T & { schema: Schema }>();
  for (const row of rows) {
    const previous = byId.get(row.id);
    if (!previous || (previous.schema === "v1" && row.schema === "v2")) byId.set(row.id, row);
  }
  return [...byId.values()];
}

const MAX_SESSION_RESULTS = 100;
const MAX_SESSION_OFFSET = Number.MAX_SAFE_INTEGER;
const MAX_SESSION_READ_TEXT_CHARS = 16_000;

export function normalizeSessionInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function codePointSafeOffset(text: string, offset: number): number {
  const bounded = Math.max(0, Math.min(text.length, offset));
  if (bounded > 0 && bounded < text.length) {
    const current = text.charCodeAt(bounded);
    const previous = text.charCodeAt(bounded - 1);
    if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
      return bounded - 1;
    }
  }
  return bounded;
}

function sliceCodePointSafe(text: string, start: number, maxChars: number): { text: string; end: number } {
  let end = Math.min(text.length, start + maxChars);
  if (end > start && end < text.length) {
    const previous = text.charCodeAt(end - 1);
    const current = text.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) end--;
  }
  return { text: text.slice(start, end), end };
}

// --- Tools -------------------------------------------------------------

export const searchAll = defineTool({
  description:
    "Search previous OpenCode, Pi, and Codex sessions concurrently by keyword. " +
    "Unavailable or uninstalled session backends are reported without failing available searches. " +
    "Multi-term queries match sessions containing ANY search term (OR logic); sessions matching more " +
    "terms rank higher. Results are grouped by source; limit applies per source.",
  input: z.object({
    query: z.string().describe("Keyword or phrase to search for"),
    limit: z
      .number()
      .optional()
      .describe("Max sessions to return per source (default 10)"),
    directory: z
      .string()
      .optional()
      .describe(
        "Filter to sessions from a specific project directory (substring match)",
      ),
  }),
  async execute({ query, limit = 10, directory }, context) {
    return { content: await runAllSessionSearch({
      query,
      limit,
      directory,
      currentSessionId: context.sessionID,
    }) };
  },
});

export async function runAllSessionSearch(
  input: {
    query: string;
    limit?: number;
    directory?: string;
    currentSessionId?: string;
  },
  providers?: SessionSearchProvider[],
): Promise<string> {
  const trimmedQuery = input.query.trim();
  if (!trimmedQuery) return "No search terms provided.";
  const safeLimit = normalizeSessionInteger(input.limit, 10, 1, MAX_SESSION_RESULTS);
  const request = { ...input, query: trimmedQuery, limit: safeLimit };
  const activeProviders: SessionSearchProvider[] = providers ?? [
    {
      source: "OpenCode",
      search: async (providerInput) => {
        if ((await sessionSources()).length === 0) {
          throw new Error("OpenCode is not installed or has no session database");
        }
        return runSessionSearch(providerInput);
      },
    },
    { source: "Pi", search: searchPiSessions },
    { source: "Codex", search: searchCodexSessions },
  ];
  return searchSessionProviders(request, activeProviders);
}

export const search = defineTool({
  description:
    "Search previous OpenCode sessions by keyword. Searches both session titles and message content. " +
    "Multi-term queries match sessions containing ANY search term (OR logic); sessions matching more " +
    "terms rank higher. Returns matching sessions with snippets and a match_offset you can pass to " +
    "session_read to jump directly to the relevant part of a long session.",
  input: z.object({
    query: z.string().describe("Keyword or phrase to search for"),
    limit: z.number().optional().describe("Max sessions to return (default 10)"),
    directory: z
      .string()
      .optional()
      .describe("Filter to sessions from a specific project directory (substring match)"),
  }),
  async execute({ query, limit = 10, directory }, context) {
    return { content: await runSessionSearch({
      query,
      limit,
      directory,
      currentSessionId: context.sessionID,
    }) };
  },
});

export async function runSessionSearch(input: {
  query: string;
  limit?: number;
  directory?: string;
  currentSessionId?: string;
}): Promise<string> {
  const { query, limit = 10, directory, currentSessionId } = input;
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return "No search terms provided.";
  const parsedTerms = parseSearchTerms(trimmedQuery);
  const terms = parsedTerms.length > 0 ? parsedTerms : [trimmedQuery];

  const patterns = terms.map((term) => `%${escapeLikeTerm(term)}%`);
  const dirFilter = directory ? `%${directory}%` : "%";
  const sources = await sessionSources();

  // Self-exclusion is optional: tests run without a session context so the
  // "skip my own session" clause collapses to a no-op.
  const selfClause = currentSessionId
    ? `AND s.id != ${sqlStr(currentSessionId)}`
    : "";

  const safeLimit = normalizeSessionInteger(limit, 10, 1, MAX_SESSION_RESULTS);

  // `ranked` establishes the exact offset used by session_read. `matching`
  // scores each part, then `representatives` deterministically picks the part
  // matching the most distinct terms (earliest part wins ties). The outer
  // score counts each term once across the title and every message.
  const searchSql = (schema: Schema, sourceLimit: number) => `
    WITH ranked AS (
      ${rankedText(schema)}
    ),
    matching AS (
      SELECT r.*, ${termHits("r.text", patterns)} AS part_term_hits
      FROM ranked r
      WHERE ${likeOr("r.text", patterns)}
    ),
    representatives AS (
      SELECT m.*,
             ROW_NUMBER() OVER (
               PARTITION BY m.session_id
               ORDER BY m.part_term_hits DESC, m.pos ASC, m.part_id ASC
             ) AS representative_rank
      FROM matching m
    )
    SELECT s.id, s.title, s.directory, s.time_updated,
           datetime(s.time_updated/1000,'unixepoch','localtime') AS updated,
           representative.text AS match_text,
           representative.pos AS match_offset,
           representative.part_term_hits AS part_term_hits,
           ${sessionTermHits("s.title", "s.id", "ranked", patterns)} AS term_hits,
           CASE WHEN ${likeOr("s.title", patterns)} THEN 1 ELSE 0 END AS title_match,
           CASE WHEN representative.session_id IS NULL THEN 0 ELSE 1 END AS content_match
    FROM ${schema === "v2" ? "session_v2" : "session"} s
    LEFT JOIN representatives representative
      ON representative.session_id = s.id AND representative.representative_rank = 1
    WHERE (${likeOr("s.title", patterns)} OR EXISTS (
             SELECT 1 FROM matching candidate WHERE candidate.session_id = s.id
           ))
      AND s.directory LIKE ${sqlStr(dirFilter)}
      AND s.time_archived IS NULL
      ${selfClause}
    ORDER BY term_hits DESC,
             COALESCE(representative.part_term_hits, 0) DESC,
             s.time_updated DESC,
             s.id ASC
    LIMIT ${sourceLimit};`;

  const migratedIds = await migratedSessionIds(sources);
  const rows = preferV2((await Promise.all(sources.map(async ({ db, schema }) =>
    (await querySqlite<SessionSearchDbRow>(db, searchSql(schema, safeLimit + (schema === "v1" ? migratedIds.size : 0))))
      .map((row) => ({ ...row, schema })),
  ))).flat().filter((row) => row.schema === "v2" || !migratedIds.has(row.id))).sort((a, b) =>
    b.term_hits - a.term_hits ||
    (b.part_term_hits ?? 0) - (a.part_term_hits ?? 0) ||
    b.time_updated - a.time_updated || a.id.localeCompare(b.id),
  ).slice(0, safeLimit);
  const results: Array<SessionSearchRow & { match: string }> = rows.map((row) => ({
    id: row.id,
    title: row.title,
    directory: row.directory,
    updated: row.updated,
    snippet: row.match_text ? centerSnippet(row.match_text, terms) : null,
    match_offset: row.match_offset,
    term_hits: row.term_hits,
    match: row.title_match && row.content_match ? "title+content" : row.title_match ? "title" : "content",
  }));

  if (results.length === 0) return `No sessions found matching "${query}".`;

  const FULL_DETAIL = 3;
  const shown = results.slice(0, safeLimit);

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

export const list = defineTool({
  description:
    "List OpenCode sessions ordered by most-recently-updated, optionally filtered by time range " +
    "and/or project directory. Useful for browsing recent work or finding sessions from a specific period.",
  input: z.object({
    from: z
      .string()
      .optional()
      .describe(
        "Start of time range, inclusive (ISO 8601, e.g. '2024-01-01' or '2024-01-01T09:00:00')",
      ),
    to: z
      .string()
      .optional()
      .describe(
        "End of time range, inclusive (ISO 8601, e.g. '2024-01-31' or '2024-01-31T23:59:59')",
      ),
    directory: z
      .string()
      .optional()
      .describe(
        "Filter to sessions from a specific project directory (substring match)",
      ),
    limit: z
      .number()
      .optional()
      .describe("Max sessions to return (default 20)"),
  }),
  async execute({ from, to, directory, limit = 20 }, context) {
    return { content: await runSessionList({
      from,
      to,
      directory,
      limit,
      currentSessionId: context.sessionID,
    }) };
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
  const safeLimit = normalizeSessionInteger(limit, 20, 1, MAX_SESSION_RESULTS);
  const dirFilter = directory ? `%${directory}%` : "%";
  const sources = await sessionSources();

  const fromClause = from
    ? `AND s.time_updated >= strftime('%s', ${sqlStr(from)}) * 1000`
    : "";
  const toClause = to
    ? `AND s.time_updated <= strftime('%s', ${sqlStr(to)}) * 1000`
    : "";
  const selfClause = currentSessionId
    ? `AND s.id != ${sqlStr(currentSessionId)}`
    : "";

  const sql = (schema: Schema, sourceLimit: number) => `
    SELECT s.id, s.title, s.directory, s.time_updated,
           datetime(s.time_created/1000,'unixepoch','localtime') AS created,
           datetime(s.time_updated/1000,'unixepoch','localtime') AS updated
    FROM ${schema === "v2" ? "session_v2" : "session"} s
    WHERE s.directory LIKE ${sqlStr(dirFilter)}
      AND s.time_archived IS NULL
      ${selfClause}
      ${fromClause}
      ${toClause}
    ORDER BY s.time_updated DESC
    LIMIT ${sourceLimit};`;

  const migratedIds = await migratedSessionIds(sources);
  const rows = preferV2((await Promise.all(sources.map(async ({ db, schema }) =>
    (await querySqlite<SessionListRow>(db, sql(schema, safeLimit + (schema === "v1" ? migratedIds.size : 0))))
      .map((row) => ({ ...row, schema })),
  ))).flat().filter((row) => row.schema === "v2" || !migratedIds.has(row.id)))
    .sort((a, b) => b.time_updated - a.time_updated || a.id.localeCompare(b.id)).slice(0, safeLimit);

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

export const read = defineTool({
  description:
    "Read a bounded portion of a previous OpenCode session in order. Returns user and assistant text " +
    "messages, capped at about 16,000 text characters per call. Use offset and limit to page through " +
    "messages; when an individual message is truncated, reuse its offset with the returned " +
    "message_char_offset to continue without losing content. session_search returns a match_offset " +
    "you can use as offset to jump directly to relevant content.",
  input: z.object({
    session_id: z
      .string()
      .describe("Session ID (from session_search results)"),
    limit: z
      .number()
      .optional()
      .describe("Number of messages to return (default 30)"),
    offset: z
      .number()
      .optional()
      .describe(
        "Skip the first N text messages — use match_offset from session_search to jump to relevant content (default 0)",
      ),
    message_char_offset: z
      .number()
      .optional()
      .describe(
        "Character offset within the first selected message (default 0); use the continuation value returned when a message exceeds the output bound",
      ),
    role: z
      .enum(["all", "user", "assistant"])
      .optional()
      .describe('Filter by role: "user", "assistant", or "all" (default "all")'),
  }),
  async execute(
    { session_id, limit = 30, offset = 0, message_char_offset = 0, role = "all" },
    context,
  ) {
    return { content: await runSessionRead({
      sessionId: session_id,
      limit,
      offset,
      messageCharOffset: message_char_offset,
      role,
      currentSessionId: context.sessionID,
    }) };
  },
});

export async function runSessionRead(input: {
  sessionId: string;
  limit?: number;
  offset?: number;
  messageCharOffset?: number;
  role?: "all" | "user" | "assistant";
  currentSessionId?: string;
}): Promise<string> {
  const {
    sessionId,
    limit = 30,
    offset = 0,
    messageCharOffset = 0,
    role = "all",
    currentSessionId,
  } = input;
  if (currentSessionId && sessionId === currentSessionId) {
    return "Cannot read the current active session.";
  }

  const safeLimit = normalizeSessionInteger(limit, 30, 1, MAX_SESSION_RESULTS);
  const safeOffset = normalizeSessionInteger(offset, 0, 0, MAX_SESSION_OFFSET);
  const safeMessageCharOffset = normalizeSessionInteger(
    messageCharOffset,
    0,
    0,
    MAX_SESSION_OFFSET,
  );

  const sources = await sessionSources();
  const roleFilter = role === "all" ? "" : `AND role = ${sqlStr(role)}`;

  type Meta = { title: string; directory: string };
  type CountRow = { count: number };
  type MsgRow = { role: string; text: string };

  let selected: Source | undefined;
  let meta: Meta[] = [];
  // Migration retains old tables and IDs. Always use the v2 copy when present.
  for (const source of [...sources].sort((a, b) => a.schema === b.schema ? 0 : a.schema === "v2" ? -1 : 1)) {
    const found = await querySqlite<Meta>(source.db,
      `SELECT title, directory FROM ${source.schema === "v2" ? "session_v2" : "session"} WHERE id = ${sqlStr(sessionId)} LIMIT 1;`);
    if (found.length) { selected = source; meta = found; break; }
  }
  if (!selected) return `Session "${sessionId}" not found.`;

  const ranked = rankedText(selected.schema);
  const filter = `session_id = ${sqlStr(sessionId)} ${roleFilter}`;
  const [countRows, rows] = await Promise.all([
    querySqlite<CountRow>(selected.db, `WITH ranked AS (${ranked}) SELECT COUNT(*) AS count FROM ranked WHERE ${filter};`),
    querySqlite<MsgRow>(selected.db, `WITH ranked AS (${ranked}) SELECT role, text FROM ranked WHERE ${filter} ORDER BY pos LIMIT ${safeLimit} OFFSET ${safeOffset};`),
  ]);

  const total = countRows[0]?.count ?? 0;

  if (rows.length === 0) {
    return safeOffset > 0
      ? `No more messages. Session "${meta[0].title}" has ${total} text message(s) total.`
      : `Session "${meta[0].title}" has no text messages.`;
  }

  const firstText = rows[0].text ?? "";
  if (safeMessageCharOffset > firstText.length) {
    return (
      `message_char_offset ${safeMessageCharOffset} is beyond message ${safeOffset + 1} ` +
      `(${firstText.length} characters).`
    );
  }

  let remaining = MAX_SESSION_READ_TEXT_CHARS;
  let nextOffset = safeOffset;
  let nextMessageCharOffset = codePointSafeOffset(firstText, safeMessageCharOffset);
  let partialStart: number | undefined;
  const displayed: string[] = [];

  for (const [index, row] of rows.entries()) {
    const text = row.text ?? "";
    const start = index === 0 ? codePointSafeOffset(text, safeMessageCharOffset) : 0;
    if (start === text.length) {
      nextOffset = safeOffset + index + 1;
      nextMessageCharOffset = 0;
      continue;
    }
    if (remaining === 0) break;

    const excerpt = sliceCodePointSafe(text, start, remaining);
    if (excerpt.end === start) {
      // The one remaining UTF-16 code unit would split a surrogate pair.
      // Continue at this exact code-point boundary on the next call.
      nextOffset = safeOffset + index;
      nextMessageCharOffset = start;
      partialStart = start;
      break;
    }

    displayed.push(`[${row.role}]\n${excerpt.text}`);
    remaining -= excerpt.text.length;
    if (excerpt.end < text.length) {
      nextOffset = safeOffset + index;
      nextMessageCharOffset = excerpt.end;
      partialStart = start;
      break;
    }

    nextOffset = safeOffset + index + 1;
    nextMessageCharOffset = 0;
  }

  const continuation =
    nextMessageCharOffset > 0
      ? `(output limited to ${MAX_SESSION_READ_TEXT_CHARS} text characters; ` +
        `message ${nextOffset + 1} continues — use offset=${nextOffset}, ` +
        `message_char_offset=${nextMessageCharOffset} to continue)`
      : nextOffset < total
        ? `(showing ${safeOffset + 1}–${nextOffset} of ${total} — use offset=${nextOffset} to continue)`
        : `(showing ${safeOffset + 1}–${nextOffset} of ${total} — end of session)`;

  const partialDetail =
    nextMessageCharOffset > 0 && partialStart !== undefined
      ? `\n(message ${nextOffset + 1} characters ${partialStart}–${nextMessageCharOffset} shown)`
      : "";

  return [
    `Session: ${meta[0].title}`,
    `Directory: ${meta[0].directory}`,
    ``,
    displayed.join("\n\n---\n\n"),
    ``,
    `${continuation}${partialDetail}`,
  ].join("\n");
}
