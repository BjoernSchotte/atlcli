import { describe, test, expect } from "bun:test";
import {
  markdownToStorage,
  storageToMarkdown,
  normalizeMarkdown,
  hashContent,
} from "./markdown.js";

describe("markdownToStorage", () => {
  test("converts basic markdown to HTML", () => {
    const md = "# Hello\n\nThis is a paragraph.";
    const html = markdownToStorage(md);
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<p>This is a paragraph.</p>");
  });

  test("converts code blocks with language", () => {
    const md = "```typescript\nconst x = 1;\n```";
    const html = markdownToStorage(md);
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("language-typescript");
  });

  test("converts task lists", () => {
    const md = "- [ ] Unchecked\n- [x] Checked";
    const html = markdownToStorage(md);
    expect(html).toContain("checkbox");
  });

  test("converts tables", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const html = markdownToStorage(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain("<td>");
  });
});

describe("storageToMarkdown", () => {
  test("converts basic HTML to markdown", () => {
    const html = "<h1>Hello</h1><p>World</p>";
    const md = storageToMarkdown(html);
    expect(md).toContain("# Hello");
    expect(md).toContain("World");
  });

  test("converts code blocks back to fenced syntax", () => {
    const html = '<pre><code class="language-js">const x = 1;</code></pre>';
    const md = storageToMarkdown(html);
    expect(md).toContain("```");
    expect(md).toContain("js");
    expect(md).toContain("const x = 1;");
  });

  test("converts task lists back to checkbox syntax", () => {
    const html = '<input type="checkbox" checked> Done';
    const md = storageToMarkdown(html);
    expect(md).toContain("[x]");
  });

  test("ends with single newline", () => {
    const html = "<p>Test</p>";
    const md = storageToMarkdown(html);
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });
});

describe("normalizeMarkdown", () => {
  test("converts CRLF to LF", () => {
    const input = "Line 1\r\nLine 2\r\n";
    const result = normalizeMarkdown(input);
    expect(result).toBe("Line 1\nLine 2\n");
  });

  test("removes trailing whitespace from lines", () => {
    const input = "Line 1   \nLine 2\t\n";
    const result = normalizeMarkdown(input);
    expect(result).toBe("Line 1\nLine 2\n");
  });

  test("collapses multiple blank lines", () => {
    const input = "Line 1\n\n\n\nLine 2\n";
    const result = normalizeMarkdown(input);
    expect(result).toBe("Line 1\n\nLine 2\n");
  });

  test("ensures single trailing newline", () => {
    const input = "Content";
    const result = normalizeMarkdown(input);
    expect(result).toBe("Content\n");
  });

  test("handles already normalized content", () => {
    const input = "# Title\n\nParagraph\n";
    const result = normalizeMarkdown(input);
    expect(result).toBe("# Title\n\nParagraph\n");
  });

  test("handles empty content", () => {
    const result = normalizeMarkdown("");
    expect(result).toBe("\n");
  });
});

describe("hashContent", () => {
  test("returns consistent hash for same content", () => {
    const content = "Hello, World!";
    const hash1 = hashContent(content);
    const hash2 = hashContent(content);
    expect(hash1).toBe(hash2);
  });

  test("returns different hash for different content", () => {
    const hash1 = hashContent("Hello");
    const hash2 = hashContent("World");
    expect(hash1).not.toBe(hash2);
  });

  test("returns 64-character hex string (SHA-256)", () => {
    const hash = hashContent("test");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("handles empty string", () => {
    const hash = hashContent("");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("handles unicode content", () => {
    const hash = hashContent("Hello \u{1F600} World");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("round-trip conversion", () => {
  test("basic markdown survives round-trip", () => {
    const original = "# Title\n\nParagraph text.\n";
    const html = markdownToStorage(original);
    const result = storageToMarkdown(html);
    expect(normalizeMarkdown(result)).toBe(normalizeMarkdown(original));
  });

  test("code block survives round-trip", () => {
    const original = "```js\nconst x = 1;\n```\n";
    const html = markdownToStorage(original);
    const result = storageToMarkdown(html);
    expect(result).toContain("```");
    expect(result).toContain("const x = 1;");
  });

  test("list survives round-trip", () => {
    const original = "- Item 1\n- Item 2\n";
    const html = markdownToStorage(original);
    const result = storageToMarkdown(html);
    expect(result).toContain("Item 1");
    expect(result).toContain("Item 2");
  });
});
