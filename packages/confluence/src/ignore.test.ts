import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadIgnorePatterns,
  parseIgnoreFile,
  shouldIgnore,
  filterIgnored,
  createIgnore,
} from "./ignore.js";

describe("parseIgnoreFile", () => {
  test("parses simple patterns", () => {
    const content = `
drafts/
*.draft.md
internal-*.md
`;
    const patterns = parseIgnoreFile(content);
    expect(patterns).toEqual(["drafts/", "*.draft.md", "internal-*.md"]);
  });

  test("ignores comments", () => {
    const content = `
# This is a comment
drafts/
# Another comment
*.draft.md
`;
    const patterns = parseIgnoreFile(content);
    expect(patterns).toEqual(["drafts/", "*.draft.md"]);
  });

  test("ignores empty lines", () => {
    const content = `

drafts/

*.draft.md

`;
    const patterns = parseIgnoreFile(content);
    expect(patterns).toEqual(["drafts/", "*.draft.md"]);
  });

  test("preserves negation patterns", () => {
    const content = `
*.md
!important.md
`;
    const patterns = parseIgnoreFile(content);
    expect(patterns).toEqual(["*.md", "!important.md"]);
  });

  test("trims whitespace", () => {
    const content = `  drafts/
   *.draft.md   `;
    const patterns = parseIgnoreFile(content);
    expect(patterns).toEqual(["drafts/", "*.draft.md"]);
  });

  test("handles empty content", () => {
    const patterns = parseIgnoreFile("");
    expect(patterns).toEqual([]);
  });

  test("handles comments only", () => {
    const content = `# Comment 1
# Comment 2`;
    const patterns = parseIgnoreFile(content);
    expect(patterns).toEqual([]);
  });
});

describe("createIgnore", () => {
  test("creates ignore instance from patterns", () => {
    const ig = createIgnore(["*.draft.md", "drafts/"]);

    expect(ig.ignores("test.draft.md")).toBe(true);
    expect(ig.ignores("drafts/file.md")).toBe(true);
    expect(ig.ignores("regular.md")).toBe(false);
  });
});

describe("shouldIgnore", () => {
  test("returns false for null ignore", () => {
    expect(shouldIgnore(null, "any/path.md")).toBe(false);
  });

  test("matches simple patterns", () => {
    const ig = createIgnore(["drafts/", "*.draft.md"]);

    expect(shouldIgnore(ig, "drafts/file.md")).toBe(true);
    expect(shouldIgnore(ig, "test.draft.md")).toBe(true);
    expect(shouldIgnore(ig, "regular.md")).toBe(false);
  });

  test("normalizes path separators", () => {
    const ig = createIgnore(["drafts/"]);

    expect(shouldIgnore(ig, "drafts\\file.md")).toBe(true);
  });

  test("removes leading ./", () => {
    const ig = createIgnore(["drafts/"]);

    expect(shouldIgnore(ig, "./drafts/file.md")).toBe(true);
  });

  test("handles wildcard patterns", () => {
    const ig = createIgnore(["internal-*.md"]);

    expect(shouldIgnore(ig, "internal-api.md")).toBe(true);
    expect(shouldIgnore(ig, "internal-docs.md")).toBe(true);
    expect(shouldIgnore(ig, "external-api.md")).toBe(false);
  });

  test("handles negation patterns", () => {
    const ig = createIgnore(["*.md", "!important.md"]);

    expect(shouldIgnore(ig, "regular.md")).toBe(true);
    expect(shouldIgnore(ig, "important.md")).toBe(false);
  });

  test("handles nested paths", () => {
    const ig = createIgnore(["docs/internal/"]);

    expect(shouldIgnore(ig, "docs/internal/file.md")).toBe(true);
    expect(shouldIgnore(ig, "docs/public/file.md")).toBe(false);
  });
});

describe("filterIgnored", () => {
  test("returns all paths for null ignore", () => {
    const paths = ["a.md", "b.md", "c.md"];
    expect(filterIgnored(null, paths)).toEqual(paths);
  });

  test("filters out ignored paths", () => {
    const ig = createIgnore(["*.draft.md", "drafts/"]);
    const paths = [
      "regular.md",
      "test.draft.md",
      "drafts/file.md",
      "docs/page.md",
    ];

    const result = filterIgnored(ig, paths);
    expect(result).toEqual(["regular.md", "docs/page.md"]);
  });

  test("preserves order", () => {
    const ig = createIgnore(["b.md"]);
    const paths = ["a.md", "b.md", "c.md"];

    const result = filterIgnored(ig, paths);
    expect(result).toEqual(["a.md", "c.md"]);
  });
});

describe("loadIgnorePatterns", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `ignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("loads default patterns when no ignore files exist", async () => {
    const result = await loadIgnorePatterns(testDir);

    expect(result.hasAtlcliIgnore).toBe(false);
    expect(result.hasGitIgnore).toBe(false);
    expect(result.patternCount).toBeGreaterThan(0);

    // Check default patterns are applied
    expect(shouldIgnore(result.ignore, ".atlcli/state.json")).toBe(true);
    expect(shouldIgnore(result.ignore, ".git/config")).toBe(true);
    expect(shouldIgnore(result.ignore, "node_modules/package/index.js")).toBe(true);
    expect(shouldIgnore(result.ignore, "file.meta.json")).toBe(true);
    expect(shouldIgnore(result.ignore, "file.base")).toBe(true);
  });

  test("loads .atlcliignore patterns", async () => {
    await writeFile(join(testDir, ".atlcliignore"), "drafts/\n*.draft.md\n");

    const result = await loadIgnorePatterns(testDir);

    expect(result.hasAtlcliIgnore).toBe(true);
    expect(result.hasGitIgnore).toBe(false);
    expect(shouldIgnore(result.ignore, "drafts/file.md")).toBe(true);
    expect(shouldIgnore(result.ignore, "test.draft.md")).toBe(true);
    expect(shouldIgnore(result.ignore, "regular.md")).toBe(false);
  });

  test("loads .gitignore patterns", async () => {
    await writeFile(join(testDir, ".gitignore"), "build/\n*.log\n");

    const result = await loadIgnorePatterns(testDir);

    expect(result.hasAtlcliIgnore).toBe(false);
    expect(result.hasGitIgnore).toBe(true);
    expect(shouldIgnore(result.ignore, "build/output.js")).toBe(true);
    expect(shouldIgnore(result.ignore, "debug.log")).toBe(true);
    expect(shouldIgnore(result.ignore, "regular.md")).toBe(false);
  });

  test("merges both .atlcliignore and .gitignore", async () => {
    await writeFile(join(testDir, ".gitignore"), "build/\n*.log\n");
    await writeFile(join(testDir, ".atlcliignore"), "drafts/\n");

    const result = await loadIgnorePatterns(testDir);

    expect(result.hasAtlcliIgnore).toBe(true);
    expect(result.hasGitIgnore).toBe(true);

    // Both patterns should be applied
    expect(shouldIgnore(result.ignore, "build/output.js")).toBe(true);
    expect(shouldIgnore(result.ignore, "debug.log")).toBe(true);
    expect(shouldIgnore(result.ignore, "drafts/file.md")).toBe(true);
    expect(shouldIgnore(result.ignore, "regular.md")).toBe(false);
  });

  test(".atlcliignore can negate .gitignore patterns", async () => {
    await writeFile(join(testDir, ".gitignore"), "*.md\n");
    await writeFile(join(testDir, ".atlcliignore"), "!important.md\n");

    const result = await loadIgnorePatterns(testDir);

    expect(shouldIgnore(result.ignore, "regular.md")).toBe(true);
    expect(shouldIgnore(result.ignore, "important.md")).toBe(false);
  });

  test("handles empty ignore files", async () => {
    await writeFile(join(testDir, ".atlcliignore"), "");
    await writeFile(join(testDir, ".gitignore"), "");

    const result = await loadIgnorePatterns(testDir);

    // Should still have default patterns
    expect(result.patternCount).toBeGreaterThan(0);
    expect(shouldIgnore(result.ignore, ".atlcli/state.json")).toBe(true);
  });

  test("handles comments-only ignore files", async () => {
    await writeFile(join(testDir, ".atlcliignore"), "# Just a comment\n# Another comment");

    const result = await loadIgnorePatterns(testDir);

    expect(result.hasAtlcliIgnore).toBe(false); // No actual patterns added
  });
});

describe("real-world scenarios", () => {
  test("typical .atlcliignore file", () => {
    const content = `
# Drafts not ready for Confluence
drafts/
*.draft.md

# Internal documentation
internal-*.md
private/

# Temporary files
*.tmp
*.bak

# Keep this even though it matches internal-*
!internal-api-docs.md
`;
    const patterns = parseIgnoreFile(content);
    const ig = createIgnore(patterns);

    expect(shouldIgnore(ig, "drafts/work-in-progress.md")).toBe(true);
    expect(shouldIgnore(ig, "architecture.draft.md")).toBe(true);
    expect(shouldIgnore(ig, "internal-notes.md")).toBe(true);
    expect(shouldIgnore(ig, "private/secrets.md")).toBe(true);
    expect(shouldIgnore(ig, "backup.tmp")).toBe(true);
    expect(shouldIgnore(ig, "old.bak")).toBe(true);
    expect(shouldIgnore(ig, "internal-api-docs.md")).toBe(false); // Negated
    expect(shouldIgnore(ig, "architecture.md")).toBe(false);
    expect(shouldIgnore(ig, "docs/public/readme.md")).toBe(false);
  });

  test("common .gitignore patterns work", () => {
    const content = `
node_modules/
.env
*.log
dist/
coverage/
.DS_Store
`;
    const patterns = parseIgnoreFile(content);
    const ig = createIgnore(patterns);

    expect(shouldIgnore(ig, "node_modules/package/index.js")).toBe(true);
    expect(shouldIgnore(ig, ".env")).toBe(true);
    expect(shouldIgnore(ig, "debug.log")).toBe(true);
    expect(shouldIgnore(ig, "dist/bundle.js")).toBe(true);
    expect(shouldIgnore(ig, "coverage/lcov.info")).toBe(true);
    expect(shouldIgnore(ig, ".DS_Store")).toBe(true);
    expect(shouldIgnore(ig, "src/index.ts")).toBe(false);
  });

  test("directory patterns match all nested contents", () => {
    const ig = createIgnore(["private/"]);

    expect(shouldIgnore(ig, "private/file.md")).toBe(true);
    expect(shouldIgnore(ig, "private/nested/deep/file.md")).toBe(true);
    expect(shouldIgnore(ig, "public/file.md")).toBe(false);
  });
});
