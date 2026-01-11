import { describe, test, expect } from "bun:test";
import {
  extractLinks,
  classifyLink,
  resolveRelativePath,
  isMarkdownPath,
  getPathWithoutAnchor,
  getAnchor,
} from "./links.js";

describe("extractLinks", () => {
  test("extracts simple markdown links", () => {
    const markdown = `Check out [this page](./other.md) for more info.`;
    const links = extractLinks(markdown);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      type: "relative-path",
      target: "./other.md",
      text: "this page",
      line: 1,
    });
  });

  test("extracts multiple links on same line", () => {
    const markdown = `See [page A](./a.md) and [page B](./b.md) for details.`;
    const links = extractLinks(markdown);

    expect(links).toHaveLength(2);
    expect(links[0].target).toBe("./a.md");
    expect(links[1].target).toBe("./b.md");
  });

  test("extracts links from multiple lines", () => {
    const markdown = `# Header

[Link 1](./page1.md)

Some text.

[Link 2](../other/page2.md)`;
    const links = extractLinks(markdown);

    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ target: "./page1.md", line: 3 });
    expect(links[1]).toMatchObject({ target: "../other/page2.md", line: 7 });
  });

  test("does not extract image links", () => {
    const markdown = `![alt text](./image.png)

[Real link](./page.md)`;
    const links = extractLinks(markdown);

    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("./page.md");
  });

  test("skips links inside fenced code blocks", () => {
    const markdown = `Here's a link: [before](./before.md)

\`\`\`markdown
[inside code](./should-ignore.md)
\`\`\`

[after](./after.md)`;
    const links = extractLinks(markdown);

    expect(links).toHaveLength(2);
    expect(links[0].target).toBe("./before.md");
    expect(links[1].target).toBe("./after.md");
  });

  test("skips links inside inline code", () => {
    const markdown = `Use \`[text](./ignore.md)\` syntax for links. See [real](./real.md).`;
    const links = extractLinks(markdown);

    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("./real.md");
  });

  test("extracts external URLs", () => {
    const markdown = `Visit [Google](https://google.com) for more.`;
    const links = extractLinks(markdown);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      type: "external",
      target: "https://google.com",
    });
  });

  test("extracts anchor links", () => {
    const markdown = `Jump to [section](#my-section) below.`;
    const links = extractLinks(markdown);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      type: "anchor",
      target: "#my-section",
    });
  });

  test("extracts attachment links", () => {
    const markdown = `Download [report](./page.attachments/report.pdf).`;
    const links = extractLinks(markdown);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      type: "attachment",
      target: "./page.attachments/report.pdf",
    });
  });

  test("extracts links with anchors", () => {
    const markdown = `See [documentation](./docs.md#installation) for setup.`;
    const links = extractLinks(markdown);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      type: "relative-path",
      target: "./docs.md#installation",
    });
  });

  test("handles empty link text", () => {
    const markdown = `[](./page.md)`;
    const links = extractLinks(markdown);

    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("");
  });

  test("tracks correct line numbers", () => {
    const markdown = `Line 1

Line 3 has [link](./page.md)

Line 5`;
    const links = extractLinks(markdown);

    expect(links).toHaveLength(1);
    expect(links[0].line).toBe(3);
  });
});

describe("classifyLink", () => {
  test("identifies external http links", () => {
    expect(classifyLink("http://example.com")).toBe("external");
    expect(classifyLink("https://example.com/path")).toBe("external");
  });

  test("identifies mailto links as external", () => {
    expect(classifyLink("mailto:user@example.com")).toBe("external");
  });

  test("identifies anchor links", () => {
    expect(classifyLink("#section")).toBe("anchor");
    expect(classifyLink("#my-heading")).toBe("anchor");
  });

  test("identifies attachment links", () => {
    expect(classifyLink("./page.attachments/file.pdf")).toBe("attachment");
    expect(classifyLink("../other.attachments/image.png")).toBe("attachment");
  });

  test("identifies relative paths", () => {
    expect(classifyLink("./page.md")).toBe("relative-path");
    expect(classifyLink("../sibling/page.md")).toBe("relative-path");
    expect(classifyLink("page.md")).toBe("relative-path");
    expect(classifyLink("./docs/api.md#section")).toBe("relative-path");
  });
});

describe("resolveRelativePath", () => {
  test("resolves same-directory paths", () => {
    const result = resolveRelativePath("/docs/page.md", "./other.md");
    expect(result).toBe("/docs/other.md");
  });

  test("resolves parent-directory paths", () => {
    const result = resolveRelativePath("/docs/api/page.md", "../other.md");
    expect(result).toBe("/docs/other.md");
  });

  test("resolves nested paths", () => {
    const result = resolveRelativePath("/docs/page.md", "./sub/nested.md");
    expect(result).toBe("/docs/sub/nested.md");
  });

  test("strips anchor from path", () => {
    const result = resolveRelativePath("/docs/page.md", "./other.md#section");
    expect(result).toBe("/docs/other.md");
  });

  test("handles multiple parent references", () => {
    const result = resolveRelativePath(
      "/docs/deep/nested/page.md",
      "../../other.md"
    );
    expect(result).toBe("/docs/other.md");
  });
});

describe("isMarkdownPath", () => {
  test("returns true for .md files", () => {
    expect(isMarkdownPath("page.md")).toBe(true);
    expect(isMarkdownPath("./docs/page.md")).toBe(true);
    expect(isMarkdownPath("PAGE.MD")).toBe(true);
  });

  test("returns true for .markdown files", () => {
    expect(isMarkdownPath("page.markdown")).toBe(true);
    expect(isMarkdownPath("README.MARKDOWN")).toBe(true);
  });

  test("returns false for other files", () => {
    expect(isMarkdownPath("page.txt")).toBe(false);
    expect(isMarkdownPath("page.html")).toBe(false);
    expect(isMarkdownPath("image.png")).toBe(false);
  });
});

describe("getPathWithoutAnchor", () => {
  test("returns path without anchor", () => {
    expect(getPathWithoutAnchor("./page.md#section")).toBe("./page.md");
    expect(getPathWithoutAnchor("./page.md")).toBe("./page.md");
  });

  test("handles anchor-only links", () => {
    expect(getPathWithoutAnchor("#section")).toBe("");
  });
});

describe("getAnchor", () => {
  test("returns anchor from path", () => {
    expect(getAnchor("./page.md#section")).toBe("section");
    expect(getAnchor("#my-heading")).toBe("my-heading");
  });

  test("returns null when no anchor", () => {
    expect(getAnchor("./page.md")).toBeNull();
    expect(getAnchor("https://example.com")).toBeNull();
  });
});
