/**
 * `@atlcli/export-macros` — the macro-renderer registry, async resolver pass,
 * and the concrete renderers for spec 004 (E1–E5).
 *
 * ## Frozen v1 surface (spec 009)
 *
 * This barrel exposes ONLY the documented v1 seams (see
 * `docs/reference/export-api.md`): the registry/port CONTRACT
 * (`MacroRendererRegistry`, `defaultRegistry`/`createRegistry`, the injected
 * dep + port interfaces) and the resolver pass (`resolveMacroBlocks` +
 * `MacroResolutionOptions`). The concrete renderer INSTANCES (`tocRenderer`,
 * `jiraMacroRenderer`, …) and their helpers (`slugifyHeading`, `issueTable`,
 * `jiraStatusColor`, …) are wired internally by `defaultRegistry` and are NOT
 * part of the frozen surface — they stay reachable via `./internal`. The
 * renderer SET may still grow additively without a breaking change; the
 * registry/resolve contract itself is what freezes. A blanket `export *` is
 * deliberately not used (it would freeze every concrete renderer + helper).
 *
 * ## Package boundary
 *
 * Zero RUNTIME imports from any `@atlcli/*` package — only type-level imports
 * of `ExportBlock`/`ExportNote`/`MacroParameter`/… from `@atlcli/confluence`.
 * Host-facing dependencies (the `storageToBlocks` walker, `htmlToExportBlocks`,
 * `parsePageProperties`, the `JiraClient`/`ConfluenceClient` ports) are
 * injected at construction time. Enforced by `scripts/check-browser-build.ts`.
 */

// --- Registry + port contract (types.ts) ---
export { portError, isPortError, isAbortError } from "./types.js";
export type {
  MacroRendererRegistry,
  MacroRenderer,
  MacroRenderResult,
  MacroInstance,
  MacroInstanceId,
  MacroExportContext,
  MacroResolutionOptions,
  MacroResolutionBudget,
  PortError,
  PortErrorKind,
  AttachmentMeta,
  AttachmentLookupPort,
  ConfluenceContentPort,
  ExportViewPort,
  JiraIssuePort,
  JiraIssueRef,
  ExternalAssetPolicy,
  ExternalAssetFetcher,
} from "./types.js";

// --- Injected registry dependencies (deps.ts + registry.ts) ---
export { createRegistry, defaultRegistry } from "./registry.js";
export type { DefaultRegistryDeps } from "./registry.js";
export type {
  StorageToBlocksDep,
  HtmlToExportBlocksDep,
  ParsePagePropertiesDep,
  ExtractMacroBodyDep,
} from "./deps.js";

// --- Resolver pass (resolve.ts) ---
export {
  resolveMacroBlocks,
  MACRO_RENDERED_VIA,
  MACRO_DEGRADED,
  MACRO_SKIPPED_BY_CONFIG,
} from "./resolve.js";
export type { UnknownBlock } from "./resolve.js";
