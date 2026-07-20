/**
 * Node entry point for `@atlcli/template-pack` (spec 007 T2.4).
 *
 * The container functions are isomorphic, so the node entry is identical to the
 * browser entry — there are no node-only adapters. Kept as a separate file to
 * match the dual-entry convention of the other packages.
 */
export * from "./index.browser.js";
