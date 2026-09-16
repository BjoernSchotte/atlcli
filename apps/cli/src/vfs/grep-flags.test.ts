import { describe, expect, it } from "bun:test";
import { Bash } from "just-bash";
import { matchesGrepFile, skipsGrepDirectory, parseFindArgs, parseGrepArgs } from "./grep-flags.js";

describe("parseGrepArgs", () => {
  it("keeps explicit patterns and option terminators separate from path operands", () => {
    expect(parseGrepArgs(["-r", "-e", "word", "a", "b"]).pathIndices).toEqual([3, 4]);
    expect(parseGrepArgs(["-r", "-f", "patterns.txt", "a"]).pathIndices).toEqual([3]);
    expect(parseGrepArgs(["-r", "--", "-foo", "a"])).toMatchObject({ pattern: "-foo", paths: ["a"], pathIndices: [3] });
  });
  it("normalizes explicit alternatives and bundled value flags without treating values as paths", () => {
    const parsed = parseGrepArgs(["before", "-riefoo", "-e", "bar", "--regexp=baz", "-fpatterns", "after"]);
    expect(parsed.patterns).toEqual(["foo", "bar", "baz"]);
    expect(parsed.patternFiles).toEqual(["patterns"]);
    expect(parsed.paths).toEqual(["before", "after"]);
    expect(parsed.pathIndices).toEqual([0, 6]);
    expect(parsed.normalizedArgs).toEqual(["-r", "-i", "-f", "patterns", "-e", "foo\nbar\nbaz", "--", "before", "after"]);
    expect(parsed.normalizedPathIndices.map((i) => parsed.normalizedArgs[i])).toEqual(parsed.paths);
    expect(parsed.hasUnsupportedOptions).toBe(false);
  });

  it("executes all normalized -e and -f alternatives in installed grep", async () => {
    const bash = new Bash({ defenseInDepth: false, files: { "/input": "foo\nbar\nbaz\nother\n", "/patterns": "baz\n" } });
    const parsed = parseGrepArgs(["-riefoo", "--regexp", "bar", "-f/patterns", "/input"]);
    const result = await bash.exec("grep", { args: parsed.normalizedArgs });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/input:foo\n/input:bar\n/input:baz\n");
  });

  it("matches installed grep's filter behavior", async () => {
    const bash = new Bash({ defenseInDepth: false, cwd: "/files", files: { "/files/a.md": "word", "/files/b.md": "word", "/files/!.md": "word", "/files/c.txt": "word", "/files/a+b.md": "word" } });
    for (const glob of ["*.md", "?.md", "[ab].md", "[!a].md", "a+b.md", "'*.md'"]) {
      const parsed = parseGrepArgs(["-rl", `--include=${glob}`, "word", "."]);
      const result = await bash.exec("grep", { args: parsed.normalizedArgs });
      const expected = ["a.md", "b.md", "!.md", "c.txt", "a+b.md"].filter((path) => matchesGrepFile(parsed, path)).sort();
      expect(result.stdout.trim().split("\n").filter(Boolean).sort()).toEqual(expected);
    }
  });

  it("keeps option-looking patterns and paths literal", () => {
    const parsed = parseGrepArgs(["-r", "-e", "--no-cql", "--", "-e", "--no-cql"]);
    expect(parsed.noCql).toBe(false);
    expect(parsed.patterns).toEqual(["--no-cql"]);
    expect(parsed.paths).toEqual(["-e", "--no-cql"]);
    expect(parseGrepArgs(["-r", "--", "--regexp=word", "-f"]).paths).toEqual(["-f"]);
  });

  it("recognizes flags and values after positional patterns", () => {
    const parsed = parseGrepArgs(["word", "--quiet", "--ignore-case", "-rA3", "file", "--exclude", "*.json", "--exclude-dir=archive"]);
    expect(parsed).toMatchObject({ pattern: "word", quiet: true, ignoreCase: true, recursive: true, paths: ["file"], excludes: ["*.json"], excludeDirs: ["archive"], hasUnsupportedOptions: false });
    expect(parsed.normalizedArgs).toContain("--exclude=*.json");
    expect(parseGrepArgs(["--invert-match", "word", "."]).invertMatch).toBe(true);
  });

  it("marks unknown flags and missing values for validation before IO", () => {
    for (const args of [["-rz", "word", "."], ["-re"], ["--include"], ["word", "-A", "no"], ["--quiet=yes", "word"]]) {
      expect(parseGrepArgs(args).hasUnsupportedOptions).toBe(true);
    }
    expect(parseGrepArgs(["--wat", "word", "."]).paths).toEqual(["."]);
  });

  it("filters basenames with grep's include/exclude precedence and glob semantics", () => {
    const parsed = parseGrepArgs(["-r", "--include=*.md", "--include=*.txt", "--exclude=_meta*", "--exclude-dir=arch*", "x"]);
    expect(matchesGrepFile(parsed, "/DOCSY/page/_index.md")).toBe(true);
    expect(matchesGrepFile(parsed, "/DOCSY/page/notes.txt")).toBe(true);
    expect(matchesGrepFile(parsed, "/DOCSY/page/_meta.md")).toBe(false);
    expect(matchesGrepFile(parsed, "/DOCSY/page/picture.png")).toBe(false);
    expect(skipsGrepDirectory(parsed, "archive-42")).toBe(true);
    expect(matchesGrepFile(parseGrepArgs(["--include=[!a].md", "x"]), "b.md")).toBe(false);
    expect(matchesGrepFile(parseGrepArgs(["--include=[", "x"]), "_index.md")).toBe(true);
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
