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
  assets: Object.freeze({}),
  notes: "inline",
});
