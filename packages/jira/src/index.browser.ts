/**
 * Browser-safe entry point for `@atlcli/jira` (spec 010 T5.4).
 *
 * ## Why this exists
 *
 * The default barrel (`./index.ts`) re-exports the CLI-shaped half of this
 * package — `webhook-server.ts` (Bun-native `Server`), `templates.ts`,
 * `worklog.ts`, `export.ts` and `import.ts` (all `node:fs`/`node:os`/
 * `node:path`) — so importing `@atlcli/jira` from a bundled browser host drags
 * `node:`/`bun:` specifiers into the graph. `packages/jira/src/client.ts` was
 * already on `BROWSER_ENTRYPOINTS` and already isomorphic, but there was no
 * *importable* way to say so: the Chrome extension therefore shipped without a
 * Jira client at all, and every Jira macro silently fell through to the
 * `export_view` stage while the CLI rendered a real issue table for the same
 * page. This barrel is what makes "the panel and the CLI resolve macros the
 * same way" a thing the build can check rather than a claim.
 *
 * This entry mirrors the spec-001 `@atlcli/core` / spec-003
 * `@atlcli/confluence` pattern: it exports ONLY the isomorphic surface — the
 * REST client and its types — and is itself gated by the browser-build CI check
 * (`scripts/check-browser-build.ts`).
 *
 * Every module re-exported here MUST build for `--target=browser` with zero
 * `node:`/`bun:` specifiers in its transitive graph. Add more modules only when
 * they are provably isomorphic (i.e. present in `BROWSER_ENTRYPOINTS`).
 *
 * `auth-redirect.ts` and `retry-after.ts` are deliberately NOT re-exported:
 * they are internal guards that `client.ts` uses, kept off every barrel on
 * purpose (see their own headers) so spec 009 does not freeze them.
 */

export * from "./client.js";
export * from "./types.js";
