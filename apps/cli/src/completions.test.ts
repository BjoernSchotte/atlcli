import { describe, expect, test } from "bun:test";
import { getCompletions } from "./completions.js";
import { SKILL_FILES } from "./skill-files.js";

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

describe("skill completions", () => {
  test("offers the skill command at the root", () => {
    expect(getCompletions([""])).toContain("skill");
  });

  test("offers every file of the skill as the path", () => {
    expect(getCompletions(["skill", ""])).toEqual(SKILL_FILES.map((file) => file.path));
  });

  test("completes a partial reference path", () => {
    const completions = getCompletions(["skill", "references/s"]);
    expect(completions).toEqual(["references/safety.md"]);
  });

  test("offers the skill flags", () => {
    const completions = getCompletions(["skill", "--"]);
    expect(completions).toContain("--install");
    expect(completions).toContain("--list");
  });
});
