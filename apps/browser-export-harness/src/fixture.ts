/**
 * Re-export shim. The fixtures now live in `@atlcli/export-fixtures` so the
 * Bun/CLI shape-parity runner and the browser harness share one source of truth
 * (spec 011 — "Fixtures are the contract"). Existing case modules keep importing
 * from `./fixture.js` unchanged.
 */
export * from "@atlcli/export-fixtures";
