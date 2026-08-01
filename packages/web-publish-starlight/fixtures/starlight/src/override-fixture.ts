import type { ExportBlock } from "@atlcli/export-blocks";
import type { AstroExportBlockRenderContextV1 } from "@atlcli/export-blocks-astro";

/** Identical normalized input for the baseline and trusted-heading variants. */
export const OVERRIDE_INVARIANT_BLOCKS_V1: readonly ExportBlock[] = [
  { type: "heading", level: 2, explicitAnchor: "invariant-heading", content: [{ type: "text", text: "Invariant heading" }] },
  {
    type: "paragraph",
    content: [
      { type: "text", text: "override-invariant-token " },
      { type: "link", target: { kind: "external", href: "https://docs.example.test/invariant" }, content: [{ type: "text", text: "resolved link" }] },
    ],
  },
  { type: "image", source: { kind: "attachment", filename: "diagram.svg" }, alt: "Resolved diagram" },
  { type: "unknown", macroName: "unsupported-widget", plainBody: "<script>must-not-execute</script>" },
];

export const OVERRIDE_INVARIANT_CONTEXT_V1: AstroExportBlockRenderContextV1 = {
  locale: "en",
  direction: "ltr",
  headings: { "invariant-heading": { id: "invariant-heading", level: 2, text: "Invariant heading" } },
  links: {},
  assets: {
    "attachment::diagram.svg": { src: "/assets/diagram.svg", mediaType: "image/svg+xml", alt: "Resolved diagram" },
  },
  notes: "inline",
};
