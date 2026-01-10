import { describe, test, expect } from "bun:test";
import {
  threeWayMerge,
  hasConflictMarkers,
  parseConflictMarkers,
  resolveConflicts,
} from "./merge.js";

describe("threeWayMerge", () => {
  describe("no conflicts", () => {
    test("returns local when local and remote are identical", () => {
      const base = "Line 1\nLine 2\n";
      const local = "Line 1\nLine 2 modified\n";
      const remote = "Line 1\nLine 2 modified\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.conflictCount).toBe(0);
    });

    test("returns remote when only remote changed", () => {
      const base = "Line 1\nLine 2\n";
      const local = "Line 1\nLine 2\n";
      const remote = "Line 1\nLine 2 modified\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).toContain("Line 2 modified");
    });

    test("returns local when only local changed", () => {
      const base = "Line 1\nLine 2\n";
      const local = "Line 1 modified\nLine 2\n";
      const remote = "Line 1\nLine 2\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).toContain("Line 1 modified");
    });

    test("merges non-overlapping changes", () => {
      const base = "Line 1\nLine 2\nLine 3\n";
      const local = "Line 1 local\nLine 2\nLine 3\n";
      const remote = "Line 1\nLine 2\nLine 3 remote\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).toContain("Line 1 local");
      expect(result.content).toContain("Line 3 remote");
    });

    test("handles additions at different locations", () => {
      const base = "Line 1\nLine 3\n";
      const local = "Line 0\nLine 1\nLine 3\n";
      const remote = "Line 1\nLine 3\nLine 4\n";

      const result = threeWayMerge(base, local, remote);
      // This may or may not be a clean merge depending on algorithm
      expect(result.conflictCount).toBe(0);
    });
  });

  describe("with conflicts", () => {
    test("detects conflict when both change same line", () => {
      const base = "Line 1\nLine 2\nLine 3\n";
      const local = "Line 1\nLine 2 local\nLine 3\n";
      const remote = "Line 1\nLine 2 remote\nLine 3\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(false);
      expect(result.conflictCount).toBeGreaterThan(0);
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain("=======");
      expect(result.content).toContain(">>>>>>> REMOTE");
    });

    test("includes both versions in conflict markers", () => {
      const base = "Same\n";
      const local = "Local change\n";
      const remote = "Remote change\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.content).toContain("Local change");
      expect(result.content).toContain("Remote change");
    });

    test("reports conflict regions", () => {
      const base = "Line 1\n";
      const local = "Local\n";
      const remote = "Remote\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts[0].localLines).toContain("Local");
      expect(result.conflicts[0].remoteLines).toContain("Remote");
    });
  });

  describe("edge cases", () => {
    test("handles empty base", () => {
      const base = "";
      const local = "New content\n";
      const remote = "New content\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
    });

    test("handles identical content", () => {
      const content = "Same content\n";

      const result = threeWayMerge(content, content, content);
      expect(result.success).toBe(true);
      expect(result.conflictCount).toBe(0);
    });

    test("handles whitespace differences", () => {
      const base = "Line 1\nLine 2\n";
      const local = "Line 1  \nLine 2\n"; // trailing spaces
      const remote = "Line 1\nLine 2\n";

      const result = threeWayMerge(base, local, remote);
      // Normalization should handle this
      expect(result.success).toBe(true);
    });
  });
});

describe("hasConflictMarkers", () => {
  test("returns true when all markers present", () => {
    const content = `
Some text
<<<<<<< LOCAL
local content
=======
remote content
>>>>>>> REMOTE
More text
`;
    expect(hasConflictMarkers(content)).toBe(true);
  });

  test("returns false when no markers", () => {
    const content = "Normal content without conflicts";
    expect(hasConflictMarkers(content)).toBe(false);
  });

  test("returns false when only partial markers", () => {
    const content = "<<<<<<< LOCAL\nNo other markers";
    expect(hasConflictMarkers(content)).toBe(false);
  });
});

describe("parseConflictMarkers", () => {
  test("parses single conflict region", () => {
    const content = `Before
<<<<<<< LOCAL
local line
=======
remote line
>>>>>>> REMOTE
After`;

    const conflicts = parseConflictMarkers(content);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].localLines).toContain("local line");
    expect(conflicts[0].remoteLines).toContain("remote line");
  });

  test("parses multiple conflict regions", () => {
    const content = `
<<<<<<< LOCAL
first local
=======
first remote
>>>>>>> REMOTE
middle
<<<<<<< LOCAL
second local
=======
second remote
>>>>>>> REMOTE
`;

    const conflicts = parseConflictMarkers(content);
    expect(conflicts.length).toBe(2);
  });

  test("handles multi-line conflicts", () => {
    const content = `<<<<<<< LOCAL
line 1
line 2
=======
line a
line b
>>>>>>> REMOTE`;

    const conflicts = parseConflictMarkers(content);
    expect(conflicts[0].localLines.length).toBe(2);
    expect(conflicts[0].remoteLines.length).toBe(2);
  });

  test("returns empty array when no conflicts", () => {
    const content = "No conflicts here";
    const conflicts = parseConflictMarkers(content);
    expect(conflicts.length).toBe(0);
  });
});

describe("resolveConflicts", () => {
  test("resolves to local version", () => {
    const content = `Before
<<<<<<< LOCAL
local content
=======
remote content
>>>>>>> REMOTE
After`;

    const resolved = resolveConflicts(content, "local");
    expect(resolved).toContain("Before");
    expect(resolved).toContain("local content");
    expect(resolved).toContain("After");
    expect(resolved).not.toContain("remote content");
    expect(resolved).not.toContain("<<<<<<<");
  });

  test("resolves to remote version", () => {
    const content = `Before
<<<<<<< LOCAL
local content
=======
remote content
>>>>>>> REMOTE
After`;

    const resolved = resolveConflicts(content, "remote");
    expect(resolved).toContain("Before");
    expect(resolved).toContain("remote content");
    expect(resolved).toContain("After");
    expect(resolved).not.toContain("local content");
    expect(resolved).not.toContain("<<<<<<<");
  });

  test("resolves multiple conflicts", () => {
    const content = `<<<<<<< LOCAL
first local
=======
first remote
>>>>>>> REMOTE
middle
<<<<<<< LOCAL
second local
=======
second remote
>>>>>>> REMOTE`;

    const resolved = resolveConflicts(content, "local");
    expect(resolved).toContain("first local");
    expect(resolved).toContain("second local");
    expect(resolved).not.toContain("first remote");
  });

  test("preserves content outside conflicts", () => {
    const content = `Line 1
<<<<<<< LOCAL
conflict
=======
other
>>>>>>> REMOTE
Line 2`;

    const resolved = resolveConflicts(content, "local");
    expect(resolved).toContain("Line 1");
    expect(resolved).toContain("Line 2");
  });
});

describe("threeWayMerge - additional edge cases", () => {
  describe("deletion scenarios", () => {
    test("local deletes line, remote unchanged", () => {
      const base = "Line 1\nLine 2\nLine 3\n";
      const local = "Line 1\nLine 3\n";
      const remote = "Line 1\nLine 2\nLine 3\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).not.toContain("Line 2");
    });

    test("remote deletes line, local unchanged", () => {
      const base = "Line 1\nLine 2\nLine 3\n";
      const local = "Line 1\nLine 2\nLine 3\n";
      const remote = "Line 1\nLine 3\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).not.toContain("Line 2");
    });

    test("both delete same line", () => {
      const base = "Line 1\nLine 2\nLine 3\n";
      const local = "Line 1\nLine 3\n";
      const remote = "Line 1\nLine 3\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).not.toContain("Line 2");
    });

    test("conflict: local deletes, remote modifies", () => {
      const base = "Line 1\nLine 2\nLine 3\n";
      const local = "Line 1\nLine 3\n";
      const remote = "Line 1\nLine 2 modified\nLine 3\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(false);
      expect(result.conflictCount).toBeGreaterThan(0);
    });

    test("conflict: local modifies, remote deletes", () => {
      const base = "Line 1\nLine 2\nLine 3\n";
      const local = "Line 1\nLine 2 modified\nLine 3\n";
      const remote = "Line 1\nLine 3\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(false);
      expect(result.conflictCount).toBeGreaterThan(0);
    });
  });

  describe("insertion scenarios", () => {
    test("local adds lines at beginning", () => {
      const base = "Line 1\nLine 2\n";
      const local = "New first\nLine 1\nLine 2\n";
      const remote = "Line 1\nLine 2\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).toContain("New first");
    });

    test("remote adds lines at end", () => {
      const base = "Line 1\nLine 2\n";
      const local = "Line 1\nLine 2\n";
      const remote = "Line 1\nLine 2\nNew last\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).toContain("New last");
    });

    test("both add same lines at same location", () => {
      const base = "Line 1\nLine 2\n";
      const local = "Line 1\nNew middle\nLine 2\n";
      const remote = "Line 1\nNew middle\nLine 2\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      // Should only have one copy of "New middle"
      const count = (result.content.match(/New middle/g) || []).length;
      expect(count).toBe(1);
    });

    test("conflict: both add different lines at same location", () => {
      const base = "Line 1\nLine 3\n";
      const local = "Line 1\nLocal insert\nLine 3\n";
      const remote = "Line 1\nRemote insert\nLine 3\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(false);
      expect(result.content).toContain("Local insert");
      expect(result.content).toContain("Remote insert");
    });
  });

  describe("real-world markdown scenarios", () => {
    test("merges heading changes with body changes", () => {
      const base = "# Title\n\nParagraph 1\n\nParagraph 2\n";
      const local = "# Updated Title\n\nParagraph 1\n\nParagraph 2\n";
      const remote = "# Title\n\nParagraph 1\n\nParagraph 2 with edits\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).toContain("Updated Title");
      expect(result.content).toContain("Paragraph 2 with edits");
    });

    test("merges list item additions", () => {
      const base = "- Item 1\n- Item 2\n";
      const local = "- Item 1\n- Item 1.5\n- Item 2\n";
      const remote = "- Item 1\n- Item 2\n- Item 3\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).toContain("Item 1.5");
      expect(result.content).toContain("Item 3");
    });

    test("handles code block changes independently", () => {
      const base = "Text before\n\n```js\ncode();\n```\n\nText after\n";
      const local = "Text before updated\n\n```js\ncode();\n```\n\nText after\n";
      const remote = "Text before\n\n```js\nupdatedCode();\n```\n\nText after\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).toContain("Text before updated");
      expect(result.content).toContain("updatedCode()");
    });
  });

  describe("complex scenarios", () => {
    test("handles multiple non-overlapping changes", () => {
      const base = "A\nB\nC\nD\nE\n";
      const local = "A modified\nB\nC\nD\nE modified\n";
      const remote = "A\nB modified\nC\nD modified\nE\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).toContain("A modified");
      expect(result.content).toContain("B modified");
      expect(result.content).toContain("D modified");
      expect(result.content).toContain("E modified");
    });

    test("handles complete content replacement on both sides", () => {
      const base = "Old content\n";
      const local = "Completely new local\n";
      const remote = "Completely new remote\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(false);
      expect(result.conflictCount).toBeGreaterThan(0);
    });

    test("handles empty lines correctly", () => {
      const base = "Line 1\n\nLine 3\n";
      const local = "Line 1\n\nLine 3 modified\n";
      const remote = "Line 1\n\nLine 3\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content).toContain("Line 3 modified");
    });

    test("handles trailing newlines consistently", () => {
      const base = "Content";
      const local = "Content\n";
      const remote = "Content";

      const result = threeWayMerge(base, local, remote);
      // Should succeed since normalization handles this
      expect(result.success).toBe(true);
    });
  });

  describe("empty content edge cases", () => {
    test("both change empty base to same content", () => {
      const base = "";
      const local = "Same new content\n";
      const remote = "Same new content\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
    });

    test("conflict: both change empty base to different content", () => {
      const base = "";
      const local = "Local new content\n";
      const remote = "Remote new content\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(false);
    });

    test("local empties content, remote unchanged", () => {
      const base = "Original content\n";
      const local = "";
      const remote = "Original content\n";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      // Local deleted everything, remote unchanged, so local wins
      expect(result.content.trim()).toBe("");
    });

    test("remote empties content, local unchanged", () => {
      const base = "Original content\n";
      const local = "Original content\n";
      const remote = "";

      const result = threeWayMerge(base, local, remote);
      expect(result.success).toBe(true);
      expect(result.content.trim()).toBe("");
    });
  });
});
