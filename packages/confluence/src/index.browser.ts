/**
 * Browser-safe entry point for `@atlcli/confluence` (spec 003 Task 0).
 *
 * Since the spec 009 barrel trim, the default (Node) barrel (`./index.ts`)
 * re-exports exactly this browser barrel — the node-only sync machinery
 * (webhook-server, sync-db, poller, atlcli-dir, …), which drags
 * `node:`/`bun:` specifiers into the graph, lives behind the explicitly
 * non-frozen `./internal` subpath (`./internal.ts`). This entry mirrors the
 * spec-001 `@atlcli/core` pattern: it exports ONLY the isomorphic surface the
 * Chrome extension needs — the REST client and the storage<->markdown
 * converter — both already gated by the browser-build CI check
 * (`scripts/check-browser-build.ts`).
 *
 * Every module re-exported here MUST build for `--target=browser` with zero
 * `node:`/`bun:` specifiers in its transitive graph. Add more modules only when
 * they are provably isomorphic (i.e. present in `BROWSER_ENTRYPOINTS`).
 */

export * from "./client.js";
export * from "./comment-text.js";
export * from "./page-body.js";
export * from "./page-body-to-blocks.js";
export * from "./adf-types.js";
export * from "./adf-coverage.js";
export * from "./adf-validate.js";
export * from "./adf-to-blocks.js";
export * from "./markdown.js";
export * from "./asset-budget.js";
export * from "./compose-document.js";
export * from "./export-blocks.js";
export * from "./datasource.js";
export * from "./html-to-blocks.js";
export * from "./macro-extract.js";
export * from "./export-progress.js";
export * from "./export-scope.js";
export * from "./in-order-limiter.js";
export * from "./pagination.js";
export * from "./tree-fetch.js";
export * from "./resolve-mentions.js";
export * from "./page-properties.js";
export * from "./svg-safety.js";
export * from "./link-safety.js";
