import { describe, test, expect } from "bun:test";
import {
  parseFrontmatter,
  addFrontmatter,
  stripFrontmatter,
  hasFrontmatterId,
  extractTitleFromMarkdown,
  AtlcliFrontmatter,
} from "./frontmatter.js";

describe("frontmatter utilities", () => {
  describe("parseFrontmatter", () => {
    test("parses basic frontmatter with id", () => {
      const markdown = `---
atlcli:
  id: "12345"
---

# Content`;

      const result = parseFrontmatter(markdown);

      expect(result.frontmatter).toEqual({ id: "12345" });
      expect(result.content).toBe("\n# Content");
    });

    test("parses frontmatter with id and title", () => {
      const markdown = `---
atlcli:
  id: "12345"
  title: "My Page"
---

# Content`;

      const result = parseFrontmatter(markdown);

      expect(result.frontmatter).toEqual({ id: "12345", title: "My Page" });
    });

    test("parses frontmatter with type field", () => {
      const markdown = `---
atlcli:
  id: "12345"
  title: "My Folder"
  type: "folder"
---
`;

      const result = parseFrontmatter(markdown);

      expect(result.frontmatter).toEqual({
        id: "12345",
        title: "My Folder",
        type: "folder",
      });
    });

    test("parses frontmatter with type: page", () => {
      const markdown = `---
atlcli:
  id: "12345"
  type: "page"
---

# Content`;

      const result = parseFrontmatter(markdown);

      expect(result.frontmatter?.type).toBe("page");
    });

    test("ignores invalid type values", () => {
      const markdown = `---
atlcli:
  id: "12345"
  type: "invalid"
---

# Content`;

      const result = parseFrontmatter(markdown);

      expect(result.frontmatter?.id).toBe("12345");
      expect(result.frontmatter?.type).toBeUndefined();
    });

    test("returns null frontmatter for content without frontmatter", () => {
      const markdown = `# Just Content

No frontmatter here.`;

      const result = parseFrontmatter(markdown);

      expect(result.frontmatter).toBeNull();
      expect(result.content).toBe(markdown);
    });

    test("returns null for frontmatter without id", () => {
      const markdown = `---
atlcli:
  title: "No ID"
---

# Content`;

      const result = parseFrontmatter(markdown);

      expect(result.frontmatter).toBeNull();
    });
  });

  describe("addFrontmatter", () => {
    test("adds basic frontmatter", () => {
      const content = "# My Page\n\nContent here.";
      const frontmatter: AtlcliFrontmatter = { id: "12345" };

      const result = addFrontmatter(content, frontmatter);

      expect(result).toContain('id: "12345"');
      expect(result).toContain("# My Page");
    });

    test("adds frontmatter with title", () => {
      const content = "Content";
      const frontmatter: AtlcliFrontmatter = { id: "12345", title: "My Title" };

      const result = addFrontmatter(content, frontmatter);

      expect(result).toContain('id: "12345"');
      expect(result).toContain('title: "My Title"');
    });

    test("adds frontmatter with type", () => {
      const content = "";
      const frontmatter: AtlcliFrontmatter = {
        id: "12345",
        title: "My Folder",
        type: "folder",
      };

      const result = addFrontmatter(content, frontmatter);

      expect(result).toContain('id: "12345"');
      expect(result).toContain('title: "My Folder"');
      expect(result).toContain('type: "folder"');
    });

    test("replaces existing frontmatter", () => {
      const content = `---
atlcli:
  id: "old-id"
---

# Content`;

      const frontmatter: AtlcliFrontmatter = { id: "new-id" };

      const result = addFrontmatter(content, frontmatter);

      expect(result).toContain('id: "new-id"');
      expect(result).not.toContain('id: "old-id"');
    });

    test("escapes quotes in title", () => {
      const content = "Content";
      const frontmatter: AtlcliFrontmatter = {
        id: "12345",
        title: 'Title with "quotes"',
      };

      const result = addFrontmatter(content, frontmatter);

      expect(result).toContain('title: "Title with \\"quotes\\""');
    });
  });

  describe("stripFrontmatter", () => {
    test("strips frontmatter from content", () => {
      const markdown = `---
atlcli:
  id: "12345"
---

# Content`;

      const result = stripFrontmatter(markdown);

      expect(result).toBe("\n# Content");
      expect(result).not.toContain("---");
    });

    test("returns content unchanged if no frontmatter", () => {
      const markdown = "# Just Content";

      const result = stripFrontmatter(markdown);

      expect(result).toBe(markdown);
    });
  });

  describe("hasFrontmatterId", () => {
    test("returns true for content with frontmatter id", () => {
      const markdown = `---
atlcli:
  id: "12345"
---

# Content`;

      expect(hasFrontmatterId(markdown)).toBe(true);
    });

    test("returns false for content without frontmatter", () => {
      const markdown = "# Just Content";

      expect(hasFrontmatterId(markdown)).toBe(false);
    });

    test("returns false for frontmatter without id", () => {
      const markdown = `---
atlcli:
  title: "No ID"
---

# Content`;

      expect(hasFrontmatterId(markdown)).toBe(false);
    });
  });

  describe("extractTitleFromMarkdown", () => {
    test("extracts H1 heading", () => {
      const markdown = `# My Title

Some content here.`;

      expect(extractTitleFromMarkdown(markdown)).toBe("My Title");
    });

    test("returns null if no H1", () => {
      const markdown = `## Only H2

Some content here.`;

      expect(extractTitleFromMarkdown(markdown)).toBeNull();
    });

    test("extracts first H1 when multiple exist", () => {
      const markdown = `# First Title

# Second Title`;

      expect(extractTitleFromMarkdown(markdown)).toBe("First Title");
    });

    test("ignores frontmatter when extracting title", () => {
      const markdown = `---
atlcli:
  id: "12345"
---

# Real Title`;

      expect(extractTitleFromMarkdown(markdown)).toBe("Real Title");
    });
  });
});
