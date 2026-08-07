/**
 * Internal (non-frozen) entry point for `@atlcli/pdf` (spec 009).
 *
 * Implementation-detail modules deliberately kept out of the published `.`
 * and `./browser` barrels: Typst escaping, document preparation and
 * serialization (incl. `mapPdfDiagnostics`), the raw template, theming, and
 * output validation. They remain importable — in-repo consumers and
 * adventurous hosts can reach them here — but they are **not** part of the
 * frozen v1 API and may change without notice between versions.
 */
export * from "./builtin-template.js";
export * from "./curated-templates.js";
export * from "./design-catalog.js";
export * from "./escape.js";
export * from "./prepare.js";
export * from "./serialize.js";
export * from "./template.js";
export * from "./template-v4.js";
export * from "./template-pack.js";
export * from "./template-preview.js";
export * from "./theme.js";
export * from "./validate.js";
