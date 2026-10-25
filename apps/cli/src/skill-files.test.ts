import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "@atlcli/core";
import { loadAuditSetup } from "./commands/audit-jira.js";
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

/** The first ```yaml fence of a Markdown text, or undefined. */
function firstYamlBlock(markdown: string): string | undefined {
  return /^```yaml\n([\s\S]*?)^```$/m.exec(markdown)?.[1];
}

describe("jira-audit.md", () => {
  // The example goes through the same read, YAML parse and validation as
  // `audit jira --rules <file>`, so a key the parser rejects or ignores fails here.
  it("has a rules-file example that audit jira accepts as written", async () => {
    const path = join(SKILL_DIR, "references", "jira-audit.md");
    const block = existsSync(path) ? firstYamlBlock(readFileSync(path, "utf8")) : undefined;
    expect(block).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "atlcli-skill-rules-"));
    try {
      const file = join(dir, "audit-rules.yaml");
      writeFileSync(file, block!);
      const { rules } = await loadAuditSetup({ name: "skill-test" } as Profile, undefined, file, null);
      expect(rules.rules["hygiene/stale"]?.thresholds?.warning).toEqual({ days: 45 });
      expect(rules.custom.map((rule) => rule.id)).toEqual(["team/bug-without-component"]);
      expect(rules.overrides[0]?.match.issueType).toEqual(["Epic"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
