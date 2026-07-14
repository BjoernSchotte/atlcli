/**
 * DOCX export barrel (spec 004 Tasks 3–5). Re-exports the browser-safe,
 * unit-testable surface the panel wires together: template scan + store,
 * placeholder resolver, OOXML serialization, and the export orchestration.
 */
export * from "./placeholder-map.js";
export * from "./dateformat.js";
export * from "./scan.js";
export * from "./resolver.js";
export * from "./serialize.js";
export * from "./export.js";
export * from "./template-store.js";
export { CODE_STYLE_ID, resolveHeadingStyleId, parseStyleNames, normalizeColor } from "./ooxml.js";
