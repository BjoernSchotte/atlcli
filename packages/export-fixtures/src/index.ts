/**
 * `@atlcli/export-fixtures` — deterministic, browser-safe, IO-free fixtures that
 * are THE shared contract between the browser conformance harness
 * (`apps/browser-export-harness`) and the Bun/CLI shape-parity runner
 * (`scripts/check-parity.ts`). Both consumers import the same fixture bytes so a
 * digest divergence means a real engine divergence, never a fixture drift.
 *
 * Spec 011 (quality gates), Architecture: "Fixtures are the contract." Nothing
 * here touches the network, filesystem, or a Confluence tenant — every port is
 * fed one of these in-memory fixtures.
 */
import {
  composeChapters,
  storageToBlocks,
  type ComposeResult,
  type ConfluencePageDetails,
  type ExportBlock,
  type ExportNode,
  type StorageToBlocksResult,
} from "@atlcli/confluence/browser";
import { buildDocx, para, stylesXml } from "@atlcli/docx/fixtures";
import type { PdfExportMetadata, PdfTemplateSettings } from "@atlcli/pdf/browser";

export * from "./svg-corpus.js";
export * from "./macro-fixtures.js";
export * from "./placeholder-fixtures.js";
export * from "./docx-quality-fixtures.js";

const MERMAID_SOURCE = "flowchart LR\n  Source --> Export\n  Export --> Document";

// ---------------------------------------------------------------------------
// DOCX general contract (pre-existing harness fixture, centralized here)
// ---------------------------------------------------------------------------

export const DOCX_TEMPLATE_BYTES = buildDocx({
  body: para("$scroll.title") + para("$scroll.content"),
  styles: stylesXml(),
});

export const DOCX_DETAILS: ConfluencePageDetails = {
  id: "browser-harness-page",
  title: "Browser Harness DOCX",
  url: "https://example.invalid/wiki/spaces/TEST/pages/browser-harness-page",
  version: 1,
  spaceKey: "TEST",
  storage:
    `<h1>Browser package contract</h1>` +
    `<p>This document was generated without an extension host.</p>` +
    `<ac:structured-macro ac:name="code">` +
    `<ac:parameter ac:name="language">mermaid</ac:parameter>` +
    `<ac:plain-text-body><![CDATA[${MERMAID_SOURCE}]]></ac:plain-text-body>` +
    `</ac:structured-macro>`,
  created: "2026-07-17T08:00:00.000Z",
  modified: "2026-07-17T08:00:00.000Z",
  createdBy: { displayName: "Harness Author" },
  modifiedBy: { displayName: "Harness Author" },
  labels: ["browser-conformance"],
};

export const DOCX_EXPECTED = {
  filename: "Browser Harness DOCX.docx",
  resolvedCount: 1,
  renderedDiagrams: 1,
  semanticNoteCodes: [] as string[],
};

// ---------------------------------------------------------------------------
// PDF general contract (pre-existing harness fixture, centralized here)
// ---------------------------------------------------------------------------

export const PDF_BLOCKS: ExportBlock[] = [
  {
    type: "heading",
    level: 1,
    content: [{ type: "text", text: "Browser package contract" }],
  },
  {
    type: "paragraph",
    content: [{ type: "text", text: "The PDF runner is hosted by a neutral module Worker." }],
  },
  {
    type: "list",
    ordered: false,
    items: [
      { content: [{ type: "paragraph", content: [{ type: "text", text: "WASM and fonts are local" }] }] },
      { content: [{ type: "paragraph", content: [{ type: "text", text: "The repeat is deterministic" }] }] },
    ],
  },
];

export const PDF_METADATA: PdfExportMetadata = {
  title: "Browser Harness PDF",
  space: "TEST",
  version: 1,
  author: "Harness Author",
  exporter: "atlcli browser harness",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-17T08:00:00.000Z"),
};

export const PDF_FILENAME = "Browser Harness PDF.pdf";

// ---------------------------------------------------------------------------
// Spec 007 — PDF settings / watermark conformance fixture
// ---------------------------------------------------------------------------

/** A slightly longer block set so cover/outline/orientation toggles are visible. */
export const PDF_SETTINGS_BLOCKS: ExportBlock[] = [
  { type: "heading", level: 1, content: [{ type: "text", text: "Settings Conformance" }] },
  {
    type: "paragraph",
    content: [{ type: "text", text: "This document proves settings thread through the Typst template." }],
  },
  { type: "heading", level: 2, content: [{ type: "text", text: "Second section" }] },
  {
    type: "paragraph",
    content: [{ type: "text", text: "Outline and cover toggles change the page count deterministically." }],
  },
];

export const PDF_SETTINGS_METADATA: PdfExportMetadata = {
  title: "PDF Settings Conformance",
  space: "TEST",
  version: 1,
  author: "Harness Author",
  exporter: "atlcli browser harness",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-17T08:00:00.000Z"),
};

/** A4 / portrait, cover + outline on, watermark on. */
export const PDF_SETTINGS_A: PdfTemplateSettings = {
  page: "a4",
  orientation: "portrait",
  cover: true,
  outline: true,
  watermark: { text: "CONFIDENTIAL" },
};

/** Letter / landscape, cover + outline off, no watermark — must differ from A. */
export const PDF_SETTINGS_B: PdfTemplateSettings = {
  page: "letter",
  orientation: "landscape",
  cover: false,
  outline: false,
};

/** A with the watermark removed — proves the watermark alone changes bytes. */
export const PDF_SETTINGS_A_NO_WATERMARK: PdfTemplateSettings = {
  page: "a4",
  orientation: "portrait",
  cover: true,
  outline: true,
};

/** Minimal, valid `.wiki-pdf-template` payload used for the container round-trip. */
export const PDF_TEMPLATE_PACK_MANIFEST = {
  schemaVersion: 1 as const,
  id: "com.atlcli.conformance",
  name: "Conformance Template",
  version: "1.0.0",
  engine: { kind: "typst" as const, api: "wiki.pdf-template/v1", entry: "template.typ" },
};

export const PDF_TEMPLATE_PACK_FILES: Record<string, string> = {
  "template.typ": "#let render(meta, body, settings) = body",
  "assets/logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
};

// ---------------------------------------------------------------------------
// Spec 002 — scope / tree-compose conformance fixture
// ---------------------------------------------------------------------------

function page(
  pageId: string,
  title: string,
  depth: number,
  position: number,
  parentId: string | null,
  blocks: ExportBlock[],
): ExportNode {
  return {
    kind: "page",
    pageId,
    title,
    depth,
    effectiveDepth: depth,
    parentId,
    position,
    blocks,
    notes: [],
    meta: { labels: [], spaceKey: "TEST" },
  };
}

/**
 * A three-page tree: a root page and two children. Each page carries a heading
 * and a paragraph plus an in-page anchor + a link to a sibling's anchor, so the
 * compose step must offset heading levels, insert chapter page breaks, and keep
 * cross-page anchors resolvable (no dangling-link diagnostics).
 *
 * Forward-provisioned for conformance **case 002 `scope`**
 * (`apps/browser-export-harness/src/scope-case.ts`, not yet written): that case
 * will drive these nodes through `composeChapters` → both engines. Committed
 * ahead of the case so the fixture contract lives in one place when 002's
 * harness case lands.
 */
export const SCOPE_TREE_NODES: readonly ExportNode[] = [
  page("root", "Handbook", 0, 0, null, [
    { type: "heading", level: 1, content: [{ type: "text", text: "Handbook" }] },
    { type: "paragraph", content: [{ type: "text", text: "Root overview." }] },
  ]),
  page("chapter-a", "Chapter A", 1, 0, "root", [
    { type: "heading", level: 1, content: [{ type: "text", text: "Chapter A" }] },
    { type: "anchor", name: "alpha" },
    { type: "paragraph", content: [{ type: "text", text: "Alpha content." }] },
    // An in-page link back to this page's own anchor — composeChapters must
    // namespace both the anchor block and the link target to `p<pageId>-alpha`
    // and rewrite the link so it resolves (no dangling-link diagnostic).
    {
      type: "paragraph",
      content: [
        {
          type: "link",
          target: { kind: "anchor", anchor: "alpha" },
          content: [{ type: "text", text: "Back to Alpha" }],
        },
      ],
    },
  ]),
  page("chapter-b", "Chapter B", 1, 1, "root", [
    { type: "heading", level: 1, content: [{ type: "text", text: "Chapter B" }] },
    { type: "paragraph", content: [{ type: "text", text: "Beta content." }] },
  ]),
];

/**
 * Compose the scope tree into a single document (conformance **case 002**). The
 * SAME pure call runs in the browser harness and the Bun/CLI parity runner, so a
 * digest divergence is a real engine divergence — never a fixture drift. Uses
 * the default options (hard `pageBreak` between chapters, chapter titles from
 * the page title) so heading offsets + chapter breaks + anchor namespacing are
 * all exercised.
 */
export function composeScopeDocument(): ComposeResult {
  return composeChapters(SCOPE_TREE_NODES);
}

/** A minimal root-page `details` for the blocks-driven DOCX path (placeholders resolve against it). */
export const SCOPE_ROOT_DETAILS: ConfluencePageDetails = {
  id: "root",
  title: "Handbook",
  url: "https://example.invalid/wiki/spaces/TEST/pages/root",
  version: 1,
  spaceKey: "TEST",
  storage: "",
  created: "2026-07-17T08:00:00.000Z",
  modified: "2026-07-17T08:00:00.000Z",
  createdBy: { displayName: "Harness Author" },
  modifiedBy: { displayName: "Harness Author" },
  labels: [],
};

export const SCOPE_METADATA: PdfExportMetadata = {
  title: "Handbook",
  space: "TEST",
  version: 1,
  author: "Harness Author",
  exporter: "atlcli browser harness",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-17T08:00:00.000Z"),
};

// ---------------------------------------------------------------------------
// Spec 001 — block-model conformance fixture (case 001 `blocks`)
// ---------------------------------------------------------------------------

/**
 * A fixture exercising EVERY new `ExportBlock` field introduced by the block
 * model (spec 001) and the content-feature specs, built directly as
 * `ExportBlock[]` (not from storage) so the case proves the ENGINES render the
 * enriched model, independent of the storage parser:
 *   - `heading.explicitAnchor` (a named heading target),
 *   - a standalone `pageBreak` block,
 *   - a `table` with `columnWidths` AND a `table` `caption`,
 *   - a `codeBlock` with a `code` `caption`,
 *   - a standalone `orientation` region (`landscape: true`) with content,
 *   - a standalone `anchor` block,
 *   - an enriched `unknown` block carrying `params` + a preserved `body`.
 *
 * Chosen so BOTH engines emit ZERO warning/info notes (no image asset fetch, no
 * container-suppressed break/orientation): the case asserts the note set is
 * empty and — for the PDF side — warm-repeat byte determinism.
 */
export const BLOCKS_ALL_FIELDS: ExportBlock[] = [
  {
    type: "heading",
    level: 1,
    content: [{ type: "text", text: "Block model coverage" }],
    explicitAnchor: "intro",
  },
  { type: "paragraph", content: [{ type: "text", text: "Every enriched field renders in both hosts." }] },
  { type: "pageBreak" },
  { type: "heading", level: 2, content: [{ type: "text", text: "Captions and widths" }] },
  {
    type: "table",
    columnWidths: [300, 100],
    caption: { kind: "table", content: [{ type: "text", text: "Sizing matrix" }] },
    rows: [
      {
        cells: [
          { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Wide" }] }] },
          { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Narrow" }] }] },
        ],
      },
      {
        cells: [
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "left" }] }] },
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "right" }] }] },
        ],
      },
    ],
  },
  {
    type: "codeBlock",
    language: "typescript",
    code: "export const answer = 42;",
    caption: { kind: "code", content: [{ type: "text", text: "Listing one" }] },
  },
  {
    type: "orientation",
    landscape: true,
    content: [{ type: "paragraph", content: [{ type: "text", text: "This region is landscape." }] }],
  },
  { type: "anchor", name: "appendix" },
  {
    type: "unknown",
    macroName: "customwidget",
    params: [{ name: "id", text: "42" }],
    body: [{ type: "paragraph", content: [{ type: "text", text: "Preserved widget body." }] }],
  },
];

export const BLOCKS_METADATA: PdfExportMetadata = {
  title: "Block Model Coverage",
  space: "TEST",
  version: 1,
  author: "Harness Author",
  exporter: "atlcli browser harness",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-17T08:00:00.000Z"),
};

/** A minimal `details` for running `BLOCKS_ALL_FIELDS` through the DOCX blocks path. */
export const BLOCKS_DETAILS: ConfluencePageDetails = {
  ...SCOPE_ROOT_DETAILS,
  id: "blocks-page",
  title: "Block Model Coverage",
  url: "https://example.invalid/wiki/spaces/TEST/pages/blocks-page",
};

// ---------------------------------------------------------------------------
// Spec 003 — content-feature / scroll-macro compat fixture (case 003)
// ---------------------------------------------------------------------------

/** Build a storage `<table>` with `rows` data rows (+ a header row) so the export exercises repeating headers. */
function repeatingHeaderTableStorage(rows: number): string {
  const header = `<tr><th>Index</th><th>Label</th></tr>`;
  let body = "";
  for (let i = 1; i <= rows; i++) body += `<tr><td>${i}</td><td>row ${i}</td></tr>`;
  return `<table><tbody>${header}${body}</tbody></table>`;
}

/**
 * Confluence storage XHTML exercising the spec 003 content-compat macros through
 * the REAL `storageToBlocks` parser (conformance **case 003**):
 *   - `scroll-pagebreak` → a `pageBreak` block,
 *   - `scroll-landscape` → an `orientation` region,
 *   - `scroll-title` → a caption attached to the following captionable block,
 *   - a 200-row table with a header row (repeating-header exercise).
 * Chosen so the parser emits ZERO notes (no orphan caption, no unknown macro),
 * keeping both engines' report projections clean for the parity gate.
 */
export const CONTENT_COMPAT_STORAGE: string =
  `<p>Content-feature compatibility coverage.</p>` +
  `<ac:structured-macro ac:name="scroll-pagebreak"/>` +
  `<ac:structured-macro ac:name="scroll-title">` +
  `<ac:parameter ac:name="title">Repeating header table</ac:parameter>` +
  `<ac:parameter ac:name="type">table</ac:parameter>` +
  `<ac:rich-text-body>${repeatingHeaderTableStorage(200)}</ac:rich-text-body>` +
  `</ac:structured-macro>` +
  `<ac:structured-macro ac:name="scroll-landscape">` +
  `<ac:rich-text-body><p>This wide table region is landscape.</p></ac:rich-text-body>` +
  `</ac:structured-macro>`;

/**
 * Parse the content-compat storage for a given target exporter. The SAME call
 * runs browser-side and CLI-side for the PDF parity digest (both use
 * `exporter: "pdf"`); the DOCX case feeds the storage straight to `runExport`.
 */
export function contentCompatBlocks(exporter: "pdf" | "word"): StorageToBlocksResult {
  return storageToBlocks(CONTENT_COMPAT_STORAGE, { exporter });
}

export const CONTENT_COMPAT_METADATA: PdfExportMetadata = {
  title: "Content Compatibility",
  space: "TEST",
  version: 1,
  author: "Harness Author",
  exporter: "atlcli browser harness",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-17T08:00:00.000Z"),
};

/** A `details` carrying the content-compat storage for the DOCX (storage-driven) path. */
export const CONTENT_COMPAT_DETAILS: ConfluencePageDetails = {
  ...SCOPE_ROOT_DETAILS,
  id: "content-compat-page",
  title: "Content Compatibility",
  url: "https://example.invalid/wiki/spaces/TEST/pages/content-compat-page",
  storage: CONTENT_COMPAT_STORAGE,
};
