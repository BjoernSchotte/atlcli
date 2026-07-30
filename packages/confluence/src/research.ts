/**
 * Minimal Confluence surface for the MV3 research worker.
 *
 * Keep this entrypoint free of the storage↔Markdown converter: Turndown owns
 * DOM-oriented initialization that is valid in extension pages but not in a
 * DedicatedWorkerGlobalScope. Research needs only the REST client, the
 * dependency-free Storage→ExportBlock parser, and URL sanitization.
 */
export * from "./client.js";
export * from "./export-blocks.js";
export * from "./link-safety.js";
