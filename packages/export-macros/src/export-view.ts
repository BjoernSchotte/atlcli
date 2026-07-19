/**
 * export_view fallback renderer (spec 004, T1.10) — the `"*"` catch-all.
 *
 * Confluence renders the macro server-side to HTML (the `export_view` body
 * representation, which transparently also carries the ADF-exported output of
 * current-generation third-party apps); a small HTML-subset converter
 * (injected, from `@atlcli/confluence`) turns that into real blocks.
 */
import type {
  MacroExportContext,
  MacroInstance,
  MacroRenderer,
  MacroRenderResult,
} from "./types.js";
import { isAbortError, isPortError } from "./types.js";
import type { HtmlToExportBlocksDep } from "./deps.js";

export function exportViewFallbackRenderer(deps: {
  htmlToExportBlocks: HtmlToExportBlocksDep;
}): MacroRenderer {
  return {
    id: "export-view",
    macros: ["*"],
    requiresLivePort: true,
    async render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult> {
      if (!ctx.exportView || !m.macroId) return { kind: "skip" };
      try {
        const html = await ctx.exportView.renderMacroHtml(ctx.page.id, m.macroId);
        if (!html) return { kind: "skip" };
        const { blocks, notes } = deps.htmlToExportBlocks(html);
        if (blocks.length === 0) return { kind: "skip", notes };
        return {
          kind: "blocks",
          blocks,
          notes: [
            {
              level: "info",
              code: "macro-rendered-via",
              message: `The "${m.name}" macro was rendered via Confluence export_view.`,
              macroName: m.name,
            },
            ...notes,
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
                message: `export_view fallback skipped for "${m.name}": ${err.message}`,
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
