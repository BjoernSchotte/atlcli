import type { ConfluencePageDetails, ExportBlock } from "@atlcli/confluence/browser";
import { buildDocx, para, stylesXml } from "@atlcli/docx/fixtures";
import type { PdfExportMetadata } from "@atlcli/pdf/browser";

const MERMAID_SOURCE = "flowchart LR\n  Source --> Export\n  Export --> Document";

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

export const PDF_BLOCKS: ExportBlock[] = [
  {
    type: "heading",
    level: 1,
    content: [{ type: "text", text: "Browser package contract" }],
  },
  {
    type: "paragraph",
    content: [
      { type: "text", text: "The PDF runner is hosted by a neutral module Worker." },
    ],
  },
  {
    type: "list",
    ordered: false,
    items: [
      {
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "WASM and fonts are local" }],
          },
        ],
      },
      {
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "The repeat is deterministic" }],
          },
        ],
      },
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
