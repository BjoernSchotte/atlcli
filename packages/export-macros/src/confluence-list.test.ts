import { describe, expect, test } from "bun:test";
import type { ExportBlock, MacroParameter } from "@atlcli/confluence";
import { columnNotes, confluenceListRenderer, confluenceListTable } from "./confluence-list.js";
import { portError } from "./types.js";
import type {
  ConfluenceContentPort,
  ConfluenceSearchHit,
  MacroExportContext,
  MacroPageScope,
} from "./types.js";

const SITE = "https://example.atlassian.net";
const LIST_URL = `${SITE}/wiki/search?text=&contributors=70121%3Aabc`;

/** The author's column selection on DOCSY page 1126236229, verbatim. */
const REAL_COLUMNS = "type,title,space,description,ownedBy,updatedAt,labels,status";

function param(name: string, text: string): MacroParameter {
  return { name, text };
}

function params(overrides: Record<string, string> = {}): MacroParameter[] {
  const merged: Record<string, string> = {
    cql: 'contributor in ("70121:abc")',
    columns: REAL_COLUMNS,
    maximumresults: "100",
    datasourceid: "768fc736-3af4-4a8f-b27e-203602bff8ca",
    datasourceurl: LIST_URL,
    ...overrides,
  };
  return Object.entries(merged)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => param(k, v));
}

/**
 * A hit carrying every field the eight columns read — the shape MEASURED off a
 * real `GET /rest/api/search` response (2026-07-21), not an idealization.
 */
function hit(i: number, overrides: Partial<ConfluenceSearchHit> = {}): ConfluenceSearchHit {
  return {
    id: `${1000 + i}`,
    title: `Page ${i}`,
    type: "page",
    url: `${SITE}/wiki/spaces/DOCSY/pages/${1000 + i}/Page+${i}`,
    spaceKey: "DOCSY",
    spaceName: "Docs & Systems",
    excerpt: `Excerpt ${i}`,
    ownedBy: "Robert Lippert",
    lastModified: "2026-05-26T06:25:48.628Z",
    labels: ["jourfixe"],
    status: "current",
    ...overrides,
  };
}

interface FakeCalls {
  cql: string;
  maximumResults: number;
  contentStatuses?: string[];
}

function port(
  hits: ConfluenceSearchHit[],
  opts: { totalSize?: number; calls?: FakeCalls[]; throws?: unknown } = {}
): ConfluenceContentPort {
  return {
    async getPageStorage() {
      return undefined;
    },
    async getChildren() {
      return [];
    },
    async searchCql() {
      return [];
    },
    async searchContent(cql, o) {
      opts.calls?.push({
        cql,
        maximumResults: o.maximumResults,
        ...(o.contentStatuses ? { contentStatuses: o.contentStatuses } : {}),
      });
      if (opts.throws) throw opts.throws;
      return {
        hits: hits.slice(0, o.maximumResults),
        ...(opts.totalSize !== undefined ? { totalSize: opts.totalSize } : {}),
      };
    },
  };
}

function ctx(
  confluence?: ConfluenceContentPort,
  extra: Partial<MacroExportContext> = {}
): MacroExportContext {
  return {
    page: { id: "1126236229", spaceKey: "DOCSY" },
    depth: 0,
    visited: new Set(),
    siteId: SITE,
    ...(confluence ? { confluence } : {}),
    ...extra,
  };
}

async function render(
  confluence: ConfluenceContentPort | undefined,
  overrides: Record<string, string> = {},
  extra: Partial<MacroExportContext> = {}
) {
  return confluenceListRenderer().render(
    { name: "confluence-list", params: params(overrides) },
    ctx(confluence, extra)
  );
}

function tableOf(blocks: ExportBlock[]): Extract<ExportBlock, { type: "table" }> {
  const table = blocks.find((b) => b.type === "table");
  if (!table || table.type !== "table") throw new Error("expected a table block");
  return table;
}

/** Flatten a cell to its plain text. */
function cellText(cell: { content: ExportBlock[] }): string {
  let out = "";
  const walkInline = (nodes: readonly { type: string; [k: string]: unknown }[]): void => {
    for (const n of nodes) {
      if (n.type === "text") out += String(n.text);
      else if (n.type === "link") walkInline(n.content as never);
    }
  };
  for (const block of cell.content) {
    if (block.type === "paragraph") walkInline(block.content as never);
  }
  return out;
}

describe("confluenceListTable — the author's columns, as TEXT", () => {
  test("renders the eight real columns in the author's order, with readable headers", () => {
    const table = confluenceListTable(REAL_COLUMNS.split(","), [hit(1)]) as Extract<
      ExportBlock,
      { type: "table" }
    >;
    expect(table.rows[0]!.cells.map(cellText)).toEqual([
      "Type",
      "Title",
      "Space",
      "Description",
      "Owned by",
      "Updated",
      "Labels",
      "Status",
    ]);
    expect(table.rows[0]!.cells.every((c) => c.header)).toBe(true);
  });

  test("glyph/chip/avatar columns render as text, never as empty cells", () => {
    // `type` is a glyph in the UI, `space` is a chip with an icon, `ownedBy` is
    // an avatar + name. The NAME is what carries the information here; a
    // renderer that only knew how to draw them would leave three blank columns.
    const table = confluenceListTable(REAL_COLUMNS.split(","), [hit(1)]) as Extract<
      ExportBlock,
      { type: "table" }
    >;
    const row = table.rows[1]!.cells.map(cellText);
    expect(row[0]).toBe("Page");
    expect(row[2]).toBe("Docs & Systems");
    expect(row[4]).toBe("Robert Lippert");
    // ...and the rest of the measured mapping.
    expect(row[1]).toBe("Page 1");
    expect(row[3]).toBe("Excerpt 1");
    expect(row[5]).toBe("2026-05-26");
    expect(row[6]).toBe("jourfixe");
    expect(row[7]).toBe("Current");
  });

  test("the space column falls back to the key when the name is absent", () => {
    const table = confluenceListTable(["space"], [hit(1, { spaceName: undefined })]) as Extract<
      ExportBlock,
      { type: "table" }
    >;
    expect(cellText(table.rows[1]!.cells[0]!)).toBe("DOCSY");
  });

  test("a content type we have no label for still shows its raw name", () => {
    const table = confluenceListTable(["type"], [hit(1, { type: "hologram" })]) as Extract<
      ExportBlock,
      { type: "table" }
    >;
    expect(cellText(table.rows[1]!.cells[0]!)).toBe("hologram");
  });
});

describe("column resolution notes", () => {
  test("an unmapped column key is empty AND named in a warning", () => {
    const notes = columnNotes(["title", "reactions"], [hit(1)], "confluence-list");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.code).toBe("datasource-column-unresolved");
    expect(notes[0]!.level).toBe("warning");
    expect(notes[0]!.message).toContain("reactions");
  });

  test("an unmapped column is named even when the table has zero rows", () => {
    const notes = columnNotes(["reactions"], [], "confluence-list");
    expect(notes.map((n) => n.code)).toEqual(["datasource-column-unresolved"]);
  });

  test("a MAPPED column that is empty on every row is named too (the issuetype/type drift)", () => {
    const notes = columnNotes(["ownedBy"], [hit(1, { ownedBy: undefined }), hit(2, { ownedBy: undefined })], "confluence-list");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.level).toBe("info");
    expect(notes[0]!.message).toContain("ownedBy");
    expect(notes[0]!.message).toContain("2 row");
  });

  test("a column with at least one value is not flagged", () => {
    expect(columnNotes(["ownedBy"], [hit(1), hit(2, { ownedBy: undefined })], "confluence-list")).toEqual([]);
  });

  test("an unmapped column renders an EMPTY cell — never a missing one", () => {
    const table = confluenceListTable(["title", "reactions"], [hit(1)]) as Extract<
      ExportBlock,
      { type: "table" }
    >;
    expect(table.rows[1]!.cells).toHaveLength(2);
    expect(cellText(table.rows[1]!.cells[1]!)).toBe("");
  });
});

describe("confluenceListRenderer — volume and truncation", () => {
  test("truncation is MEASURED: the port is asked for cap+1 rows", async () => {
    const calls: FakeCalls[] = [];
    await render(port([hit(1)], { calls }), { maximumresults: "10" });
    expect(calls[0]!.maximumResults).toBe(11);
  });

  test("a result set past the cap renders exactly cap rows and names BOTH counts", async () => {
    const many = Array.from({ length: 40 }, (_v, i) => hit(i));
    const res = await render(port(many, { totalSize: 2817 }), { maximumresults: "10" });
    if (res.kind !== "blocks") throw new Error("expected blocks");
    expect(tableOf(res.blocks).rows).toHaveLength(11); // header + 10
    const note = res.notes!.find((n) => n.code === "macro-degraded")!;
    expect(note.message).toContain("10 of 2817");
    // "truncated" alone would hide that the reader is seeing 0.4 % of the data.
    expect(note.message).toContain("sample");
    // ...and it must be actionable: how to make the export show more.
    expect(note.message).toMatch(/space|label|filter/i);
  });

  test("a truncated table KEEPS the link to the live list underneath it", async () => {
    const many = Array.from({ length: 40 }, (_v, i) => hit(i));
    const res = await render(port(many, { totalSize: 2817 }), { maximumresults: "10" });
    if (res.kind !== "blocks") throw new Error("expected blocks");
    const last = res.blocks[res.blocks.length - 1]!;
    expect(last.type).toBe("paragraph");
    if (last.type !== "paragraph") return;
    expect(last.content[0]).toMatchObject({ type: "link", target: { kind: "external", href: LIST_URL } });
  });

  test("an UNTRUNCATED table emits no truncation note and NO link — its absence is information", async () => {
    const res = await render(port([hit(1), hit(2)], { totalSize: 2 }), { maximumresults: "10" });
    if (res.kind !== "blocks") throw new Error("expected blocks");
    expect(res.blocks).toHaveLength(1);
    expect(res.blocks[0]!.type).toBe("table");
    expect(res.notes!.some((n) => n.code === "macro-degraded")).toBe(false);
  });

  test("without a server total the note still states truncation honestly", async () => {
    const many = Array.from({ length: 40 }, (_v, i) => hit(i));
    const res = await render(port(many), { maximumresults: "10" });
    if (res.kind !== "blocks") throw new Error("expected blocks");
    expect(res.notes!.find((n) => n.code === "macro-degraded")!.message).toContain("10 of 10+");
  });
});

describe("confluenceListRenderer — links into the SAME document", () => {
  const scope = (ids: string[]): MacroPageScope => ({
    chapterAnchorFor: (id) => (ids.includes(id) ? `page-${id}` : undefined),
  });

  test("a result page that is a chapter of THIS export links internally", async () => {
    const res = await render(port([hit(1)]), { columns: "title" }, { pageScope: scope(["1001"]) });
    if (res.kind !== "blocks") throw new Error("expected blocks");
    const cell = tableOf(res.blocks).rows[1]!.cells[0]!;
    const para = cell.content[0] as Extract<ExportBlock, { type: "paragraph" }>;
    expect(para.content[0]).toMatchObject({ type: "link", target: { kind: "anchor", anchor: "page-1001" } });
  });

  test("a result page outside the export links absolutely and is reported once, not per row", async () => {
    const hits = [hit(1), hit(2), hit(3)];
    const res = await render(port(hits), { columns: "title" }, { pageScope: scope(["1001"]) });
    if (res.kind !== "blocks") throw new Error("expected blocks");
    const outside = tableOf(res.blocks).rows[2]!.cells[0]!.content[0] as Extract<
      ExportBlock,
      { type: "paragraph" }
    >;
    expect(outside.content[0]).toMatchObject({
      type: "link",
      target: { kind: "external", href: hits[1]!.url },
    });
    const notes = res.notes!.filter((n) => n.code === "link-outside-scope");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain("2 of 3");
  });

  test("with no scope at all (single-page export) every row links absolutely, with no note", async () => {
    const res = await render(port([hit(1)]), { columns: "title" });
    if (res.kind !== "blocks") throw new Error("expected blocks");
    const para = tableOf(res.blocks).rows[1]!.cells[0]!.content[0] as Extract<
      ExportBlock,
      { type: "paragraph" }
    >;
    expect(para.content[0]).toMatchObject({ type: "link", target: { kind: "external" } });
    expect(res.notes!.some((n) => n.code === "link-outside-scope")).toBe(false);
  });
});

describe("confluenceListRenderer — degradations", () => {
  test("a list targeting ANOTHER Confluence site keeps its link and says so", async () => {
    const res = await render(port([hit(1)]), {
      datasourceurl: "https://other.atlassian.net/wiki/search?text=x",
    });
    if (res.kind !== "blocks") throw new Error("expected blocks");
    expect(res.notes!.map((n) => n.code)).toEqual(["datasource-cross-site"]);
    expect(res.notes![0]!.message).toContain("other.atlassian.net");
  });

  test("a host whose Confluence port has no content search degrades with a note", async () => {
    const withoutSearch: ConfluenceContentPort = {
      async getPageStorage() {
        return undefined;
      },
      async getChildren() {
        return [];
      },
      async searchCql() {
        return [];
      },
    };
    const res = await render(withoutSearch);
    expect(res.kind).toBe("skip");
    expect(res.notes!.map((n) => n.code)).toEqual(["macro-degraded"]);
  });

  test("zero results carry the composed CQL, so 'no matches' is distinguishable from 'wrong query'", async () => {
    const res = await render(port([]));
    if (res.kind !== "blocks") throw new Error("expected blocks");
    const rendered = res.notes!.find((n) => n.code === "macro-rendered-via")!;
    expect(rendered.message).toContain('contributor in ("70121:abc")');
  });

  test("port errors map onto the resolver's taxonomy without losing the macro", async () => {
    const res = await render(port([], { throws: portError("permission", "403", { service: "confluence" }) }));
    expect(res.kind).toBe("skip");
    expect(res.notes![0]!.code).toBe("macro-degraded");
    expect(res.notes![0]!.message).toContain("permission");
  });

  test("an abort propagates instead of degrading (it must stop the whole export)", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    await expect(render(port([], { throws: abort }))).rejects.toThrow("aborted");
  });

  test("contentStatuses reaches the port as a request option, not inside the CQL", async () => {
    const calls: FakeCalls[] = [];
    await render(port([hit(1)], { calls }), { contentstatuses: "current,archived" });
    expect(calls[0]!.contentStatuses).toEqual(["current", "archived"]);
    expect(calls[0]!.cql).not.toContain("status");
  });
});

describe("confluenceListRenderer — layout stays generic", () => {
  test("an eight-column list emits ONE plain table block, with no datasource-specific wrapper", async () => {
    // The serializer owns wide-table degradation (`table-text-scaled`,
    // `table-overflow-warned`); a bespoke layout path here would bypass the
    // vocabulary users already know.
    const res = await render(port([hit(1), hit(2)], { totalSize: 2 }));
    if (res.kind !== "blocks") throw new Error("expected blocks");
    expect(res.blocks.map((b) => b.type)).toEqual(["table"]);
    const table = tableOf(res.blocks);
    expect(table.rows.every((r) => r.cells.length === 8)).toBe(true);
    // No column widths, no orientation block, no page-break: nothing bespoke.
    expect(JSON.stringify(table)).not.toContain("columnWidths");
  });
});
