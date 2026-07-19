import { describe, expect, test } from "bun:test";
import {
  macroParamText,
  storageToBlocks,
  type ExportBlock,
  type InlineNode,
  type MacroParameter,
} from "./export-blocks.js";

/** Convenience: parse and return only the blocks. */
function blocks(storage: string): ExportBlock[] {
  return storageToBlocks(storage).blocks;
}

describe("storageToBlocks — headings", () => {
  test("emits heading level + inline content", () => {
    const out = blocks("<h1>Hello</h1><h3>World</h3>");
    expect(out).toEqual([
      { type: "heading", level: 1, content: [{ type: "text", text: "Hello" }] },
      { type: "heading", level: 3, content: [{ type: "text", text: "World" }] },
    ]);
  });

  test("preserves marks inside a heading", () => {
    const out = blocks("<h2>a <strong>bold</strong> title</h2>");
    expect(out[0]).toEqual({
      type: "heading",
      level: 2,
      content: [
        { type: "text", text: "a " },
        { type: "text", text: "bold", marks: ["bold"] },
        { type: "text", text: " title" },
      ],
    });
  });
});

describe("storageToBlocks — paragraphs & marks", () => {
  test("models marks as a typed set, not delimiters", () => {
    const out = blocks(
      "<p>plain <strong>bold</strong> <em>italic</em> <code>mono</code> <s>gone</s></p>"
    );
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([
      { type: "text", text: "plain " },
      { type: "text", text: "bold", marks: ["bold"] },
      { type: "text", text: " " },
      { type: "text", text: "italic", marks: ["italic"] },
      { type: "text", text: " " },
      { type: "text", text: "mono", marks: ["code"] },
      { type: "text", text: " " },
      { type: "text", text: "gone", marks: ["strike"] },
    ]);
  });

  test("nested marks accumulate", () => {
    const out = blocks("<p><strong><em>both</em></strong></p>");
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([{ type: "text", text: "both", marks: ["italic", "bold"] }]);
  });

  test("line breaks become lineBreak nodes", () => {
    const out = blocks("<p>a<br/>b</p>");
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([
      { type: "text", text: "a" },
      { type: "lineBreak" },
      { type: "text", text: "b" },
    ]);
  });

  test("decodes entities including numeric and nbsp", () => {
    const out = blocks("<p>a &amp; b &lt;c&gt; &#8212; d&nbsp;e</p>");
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toHaveLength(1);
    const run = content[0] as { type: "text"; text: string };
    expect(run.text).toBe(`a & b <c> — d e`);
  });

  test("decodes the full HTML named-entity set (umlauts, punctuation, charrefs)", () => {
    const out = blocks(
      "<p>&uuml;&auml;&ouml;&Uuml;&szlig; &eacute; &mdash;&hellip; &copy; &#252;&#xFC; &amp;&lt;&gt;</p>"
    );
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toHaveLength(1);
    const run = content[0] as { type: "text"; text: string };
    // Named umlauts + eszett, punctuation, decimal + hex charrefs and the
    // XML-core trio all resolve to real characters (full HTML5 entity set).
    expect(run.text).toBe("üäöÜß é —… © üü &<>");
    // Zero surviving named-entity literals.
    expect(run.text).not.toMatch(/&[a-zA-Z][a-zA-Z0-9]*;/);
  });

  test("drops empty/whitespace-only paragraphs", () => {
    expect(blocks("<p></p><p>  </p><p>real</p>")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "real" }] },
    ]);
  });
});

describe("storageToBlocks — links & mentions", () => {
  test("external link", () => {
    const out = blocks('<p><a href="https://x.test/y">label</a></p>');
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([
      { type: "link", target: { kind: "external", href: "https://x.test/y" }, content: [{ type: "text", text: "label" }] },
    ]);
  });

  test("page link carries title + space + anchor", () => {
    const out = blocks(
      '<p><ac:link ac:anchor="sec"><ri:page ri:content-title="Target" ri:space-key="DOCSY"/><ac:plain-text-link-body>see</ac:plain-text-link-body></ac:link></p>'
    );
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([
      {
        type: "link",
        target: { kind: "page", contentTitle: "Target", spaceKey: "DOCSY", anchor: "sec" },
        content: [{ type: "text", text: "see" }],
      },
    ]);
  });

  test("attachment link falls back to filename", () => {
    const out = blocks(
      '<p><ac:link><ri:attachment ri:filename="spec.pdf"/></ac:link></p>'
    );
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([
      { type: "link", target: { kind: "attachment", filename: "spec.pdf" }, content: [{ type: "text", text: "spec.pdf" }] },
    ]);
  });

  test("user mention is a distinct node carrying accountId + display name", () => {
    const out = blocks(
      '<p><ac:link><ri:user ri:account-id="abc-123"/><ac:plain-text-link-body>Jane Doe</ac:plain-text-link-body></ac:link></p>'
    );
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([{ type: "mention", accountId: "abc-123", displayName: "Jane Doe" }]);
  });

  test("mention without a display name leaves the slot open", () => {
    const out = blocks('<p><ac:link><ri:user ri:account-id="abc-123"/></ac:link></p>');
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([{ type: "mention", accountId: "abc-123" }]);
  });
});

describe("storageToBlocks — lists", () => {
  test("unordered & ordered", () => {
    expect(blocks("<ul><li>a</li><li>b</li></ul>")).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          { content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
          { content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
        ],
      },
    ]);
    expect((blocks("<ol><li>a</li></ol>")[0] as { ordered: boolean }).ordered).toBe(true);
  });

  test("nested list nests inside the item", () => {
    const out = blocks("<ul><li>top<ul><li>child</li></ul></li></ul>");
    const item = (out[0] as { items: { content: ExportBlock[] }[] }).items[0];
    expect(item.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "top" }] },
      {
        type: "list",
        ordered: false,
        items: [{ content: [{ type: "paragraph", content: [{ type: "text", text: "child" }] }] }],
      },
    ]);
  });

  test("task list carries checked state", () => {
    const out = blocks(
      "<ac:task-list>" +
        "<ac:task><ac:task-status>complete</ac:task-status><ac:task-body>done</ac:task-body></ac:task>" +
        "<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>todo</ac:task-body></ac:task>" +
        "</ac:task-list>"
    );
    expect(out).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          { content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }], checked: true },
          { content: [{ type: "paragraph", content: [{ type: "text", text: "todo" }] }], checked: false },
        ],
      },
    ]);
  });
});

describe("storageToBlocks — tables", () => {
  test("header rows + colspan/rowspan", () => {
    const out = blocks(
      "<table><tbody>" +
        '<tr><th>H1</th><th colspan="2">H2</th></tr>' +
        '<tr><td rowspan="2">a</td><td>b</td><td>c</td></tr>' +
        "</tbody></table>"
    );
    const table = out[0] as { type: "table"; rows: { cells: { header: boolean; colspan: number; rowspan: number }[] }[] };
    expect(table.type).toBe("table");
    expect(table.rows[0].cells.map((c) => [c.header, c.colspan])).toEqual([
      [true, 1],
      [true, 2],
    ]);
    expect(table.rows[1].cells[0]).toMatchObject({ header: false, rowspan: 2, colspan: 1 });
  });

  test("preserves normalized cell backgrounds from Confluence storage attributes", () => {
    const out = blocks(
      "<table><tbody><tr>" +
        '<th data-highlight-colour="#334455"><p>Dark</p></th>' +
        '<td style="width: 20px; background-color: rgb(233, 242, 255);"><p>Light</p></td>' +
        '<td bgcolor="#abc"><p>Short</p></td>' +
        '<td data-highlight-color="transparent"><p>Clear</p></td>' +
        "</tr></tbody></table>"
    );
    const table = out[0] as Extract<ExportBlock, { type: "table" }>;

    expect(table.rows[0].cells.map((cell) => cell.backgroundColor)).toEqual([
      "#334455",
      "#E9F2FF",
      "#AABBCC",
      undefined,
    ]);
  });

  test("modern Cloud markup: <colgroup> + ac:local-id + <p local-id> wrappers (regression)", () => {
    // This is the exact shape that broke the markdown table path: a leading
    // <colgroup> made <tbody> a non-first sibling. The rich walker tolerates
    // the metadata and retains the author's column proportions.
    const storage =
      '<table data-layout="default" ac:local-id="1f2e3d4c">' +
      '<colgroup><col style="width: 226.0px;"/><col style="width: 226.0px;"/></colgroup>' +
      "<tbody>" +
      '<tr><th><p local-id="a1">Name</p></th><th><p local-id="a2">Role</p></th></tr>' +
      '<tr><td><p local-id="b1">Ada</p></td><td><p local-id="b2">Engineer</p></td></tr>' +
      "</tbody></table>";
    const table = blocks(storage)[0] as {
      type: "table";
      columnWidths?: number[];
      rows: { cells: { header: boolean; content: ExportBlock[] }[] }[];
    };
    expect(table.type).toBe("table");
    expect(table.columnWidths).toEqual([226, 226]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].cells.every((c) => c.header)).toBe(true);
    expect(table.rows[0].cells[0].content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Name" }] },
    ]);
    expect(table.rows[1].cells[1].content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Engineer" }] },
    ]);
  });

  test("normalizes absolute colgroup units and expands spans", () => {
    const table = blocks(
      '<table><colgroup><col width="72pt"/><col style="width: 25.4mm" span="2"/></colgroup>' +
        '<tbody><tr><td>A</td><td>B</td><td>C</td></tr></tbody></table>'
    )[0] as Extract<ExportBlock, { type: "table" }>;
    expect(table.columnWidths).toEqual([96, 96, 96]);
  });

  test("drops incomplete colgroup widths instead of inventing proportions", () => {
    const table = blocks(
      '<table><colgroup><col style="width: 100px"/><col/></colgroup>' +
        '<tbody><tr><td>A</td><td>B</td></tr></tbody></table>'
    )[0] as Extract<ExportBlock, { type: "table" }>;
    expect(table.columnWidths).toBeUndefined();
  });
});

describe("storageToBlocks — code blocks", () => {
  test("preserves language and CDATA body", () => {
    const out = blocks(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">typescript</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[const x = 1 < 2 && 3 > 2;]]></ac:plain-text-body></ac:structured-macro>"
    );
    expect(out).toEqual([{ type: "codeBlock", language: "typescript", code: "const x = 1 < 2 && 3 > 2;" }]);
  });

  test("noformat becomes a language-less code block", () => {
    const out = blocks(
      '<ac:structured-macro ac:name="noformat"><ac:plain-text-body><![CDATA[raw]]></ac:plain-text-body></ac:structured-macro>'
    );
    expect(out).toEqual([{ type: "codeBlock", code: "raw" }]);
  });

  // Spec 004 Task 6 / F2: mermaid rendering is deferred (it needs the image module,
  // spec 005). A mermaid diagram must stay an ordinary code block carrying its source
  // — the descope path the PLAN pins ("never a broken image").
  test("mermaid stays an ordinary code block while diagram rendering is deferred", () => {
    const out = blocks(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[graph TD;\n  A-->B;]]></ac:plain-text-body></ac:structured-macro>"
    );
    expect(out).toEqual([{ type: "codeBlock", language: "mermaid", code: "graph TD;\n  A-->B;" }]);
  });
});

describe("storageToBlocks — callouts", () => {
  for (const kind of ["info", "note", "warning", "tip"] as const) {
    test(`${kind} callout with body`, () => {
      const out = blocks(
        `<ac:structured-macro ac:name="${kind}"><ac:rich-text-body><p>body</p></ac:rich-text-body></ac:structured-macro>`
      );
      expect(out).toEqual([
        { type: "callout", kind, content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] },
      ]);
    });
  }

  test("generic panel keeps its title", () => {
    const out = blocks(
      '<ac:structured-macro ac:name="panel"><ac:parameter ac:name="title">Heads up</ac:parameter>' +
        "<ac:rich-text-body><p>content</p></ac:rich-text-body></ac:structured-macro>"
    );
    expect(out).toEqual([
      {
        type: "callout",
        kind: "panel",
        title: "Heads up",
        content: [{ type: "paragraph", content: [{ type: "text", text: "content" }] }],
      },
    ]);
  });
});

describe("storageToBlocks — images", () => {
  test("attachment image with dimensions + alt", () => {
    const out = blocks(
      '<ac:image ac:width="600" ac:height="400" ac:alt="Diagram"><ri:attachment ri:filename="arch.png"/></ac:image>'
    );
    expect(out).toEqual([
      { type: "image", source: { kind: "attachment", filename: "arch.png" }, alt: "Diagram", width: 600, height: 400 },
    ]);
  });

  test("external image URL", () => {
    const out = blocks('<ac:image><ri:url ri:value="https://x.test/a.png"/></ac:image>');
    expect(out).toEqual([{ type: "image", source: { kind: "external", url: "https://x.test/a.png" } }]);
  });

  test("decodes named entities in attribute values (image alt)", () => {
    const out = blocks(
      '<ac:image ac:alt="drei &uuml;berlappende &auml;pfel &mdash; Gr&ouml;&szlig;e"><ri:attachment ri:filename="a.png"/></ac:image>'
    );
    expect(out).toEqual([
      { type: "image", source: { kind: "attachment", filename: "a.png" }, alt: "drei überlappende äpfel — Größe" },
    ]);
  });

  test("image inside a paragraph splits into its own block", () => {
    const out = blocks('<p>before <ac:image><ri:attachment ri:filename="i.png"/></ac:image> after</p>');
    expect(out).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      { type: "image", source: { kind: "attachment", filename: "i.png" } },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ]);
  });
});

describe("storageToBlocks — status macro", () => {
  test("inline status carries text + color", () => {
    const out = blocks(
      '<p>state: <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter>' +
        '<ac:parameter ac:name="title">Done</ac:parameter></ac:structured-macro></p>'
    );
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([
      { type: "text", text: "state: " },
      { type: "status", text: "Done", color: "green" },
    ]);
  });
});

describe("storageToBlocks — unknown macros", () => {
  test("unknown macro → explicit unknown block + warning note, no raw XML", () => {
    const { blocks: b, notes } = storageToBlocks(
      '<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">x</ac:parameter></ac:structured-macro>'
    );
    // Lossless capture: the block keeps its (lowercased-name) parameter, and the
    // note/no-raw-XML invariant is unchanged.
    expect(b).toEqual([
      { type: "unknown", macroName: "drawio", params: [{ name: "diagramname", text: "x" }] },
    ]);
    expect(notes).toEqual([
      { level: "warning", code: "unknown-macro", message: expect.any(String), macroName: "drawio" },
    ]);
    // Never leak raw storage XML.
    expect(JSON.stringify(b)).not.toContain("structured-macro");
  });

  test("recognized-but-unrendered macro → info note (reuses KNOWN_MACROS)", () => {
    const { blocks: b, notes } = storageToBlocks('<ac:structured-macro ac:name="jira"/>');
    expect(b).toEqual([{ type: "unknown", macroName: "jira" }]);
    expect(notes[0]).toMatchObject({ level: "info", code: "macro-not-rendered", macroName: "jira" });
  });
});

describe("storageToBlocks — lossless unknown macros", () => {
  /** Convenience: parse and return the first block as an enriched unknown block. */
  function unknownBlock(storage: string): Extract<ExportBlock, { type: "unknown" }> {
    return blocks(storage)[0] as Extract<ExportBlock, { type: "unknown" }>;
  }

  test("captures macroId + plain-text parameters; no body fields when there is no body", () => {
    const block = unknownBlock(
      '<ac:structured-macro ac:name="drawio" ac:macro-id="mid-42">' +
        '<ac:parameter ac:name="diagramName">Architecture</ac:parameter>' +
        '<ac:parameter ac:name="width">640</ac:parameter>' +
        "</ac:structured-macro>"
    );
    expect(block).toEqual({
      type: "unknown",
      macroName: "drawio",
      macroId: "mid-42",
      params: [
        { name: "diagramname", text: "Architecture" },
        { name: "width", text: "640" },
      ],
    });
    // No rich-text/plain-text body → those fields are absent entirely.
    expect(block.body).toBeUndefined();
    expect(block.plainBody).toBeUndefined();
    expect(block.bodyNotes).toBeUndefined();
  });

  test("captures an ri:page reference as a page MacroParamRef", () => {
    const block = unknownBlock(
      '<ac:structured-macro ac:name="include">' +
        '<ac:parameter ac:name="page"><ri:page ri:content-id="12345" ri:content-title="Spec" ri:space-key="DOCSY"/></ac:parameter>' +
        "</ac:structured-macro>"
    );
    expect(block.params).toEqual([
      {
        name: "page",
        refs: [{ kind: "page", contentId: "12345", contentTitle: "Spec", spaceKey: "DOCSY" }],
      },
    ]);
  });

  test("captures an ri:attachment reference", () => {
    const block = unknownBlock(
      '<ac:structured-macro ac:name="multimedia">' +
        '<ac:parameter ac:name="name"><ri:attachment ri:filename="demo.mp4"/></ac:parameter>' +
        "</ac:structured-macro>"
    );
    expect(block.params).toEqual([
      { name: "name", refs: [{ kind: "attachment", filename: "demo.mp4" }] },
    ]);
  });

  test("captures an ri:url reference", () => {
    const block = unknownBlock(
      '<ac:structured-macro ac:name="widget">' +
        '<ac:parameter ac:name="url"><ri:url ri:value="https://x.test/w"/></ac:parameter>' +
        "</ac:structured-macro>"
    );
    expect(block.params).toEqual([
      { name: "url", refs: [{ kind: "url", value: "https://x.test/w" }] },
    ]);
  });

  test("captures an ri:user reference", () => {
    const block = unknownBlock(
      '<ac:structured-macro ac:name="blog-posts">' +
        '<ac:parameter ac:name="author"><ri:user ri:account-id="acc-9"/></ac:parameter>' +
        "</ac:structured-macro>"
    );
    expect(block.params).toEqual([
      { name: "author", refs: [{ kind: "user", accountId: "acc-9" }] },
    ]);
  });

  test("captures MULTIPLE sibling ri:space refs under one parameter (blog-posts spaces)", () => {
    const block = unknownBlock(
      '<ac:structured-macro ac:name="blog-posts">' +
        '<ac:parameter ac:name="spaces"><ri:space ri:space-key="DOCSY"/><ri:space ri:space-key="ENG"/></ac:parameter>' +
        "</ac:structured-macro>"
    );
    expect(block.params).toEqual([
      {
        name: "spaces",
        refs: [
          { kind: "space", spaceKey: "DOCSY" },
          { kind: "space", spaceKey: "ENG" },
        ],
      },
    ]);
  });

  test("captures an unnamed parameter with name: \"\" (include/excerpt-include shape)", () => {
    const block = unknownBlock(
      '<ac:structured-macro ac:name="excerpt-include">' +
        '<ac:parameter ac:name=""><ri:page ri:content-id="999"/></ac:parameter>' +
        "</ac:structured-macro>"
    );
    expect(block.params).toEqual([
      { name: "", refs: [{ kind: "page", contentId: "999" }] },
    ]);
  });

  test("keeps case-colliding duplicate parameter names as ordered array entries", () => {
    const block = unknownBlock(
      '<ac:structured-macro ac:name="drawio">' +
        '<ac:parameter ac:name="Foo">first</ac:parameter>' +
        '<ac:parameter ac:name="foo">second</ac:parameter>' +
        "</ac:structured-macro>"
    );
    expect(block.params).toEqual([
      { name: "foo", text: "first" },
      { name: "foo", text: "second" },
    ]);
  });

  test("trims leading/trailing whitespace in parameter text (mirrors macroParam)", () => {
    const block = unknownBlock(
      '<ac:structured-macro ac:name="drawio">' +
        '<ac:parameter ac:name="title">   spaced value   </ac:parameter>' +
        "</ac:structured-macro>"
    );
    expect(block.params).toEqual([{ name: "title", text: "spaced value" }]);
  });

  test("walks a rich-text-body; nested-macro note stays OUT of the top-level report", () => {
    const { blocks: b, notes } = storageToBlocks(
      '<ac:structured-macro ac:name="drawio"><ac:rich-text-body>' +
        "<p>intro</p>" +
        '<ac:structured-macro ac:name="jira"/>' +
        "</ac:rich-text-body></ac:structured-macro>"
    );
    const block = b[0] as Extract<ExportBlock, { type: "unknown" }>;
    expect(block.body).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "intro" }] },
      { type: "unknown", macroName: "jira" },
    ]);
    // The top-level report has ONLY the outer macro's note — the nested
    // jira note was collected by the scratch ctx, not merged upward.
    expect(notes).toEqual([
      { level: "warning", code: "unknown-macro", message: expect.any(String), macroName: "drawio" },
    ]);
    // ...and it survives on the block as bodyNotes.
    expect(block.bodyNotes).toEqual([
      { level: "info", code: "macro-not-rendered", message: expect.any(String), macroName: "jira" },
    ]);
  });

  test("preserves a scratch-walk note that walkImage would otherwise drop (bodyNotes)", () => {
    const { blocks: b, notes } = storageToBlocks(
      '<ac:structured-macro ac:name="drawio"><ac:rich-text-body>' +
        "<p>text</p>" +
        "<ac:image></ac:image>" +
        "</ac:rich-text-body></ac:structured-macro>"
    );
    const block = b[0] as Extract<ExportBlock, { type: "unknown" }>;
    // The unresolvable image is dropped from body (as walkImage always does)...
    expect(block.body).toEqual([{ type: "paragraph", content: [{ type: "text", text: "text" }] }]);
    // ...but the observation is preserved on the block, not discarded.
    expect(block.bodyNotes).toEqual([
      { level: "warning", code: "image-unresolved", message: expect.any(String) },
    ]);
    // The top-level report never sees it.
    expect(notes.some((n) => n.code === "image-unresolved")).toBe(false);
    expect(notes).toEqual([
      { level: "warning", code: "unknown-macro", message: expect.any(String), macroName: "drawio" },
    ]);
  });

  test("captures a plain-text-body verbatim (CDATA)", () => {
    const block = unknownBlock(
      '<ac:structured-macro ac:name="drawio"><ac:plain-text-body><![CDATA[a < b && c > d]]></ac:plain-text-body></ac:structured-macro>'
    );
    expect(block.plainBody).toBe("a < b && c > d");
    expect(block.body).toBeUndefined();
  });

  test("backward-compat pin: a bare macro is just { type, macroName }", () => {
    const block = unknownBlock('<ac:structured-macro ac:name="x"/>');
    expect(block).toEqual({ type: "unknown", macroName: "x" });
  });
});

describe("macroParamText", () => {
  const params: MacroParameter[] = [
    { name: "jqlquery", text: "project = ATL" },
    { name: "page", refs: [{ kind: "page", contentId: "1" }] },
    { name: "dup", text: "first" },
    { name: "dup", text: "second" },
  ];

  test("returns a matching parameter's text case-insensitively", () => {
    expect(macroParamText(params, "jqlQuery")).toBe("project = ATL");
  });

  test("returns undefined for a ref-only parameter", () => {
    expect(macroParamText(params, "page")).toBeUndefined();
  });

  test("returns undefined for an absent parameter or absent params", () => {
    expect(macroParamText(params, "missing")).toBeUndefined();
    expect(macroParamText(undefined, "jqlQuery")).toBeUndefined();
  });

  test("returns the FIRST match when duplicate names exist", () => {
    expect(macroParamText(params, "dup")).toBe("first");
  });
});

describe("storageToBlocks — options", () => {
  test("exporter option has no semantic effect yet (deep-equal to no-options)", () => {
    const xml =
      '<h2>Mixed</h2><p>text with a <a href="https://x.test">link</a></p>' +
      '<ac:structured-macro ac:name="drawio" ac:macro-id="m1"><ac:parameter ac:name="k">v</ac:parameter>' +
      "<ac:rich-text-body><p>body</p></ac:rich-text-body></ac:structured-macro>";
    expect(storageToBlocks(xml, { exporter: "pdf" })).toEqual(storageToBlocks(xml));
    expect(storageToBlocks(xml, { exporter: "word" })).toEqual(storageToBlocks(xml));
  });
});

describe("ExportBlock — compile-shape", () => {
  test("the new/extended variants type-check as an ExportBlock[] literal", () => {
    const doc: ExportBlock[] = [
      { type: "pageBreak" },
      {
        type: "orientation",
        landscape: true,
        content: [{ type: "paragraph", content: [{ type: "text", text: "wide" }] }],
      },
      { type: "anchor", name: "sec-1" },
      { type: "codeBlock", code: "x=1", caption: { kind: "code", content: [{ type: "text", text: "Listing 1" }] } },
      {
        type: "table",
        rows: [],
        caption: { kind: "table", content: [{ type: "text", text: "Table 1" }] },
      },
      {
        type: "image",
        source: { kind: "external", url: "https://x.test/i.png" },
        caption: { kind: "figure", content: [{ type: "text", text: "Figure 1" }] },
      },
      { type: "heading", level: 2, content: [{ type: "text", text: "H" }], explicitAnchor: "h-anchor" },
    ];
    expect(doc.map((b) => b.type)).toEqual([
      "pageBreak",
      "orientation",
      "anchor",
      "codeBlock",
      "table",
      "image",
      "heading",
    ]);
  });
});

describe("storageToBlocks — misc blocks", () => {
  test("horizontal rule → divider", () => {
    expect(blocks("<hr/>")).toEqual([{ type: "divider" }]);
  });

  test("blockquote wraps its body", () => {
    expect(blocks("<blockquote><p>quoted</p></blockquote>")).toEqual([
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] },
    ]);
  });

  test("layout columns descend transparently", () => {
    const out = blocks(
      "<ac:layout><ac:layout-section><ac:layout-cell><p>left</p></ac:layout-cell>" +
        "<ac:layout-cell><p>right</p></ac:layout-cell></ac:layout-section></ac:layout>"
    );
    expect(out).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "left" }] },
      { type: "paragraph", content: [{ type: "text", text: "right" }] },
    ]);
  });
});

describe("storageToBlocks — integration (§2.1 feature zoo)", () => {
  // The spec §2.1 fixture: headings 1–4, callouts ×4, merged-cell table,
  // ordered/unordered/nested lists, code block, images, links, status macro.
  const FIXTURE =
    '<h1>Export Feature Zoo</h1>' +
    "<p>Intro with <strong>bold</strong>, <em>italic</em>, <code>code</code>, " +
    'and a <a href="https://example.test">link</a>.</p>' +
    "<h2>Callouts</h2>" +
    '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>info body</p></ac:rich-text-body></ac:structured-macro>' +
    '<ac:structured-macro ac:name="note"><ac:rich-text-body><p>note body</p></ac:rich-text-body></ac:structured-macro>' +
    '<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>warn body</p></ac:rich-text-body></ac:structured-macro>' +
    '<ac:structured-macro ac:name="tip"><ac:rich-text-body><p>tip body</p></ac:rich-text-body></ac:structured-macro>' +
    "<h3>Lists</h3>" +
    "<ul><li>bullet one</li><li>bullet two<ul><li>nested</li></ul></li></ul>" +
    "<ol><li>step one</li><li>step two</li></ol>" +
    "<h3>Table</h3>" +
    '<table><colgroup><col/><col/></colgroup><tbody>' +
    '<tr><th>Key</th><th colspan="2">Value</th></tr>' +
    "<tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>" +
    "<h4>Code</h4>" +
    '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>' +
    "<ac:plain-text-body><![CDATA[console.log(1);]]></ac:plain-text-body></ac:structured-macro>" +
    "<h4>Media & status</h4>" +
    '<ac:image ac:width="320"><ri:attachment ri:filename="pic.png"/></ac:image>' +
    '<p>Status: <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter>' +
    '<ac:parameter ac:name="title">OK</ac:parameter></ac:structured-macro> and ' +
    '<ac:link><ri:user ri:account-id="acc-1"/><ac:plain-text-link-body>Ada</ac:plain-text-link-body></ac:link>.</p>' +
    '<ac:structured-macro ac:name="drawio"/>';

  test("structural snapshot of the whole document", () => {
    const { blocks: b, notes } = storageToBlocks(FIXTURE);

    // Block-type sequence is the stable shape assertion.
    expect(b.map((blk) => blk.type)).toEqual([
      "heading", // h1
      "paragraph", // intro
      "heading", // h2 Callouts
      "callout", // info
      "callout", // note
      "callout", // warning
      "callout", // tip
      "heading", // h3 Lists
      "list", // ul (nested)
      "list", // ol
      "heading", // h3 Table
      "table",
      "heading", // h4 Code
      "codeBlock",
      "heading", // h4 Media & status
      "image",
      "paragraph", // status + mention
      "unknown", // drawio
    ]);

    // Callout kinds in order.
    expect(b.filter((blk) => blk.type === "callout").map((blk) => (blk as { kind: string }).kind)).toEqual([
      "info",
      "note",
      "warning",
      "tip",
    ]);

    // Table survived the modern-Cloud colgroup and kept the colspan.
    const table = b.find((blk) => blk.type === "table") as { rows: { cells: { colspan: number }[] }[] };
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].cells[1].colspan).toBe(2);

    // Nested list.
    const firstList = b.find((blk) => blk.type === "list") as { items: { content: ExportBlock[] }[] };
    expect(firstList.items[1].content.some((c) => c.type === "list")).toBe(true);

    // Code block language preserved.
    expect(b.find((blk) => blk.type === "codeBlock")).toEqual({
      type: "codeBlock",
      language: "js",
      code: "console.log(1);",
    });

    // Status + mention inline nodes present in the media paragraph.
    const statusPara = b[16] as { content: InlineNode[] };
    expect(statusPara.content).toContainEqual({ type: "status", text: "OK", color: "green" });
    expect(statusPara.content).toContainEqual({ type: "mention", accountId: "acc-1", displayName: "Ada" });

    // Unknown macro produced a note; no raw XML anywhere in the output.
    expect(notes.some((nt) => nt.code === "unknown-macro" && nt.macroName === "drawio")).toBe(true);
    expect(JSON.stringify(b)).not.toContain("ac:structured-macro");
  });

  test("full block-tree snapshot", () => {
    expect(storageToBlocks(FIXTURE)).toMatchSnapshot();
  });
});
