import { describe, test, expect } from "bun:test";
import {
  composeChapters,
  sanitizeAnchorId,
  computeHeadingOffset,
  minHeadingLevel,
  AnchorRegistry,
  MAX_ANCHOR_ID_LENGTH,
  type ComposeOptions,
} from "./compose-document.js";
import type { ExportNode, ExportPageNode, ExportFolderNode } from "./tree-fetch.js";
import { storageToBlocks, type ExportBlock, type InlineNode, type LinkTarget } from "./export-blocks.js";

// ---------------------------------------------------------------------------
// Fixture builders (pure in-memory ExportNodes — no mocks)
// ---------------------------------------------------------------------------

function page(
  id: string,
  title: string,
  effectiveDepth: number,
  parentId: string | null,
  storage: string,
  spaceKey = "DOC"
): ExportPageNode {
  const { blocks } = storageToBlocks(storage, { pageContext: { id, spaceKey } });
  return {
    kind: "page",
    pageId: id,
    title,
    depth: effectiveDepth,
    effectiveDepth,
    parentId,
    position: 0,
    blocks,
    notes: [],
    meta: { labels: [], spaceKey },
  };
}

function folder(
  id: string,
  title: string,
  effectiveDepth: number,
  parentId: string | null
): ExportFolderNode {
  return { kind: "folder", folderId: id, title, depth: effectiveDepth, effectiveDepth, parentId, position: 0 };
}

// ---------------------------------------------------------------------------
// Deep collectors
// ---------------------------------------------------------------------------

function allHeadings(blocks: ExportBlock[]): Extract<ExportBlock, { type: "heading" }>[] {
  const out: Extract<ExportBlock, { type: "heading" }>[] = [];
  const walk = (list: ExportBlock[]): void => {
    for (const b of list) {
      if (b.type === "heading") out.push(b);
      else if (b.type === "callout" || b.type === "blockquote" || b.type === "orientation") walk(b.content);
      else if (b.type === "list") for (const it of b.items) walk(it.content);
      else if (b.type === "table") for (const r of b.rows) for (const c of r.cells) walk(c.content);
    }
  };
  walk(blocks);
  return out;
}

function allLinkTargets(blocks: ExportBlock[]): LinkTarget[] {
  const out: LinkTarget[] = [];
  const inline = (nodes: InlineNode[]): void => {
    for (const n of nodes) {
      if (n.type === "link") {
        out.push(n.target);
        inline(n.content);
      }
    }
  };
  const walk = (list: ExportBlock[]): void => {
    for (const b of list) {
      switch (b.type) {
        case "paragraph":
        case "heading":
          inline(b.content);
          break;
        case "callout":
        case "blockquote":
        case "orientation":
          walk(b.content);
          break;
        case "list":
          for (const it of b.items) walk(it.content);
          break;
        case "table":
          for (const r of b.rows) for (const c of r.cells) walk(c.content);
          break;
      }
    }
  };
  walk(blocks);
  return out;
}

function plainText(nodes: InlineNode[]): string {
  return nodes
    .map((n) =>
      n.type === "text" ? n.text : n.type === "link" ? plainText(n.content) : ""
    )
    .join("");
}

// ---------------------------------------------------------------------------
// The reference fixture tree (PLAN: depth 3, duplicate titles, same-named
// in-page headings, cross-page links, out-of-scope link, interleaved folder).
// ---------------------------------------------------------------------------

function fixtureTree(): ExportNode[] {
  return [
    page(
      "1",
      "Handbook",
      0,
      null,
      `<h2>Intro</h2>` +
        `<p>Start: <ac:link><ri:page ri:content-id="2" ri:content-title="Guide" ri:space-key="DOC"/><ac:plain-text-link-body>the guide</ac:plain-text-link-body></ac:link></p>` +
        `<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">spec-anchor</ac:parameter></ac:structured-macro>` +
        `<p><ac:link ac:anchor="spec-anchor"><ac:plain-text-link-body>jump</ac:plain-text-link-body></ac:link></p>`
    ),
    // Starts at H3 to exercise per-page promotion.
    page("2", "Guide", 1, "1", `<h3>Setup</h3><h4>Sub</h4><p>text</p>`),
    // Duplicate title "Guide"; same-named in-page headings + a clamp-triggering H6.
    page(
      "3",
      "Guide",
      2,
      "2",
      `<h2>Notes</h2><p>a</p><h2>Notes</h2><h6>Deep</h6>` +
        `<p><ac:link ac:anchor="Notes"><ac:plain-text-link-body>to notes</ac:plain-text-link-body></ac:link></p>`
    ),
    folder("F1", "Appendices", 1, "1"),
    page(
      "4",
      "Reference",
      1,
      "1",
      `<p><ac:link><ri:page ri:content-title="Guide" ri:space-key="DOC"/><ac:plain-text-link-body>guide?</ac:plain-text-link-body></ac:link></p>` +
        `<p><ac:link ac:anchor="sec"><ri:page ri:content-title="External" ri:space-key="OTHER"/><ac:plain-text-link-body>ext</ac:plain-text-link-body></ac:link></p>` +
        `<p><ac:link ac:anchor="Intro"><ri:page ri:content-id="1" ri:content-title="Handbook" ri:space-key="DOC"/><ac:plain-text-link-body>intro</ac:plain-text-link-body></ac:link></p>` +
        `<p><ac:link ac:anchor="Nope"><ri:page ri:content-id="1" ri:content-title="Handbook"/><ac:plain-text-link-body>nope</ac:plain-text-link-body></ac:link></p>`
    ),
  ];
}

const resolveExternalUrl: NonNullable<ComposeOptions["resolveExternalUrl"]> = (t, anchor) =>
  `https://wiki.example/space/${t.spaceKey}/${encodeURIComponent(t.contentTitle)}${anchor ? `#${anchor}` : ""}`;

// ---------------------------------------------------------------------------
// Heading-offset helpers (lifted into this module; shared by both engines)
// ---------------------------------------------------------------------------

describe("computeHeadingOffset / minHeadingLevel (shared helper)", () => {
  test("promotes the shallowest heading (offset = min - 1) across nesting", () => {
    const blocks: ExportBlock[] = [
      { type: "heading", level: 2, content: [{ type: "text", text: "A" }] },
      {
        type: "callout",
        kind: "info",
        content: [{ type: "heading", level: 3, content: [{ type: "text", text: "B" }] }],
      },
    ];
    expect(minHeadingLevel(blocks)).toBe(2);
    expect(computeHeadingOffset(blocks)).toBe(1);
  });

  test("no headings → offset 0", () => {
    expect(computeHeadingOffset([{ type: "paragraph", content: [] }])).toBe(0);
  });

  test("a composed document always yields offset 0 (chapters start at level 1)", () => {
    const { blocks } = composeChapters(fixtureTree());
    expect(computeHeadingOffset(blocks)).toBe(0);
    expect(minHeadingLevel(blocks)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Chapter structure & levels
// ---------------------------------------------------------------------------

describe("composeChapters — chapter structure", () => {
  test("chapter levels follow effectiveDepth; folder is a heading-only chapter", () => {
    const { blocks } = composeChapters(fixtureTree(), { chapterBreak: "none" });
    const chapterOf = (anchor: string) =>
      blocks.find(
        (b): b is Extract<ExportBlock, { type: "heading" }> =>
          b.type === "heading" && b.explicitAnchor === anchor
      )!;
    expect(chapterOf("page-1").level).toBe(1); // Handbook, eff 0
    expect(chapterOf("page-2").level).toBe(2); // Guide, eff 1
    expect(chapterOf("page-3").level).toBe(3); // Guide (dup), eff 2
    expect(chapterOf("page-f1").level).toBe(2); // folder Appendices, eff 1
    expect(chapterOf("page-4").level).toBe(2); // Reference, eff 1

    // Folder chapter carries no body: the block right after it is the next
    // chapter heading (Reference), not folder content.
    const idx = blocks.findIndex((b) => b.type === "heading" && b.explicitAnchor === "page-f1");
    const next = blocks[idx + 1] as Extract<ExportBlock, { type: "heading" }>;
    expect(next.explicitAnchor).toBe("page-4");
  });

  test("per-page promotion then depth shift (page 2 starts at H3)", () => {
    const { blocks } = composeChapters(fixtureTree(), { chapterBreak: "none" });
    // Guide(2): chapterLevel 2, offset 2 (min H3), shift 0 → Setup stays H3, Sub H4.
    const setup = blocks.find(
      (b) => b.type === "heading" && b.explicitAnchor === "p2-setup"
    ) as Extract<ExportBlock, { type: "heading" }>;
    const sub = blocks.find(
      (b) => b.type === "heading" && b.explicitAnchor === "p2-sub"
    ) as Extract<ExportBlock, { type: "heading" }>;
    expect(setup.level).toBe(3);
    expect(sub.level).toBe(4);
  });

  test("preserves authored block presentation while shifting headings and rewriting inline content", () => {
    const source = page("presented", "Presented", 0, null, "");
    source.blocks = [
      {
        type: "heading",
        level: 2,
        presentation: { alignment: "end", indentation: 1 },
        content: [{ type: "text", text: "Presented heading" }],
      },
      {
        type: "paragraph",
        presentation: { alignment: "center", indentation: 2 },
        content: [{ type: "text", text: "Presented paragraph" }],
      },
    ];

    const { blocks } = composeChapters([source], { chapterBreak: "none" });
    expect(blocks.find(
      (block) => block.type === "heading" && plainText(block.content) === "Presented heading",
    )).toMatchObject({
      type: "heading",
      presentation: { alignment: "end", indentation: 1 },
    });
    expect(blocks.find(
      (block) => block.type === "paragraph" && plainText(block.content) === "Presented paragraph",
    )).toMatchObject({
      type: "paragraph",
      presentation: { alignment: "center", indentation: 2 },
    });
  });

  test("preserves nested ordered/task lists and decision identity through composition", () => {
    const source = page("semantic-lists", "Semantic lists", 0, null, "");
    source.blocks = [
      {
        type: "list",
        ordered: true,
        start: 4,
        items: [{
          content: [
            { type: "paragraph", content: [{ type: "text", text: "four" }] },
            {
              type: "list",
              ordered: true,
              start: 8,
              items: [{
                content: [{ type: "paragraph", content: [{ type: "text", text: "eight" }] }],
              }],
            },
          ],
        }],
      },
      {
        type: "list",
        ordered: false,
        listKind: "task",
        localId: "tasks",
        items: [{
          kind: "task",
          state: "TODO",
          localId: "task-parent",
          checked: false,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "parent task" }] },
            {
              type: "list",
              ordered: false,
              listKind: "task",
              localId: "nested-tasks",
              items: [{
                kind: "task",
                state: "DONE",
                localId: "task-child",
                checked: true,
                content: [{ type: "paragraph", content: [{ type: "text", text: "child task" }] }],
              }],
            },
          ],
        }],
      },
      {
        type: "list",
        ordered: false,
        listKind: "decision",
        localId: "decisions",
        items: [{
          kind: "decision",
          state: "DECIDED",
          localId: "decision-1",
          content: [{ type: "paragraph", content: [{ type: "text", text: "ship" }] }],
        }],
      },
    ];

    const { blocks } = composeChapters([source], { chapterBreak: "none" });
    expect(blocks.find((block) => block.type === "list" && block.ordered)).toMatchObject({
      type: "list",
      ordered: true,
      start: 4,
      items: [{
        content: [
          { type: "paragraph" },
          { type: "list", ordered: true, start: 8 },
        ],
      }],
    });
    expect(blocks.find(
      (block) => block.type === "list" && block.listKind === "task",
    )).toMatchObject({
      type: "list",
      listKind: "task",
      localId: "tasks",
      items: [{
        kind: "task",
        state: "TODO",
        localId: "task-parent",
        content: [
          { type: "paragraph" },
          {
            type: "list",
            listKind: "task",
            localId: "nested-tasks",
            items: [{
              kind: "task",
              state: "DONE",
              localId: "task-child",
            }],
          },
        ],
      }],
    });
    expect(blocks.find(
      (block) => block.type === "list" && block.listKind === "decision",
    )).toMatchObject({
      type: "list",
      listKind: "decision",
      localId: "decisions",
      items: [{ kind: "decision", state: "DECIDED", localId: "decision-1" }],
    });
  });

  test("clamp at level 6 emits heading-depth-clamped note", () => {
    const { blocks, notes } = composeChapters(fixtureTree(), { chapterBreak: "none" });
    // Guide(3): chapterLevel 3, offset 1 (min H2), shift 2 → H6 Deep → 8 → clamp 6.
    const deep = blocks.find(
      (b) => b.type === "heading" && plainText(b.content) === "Deep"
    ) as Extract<ExportBlock, { type: "heading" }>;
    expect(deep.level).toBe(6);
    expect(notes.some((n) => n.code === "heading-depth-clamped")).toBe(true);
  });

  test("chapterTitleFromPage: false marks chapter start with an anchor block", () => {
    const { blocks } = composeChapters(fixtureTree(), {
      chapterBreak: "none",
      chapterTitleFromPage: false,
    });
    // No synthetic page-title heading; the chapter start is a standalone anchor.
    const anchorBlock = blocks.find((b) => b.type === "anchor" && b.name === "page-1");
    expect(anchorBlock).toBeDefined();
    expect(blocks.some((b) => b.type === "heading" && b.explicitAnchor === "page-1")).toBe(false);
    // The FOLDER node ("F1") degrades identically: no heading, but its chapter
    // anchor is still emitted so `page-<folderId>` links keep resolving.
    const folderAnchor = blocks.find((b) => b.type === "anchor" && b.name === "page-f1");
    expect(folderAnchor).toBeDefined();
    expect(blocks.some((b) => b.type === "heading" && b.explicitAnchor === "page-f1")).toBe(false);
    // No folder-title heading text survives anywhere.
    expect(
      allHeadings(blocks).some((h) => plainText(h.content) === "Appendices")
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Page breaks
// ---------------------------------------------------------------------------

describe("composeChapters — chapter breaks", () => {
  test("default pageBreak inserts a break between chapters, not before the first", () => {
    const { blocks } = composeChapters(fixtureTree());
    const breaks = blocks.filter((b) => b.type === "pageBreak").length;
    // 5 chapters → 4 inter-chapter breaks; the very first chapter has none.
    expect(breaks).toBe(4);
    expect(blocks[0].type).not.toBe("pageBreak");
  });

  test('chapterBreak: "none" emits no page breaks', () => {
    const { blocks } = composeChapters(fixtureTree(), { chapterBreak: "none" });
    expect(blocks.some((b) => b.type === "pageBreak")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Anchor namespacing + link rewrite
// ---------------------------------------------------------------------------

describe("composeChapters — anchor namespacing & link rewrite", () => {
  test("cross-page link via contentId → chapter-start anchor", () => {
    const { blocks } = composeChapters(fixtureTree(), { chapterBreak: "none" });
    const targets = allLinkTargets(blocks);
    // Handbook's "the guide" link (contentId 2, no anchor) → page-2 chapter start.
    expect(targets).toContainEqual({ kind: "anchor", anchor: "page-2" });
  });

  test("cross-page link WITH anchor → namespaced in-page destination", () => {
    const { blocks } = composeChapters(fixtureTree(), { chapterBreak: "none" });
    const targets = allLinkTargets(blocks);
    // Reference → Handbook#Intro resolves to p1-intro (heading-derived anchor).
    expect(targets).toContainEqual({ kind: "anchor", anchor: "p1-intro" });
  });

  test("in-page anchor link → this page's namespaced destination", () => {
    const { blocks } = composeChapters(fixtureTree(), { chapterBreak: "none" });
    const targets = allLinkTargets(blocks);
    // Handbook's "jump" → spec-anchor on page 1.
    expect(targets).toContainEqual({ kind: "anchor", anchor: "p1-spec-anchor" });
    // Guide(3)'s in-page "to notes" → first "Notes" heading destination.
    expect(targets).toContainEqual({ kind: "anchor", anchor: "p3-notes" });
  });

  test("explicit anchor macro registers the SAME destination a heading-derived anchor would", () => {
    const { blocks } = composeChapters(fixtureTree(), { chapterBreak: "none" });
    const anchorBlock = blocks.find(
      (b) => b.type === "anchor" && b.name === sanitizeAnchorId(AnchorRegistry.inPageKey("1", "spec-anchor"))
    ) as Extract<ExportBlock, { type: "anchor" }>;
    // The macro-derived anchor block and the link both point at the identical id,
    // computed by the same sanitize+namespace rule headings use.
    expect(anchorBlock).toBeDefined();
    expect(anchorBlock.name).toBe("p1-spec-anchor");
    const targets = allLinkTargets(blocks);
    expect(targets).toContainEqual({ kind: "anchor", anchor: anchorBlock.name });
  });

  test("ambiguous cross-page link → note + page-only text", () => {
    const { blocks, notes } = composeChapters(fixtureTree(), { chapterBreak: "none" });
    expect(notes.some((n) => n.code === "link-target-ambiguous")).toBe(true);
    // The "guide?" link (dup title, no contentId) is unwrapped to plain text.
    const targets = allLinkTargets(blocks);
    // No unresolved page-kind targets survive composition.
    expect(targets.every((t) => t.kind !== "page")).toBe(true);
    // Its text survives.
    const refBody = blocks.filter((b) => b.type === "paragraph") as Extract<ExportBlock, { type: "paragraph" }>[];
    expect(refBody.some((p) => plainText(p.content).includes("guide?"))).toBe(true);
  });

  test("out-of-scope link → absolute URL via resolveExternalUrl + note", () => {
    const { blocks, notes } = composeChapters(fixtureTree(), {
      chapterBreak: "none",
      resolveExternalUrl,
    });
    expect(notes.some((n) => n.code === "link-outside-scope")).toBe(true);
    const targets = allLinkTargets(blocks);
    expect(targets).toContainEqual({
      kind: "external",
      href: "https://wiki.example/space/OTHER/External#sec",
    });
  });

  test("out-of-scope link without a callback degrades to page-only text", () => {
    const { blocks, notes } = composeChapters(fixtureTree(), { chapterBreak: "none" });
    expect(notes.some((n) => n.code === "link-outside-scope")).toBe(true);
    const targets = allLinkTargets(blocks);
    expect(targets.some((t) => t.kind === "external")).toBe(false);
  });

  test("caption links pass through the same rewrite (table/codeBlock/image captions)", () => {
    // No walker emits captions yet (spec 003/T1.4), so build the blocks
    // programmatically: each caption carries a cross-page link to page 2.
    const captionLink = (text: string): InlineNode => ({
      type: "link",
      target: { kind: "page", contentTitle: "Target", contentId: "2", spaceKey: "DOC" },
      content: [{ type: "text", text }],
    });
    const source = page("1", "Root", 0, null, "<p>body</p>");
    source.blocks.push(
      {
        type: "table",
        rows: [{ cells: [{ header: false, colspan: 1, rowspan: 1, content: [] }] }],
        caption: { kind: "table", content: [captionLink("tab")] },
      },
      { type: "codeBlock", code: "x", caption: { kind: "code", content: [captionLink("code")] } },
      {
        type: "image",
        source: { kind: "attachment", filename: "a.png" },
        caption: { kind: "figure", content: [captionLink("fig")] },
      }
    );
    const target = page("2", "Target", 1, "1", "<p>t</p>");
    const { blocks } = composeChapters([source, target], { chapterBreak: "none" });

    const captions = blocks.flatMap((b) =>
      (b.type === "table" || b.type === "codeBlock" || b.type === "image") && b.caption
        ? [b.caption]
        : []
    );
    expect(captions).toHaveLength(3);
    for (const caption of captions) {
      const link = caption.content.find((n) => n.type === "link") as Extract<
        InlineNode,
        { type: "link" }
      >;
      // Rewritten to the chapter-start anchor, not left as an unresolved page link.
      expect(link.target).toEqual({ kind: "anchor", anchor: "page-2" });
    }
  });

  test("missing target anchor → link-anchor-missing + page-only text", () => {
    const { blocks, notes } = composeChapters(fixtureTree(), { chapterBreak: "none" });
    expect(notes.some((n) => n.code === "link-anchor-missing")).toBe(true);
    // The "nope" link (Handbook#Nope, undefined anchor) is unwrapped.
    const paras = blocks.filter((b) => b.type === "paragraph") as Extract<ExportBlock, { type: "paragraph" }>[];
    expect(paras.some((p) => plainText(p.content) === "nope")).toBe(true);
  });
});

describe("composeChapters — retained ADF mark identities", () => {
  test("preserves annotation and fragment metadata while rewriting document structure", () => {
    const source = page("1", "Source", 0, null, "<p>body</p>");
    source.blocks.push(
      {
        type: "paragraph",
        content: [{
          type: "text",
          text: "commented",
          annotations: [{ id: "comment-1", annotationType: "inlineComment" }],
        }],
      },
      {
        type: "table",
        presentation: {
          layout: "align-end",
          width: 480,
          displayMode: "fixed",
          numberedColumn: true,
          localId: "table-local",
        },
        rows: [{
          localId: "",
          cells: [{
            header: false,
            colspan: 1,
            rowspan: 1,
            columnWidths: [480],
            verticalAlignment: "bottom",
            localId: "cell-local",
            content: [{ type: "paragraph", content: [{ type: "text", text: "cell" }] }],
          }],
        }],
        fragments: [{ localId: "table-fragment", name: "" }],
      },
      {
        type: "unknown",
        macroName: "extension",
        fragments: [{ localId: "extension-fragment", name: "named" }],
      },
    );

    const { blocks } = composeChapters([source], { chapterBreak: "none" });
    expect(blocks).toContainEqual({
      type: "paragraph",
      content: [{
        type: "text",
        text: "commented",
        annotations: [{ id: "comment-1", annotationType: "inlineComment" }],
      }],
    });
    expect(blocks).toContainEqual({
      type: "table",
      presentation: {
        layout: "align-end",
        width: 480,
        displayMode: "fixed",
        numberedColumn: true,
        localId: "table-local",
      },
      rows: [{
        localId: "",
        cells: [{
          header: false,
          colspan: 1,
          rowspan: 1,
          columnWidths: [480],
          verticalAlignment: "bottom",
          localId: "cell-local",
          content: [{ type: "paragraph", content: [{ type: "text", text: "cell" }] }],
        }],
      }],
      fragments: [{ localId: "table-fragment", name: "" }],
    });
    expect(blocks).toContainEqual({
      type: "unknown",
      macroName: "extension",
      fragments: [{ localId: "extension-fragment", name: "named" }],
    });
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("composeChapters — determinism", () => {
  test("double run is byte-equal", () => {
    const a = composeChapters(fixtureTree(), { resolveExternalUrl });
    const b = composeChapters(fixtureTree(), { resolveExternalUrl });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("golden snapshot of the reference fixture", () => {
    const result = composeChapters(fixtureTree(), { resolveExternalUrl });
    expect(result).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Anchor registry sanitization goldens
// ---------------------------------------------------------------------------

describe("sanitizeAnchorId — registry goldens", () => {
  test("folds Unicode / diacritics to ASCII", () => {
    const { blocks } = composeChapters(
      [page("9", "P", 0, null, `<h2>Übersicht</h2>`)],
      { chapterBreak: "none" }
    );
    const h = allHeadings(blocks).find((x) => plainText(x.content) === "Übersicht")!;
    expect(h.explicitAnchor).toBe("p9-ubersicht");
  });

  test("strips control characters", () => {
    const { blocks } = composeChapters(
      [page("9", "P", 0, null, `<h2>Ta&#1;b</h2>`)],
      { chapterBreak: "none" }
    );
    const h = allHeadings(blocks).find((x) => x.explicitAnchor?.startsWith("p9-"))!;
    expect(h.explicitAnchor).toBe("p9-tab");
  });

  test("truncates over-40-char ids with a stable hash suffix", () => {
    const longTitle = "A very long heading title that certainly exceeds forty characters";
    const { blocks } = composeChapters(
      [page("9", "P", 0, null, `<h2>${longTitle}</h2>`)],
      { chapterBreak: "none" }
    );
    const h = allHeadings(blocks).find((x) => plainText(x.content) === longTitle)!;
    expect(h.explicitAnchor!.length).toBeLessThanOrEqual(MAX_ANCHOR_ID_LENGTH);
    expect(h.explicitAnchor).toMatch(/-[0-9a-z]+$/);
    // Deterministic across runs.
    const { blocks: blocks2 } = composeChapters(
      [page("9", "P", 0, null, `<h2>${longTitle}</h2>`)],
      { chapterBreak: "none" }
    );
    const h2 = allHeadings(blocks2).find((x) => plainText(x.content) === longTitle)!;
    expect(h2.explicitAnchor).toBe(h.explicitAnchor);
  });

  test("same-page distinct headings that sanitize alike get unique hash-suffixed ids", () => {
    // "Foo Bar" and "Foo-Bar" are distinct raw keys but sanitize to p9-foo-bar.
    const { blocks } = composeChapters(
      [page("9", "P", 0, null, `<h2>Foo Bar</h2><h2>Foo-Bar</h2>`)],
      { chapterBreak: "none" }
    );
    const hs = allHeadings(blocks).filter((x) => x.explicitAnchor?.startsWith("p9-foo-bar"));
    expect(hs).toHaveLength(2);
    const ids = hs.map((x) => x.explicitAnchor);
    expect(new Set(ids).size).toBe(2); // unique
    expect(ids).toContain("p9-foo-bar"); // first-wins keeps the clean id
  });
});

describe("composeChapters — the published chapter-anchor map", () => {
  /**
   * Macro resolution runs AFTER composition (both engines resolve macros on the
   * already-composed tree), so a renderer that lists other Confluence pages can
   * no longer have its `{ kind: "page" }` targets rewritten. This map is how it
   * reaches composition's OWN in-scope answer instead of growing a second
   * link-resolution path.
   */
  test("names every page AND folder, with the anchor its chapter actually carries", () => {
    const result = composeChapters(fixtureTree(), { resolveExternalUrl });
    expect([...result.chapterAnchorById.keys()].sort()).toEqual(["1", "2", "3", "4", "F1"]);

    // The value must be the anchor the DOCUMENT uses, not a recomputed guess:
    // pull the chapter headings' explicit anchors back out and compare.
    const headingAnchors = result.blocks
      .filter((b): b is Extract<ExportBlock, { type: "heading" }> => b.type === "heading")
      .map((h) => h.explicitAnchor)
      .filter((a): a is string => a !== undefined);
    for (const anchor of result.chapterAnchorById.values()) {
      expect(headingAnchors).toContain(anchor);
    }
  });

  test("a page outside the export is simply absent — never a fabricated anchor", () => {
    const result = composeChapters(fixtureTree(), { resolveExternalUrl });
    expect(result.chapterAnchorById.get("999")).toBeUndefined();
  });

  test("is stable across runs, like the rest of composition", () => {
    const a = composeChapters(fixtureTree(), { resolveExternalUrl });
    const b = composeChapters(fixtureTree(), { resolveExternalUrl });
    expect([...a.chapterAnchorById]).toEqual([...b.chapterAnchorById]);
  });
});
