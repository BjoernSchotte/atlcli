import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findSkillFile, SKILL_FILES } from "./skill-files.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SKILL_DIR = join(REPO_ROOT, "skills", "atlcli");

/**
 * The skill's files as git sees them: tracked plus untracked, minus ignored. A
 * reference added to `skills/atlcli/` but not to the manifest fails the
 * comparison even before it is committed; `.DS_Store` and editor files do not.
 */
function skillFilePathsOnDisk(): string[] {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "skills/atlcli"],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  const prefix = "skills/atlcli/";
  const paths = new Set(
    listed.stdout
      .toString()
      .split("\0")
      .filter((path) => path.startsWith(prefix))
      .filter((path) => existsSync(join(REPO_ROOT, path)))
      .map((path) => path.slice(prefix.length)),
  );
  return [...paths].sort();
}

describe("embedded skill", () => {
  it("embeds exactly the files under skills/atlcli", () => {
    expect(SKILL_FILES.map((file) => file.path).sort()).toEqual(skillFilePathsOnDisk());
  });

  it("embeds each file with its content on disk", () => {
    const differing = SKILL_FILES.filter(
      (file) => file.content !== readFileSync(join(SKILL_DIR, file.path), "utf8"),
    ).map((file) => file.path);
    expect(SKILL_FILES.length).toBeGreaterThan(0);
    expect(differing).toEqual([]);
  });

  it("lists SKILL.md first, then the references in order", () => {
    const paths = SKILL_FILES.map((file) => file.path);
    expect(paths[0]).toBe("SKILL.md");
    expect(paths.slice(1)).toEqual([...paths.slice(1)].sort());
  });
});

describe("findSkillFile", () => {
  it("finds SKILL.md", () => {
    expect(findSkillFile("SKILL.md")?.path).toBe("SKILL.md");
  });

  it("finds a reference by the path SKILL.md links it with", () => {
    expect(findSkillFile("references/safety.md")?.path).toBe("references/safety.md");
  });

  it("ignores the anchor of a link", () => {
    expect(findSkillFile("references/invocation.md#flag-grammar")?.path).toBe("references/invocation.md");
  });

  it("finds a reference by a sibling link inside another reference", () => {
    expect(findSkillFile("safety.md")?.path).toBe("references/safety.md");
  });

  it("finds a reference by a sibling link with an anchor", () => {
    expect(findSkillFile("jira-issues.md#transitions")?.path).toBe("references/jira-issues.md");
  });

  it("does not find a file the skill lacks", () => {
    expect(findSkillFile("references/nope.md")).toBeUndefined();
  });

  it("does not normalise other path forms", () => {
    expect(findSkillFile("./SKILL.md")).toBeUndefined();
  });
});
