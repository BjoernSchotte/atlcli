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

describe("normalizeMarkdown - additional edge cases", () => {
  test("handles CRLF line endings", () => {
    const input = "Line1\r\nLine2\r\nLine3";
    const result = normalizeMarkdown(input);
    expect(result).toBe("Line1\nLine2\nLine3\n");
  });

  test("preserves multiple consecutive spaces within lines", () => {
    const input = "Word1    Word2\n";
    const result = normalizeMarkdown(input);
    expect(result).toBe("Word1    Word2\n");
  });

  test("trims leading whitespace from content (uses trim())", () => {
    const input = "    indented code\n        more indented\n";
    const result = normalizeMarkdown(input);
    // Note: trim() removes leading whitespace - this is expected behavior
    expect(result).toBe("indented code\n        more indented\n");
  });

  test("preserves internal indentation", () => {
    const input = "Line1\n    indented\n        double indented\n";
    const result = normalizeMarkdown(input);
    expect(result).toBe("Line1\n    indented\n        double indented\n");
  });

  test("handles content with only whitespace", () => {
    const input = "   \n\t\n  ";
    const result = normalizeMarkdown(input);
    // Should collapse to single newline since all lines are empty after trim
    expect(result).toBe("\n");
  });

  test("handles multiple trailing newlines", () => {
    const input = "Content\n\n\n\n";
    const result = normalizeMarkdown(input);
    expect(result).toBe("Content\n");
  });

  test("handles tabs as trailing whitespace", () => {
    const input = "Line1\t\t\nLine2   \t\n";
    const result = normalizeMarkdown(input);
    expect(result).toBe("Line1\nLine2\n");
  });

  test("preserves single blank line between paragraphs", () => {
    const input = "Paragraph 1\n\nParagraph 2\n";
    const result = normalizeMarkdown(input);
    expect(result).toBe("Paragraph 1\n\nParagraph 2\n");
  });

  test("normalizes three+ blank lines to one blank line", () => {
    const input = "Section 1\n\n\n\n\nSection 2\n";
    const result = normalizeMarkdown(input);
    expect(result).toBe("Section 1\n\nSection 2\n");
  });

  test("handles markdown with code fences", () => {
    const input = "```js\nconst x = 1;   \n```\n";
    const result = normalizeMarkdown(input);
    // Trailing whitespace inside code should still be trimmed
    expect(result).toBe("```js\nconst x = 1;\n```\n");
  });

  test("idempotent - normalizing twice gives same result", () => {
    const input = "Line1  \r\n\r\n\r\nLine2\t\n";
    const once = normalizeMarkdown(input);
    const twice = normalizeMarkdown(once);
    expect(twice).toBe(once);
  });

  test("handles very long lines", () => {
    const longLine = "x".repeat(10000);
    const input = `${longLine}   \n`;
    const result = normalizeMarkdown(input);
    expect(result).toBe(`${longLine}\n`);
  });
});

describe("hashContent - additional edge cases", () => {
  test("produces known SHA-256 for 'test'", () => {
    // SHA-256 of "test" is well-known
    const hash = hashContent("test");
    expect(hash).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
  });

  test("produces known SHA-256 for empty string", () => {
    // SHA-256 of "" is well-known
    const hash = hashContent("");
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("whitespace matters for hash", () => {
    const hash1 = hashContent("hello");
    const hash2 = hashContent("hello ");
    const hash3 = hashContent(" hello");
    expect(hash1).not.toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash2).not.toBe(hash3);
  });

  test("newlines matter for hash", () => {
    const hash1 = hashContent("line1\nline2");
    const hash2 = hashContent("line1\r\nline2");
    expect(hash1).not.toBe(hash2);
  });

  test("case sensitive", () => {
    const hash1 = hashContent("Hello");
    const hash2 = hashContent("hello");
    expect(hash1).not.toBe(hash2);
  });

  test("handles large content efficiently", () => {
    const largeContent = "x".repeat(1_000_000);
    const start = Date.now();
    const hash = hashContent(largeContent);
    const duration = Date.now() - start;
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(duration).toBeLessThan(1000); // Should be fast
  });

  test("handles special characters", () => {
    const content = "Special: <>&\"'`~!@#$%^&*()[]{}|\\";
    const hash = hashContent(content);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("handles multi-byte unicode", () => {
    const content = "日本語 中文 한국어 العربية";
    const hash = hashContent(content);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("handles emoji sequences", () => {
    const content = "👨‍👩‍👧‍👦 🏳️‍🌈 👩🏽‍💻";
    const hash = hashContent(content);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("null bytes in content", () => {
    const content = "before\x00after";
    const hash = hashContent(content);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("normalizeMarkdown + hashContent integration", () => {
  test("normalized content produces consistent hash", () => {
    const variant1 = "Hello\r\nWorld   \n";
    const variant2 = "Hello\nWorld\n";

    const hash1 = hashContent(normalizeMarkdown(variant1));
    const hash2 = hashContent(normalizeMarkdown(variant2));
    expect(hash1).toBe(hash2);
  });

  test("different content produces different hash after normalization", () => {
    const content1 = "Hello World\n";
    const content2 = "Hello  World\n"; // extra space

    const hash1 = hashContent(normalizeMarkdown(content1));
    const hash2 = hashContent(normalizeMarkdown(content2));
    expect(hash1).not.toBe(hash2);
  });

  test("blank line differences are preserved", () => {
    const content1 = "A\n\nB\n";
    const content2 = "A\nB\n";

    const hash1 = hashContent(normalizeMarkdown(content1));
    const hash2 = hashContent(normalizeMarkdown(content2));
    expect(hash1).not.toBe(hash2);
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
