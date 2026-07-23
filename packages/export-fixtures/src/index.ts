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
  createAdfMediaAttachmentResolver,
  pageBodyToBlocks,
  storageToBlocks,
  type BlocksResult,
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
export * from "./m1-corpus.js";
export * from "./manuscript-fixtures.js";
export * from "./large-export-corpus.js";

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
// ADF-primary browser conformance fixture
// ---------------------------------------------------------------------------

export const ADF_CODE_BLOCK_SOURCE =
  "const first = 1;\n" +
  "const second = first + 1;\n" +
  'const message = "This is a deliberately long Confluence code line that must remain fully visible in both bounded static export targets even when no-wrap was authored";\n' +
  "console.log(second, message);\n";

/**
 * Real ADF input for the browser conformance harness. This deliberately starts
 * before the representation-neutral boundary: the case must validate and
 * decode ADF in the packed browser, then feed the resulting blocks to both
 * renderers. It mixes native semantics with visible, diagnosed degradations.
 */
export const ADF_CONFORMANCE_SOURCE = JSON.stringify({
  version: 1,
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1, localId: "heading-local" },
      content: [{ type: "text", text: "ADF browser conformance" }],
    },
    {
      type: "paragraph",
      attrs: { localId: "paragraph-local" },
      content: [
        {
          type: "text",
          text: "INLINE_TOKEN",
          marks: [
            { type: "code" },
            {
              type: "annotation",
              attrs: { id: "annotation-inline-code", annotationType: "inlineComment" },
            },
          ],
        },
        { type: "text", text: " remains literal; " },
        { type: "emoji", attrs: { shortName: ":warning:", text: "⚠️" } },
        { type: "text", text: " and custom " },
        { type: "emoji", attrs: { shortName: ":custom_party:", id: "custom-emoji", text: "" } },
        { type: "text", text: " " },
        { type: "date", attrs: { timestamp: "1709510400000", localId: "date-local" } },
        { type: "text", text: " " },
        { type: "status", attrs: { text: "Ready", color: "purple", localId: "status-local" } },
        { type: "text", text: " " },
        {
          type: "status",
          attrs: { text: "Keep Case", color: "neutral", style: "mixedCase" },
        },
        { type: "placeholder", attrs: { text: "editor-only-secret", localId: "placeholder-local" } },
        { type: "text", text: " " },
        {
          type: "mention",
          attrs: {
            id: "mention-account-1",
            text: "@Example Person",
            localId: "mention-local",
            accessLevel: "SITE",
            userType: "DEFAULT",
          },
        },
        { type: "text", text: " " },
        {
          type: "inlineCard",
          attrs: {
            data: {
              url: "https://example.invalid/adf-card",
              name: "Local card title",
            },
          },
        },
      ],
    },
    {
      type: "blockCard",
      attrs: {
        url: "https://example.invalid/adf-block-card",
        localId: "block-card-local",
      },
    },
    {
      type: "blockCard",
      attrs: {
        datasource: {
          id: "example-provider",
          parameters: { query: "type = page" },
          views: [{ type: "table", properties: { columns: ["title"] } }],
        },
        url: "https://example.invalid/adf-datasource-card",
        layout: "wide",
        width: 72,
        localId: "datasource-card-local",
      },
    },
    {
      type: "embedCard",
      attrs: {
        url: "https://example.invalid/adf-embed-card",
        layout: "full-width",
        width: 80,
        originalHeight: 720,
        originalWidth: 1280,
        localId: "embed-card-local",
      },
    },
    {
      type: "paragraph",
      marks: [
        { type: "alignment", attrs: { align: "center" } },
        { type: "fontSize", attrs: { fontSize: "small" } },
      ],
      content: [{ type: "text", text: "Centered paragraph" }],
    },
    {
      type: "paragraph",
      marks: [{ type: "indentation", attrs: { level: 2 } }],
      content: [{ type: "text", text: "Indented paragraph" }],
    },
    {
      type: "panel",
      attrs: { panelType: "info" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "ADF panel body" }] }],
    },
    {
      type: "panel",
      attrs: { panelType: "success" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "ADF success panel" }] }],
    },
    {
      type: "panel",
      attrs: { panelType: "error" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "ADF error panel" }] }],
    },
    {
      type: "panel",
      attrs: {
        panelType: "custom",
        localId: "custom-panel-local",
        panelColor: "#123456",
        panelIcon: ":star:",
        panelIconId: "custom-panel-icon",
        panelIconText: "★",
      },
      content: [{ type: "paragraph", content: [{ type: "text", text: "ADF custom panel" }] }],
    },
    {
      type: "orderedList",
      attrs: { order: 3 },
      content: [{
        type: "listItem",
        attrs: { localId: "ordered-item-local" },
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Third item" }] },
          {
            type: "orderedList",
            attrs: { order: 8 },
            content: [{
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Eighth nested item" }] }],
            }],
          },
        ],
      }],
    },
    {
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { localId: "bullet-item-local" },
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Bullet parent" }] },
          {
            type: "bulletList",
            content: [{
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Bullet child" }] }],
            }],
          },
        ],
      }],
    },
    {
      type: "taskList",
      attrs: { localId: "tasks-root" },
      content: [
        {
          type: "taskItem",
          attrs: { localId: "task-open", state: "TODO" },
          content: [{ type: "text", text: "Open task" }],
        },
        {
          type: "blockTaskItem",
          attrs: { localId: "task-done", state: "DONE" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Completed block task" }] }],
        },
        {
          type: "taskList",
          attrs: { localId: "tasks-nested" },
          content: [{
            type: "taskItem",
            attrs: { localId: "task-nested", state: "TODO" },
            content: [{ type: "text", text: "Nested task" }],
          }],
        },
      ],
    },
    {
      type: "decisionList",
      attrs: { localId: "decisions-root" },
      content: [{
        type: "decisionItem",
        attrs: { localId: "decision-ship", state: "DECIDED" },
        content: [{ type: "text", text: "Ship the release" }],
      }],
    },
    {
      type: "table",
      attrs: {
        layout: "align-end",
        width: 480,
        displayMode: "fixed",
        isNumberColumnEnabled: true,
        localId: "table-local",
      },
      marks: [{
        type: "fragment",
        attrs: { localId: "table-fragment", name: "semantic-table" },
      }],
      content: [{
        type: "tableRow",
        attrs: { localId: "table-row-local" },
        content: [
          {
            type: "tableHeader",
            attrs: {
              colspan: 1,
              rowspan: 1,
              background: "#AABBCC",
              colwidth: [240],
              valign: "middle",
              localId: "table-header-local",
            },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }],
          },
          {
            type: "tableCell",
            attrs: {
              colspan: 1,
              rowspan: 1,
              colwidth: [360],
              valign: "bottom",
              localId: "table-cell-local",
            },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }],
          },
        ],
      }],
    },
    {
      type: "layoutSection",
      attrs: { localId: "layout-local" },
      marks: [{ type: "breakout", attrs: { mode: "wide", width: 960 } }],
      content: [
        {
          type: "layoutColumn",
          attrs: { width: 30, valign: "middle", localId: "layout-sidebar-local" },
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Layout sidebar" }],
          }],
        },
        {
          type: "layoutColumn",
          attrs: { width: 70, valign: "bottom", localId: "layout-main-local" },
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Layout main" }],
          }],
        },
      ],
    },
    {
      type: "expand",
      attrs: { title: "Expanded title", localId: "expand-local" },
      marks: [{ type: "breakout", attrs: { mode: "full-width", width: 1024 } }],
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Expanded body" }] },
        {
          type: "nestedExpand",
          attrs: { title: "Nested expanded title", localId: "" },
          content: [{
            type: "paragraph",
            content: [{ type: "text", text: "Nested expanded body" }],
          }],
        },
      ],
    },
    {
      type: "bodiedExtension",
      attrs: {
        extensionType: "com.example.synthetic",
        extensionKey: "visible-extension",
        localId: "editor-local-only",
        parameters: { mode: "compact" },
      },
      content: [{ type: "paragraph", content: [{ type: "text", text: "Extension body" }] }],
    },
    {
      type: "mediaSingle",
      attrs: {
        layout: "wrap-left",
        width: 40,
        widthType: "percentage",
        localId: "media-single-local",
      },
      marks: [{
        type: "link",
        attrs: {
          href: "https://example.invalid/adf-media",
          title: "Open media",
          id: "media-link-id",
          collection: "contentId-1",
          occurrenceKey: "media-link-occurrence",
        },
      }],
      content: [
        {
          type: "media",
          attrs: {
            type: "file",
            id: "unresolved-media",
            collection: "contentId-1",
            alt: "Visible media fallback",
            width: 640,
            height: 480,
          },
          marks: [{
            type: "border",
            attrs: { color: "#091e4224", size: 2 },
          }],
        },
        {
          type: "caption",
          attrs: { localId: "media-caption-local" },
          content: [{ type: "text", text: "Media caption" }],
        },
      ],
    },
    {
      type: "paragraph",
      content: [{
        type: "text",
        text: "This paragraph demonstrates bounded text wrapping beside authored media.",
      }],
    },
    {
      type: "mediaGroup",
      content: [
        {
          type: "media",
          attrs: {
            type: "file",
            id: "group-media-1",
            collection: "contentId-1",
            alt: "Grouped attachment one",
          },
        },
        {
          type: "media",
          attrs: {
            type: "link",
            id: "group-media-2",
            collection: "contentId-1",
            alt: "Grouped attachment two",
          },
        },
      ],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Inline media: " },
        {
          type: "mediaInline",
          attrs: {
            type: "image",
            id: "inline-media-1",
            collection: "contentId-1",
            localId: "inline-media-local",
            alt: "Inline media chip",
            width: 24,
            height: 16,
            data: { source: "fixture" },
          },
          marks: [
            {
              type: "dataConsumer",
              attrs: {
                sources: ["synthetic-consumer-primary", "synthetic-consumer-secondary"],
              },
            },
            {
              type: "border",
              attrs: { color: "#0052CC", size: 1 },
            },
          ],
        },
      ],
    },
    {
      type: "codeBlock",
      attrs: {
        language: "typescript",
        wrap: false,
        hideLineNumbers: false,
        localId: "code-local",
        uniqueId: "code-unique",
      },
      marks: [{ type: "breakout", attrs: { mode: "wide", width: 880 } }],
      content: [{
        type: "text",
        text: ADF_CODE_BLOCK_SOURCE,
      }],
    },
    {
      type: "bodiedSyncBlock",
      attrs: {
        resourceId: "synthetic-sync-snapshot-resource",
        localId: "synthetic-sync-snapshot-local",
      },
      marks: [{
        type: "breakout",
        attrs: { mode: "wide", width: 840 },
      }],
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "Synced snapshot body" }],
      }],
    },
    {
      type: "syncBlock",
      attrs: {
        resourceId: "synthetic-sync-reference-resource",
        localId: "synthetic-sync-reference-local",
      },
      marks: [{
        type: "breakout",
        attrs: { mode: "full-width" },
      }],
    },
    {
      type: "unsupportedBlock",
      attrs: {
        originalValue: { kind: "synthetic-legacy-wrapper" },
        opaqueIdentity: "unsupported-block-private-provenance",
      },
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "Unsupported wrapper keeps " },
          {
            type: "unsupportedInline",
            attrs: {
              originalValue: ["synthetic", "inline"],
              opaqueIdentity: "unsupported-inline-private-provenance",
            },
            content: [{
              type: "text",
              text: "rich inline content",
              marks: [{ type: "strong" }],
            }],
          },
        ],
      }],
    },
    {
      type: "extension",
      attrs: {
        extensionType: "com.atlassian.ecosystem",
        extensionKey: "static-extension",
        localId: "static-extension-private-local-id",
        parameters: { privateMode: "static-extension-private-parameter" },
      },
    },
  ],
});

export const ADF_CONFORMANCE_DETAILS: ConfluencePageDetails = {
  id: "adf-conformance-page",
  title: "ADF Browser Conformance",
  url: "https://example.invalid/wiki/spaces/TEST/pages/adf-conformance-page",
  version: 1,
  spaceKey: "TEST",
  storage: "",
  created: "2026-07-22T08:00:00.000Z",
  modified: "2026-07-22T08:00:00.000Z",
  createdBy: { displayName: "Harness Author" },
  modifiedBy: { displayName: "Harness Author" },
  labels: ["browser-conformance"],
};

export const ADF_CONFORMANCE_METADATA: PdfExportMetadata = {
  title: "ADF Browser Conformance",
  space: "TEST",
  version: 1,
  author: "Harness Author",
  exporter: "atlcli browser harness",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-22T08:00:00.000Z"),
};

export const ADF_INLINE_MEDIA_FILENAME = "inline-media.png";
export const ADF_INLINE_MEDIA_BYTES = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (character) => character.charCodeAt(0),
);
export const ADF_CONFORMANCE_MEDIA_ATTACHMENTS = [{
  fileId: "inline-media-1",
  filename: ADF_INLINE_MEDIA_FILENAME,
  pageId: ADF_CONFORMANCE_DETAILS.id,
  mediaType: "image/png",
}] as const;

/** Decode the real ADF fixture through the production representation dispatcher. */
export function adfConformanceBlocks(exporter: "pdf" | "word"): BlocksResult {
  return pageBodyToBlocks(
    {
      primary: { representation: "atlas_doc_format", value: ADF_CONFORMANCE_SOURCE },
      sourceVersion: 1,
    },
    {
      exporter,
      pageContext: {
        id: ADF_CONFORMANCE_DETAILS.id,
        title: ADF_CONFORMANCE_DETAILS.title,
        url: ADF_CONFORMANCE_DETAILS.url,
        version: ADF_CONFORMANCE_DETAILS.version,
        spaceKey: ADF_CONFORMANCE_DETAILS.spaceKey,
      },
      resolveMediaAttachment: createAdfMediaAttachmentResolver(
        ADF_CONFORMANCE_MEDIA_ATTACHMENTS,
      ),
    },
  );
}

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
 * A three-page tree: a root page and two children. Chapter A carries its own
 * in-page anchor (`alpha`) AND a genuine CROSS-page link to Chapter B's anchor
 * (`beta`), so the compose step must offset heading levels, insert chapter page
 * breaks, namespace every anchor to `p<pageId>-<name>`, and rewrite the
 * cross-page link to Chapter B's namespaced destination — all with no
 * dangling-link diagnostic.
 *
 * Drives conformance **case 002 `scope`**
 * (`apps/browser-export-harness/src/scope-case.ts`) through `composeChapters` →
 * both engines. The SAME nodes run browser-side and CLI-side, so a digest
 * divergence is a real engine divergence, never a fixture drift.
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
    // A CROSS-page link to Chapter B's `beta` anchor — composeChapters resolves
    // the page (by contentId, in scope), namespaces both pages' anchors, and
    // rewrites this link to Chapter B's `p<pageId>-beta` destination so it
    // resolves (no dangling-link diagnostic).
    {
      type: "paragraph",
      content: [
        {
          type: "link",
          target: { kind: "page", contentId: "chapter-b", contentTitle: "Chapter B", anchor: "beta" },
          content: [{ type: "text", text: "See Chapter B" }],
        },
      ],
    },
  ]),
  page("chapter-b", "Chapter B", 1, 1, "root", [
    { type: "heading", level: 1, content: [{ type: "text", text: "Chapter B" }] },
    { type: "anchor", name: "beta" },
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
