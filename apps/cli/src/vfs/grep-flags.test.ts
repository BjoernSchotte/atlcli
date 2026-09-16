import { describe, expect, it } from "bun:test";
import { parseFindArgs, parseGrepArgs } from "./grep-flags.js";

describe("parseGrepArgs", () => {
  it("keeps explicit patterns and option terminators separate from path operands", () => {
    expect(parseGrepArgs(["-r", "-e", "word", "a", "b"]).pathIndices).toEqual([3, 4]);
    expect(parseGrepArgs(["-r", "-f", "patterns.txt", "a"]).pathIndices).toEqual([3]);
    expect(parseGrepArgs(["-r", "--", "-foo", "a"])).toMatchObject({ pattern: "-foo", paths: ["a"], pathIndices: [3] });
  });
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
