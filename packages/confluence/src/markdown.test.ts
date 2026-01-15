import { describe, test, expect } from "bun:test";
import {
  markdownToStorage,
  storageToMarkdown,
  normalizeMarkdown,
  hashContent,
  isImageFile,
  replaceAttachmentPaths,
  extractAttachmentRefs,
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

  test("converts task lists to Confluence format", () => {
    const md = "- [ ] Unchecked\n- [x] Checked";
    const html = markdownToStorage(md);
    expect(html).toContain("<ac:task-list>");
    expect(html).toContain("<ac:task>");
    expect(html).toContain("<ac:task-status>incomplete</ac:task-status>");
    expect(html).toContain("<ac:task-status>complete</ac:task-status>");
    expect(html).toContain("Unchecked");
    expect(html).toContain("Checked");
  });

  test("converts date macros to time element", () => {
    const md = "Meeting on {date:2024-01-15} at 3pm";
    const html = markdownToStorage(md);
    expect(html).toContain('<time datetime="2024-01-15" />');
  });

  test("converts emoticons to ac:emoticon", () => {
    const md = "Great job :thumbs-up: and :smile:";
    const html = markdownToStorage(md);
    expect(html).toContain('<ac:emoticon ac:name="thumbs-up" />');
    expect(html).toContain('<ac:emoticon ac:name="smile" />');
  });

  test("does not convert unknown emoticons", () => {
    const md = "This :not-a-real-emoticon: stays";
    const html = markdownToStorage(md);
    expect(html).toContain(":not-a-real-emoticon:");
    expect(html).not.toContain("ac:emoticon");
  });

  test("converts emoticon aliases to Confluence names", () => {
    const md = "Good :+1: idea :bulb: check :check:";
    const html = markdownToStorage(md);
    expect(html).toContain('<ac:emoticon ac:name="thumbs-up" />');
    expect(html).toContain('<ac:emoticon ac:name="light-on" />');
    expect(html).toContain('<ac:emoticon ac:name="tick" />');
  });

  test("converts user mentions to ac:link", () => {
    const md = "Please review @[John Doe](123456:abcd-efgh)";
    const html = markdownToStorage(md);
    expect(html).toContain('<ac:link><ri:user ri:account-id="123456:abcd-efgh" />');
    expect(html).toContain("<![CDATA[John Doe]]>");
    expect(html).toContain("</ac:plain-text-link-body></ac:link>");
  });

  test("converts colored text to span with style", () => {
    const md = "This is {color:red}important{color} text";
    const html = markdownToStorage(md);
    expect(html).toContain('<span style="color: red;">important</span>');
  });

  test("converts hex color codes", () => {
    const md = "Use {color:#0066cc}brand blue{color} here";
    const html = markdownToStorage(md);
    expect(html).toContain('<span style="color: #0066cc;">brand blue</span>');
  });

  test("handles nested formatting in colored text", () => {
    const md = "This is {color:green}**bold green**{color}";
    const html = markdownToStorage(md);
    expect(html).toContain("color: green");
    expect(html).toContain("<strong>");
  });

  test("converts background color to span with style", () => {
    const md = "This is {bg:yellow}highlighted{bg} text";
    const html = markdownToStorage(md);
    expect(html).toContain('<span style="background-color: yellow;">highlighted</span>');
  });

  test("converts hex background color", () => {
    const md = "Use {bg:#FFFF00}bright yellow{bg} here";
    const html = markdownToStorage(md);
    expect(html).toContain('<span style="background-color: #FFFF00;">bright yellow</span>');
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

  test("converts Confluence native tasks to markdown", () => {
    const storage = `
      <ac:task-list>
        <ac:task>
          <ac:task-id>1</ac:task-id>
          <ac:task-status>incomplete</ac:task-status>
          <ac:task-body>Buy milk</ac:task-body>
        </ac:task>
        <ac:task>
          <ac:task-id>2</ac:task-id>
          <ac:task-status>complete</ac:task-status>
          <ac:task-body>Write code</ac:task-body>
        </ac:task>
      </ac:task-list>
    `;
    const md = storageToMarkdown(storage);
    expect(md).toContain("[ ]");
    expect(md).toContain("[x]");
    expect(md).toContain("Buy milk");
    expect(md).toContain("Write code");
  });

  test("converts time element to date macro", () => {
    const storage = '<p>Meeting on <time datetime="2024-01-15" /> at 3pm</p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("{date:2024-01-15}");
  });

  test("converts Confluence date macro to markdown", () => {
    const storage = '<p>Deadline: <ac:structured-macro ac:name="date"><ac:parameter ac:name="">2025-12-31</ac:parameter></ac:structured-macro></p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("{date:2025-12-31}");
  });

  test("converts ac:emoticon to markdown", () => {
    const storage = '<p>Great <ac:emoticon ac:name="thumbs-up" /> work!</p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain(":thumbs-up:");
  });

  test("converts user mention with display name to markdown", () => {
    const storage = '<p>Please review <ac:link><ri:user ri:account-id="123456:abcd-efgh" /><ac:plain-text-link-body><![CDATA[John Doe]]></ac:plain-text-link-body></ac:link></p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("@[John Doe](123456:abcd-efgh)");
  });

  test("converts user mention without display name to markdown", () => {
    const storage = '<p>CC <ac:link><ri:user ri:account-id="123456:abcd-efgh" /></ac:link></p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("@[123456:abcd-efgh](123456:abcd-efgh)");
  });

  test("converts colored span to markdown syntax", () => {
    const storage = '<p>This is <span style="color: red;">important</span> text</p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("{color:red}important{color}");
  });

  test("converts hex color from span", () => {
    const storage = '<p>Use <span style="color: #0066cc;">brand blue</span></p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("{color:#0066cc}brand blue{color}");
  });

  test("converts rgb color from span", () => {
    const storage = '<p>Text <span style="color: rgb(255, 0, 0);">in red</span></p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("{color:rgb(255, 0, 0)}in red{color}");
  });

  test("converts background color span to markdown syntax", () => {
    const storage = '<p>This is <span style="background-color: yellow;">highlighted</span> text</p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("{bg:yellow}highlighted{bg}");
  });

  test("converts rgb background color from span", () => {
    const storage = '<p>Text <span style="background-color: rgb(255, 255, 0);">yellow bg</span></p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("{bg:rgb(255, 255, 0)}yellow bg{bg}");
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

describe("jira macro", () => {
  test("converts basic jira macro to Confluence storage", () => {
    const md = "See {jira:PROJ-123} for details.";
    const html = markdownToStorage(md);
    expect(html).toContain('<ac:structured-macro ac:name="jira">');
    expect(html).toContain('<ac:parameter ac:name="key">PROJ-123</ac:parameter>');
  });

  test("converts jira macro with showSummary option", () => {
    const md = "See {jira:PROJ-456|showSummary} for details.";
    const html = markdownToStorage(md);
    expect(html).toContain('<ac:parameter ac:name="key">PROJ-456</ac:parameter>');
    expect(html).toContain('<ac:parameter ac:name="showSummary">true</ac:parameter>');
  });

  test("converts jira macro with multiple options", () => {
    const md = "See {jira:TEST-789|showSummary,count} for details.";
    const html = markdownToStorage(md);
    expect(html).toContain('<ac:parameter ac:name="key">TEST-789</ac:parameter>');
    expect(html).toContain('<ac:parameter ac:name="showSummary">true</ac:parameter>');
    expect(html).toContain('<ac:parameter ac:name="count">true</ac:parameter>');
  });

  test("converts jira macro with columns option", () => {
    const md = "See {jira:DEV-100|columns=key,summary,status} for details.";
    const html = markdownToStorage(md);
    expect(html).toContain('<ac:parameter ac:name="key">DEV-100</ac:parameter>');
    expect(html).toContain('<ac:parameter ac:name="columns">key,summary,status</ac:parameter>');
  });

  test("converts Confluence jira storage to markdown", () => {
    const storage = '<p>See <ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-123</ac:parameter></ac:structured-macro> for details.</p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("{jira:PROJ-123}");
  });

  test("converts Confluence jira storage with showSummary to markdown", () => {
    const storage = '<p>See <ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-456</ac:parameter><ac:parameter ac:name="showSummary">true</ac:parameter></ac:structured-macro> for details.</p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("{jira:PROJ-456|showSummary}");
  });

  test("converts Confluence jira storage with multiple options to markdown", () => {
    const storage = '<p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">TEST-789</ac:parameter><ac:parameter ac:name="showSummary">true</ac:parameter><ac:parameter ac:name="count">true</ac:parameter></ac:structured-macro></p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("{jira:TEST-789|showSummary,count}");
  });

  test("jira macro survives round-trip", () => {
    const original = "See {jira:PROJ-123} for details.\n";
    const html = markdownToStorage(original);
    const result = storageToMarkdown(html);
    expect(result).toContain("{jira:PROJ-123}");
  });

  test("jira macro with options survives round-trip", () => {
    const original = "See {jira:PROJ-456|showSummary} for details.\n";
    const html = markdownToStorage(original);
    const result = storageToMarkdown(html);
    expect(result).toContain("{jira:PROJ-456|showSummary}");
  });

  test("handles multiple jira macros in same paragraph", () => {
    const md = "Related: {jira:PROJ-1} and {jira:PROJ-2}";
    const html = markdownToStorage(md);
    expect(html).toContain('<ac:parameter ac:name="key">PROJ-1</ac:parameter>');
    expect(html).toContain('<ac:parameter ac:name="key">PROJ-2</ac:parameter>');
  });

  test("case insensitive issue key matching", () => {
    // Jira keys are uppercase, but we should handle lowercase gracefully
    const md = "See {jira:proj-123} for details.";
    const html = markdownToStorage(md);
    // The regex is case insensitive, so it should match
    expect(html).toContain('<ac:structured-macro ac:name="jira">');
  });
});

describe("attachment images", () => {
  test("converts basic image attachment to Confluence storage", () => {
    const md = "See the diagram:\n\n![Architecture](./page.attachments/diagram.png)";
    const html = markdownToStorage(md);
    expect(html).toContain('<ac:image><ri:attachment ri:filename="diagram.png" ac:alt="Architecture"/></ac:image>');
  });

  test("converts image attachment with size to Confluence storage", () => {
    const md = "![Screenshot](./page.attachments/screen.png){width=800}";
    const html = markdownToStorage(md);
    expect(html).toContain('ac:width="800"');
    expect(html).toContain('ri:filename="screen.png"');
  });

  test("converts image attachment with width and height to Confluence storage", () => {
    const md = "![Logo](./page.attachments/logo.svg){width=200 height=100}";
    const html = markdownToStorage(md);
    expect(html).toContain('ac:width="200"');
    expect(html).toContain('ac:height="100"');
    expect(html).toContain('ri:filename="logo.svg"');
  });

  test("converts Confluence image attachment to markdown", () => {
    const storage = '<p>See <ac:image><ri:attachment ri:filename="diagram.png" ac:alt="Architecture"/></ac:image></p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("![Architecture](./attachments/diagram.png)");
  });

  test("converts Confluence image with size to markdown", () => {
    const storage = '<ac:image ac:width="800"><ri:attachment ri:filename="screen.png"/></ac:image>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("![](./attachments/screen.png){width=800}");
  });

  test("converts Confluence image with width and height to markdown", () => {
    const storage = '<ac:image ac:width="200" ac:height="100"><ri:attachment ri:filename="logo.svg"/></ac:image>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("![](./attachments/logo.svg){width=200 height=100}");
  });

  test("handles multiple image attachments", () => {
    const md = "![A](./docs.attachments/a.png) and ![B](./docs.attachments/b.jpg)";
    const html = markdownToStorage(md);
    expect(html).toContain('ri:filename="a.png"');
    expect(html).toContain('ri:filename="b.jpg"');
  });

  test("handles various image extensions", () => {
    const extensions = ["png", "jpg", "jpeg", "gif", "svg", "webp"];
    for (const ext of extensions) {
      const md = `![Test](./page.attachments/image.${ext})`;
      const html = markdownToStorage(md);
      expect(html).toContain(`ri:filename="image.${ext}"`);
      expect(html).toContain('<ac:image>');
    }
  });

  test("does not convert attachment syntax inside inline code", () => {
    const md = "Example: `![alt](./page.attachments/example.png)` syntax";
    const html = markdownToStorage(md);
    // Should NOT convert to ac:image because it's in backticks
    expect(html).not.toContain('<ac:image>');
    expect(html).not.toContain('ri:attachment');
    // Should preserve the code content
    expect(html).toContain('<code>');
    expect(html).toContain('![alt]');
  });

  test("converts real attachments but preserves inline code examples", () => {
    const md = `
Real image: ![Photo](./page.attachments/photo.png)

Example syntax: \`![alt](./page.attachments/example.png)\`
`;
    const html = markdownToStorage(md);
    // Real attachment should be converted
    expect(html).toContain('ri:filename="photo.png"');
    expect(html).toContain('<ac:image>');
    // Example in code should NOT be converted
    expect(html).toContain('<code>');
    // Should only have one ac:image (for the real one)
    const acImageCount = (html.match(/<ac:image>/g) || []).length;
    expect(acImageCount).toBe(1);
  });
});

describe("attachment file links", () => {
  test("converts PDF attachment link to Confluence storage", () => {
    const md = "Download the [Report](./page.attachments/report.pdf)";
    const html = markdownToStorage(md);
    expect(html).toContain('<ac:link>');
    expect(html).toContain('<ri:attachment ri:filename="report.pdf"/>');
    expect(html).toContain('<ac:plain-text-link-body><![CDATA[Report]]></ac:plain-text-link-body>');
  });

  test("converts Excel attachment link to Confluence storage", () => {
    const md = "[Spreadsheet](./data.attachments/data.xlsx)";
    const html = markdownToStorage(md);
    expect(html).toContain('<ri:attachment ri:filename="data.xlsx"/>');
    expect(html).toContain('<![CDATA[Spreadsheet]]>');
  });

  test("converts Word document attachment link to Confluence storage", () => {
    const md = "[Document](./page.attachments/spec.docx)";
    const html = markdownToStorage(md);
    expect(html).toContain('<ri:attachment ri:filename="spec.docx"/>');
  });

  test("converts Confluence file attachment link to markdown", () => {
    const storage = '<p>Download the <ac:link><ri:attachment ri:filename="report.pdf"/><ac:plain-text-link-body><![CDATA[Report]]></ac:plain-text-link-body></ac:link></p>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("[Report](./attachments/report.pdf)");
  });

  test("converts Confluence attachment link without CDATA to markdown", () => {
    const storage = '<ac:link><ri:attachment ri:filename="spec.docx"/><ac:plain-text-link-body>Specification</ac:plain-text-link-body></ac:link>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("[Specification](./attachments/spec.docx)");
  });

  test("converts Confluence attachment link without link body to markdown", () => {
    const storage = '<ac:link><ri:attachment ri:filename="data.xlsx"/></ac:link>';
    const md = storageToMarkdown(storage);
    expect(md).toContain("[data.xlsx](./attachments/data.xlsx)");
  });

  test("does not convert image extensions as file links", () => {
    // Image extensions should use ac:image, not ac:link
    const md = "![Image](./page.attachments/photo.png)";
    const html = markdownToStorage(md);
    expect(html).toContain('<ac:image>');
    expect(html).not.toContain('<ac:link>');
  });

  test("handles various file extensions", () => {
    const files = [
      { ext: "pdf", name: "PDF" },
      { ext: "xlsx", name: "Excel" },
      { ext: "docx", name: "Word" },
      { ext: "pptx", name: "PowerPoint" },
      { ext: "zip", name: "Archive" },
      { ext: "txt", name: "Text" },
      { ext: "json", name: "JSON" },
      { ext: "csv", name: "CSV" },
    ];
    for (const { ext, name } of files) {
      const md = `[${name}](./page.attachments/file.${ext})`;
      const html = markdownToStorage(md);
      expect(html).toContain(`ri:filename="file.${ext}"`);
      expect(html).toContain('<ac:link>');
    }
  });
});

describe("attachment mixed content", () => {
  test("handles mixed images and file attachments in same content", () => {
    const md = `
# Documentation

![Diagram](./docs.attachments/arch.png)

Download the [Specification](./docs.attachments/spec.pdf) for details.

See also ![Screenshot](./docs.attachments/screen.jpg){width=600}
`;
    const html = markdownToStorage(md);

    // Should have 2 images and 1 file link
    expect(html).toContain('ri:filename="arch.png"');
    expect(html).toContain('ri:filename="screen.jpg"');
    expect(html).toContain('ac:width="600"');
    expect(html).toContain('ri:filename="spec.pdf"');
    expect(html).toContain('<ac:link>');
  });

  test("preserves non-attachment images", () => {
    const md = "![External](https://example.com/image.png)";
    const html = markdownToStorage(md);
    // Should NOT convert to ac:image (no .attachments/ path)
    expect(html).not.toContain('<ac:image>');
    expect(html).toContain('<img');
  });

  test("preserves non-attachment links", () => {
    const md = "[External PDF](https://example.com/doc.pdf)";
    const html = markdownToStorage(md);
    // Should NOT convert to ac:link (no .attachments/ path)
    expect(html).not.toContain('<ac:link>');
    expect(html).toContain('<a');
  });
});

describe("isImageFile", () => {
  test("returns true for common image extensions", () => {
    expect(isImageFile("photo.png")).toBe(true);
    expect(isImageFile("photo.PNG")).toBe(true);
    expect(isImageFile("photo.jpg")).toBe(true);
    expect(isImageFile("photo.jpeg")).toBe(true);
    expect(isImageFile("icon.gif")).toBe(true);
    expect(isImageFile("logo.svg")).toBe(true);
    expect(isImageFile("image.webp")).toBe(true);
    expect(isImageFile("favicon.ico")).toBe(true);
    expect(isImageFile("image.bmp")).toBe(true);
  });

  test("returns false for non-image extensions", () => {
    expect(isImageFile("doc.pdf")).toBe(false);
    expect(isImageFile("data.xlsx")).toBe(false);
    expect(isImageFile("report.docx")).toBe(false);
    expect(isImageFile("archive.zip")).toBe(false);
    expect(isImageFile("code.js")).toBe(false);
    expect(isImageFile("readme.md")).toBe(false);
  });

  test("handles edge cases", () => {
    expect(isImageFile(".png")).toBe(true); // just extension
    expect(isImageFile("no-extension")).toBe(false);
    expect(isImageFile("")).toBe(false);
  });
});

describe("replaceAttachmentPaths", () => {
  test("replaces image attachment paths", () => {
    const md = "![Diagram](./attachments/arch.png)";
    const result = replaceAttachmentPaths(md, "architecture.md");
    expect(result).toBe("![Diagram](./architecture.attachments/arch.png)");
  });

  test("replaces file attachment paths", () => {
    const md = "[Report](./attachments/report.pdf)";
    const result = replaceAttachmentPaths(md, "docs.md");
    expect(result).toBe("[Report](./docs.attachments/report.pdf)");
  });

  test("replaces multiple attachments", () => {
    const md = `
![Image](./attachments/photo.png)

[PDF](./attachments/doc.pdf)

![Another](./attachments/logo.svg)
`;
    const result = replaceAttachmentPaths(md, "page.md");
    expect(result).toContain("./page.attachments/photo.png");
    expect(result).toContain("./page.attachments/doc.pdf");
    expect(result).toContain("./page.attachments/logo.svg");
  });

  test("preserves size attributes in images", () => {
    const md = "![Photo](./attachments/screen.png){width=800}";
    const result = replaceAttachmentPaths(md, "test.md");
    expect(result).toBe("![Photo](./test.attachments/screen.png){width=800}");
  });

  test("preserves alt text", () => {
    const md = "![Architecture Overview](./attachments/diagram.png)";
    const result = replaceAttachmentPaths(md, "overview.md");
    expect(result).toBe("![Architecture Overview](./overview.attachments/diagram.png)");
  });

  test("handles page filename without .md extension", () => {
    const md = "![Image](./attachments/img.png)";
    const result = replaceAttachmentPaths(md, "page");
    expect(result).toBe("![Image](./page.attachments/img.png)");
  });
});

describe("extractAttachmentRefs", () => {
  test("extracts image attachment references", () => {
    const md = "![Diagram](./docs.attachments/arch.png)";
    const refs = extractAttachmentRefs(md);
    expect(refs).toContain("arch.png");
  });

  test("extracts file attachment references", () => {
    const md = "[Report](./docs.attachments/report.pdf)";
    const refs = extractAttachmentRefs(md);
    expect(refs).toContain("report.pdf");
  });

  test("extracts multiple attachment references", () => {
    const md = `
![Image](./page.attachments/photo.png)
[PDF](./page.attachments/doc.pdf)
![Logo](./page.attachments/logo.svg){width=100}
`;
    const refs = extractAttachmentRefs(md);
    expect(refs).toHaveLength(3);
    expect(refs).toContain("photo.png");
    expect(refs).toContain("doc.pdf");
    expect(refs).toContain("logo.svg");
  });

  test("returns unique references only", () => {
    const md = `
![Image](./page.attachments/photo.png)
![Same](./page.attachments/photo.png)
`;
    const refs = extractAttachmentRefs(md);
    expect(refs).toHaveLength(1);
    expect(refs).toContain("photo.png");
  });

  test("returns empty array for no attachments", () => {
    const md = "# Title\n\nSome text without attachments.";
    const refs = extractAttachmentRefs(md);
    expect(refs).toHaveLength(0);
  });

  test("ignores external URLs", () => {
    const md = "![External](https://example.com/image.png)";
    const refs = extractAttachmentRefs(md);
    expect(refs).toHaveLength(0);
  });

  test("ignores references inside inline code", () => {
    const md = `
Real image: ![Test](./page.attachments/real.png)

Example: \`![alt](./page.attachments/example.png)\` syntax
`;
    const refs = extractAttachmentRefs(md);
    expect(refs).toHaveLength(1);
    expect(refs).toContain("real.png");
    expect(refs).not.toContain("example.png");
  });

  test("ignores references inside code blocks", () => {
    const md = `
![Real](./page.attachments/real.png)

\`\`\`markdown
![Example](./page.attachments/example.png)
\`\`\`
`;
    const refs = extractAttachmentRefs(md);
    expect(refs).toHaveLength(1);
    expect(refs).toContain("real.png");
    expect(refs).not.toContain("example.png");
  });
});

describe("smart links", () => {
  const baseUrl = "https://example.atlassian.net";

  describe("storageToMarkdown - smart link conversion", () => {
    test("converts inline smart link to markdown URL", () => {
      const storage = '<p>See <a href="https://example.atlassian.net/browse/PROJ-123" data-card-appearance="inline">PROJ-123</a> for details.</p>';
      const md = storageToMarkdown(storage, { baseUrl });
      expect(md).toContain("[PROJ-123](https://example.atlassian.net/browse/PROJ-123)");
      expect(md).not.toContain("<!--");
    });

    test("converts card smart link to markdown URL with annotation", () => {
      const storage = '<div data-card-appearance="card"><a href="https://example.atlassian.net/browse/PROJ-456">PROJ-456</a></div>';
      const md = storageToMarkdown(storage, { baseUrl });
      expect(md).toContain("[PROJ-456](https://example.atlassian.net/browse/PROJ-456)<!--card-->");
    });

    test("converts embed smart link to markdown URL with annotation", () => {
      const storage = '<div data-card-appearance="embed"><a href="https://example.atlassian.net/wiki/spaces/TEAM/pages/123">Page Title</a></div>';
      const md = storageToMarkdown(storage, { baseUrl });
      expect(md).toContain("[Page Title](https://example.atlassian.net/wiki/spaces/TEAM/pages/123)<!--embed-->");
    });

    test("handles smart link without data-card-appearance as inline", () => {
      const storage = '<p><a href="https://example.atlassian.net/browse/TEST-1">TEST-1</a></p>';
      const md = storageToMarkdown(storage, { baseUrl });
      // Regular links should still work even without data-card-appearance
      expect(md).toContain("[TEST-1](https://example.atlassian.net/browse/TEST-1)");
    });
  });

  describe("markdownToStorage - URL to smart link conversion", () => {
    test("converts Jira URL to inline smart link", () => {
      const md = "[PROJ-123](https://example.atlassian.net/browse/PROJ-123)";
      const html = markdownToStorage(md, { baseUrl });
      expect(html).toContain('data-card-appearance="inline"');
      expect(html).toContain('href="https://example.atlassian.net/browse/PROJ-123"');
      expect(html).toContain(">PROJ-123</a>");
    });

    test("converts Confluence URL to inline smart link", () => {
      const md = "[Page Title](https://example.atlassian.net/wiki/spaces/TEAM/pages/12345)";
      const html = markdownToStorage(md, { baseUrl });
      expect(html).toContain('data-card-appearance="inline"');
      expect(html).toContain('href="https://example.atlassian.net/wiki/spaces/TEAM/pages/12345"');
    });

    test("converts URL with card annotation to card smart link", () => {
      const md = "[PROJ-456](https://example.atlassian.net/browse/PROJ-456)<!--card-->";
      const html = markdownToStorage(md, { baseUrl });
      expect(html).toContain('data-card-appearance="card"');
      // Uses anchor tag directly - Confluence strips attributes from div elements
      expect(html).toContain("<a");
    });

    test("converts URL with embed annotation to embed smart link", () => {
      const md = "[Page](https://example.atlassian.net/wiki/spaces/TEAM/pages/123)<!--embed-->";
      const html = markdownToStorage(md, { baseUrl });
      expect(html).toContain('data-card-appearance="embed"');
      // Uses anchor tag directly - Confluence strips attributes from div elements
      expect(html).toContain("<a");
    });

    test("does not convert URLs from different hosts", () => {
      const md = "[PROJ-123](https://other.atlassian.net/browse/PROJ-123)";
      const html = markdownToStorage(md, { baseUrl });
      // Should be a regular link, not a smart link
      expect(html).not.toContain('data-card-appearance');
      expect(html).toContain('<a href="https://other.atlassian.net/browse/PROJ-123">');
    });

    test("does not convert non-Atlassian URLs", () => {
      const md = "[GitHub](https://github.com/user/repo)";
      const html = markdownToStorage(md, { baseUrl });
      expect(html).not.toContain('data-card-appearance');
      expect(html).toContain('<a href="https://github.com/user/repo">');
    });

    test("handles missing baseUrl gracefully", () => {
      const md = "[PROJ-123](https://example.atlassian.net/browse/PROJ-123)";
      const html = markdownToStorage(md);
      // Without baseUrl, should be a regular link
      expect(html).not.toContain('data-card-appearance');
      expect(html).toContain('<a href="https://example.atlassian.net/browse/PROJ-123">');
    });
  });

  describe("legacy jira macro with baseUrl", () => {
    test("outputs full URL when baseUrl is provided", () => {
      const storage = '<p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-123</ac:parameter></ac:structured-macro></p>';
      const md = storageToMarkdown(storage, { baseUrl });
      expect(md).toContain("[PROJ-123](https://example.atlassian.net/browse/PROJ-123)");
      expect(md).not.toContain("{jira:");
    });

    test("falls back to {jira:} syntax without baseUrl", () => {
      const storage = '<p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-123</ac:parameter></ac:structured-macro></p>';
      const md = storageToMarkdown(storage);
      expect(md).toContain("{jira:PROJ-123}");
      expect(md).not.toContain("https://");
    });

    test("preserves jira macro options with full URL", () => {
      const storage = '<p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-456</ac:parameter><ac:parameter ac:name="showSummary">true</ac:parameter></ac:structured-macro></p>';
      const md = storageToMarkdown(storage, { baseUrl });
      // With baseUrl, outputs URL with options in comment
      expect(md).toContain("[PROJ-456](https://example.atlassian.net/browse/PROJ-456)");
    });
  });

  describe("round-trip smart link conversion", () => {
    test("inline smart link survives round-trip", () => {
      const original = "[PROJ-123](https://example.atlassian.net/browse/PROJ-123)";
      const storage = markdownToStorage(original, { baseUrl });
      const result = storageToMarkdown(storage, { baseUrl });
      expect(result.trim()).toBe(original);
    });

    test("card smart link survives round-trip", () => {
      const original = "[PROJ-456](https://example.atlassian.net/browse/PROJ-456)<!--card-->";
      const storage = markdownToStorage(original, { baseUrl });
      const result = storageToMarkdown(storage, { baseUrl });
      expect(result.trim()).toBe(original);
    });

    test("embed smart link survives round-trip", () => {
      const original = "[Page](https://example.atlassian.net/wiki/spaces/TEAM/pages/123)<!--embed-->";
      const storage = markdownToStorage(original, { baseUrl });
      const result = storageToMarkdown(storage, { baseUrl });
      expect(result.trim()).toBe(original);
    });
  });

  describe("deprecation warnings", () => {
    test("emits warning for legacy {jira:} syntax when enabled", () => {
      const warnings: string[] = [];
      const options = {
        baseUrl,
        emitWarnings: true,
        onWarning: (msg: string) => warnings.push(msg),
      };

      markdownToStorage("See {jira:PROJ-123} for details.", options);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain("deprecated");
    });

    test("does not emit warning when emitWarnings is false", () => {
      const warnings: string[] = [];
      const options = {
        baseUrl,
        emitWarnings: false,
        onWarning: (msg: string) => warnings.push(msg),
      };

      markdownToStorage("See {jira:PROJ-123} for details.", options);
      expect(warnings.length).toBe(0);
    });
  });

  describe("edge cases", () => {
    test("handles multiple smart links in same paragraph", () => {
      const md = "See [PROJ-1](https://example.atlassian.net/browse/PROJ-1) and [PROJ-2](https://example.atlassian.net/browse/PROJ-2)";
      const html = markdownToStorage(md, { baseUrl });
      const inlineCount = (html.match(/data-card-appearance="inline"/g) || []).length;
      expect(inlineCount).toBe(2);
    });

    test("handles mixed smart links and regular links", () => {
      const md = `
[Jira](https://example.atlassian.net/browse/PROJ-123)
[GitHub](https://github.com/user/repo)
[Wiki](https://example.atlassian.net/wiki/spaces/TEAM/pages/123)
`;
      const html = markdownToStorage(md, { baseUrl });
      // Should have 2 smart links (Jira and Wiki)
      const smartLinkCount = (html.match(/data-card-appearance/g) || []).length;
      expect(smartLinkCount).toBe(2);
      // GitHub should be a regular link
      expect(html).toContain('<a href="https://github.com/user/repo">');
    });

    test("preserves smart link text exactly", () => {
      const storage = '<a href="https://example.atlassian.net/browse/PROJ-123" data-card-appearance="inline">Custom Text Here</a>';
      const md = storageToMarkdown(storage, { baseUrl });
      expect(md).toContain("[Custom Text Here]");
    });

    test("handles URL with special characters in path", () => {
      const md = "[Page Name](https://example.atlassian.net/wiki/spaces/My%20Space/pages/123)";
      const html = markdownToStorage(md, { baseUrl });
      expect(html).toContain('href="https://example.atlassian.net/wiki/spaces/My%20Space/pages/123"');
    });
  });
});
