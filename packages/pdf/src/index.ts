/**
 * Default (Node) entry point for `@atlcli/pdf` (spec 009).
 *
 * The package is fully isomorphic, so the default barrel is identical to the
 * browser one — trimmed to the documented host-facing seams (see
 * `index.browser.ts`). Rendering internals live behind `./template` and the
 * non-frozen `./internal` subpath.
 */
export * from "./index.browser.js";
