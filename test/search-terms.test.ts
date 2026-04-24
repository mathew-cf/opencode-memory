import { describe, expect, test } from "bun:test";
import {
  countTermMatches,
  parseSearchTerms,
  scoreCandidate,
} from "../src/lib/search-terms";

describe("parseSearchTerms", () => {
  test("splits on whitespace", () => {
    expect(parseSearchTerms("alpha beta gamma")).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  test("preserves quoted phrases as single terms", () => {
    expect(parseSearchTerms(`"event loop" alpha`)).toEqual([
      "event loop",
      "alpha",
    ]);
  });

  test("filters out stop words", () => {
    expect(parseSearchTerms("the quick and fox")).toEqual(["quick", "fox"]);
  });

  test("filters out one-character terms", () => {
    expect(parseSearchTerms("a big x tree")).toEqual(["big", "tree"]);
  });

  test("returns empty list for empty or all-filtered input", () => {
    expect(parseSearchTerms("")).toEqual([]);
    expect(parseSearchTerms("the a an")).toEqual([]);
  });

  test("preserves original casing", () => {
    expect(parseSearchTerms("SQL Query")).toEqual(["SQL", "Query"]);
  });
});

describe("countTermMatches", () => {
  test("returns 0 for empty term list", () => {
    expect(countTermMatches("hello world", [])).toBe(0);
  });

  test("counts each matching term once", () => {
    expect(countTermMatches("hello world", ["hello", "world"])).toBe(2);
    expect(countTermMatches("hello world", ["hello", "missing"])).toBe(1);
  });

  test("is case-insensitive", () => {
    expect(countTermMatches("Hello World", ["hello", "WORLD"])).toBe(2);
  });

  test("does not count the same term multiple times", () => {
    // We're asking "did this term appear at all?", not "how many times".
    expect(countTermMatches("hello hello hello", ["hello"])).toBe(1);
  });
});

describe("scoreCandidate", () => {
  test("returns 0 when no signals are present", () => {
    const score = scoreCandidate({
      rgMatch: false,
      termMatches: 0,
      totalTerms: 0,
      path: "empty.md",
      terms: [],
    });
    expect(score).toBe(0);
  });

  test("rgMatch alone produces a base score in [0.15, 0.50]", () => {
    const low = scoreCandidate({
      rgMatch: true,
      termMatches: 0,
      totalTerms: 3,
      path: "foo.md",
      terms: ["a", "b", "c"],
    });
    const high = scoreCandidate({
      rgMatch: true,
      termMatches: 3,
      totalTerms: 3,
      path: "foo.md",
      terms: ["a", "b", "c"],
    });
    expect(low).toBeGreaterThanOrEqual(0.15);
    expect(high).toBeLessThanOrEqual(0.5);
    expect(high).toBeGreaterThan(low);
  });

  test("ragScore contributes 1.4x its raw value", () => {
    const score = scoreCandidate({
      rgMatch: false,
      ragScore: 0.5,
      termMatches: 0,
      totalTerms: 0,
      path: "foo.md",
      terms: [],
    });
    expect(score).toBeCloseTo(0.7, 5);
  });

  test("hybrid bonus fires only when both signals present", () => {
    const onlyRg = scoreCandidate({
      rgMatch: true,
      termMatches: 1,
      totalTerms: 1,
      path: "foo.md",
      terms: ["alpha"],
    });
    const both = scoreCandidate({
      rgMatch: true,
      ragScore: 0.5,
      termMatches: 1,
      totalTerms: 1,
      path: "foo.md",
      terms: ["alpha"],
    });
    const expectedDiff = 0.5 * 1.4 + 0.1; // rag contribution + hybrid bonus
    expect(both - onlyRg).toBeCloseTo(expectedDiff, 5);
  });

  test("tag match contributes proportionally to term coverage", () => {
    const noTag = scoreCandidate({
      rgMatch: false,
      termMatches: 0,
      totalTerms: 2,
      path: "foo.md",
      terms: ["alpha", "beta"],
    });
    const oneTag = scoreCandidate({
      rgMatch: false,
      termMatches: 0,
      totalTerms: 2,
      path: "foo.md",
      terms: ["alpha", "beta"],
      tags: ["alpha-release"],
    });
    const bothTags = scoreCandidate({
      rgMatch: false,
      termMatches: 0,
      totalTerms: 2,
      path: "foo.md",
      terms: ["alpha", "beta"],
      tags: ["alpha-release", "beta-net"],
    });
    expect(oneTag - noTag).toBeCloseTo(0.1, 5); // 0.2 * 1/2
    expect(bothTags - noTag).toBeCloseTo(0.2, 5); // 0.2 * 2/2
  });

  test("path match contributes proportionally", () => {
    const noPath = scoreCandidate({
      rgMatch: false,
      termMatches: 0,
      totalTerms: 1,
      path: "misc.md",
      terms: ["alpha"],
    });
    const withPath = scoreCandidate({
      rgMatch: false,
      termMatches: 0,
      totalTerms: 1,
      path: "technical/alpha-release.md",
      terms: ["alpha"],
    });
    expect(withPath - noPath).toBeCloseTo(0.15, 5);
  });

  test("importance high adds 0.15, low subtracts 0.10", () => {
    const base = scoreCandidate({
      rgMatch: false,
      termMatches: 0,
      totalTerms: 0,
      path: "foo.md",
      terms: [],
    });
    const high = scoreCandidate({
      rgMatch: false,
      termMatches: 0,
      totalTerms: 0,
      path: "foo.md",
      terms: [],
      importance: "high",
    });
    const low = scoreCandidate({
      rgMatch: false,
      termMatches: 0,
      totalTerms: 0,
      path: "foo.md",
      terms: [],
      importance: "low",
    });
    expect(high - base).toBeCloseTo(0.15, 5);
    expect(low - base).toBeCloseTo(-0.1, 5);
  });

  test("access count bonuses cross thresholds at 2 and 5", () => {
    const mk = (count?: number) =>
      scoreCandidate({
        rgMatch: false,
        termMatches: 0,
        totalTerms: 0,
        path: "foo.md",
        terms: [],
        accessCount: count,
      });
    expect(mk(undefined)).toBe(0);
    expect(mk(1)).toBe(0);
    expect(mk(2)).toBeCloseTo(0.05, 5);
    expect(mk(4)).toBeCloseTo(0.05, 5);
    expect(mk(5)).toBeCloseTo(0.1, 5);
    expect(mk(999)).toBeCloseTo(0.1, 5);
  });
});
