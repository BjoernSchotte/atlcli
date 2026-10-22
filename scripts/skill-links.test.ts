/**
 * The agent skill under `skills/atlcli/` is self-consistent.
 *
 * Agents read the skill by following its links, either as files next to
 * `SKILL.md` or through `atlcli skill <path>`. A broken link or anchor sends an
 * agent to a file or section that does not exist, and nothing else in the build
 * notices. Installers that follow the Agent Skills layout require the
 * frontmatter `name` to equal the directory name.
 *
 * The file set comes from git (tracked plus untracked, minus ignored), not a
 * directory walk, so a new reference that is not yet added still counts while
 * editor and Finder droppings such as `.DS_Store` do not.
 */
import { describe, expect, it } from "bun:test";
import GithubSlugger from "github-slugger";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL_DIR = join(REPO_ROOT, "skills", "atlcli");

function skillFilePaths(): string[] {
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
      // `--cached` still lists a tracked file deleted from the work tree.
      .filter((path) => existsSync(join(REPO_ROOT, path)))
      .map((path) => path.slice(prefix.length)),
  );
  return [...paths].sort();
}

function readSkillFiles(): Map<string, string> {
  return new Map(skillFilePaths().map((path) => [path, readFileSync(join(SKILL_DIR, path), "utf8")]));
}

// =========================================================================
// Markdown helpers
// =========================================================================

/**
 * Calls `visit` for every line outside fenced code blocks. The skill's shell
 * examples are full of `#` comments and example links such as
 * `![Diagram](./page-name.attachments/diagram.png)`; inside a fence they are
 * neither headings nor links.
 */
function forEachProseLine(text: string, visit: (line: string) => void): void {
  let fence = "";
  for (const line of text.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!fence) fence = marker;
      else if (marker === fence) fence = "";
      continue;
    }
    if (!fence) visit(line);
  }
}

/** Heading ids as GitHub renders them, which is how agents and readers see the skill. */
function anchorsOf(text: string): Set<string> {
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  forEachProseLine(text, (line) => {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!heading) return;
    const rendered = heading[2]!
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|\*|_)/g, "");
    anchors.add(slugger.slug(rendered));
  });
  return anchors;
}

function linksOf(text: string): string[] {
  const links: string[] = [];
  forEachProseLine(text, (line) => {
    // Inline code holds example syntax such as `@[Jane Doe](accountId)`.
    const prose = line.replace(/`[^`]*`/g, "");
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) links.push(match[1]!);
  });
  return links;
}

const EXTERNAL = /^(https?:|mailto:)/;

/**
 * Every link that does not land on a file of the skill, or on a heading of that
 * file, as `from → href (reason)`. A link's path is relative to the linking
 * file's directory; an empty path is the linking file itself.
 */
function unresolvedLinks(files: Map<string, string>): string[] {
  const broken: string[] = [];
  for (const [from, text] of files) {
    for (const href of linksOf(text)) {
      if (EXTERNAL.test(href)) continue;
      const [pathPart, rawAnchor] = href.split("#", 2);
      const target = pathPart ? posix.normalize(posix.join(posix.dirname(from), pathPart)) : from;
      if (target === ".." || target.startsWith("../")) {
        broken.push(`${from} → ${href} (leaves the skill)`);
        continue;
      }
      const targetText = files.get(target);
      if (targetText === undefined) {
        broken.push(`${from} → ${href} (no such file)`);
        continue;
      }
      if (rawAnchor && !anchorsOf(targetText).has(decodeURIComponent(rawAnchor))) {
        broken.push(`${from} → ${href} (no such heading)`);
      }
    }
  }
  return broken;
}

/**
 * `atlcli skill <path>` falls back from `<path>` to `references/<path>`, so a
 * sibling link inside a reference file works as written. That fallback is only
 * unambiguous while `SKILL.md` is the only file at the root and no two files
 * under `references/` share a name.
 */
function layoutViolations(paths: string[]): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!path.includes("/")) {
      if (path !== "SKILL.md") violations.push(`${path} (only SKILL.md belongs at the root)`);
      continue;
    }
    const name = posix.basename(path);
    if (seen.has(name)) violations.push(`${path} (another file under references/ is named ${name})`);
    seen.add(name);
  }
  return violations;
}

function frontmatterField(text: string, field: string): string | undefined {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  return new RegExp(`^${field}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim();
}

// =========================================================================
// The helpers catch what they exist to catch
// =========================================================================

describe("skill link checker", () => {
  const files = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it("reports a link to a file that does not exist", () => {
    expect(unresolvedLinks(files({ "SKILL.md": "[x](references/missing.md)" }))).toEqual([
      "SKILL.md → references/missing.md (no such file)",
    ]);
  });

  it("reports an anchor that matches no heading", () => {
    expect(
      unresolvedLinks(files({ "SKILL.md": "[x](references/a.md#nope)", "references/a.md": "## Yes\n" })),
    ).toEqual(["SKILL.md → references/a.md#nope (no such heading)"]);
  });

  it("reports a link that leaves the skill directory", () => {
    expect(unresolvedLinks(files({ "references/a.md": "[x](../../README.md)" }))).toEqual([
      "references/a.md → ../../README.md (leaves the skill)",
    ]);
  });

  it("resolves a same-file anchor to a heading of the linking file", () => {
    expect(unresolvedLinks(files({ "references/a.md": "[x](#flag-grammar)\n\n## Flag grammar\n" }))).toEqual(
      [],
    );
  });

  it("reports a same-file anchor that matches no heading", () => {
    expect(unresolvedLinks(files({ "references/a.md": "[x](#missing)\n\n## Present\n" }))).toEqual([
      "references/a.md → #missing (no such heading)",
    ]);
  });

  it("resolves a sibling link relative to the linking file's directory", () => {
    expect(
      unresolvedLinks(files({ "references/a.md": "[x](b.md#two)", "references/b.md": "## Two\n" })),
    ).toEqual([]);
  });

  it("ignores links inside fenced code", () => {
    expect(unresolvedLinks(files({ "SKILL.md": "```markdown\n[x](./runbook.md)\n```\n" }))).toEqual([]);
  });

  it("ignores links inside inline code", () => {
    expect(unresolvedLinks(files({ "SKILL.md": "Write `@[Jane Doe](accountId)` for a mention." }))).toEqual([]);
  });

  it("reports a second file at the skill root", () => {
    expect(layoutViolations(["NOTES.md", "SKILL.md"])).toEqual(["NOTES.md (only SKILL.md belongs at the root)"]);
  });

  it("reports two reference files with the same name", () => {
    expect(layoutViolations(["SKILL.md", "references/a/x.md", "references/b/x.md"])).toEqual([
      "references/b/x.md (another file under references/ is named x.md)",
    ]);
  });
});

// =========================================================================
// The skill itself
// =========================================================================

describe("skills/atlcli", () => {
  it("has a SKILL.md", () => {
    expect(existsSync(join(SKILL_DIR, "SKILL.md"))).toBe(true);
  });

  it("names the skill after its directory", () => {
    expect(frontmatterField(readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"), "name")).toBe("atlcli");
  });

  it("carries the repository's license", () => {
    expect(frontmatterField(readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"), "license")).toBe("Apache-2.0");
  });

  it("uses LF line endings in every file", () => {
    const withCarriageReturns = [...readSkillFiles()].filter(([, text]) => text.includes("\r")).map(([path]) => path);
    expect(withCarriageReturns).toEqual([]);
  });

  it("points every link at a file and heading of the skill", () => {
    const broken = unresolvedLinks(readSkillFiles());
    expect(broken, `broken skill links:\n  ${broken.join("\n  ")}`).toEqual([]);
  });

  it("keeps every file name unambiguous for atlcli skill <path>", () => {
    expect(layoutViolations(skillFilePaths())).toEqual([]);
  });
});
