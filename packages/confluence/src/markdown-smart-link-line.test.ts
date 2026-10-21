import { describe, expect, test } from "bun:test";
import { markdownToStorage } from "./markdown.js";

const BASE = "https://x.atlassian.net";

describe("smart link at the start of a line (regression)", () => {
  // The smart-link placeholder used to be an HTML comment; at a line start it
  // opened a raw HTML block, so the rest of the line skipped inline markdown
  // and backslash escapes reached the page verbatim.
  test("the rest of a list item is still markdown", () => {
    const storage = markdownToStorage(`- [A-1](${BASE}/browse/A-1) Fix \\*all\\* **now**`, { baseUrl: BASE });
    expect(storage).toContain('data-card-appearance="inline">A-1</a> Fix *all* <strong>now</strong>');
    expect(storage).not.toContain("\\*");
  });

  test("the rest of a paragraph is still markdown", () => {
    const storage = markdownToStorage(`[A-1](${BASE}/browse/A-1) is *done*`, { baseUrl: BASE });
    expect(storage).toContain("<em>done</em>");
  });

  test("a card on its own line is still a block", () => {
    expect(markdownToStorage(`[A-1](${BASE}/browse/A-1)<!--card-->`, { baseUrl: BASE }).trim()).toBe(
      `<a href="${BASE}/browse/A-1" data-card-appearance="card">A-1</a>`
    );
  });
});
