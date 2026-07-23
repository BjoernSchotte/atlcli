/**
 * `@atlcli/export-node` — the batteries-included Node consumer package
 * (spec 009 / BASELINE-DESIGN §A5).
 *
 * Bundles everything a plain Node/Bun host needs to drive the export engines
 * without hand-wiring wasm bytes, font bytes, template assets, or filesystem
 * adapters:
 *
 * ```ts
 * import { fetchExportTree, composeChapters } from "@atlcli/confluence";
 * import { runPdfExport } from "@atlcli/pdf";
 * import { nodePdfEnv, confluenceTreeSource } from "@atlcli/export-node";
 *
 * const tree = await fetchExportTree(confluenceTreeSource(profile),
 *   { kind: "tree", rootPageId: "123" }, { labels: { exclude: ["internal"] } });
 * const doc = composeChapters(tree.nodes);
 * await runPdfExport({ blocks: doc.blocks, metadata, filename: "handbook.pdf" },
 *   nodePdfEnv(profile, { outDir: "dist" }));
 * ```
 */
export * from "./asset-fetcher.js";
export * from "./docx-env.js";
export * from "./pdf-env.js";
export * from "./tree-source.js";
export * from "./jobs/paths.js";
export * from "./jobs/file-lock.js";
export * from "./jobs/file-job-store.js";
export * from "./jobs/file-spool-store.js";
export * from "./jobs/file-artifact-store.js";
export * from "./jobs/delivery.js";
export * from "./jobs/reconcile.js";
export * from "./jobs/persistence.js";
export * from "./jobs/executor-stores.js";
export * from "./jobs/render-reservation.js";
export * from "./jobs/runtime.js";
export * from "./jobs/retention.js";
// Re-exported Node adapters so one import covers the full host wiring story.
export {
  fileOutputSink,
  fileTemplateSource,
  resvgSvgRasterizer,
  unsupportedAssetFetcher,
} from "@atlcli/docx";
