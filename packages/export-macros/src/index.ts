/**
 * `@atlcli/export-macros` — the macro-renderer registry, async resolver pass,
 * and the concrete renderers for spec 004 (E1–E5).
 *
 * ## Package boundary
 *
 * This package has **zero runtime imports** from any `@atlcli/*` package — only
 * type-level imports of `ExportBlock`/`ExportNote`/`MacroParameter`/… from
 * `@atlcli/confluence`. Everything host-facing (the `storageToBlocks` walker,
 * `htmlToExportBlocks`, `parsePageProperties`, and the port implementations
 * over `JiraClient`/`ConfluenceClient`) is injected at construction time. The
 * browser-build gate (`scripts/check-browser-build.ts`) enforces this the same
 * way it enforces browser safety elsewhere: a stray runtime import of a
 * node-only package turns the gate red.
 *
 * ## Host wiring contract (see spec 004 "Host wiring")
 *
 * A host builds the registry via {@link defaultRegistry} (passing the three
 * injected functions) and threads a {@link MacroResolutionOptions} through the
 * engine env (`ExportInput.macros` / `PdfExportEnv.macros`). The engine calls
 * {@link resolveMacroBlocks} once on the composed block tree.
 *
 * - **CLI** adapts `JiraClient`/`ConfluenceClient` (token auth) into the ports.
 * - **Extension** (T5.4, post-M1) supplies the same ports over its session
 *   `fetch` against the current site (`…/rest/api/3` for Jira on connected
 *   sites, `/wiki/rest/api` for export_view) — no package changes needed.
 */
export * from "./types.js";
export * from "./deps.js";
export * from "./params.js";
export * from "./resolve.js";
export * from "./registry.js";
export * from "./toc.js";
export * from "./jira.js";
export * from "./diagram.js";
export * from "./multiexcerpt.js";
export * from "./table-layout.js";
export * from "./children.js";
export * from "./include-excerpt.js";
export * from "./page-properties-report.js";
export * from "./export-view.js";
