/**
 * Multiexcerpt-include renderer (spec 004, E4 — Appfire single-sourcing).
 *
 * Fetches the source page, extracts the named excerpt's body from the walked
 * block tree, and returns it as real blocks. Shares the recursion guard
 * (`ctx.visited`/`ctx.depth`) with the E5 include renderers so a multiexcerpt
 * that itself includes another is bounded.
 */
import type { ExportBlock, ExportNote } from "@atlcli/confluence";
import { macroParamText } from "./params.js";
import type {
  MacroExportContext,
  MacroInstance,
  MacroRenderer,
  MacroRenderResult,
} from "./types.js";
import { isAbortError, isPortError } from "./types.js";
import type { ExtractMacroBodyDep, StorageToBlocksDep } from "./deps.js";

const INCLUDE_MACROS = ["multiexcerpt-include-macro", "multiexcerpt-include"];
const DEFINITION_MACROS = ["multiexcerpt-macro", "multiexcerpt"];
const MAX_DEPTH = 5;

export function multiexcerptIncludeRenderer(deps: {
  storageToBlocks: StorageToBlocksDep;
  extractMacroBody: ExtractMacroBodyDep;
}): MacroRenderer {
  return {
    id: "multiexcerpt-include",
    macros: INCLUDE_MACROS,
    requiresLivePort: true,
    async render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult> {
      if (!ctx.confluence) return { kind: "skip" };
      // Appfire renamed the parameters between Server and Cloud generations.
      const pageTitle =
        macroParamText(m.params, "PageWithExcerpt") ?? macroParamText(m.params, "page");
      const name =
        macroParamText(m.params, "MultiExcerptName") ?? macroParamText(m.params, "name");
      if (!pageTitle || !name) return { kind: "skip" };

      const key = `${pageTitle}#${name}`;
      if (ctx.visited.has(key) || ctx.depth > MAX_DEPTH) {
        return {
          kind: "skip",
          notes: [cycleNote(m.name, key)],
        };
      }
      ctx.visited.add(key);

      try {
        const page = await ctx.confluence.getPageStorage(pageTitle, ctx.page.spaceKey);
        if (!page) {
          return { kind: "skip", notes: [notFoundNote(m.name, pageTitle)] };
        }
        // Extract the named excerpt from the SOURCE STORAGE (the walker renders
        // definition macros transparently, so a walked tree can no longer
        // locate them), then walk just that fragment.
        const fragment = deps.extractMacroBody(page.storage, DEFINITION_MACROS, name);
        if (!fragment) {
          return { kind: "skip", notes: [noFragmentNote(m.name, name, pageTitle)] };
        }
        const walked = deps.storageToBlocks(fragment, {
          pageContext: { id: page.id, version: page.version, spaceKey: ctx.page.spaceKey },
        });
        if (walked.blocks.length === 0) {
          return { kind: "skip", notes: [noFragmentNote(m.name, name, pageTitle)] };
        }
        return {
          kind: "blocks",
          blocks: walked.blocks,
          notes: [
            {
              level: "info",
              code: "macro-rendered-via",
              message: `Multiexcerpt "${name}" included from page "${pageTitle}".`,
              macroName: m.name,
            },
          ],
        };
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (isPortError(err)) {
          return {
            kind: "skip",
            notes: [
              {
                level: "warning",
                code: "macro-degraded",
                message: `Multiexcerpt include skipped: ${err.message}`,
                macroName: m.name,
              },
            ],
          };
        }
        return { kind: "skip" };
      }
    },
  };
}

function cycleNote(macroName: string, key: string): ExportNote {
  return {
    level: "info",
    code: "macro-degraded",
    message: `Include cycle or depth limit reached for "${key}"; not expanded.`,
    macroName,
  };
}
function notFoundNote(macroName: string, title: string): ExportNote {
  return {
    level: "warning",
    code: "macro-degraded",
    message: `Multiexcerpt source page "${title}" not found.`,
    macroName,
  };
}
function noFragmentNote(macroName: string, name: string, title: string): ExportNote {
  return {
    level: "warning",
    code: "macro-degraded",
    message: `Multiexcerpt "${name}" not found on page "${title}".`,
    macroName,
  };
}
