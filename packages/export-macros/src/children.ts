/**
 * `children` macro renderer (spec 004, E5): a list of child-page links.
 */
import type { ExportBlock, ExportNote, InlineNode, ListItem } from "@atlcli/confluence";
import { macroParamText } from "./params.js";
import type {
  MacroExportContext,
  MacroInstance,
  MacroRenderer,
  MacroRenderResult,
} from "./types.js";
import { isAbortError, isPortError } from "./types.js";

const DEFAULT_CAP = 50;
const HARD_CAP = 200;

export function childrenRenderer(): MacroRenderer {
  return {
    id: "children",
    macros: ["children"],
    requiresLivePort: true,
    async render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult> {
      if (!ctx.confluence) return { kind: "skip" };

      const depthAll = (macroParamText(m.params, "depth") ?? "").toLowerCase() === "all";
      const limit = depthAll ? HARD_CAP : DEFAULT_CAP;

      const notes: ExportNote[] = [];
      const sortParam = (macroParamText(m.params, "sort") ?? "title").toLowerCase();
      if (sortParam !== "title" && sortParam !== "created") {
        notes.push({
          level: "info",
          code: "macro-rendered-via",
          message: `children macro: unsupported sort "${sortParam}"; using title order.`,
          macroName: m.name,
        });
      }

      try {
        // Fetch one past the cap so we can detect + report truncation.
        const children = await ctx.confluence.getChildren(ctx.page.id, { limit: limit + 1 });
        if (children.length === 0) {
          // Empty children → an empty list, not a skip (the macro rendered; there
          // are simply no children).
          return {
            kind: "blocks",
            blocks: [{ type: "list", ordered: false, items: [] }],
            notes: [renderedNote(m.name, 0)],
          };
        }

        // Deterministic sort by title (locale-aware, stable) regardless of the
        // port's own return order, so repeated exports are byte-identical.
        const sorted = [...children].sort((a, b) => a.title.localeCompare(b.title));
        const truncated = sorted.length > limit;
        const shown = truncated ? sorted.slice(0, limit) : sorted;
        if (truncated) {
          notes.push({
            level: "warning",
            code: "macro-degraded",
            message: `children macro: list truncated to ${limit} of ${sorted.length}+ pages.`,
            macroName: m.name,
          });
        }

        const items: ListItem[] = shown.map((c) => ({
          content: [{ type: "paragraph", content: [pageLink(c.title)] }],
        }));
        notes.push(renderedNote(m.name, shown.length));
        return { kind: "blocks", blocks: [{ type: "list", ordered: false, items }], notes };
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (isPortError(err)) {
          return {
            kind: "skip",
            notes: [
              {
                level: "warning",
                code: "macro-degraded",
                message: `children macro skipped: ${err.message}`,
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

function pageLink(title: string): InlineNode {
  return {
    type: "link",
    target: { kind: "page", contentTitle: title },
    content: [{ type: "text", text: title }],
  };
}

function renderedNote(macroName: string, count: number): ExportNote {
  return {
    level: "info",
    code: "macro-rendered-via",
    message: `children macro rendered ${count} child page link(s).`,
    macroName,
  };
}
