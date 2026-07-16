/**
 * Browser-safe entry point for `@atlcli/docx` (spec 006).
 *
 * Exports ONLY the isomorphic engine surface: pure transforms plus the
 * injected-interface contract ({@link ExportEnv} / {@link runExport}). Every
 * module re-exported here MUST build for `--target=browser` with zero
 * `node:`/`bun:` specifiers in its transitive graph — enforced by
 * `scripts/check-browser-build.ts`. Host adapters live with their hosts:
 * the Node filesystem adapters in `./node-adapters.ts` (node barrel only),
 * the extension's IndexedDB/download adapters in `apps/extension`.
 */
export * from "./placeholder-map.js";
export * from "./dateformat.js";
export * from "./scan.js";
export * from "./resolver.js";
export * from "./serialize.js";
export * from "./export.js";
export * from "./env.js";
export * from "./image.js";
export { CODE_STYLE_ID, resolveHeadingStyleId, parseStyleNames, normalizeColor } from "./ooxml.js";
