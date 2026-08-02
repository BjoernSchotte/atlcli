import type { ExportBlock } from "@atlcli/export-blocks";

export const PUBLISHED_RELEASE_BLOCKS_V1: readonly ExportBlock[] = [
  {
    type: "paragraph",
    content: [{ type: "text", text: "This body was published from ExportBlock[], not Markdown." }],
  },
  {
    type: "callout",
    kind: "note",
    title: "Starlight is the presentation layer",
    content: [{
      type: "paragraph",
      content: [{ type: "text", text: "Navigation, search, color modes, and page chrome remain Starlight features." }],
    }],
  },
  {
    type: "heading",
    level: 2,
    explicitAnchor: "published-content",
    content: [{ type: "text", text: "Published content" }],
  },
  {
    type: "codeBlock",
    language: "ts",
    title: "publish.ts",
    code: "const source = 'ExportBlock[]';",
    wrap: true,
    highlightLines: [1],
    caption: { kind: "code", content: [{ type: "text", text: "Normalized source data" }] },
  },
  {
    type: "codeBlock",
    language: "ts\"><script>",
    title: "hostile\" title {1}",
    code: "</script><img src=x onerror=alert(1)>",
  },
  {
    type: "list",
    ordered: false,
    items: [
      { content: [{ type: "paragraph", content: [{ type: "text", text: "The document renderer remains the single ExportBlock dispatcher." }] }] },
      { content: [{ type: "paragraph", content: [{ type: "text", text: "Starlight tokens style the document-body slot without DOM-selector coupling." }] }] },
    ],
  },
];
