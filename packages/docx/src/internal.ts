/**
 * Internal (non-frozen) entry point for `@atlcli/docx` (spec 009).
 *
 * Implementation-detail modules deliberately kept out of the published `.`
 * and `./browser` barrels: the template scanner, placeholder resolver, block
 * serializer, and OOXML helpers. They remain importable — in-repo consumers
 * and adventurous hosts can reach them here — but they are **not** part of
 * the frozen v1 API and may change without notice between versions.
 */
export * from "./scan.js";
export * from "./resolver.js";
export * from "./include-lookup.js";
export * from "./serialize.js";
export * from "./ooxml.js";
// Non-frozen helpers dropped from the trimmed v1 barrel (spec 009 review C1):
// placeholder classification, date formatting, image/OOXML embedding, and the
// numbering + lower-level export helpers stay reachable here for in-repo
// consumers and adventurous hosts.
export * from "./placeholder-map.js";
export * from "./dateformat.js";
export * from "./image.js";
export * from "./numbering.js";
export * from "./export.js";
