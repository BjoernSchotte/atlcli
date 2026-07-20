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
import type { ConfluencePageDetails, ExportBlock, ExportNode } from "@atlcli/confluence/browser";
import { buildDocx, para, stylesXml } from "@atlcli/docx/fixtures";
import type { PdfExportMetadata, PdfTemplateSettings } from "@atlcli/pdf/browser";

export * from "./svg-corpus.js";

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
  ]),
  page("chapter-b", "Chapter B", 1, 1, "root", [
    { type: "heading", level: 1, content: [{ type: "text", text: "Chapter B" }] },
    { type: "paragraph", content: [{ type: "text", text: "Beta content." }] },
  ]),
];
