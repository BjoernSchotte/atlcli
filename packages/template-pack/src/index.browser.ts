/**
 * Browser-safe entry point for `@atlcli/template-pack` (spec 007 T2.4).
 *
 * Pure byte-in/byte-out functions for the `.wiki-pdf-template` container,
 * shared by the Typst and DOCX engines. Every module re-exported here MUST
 * build for `--target=browser` with zero `node:`/`bun:` specifiers in its
 * transitive graph — enforced by `scripts/check-browser-build.ts`.
 */
export * from "./manifest.js";
export * from "./design.js";
export * from "./bindings.js";
export * from "./localization.js";
export * from "./localize.js";
export * from "./pack.js";
export * from "./unpack.js";
export * from "./validate.js";
