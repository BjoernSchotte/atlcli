import { describe, expect, test } from "bun:test";
import { getCompletions } from "./completions.js";

describe("wiki page diff completions", () => {
  test("offers the current version and presentation flags", () => {
    const completions = getCompletions(["wiki", "page", "diff", "--"]);

    expect(completions).toContain("--version");
    expect(completions).toContain("--from");
    expect(completions).toContain("--to");
    expect(completions).toContain("--format");
    expect(completions).toContain("--context");
    expect(completions).toContain("--no-color");
    expect(completions).toContain("--word-diff");
    expect(completions).not.toContain("--version1");
    expect(completions).not.toContain("--version2");
  });
});
