import { describe, test, expect } from "bun:test";
import {
  generateDiff,
  formatDiffWithColors,
  formatDiffSummary,
  DiffResult,
} from "./diff.js";

describe("generateDiff", () => {
  describe("no changes", () => {
    test("returns hasChanges=false when content is identical", () => {
      const content = "Line 1\nLine 2\nLine 3\n";
      const result = generateDiff(content, content);

      expect(result.hasChanges).toBe(false);
      expect(result.unified).toBe("");
      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(0);
      expect(result.hunks.length).toBe(0);
    });

    test("treats different line endings as identical", () => {
      const unix = "Line 1\nLine 2\n";
      const windows = "Line 1\r\nLine 2\r\n";

      const result = generateDiff(unix, windows);
      expect(result.hasChanges).toBe(false);
    });
  });

  describe("with changes", () => {
    test("detects line additions", () => {
      const old = "Line 1\nLine 3\n";
      const newContent = "Line 1\nLine 2\nLine 3\n";

      const result = generateDiff(old, newContent);

      expect(result.hasChanges).toBe(true);
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(0);
      expect(result.unified).toContain("+Line 2");
    });

    test("detects line deletions", () => {
      const old = "Line 1\nLine 2\nLine 3\n";
      const newContent = "Line 1\nLine 3\n";

      const result = generateDiff(old, newContent);

      expect(result.hasChanges).toBe(true);
      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(1);
      expect(result.unified).toContain("-Line 2");
    });

    test("detects line modifications", () => {
      const old = "Line 1\nLine 2\nLine 3\n";
      const newContent = "Line 1\nLine 2 modified\nLine 3\n";

      const result = generateDiff(old, newContent);

      expect(result.hasChanges).toBe(true);
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(1);
      expect(result.unified).toContain("-Line 2");
      expect(result.unified).toContain("+Line 2 modified");
    });

    test("handles multiple changes", () => {
      const old = "A\nB\nC\nD\nE\n";
      const newContent = "A modified\nB\nC\nD\nE modified\n";

      const result = generateDiff(old, newContent);

      expect(result.hasChanges).toBe(true);
      expect(result.additions).toBe(2);
      expect(result.deletions).toBe(2);
    });

    test("creates correct hunk structure", () => {
      const old = "Line 1\nLine 2\nLine 3\n";
      const newContent = "Line 1\nLine 2 modified\nLine 3\n";

      const result = generateDiff(old, newContent);

      expect(result.hunks.length).toBeGreaterThan(0);
      const hunk = result.hunks[0];
      expect(hunk.oldStart).toBeDefined();
      expect(hunk.newStart).toBeDefined();
      expect(hunk.lines).toBeDefined();
    });
  });

  describe("options", () => {
    test("uses custom labels in unified diff", () => {
      const old = "Old content\n";
      const newContent = "New content\n";

      const result = generateDiff(old, newContent, {
        oldLabel: "Version 1",
        newLabel: "Version 2",
      });

      // The oldLabel is used as the filename in the diff header
      expect(result.unified).toContain("Version 1");
    });

    test("uses default labels when not provided", () => {
      const old = "Old content\n";
      const newContent = "New content\n";

      const result = generateDiff(old, newContent);

      // Default label is "old"
      expect(result.unified).toContain("old");
    });

    test("respects context lines option", () => {
      // Create a file with many lines
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
      const old = lines.join("\n") + "\n";

      // Modify line 10
      const modifiedLines = [...lines];
      modifiedLines[9] = "Line 10 modified";
      const newContent = modifiedLines.join("\n") + "\n";

      const result = generateDiff(old, newContent, { context: 1 });

      // With context of 1, we should see fewer surrounding lines
      expect(result.hunks.length).toBe(1);
    });
  });

  describe("edge cases", () => {
    test("handles empty old content", () => {
      const result = generateDiff("", "New content\n");

      expect(result.hasChanges).toBe(true);
      expect(result.additions).toBe(1);
      expect(result.deletions).toBe(0);
    });

    test("handles empty new content", () => {
      const result = generateDiff("Old content\n", "");

      expect(result.hasChanges).toBe(true);
      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(1);
    });

    test("handles both empty", () => {
      const result = generateDiff("", "");

      expect(result.hasChanges).toBe(false);
    });

    test("handles content with special characters", () => {
      const old = "console.log('hello');\n";
      const newContent = "console.log(\"hello\");\n";

      const result = generateDiff(old, newContent);

      expect(result.hasChanges).toBe(true);
    });

    test("handles unicode content", () => {
      const old = "Hello 世界\n";
      const newContent = "Hello 世界!\n";

      const result = generateDiff(old, newContent);

      expect(result.hasChanges).toBe(true);
      expect(result.unified).toContain("世界");
    });
  });
});

describe("formatDiffWithColors", () => {
  test("returns 'No changes' when no changes", () => {
    const diff: DiffResult = {
      hasChanges: false,
      unified: "",
      additions: 0,
      deletions: 0,
      hunks: [],
    };

    expect(formatDiffWithColors(diff)).toBe("No changes");
  });

  test("colorizes additions in green", () => {
    const diff = generateDiff("Line 1\n", "Line 1\nLine 2\n");
    const colored = formatDiffWithColors(diff);

    // Green ANSI code
    expect(colored).toContain("\x1b[32m");
    expect(colored).toContain("+Line 2");
  });

  test("colorizes deletions in red", () => {
    const diff = generateDiff("Line 1\nLine 2\n", "Line 1\n");
    const colored = formatDiffWithColors(diff);

    // Red ANSI code
    expect(colored).toContain("\x1b[31m");
    expect(colored).toContain("-Line 2");
  });

  test("colorizes headers in cyan", () => {
    const diff = generateDiff("Old\n", "New\n");
    const colored = formatDiffWithColors(diff);

    // Cyan ANSI code
    expect(colored).toContain("\x1b[36m");
  });

  test("includes reset codes", () => {
    const diff = generateDiff("Old\n", "New\n");
    const colored = formatDiffWithColors(diff);

    // Reset ANSI code
    expect(colored).toContain("\x1b[0m");
  });
});

describe("formatDiffSummary", () => {
  test("returns 'No changes' when no changes", () => {
    const diff: DiffResult = {
      hasChanges: false,
      unified: "",
      additions: 0,
      deletions: 0,
      hunks: [],
    };

    expect(formatDiffSummary(diff)).toBe("No changes");
  });

  test("shows additions only", () => {
    const diff: DiffResult = {
      hasChanges: true,
      unified: "",
      additions: 5,
      deletions: 0,
      hunks: [],
    };

    expect(formatDiffSummary(diff)).toBe("+5 line(s) changed");
  });

  test("shows deletions only", () => {
    const diff: DiffResult = {
      hasChanges: true,
      unified: "",
      additions: 0,
      deletions: 3,
      hunks: [],
    };

    expect(formatDiffSummary(diff)).toBe("-3 line(s) changed");
  });

  test("shows both additions and deletions", () => {
    const diff: DiffResult = {
      hasChanges: true,
      unified: "",
      additions: 5,
      deletions: 3,
      hunks: [],
    };

    expect(formatDiffSummary(diff)).toBe("+5, -3 line(s) changed");
  });
});

describe("real-world scenarios", () => {
  test("diffs markdown heading changes", () => {
    const old = "# Title\n\nSome content\n";
    const newContent = "# Updated Title\n\nSome content\n";

    const result = generateDiff(old, newContent);

    expect(result.hasChanges).toBe(true);
    expect(result.unified).toContain("-# Title");
    expect(result.unified).toContain("+# Updated Title");
  });

  test("diffs code block changes", () => {
    const old = "```js\nconst x = 1;\n```\n";
    const newContent = "```js\nconst x = 2;\n```\n";

    const result = generateDiff(old, newContent);

    expect(result.hasChanges).toBe(true);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
  });

  test("diffs list item additions", () => {
    const old = "- Item 1\n- Item 2\n";
    const newContent = "- Item 1\n- Item 1.5\n- Item 2\n";

    const result = generateDiff(old, newContent);

    expect(result.hasChanges).toBe(true);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(0);
    expect(result.unified).toContain("+- Item 1.5");
  });

  test("diffs confluence page content changes", () => {
    const old = `# Architecture Overview

This document describes the system architecture.

## Components

- Frontend
- Backend
- Database
`;

    const newContent = `# Architecture Overview

This document describes the updated system architecture.

## Components

- Frontend (React)
- Backend (Node.js)
- Database
- Cache (Redis)
`;

    const result = generateDiff(old, newContent, {
      oldLabel: "Version 1",
      newLabel: "Version 2",
    });

    expect(result.hasChanges).toBe(true);
    expect(result.additions).toBeGreaterThan(0);
    expect(result.deletions).toBeGreaterThan(0);
    // The oldLabel is used as the filename in the diff header
    expect(result.unified).toContain("Version 1");
  });
});
