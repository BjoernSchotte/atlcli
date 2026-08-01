import type { ExportBlock, ExportNote } from "@atlcli/confluence";
import type { NormalizeChartMacroDep } from "./deps.js";
import type { MacroInstance, MacroRenderer, MacroRenderResult } from "./types.js";

export function chartMacroRenderer(deps: { normalizeChartMacro: NormalizeChartMacroDep }): MacroRenderer {
  return {
    id: "chart",
    macros: ["chart"],
    webRenderModel: { kind: "chart", dependencies: ["confluence", "attachment"] },
    requiresLivePort: false,
    async render(m: MacroInstance): Promise<MacroRenderResult> {
      const result = deps.normalizeChartMacro(m.params, m.body ?? [], "cloud-adf");
      const notes: ExportNote[] = result.diagnostics.map((diagnostic) => ({
        level: "warning",
        code: "macro-not-rendered",
        message: `Chart macro: ${diagnostic.message}`,
        macroName: "chart",
      }));
      if (!result.model) return { kind: "skip", notes };
      const block: Extract<ExportBlock, { type: "chart" }> = {
        type: "chart",
        chart: result.model,
        ...(m.adfExtension?.localId ? { localId: m.adfExtension.localId } : {}),
      };
      return { kind: "blocks", blocks: [block], notes };
    },
  };
}
