import type { ExportBlock } from "@atlcli/export-blocks";
import type { AstroExportBlockRenderContextV1 } from "./index.js";

/** Minimal deterministic fixture for package and plain-Astro consumer probes. */
export const EXPORT_BLOCKS_ASTRO_MINIMAL_FIXTURE_V1: readonly ExportBlock[] = Object.freeze([
  {
    type: "heading",
    level: 1,
    content: [{ type: "text", text: "Publication guide" }],
    explicitAnchor: "publication-guide",
  },
  {
    type: "paragraph",
    content: [{ type: "text", text: "Structured ExportBlock fixture." }],
  },
]);

/** Minimal render-safe context paired with the package fixture. */
export const EXPORT_BLOCKS_ASTRO_MINIMAL_CONTEXT_V1: AstroExportBlockRenderContextV1 = Object.freeze({
  locale: "en",
  direction: "ltr",
  headings: Object.freeze({
    "publication-guide": Object.freeze({ id: "publication-guide", level: 1, text: "Publication guide" }),
  }),
  links: Object.freeze({}),
  assets: Object.freeze({
    "attachment::diagram.svg": Object.freeze({
      src: "/assets/diagram.svg",
      mediaType: "image/svg+xml",
      alt: "Resolved diagram",
      srcset: Object.freeze([
        Object.freeze({ src: "/assets/diagram.svg", width: 320, mediaType: "image/svg+xml" }),
        Object.freeze({ src: "/assets/diagram.svg", width: 960, mediaType: "image/svg+xml" }),
      ]),
      sizes: "(max-width: 60rem) 100vw, 60rem",
      width: 960,
      height: 540,
      downloadHref: "/assets/diagram.svg",
      downloadName: "diagram.svg",
      mode: "astro-responsive",
    }),
  }),
  notes: "inline",
});

/** Exhaustive discriminator fixture for the plain-Astro render-kit consumer. */
export const EXPORT_BLOCKS_ASTRO_ALL_FIELDS_FIXTURE_V1: readonly ExportBlock[] = Object.freeze([
  {
    type: "heading", level: 1, explicitAnchor: "all-fields",
    content: [{ type: "text", text: "All fields", marks: ["bold", "italic", "code", "strike", "underline", "subscript", "superscript"] }],
  },
  {
    type: "paragraph",
    content: [
      { type: "text", text: "Text " },
      { type: "link", target: { kind: "external", href: "https://example.test/guide" }, content: [{ type: "text", text: "link" }] },
      { type: "mention", accountId: "private", displayName: "Reader" },
      { type: "date", timestamp: "1704067200000" },
      { type: "status", text: "done", color: "green" },
      { type: "smartCard", card: { appearance: "inline", source: "url", title: "Inline card", url: "https://example.test/card" } },
      { type: "media", media: { filename: "inline.png" }, alt: "Inline media" },
      { type: "placeholder", text: "hidden" }, { type: "lineBreak" },
    ],
  },
  { type: "smartCard", card: { appearance: "block", source: "url", title: "Block card", url: "https://example.test/card" } },
  { type: "codeBlock", language: "ts", title: "example.ts", code: "const answer = 42;", caption: { kind: "code", content: [{ type: "text", text: "Example source" }] } },
  { type: "callout", kind: "info", title: "Notice", content: [{ type: "paragraph", content: [{ type: "text", text: "Callout body" }] }] },
  { type: "expand", nested: false, title: "Details", content: [{ type: "paragraph", content: [{ type: "text", text: "Expanded" }] }] },
  { type: "list", ordered: true, start: 3, listKind: "task", items: [{ kind: "task", checked: true, content: [{ type: "paragraph", content: [{ type: "text", text: "Task" }] }] }] },
  { type: "layout", columns: [{ width: 50, content: [{ type: "paragraph", content: [{ type: "text", text: "Column" }] }] }, { width: 50, content: [] }] },
  { type: "table", caption: { kind: "table", content: [{ type: "text", text: "Example table" }] }, rows: [{ cells: [{ header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }] }, { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }] }] }] },
  { type: "image", source: { kind: "attachment", filename: "diagram.svg" }, alt: "Diagram", caption: { kind: "figure", content: [{ type: "text", text: "Architecture diagram" }] } },
  { type: "mediaFallback", label: "Movie", media: { mediaType: "video", filename: "movie.mp4" } },
  { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quote" }] }] },
  { type: "divider" }, { type: "pageBreak" },
  { type: "orientation", landscape: true, content: [{ type: "paragraph", content: [{ type: "text", text: "Landscape" }] }] },
  { type: "anchor", name: "bookmark" },
  { type: "unknown", macroName: "custom-widget", plainBody: "<not-html-executed />", body: [{ type: "paragraph", content: [{ type: "text", text: "Fallback body" }] }] },
]);
