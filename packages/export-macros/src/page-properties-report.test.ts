import { describe, expect, test } from "bun:test";
import { storageToBlocks, parsePageProperties } from "@atlcli/confluence";
import type { ExportBlock, MacroParameter } from "@atlcli/confluence";
import { pagePropertiesReportRenderer, cqlFromParams } from "./page-properties-report.js";
import type { ConfluenceContentPort, MacroExportContext } from "./types.js";

function param(name: string, text: string): MacroParameter {
  return { name, text };
}

function ctx(confluence: ConfluenceContentPort): MacroExportContext {
  return { page: { id: "root" }, depth: 0, visited: new Set(), confluence };
}

/** A page whose `details` macro carries the given label→value rows. */
function detailsStorage(rows: Record<string, string>): string {
  const trs = Object.entries(rows)
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join("");
  return `<ac:structured-macro ac:name="details"><ac:rich-text-body><table><tbody>${trs}</tbody></table></ac:rich-text-body></ac:structured-macro>`;
}

function port(pages: { id: string; title: string; rows: Record<string, string> }[]): ConfluenceContentPort {
  const byId = new Map(pages.map((p) => [p.id, p]));
  return {
    async getPageStorage() {
      return undefined;
    },
    async getPageStorageById(id) {
      const p = byId.get(id);
      return p ? { id: p.id, version: 1, storage: detailsStorage(p.rows) } : undefined;
    },
    async getChildren() {
      return [];
    },
    async searchCql() {
      return pages.map((p) => ({ id: p.id, title: p.title }));
    },
  };
}

const deps = { storageToBlocks, parsePageProperties };

describe("cqlFromParams", () => {
  test("builds label-based CQL", () => {
    expect(cqlFromParams({ name: "detailssummary", params: [param("label", "meta")] })).toBe('label = "meta"');
  });
  test("passes cql through", () => {
    expect(cqlFromParams({ name: "detailssummary", params: [param("cql", "space = X")] })).toBe("space = X");
  });
});

describe("pagePropertiesReportRenderer", () => {
  test("no cql → skip", async () => {
    const res = await pagePropertiesReportRenderer(deps).render(
      { name: "detailssummary", params: [] },
      ctx(port([]))
    );
    expect(res.kind).toBe("skip");
  });

  test("column union across heterogeneous property sets, missing keys empty", async () => {
    const res = await pagePropertiesReportRenderer(deps).render(
      { name: "detailssummary", params: [param("label", "meta")] },
      ctx(
        port([
          { id: "b", title: "Bravo", rows: { Owner: "Bob", Status: "Done" } },
          { id: "a", title: "Alpha", rows: { Owner: "Ann", Team: "X" } },
        ])
      )
    );
    expect(res.kind).toBe("blocks");
    if (res.kind === "blocks") {
      const table = res.blocks[0] as Extract<ExportBlock, { type: "table" }>;
      // Rows sorted by title: header, Alpha, Bravo
      const firstCol = table.rows.map((r) => {
        const cell = r.cells[0];
        const para = cell.content[0] as Extract<ExportBlock, { type: "paragraph" }>;
        const node = para.content[0] as { type: string; content?: { text: string }[]; text?: string };
        return node.type === "link" ? node.content![0].text : node.text;
      });
      expect(firstCol).toEqual(["Page", "Alpha", "Bravo"]);
      // Column count = firstColumn + union(Owner, Status, Team) = 4
      expect(table.rows[0].cells.length).toBe(4);
    }
  });
});
