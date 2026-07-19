/**
 * Macro-renderer registry (spec 004, T1.7).
 *
 * `createRegistry` validates and freezes a renderer list into an immutable,
 * first-match-wins {@link MacroRendererRegistry}. `defaultRegistry` assembles
 * the standard renderer order.
 */
import type { MacroRenderer, MacroRendererRegistry } from "./types.js";
import type {
  HtmlToExportBlocksDep,
  ParsePagePropertiesDep,
  StorageToBlocksDep,
} from "./deps.js";
import { tocRenderer } from "./toc.js";
import { jiraMacroRenderer } from "./jira.js";
import { diagramMacroRenderer } from "./diagram.js";
import { multiexcerptIncludeRenderer } from "./multiexcerpt.js";
import { scrollTableLayoutRenderer } from "./table-layout.js";
import { childrenRenderer } from "./children.js";
import { includeRenderer, excerptIncludeRenderer, excerptRenderer } from "./include-excerpt.js";
import { pagePropertiesReportRenderer } from "./page-properties-report.js";
import { exportViewFallbackRenderer } from "./export-view.js";

/**
 * Dependencies the E1/E4/E5 renderers need, injected rather than imported at
 * runtime (see Architecture — DI, not runtime import). `storageToBlocks` and
 * `htmlToExportBlocks` live in `@atlcli/confluence`; host-wiring code imports
 * them and passes them in.
 */
export interface DefaultRegistryDeps {
  storageToBlocks: StorageToBlocksDep;
  htmlToExportBlocks: HtmlToExportBlocksDep;
  parsePageProperties: ParsePagePropertiesDep;
}

/**
 * Validate and freeze a renderer list into a {@link MacroRendererRegistry}.
 * Throws at construction time (not export time) if two non-catch-all renderers
 * claim the same lowercase macro name without one being an explicit override,
 * or if more than one renderer declares the `"*"` catch-all.
 */
export function createRegistry(renderers: readonly MacroRenderer[]): MacroRendererRegistry {
  validateRenderers(renderers);
  const frozen = Object.freeze([...renderers]);
  const registry: MacroRendererRegistry = {
    renderers: frozen,
    compose(...overrides: MacroRenderer[]): MacroRendererRegistry {
      // Overrides win → prepend. Still validated, but overrides may legitimately
      // shadow a built-in's macro name, so validation is override-aware.
      return createRegistryWithOverrides(overrides, frozen);
    },
  };
  return Object.freeze(registry);
}

function createRegistryWithOverrides(
  overrides: readonly MacroRenderer[],
  builtins: readonly MacroRenderer[]
): MacroRendererRegistry {
  // Overrides are validated among themselves (no two overrides may collide);
  // a built-in whose macro name an override claims is shadowed, not a conflict.
  validateRenderers(overrides);
  const shadowed = new Set<string>();
  for (const r of overrides) for (const m of r.macros) shadowed.add(m.toLowerCase());
  const overrideHasCatchAll = overrides.some((r) => r.macros.includes("*"));
  // Keep every built-in; first-match-wins in the resolver means a shadowed
  // built-in simply never fires. But a second `"*"` would still be invalid, so
  // drop the built-in catch-all if an override supplies one.
  const keptBuiltins = builtins.filter((r) => !(overrideHasCatchAll && r.macros.includes("*")));
  const merged = [...overrides, ...keptBuiltins];
  // Final invariant check across the merged list, but tolerate a name appearing
  // in both an override and a built-in (that's the whole point of an override).
  validateRenderers(merged, { allowDuplicatesShadowedBy: shadowed });
  const frozen = Object.freeze(merged);
  return Object.freeze({
    renderers: frozen,
    compose(...more: MacroRenderer[]): MacroRendererRegistry {
      return createRegistryWithOverrides(more, frozen);
    },
  });
}

function validateRenderers(
  renderers: readonly MacroRenderer[],
  opts?: { allowDuplicatesShadowedBy?: Set<string> }
): void {
  const shadow = opts?.allowDuplicatesShadowedBy;
  let catchAllCount = 0;
  const claimedBy = new Map<string, string>();
  for (const r of renderers) {
    for (const raw of r.macros) {
      const name = raw.toLowerCase();
      if (name === "*") {
        catchAllCount += 1;
        continue;
      }
      const prior = claimedBy.get(name);
      if (prior !== undefined) {
        // Duplicate is allowed only when the name is shadowed by an override
        // AND both claimants are the (override, built-in) pair — but since the
        // override always comes first in `merged`, the first claimant wins in
        // the resolver, so we accept the pair silently.
        if (shadow?.has(name)) continue;
        throw new Error(
          `Macro renderer conflict: both "${prior}" and "${r.id}" claim macro "${name}". ` +
            `Register exactly one non-catch-all renderer per macro name (use compose() to override).`
        );
      }
      claimedBy.set(name, r.id);
    }
  }
  if (catchAllCount > 1) {
    throw new Error(
      `Macro renderer conflict: ${catchAllCount} renderers declare the "*" catch-all; exactly one is allowed.`
    );
  }
}

/**
 * Assemble the standard renderer order: TOC first (pure reference renderer),
 * then the specific renderers (Jira, diagram, multiexcerpt-include,
 * scroll-tablelayout, children, include/excerpt, page-properties-report),
 * `exportViewFallbackRenderer` last as the `"*"` catch-all.
 */
export function defaultRegistry(deps: DefaultRegistryDeps): MacroRendererRegistry {
  return createRegistry([
    tocRenderer(),
    jiraMacroRenderer(),
    diagramMacroRenderer(),
    multiexcerptIncludeRenderer({ storageToBlocks: deps.storageToBlocks }),
    scrollTableLayoutRenderer(),
    childrenRenderer(),
    includeRenderer({ storageToBlocks: deps.storageToBlocks }),
    excerptIncludeRenderer({ storageToBlocks: deps.storageToBlocks }),
    excerptRenderer(),
    pagePropertiesReportRenderer({
      storageToBlocks: deps.storageToBlocks,
      parsePageProperties: deps.parsePageProperties,
    }),
    exportViewFallbackRenderer({ htmlToExportBlocks: deps.htmlToExportBlocks }),
  ]);
}
