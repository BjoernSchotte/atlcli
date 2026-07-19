import { describe, expect, test } from "bun:test";
import { htmlToExportBlocks, isSafeLinkScheme } from "./html-to-blocks.js";
import type { ExportBlock } from "./export-blocks.js";

describe("htmlToExportBlocks — basic subset", () => {
  test("paragraphs, headings, inline marks", () => {
    const { blocks } = htmlToExportBlocks(
      `<h2>Title</h2><p>Hello <strong>bold</strong> and <em>italic</em></p>`
    );
    expect(blocks[0]).toMatchObject({ type: "heading", level: 2 });
    const p = blocks[1] as Extract<ExportBlock, { type: "paragraph" }>;
    expect(p.content.some((n) => n.type === "text" && n.marks?.includes("bold"))).toBe(true);
    expect(p.content.some((n) => n.type === "text" && n.marks?.includes("italic"))).toBe(true);
  });

  test("tables with header cells", () => {
    const { blocks } = htmlToExportBlocks(
      `<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>C</td></tr></tbody></table>`
    );
    const t = blocks[0] as Extract<ExportBlock, { type: "table" }>;
    expect(t.rows.length).toBe(2);
    expect(t.rows[0].cells[0].header).toBe(true);
  });

  test("lists and code blocks", () => {
    const { blocks } = htmlToExportBlocks(`<ul><li>one</li><li>two</li></ul><pre>code here</pre>`);
    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
    expect(blocks[1]).toMatchObject({ type: "codeBlock", code: "code here" });
  });

  test("img becomes external ImageSource tagged trust=export-view", () => {
    const { blocks } = htmlToExportBlocks(`<img src="https://cdn.example.com/a.png" alt="pic">`);
    expect(blocks[0]).toMatchObject({
      type: "image",
      source: { kind: "external", url: "https://cdn.example.com/a.png", trust: "export-view" },
    });
  });
});

describe("htmlToExportBlocks — link scheme allowlist", () => {
  test("http/https/mailto/relative allowed; javascript/file dropped to text", () => {
    expect(isSafeLinkScheme("https://x.com")).toBe(true);
    expect(isSafeLinkScheme("mailto:a@b.com")).toBe(true);
    expect(isSafeLinkScheme("/wiki/page")).toBe(true);
    expect(isSafeLinkScheme("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkScheme("file:///etc/passwd")).toBe(false);

    const { blocks } = htmlToExportBlocks(`<p><a href="javascript:alert(1)">click</a></p>`);
    const p = blocks[0] as Extract<ExportBlock, { type: "paragraph" }>;
    // text survives, but no link node
    expect(p.content.some((n) => n.type === "link")).toBe(false);
    expect(p.content.some((n) => n.type === "text" && n.text === "click")).toBe(true);
  });
});

describe("htmlToExportBlocks — active content stripping", () => {
  test("script/iframe/form content never survives, not even as text", () => {
    const { blocks } = htmlToExportBlocks(
      `<p>safe</p><script>alert('x')</script><iframe src="evil"></iframe><form><input value="y"><button>go</button></form>`
    );
    const flat = JSON.stringify(blocks);
    expect(flat).not.toContain("alert");
    expect(flat).not.toContain("evil");
    expect(flat).not.toContain("go");
    expect(flat).toContain("safe");
  });
});

describe("htmlToExportBlocks — limits (adversarial)", () => {
  test("deeply nested tags past maxDepth truncate with a note, no throw", () => {
    const deep = "<div>".repeat(100) + "x" + "</div>".repeat(100);
    const { notes } = htmlToExportBlocks(deep, { maxDepth: 10 });
    expect(notes.some((n) => n.code === "macro-degraded")).toBe(true);
  });

  test("wide sibling list past maxNodes truncates with a note", () => {
    const wide = Array.from({ length: 500 }, (_v, i) => `<p>${i}</p>`).join("");
    const { notes } = htmlToExportBlocks(wide, { maxNodes: 50 });
    expect(notes.some((n) => n.code === "macro-degraded")).toBe(true);
  });

  test("oversized input truncates with a note", () => {
    const big = "a".repeat(2000);
    const { notes } = htmlToExportBlocks(`<p>${big}</p>`, { maxInputBytes: 100 });
    expect(notes.some((n) => n.code === "macro-degraded")).toBe(true);
  });

  test("unclosed/malformed markup does not hang or throw", () => {
    const { blocks } = htmlToExportBlocks(`<p>open <strong>bold <em>nested</p><ul><li>x`);
    expect(Array.isArray(blocks)).toBe(true);
  });

  test("unknown tag is unwrapped, children kept", () => {
    const { blocks } = htmlToExportBlocks(`<custom-widget><p>inside</p></custom-widget>`);
    expect(blocks[0]).toMatchObject({ type: "paragraph" });
  });
});
