/**
 * Browser-safe entry point for `@atlcli/docx` (spec 006).
 *
 * Exports ONLY the isomorphic engine surface: pure transforms plus the
 * injected-interface contract ({@link ExportEnv} / {@link runExport}). Every
 * module re-exported here MUST build for `--target=browser` with zero
 * `node:`/`bun:` specifiers in its transitive graph — enforced by
 * `scripts/check-browser-build.ts`. Host adapters live with their hosts:
 * the Node filesystem adapters in `./node-adapters.ts` (node barrel only),
 * host-specific IndexedDB/session/download adapters stay with their host.
 * Neutral browser bootstrap/canvas capability is available only through the
 * explicit `./browser-runtime` subpath and is not re-exported here.
 */
export * from "./placeholder-map.js";
export * from "./dateformat.js";
// The mermaid renderer is the format-agnostic `@atlcli/diagram` adapter
// (shared with the PDF path, spec 007); re-exported here so DOCX consumers
// get `DiagramTheme`/`renderDiagram` from one barrel.
export * from "@atlcli/diagram";
export * from "./export.js";
export * from "./env.js";
export * from "./image.js";
// Implementation-detail modules (scan/resolver/serialize/ooxml) are NOT part
// of this barrel (spec 009 barrel trim): they stay reachable via the explicit
// `./scan` subpath and the non-frozen `./internal` subpath.
//
// The TYPES below are transitively required by the frozen v1 surface
// (RunExportInput reaches TemplateMeta/ResolveDeps; ExportReport reaches
// ScanResult; the numbering seam reaches NumberingAllocator) — the closure
// classification (spec 009 T4.2) flags any reachable-but-unexported type, so
// they are exported type-only here without re-adding the implementation
// modules to the barrel.
export type { IncludeLookupOutcome, PageOwner, ResolveDeps, TemplateMeta } from "./resolver.js";
export type { ScanHit, ScanResult } from "./scan.js";
export type { NumberingAllocator, NumberingBase, NumberingXml } from "./numbering.js";
