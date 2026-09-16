import { describe, expect, it } from "bun:test";
import { cqlForPattern, qualifiesForCqlShortcut } from "./cql-guard.js";
import { parseFindArgs, parseGrepArgs } from "./grep-flags.js";

describe("the CQL guard", () => {
  it("accepts a whole word the caller marked with -w", () => {
    const verdict = qualifiesForCqlShortcut("kubernetes", { wordMatch: true });
    expect(verdict.qualifies).toBe(true);
    expect(verdict.literal).toBe("kubernetes");
  });

  it("accepts an explicitly anchored pattern and strips the anchors", () => {
    const verdict = qualifiesForCqlShortcut(String.raw`\bkubernetes\b`);
    expect(verdict.qualifies).toBe(true);
    expect(verdict.literal).toBe("kubernetes");
  });

  /**
   * The regression that rewrote this guard. "kubern" passes every syntactic
   * condition decision 12 lists, and `text ~ "kubern"` matches nothing while
   * grep matches every page containing "kubernetes".
   */
  it("refuses a bare literal, because grep matches substrings and CQL does not", () => {
    for (const pattern of ["kubernetes", "kubern", "ubernet"]) {
      const verdict = qualifiesForCqlShortcut(pattern);
      expect(verdict.qualifies).toBe(false);
      expect(verdict.reason).toContain("whole word");
    }
  });

  it("refuses regex metacharacters even when marked as a word", () => {
    const verdict = qualifiesForCqlShortcut("kube.*", { wordMatch: true });
    expect(verdict.qualifies).toBe(false);
    expect(verdict.reason).toContain("metacharacters");
  });

  it("allows a metacharacter under -F, which makes it a literal", () => {
    expect(
      qualifiesForCqlShortcut("kube", { wordMatch: true, fixedString: true }).qualifies,
    ).toBe(true);
  });

  it("refuses a pattern shorter than three characters", () => {
    const verdict = qualifiesForCqlShortcut("on", { wordMatch: true });
    expect(verdict.qualifies).toBe(false);
    expect(verdict.reason).toContain("three characters");
  });

  it("refuses separators, which the index tokenizes differently", () => {
    for (const pattern of ["container-platform", "container_platform", "a.b", "x/y", "a@b"]) {
      const verdict = qualifiesForCqlShortcut(pattern, { wordMatch: true, fixedString: true });
      expect(verdict.qualifies).toBe(false);
    }
  });

  it("refuses whitespace", () => {
    expect(qualifiesForCqlShortcut("two words", { wordMatch: true }).qualifies).toBe(false);
  });

  it("accepts letters and digits from any script", () => {
    expect(qualifiesForCqlShortcut("größe", { wordMatch: true }).qualifies).toBe(true);
    expect(qualifiesForCqlShortcut("日本語", { wordMatch: true }).qualifies).toBe(true);
    expect(qualifiesForCqlShortcut("abc123", { wordMatch: true }).qualifies).toBe(true);
  });
});

describe("cqlForPattern", () => {
  it("scopes to the space and escapes quotes", () => {
    expect(cqlForPattern("DOCSY", "kubernetes")).toBe(
      'space = "DOCSY" AND type = page AND text ~ "kubernetes"',
    );
    expect(cqlForPattern("DOCSY", 'say"hi')).toContain('say\\"hi');
  });
});

describe("parseGrepArgs", () => {
  it("reads the pattern and the paths", () => {
    const parsed = parseGrepArgs(["kubernetes", "."]);
    expect(parsed.pattern).toBe("kubernetes");
    expect(parsed.paths).toEqual(["."]);
  });

  it("splits a flag bundle into its letters", () => {
    const parsed = parseGrepArgs(["-rlnwiEF", "x", "."]);
    expect(parsed).toMatchObject({
      recursive: true,
      filesWithMatches: true,
      lineNumbers: true,
      wordMatch: true,
      ignoreCase: true,
      extendedRegex: true,
      fixedString: true,
    });
  });

  it("treats -R as recursive", () => {
    expect(parseGrepArgs(["-R", "x", "."]).recursive).toBe(true);
  });

  it("reads --include in both spellings and forwards it", () => {
    expect(parseGrepArgs(["--include=*.md", "x", "."]).include).toBe("*.md");
    const spaced = parseGrepArgs(["--include", "*.md", "x", "."]);
    expect(spaced.include).toBe("*.md");
    expect(spaced.passthrough).toEqual(["--include", "*.md"]);
  });

  it("consumes --no-cql without passing it on to grep", () => {
    const parsed = parseGrepArgs(["--no-cql", "-r", "x", "."]);
    expect(parsed.noCql).toBe(true);
    expect(parsed.passthrough).not.toContain("--no-cql");
    expect(parsed.pattern).toBe("x");
  });

  it("forwards a flag it does not understand, with its value", () => {
    const parsed = parseGrepArgs(["-A", "3", "--color", "x", "."]);
    expect(parsed.passthrough).toEqual(["-A", "3", "--color"]);
    expect(parsed.pattern).toBe("x");
  });
});

describe("parseFindArgs", () => {
  it("reads the index-answerable predicates", () => {
    const parsed = parseFindArgs([".", "-name", "*.md", "-type", "f"]);
    expect(parsed).toMatchObject({ paths: ["."], name: "*.md", type: "f" });
    expect(parsed.hasUnsupportedPredicate).toBe(false);
  });

  it("recognises the time predicates that go through CQL", () => {
    expect(parseFindArgs([".", "-mtime", "-7"]).timePredicate).toEqual({
      kind: "mtime",
      value: "-7",
    });
    expect(parseFindArgs([".", "-newermt", "2026-09-01"]).timePredicate?.kind).toBe("newermt");
  });

  it("flags a predicate it cannot answer from the index", () => {
    expect(parseFindArgs([".", "-size", "+1k"]).hasUnsupportedPredicate).toBe(true);
    expect(parseFindArgs([".", "-exec", "rm", "{}", ";"]).hasUnsupportedPredicate).toBe(true);
  });

  it("does not flag the harmless structural predicates", () => {
    expect(parseFindArgs([".", "-maxdepth", "2", "-print"]).hasUnsupportedPredicate).toBe(false);
  });
});
