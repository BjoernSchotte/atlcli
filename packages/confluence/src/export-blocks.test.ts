import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STORAGE_PARSE_BUDGET,
  EXPORT_NOTE_CODES,
  RETIRED_EXPORT_NOTE_CODES,
  SEMANTIC_CALLOUT_ICONS,
  StorageParseError,
  canonicalExportNoteCode,
  formatAdfDateTimestamp,
  macroParamText,
  materializeTable,
  normalizeCaptionKind,
  parseXml,
  parseAdfDateTimestamp,
  resolveCalloutIcon,
  storageToBlocks,
  type ExportBlock,
  type InlineNode,
  type MacroParameter,
} from "./export-blocks.js";
import {
  CONFLUENCE_LEGACY_EMOJI_ALIASES,
  CONFLUENCE_LEGACY_EMOJI_PROJECTIONS,
} from "./emoji-projection.js";

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

  test("retains heading, paragraph, and ordinary-list-item local identities", () => {
    const result = storageToBlocks(
      '<h2 local-id="heading-1">Heading</h2>' +
        '<p ac:local-id="">Paragraph</p>' +
        '<ul><li local-id="item-1"><p>Item</p></li></ul>'
    );
    expect(result).toEqual({
      blocks: [
        {
          type: "heading",
          level: 2,
          localId: "heading-1",
          content: [{ type: "text", text: "Heading" }],
        },
        {
          type: "paragraph",
          localId: "",
          content: [{ type: "text", text: "Paragraph" }],
        },
        {
          type: "list",
          ordered: false,
          items: [{
            localId: "item-1",
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "Item" }],
            }],
          }],
        },
      ],
      notes: [],
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

  test("retains Storage emoji identity and diagnoses textual fallbacks without rewriting colon text", () => {
    const result = storageToBlocks(
      '<p>:warning: <ac:emoticon ac:name="warning" ac:emoji-shortname=":warning:" ac:emoji-fallback="⚠️"/>' +
        ' <ac:emoticon ac:name="custom-party" ac:emoji-shortname=":custom-party:" ac:emoji-fallback=":custom-party:"/>' +
        ' <ac:emoticon ac:name="empty" ac:emoji-shortname=":empty:" ac:emoji-fallback=""/></p>',
      { pageContext: { id: "page-1" } }
    );

    expect(result.blocks[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: ":warning: " },
        {
          type: "text",
          text: "⚠️",
          emoji: {
            shortName: ":warning:",
            text: "⚠️",
            renderedFrom: "source-text",
          },
        },
        { type: "text", text: " " },
        {
          type: "text",
          text: ":custom-party:",
          emoji: {
            shortName: ":custom-party:",
            text: ":custom-party:",
            renderedFrom: "short-name",
          },
        },
        { type: "text", text: " " },
        {
          type: "text",
          text: ":empty:",
          emoji: {
            shortName: ":empty:",
            text: "",
            renderedFrom: "short-name",
          },
        },
      ],
    });
    expect(result.notes).toEqual([
      expect.objectContaining({
        code: "emoji-text-fallback",
        source: expect.objectContaining({ pageId: "page-1", blockPath: "blocks[0].content[0]" }),
      }),
      expect.objectContaining({
        code: "emoji-text-fallback",
        source: expect.objectContaining({ pageId: "page-1", blockPath: "blocks[0].content[0]" }),
      }),
    ]);
  });

  test("projects typed Storage emoticons with short-name precedence", () => {
    const warning = CONFLUENCE_LEGACY_EMOJI_PROJECTIONS.warning;
    const cases = [
      {
        storage: '<ac:emoticon ac:name="warning"/>',
        expected: {
          type: "text",
          text: warning.text,
          emoji: {
            shortName: "warning",
            renderedFrom: "catalog-projection",
            projection: warning,
          },
        },
      },
      {
        storage: '<ac:emoticon ac:name="smile" ac:emoji-shortname=":warn:"/>',
        expected: {
          type: "text",
          text: warning.text,
          emoji: {
            shortName: ":warn:",
            renderedFrom: "catalog-projection",
            projection: warning,
          },
        },
      },
      {
        storage:
          '<ac:emoticon ac:name="smile" ac:emoji-shortname=":warning:" ac:emoji-fallback=":smile:"/>',
        expected: {
          type: "text",
          text: warning.text,
          emoji: {
            shortName: ":warning:",
            text: ":smile:",
            renderedFrom: "catalog-projection",
            projection: warning,
          },
        },
      },
      {
        storage:
          '<ac:emoticon ac:name="smile" ac:emoji-shortname=":warning:" ac:emoji-fallback="⚠️"/>',
        expected: {
          type: "text",
          text: "⚠️",
          emoji: {
            shortName: ":warning:",
            text: "⚠️",
            renderedFrom: "source-text",
          },
        },
      },
    ] as const;

    for (const { storage, expected } of cases) {
      const result = storageToBlocks(`<p>${storage}</p>`);
      expect(result.blocks[0]).toEqual({
        type: "paragraph",
        content: [expected],
      });
      expect(result.notes).toEqual([]);
    }

    const unknown = storageToBlocks('<p><ac:emoticon ac:name="custom-party"/></p>');
    expect(unknown.blocks[0]).toEqual({
      type: "paragraph",
      content: [{
        type: "text",
        text: "custom-party",
        emoji: {
          shortName: "custom-party",
          renderedFrom: "short-name",
        },
      }],
    });
    expect(unknown.notes).toEqual([
      expect.objectContaining({ code: "emoji-text-fallback" }),
    ]);

    expect(storageToBlocks("<p>:warning:</p>").blocks[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: ":warning:" }],
    });
  });

  test("projects all 22 canonical and 26 alias notations through Body Storage", () => {
    const canonicalCases = Object.values(CONFLUENCE_LEGACY_EMOJI_PROJECTIONS)
      .map((projection) => ({
        shortName: `:${projection.canonicalName}:`,
        projection,
      }));
    const aliasCases = Object.entries(CONFLUENCE_LEGACY_EMOJI_ALIASES)
      .map(([alias, canonicalName]) => ({
        shortName: `:${alias}:`,
        projection: CONFLUENCE_LEGACY_EMOJI_PROJECTIONS[canonicalName],
      }));
    const cases = [...canonicalCases, ...aliasCases];
    const storage = `<p>${cases.map(({ shortName }) =>
      `<ac:emoticon ac:name="smile" ac:emoji-shortname="${shortName}"/>`
    ).join("")}:+1:</p>`;
    const result = storageToBlocks(storage);

    expect(canonicalCases).toHaveLength(22);
    expect(aliasCases).toHaveLength(26);
    expect(result.blocks[0]).toEqual({
      type: "paragraph",
      content: [
        ...cases.map(({ shortName, projection }) => ({
          type: "text" as const,
          text: projection.text,
          emoji: {
            shortName,
            renderedFrom: "catalog-projection" as const,
            projection,
          },
        })),
        { type: "text", text: ":+1:" },
      ],
    });
    expect(result.notes).toEqual([]);
  });

  test("projects Cloud picker aliases through Body Storage and preserves Unicode fallbacks", () => {
    const pickerAssets = [
      { shortName: ":check_mark:", id: "atlassian-check_mark", canonicalName: "tick" },
      { shortName: ":warning:", id: "atlassian-warning", canonicalName: "warning" },
      { shortName: ":minus:", id: "atlassian-minus", canonicalName: "minus" },
      { shortName: ":question_mark:", id: "atlassian-question_mark", canonicalName: "question" },
      { shortName: ":cross_mark:", id: "atlassian-cross_mark", canonicalName: "cross" },
      { shortName: ":info:", id: "atlassian-info", canonicalName: "information" },
    ] as const;
    const storage = `<p>${pickerAssets.map(({ shortName, id }) =>
      `<ac:emoticon ac:name="smile" ac:emoji-id="${id}" ac:emoji-shortname="${shortName}" ac:emoji-fallback="${shortName}"/>`
    ).join("")}<ac:emoticon ac:name="slight-smile" ac:emoji-id="1f642" ac:emoji-shortname=":slight_smile:" ac:emoji-fallback="🙂"/></p>`;
    const result = storageToBlocks(storage);

    expect(result.blocks[0]).toEqual({
      type: "paragraph",
      content: [
        ...pickerAssets.map(({ shortName, canonicalName }) => {
          const projection = CONFLUENCE_LEGACY_EMOJI_PROJECTIONS[canonicalName];
          return {
            type: "text" as const,
            text: projection.text,
            emoji: {
              shortName,
              text: shortName,
              renderedFrom: "catalog-projection" as const,
              projection,
            },
          };
        }),
        {
          type: "text",
          text: "🙂",
          emoji: {
            shortName: ":slight_smile:",
            text: "🙂",
            renderedFrom: "source-text",
          },
        },
      ],
    });
    expect(result.notes).toEqual([]);
  });

  test("keeps a visible diagnosed floor for an invalid empty Storage emoji identity", () => {
    const result = storageToBlocks(
      '<p><ac:emoticon ac:name="warning" ac:emoji-shortname=""/></p>'
    );

    expect(result.blocks[0]).toEqual({
      type: "paragraph",
      content: [{
        type: "text",
        text: "[emoji]",
        emoji: {
          shortName: "[emoji]",
          renderedFrom: "short-name",
        },
      }],
    });
    expect(result.notes).toEqual([
      expect.objectContaining({ code: "emoji-text-fallback" }),
    ]);
  });

  test("nested marks accumulate", () => {
    const out = blocks("<p><strong><em>both</em></strong></p>");
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([{ type: "text", text: "both", marks: ["italic", "bold"] }]);
  });

  test("preserves inline foreground and background colors without confusing the two properties", () => {
    const out = blocks(
      '<p><span style="background-color: rgb(186, 243, 219);">green</span> ' +
        '<span style="color: #403294; background-color: #EED7FC"><strong>purple</strong></span> ' +
        '<span style="background-color: #FFF0B3"><a href="https://example.com">linked</a></span> ' +
        '<span style="background-color: #DEEBFF"><span style="background-color: #FDD0EC">inner</span></span></p>'
    );
    const content = (out[0] as Extract<ExportBlock, { type: "paragraph" }>).content;
    expect(content).toContainEqual({
      type: "text",
      text: "green",
      backgroundColor: "#BAF3DB",
    });
    expect(content).toContainEqual({
      type: "text",
      text: "purple",
      marks: ["bold"],
      color: "#403294",
      backgroundColor: "#EED7FC",
    });
    expect(content).toContainEqual({
      type: "link",
      target: { kind: "external", href: "https://example.com" },
      content: [{ type: "text", text: "linked", backgroundColor: "#FFF0B3" }],
    });
    expect(content).toContainEqual({
      type: "text",
      text: "inner",
      backgroundColor: "#FDD0EC",
    });
    expect(content).not.toContainEqual(
      expect.objectContaining({ text: "green", color: expect.anything() })
    );
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

describe("semantic date helpers", () => {
  test("interpret timestamps as exact epoch milliseconds and format in UTC", () => {
    expect(parseAdfDateTimestamp("1709510400000")?.toISOString()).toBe("2024-03-04T00:00:00.000Z");
    expect(formatAdfDateTimestamp("1709510400000", "de-DE")).toBe("4. März 2024");
    expect(formatAdfDateTimestamp("1709510400000", "[]")).toBe("Mar 4, 2024");
  });

  test("does not guess units or rewrite invalid source text", () => {
    expect(parseAdfDateTimestamp("1709510400")?.toISOString()).toBe("1970-01-20T18:51:50.400Z");
    expect(parseAdfDateTimestamp("1709510400.5")).toBeUndefined();
    expect(formatAdfDateTimestamp("not-a-timestamp", "de-DE")).toBe("not-a-timestamp");
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

  test("preserves an authored Storage smart-link appearance", () => {
    const out = blocks(
      '<p><a href="https://tenant-a.atlassian.net/wiki/spaces/DEMO/pages/1001" data-card-appearance="inline" local-id="card-1">Decision page</a></p>',
    );
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([{
      type: "smartCard",
      card: {
        appearance: "inline",
        source: "url",
        url: "https://tenant-a.atlassian.net/wiki/spaces/DEMO/pages/1001",
        target: {
          kind: "external",
          href: "https://tenant-a.atlassian.net/wiki/spaces/DEMO/pages/1001",
        },
        title: "Decision page",
        localId: "card-1",
      },
    }]);
  });

  test("Confluence ri:url link preserves its target and rich display text", () => {
    const out = blocks(
      '<p>See <ac:link><ri:url ri:value="https://x.test/y"/>' +
        '<ac:link-body>the <strong>guide</strong></ac:link-body></ac:link>.</p>'
    );
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([
      { type: "text", text: "See " },
      {
        type: "link",
        target: { kind: "external", href: "https://x.test/y" },
        content: [
          { type: "text", text: "the " },
          { type: "text", text: "guide", marks: ["bold"] },
        ],
      },
      { type: "text", text: "." },
    ]);
  });

  test("Confluence ri:url link falls back to its visible URL inside a table", () => {
    const href = "https://x.test/a/very/long/path/that/can/wrap/in/a/narrow/table/cell";
    const out = blocks(
      `<table><tbody><tr><td><p><ac:link><ri:url ri:value="${href}"/></ac:link></p></td></tr></tbody></table>`
    );
    const table = out[0] as Extract<ExportBlock, { type: "table" }>;
    const paragraph = table.rows[0]!.cells[0]!.content[0] as Extract<
      ExportBlock,
      { type: "paragraph" }
    >;
    expect(paragraph.content).toEqual([
      {
        type: "link",
        target: { kind: "external", href },
        content: [{ type: "text", text: href }],
      },
    ]);
  });

  test("Confluence ri:url emits only the sanitized target and fallback text", () => {
    const out = blocks(
      '<p><ac:link><ri:url ri:value="https://exa&#x9;mple.com/path"/></ac:link></p>'
    );
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([
      {
        type: "link",
        target: { kind: "external", href: "https://example.com/path" },
        content: [{ type: "text", text: "https://example.com/path" }],
      },
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

  test("page link carries ri:content-id when the page picker emitted one", () => {
    const out = blocks(
      '<p><ac:link ac:anchor="sec"><ri:page ri:content-id="123456" ri:content-title="Target" ri:space-key="DOCSY"/><ac:plain-text-link-body>see</ac:plain-text-link-body></ac:link></p>'
    );
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([
      {
        type: "link",
        target: { kind: "page", contentTitle: "Target", contentId: "123456", spaceKey: "DOCSY", anchor: "sec" },
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

  test("ordered lists retain a non-default authored start", () => {
    expect(blocks('<ol start="0"><li>a</li></ol>')[0]).toMatchObject({
      type: "list",
      ordered: true,
      start: 0,
    });
    expect(blocks('<ol start="-1"><li>a</li></ol>')[0]).not.toHaveProperty("start");
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
      '<ac:task-list ac:local-id="tasks-root">' +
        "<ac:task><ac:task-id>task-done</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>done</ac:task-body></ac:task>" +
        "<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>todo</ac:task-body></ac:task>" +
        "</ac:task-list>"
    );
    expect(out).toEqual([
      {
        type: "list",
        ordered: false,
        listKind: "task",
        localId: "tasks-root",
        items: [
          {
            content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }],
            kind: "task",
            state: "DONE",
            localId: "task-done",
            checked: true,
          },
          {
            content: [{ type: "paragraph", content: [{ type: "text", text: "todo" }] }],
            kind: "task",
            state: "TODO",
            checked: false,
          },
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

  test("preserves Storage table identity and vertical alignment", () => {
    const table = blocks(
      '<table data-layout="align-start" ac:local-id="table-id"><tbody>' +
        '<tr ac:local-id=""><td ac:local-id="cell-id" style="vertical-align: middle"><p>Middle</p></td>' +
        '<td valign="bottom"><p>Bottom</p></td></tr>' +
        "</tbody></table>",
    )[0] as Extract<ExportBlock, { type: "table" }>;

    expect(table.presentation).toEqual({ layout: "align-start", localId: "table-id" });
    expect(table.rows[0].localId).toBe("");
    expect(table.rows[0].cells[0]).toMatchObject({
      localId: "cell-id",
      verticalAlignment: "middle",
    });
    expect(table.rows[0].cells[1].verticalAlignment).toBe("bottom");
  });

  test("materializes the implicit ADF numbered column identically for all renderers", () => {
    const table: Extract<ExportBlock, { type: "table" }> = {
      type: "table",
      presentation: { numberedColumn: true, width: 480 },
      rows: [
        {
          localId: "row-1",
          cells: [{
            header: true,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }],
          }],
        },
        {
          cells: [{
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }],
          }],
        },
      ],
    };

    const materialized = materializeTable(table);
    expect(materialized.rows.map((row) => row.cells[0].content)).toEqual([
      [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
      [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
    ]);
    expect(materialized.rows[0].localId).toBe("row-1");
    expect(materialized.columnWidths).toEqual([48, 432]);
    expect(table.rows[0].cells).toHaveLength(1);
  });

  test("bounds numbered-column width derivation before either renderer allocates tracks", () => {
    const table: Extract<ExportBlock, { type: "table" }> = {
      type: "table",
      presentation: { numberedColumn: true },
      rows: [{
        cells: [{
          header: false,
          colspan: Number.MAX_SAFE_INTEGER,
          rowspan: 1,
          content: [],
        }],
      }],
    };
    expect(materializeTable(table).columnWidths).toHaveLength(201);

    const oversizedAuthoredTracks = {
      ...table,
      rows: [{
        cells: [{
          header: false,
          colspan: 1,
          rowspan: 1,
          content: [],
        }],
      }],
      columnWidths: Array.from({ length: 10_000 }, () => 1),
    } satisfies Extract<ExportBlock, { type: "table" }>;
    expect(materializeTable(oversizedAuthoredTracks).columnWidths).toHaveLength(2);
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
      { type: "paragraph", localId: "a1", content: [{ type: "text", text: "Name" }] },
    ]);
    expect(table.rows[1].cells[1].content).toEqual([
      { type: "paragraph", localId: "b2", content: [{ type: "text", text: "Engineer" }] },
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
    expect(out).toEqual([{
      type: "codeBlock",
      language: "typescript",
      code: "const x = 1 < 2 && 3 > 2;",
      hideLineNumbers: true,
    }]);
  });

  test("noformat becomes a language-less code block", () => {
    const out = blocks(
      '<ac:structured-macro ac:name="noformat"><ac:plain-text-body><![CDATA[raw]]></ac:plain-text-body></ac:structured-macro>'
    );
    expect(out).toEqual([{ type: "codeBlock", code: "raw", hideLineNumbers: true }]);
  });

  // Spec 004 Task 6 / F2: mermaid rendering is deferred (it needs the image module,
  // spec 005). A mermaid diagram must stay an ordinary code block carrying its source
  // — the descope path the PLAN pins ("never a broken image").
  test("mermaid stays an ordinary code block while diagram rendering is deferred", () => {
    const out = blocks(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[graph TD;\n  A-->B;]]></ac:plain-text-body></ac:structured-macro>"
    );
    expect(out).toEqual([{
      type: "codeBlock",
      language: "mermaid",
      code: "graph TD;\n  A-->B;",
      hideLineNumbers: true,
    }]);
  });

  test("retains Storage code-macro line numbers, first ordinal, and macro identity", () => {
    const out = blocks(
      '<ac:structured-macro ac:name="code" ac:local-id="code-local">' +
        '<ac:parameter ac:name="linenumbers">true</ac:parameter>' +
        '<ac:parameter ac:name="firstline">7</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[first\nsecond]]></ac:plain-text-body>" +
        "</ac:structured-macro>"
    );
    expect(out).toEqual([{
      type: "codeBlock",
      code: "first\nsecond",
      hideLineNumbers: false,
      firstLineNumber: 7,
      localId: "code-local",
    }]);
  });

  test("retains the legacy title and explicit collapse state independently", () => {
    const out = blocks(
      '<ac:structured-macro ac:name="code">' +
        '<ac:parameter ac:name="title">Deployment &amp; rollback</ac:parameter>' +
        '<ac:parameter ac:name="collapse">TRUE</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[first]]></ac:plain-text-body>" +
        "</ac:structured-macro>" +
        '<ac:structured-macro ac:name="code">' +
        '<ac:parameter ac:name="title"></ac:parameter>' +
        '<ac:parameter ac:name="collapse">false</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[second]]></ac:plain-text-body>" +
        "</ac:structured-macro>"
    );

    expect(out).toEqual([
      {
        type: "codeBlock",
        code: "first",
        title: "Deployment & rollback",
        initiallyCollapsed: true,
        hideLineNumbers: true,
      },
      {
        type: "codeBlock",
        code: "second",
        title: "",
        initiallyCollapsed: false,
        hideLineNumbers: true,
      },
    ]);
  });
});

describe("storageToBlocks — callouts", () => {
  for (const kind of ["info", "note", "warning", "tip", "success", "error"] as const) {
    test(`${kind} callout with body`, () => {
      const out = blocks(
        `<ac:structured-macro ac:name="${kind}"><ac:rich-text-body><p>body</p></ac:rich-text-body></ac:structured-macro>`
      );
      expect(out).toEqual([
        { type: "callout", kind, content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] },
      ]);
    });
  }

  test("semantic registry is exhaustive and explicit source icons always win", () => {
    expect(SEMANTIC_CALLOUT_ICONS).toEqual({
      info: { kind: "info", symbol: "ℹ", label: "Info" },
      note: { kind: "note", symbol: "✎", label: "Note" },
      warning: { kind: "warning", symbol: "⚠", label: "Warning" },
      tip: { kind: "tip", symbol: "💡", label: "Tip" },
      success: { kind: "success", symbol: "✓", label: "Success" },
      error: { kind: "error", symbol: "✕", label: "Error" },
    });
    for (const icon of Object.values(SEMANTIC_CALLOUT_ICONS)) {
      expect(resolveCalloutIcon({ kind: icon.kind })).toEqual({
        source: "semantic-default",
        icon,
      });
    }

    expect(resolveCalloutIcon({ kind: "warning", panelIconText: "🧭", panelIcon: ":warning:" }))
      .toEqual({ source: "explicit", text: "🧭" });
    expect(resolveCalloutIcon({ kind: "warning", panelIcon: "🦜" }))
      .toEqual({ source: "explicit", text: "🦜" });
    expect(resolveCalloutIcon({
      kind: "warning",
      panelIcon: ":warning:",
      panelIconProjection: CONFLUENCE_LEGACY_EMOJI_PROJECTIONS.warning,
    })).toEqual({ source: "explicit", text: "⚠" });
    expect(resolveCalloutIcon({ kind: "warning", panelIcon: ":custom-visible:" }))
      .toEqual({ source: "explicit", text: ":custom-visible:" });
    expect(resolveCalloutIcon({ kind: "panel" })).toBeUndefined();
    expect(resolveCalloutIcon({ kind: "warning", suppressDefaultIcon: true })).toBeUndefined();
  });

  for (const kind of ["info", "note", "warning", "tip"] as const) {
    test(`${kind} preserves the Data Center icon=false author choice`, () => {
      const out = blocks(
        `<ac:structured-macro ac:name="${kind}">` +
          '<ac:parameter ac:name="icon"> FALSE </ac:parameter>' +
          "<ac:rich-text-body><p>body</p></ac:rich-text-body>" +
        "</ac:structured-macro>"
      );
      expect(out[0]).toMatchObject({
        type: "callout",
        kind,
        suppressDefaultIcon: true,
      });
      expect(resolveCalloutIcon(out[0] as Extract<ExportBlock, { type: "callout" }>))
        .toBeUndefined();
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

  test("retains Storage expand identity and marks table-cell expands as nested", () => {
    const result = storageToBlocks(
      '<ac:structured-macro ac:name="expand" ac:local-id="" ac:macro-id="expand-root">' +
        '<ac:parameter ac:name="title"></ac:parameter>' +
        '<ac:rich-text-body><p>Outer body</p>' +
          '<ac:structured-macro ac:name="expand" ac:macro-id="expand-child">' +
            '<ac:parameter ac:name="title">Child details</ac:parameter>' +
            '<ac:rich-text-body><p>Child body</p></ac:rich-text-body>' +
          '</ac:structured-macro>' +
        '</ac:rich-text-body>' +
      '</ac:structured-macro>' +
      '<table><tbody><tr><td>' +
        '<ac:structured-macro ac:name="expand" ac:local-id="nested-local" ac:macro-id="expand-nested">' +
          '<ac:parameter ac:name="title">Nested details</ac:parameter>' +
          '<ac:rich-text-body><p>Nested body</p></ac:rich-text-body>' +
        '</ac:structured-macro>' +
      '</td></tr></tbody></table>',
      { pageContext: { id: "page-1", version: 4 } },
    );

    expect(result.blocks).toEqual([
      {
        type: "expand",
        nested: false,
        title: "",
        localId: "",
        macroId: "expand-root",
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: "Outer body" }],
        }, {
          type: "expand",
          nested: true,
          title: "Child details",
          macroId: "expand-child",
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Child body" }],
          }],
        }],
      },
      {
        type: "table",
        rows: [{
          cells: [{
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{
              type: "expand",
              nested: true,
              title: "Nested details",
              localId: "nested-local",
              macroId: "expand-nested",
              content: [{
                type: "paragraph",
                content: [{ type: "text", text: "Nested body" }],
              }],
            }],
          }],
        }],
      },
    ]);
    expect(result.notes).toEqual([
      expect.objectContaining({
        level: "info",
        code: "expand-static",
        source: expect.objectContaining({ pageId: "page-1", blockPath: "blocks[0]" }),
      }),
      expect.objectContaining({
        level: "info",
        code: "expand-static",
        source: expect.objectContaining({
          pageId: "page-1",
          blockPath: "blocks[0].content[1]",
        }),
      }),
      expect.objectContaining({
        level: "info",
        code: "expand-static",
        source: expect.objectContaining({
          pageId: "page-1",
          blockPath: "blocks[1].content[0]",
        }),
      }),
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

  test("retains subtle status style", () => {
    const out = blocks(
      '<p><ac:structured-macro ac:name="status">' +
        '<ac:parameter ac:name="colour">Purple</ac:parameter>' +
        '<ac:parameter ac:name="title">Mixed source</ac:parameter>' +
        '<ac:parameter ac:name="subtle">true</ac:parameter>' +
      '</ac:structured-macro></p>'
    );
    expect((out[0] as { content: InlineNode[] }).content).toEqual([
      { type: "status", text: "Mixed source", color: "purple", style: "subtle" },
    ]);
  });
});

describe("storageToBlocks — semantic dates and template placeholders", () => {
  test("normalizes time and legacy date macro values to epoch milliseconds", () => {
    const result = storageToBlocks(
      '<p><time datetime="2024-01-01"/> ' +
        '<ac:structured-macro ac:name="date">' +
          '<ac:parameter ac:name="">2024-01-02</ac:parameter>' +
        '</ac:structured-macro></p>'
    );
    expect(result.blocks).toEqual([{
      type: "paragraph",
      content: [
        { type: "date", timestamp: "1704067200000" },
        { type: "text", text: " " },
        { type: "date", timestamp: "1704153600000" },
      ],
    }]);
    expect(result.notes).toEqual([]);
  });

  test("retains placeholder identity but treats it as editor-only content", () => {
    const result = storageToBlocks(
      '<p>before<ac:placeholder ac:type="mention">Choose a person</ac:placeholder>after</p>'
    );
    expect(result).toEqual({
      blocks: [{
        type: "paragraph",
        content: [
          { type: "text", text: "before" },
          { type: "placeholder", text: "Choose a person", placeholderType: "mention" },
          { type: "text", text: "after" },
        ],
      }],
      notes: [],
    });
  });

  test("retains invalid date source text with a typed warning", () => {
    const result = storageToBlocks(
      '<p><time datetime="not-a-date"/></p>',
      { pageContext: { id: "page-1" } }
    );
    expect(result.blocks).toEqual([{
      type: "paragraph",
      content: [{ type: "date", timestamp: "not-a-date" }],
    }]);
    expect(result.notes).toEqual([expect.objectContaining({
      level: "warning",
      code: "date-invalid",
      source: expect.objectContaining({ pageId: "page-1", blockPath: "blocks[0].content[0]" }),
    })]);
  });

  test("does not guess locale-shaped dates but accepts explicitly zoned ISO timestamps", () => {
    const result = storageToBlocks(
      '<p><time datetime="03/04/2024"/> ' +
        '<time datetime="2024-03-04T10:30:00+01:00"/></p>'
    );
    expect(result.blocks).toEqual([{
      type: "paragraph",
      content: [
        { type: "date", timestamp: "03/04/2024" },
        { type: "text", text: " " },
        { type: "date", timestamp: "1709544600000" },
      ],
    }]);
    expect(result.notes).toEqual([expect.objectContaining({
      level: "warning",
      code: "date-invalid",
    })]);
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

describe("storageToBlocks — anchor macro", () => {
  test("anchor macro round-trips to an anchor block, not an unknown one", () => {
    const { blocks: b, notes } = storageToBlocks(
      '<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">myanchor</ac:parameter></ac:structured-macro>'
    );
    expect(b).toEqual([{ type: "anchor", name: "myanchor" }]);
    // No unknown-macro / macro-not-rendered note is produced for a mapped macro.
    expect(notes).toEqual([]);
    expect(JSON.stringify(b)).not.toContain("unknown");
  });

  test("anchor macro with an omitted ac:name attribute still resolves its name", () => {
    const b = blocks(
      '<ac:structured-macro ac:name="anchor"><ac:parameter>bare</ac:parameter></ac:structured-macro>'
    );
    expect(b).toEqual([{ type: "anchor", name: "bare" }]);
  });

  test("nameless anchor macro falls back to lossless unknown capture", () => {
    const { blocks: b } = storageToBlocks('<ac:structured-macro ac:name="anchor"/>');
    expect(b).toEqual([{ type: "unknown", macroName: "anchor" }]);
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
  test("exporter option leaves non-export-control content exporter-blind", () => {
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

  test("Storage layout sections preserve named column proportions and content ownership", () => {
    const out = blocks(
      '<ac:layout><ac:layout-section ac:type="two_left_sidebar" ac:local-id="layout-local">' +
        '<ac:layout-cell ac:local-id="left-local" valign="middle"><p>left</p></ac:layout-cell>' +
        '<ac:layout-cell ac:local-id="" style="vertical-align: bottom"><p>right</p></ac:layout-cell>' +
        "</ac:layout-section></ac:layout>"
    );
    expect(out).toEqual([
      {
        type: "layout",
        columns: [
          {
            width: 30,
            verticalAlignment: "middle",
            localId: "left-local",
            content: [{ type: "paragraph", content: [{ type: "text", text: "left" }] }],
          },
          {
            width: 70,
            verticalAlignment: "bottom",
            localId: "",
            content: [{ type: "paragraph", content: [{ type: "text", text: "right" }] }],
          },
        ],
        localId: "layout-local",
      },
    ]);
  });

  test("Storage layout shape mismatch stays visible and uses equal portable tracks", () => {
    const result = storageToBlocks(
      '<ac:layout><ac:layout-section ac:type="three_equal">' +
        "<ac:layout-cell><p>left</p></ac:layout-cell>" +
        "<ac:layout-cell><p>right</p></ac:layout-cell>" +
        "</ac:layout-section></ac:layout>",
      { pageContext: { id: "source-page" } },
    );
    expect((result.blocks[0] as Extract<ExportBlock, { type: "layout" }>)
      .columns.map((column) => column.width)).toEqual([50, 50]);
    expect(result.notes).toContainEqual(expect.objectContaining({
      code: "layout-geometry-fallback",
      source: expect.objectContaining({ pageId: "source-page" }),
    }));
  });

  test("legacy section/column macros flatten without placeholder blocks", () => {
    const storage =
      '<ac:structured-macro ac:name="section"><ac:rich-text-body>' +
      '<ac:structured-macro ac:name="column"><ac:parameter ac:name="width">40%</ac:parameter>' +
      "<ac:rich-text-body><p>left</p></ac:rich-text-body></ac:structured-macro>" +
      '<ac:structured-macro ac:name="column"><ac:parameter ac:name="width">60%</ac:parameter>' +
      "<ac:rich-text-body><p>right</p></ac:rich-text-body></ac:structured-macro>" +
      "</ac:rich-text-body></ac:structured-macro>";
    const out = storageToBlocks(storage);

    expect(out.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "left" }] },
      { type: "paragraph", content: [{ type: "text", text: "right" }] },
    ]);
    expect(JSON.stringify(out.blocks)).not.toContain("macro not rendered");
    expect(out.notes).toEqual([]);
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
      hideLineNumbers: true,
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

// ===========================================================================
// spec 003 — scroll-* compatibility macros (C3/C4/C5/C6)
// ===========================================================================
//
// Storage fixtures for the K15t Scroll compatibility macros. NOTE: these
// fragments are modeled on the documented Scroll storage shape (body-wrapped
// `ac:rich-text-body`, an `exporter` selection parameter). The exact macro
// names, the `exporter` parameter's value set, and the scroll-title/orientation
// body wrapping are UNVERIFIED against a live instance (see PLAN "Risks"); the
// walker fails safe (include + warn) for anything it does not recognize. When
// the live E2E fixture capture runs, these fragments should be reconciled with
// the real `body.storage` and any drift corrected here.

/** A scroll-only/scroll-ignore macro with an optional exporter parameter. */
function scrollControl(name: string, exporter: string | null, body: string): string {
  const param = exporter === null ? "" : `<ac:parameter ac:name="exporter">${exporter}</ac:parameter>`;
  return `<ac:structured-macro ac:name="${name}">${param}<ac:rich-text-body>${body}</ac:rich-text-body></ac:structured-macro>`;
}

describe("storageToBlocks — C4 scroll-only / scroll-ignore (block)", () => {
  const only = (exp: string | null) => scrollControl("scroll-only", exp, "<p>secret</p>");
  const ignore = (exp: string | null) => scrollControl("scroll-ignore", exp, "<p>internal</p>");

  test("scroll-only: absent param keeps body + applied note", () => {
    const { blocks: b, notes } = storageToBlocks(only(null), { exporter: "word" });
    expect(b).toEqual([{ type: "paragraph", content: [{ type: "text", text: "secret" }] }]);
    expect(notes.map((n) => n.code)).toEqual(["scroll-only-applied"]);
  });

  test("scroll-only: matching exporter keeps body", () => {
    const { blocks: b, notes } = storageToBlocks(only("word"), { exporter: "word" });
    expect(b).toEqual([{ type: "paragraph", content: [{ type: "text", text: "secret" }] }]);
    expect(notes[0]!.code).toBe("scroll-only-applied");
  });

  test("web is an explicit exporter identity, not an unknown fallback", () => {
    const webOnly = storageToBlocks(only("web"), { exporter: "web" });
    expect(webOnly.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "secret" }] }]);
    expect(webOnly.notes.map((note) => note.code)).toEqual(["scroll-only-applied"]);

    const webIgnore = storageToBlocks(ignore("web"), { exporter: "web" });
    expect(webIgnore.blocks).toEqual([]);
    expect(webIgnore.notes.map((note) => note.code)).toEqual(["scroll-ignore-applied"]);

    const wordOnly = storageToBlocks(only("web"), { exporter: "word" });
    expect(wordOnly.blocks).toEqual([]);
    expect(wordOnly.notes.map((note) => note.code)).toEqual(["scroll-only-skipped-other-exporter"]);
  });

  test("scroll-only: mismatching exporter DROPS body (opposite of no-op) + note", () => {
    const { blocks: b, notes } = storageToBlocks(only("pdf"), { exporter: "word" });
    expect(b).toEqual([]);
    expect(notes.map((n) => n.code)).toEqual(["scroll-only-skipped-other-exporter"]);
  });

  test("scroll-ignore: absent param DROPS body + applied note", () => {
    const { blocks: b, notes } = storageToBlocks(ignore(null), { exporter: "word" });
    expect(b).toEqual([]);
    expect(notes.map((n) => n.code)).toEqual(["scroll-ignore-applied"]);
  });

  test("scroll-ignore: matching exporter DROPS body", () => {
    const { blocks: b } = storageToBlocks(ignore("word"), { exporter: "word" });
    expect(b).toEqual([]);
  });

  test("scroll-ignore: mismatching exporter KEEPS body (opposite of drop) + note", () => {
    const { blocks: b, notes } = storageToBlocks(ignore("pdf"), { exporter: "word" });
    expect(b).toEqual([{ type: "paragraph", content: [{ type: "text", text: "internal" }] }]);
    expect(notes.map((n) => n.code)).toEqual(["scroll-ignore-skipped-other-exporter"]);
  });

  test("unknown exporter value fails safe: both macros keep body + warning", () => {
    const only = storageToBlocks(scrollControl("scroll-only", "banana", "<p>x</p>"), { exporter: "word" });
    expect(only.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "x" }] }]);
    expect(only.notes[0]).toMatchObject({ level: "warning", code: "scroll-only-unknown-exporter" });

    const ignore = storageToBlocks(scrollControl("scroll-ignore", "banana", "<p>y</p>"), { exporter: "word" });
    expect(ignore.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "y" }] }]);
    expect(ignore.notes[0]).toMatchObject({ level: "warning", code: "scroll-ignore-unknown-exporter" });
  });

  test("no exporter identity treats a param as absent (apply both unconditionally)", () => {
    // scroll-only keeps (cannot determine exclusion), scroll-ignore drops.
    expect(storageToBlocks(only("pdf")).blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "secret" }] },
    ]);
    expect(storageToBlocks(ignore("pdf")).blocks).toEqual([]);
  });

  test("exportControls: passthrough keeps BOTH bodies + passthrough note", () => {
    const onlyOut = storageToBlocks(only("pdf"), { exporter: "word", exportControls: "passthrough" });
    expect(onlyOut.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "secret" }] }]);
    expect(onlyOut.notes.map((n) => n.code)).toEqual(["export-controls-passthrough"]);

    const ignoreOut = storageToBlocks(ignore(null), { exporter: "word", exportControls: "passthrough" });
    expect(ignoreOut.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "internal" }] }]);
    expect(ignoreOut.notes.map((n) => n.code)).toEqual(["export-controls-passthrough"]);
  });

  test("regression: scroll macros never reach the unknown-macro placeholder path", () => {
    const { blocks: b, notes } = storageToBlocks(only(null), { exporter: "word" });
    expect(JSON.stringify(b)).not.toContain("unknown");
    expect(notes.some((n) => n.code === "unknown-macro" || n.code === "macro-not-rendered")).toBe(false);
  });
});

describe("storageToBlocks — C4 scroll-only-inline / scroll-ignore-inline", () => {
  const inlineControl = (name: string, exp: string | null) => {
    const param = exp === null ? "" : `<ac:parameter ac:name="exporter">${exp}</ac:parameter>`;
    return `<p>before <ac:structured-macro ac:name="${name}">${param}<ac:rich-text-body>MID</ac:rich-text-body></ac:structured-macro> after</p>`;
  };

  test("scroll-ignore-inline: absent param drops inline content + note", () => {
    const { blocks: b, notes } = storageToBlocks(inlineControl("scroll-ignore-inline", null), { exporter: "word" });
    const content = (b[0] as { content: InlineNode[] }).content;
    expect(content).toEqual([
      { type: "text", text: "before " },
      { type: "text", text: " after" },
    ]);
    expect(notes.map((n) => n.code)).toEqual(["scroll-ignore-applied"]);
  });

  test("scroll-only-inline: matching exporter keeps inline content", () => {
    const { blocks: b } = storageToBlocks(inlineControl("scroll-only-inline", "word"), { exporter: "word" });
    const content = (b[0] as { content: InlineNode[] }).content;
    expect(content).toContainEqual({ type: "text", text: "MID" });
  });

  test("scroll-only-inline: mismatching exporter drops inline content", () => {
    const { blocks: b, notes } = storageToBlocks(inlineControl("scroll-only-inline", "pdf"), { exporter: "word" });
    const content = (b[0] as { content: InlineNode[] }).content;
    expect(content.some((n) => n.type === "text" && n.text === "MID")).toBe(false);
    expect(notes.map((n) => n.code)).toEqual(["scroll-only-skipped-other-exporter"]);
  });

  test("passthrough keeps inline content regardless of exporter", () => {
    const { blocks: b } = storageToBlocks(inlineControl("scroll-ignore-inline", null), {
      exporter: "word",
      exportControls: "passthrough",
    });
    const content = (b[0] as { content: InlineNode[] }).content;
    expect(content).toContainEqual({ type: "text", text: "MID" });
  });
});

describe("storageToBlocks — C5 scroll-pagebreak", () => {
  test("emits a pageBreak block", () => {
    const { blocks: b, notes } = storageToBlocks('<ac:structured-macro ac:name="scroll-pagebreak"/>');
    expect(b).toEqual([{ type: "pageBreak" }]);
    expect(notes).toEqual([]);
  });

  test("regression: scroll-pagebreak no longer reaches the unknown path", () => {
    const { blocks: b } = storageToBlocks('<p>a</p><ac:structured-macro ac:name="scroll-pagebreak"/><p>b</p>');
    expect(b).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "a" }] },
      { type: "pageBreak" },
      { type: "paragraph", content: [{ type: "text", text: "b" }] },
    ]);
  });
});

describe("storageToBlocks — C6 scroll-landscape / scroll-portrait", () => {
  test("scroll-landscape → orientation region (landscape: true)", () => {
    const xml = '<ac:structured-macro ac:name="scroll-landscape"><ac:rich-text-body><p>wide</p></ac:rich-text-body></ac:structured-macro>';
    expect(storageToBlocks(xml).blocks).toEqual([
      { type: "orientation", landscape: true, content: [{ type: "paragraph", content: [{ type: "text", text: "wide" }] }] },
    ]);
  });

  test("scroll-portrait → orientation region (landscape: false)", () => {
    const xml = '<ac:structured-macro ac:name="scroll-portrait"><ac:rich-text-body><p>tall</p></ac:rich-text-body></ac:structured-macro>';
    expect(storageToBlocks(xml).blocks).toEqual([
      { type: "orientation", landscape: false, content: [{ type: "paragraph", content: [{ type: "text", text: "tall" }] }] },
    ]);
  });

  test("nested orientation: outer wins + warning note (inner flattened)", () => {
    const inner = '<ac:structured-macro ac:name="scroll-portrait"><ac:rich-text-body><p>inner</p></ac:rich-text-body></ac:structured-macro>';
    const xml = `<ac:structured-macro ac:name="scroll-landscape"><ac:rich-text-body><p>outer</p>${inner}</ac:rich-text-body></ac:structured-macro>`;
    const { blocks: b, notes } = storageToBlocks(xml);
    expect(b).toEqual([
      {
        type: "orientation",
        landscape: true,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "outer" }] },
          { type: "paragraph", content: [{ type: "text", text: "inner" }] },
        ],
      },
    ]);
    expect(notes.map((n) => n.code)).toEqual(["orientation-nested-collapsed"]);
  });
});

describe("storageToBlocks — C3 scroll-title captions", () => {
  test("attaches a caption to the first captionable block (image → figure)", () => {
    const xml =
      '<ac:structured-macro ac:name="scroll-title">' +
      '<ac:parameter ac:name="title">Architecture overview</ac:parameter>' +
      '<ac:rich-text-body><ac:image><ri:attachment ri:filename="arch.png"/></ac:image></ac:rich-text-body>' +
      "</ac:structured-macro>";
    const { blocks: b, notes } = storageToBlocks(xml);
    expect(b).toEqual([
      {
        type: "image",
        source: { kind: "attachment", filename: "arch.png" },
        alt: undefined,
        width: undefined,
        height: undefined,
        caption: { kind: "figure", content: [{ type: "text", text: "Architecture overview" }] },
      },
    ]);
    expect(notes).toEqual([]);
  });

  test("declared type wins over target block type (type=table on an image)", () => {
    const xml =
      '<ac:structured-macro ac:name="scroll-title">' +
      '<ac:parameter ac:name="type">table</ac:parameter>' +
      '<ac:parameter ac:name="title">Matrix</ac:parameter>' +
      '<ac:rich-text-body><ac:image><ri:attachment ri:filename="m.png"/></ac:image></ac:rich-text-body>' +
      "</ac:structured-macro>";
    const img = storageToBlocks(xml).blocks[0] as Extract<ExportBlock, { type: "image" }>;
    expect(img.caption?.kind).toBe("table");
  });

  test("unknown caption kind falls back to natural kind + warning note", () => {
    const xml =
      '<ac:structured-macro ac:name="scroll-title">' +
      '<ac:parameter ac:name="type">diagram</ac:parameter>' +
      '<ac:parameter ac:name="title">X</ac:parameter>' +
      '<ac:rich-text-body><table><tbody><tr><td>c</td></tr></tbody></table></ac:rich-text-body>' +
      "</ac:structured-macro>";
    const { blocks: b, notes } = storageToBlocks(xml);
    const table = b[0] as Extract<ExportBlock, { type: "table" }>;
    expect(table.caption?.kind).toBe("table");
    expect(notes.map((n) => n.code)).toEqual(["caption-kind-unknown"]);
  });

  test("no captionable block → italic caption paragraph + fallback note", () => {
    const xml =
      '<ac:structured-macro ac:name="scroll-title">' +
      '<ac:parameter ac:name="title">Orphan caption</ac:parameter>' +
      '<ac:rich-text-body><p>just text</p></ac:rich-text-body>' +
      "</ac:structured-macro>";
    const { blocks: b, notes } = storageToBlocks(xml);
    expect(b).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "just text" }] },
      { type: "paragraph", content: [{ type: "text", text: "Orphan caption", marks: ["italic"] }] },
    ]);
    expect(notes.map((n) => n.code)).toEqual(["scroll-title-caption-fallback"]);
  });
});

describe("normalizeCaptionKind (standalone)", () => {
  test("empty/absent input → natural kind, no note", () => {
    expect(normalizeCaptionKind(undefined, "image")).toEqual({ kind: "figure" });
    expect(normalizeCaptionKind("  ", "table")).toEqual({ kind: "table" });
    expect(normalizeCaptionKind("", "codeBlock")).toEqual({ kind: "code" });
  });

  test("case-insensitive aliases map to the closed enum", () => {
    expect(normalizeCaptionKind("Figure", "table").kind).toBe("figure");
    expect(normalizeCaptionKind("PICTURE", "table").kind).toBe("figure");
    expect(normalizeCaptionKind("Listing", "image").kind).toBe("code");
    expect(normalizeCaptionKind("tbl", "image").kind).toBe("table");
  });

  test("equation is rejected (no math block yet) → natural + warning", () => {
    const r = normalizeCaptionKind("equation", "image");
    expect(r.kind).toBe("figure");
    expect(r.note).toMatchObject({ level: "warning", code: "caption-kind-unsupported" });
  });

  test("unknown value → natural + warning note", () => {
    const r = normalizeCaptionKind("banana", "codeBlock");
    expect(r.kind).toBe("code");
    expect(r.note).toMatchObject({ level: "warning", code: "caption-kind-unknown" });
  });
});

describe("ExportNote.source provenance (spec 003)", () => {
  test("populated with pageId from page context for a new note code", () => {
    const { notes } = storageToBlocks(scrollControl("scroll-ignore", null, "<p>x</p>"), {
      exporter: "word",
      pageContext: { id: "12345", spaceKey: "DOCSY" },
    });
    expect(notes[0]).toMatchObject({ code: "scroll-ignore-applied", source: { pageId: "12345" } });
  });

  test("absent for single-page export (no page context) — stays backward compatible", () => {
    const { notes } = storageToBlocks(scrollControl("scroll-ignore", null, "<p>x</p>"), { exporter: "word" });
    expect(notes[0]!.source).toBeUndefined();
  });
});

describe("storageToBlocks — C6 marker-shaped orientation (paired open/close)", () => {
  // The K15t-documented alternative shape: the macros carry NO body and act as
  // stateful markers orienting everything up to the matching counter-marker.
  const landscapeMarker = '<ac:structured-macro ac:name="scroll-landscape"/>';
  const portraitMarker = '<ac:structured-macro ac:name="scroll-portrait"/>';

  test("open → close folds the in-between siblings into one landscape region", () => {
    const { blocks: b, notes } = storageToBlocks(
      `<p>before</p>${landscapeMarker}<p>one</p><p>two</p>${portraitMarker}<p>after</p>`
    );
    expect(b).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      {
        type: "orientation",
        landscape: true,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "one" }] },
          { type: "paragraph", content: [{ type: "text", text: "two" }] },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ]);
    expect(notes).toEqual([]);
  });

  test("open → EOF closes the region at end of content + info note (base restored)", () => {
    const { blocks: b, notes } = storageToBlocks(`${landscapeMarker}<p>tail</p>`);
    expect(b).toEqual([
      {
        type: "orientation",
        landscape: true,
        content: [{ type: "paragraph", content: [{ type: "text", text: "tail" }] }],
      },
    ]);
    expect(notes.map((n) => n.code)).toEqual(["orientation-marker-unterminated"]);
  });

  test("a portrait marker with no open region is dropped with an info note", () => {
    const { blocks: b, notes } = storageToBlocks(`<p>x</p>${portraitMarker}<p>y</p>`);
    expect(b).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "x" }] },
      { type: "paragraph", content: [{ type: "text", text: "y" }] },
    ]);
    expect(notes.map((n) => n.code)).toEqual(["orientation-marker-unmatched"]);
  });

  test("two sequential landscape markers become two sequential regions (no nesting)", () => {
    const { blocks: b, notes } = storageToBlocks(
      `${landscapeMarker}<p>one</p>${landscapeMarker}<p>two</p>${portraitMarker}`
    );
    expect(b).toEqual([
      { type: "orientation", landscape: true, content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
      { type: "orientation", landscape: true, content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
    ]);
    expect(notes).toEqual([]);
  });

  test("markers inside a callout body normalize within that body", () => {
    const { blocks: b } = storageToBlocks(
      `<ac:structured-macro ac:name="info"><ac:rich-text-body>${landscapeMarker}<p>inner</p>${portraitMarker}</ac:rich-text-body></ac:structured-macro>`
    );
    expect(b).toEqual([
      {
        type: "callout",
        kind: "info",
        title: undefined,
        content: [
          { type: "orientation", landscape: true, content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }] },
        ],
      },
    ]);
  });
});

describe("storageToBlocks — C6 deep nested-orientation collapse", () => {
  test("an orientation region nested inside a LIST inside a region is unwrapped (outer wins)", () => {
    const inner =
      '<ac:structured-macro ac:name="scroll-portrait"><ac:rich-text-body><p>deep</p></ac:rich-text-body></ac:structured-macro>';
    const xml =
      `<ac:structured-macro ac:name="scroll-landscape"><ac:rich-text-body>` +
      `<ul><li>${inner}</li></ul>` +
      `</ac:rich-text-body></ac:structured-macro>`;
    const { blocks: b, notes } = storageToBlocks(xml);
    expect(b).toEqual([
      {
        type: "orientation",
        landscape: true,
        content: [
          {
            type: "list",
            ordered: false,
            items: [{ content: [{ type: "paragraph", content: [{ type: "text", text: "deep" }] }] }],
          },
        ],
      },
    ]);
    expect(notes.map((n) => n.code)).toEqual(["orientation-nested-collapsed"]);
  });

  test("an orientation region nested inside a BLOCKQUOTE inside a region is unwrapped", () => {
    const inner =
      '<ac:structured-macro ac:name="scroll-landscape"><ac:rich-text-body><p>deep</p></ac:rich-text-body></ac:structured-macro>';
    const xml =
      `<ac:structured-macro ac:name="scroll-landscape"><ac:rich-text-body>` +
      `<blockquote>${inner}</blockquote>` +
      `</ac:rich-text-body></ac:structured-macro>`;
    const { blocks: b, notes } = storageToBlocks(xml);
    const region = b[0] as Extract<ExportBlock, { type: "orientation" }>;
    expect(region.landscape).toBe(true);
    expect(JSON.stringify(region.content)).not.toContain('"orientation"');
    expect(notes.map((n) => n.code)).toEqual(["orientation-nested-collapsed"]);
  });

  test("nested-orientation cleanup traverses layout columns", () => {
    const inner =
      '<ac:structured-macro ac:name="scroll-portrait"><ac:rich-text-body><p>deep</p></ac:rich-text-body></ac:structured-macro>';
    const xml =
      `<ac:structured-macro ac:name="scroll-landscape"><ac:rich-text-body>` +
      `<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell>${inner}</ac:layout-cell></ac:layout-section></ac:layout>` +
      `</ac:rich-text-body></ac:structured-macro>`;
    const { blocks: b, notes } = storageToBlocks(xml);
    expect(b).toMatchObject([{
      type: "orientation",
      landscape: true,
      content: [{
        type: "layout",
        columns: [{
          width: 100,
          content: [{ type: "paragraph", content: [{ type: "text", text: "deep" }] }],
        }],
      }],
    }]);
    expect(JSON.stringify(b)).not.toContain('"orientation","landscape":false');
    expect(notes.map((n) => n.code)).toEqual(["orientation-nested-collapsed"]);
  });

  test("nested-orientation cleanup retains Storage table-row identity", () => {
    const inner =
      '<ac:structured-macro ac:name="scroll-portrait"><ac:rich-text-body><p>deep</p></ac:rich-text-body></ac:structured-macro>';
    const xml =
      `<ac:structured-macro ac:name="scroll-landscape"><ac:rich-text-body>` +
      `<table><tbody><tr ac:local-id="row-local"><td>${inner}</td></tr></tbody></table>` +
      `</ac:rich-text-body></ac:structured-macro>`;
    const { blocks: b } = storageToBlocks(xml);
    expect(b).toMatchObject([{
      type: "orientation",
      content: [{
        type: "table",
        rows: [{ localId: "row-local" }],
      }],
    }]);
  });
});

describe("storageToBlocks — inline export-control safety", () => {
  test("a body-less scroll-only-inline never leaks parameter text into the document", () => {
    // No ac:rich-text-body: the fallback must be EMPTY, not a transparent walk
    // of the macro children (which would surface `<ac:parameter>` text).
    const xml =
      '<p>a <ac:structured-macro ac:name="scroll-only-inline">' +
      '<ac:parameter ac:name="exporter">word</ac:parameter>' +
      "</ac:structured-macro> b</p>";
    const { blocks: b } = storageToBlocks(xml, { exporter: "word" });
    const content = (b[0] as { content: InlineNode[] }).content;
    expect(JSON.stringify(content)).not.toContain("word");
    expect(content).toEqual([
      { type: "text", text: "a " },
      { type: "text", text: " b" },
    ]);
  });
});

describe("ExportNote.source — full provenance (pageTitle/pageUrl/blockPath)", () => {
  test("populates pageTitle, pageUrl and blockPath when the host threads them", () => {
    const xml =
      "<p>first</p>" +
      '<ac:structured-macro ac:name="scroll-ignore"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>';
    const { notes } = storageToBlocks(xml, {
      exporter: "word",
      pageContext: {
        id: "12345",
        title: "My Page",
        url: "https://x.atlassian.net/wiki/spaces/D/pages/12345",
      },
    });
    expect(notes[0]).toMatchObject({
      code: "scroll-ignore-applied",
      source: {
        pageId: "12345",
        pageTitle: "My Page",
        pageUrl: "https://x.atlassian.net/wiki/spaces/D/pages/12345",
        blockPath: "blocks[1]",
      },
    });
  });

  test("blockPath reflects nesting (a control inside a callout body)", () => {
    const xml =
      '<ac:structured-macro ac:name="info"><ac:rich-text-body>' +
      "<p>lead</p>" +
      '<ac:structured-macro ac:name="scroll-ignore"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>' +
      "</ac:rich-text-body></ac:structured-macro>";
    const { notes } = storageToBlocks(xml, { exporter: "pdf", pageContext: { id: "1" } });
    expect(notes[0]!.source?.blockPath).toBe("blocks[0].content[1]");
  });
});


// ---------------------------------------------------------------------------
// spec 011 — storage parse budget (adversarial)
// ---------------------------------------------------------------------------

/** Assert `fn` throws a {@link StorageParseError} with exactly `kind`. */
function expectParseError(fn: () => unknown, kind: StorageParseError["kind"]): StorageParseError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StorageParseError);
    expect((err as StorageParseError).kind).toBe(kind);
    return err as StorageParseError;
  }
  throw new Error(`expected a StorageParseError(${kind}), but nothing was thrown`);
}

describe("parseXml — storage parse budget (spec 011)", () => {
  test("rejects a pathological nesting bomb instead of overflowing the stack", () => {
    // 50 000 nested <div>s. Before the budget this parsed into a 50 000-deep
    // tree and `walkBlocks` then recursed past the JS stack limit — a RangeError
    // that killed the whole export rather than one page.
    const depth = 50_000;
    const storage = "<div>".repeat(depth) + "deep" + "</div>".repeat(depth);
    const err = expectParseError(() => storageToBlocks(storage), "too-deep");
    expect(err.message).toContain(String(DEFAULT_STORAGE_PARSE_BUDGET.maxDepth));
  });

  test("the nesting bomb is a REAL stack overflow without the budget", () => {
    // Proves the guard is load-bearing: with the depth cap lifted, walking the
    // same document throws a RangeError (not a StorageParseError). If this ever
    // stops overflowing, the cap can be revisited — but not silently.
    const depth = 50_000;
    const storage = "<div>".repeat(depth) + "deep" + "</div>".repeat(depth);
    let overflowed = false;
    try {
      storageToBlocks(storage, {
        parseBudget: { ...DEFAULT_STORAGE_PARSE_BUDGET, maxDepth: depth + 10 },
      });
    } catch (err) {
      overflowed = err instanceof RangeError;
    }
    expect(overflowed).toBe(true);
  });

  test("rejects a node-count flood", () => {
    const budget = { ...DEFAULT_STORAGE_PARSE_BUDGET, maxNodes: 1000 };
    const storage = "<p>x</p>".repeat(2000);
    const err = expectParseError(() => storageToBlocks(storage, { parseBudget: budget }), "too-many-nodes");
    expect(err.message).toContain("1000");
  });

  test("rejects a node flood against the REAL default budget", () => {
    // Derived from the budget rather than hardcoded, so raising the limit does
    // not silently turn this into a test that proves nothing.
    const pairs = Math.ceil(DEFAULT_STORAGE_PARSE_BUDGET.maxNodes / 2) + 1000;
    expectParseError(() => storageToBlocks("<br/>a".repeat(pairs)), "too-many-nodes");
  });

  test("rejects an over-long text payload", () => {
    const budget = { ...DEFAULT_STORAGE_PARSE_BUDGET, maxTextLength: 100 };
    expectParseError(
      () => storageToBlocks(`<p>${"x".repeat(500)}</p>`, { parseBudget: budget }),
      "text-too-long"
    );
  });

  test("counts text length across nodes, not per node", () => {
    const budget = { ...DEFAULT_STORAGE_PARSE_BUDGET, maxTextLength: 100 };
    const storage = `<p>${"x".repeat(60)}</p><p>${"y".repeat(60)}</p>`;
    expectParseError(() => storageToBlocks(storage, { parseBudget: budget }), "text-too-long");
  });

  test("the error is typed and catchable, so one bad page need not kill an export", () => {
    const pages = ["<p>fine</p>", "<div>".repeat(50_000), "<p>also fine</p>"];
    const results: string[] = [];
    for (const page of pages) {
      try {
        results.push(storageToBlocks(page).blocks.length ? "ok" : "empty");
      } catch (err) {
        results.push(err instanceof StorageParseError ? `degraded:${err.kind}` : "fatal");
      }
    }
    expect(results).toEqual(["ok", "degraded:too-deep", "ok"]);
  });

  test("POSITIVE CONTROL: a large but realistic page parses fine", () => {
    // 2000 paragraphs plus a 30-level nested list — far more than a real page,
    // comfortably inside every default limit.
    const nested = "<ul><li>".repeat(30) + "deep" + "</li></ul>".repeat(30);
    const storage = "<p>Hello <strong>world</strong></p>".repeat(2000) + nested;
    const out = storageToBlocks(storage);
    expect(out.blocks.length).toBeGreaterThan(2000);
  });

  test("POSITIVE CONTROL: nesting exactly at the depth limit still parses", () => {
    const depth = DEFAULT_STORAGE_PARSE_BUDGET.maxDepth;
    const storage = "<div>".repeat(depth) + "edge" + "</div>".repeat(depth);
    expect(() => parseXml(storage)).not.toThrow();
  });
});

describe("parseXml — XML-illegal control characters (spec 011)", () => {
  test("strips control characters that would corrupt a .docx", () => {
    // U+0001 is illegal in XML 1.0 but survives Confluence storage as a
    // numeric charref; emitted verbatim into a <w:t> run it produces a file
    // Word refuses to open with "unreadable content".
    const out = storageToBlocks("<p>be&#x1;fore&#x8;after</p>");
    const para = out.blocks[0] as Extract<ExportBlock, { type: "paragraph" }>;
    const text = (para.content[0] as Extract<InlineNode, { type: "text" }>).text;
    expect(text).toBe("beforeafter");
    expect(/[\u0000-\u0008]/.test(text)).toBe(false);
  });

  test("strips control characters from attribute values too", () => {
    const out = storageToBlocks('<p><a href="https://ex&#x1;ample.com/x">t</a></p>');
    const para = out.blocks[0] as Extract<ExportBlock, { type: "paragraph" }>;
    const link = para.content[0] as Extract<InlineNode, { type: "link" }>;
    expect(link.target).toEqual({ kind: "external", href: "https://example.com/x" });
  });

  test("POSITIVE CONTROL: tab, newline and carriage return are preserved", () => {
    const out = storageToBlocks("<p>a&#x9;b&#xA;c</p>");
    const para = out.blocks[0] as Extract<ExportBlock, { type: "paragraph" }>;
    const text = (para.content[0] as Extract<InlineNode, { type: "text" }>).text;
    expect(text).toContain("\t");
    expect(text).toContain("\n");
  });
});


// ---------------------------------------------------------------------------
// spec 011 round 3 — the budget must clear what the PLATFORM accepts
// ---------------------------------------------------------------------------

describe("storage parse budget — realistic pages are NOT rejected", () => {
  const MiB = 1024 * 1024;

  /** Densest realistic shape measured: 4-column tables of short cells. */
  function denseTable(bytes: number): string {
    const row = `<tr><td><p>a</p></td><td><p>b</p></td><td><p>c</p></td><td><p>d</p></td></tr>`;
    return `<table><tbody>${row.repeat(Math.ceil(bytes / row.length))}</tbody></table>`;
  }

  function richText(bytes: number): string {
    const u =
      `<p>Some ordinary sentence with <strong>bold</strong> and <em>italic</em> text, ` +
      `plus <a href="https://example.com/page">a link</a> and a bit more prose.</p>`;
    return u.repeat(Math.ceil(bytes / u.length));
  }

  // Confluence Cloud accepts page bodies around 5 MB. A budget below that is an
  // availability bug, not a control: the FIRST version of this budget rejected
  // a 4 MiB table page outright, which would have aborted whole tree exports on
  // ordinary customer content.
  for (const mib of [1, 3, 5]) {
    test(`accepts a ${mib} MiB dense-table page (platform-legal)`, () => {
      expect(() => storageToBlocks(denseTable(mib * MiB))).not.toThrow();
    });

    test(`accepts a ${mib} MiB rich-text page (platform-legal)`, () => {
      expect(() => storageToBlocks(richText(mib * MiB))).not.toThrow();
    });
  }

  test("the default budget clears the worst measured density at the platform limit", () => {
    // 177 029 nodes/MiB x 5 MiB = 885 145 worst-case nodes. The budget must sit
    // above that with margin, or ordinary pages start failing.
    expect(DEFAULT_STORAGE_PARSE_BUDGET.maxNodes).toBeGreaterThan(177_029 * 5);
  });
});

// ---------------------------------------------------------------------------
// Datasource smart links (SUPPORT-DATASOURCE-JIRA)
// ---------------------------------------------------------------------------

describe("storageToBlocks — datasource smart links", () => {
  /**
   * A privacy-sanitized `<a data-datasource>` fixture preserving the captured
   * Confluence Cloud structure that exposed this defect.
   * Before the fix this walked into a `{ type: "link" }` inline node and the
   * export report was empty.
   */
  const REAL_DATASOURCE_LINK =
    '<a href="https://example.atlassian.net/issues/?jql=project%20in%20(DEMO)%20and%20status%20in%20(Review)%20ORDER%20BY%20created%20DESC" ' +
    'local-id="fbd3bb04abe6" data-card-appearance="block" ' +
    'data-datasource="{&quot;id&quot;:&quot;d8b75300-dfda-4519-b6cd-e49abbd50401&quot;,' +
    "&quot;parameters&quot;:{&quot;cloudId&quot;:&quot;11111111-2222-4333-8444-555555555555&quot;," +
    "&quot;jql&quot;:&quot;project in (DEMO) and status in (Review) ORDER BY created DESC&quot;}," +
    "&quot;views&quot;:[{&quot;type&quot;:&quot;table&quot;,&quot;properties&quot;:{&quot;columns&quot;:[" +
    "{&quot;key&quot;:&quot;issuetype&quot;},{&quot;key&quot;:&quot;key&quot;},{&quot;key&quot;:&quot;summary&quot;}," +
    "{&quot;key&quot;:&quot;assignee&quot;},{&quot;key&quot;:&quot;priority&quot;},{&quot;key&quot;:&quot;status&quot;}," +
    '{&quot;key&quot;:&quot;updated&quot;}]}}]}">https://example.atlassian.net/issues/?jql=…</a>';

  function datasourceLink(payload: unknown, href = "https://acme.atlassian.net/issues/?jql=x"): string {
    const attr = JSON.stringify(payload).replaceAll('"', "&quot;");
    return `<a href="${href}" data-card-appearance="block" data-datasource="${attr}">${href}</a>`;
  }

  const JIRA_ID = "d8b75300-dfda-4519-b6cd-e49abbd50401";

  test("the real artifact becomes an unknown macro block, NOT a link", () => {
    const out = storageToBlocks(REAL_DATASOURCE_LINK).blocks;
    expect(out.length).toBe(1);
    const block = out[0] as Extract<ExportBlock, { type: "unknown" }>;
    expect(block.type).toBe("unknown");
    expect(block.macroName).toBe("jira");
    expect(macroParamText(block.params, "jqlQuery")).toBe(
      "project in (DEMO) and status in (Review) ORDER BY created DESC"
    );
    expect(macroParamText(block.params, "columns")).toBe(
      "issuetype,key,summary,assignee,priority,status,updated"
    );
  });

  test("the pre-fix output (a raw-URL link block) is gone", () => {
    const out = storageToBlocks(REAL_DATASOURCE_LINK).blocks;
    // The defect signature: a paragraph whose only content is an external link
    // to the percent-encoded JQL URL, with no note anywhere.
    expect(out.some((b) => b.type === "paragraph")).toBe(false);
  });

  test("emits exactly one walker macro note, so resolver note pairing holds", () => {
    // resolve.ts pairs the i-th walker macro note with the i-th unknown block
    // POSITIONALLY. An unknown block emitted without its note shifts every
    // later macro's note onto the wrong instance.
    const storage = `<ac:structured-macro ac:name="unknownthing"/>${REAL_DATASOURCE_LINK}<ac:structured-macro ac:name="anotherthing"/>`;
    const res = storageToBlocks(storage);
    const macroNotes = res.notes.filter(
      (n) => n.code === "unknown-macro" || n.code === "macro-not-rendered"
    );
    const unknownBlocks = res.blocks.filter((b) => b.type === "unknown");
    expect(unknownBlocks.length).toBe(3);
    expect(macroNotes.length).toBe(3);
    // Order matters: note i must describe block i.
    expect(macroNotes[0].macroName).toBe("unknownthing");
    expect(macroNotes[1].macroName).toBe("jira");
    expect(macroNotes[2].macroName).toBe("anotherthing");
  });

  test("keeps the original link as the block body (the placeholder-floor fallback)", () => {
    const block = storageToBlocks(REAL_DATASOURCE_LINK).blocks[0] as Extract<
      ExportBlock,
      { type: "unknown" }
    >;
    expect(block.body?.length).toBe(1);
    const para = block.body![0] as Extract<ExportBlock, { type: "paragraph" }>;
    expect(para.content[0]).toMatchObject({ type: "link" });
  });

  test("carries no macroId (a datasource is not a server-side macro)", () => {
    const block = storageToBlocks(REAL_DATASOURCE_LINK).blocks[0] as Extract<
      ExportBlock,
      { type: "unknown" }
    >;
    expect(block.macroId).toBeUndefined();
  });

  test("binds sourcePage in a multi-page export", () => {
    const block = storageToBlocks(REAL_DATASOURCE_LINK, {
      pageContext: { id: "42", version: 7, spaceKey: "DOCSY" },
    }).blocks[0] as Extract<ExportBlock, { type: "unknown" }>;
    expect(block.sourcePage).toEqual({ id: "42", version: 7, spaceKey: "DOCSY" });
  });

  test("a datasource inside a paragraph does not corrupt the surrounding inline content", () => {
    const out = storageToBlocks(`<p>before ${REAL_DATASOURCE_LINK} after</p>`).blocks;
    expect(out.map((b) => b.type)).toEqual(["paragraph", "unknown", "paragraph"]);
    expect((out[0] as { content: InlineNode[] }).content).toEqual([
      { type: "text", text: "before" },
    ]);
    expect((out[2] as { content: InlineNode[] }).content).toEqual([{ type: "text", text: "after" }]);
  });

  test("an ordinary <a> is still an inline link", () => {
    const out = storageToBlocks('<p>see <a href="https://example.com/x">here</a></p>').blocks;
    const content = (out[0] as { content: InlineNode[] }).content;
    expect(content.some((n) => n.type === "link")).toBe(true);
  });

  test("unknown provider degrades to the link plus a note carrying the raw id", () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const res = storageToBlocks(
      datasourceLink({ id, parameters: {}, views: [{ type: "table" }] })
    );
    expect(res.blocks.map((b) => b.type)).toEqual(["paragraph"]);
    const note = res.notes.find((n) => n.code === "datasource-provider-unknown");
    expect(note).toBeDefined();
    expect(note!.message).toContain(id);
    expect(note!.level).toBe("warning");
  });

  test("a known-but-unimplemented provider degrades by name", () => {
    const res = storageToBlocks(
      datasourceLink({
        id: "361d618a-3c04-40ad-9b27-3c8ea6927020",
        parameters: {},
        views: [{ type: "table" }],
      })
    );
    expect(res.notes.some((n) => n.code === "datasource-provider-unsupported")).toBe(true);
    expect(res.blocks.map((b) => b.type)).toEqual(["paragraph"]);
  });

  test("the saved-filter variant degrades with its own code", () => {
    const res = storageToBlocks(
      datasourceLink({
        id: JIRA_ID,
        parameters: { cloudId: "c", filter: "10042" },
        views: [{ type: "table" }],
      })
    );
    expect(res.notes.some((n) => n.code === "datasource-filter-unsupported")).toBe(true);
  });

  test("malformed JSON degrades with a note instead of failing the page", () => {
    const storage = `<h1>Kept</h1><a href="https://acme.atlassian.net/x" data-datasource="{&quot;id&quot;:">link text</a>`;
    const res = storageToBlocks(storage);
    expect(res.notes.some((n) => n.code === "datasource-invalid")).toBe(true);
    // Neither the page nor the link's own text is lost.
    expect(res.blocks[0].type).toBe("heading");
    expect(res.blocks[1].type).toBe("paragraph");
  });

  test("a non-table view degrades", () => {
    const res = storageToBlocks(
      datasourceLink({ id: JIRA_ID, parameters: { jql: "a" }, views: [{ type: "gallery" }] })
    );
    expect(res.notes.some((n) => n.code === "datasource-invalid")).toBe(true);
  });

  test("REGRESSION: the legacy jira macro path is untouched", () => {
    const res = storageToBlocks(
      '<ac:structured-macro ac:name="jira" ac:macro-id="m-1">' +
        '<ac:parameter ac:name="jqlQuery">project = ATL ORDER BY created DESC</ac:parameter>' +
        '<ac:parameter ac:name="columns">key,summary</ac:parameter>' +
        "</ac:structured-macro>"
    );
    const block = res.blocks[0] as Extract<ExportBlock, { type: "unknown" }>;
    expect(block.type).toBe("unknown");
    expect(block.macroName).toBe("jira");
    expect(block.macroId).toBe("m-1");
    expect(block.body).toBeUndefined();
    expect(macroParamText(block.params, "jqlQuery")).toBe("project = ATL ORDER BY created DESC");
    expect(res.notes.filter((n) => n.code === "macro-not-rendered").length).toBe(1);
    expect(res.notes.some((n) => n.code.startsWith("datasource-"))).toBe(false);
  });
});

describe("storageToBlocks — typed ac:adf-node fallback", () => {
  test("retains block and inline wrapper provenance without flattening visible children", () => {
    const result = storageToBlocks(
      '<ac:adf-node type="unsupportedBlock" data-envelope="legacy">' +
        '<ac:adf-attribute key="originalValue">' +
          '<ac:adf-parameter key="kind">synthetic</ac:adf-parameter>' +
        '</ac:adf-attribute>' +
        '<ac:adf-content><p>Visible ' +
          '<ac:adf-node type="unsupportedInline">' +
            '<ac:adf-attribute key="tone">quiet</ac:adf-attribute>' +
            '<ac:adf-content><strong>inline</strong></ac:adf-content>' +
          '</ac:adf-node>' +
        '</p></ac:adf-content>' +
      '</ac:adf-node>',
    );

    expect(result.blocks).toEqual([{
      type: "unknown",
      macroName: "unsupportedBlock",
      unsupportedAdf: {
        nodeType: "unsupportedBlock",
        sourceRepresentation: "storage",
        attributes: [
          { name: "data-envelope", value: "legacy" },
          {
            name: "originalValue",
            value: [{ name: "kind", value: "synthetic" }],
          },
        ],
      },
      body: [{
        type: "paragraph",
        content: [
          { type: "text", text: "Visible " },
          {
            type: "text",
            text: "inline",
            marks: ["bold"],
            unsupportedAdf: [{
              nodeType: "unsupportedInline",
              sourceRepresentation: "storage",
              attributes: [{ name: "tone", value: "quiet" }],
            }],
          },
        ],
      }],
    }]);
    expect(result.notes.map(({ code }) => code)).toEqual([
      "adf-node-degraded",
      "adf-node-degraded",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Note-code vocabulary contract (spec 010)
// ---------------------------------------------------------------------------

/**
 * The alias table is a CONTRACT, not a comment. Note codes reach users through
 * `--report json` (`issues[].code`, `notesByCode`), through the docs, and
 * through CI pipelines that grep for one specific code. The spec 010
 * unification retired three of them, so the only honest migration story is a
 * table a consumer can actually resolve — and a table nobody executes rots into
 * a lie within one release. These tests are the execution.
 */
describe("retired note codes resolve to the code emitted today (spec 010)", () => {
  const registry = new Set<string>(EXPORT_NOTE_CODES);

  test("every retired code maps to a code that is still emitted", () => {
    for (const [retired, canonical] of Object.entries(RETIRED_EXPORT_NOTE_CODES)) {
      expect(canonicalExportNoteCode(retired), `alias for "${retired}"`).toBe(canonical);
      expect(registry.has(canonical), `"${canonical}" (target of "${retired}") is a live code`).toBe(
        true
      );
    }
  });

  test("no retired code is still a registry member", () => {
    // Both directions matter: a code cannot be simultaneously retired and
    // current, and leaving it in the union would tell the type system it can
    // still appear on a report when nothing emits it.
    const zombies = Object.keys(RETIRED_EXPORT_NOTE_CODES).filter((code) => registry.has(code));
    expect(zombies, `retired codes still in EXPORT_NOTE_CODES: ${zombies.join(", ")}`).toEqual([]);
  });

  test("the alt-text audit is one fact across both engines", () => {
    expect(canonicalExportNoteCode("pdf-image-missing-alt")).toBe("image-missing-alt");
  });

  test("the PDF per-image failure maps to image-embed-failed, NOT image-skipped", () => {
    // The load-bearing one. `pdf-image-skipped` LOOKS like it pairs with
    // `image-skipped`; reading both emitters says otherwise. `image-skipped`
    // (info) is DOCX's "this export has no image pipeline at all" — a state the
    // PDF engine cannot reach, since `preparePdfDocument` requires a resolver.
    // The fact `pdf-image-skipped` reported — "this one image's bytes could not
    // be resolved" — is DOCX's `image-embed-failed` (warning).
    expect(canonicalExportNoteCode("pdf-image-skipped")).toBe("image-embed-failed");
    expect(canonicalExportNoteCode("pdf-image-skipped")).not.toBe("image-skipped");
    // …and the DOCX-only code survives untouched, because it is a real, distinct fact.
    expect(canonicalExportNoteCode("image-skipped")).toBe("image-skipped");
  });

  test("the mention code is one fact across both hosts", () => {
    expect(canonicalExportNoteCode("pdf-mention-unresolved")).toBe("mention-unresolved");
  });

  test("codes that describe facts their look-alike does not are NOT aliased away", () => {
    // Each of these survived the unification on purpose (see the registry
    // comments): a render-stage statement, a whole-call failure with no CLI
    // counterpart, and a no-pipeline configuration fact.
    const kept = ["pdf-image-alt-fallback", "pdf-mention-resolution-failed", "image-skipped"] as const;
    for (const code of kept) {
      expect(canonicalExportNoteCode(code), `"${code}" must stay a code of its own`).toBe(code);
      expect(Object.keys(RETIRED_EXPORT_NOTE_CODES)).not.toContain(code);
    }
  });

  test("a current code passes through and an invented one does not resolve", () => {
    expect(canonicalExportNoteCode("unknown-macro")).toBe("unknown-macro");
    expect(canonicalExportNoteCode("pdf-image-definitely-not-a-code")).toBeUndefined();
  });
});
