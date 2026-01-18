import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  validateFile,
  validateDirectory,
  validateMacros,
  validateFolders,
  formatValidationReport,
  type ValidationResult,
} from "./validation.js";
import type { AtlcliState } from "./atlcli-dir.js";

const TEST_DIR = "/tmp/validation-test";

describe("validateFile", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("reports broken link when target file does not exist", () => {
    const filePath = join(TEST_DIR, "page.md");
    writeFileSync(filePath, "Check [missing](./nonexistent.md) link.");

    const result = validateFile(filePath, "Check [missing](./nonexistent.md) link.", null, TEST_DIR);

    expect(result.hasErrors).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      severity: "error",
      code: "LINK_FILE_NOT_FOUND",
      line: 1,
    });
    expect(result.issues[0].message).toContain("./nonexistent.md");
  });

  test("passes when target file exists", () => {
    const filePath = join(TEST_DIR, "page.md");
    const targetPath = join(TEST_DIR, "target.md");
    writeFileSync(filePath, "Check [exists](./target.md) link.");
    writeFileSync(targetPath, "# Target");

    const result = validateFile(filePath, "Check [exists](./target.md) link.", null, TEST_DIR);

    expect(result.hasErrors).toBe(false);
    expect(result.issues.filter((i) => i.code === "LINK_FILE_NOT_FOUND")).toHaveLength(0);
  });

  test("warns when target file is untracked", () => {
    const filePath = join(TEST_DIR, "page.md");
    const targetPath = join(TEST_DIR, "untracked.md");
    writeFileSync(filePath, "Check [untracked](./untracked.md) link.");
    writeFileSync(targetPath, "# Untracked");

    // Create state with empty pathIndex
    const state: AtlcliState = {
      schemaVersion: 1,
      lastSync: null,
      pages: {},
      pathIndex: {},
    };

    const result = validateFile(filePath, "Check [untracked](./untracked.md) link.", state, TEST_DIR);

    expect(result.hasWarnings).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      severity: "warning",
      code: "LINK_UNTRACKED_PAGE",
    });
  });

  test("passes when target file is tracked", () => {
    const filePath = join(TEST_DIR, "page.md");
    const targetPath = join(TEST_DIR, "tracked.md");
    writeFileSync(filePath, "Check [tracked](./tracked.md) link.");
    writeFileSync(targetPath, "# Tracked");

    // Create state with tracked page
    const state: AtlcliState = {
      schemaVersion: 1,
      lastSync: null,
      pages: {
        "123": {
          path: "tracked.md",
          title: "Tracked",
          spaceKey: "TEST",
          version: 1,
          lastSyncedAt: new Date().toISOString(),
          localHash: "",
          remoteHash: "",
          baseHash: "",
          syncState: "synced",
          parentId: null,
          ancestors: [],
        },
      },
      pathIndex: {
        "tracked.md": "123",
      },
    };

    const result = validateFile(filePath, "Check [tracked](./tracked.md) link.", state, TEST_DIR);

    expect(result.hasWarnings).toBe(false);
    expect(result.hasErrors).toBe(false);
  });

  test("ignores external links", () => {
    const filePath = join(TEST_DIR, "page.md");
    writeFileSync(filePath, "Check [external](https://example.com) link.");

    const result = validateFile(filePath, "Check [external](https://example.com) link.", null, TEST_DIR);

    expect(result.issues.filter((i) => i.code.startsWith("LINK_"))).toHaveLength(0);
  });

  test("ignores anchor-only links", () => {
    const filePath = join(TEST_DIR, "page.md");
    writeFileSync(filePath, "Check [anchor](#section) link.");

    const result = validateFile(filePath, "Check [anchor](#section) link.", null, TEST_DIR);

    expect(result.issues.filter((i) => i.code.startsWith("LINK_"))).toHaveLength(0);
  });

  test("warns when page size exceeds limit", () => {
    const filePath = join(TEST_DIR, "page.md");
    const largeContent = "x".repeat(600 * 1024); // 600KB
    writeFileSync(filePath, largeContent);

    const result = validateFile(filePath, largeContent, null, TEST_DIR, {
      checkBrokenLinks: false,
      maxPageSizeKb: 500,
    });

    expect(result.hasWarnings).toBe(true);
    expect(result.issues[0]).toMatchObject({
      severity: "warning",
      code: "PAGE_SIZE_EXCEEDED",
    });
  });
});

describe("validateMacros", () => {
  test("reports unclosed macro", () => {
    const content = `# Title

:::info
This macro is not closed.

Some more text.`;

    const issues = validateMacros(content, "test.md");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "error",
      code: "MACRO_UNCLOSED",
      line: 3,
    });
    expect(issues[0].message).toContain(":::info");
  });

  test("passes for properly closed macros", () => {
    const content = `# Title

:::info
This macro is properly closed.
:::

More text.`;

    const issues = validateMacros(content, "test.md");

    expect(issues).toHaveLength(0);
  });

  test("handles nested macros", () => {
    const content = `:::info
Outer macro
:::note
Inner macro
:::
:::`;

    const issues = validateMacros(content, "test.md");

    expect(issues).toHaveLength(0);
  });

  test("reports unexpected close without open", () => {
    const content = `# Title

:::

Some text.`;

    const issues = validateMacros(content, "test.md");

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("Unexpected macro close");
  });

  test("reports multiple unclosed macros", () => {
    const content = `:::info
First unclosed

:::warning
Second unclosed`;

    const issues = validateMacros(content, "test.md");

    expect(issues).toHaveLength(2);
  });
});

describe("validateDirectory", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("validates all markdown files in directory", async () => {
    writeFileSync(join(TEST_DIR, "good.md"), "# Good page");
    writeFileSync(join(TEST_DIR, "bad.md"), "[broken](./missing.md)");

    const result = await validateDirectory(TEST_DIR, null, TEST_DIR);

    expect(result.filesChecked).toBe(2);
    expect(result.totalErrors).toBe(1);
    expect(result.passed).toBe(false);
  });

  test("validates files in subdirectories", async () => {
    mkdirSync(join(TEST_DIR, "sub"), { recursive: true });
    writeFileSync(join(TEST_DIR, "root.md"), "# Root");
    writeFileSync(join(TEST_DIR, "sub", "nested.md"), "[broken](./missing.md)");

    const result = await validateDirectory(TEST_DIR, null, TEST_DIR);

    expect(result.filesChecked).toBe(2);
    expect(result.totalErrors).toBe(1);
  });

  test("skips hidden directories", async () => {
    mkdirSync(join(TEST_DIR, ".hidden"), { recursive: true });
    writeFileSync(join(TEST_DIR, "visible.md"), "# Visible");
    writeFileSync(join(TEST_DIR, ".hidden", "hidden.md"), "[broken](./missing.md)");

    const result = await validateDirectory(TEST_DIR, null, TEST_DIR);

    expect(result.filesChecked).toBe(1);
    expect(result.totalErrors).toBe(0);
  });

  test("skips node_modules", async () => {
    mkdirSync(join(TEST_DIR, "node_modules"), { recursive: true });
    writeFileSync(join(TEST_DIR, "app.md"), "# App");
    writeFileSync(join(TEST_DIR, "node_modules", "pkg.md"), "[broken](./missing.md)");

    const result = await validateDirectory(TEST_DIR, null, TEST_DIR);

    expect(result.filesChecked).toBe(1);
  });

  test("validates single file when path is file", async () => {
    const filePath = join(TEST_DIR, "single.md");
    writeFileSync(filePath, "[broken](./missing.md)");

    const result = await validateDirectory(filePath, null, TEST_DIR);

    expect(result.filesChecked).toBe(1);
    expect(result.totalErrors).toBe(1);
  });

  test("reports passed: true when no errors", async () => {
    writeFileSync(join(TEST_DIR, "good.md"), "# Good page\n\n[link](https://example.com)");

    const result = await validateDirectory(TEST_DIR, null, TEST_DIR);

    expect(result.passed).toBe(true);
  });
});

describe("formatValidationReport", () => {
  test("formats report with issues", () => {
    const result: ValidationResult = {
      filesChecked: 3,
      totalErrors: 1,
      totalWarnings: 1,
      passed: false,
      files: [
        {
          path: "good.md",
          issues: [],
          hasErrors: false,
          hasWarnings: false,
        },
        {
          path: "bad.md",
          issues: [
            {
              severity: "error",
              code: "LINK_FILE_NOT_FOUND",
              message: 'Broken link to "./missing.md"',
              file: "bad.md",
              line: 5,
            },
            {
              severity: "warning",
              code: "LINK_UNTRACKED_PAGE",
              message: 'Link to untracked page "./new.md"',
              file: "bad.md",
              line: 10,
            },
          ],
          hasErrors: true,
          hasWarnings: true,
        },
      ],
    };

    const report = formatValidationReport(result);

    expect(report).toContain("Checking 3 files...");
    expect(report).toContain("bad.md");
    expect(report).toContain("line 5: ERROR");
    expect(report).toContain("line 10: WARNING");
    expect(report).toContain("1 error");
    expect(report).toContain("1 warning");
    expect(report).toContain("1 file");
    expect(report).toContain("2 passed");
  });

  test("formats report with no issues", () => {
    const result: ValidationResult = {
      filesChecked: 5,
      totalErrors: 0,
      totalWarnings: 0,
      passed: true,
      files: [],
    };

    const report = formatValidationReport(result);

    expect(report).toContain("0 errors");
    expect(report).toContain("0 warnings");
    expect(report).toContain("5 passed");
  });
});

describe("validateFolders", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("detects empty folder", () => {
    // Create folder with just index.md (no children)
    mkdirSync(join(TEST_DIR, "empty-folder"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "empty-folder", "index.md"),
      `---
atlcli:
  id: "123"
  title: "Empty Folder"
  type: "folder"
---

`
    );

    const issues = validateFolders(TEST_DIR);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "warning",
      code: "FOLDER_EMPTY",
    });
    expect(issues[0].message).toContain("Empty Folder");
  });

  test("no warning for folder with children", () => {
    // Create folder with index.md and a child page
    mkdirSync(join(TEST_DIR, "populated-folder"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "populated-folder", "index.md"),
      `---
atlcli:
  id: "123"
  title: "Populated Folder"
  type: "folder"
---

`
    );
    writeFileSync(
      join(TEST_DIR, "populated-folder", "child.md"),
      `---
atlcli:
  id: "456"
  title: "Child Page"
---

# Child Page
`
    );

    const issues = validateFolders(TEST_DIR);

    expect(issues.filter((i) => i.code === "FOLDER_EMPTY")).toHaveLength(0);
  });

  test("no warning for folder with subdirectories", () => {
    // Create folder with index.md and a subdirectory
    mkdirSync(join(TEST_DIR, "parent-folder", "sub-folder"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "parent-folder", "index.md"),
      `---
atlcli:
  id: "123"
  title: "Parent Folder"
  type: "folder"
---

`
    );
    writeFileSync(
      join(TEST_DIR, "parent-folder", "sub-folder", "index.md"),
      `---
atlcli:
  id: "456"
  title: "Sub Folder"
  type: "folder"
---

`
    );

    const issues = validateFolders(TEST_DIR);

    // Parent folder has child (sub-folder), so no FOLDER_EMPTY
    // Sub folder is empty, so one FOLDER_EMPTY
    const emptyIssues = issues.filter((i) => i.code === "FOLDER_EMPTY");
    expect(emptyIssues).toHaveLength(1);
    expect(emptyIssues[0].message).toContain("Sub Folder");
  });

  test("detects directory without index.md", () => {
    // Create directory with pages but no index.md
    mkdirSync(join(TEST_DIR, "orphan-dir"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "orphan-dir", "page.md"),
      `---
atlcli:
  id: "123"
  title: "Orphan Page"
---

# Orphan Page
`
    );

    const issues = validateFolders(TEST_DIR);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "warning",
      code: "FOLDER_MISSING_INDEX",
    });
    expect(issues[0].message).toContain("orphan-dir");
  });

  test("no warning when directory has index.md", () => {
    // Create directory with index.md and pages
    mkdirSync(join(TEST_DIR, "proper-folder"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "proper-folder", "index.md"),
      `---
atlcli:
  id: "123"
  title: "Proper Folder"
  type: "folder"
---

`
    );
    writeFileSync(
      join(TEST_DIR, "proper-folder", "page.md"),
      `---
atlcli:
  id: "456"
  title: "Child Page"
---

# Child Page
`
    );

    const issues = validateFolders(TEST_DIR);

    expect(issues.filter((i) => i.code === "FOLDER_MISSING_INDEX")).toHaveLength(0);
  });

  test("ignores root directory pages", () => {
    // Pages at root level don't need an index.md
    writeFileSync(
      join(TEST_DIR, "root-page.md"),
      `---
atlcli:
  id: "123"
  title: "Root Page"
---

# Root Page
`
    );

    const issues = validateFolders(TEST_DIR);

    expect(issues.filter((i) => i.code === "FOLDER_MISSING_INDEX")).toHaveLength(0);
  });

  test("ignores non-folder index.md", () => {
    // index.md without type: folder should not be checked for children
    mkdirSync(join(TEST_DIR, "not-folder"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "not-folder", "index.md"),
      `---
atlcli:
  id: "123"
  title: "Not A Folder"
---

# Not A Folder
`
    );

    const issues = validateFolders(TEST_DIR);

    expect(issues.filter((i) => i.code === "FOLDER_EMPTY")).toHaveLength(0);
  });
});
