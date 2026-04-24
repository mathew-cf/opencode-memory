import { describe, expect, test } from "bun:test";
import {
  bumpAccessFields,
  parseFrontmatter,
  todayISO,
} from "../src/lib/frontmatter";

describe("parseFrontmatter", () => {
  test("returns empty meta when no frontmatter is present", () => {
    const { meta, body } = parseFrontmatter("just body text");
    expect(meta).toEqual({});
    expect(body).toBe("just body text");
  });

  test("parses scalar fields", () => {
    const content = `---
title: Hello
summary: A greeting
importance: high
updated: 2025-01-15
---
body`;
    const { meta, body } = parseFrontmatter(content);
    expect(meta.title).toBe("Hello");
    expect(meta.summary).toBe("A greeting");
    expect(meta.importance).toBe("high");
    expect(meta.updated).toBe("2025-01-15");
    expect(body).toBe("body");
  });

  test("parses array fields (tags, related)", () => {
    const content = `---
title: X
tags: [alpha, beta, gamma]
related: [repos/foo.md, technical/bar.md]
---
body`;
    const { meta } = parseFrontmatter(content);
    expect(meta.tags).toEqual(["alpha", "beta", "gamma"]);
    expect(meta.related).toEqual(["repos/foo.md", "technical/bar.md"]);
  });

  test("returns empty array for empty brackets", () => {
    const content = `---
title: X
tags: []
---
body`;
    const { meta } = parseFrontmatter(content);
    expect(meta.tags).toEqual([]);
  });

  test("parses access_count as integer, defaulting to 0 on bad input", () => {
    const ok = parseFrontmatter(`---
access_count: 42
---
body`).meta;
    expect(ok.access_count).toBe(42);

    const bad = parseFrontmatter(`---
access_count: not-a-number
---
body`).meta;
    // `parseInt("not-a-number", 10)` → NaN → falls back to 0.
    expect(bad.access_count).toBe(0);
  });

  test("ignores unknown keys", () => {
    const { meta } = parseFrontmatter(`---
title: X
random_field: whatever
---
body`);
    expect(meta.title).toBe("X");
    expect((meta as Record<string, unknown>).random_field).toBeUndefined();
  });

  test("handles body with multiple --- separators after frontmatter", () => {
    const content = `---
title: X
---

Some body

---
more body
`;
    const { meta, body } = parseFrontmatter(content);
    expect(meta.title).toBe("X");
    expect(body).toContain("Some body");
    expect(body).toContain("more body");
  });

  test("handles missing trailing newline", () => {
    const content = `---
title: X
---body`;
    const { meta, body } = parseFrontmatter(content);
    expect(meta.title).toBe("X");
    expect(body).toBe("body");
  });
});

describe("bumpAccessFields", () => {
  test("inserts both fields when neither is present", () => {
    const input = "title: X";
    const { yaml, newCount } = bumpAccessFields(input, "2025-01-15");
    expect(newCount).toBe(1);
    expect(yaml).toContain("last_accessed: 2025-01-15");
    expect(yaml).toContain("access_count: 1");
  });

  test("updates last_accessed in place and increments count", () => {
    const input = `title: X
last_accessed: 2024-12-01
access_count: 5`;
    const { yaml, newCount } = bumpAccessFields(input, "2025-01-15");
    expect(newCount).toBe(6);
    expect(yaml).toContain("last_accessed: 2025-01-15");
    expect(yaml).toContain("access_count: 6");
    expect(yaml).not.toContain("2024-12-01");
    expect(yaml).not.toContain("access_count: 5");
  });

  test("only appends the missing field", () => {
    const input = `title: X
access_count: 3`;
    const { yaml, newCount } = bumpAccessFields(input, "2025-01-15");
    expect(newCount).toBe(4);
    expect(yaml).toContain("last_accessed: 2025-01-15");
    expect(yaml).toContain("access_count: 4");
  });
});

describe("todayISO", () => {
  test("returns YYYY-MM-DD format", () => {
    const s = todayISO();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.length).toBe(10);
  });
});
