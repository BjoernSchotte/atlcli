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
export * from "./serialize.js";
export * from "./ooxml.js";
