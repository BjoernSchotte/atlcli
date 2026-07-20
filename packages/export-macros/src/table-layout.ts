/**
 * scroll-tablelayout renderer (spec 004, E4 — legacy-migration content).
 *
 * A pure, transparent body wrapper (`requiresLivePort: false`): it renders the
 * macro's body unchanged, optionally applying the `widths` parameter to the
 * body's top-level tables via the existing `columnWidths` field.
 */
import type { ExportBlock, ExportNote } from "@atlcli/confluence";
import { macroParamText } from "./params.js";
import type {
  MacroExportContext,
  MacroInstance,
  MacroRenderer,
  MacroRenderResult,
} from "./types.js";

const MACROS = ["scroll-tablelayout", "scroll-tablelayout-macro"];

/** Parse a comma-separated widths string into positive numbers, or undefined. */
export function parseWidths(raw: string | undefined): number[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim().replace(/(px|%)$/i, ""))
    .map((p) => Number.parseFloat(p));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n <= 0)) return undefined;
  return parts;
}

function applyWidths(blocks: ExportBlock[], widths: number[]): ExportBlock[] {
  return blocks.map((b) => (b.type === "table" ? { ...b, columnWidths: widths } : b));
}

export function scrollTableLayoutRenderer(): MacroRenderer {
  return {
    id: "scroll-tablelayout",
    macros: MACROS,
    requiresLivePort: false,
    async render(m: MacroInstance, _ctx: MacroExportContext): Promise<MacroRenderResult> {
      const body = m.body;
      if (!body || body.length === 0) return { kind: "skip" };

      const notes: ExportNote[] = [];
      const orientation = macroParamText(m.params, "orientation");
      if (orientation && orientation.toLowerCase() === "landscape") {
        notes.push({
          level: "info",
          code: "macro-rendered-via",
          message: "scroll-tablelayout `orientation=landscape` is noted but not applied in this version.",
          macroName: m.name,
        });
      }

      const widths = parseWidths(macroParamText(m.params, "widths"));
      let blocks = body;
      if (widths) {
        blocks = applyWidths(body, widths);
      } else if (macroParamText(m.params, "widths")) {
        notes.push({
          level: "info",
          code: "macro-rendered-via",
          message: "scroll-tablelayout `widths` not recognized; table layout left unchanged.",
          macroName: m.name,
        });
      }

      if (notes.length === 0) {
        notes.push({
          level: "info",
          code: "macro-rendered-via",
          message: "scroll-tablelayout body rendered.",
          macroName: m.name,
        });
      }
      return { kind: "blocks", blocks, notes, bodyConsumed: true };
    },
  };
}
