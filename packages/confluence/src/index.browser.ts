/**
 * Browser-safe entry point for `@atlcli/confluence` (spec 003 Task 0).
 *
 * The Node barrel (`./index.ts`) re-exports node-only modules (webhook-server,
 * sync-db, poller, atlcli-dir, …) which drag `node:`/`bun:` specifiers into the
 * graph. This entry mirrors the spec-001 `@atlcli/core` pattern: it exports
 * ONLY the isomorphic surface the Chrome extension needs — the REST client and
 * the storage<->markdown converter — both already gated by the browser-build
 * CI check (`scripts/check-browser-build.ts`).
 *
 * Every module re-exported here MUST build for `--target=browser` with zero
 * `node:`/`bun:` specifiers in its transitive graph. Add more modules only when
 * they are provably isomorphic (i.e. present in `BROWSER_ENTRYPOINTS`).
 */

export * from "./client.js";
export * from "./markdown.js";
export * from "./asset-budget.js";
export * from "./compose-document.js";
export * from "./export-blocks.js";
export * from "./html-to-blocks.js";
export * from "./macro-extract.js";
export * from "./export-progress.js";
export * from "./export-scope.js";
export * from "./in-order-limiter.js";
export * from "./pagination.js";
export * from "./tree-fetch.js";
export * from "./resolve-mentions.js";
export * from "./page-properties.js";
