/**
 * Page Properties Report renderer (spec 004, E5): `detailssummary`.
 *
 * Runs the report's CQL, reads each matched page's `details` table via the
 * injected `parsePageProperties` reader, and aggregates into one table whose
 * columns are the union of property keys across matched pages.
 */
import type { ExportBlock, ExportNote, InlineNode, TableCell, TableRow } from "@atlcli/confluence";
import { macroParamText } from "./params.js";
import type {
  MacroExportContext,
  MacroInstance,
  MacroRenderer,
  MacroRenderResult,
} from "./types.js";
import { isAbortError, isPortError } from "./types.js";
import type { ParsePagePropertiesDep, StorageToBlocksDep } from "./deps.js";

const DEFAULT_CAP = 50;
const HARD_CAP = 200;

/** Build the CQL from the macro's label/cql parameters. */
export function cqlFromParams(m: MacroInstance): string | undefined {
  const cql = macroParamText(m.params, "cql");
  if (cql) return cql;
  const label = macroParamText(m.params, "label") ?? macroParamText(m.params, "labels");
  if (label) {
    const labels = label
      .split(/[,\s]+/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (labels.length > 0) return labels.map((l) => `label = "${l}"`).join(" and ");
  }
  const spaceKey = macroParamText(m.params, "spaces");
  if (spaceKey) return `space = "${spaceKey}"`;
  return undefined;
}

export function pagePropertiesReportRenderer(deps: {
  storageToBlocks: StorageToBlocksDep;
  parsePageProperties: ParsePagePropertiesDep;
}): MacroRenderer {
  return {
    id: "page-properties-report",
    macros: ["detailssummary"],
    requiresLivePort: true,
    async render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult> {
      if (!ctx.confluence) return { kind: "skip" };
      const cql = cqlFromParams(m);
      if (!cql) return { kind: "skip" };

      const firstColumn = macroParamText(m.params, "firstcolumn") ?? "Page";
      const notes: ExportNote[] = [];

      try {
        const matches = await ctx.confluence.searchCql(cql, { limit: HARD_CAP + 1 });
        if (matches.length === 0) return { kind: "skip" };

        // Deterministic sort by title so repeated exports are byte-identical.
        const sorted = [...matches].sort((a, b) => a.title.localeCompare(b.title));
        const truncated = sorted.length > DEFAULT_CAP;
        const shown = truncated ? sorted.slice(0, DEFAULT_CAP) : sorted;
        if (truncated) {
          notes.push({
            level: "warning",
            code: "macro-degraded",
            message: `Page Properties Report truncated to ${DEFAULT_CAP} of ${sorted.length}+ pages.`,
            macroName: m.name,
          });
        }

        // Fetch + parse each matched page's details table.
        const rows: { title: string; props: Map<string, string> }[] = [];
        const columnOrder: string[] = [];
        const seenColumns = new Set<string>();
        for (const page of shown) {
          const fetched = ctx.confluence.getPageStorageById
            ? await ctx.confluence.getPageStorageById(page.id)
            : undefined;
          const props = new Map<string, string>();
          if (fetched) {
            for (const macro of deps.parsePageProperties(fetched.storage)) {
              for (const [key, value] of macro.rows) {
                if (!props.has(key)) props.set(key, value);
                if (!seenColumns.has(key)) {
                  seenColumns.add(key);
                  columnOrder.push(key);
                }
              }
            }
          }
          rows.push({ title: page.title, props });
        }

        const table = buildTable(firstColumn, columnOrder, rows);
        notes.push({
          level: "info",
          code: "macro-rendered-via",
          message: `Page Properties Report rendered ${rows.length} page(s), ${columnOrder.length} column(s).`,
          macroName: m.name,
        });
        return { kind: "blocks", blocks: [table], notes };
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (isPortError(err)) {
          return {
            kind: "skip",
            notes: [
              {
                level: "warning",
                code: "macro-degraded",
                message: `Page Properties Report skipped: ${err.message}`,
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

function textCell(text: string, header = false): TableCell {
  return {
    header,
    colspan: 1,
    rowspan: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text, ...(header ? { marks: ["bold" as const] } : {}) }],
      },
    ],
  };
}

function linkCell(title: string): TableCell {
  const link: InlineNode = {
    type: "link",
    target: { kind: "page", contentTitle: title },
    content: [{ type: "text", text: title }],
  };
  return { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [link] }] };
}

function buildTable(
  firstColumn: string,
  columns: string[],
  rows: { title: string; props: Map<string, string> }[]
): ExportBlock {
  const headerRow: TableRow = {
    cells: [textCell(firstColumn, true), ...columns.map((c) => textCell(c, true))],
  };
  const bodyRows: TableRow[] = rows.map((r) => ({
    cells: [linkCell(r.title), ...columns.map((c) => textCell(r.props.get(c) ?? ""))],
  }));
  return { type: "table", rows: [headerRow, ...bodyRows] };
}
