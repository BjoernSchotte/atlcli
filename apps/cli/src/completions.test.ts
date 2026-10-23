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

describe("jira completions", () => {
  test("offers the subcommands the dispatcher handles", () => {
    expect(getCompletions(["jira", "issue", ""])).toEqual(expect.arrayContaining(["link-page", "pages", "unlink-page"]));
    expect(getCompletions(["jira", "issue", "comments", ""])).toEqual(["add", "delete", "edit", "list"]);
    expect(getCompletions(["jira", "bulk", ""])).toEqual(expect.arrayContaining(["link-page", "move"]));
    expect(getCompletions(["jira", "sprint", ""])).toContain("review");
    expect(getCompletions(["jira", "version", ""])).toContain("notes");
  });

  test("offers the flags the handlers read", () => {
    const worklog = getCompletions(["jira", "worklog", "add", "--"]);
    expect(worklog).toContain("--issue");
    expect(worklog).not.toContain("--key");

    const comments = getCompletions(["jira", "issue", "comments", "delete", "--"]);
    expect(comments).toEqual(expect.arrayContaining(["--confirm", "--id", "--key"]));
    expect(comments).not.toContain("--body");

    expect(getCompletions(["jira", "bulk", "move", "--"])).toEqual(
      expect.arrayContaining(["--backlog", "--issues", "--jql", "--sprint"])
    );

    const exported = getCompletions(["jira", "export", "--"]);
    expect(exported).toContain("--no-comments");
    expect(exported).not.toContain("--comments");

    expect(getCompletions(["jira", "sprint", "add", "--"])).not.toContain("--id");
    expect(getCompletions(["audit", "jira", "--"])).toContain("--fail-on");
  });
});

test("root completion offers every root help command (#279)", async () => {
  const { ROOT_COMMANDS } = await import("./root-commands.js");
  const roots = getCompletions([""]);
  for (const [name] of ROOT_COMMANDS) expect(roots).toContain(name);
  expect(getCompletions(["re"])).toEqual(["release-info", "research"]);
});
