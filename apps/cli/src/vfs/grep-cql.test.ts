import { describe, expect, it } from "bun:test";
import { planGrepCql } from "./grep-cql.js";
import { parseGrepArgs } from "./grep-flags.js";

const plan = (...args: string[]) => planGrepCql(parseGrepArgs(args));

describe("index-backed grep candidate planning", () => {
  it("unions direct terms and prefixes for words, literal phrases, Unicode, and anchors", () => {
    expect(plan("-ri", "retrospektive", ".")).toEqual({ query: '((text ~ "retrospektive" OR text ~ "retrospektive*"))' });
    expect(plan("-r", "software craftsmanship", ".")).toEqual({ query: '((text ~ "software" OR text ~ "software*") AND (text ~ "craftsmanship" OR text ~ "craftsmanship*"))' });
    expect(plan("-r", "^Äpfel Überprüfung$", ".")).toEqual({ query: '((text ~ "Äpfel" OR text ~ "Äpfel*") AND (text ~ "Überprüfung" OR text ~ "Überprüfung*"))' });
    expect(plan("-r", "retrospektive\\.foo", ".")).toEqual({ query: '((text ~ "retrospektive" OR text ~ "retrospektive*") AND (text ~ "foo" OR text ~ "foo*"))' });
  });

  it("combines alternatives with OR and each phrase with AND", () => {
    expect(plan("-r", "-e", "foo bar", "-e", "baz\nquux", ".")).toEqual({ query: '((text ~ "foo" OR text ~ "foo*") AND (text ~ "bar" OR text ~ "bar*")) OR ((text ~ "baz" OR text ~ "baz*")) OR ((text ~ "quux" OR text ~ "quux*"))' });
    expect(plan("-rE", "^foo|bar baz$", ".")).toEqual({ query: '((text ~ "foo" OR text ~ "foo*")) OR ((text ~ "bar" OR text ~ "bar*") AND (text ~ "baz" OR text ~ "baz*"))' });
    expect(plan("-rF", "foo|bar", ".")).toEqual({ query: '((text ~ "foo" OR text ~ "foo*") AND (text ~ "bar" OR text ~ "bar*"))' });
  });

  it("tokenizes fixed strings without allowing CQL syntax injection", () => {
    expect(plan("-rF", 'foo.bar " OR space = "SECRET"', ".")).toEqual({ query: '((text ~ "foo" OR text ~ "foo*") AND (text ~ "bar" OR text ~ "bar*") AND (text ~ "space" OR text ~ "space*") AND (text ~ "SECRET" OR text ~ "SECRET*"))' });
    expect(plan("-rF", "a/b-craftsmanship:foo", ".")).toEqual({ query: '((text ~ "craftsmanship" OR text ~ "craftsmanship*") AND (text ~ "foo" OR text ~ "foo*"))' });
    expect(plan("-rF", "foo foo", ".")).toEqual({ query: '((text ~ "foo" OR text ~ "foo*"))' });
  });

  it("does not infer required terms from optional or complex regex branches", () => {
    for (const pattern of ["foo.*bar", "foo?", "foo*", "(foo)?bar", "foo[ab]", "foo\\b", "foo\\|bar", "foo|a", "foo|", "foo\\", "foo{1,3}"]) {
      expect({ pattern, fallback: "reason" in plan("-rE", pattern, ".") }).toEqual({ pattern, fallback: true });
    }
  });

  it("falls back for full-file semantics, pattern files, opt-outs, and unknown flags", () => {
    for (const args of [["-rv", "foo"], ["-rc", "foo"], ["-rL", "foo"], ["-rf", "patterns"], ["--no-cql", "-r", "foo"], ["-rz", "foo"], ["-r", "--include=*.md", "foo"], ["-r", "--exclude=*.txt", "foo"], ["-r", "--exclude-dir=archive", "foo"]]) {
      expect("reason" in plan(...args)).toBe(true);
    }
    expect(plan("-r", "-e", "-c", "-e", "foo")).toHaveProperty("reason"); // -c is too short, not a count flag.
    expect(plan("-rF", "-e", "-craftsmanship")).toEqual({ query: '((text ~ "craftsmanship" OR text ~ "craftsmanship*"))' });
    expect(plan("-rq", "foo")).toHaveProperty("query");
    expect(plan("-rl", "foo")).toHaveProperty("query");
  });

  it("bounds empty, short, long, and numerous patterns", () => {
    for (const pattern of ["", "ab", "...", "a".repeat(81), Array.from({ length: 13 }, (_, i) => `word${i}`).join(" "), Array(33).fill("foo").join("\n")]) {
      expect("reason" in plan("-rF", pattern)).toBe(true);
    }
  });
});
