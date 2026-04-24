/**
 * Minimal YAML frontmatter parser/updater.
 *
 * Memory files use a small, opinionated frontmatter schema (title, tags,
 * summary, importance, updated, last_accessed, access_count, related). A full
 * YAML parser would be overkill — this hand-rolled parser understands just
 * enough to feed the search ranker and update the access-tracking fields.
 *
 * Keeping it simple also means the parser behaves predictably on broken or
 * partial frontmatter: unknown keys are ignored, malformed arrays become
 * empty arrays, etc. Tests exercise those failure modes directly.
 */

export interface FrontMatter {
  title?: string;
  tags?: string[];
  summary?: string;
  importance?: string;
  updated?: string;
  related?: string[];
  last_accessed?: string;
  access_count?: number;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Split a markdown file into `{meta, body}`. If no frontmatter is present,
 * `meta` is empty and the entire input becomes `body` — callers still get
 * something usable rather than a thrown error.
 */
export function parseFrontmatter(content: string): {
  meta: FrontMatter;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { meta: {}, body: content };

  const yaml = match[1];
  const body = match[2];
  const meta: FrontMatter = {};

  for (const line of yaml.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();

    if (key === "title") meta.title = value;
    else if (key === "summary") meta.summary = value;
    else if (key === "importance") meta.importance = value;
    else if (key === "updated") meta.updated = value;
    else if (key === "last_accessed") meta.last_accessed = value;
    else if (key === "access_count") {
      const parsed = parseInt(value, 10);
      meta.access_count = Number.isFinite(parsed) ? parsed : 0;
    } else if (key === "tags" || key === "related") {
      const arr = value.match(/\[([^\]]*)\]/);
      if (arr && arr[1].trim()) {
        (meta as Record<string, unknown>)[key] = arr[1]
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean);
      } else {
        (meta as Record<string, unknown>)[key] = [];
      }
    }
  }

  return { meta, body };
}

/**
 * Update or insert the `last_accessed` and `access_count` fields in a YAML
 * block. Returns the new YAML string. The caller is responsible for gluing
 * it back onto the body with the `---` sentinels.
 *
 * Kept pure so tests can verify the exact text transformation without
 * touching the filesystem.
 */
export function bumpAccessFields(
  yaml: string,
  dateStr: string,
): { yaml: string; newCount: number } {
  const countMatch = yaml.match(/^access_count:\s*(\d+)/m);
  const currentCount = countMatch ? parseInt(countMatch[1], 10) : 0;
  const newCount = currentCount + 1;

  let updated = yaml;
  if (updated.match(/^last_accessed:/m)) {
    updated = updated.replace(/^last_accessed:.*$/m, `last_accessed: ${dateStr}`);
  } else {
    updated += `\nlast_accessed: ${dateStr}`;
  }

  if (updated.match(/^access_count:/m)) {
    updated = updated.replace(/^access_count:.*$/m, `access_count: ${newCount}`);
  } else {
    updated += `\naccess_count: ${newCount}`;
  }

  return { yaml: updated, newCount };
}

/**
 * Current date as `YYYY-MM-DD` in UTC. Exposed so tests can compare against
 * the exact string format written to memory files.
 */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
