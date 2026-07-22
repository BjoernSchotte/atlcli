/**
 * Confluence-list renderer (spec `SUPPORT-DATASOURCE-CONFLUENCE`).
 *
 * Renders the "Confluence search results" datasource provider — the modern
 * editor's page-list card — as a real `{ type: "table" }` block carrying the
 * author's own column selection, in the author's order.
 *
 * Three decisions here are evidence-driven and deliberately DIFFER from the
 * Jira datasource renderer next door:
 *
 * 1. **Truncation is the normal case, not a safety valve.** The live artifact
 *    matches 2 817 rows against a 100-row cap, so the note names BOTH counts
 *    (shown and matched) and says the table is a sample — "truncated" alone
 *    hides that the reader is seeing 3.5 % of the data.
 * 2. **A truncated table KEEPS the link to the live list** underneath it. Jira
 *    replaces the link with the table; here the route to the withheld 97 % is
 *    the point. An untruncated table drops the link, so its presence carries
 *    information.
 * 3. **No datasource-specific layout.** Eight columns need a horizontal
 *    scrollbar in the browser and a PDF page has none, so this emits a NORMAL
 *    table and lets the serializer's existing overflow vocabulary
 *    (`table-text-scaled`, `table-overflow-warned`) handle it — a wide
 *    datasource table degrades exactly like any other wide table.
 *
 * Cell content is always text. Three of the eight columns are visual in the UI
 * (`type` is a glyph, `space` is a chip, `ownedBy` is an avatar); the NAME
 * carries the information, and avatars would be an asset-budget item spent on
 * decoration.
 */
import type { ExportBlock, ExportNote, InlineNode, TableCell, TableRow } from "@atlcli/confluence";
import { datasourceSiteVerdict } from "./jira.js";
import { macroParamText } from "./params.js";
import type {
  ConfluenceSearchHit,
  MacroExportContext,
  MacroInstance,
  MacroRenderer,
  MacroRenderResult,
} from "./types.js";
import { isAbortError, isPortError } from "./types.js";

/** Columns the editor offers by default when the author picked none. */
const DEFAULT_COLUMNS = ["type", "title", "space", "updatedAt"];
const DEFAULT_MAX_RESULTS = 100;
const HARD_MAX_RESULTS = 250;

/**
 * Column key → header label. The keys are the PROVIDER's schema names, which
 * are camelCase and not always what the field is called anywhere else
 * (`updatedAt` is `history.lastUpdated.when`, `ownedBy` is `history.ownedBy`).
 */
const COLUMN_LABELS: Record<string, string> = {
  type: "Type",
  title: "Title",
  space: "Space",
  description: "Description",
  ownedby: "Owned by",
  updatedat: "Updated",
  labels: "Labels",
  status: "Status",
};

/**
 * CQL content type → the name the UI's glyph stands for. A type outside this
 * map renders its raw CQL name rather than an empty cell: a name we have not
 * prettified is still information.
 */
const TYPE_NAMES: Record<string, string> = {
  page: "Page",
  blogpost: "Blog post",
  attachment: "Attachment",
  comment: "Comment",
  whiteboard: "Whiteboard",
  database: "Database",
  embed: "Smart link",
  folder: "Folder",
};

const STATUS_NAMES: Record<string, string> = {
  current: "Current",
  draft: "Draft",
  archived: "Archived",
  trashed: "Trashed",
  historical: "Historical",
};

function prettyColumn(key: string): string {
  const label = COLUMN_LABELS[key.toLowerCase()];
  if (label) return label;
  // Unknown provider key: split camelCase so `someNewThing` reads as
  // "Some new thing" rather than as a raw identifier.
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** `2026-07-21` — locale-independent so two runs of one export are identical. */
function isoDate(raw: string | undefined): string {
  if (!raw) return "";
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : raw;
}

/**
 * The plain-text value of one column for one row, or `undefined` when the key
 * has NO mapping at all. The distinction matters: `undefined` is a mapping we
 * are missing (a warning naming the column), `""` is a value the row does not
 * have (ordinary empty data).
 */
export function confluenceListCellText(hit: ConfluenceSearchHit, column: string): string | undefined {
  switch (column.toLowerCase()) {
    case "type":
      return hit.type ? (TYPE_NAMES[hit.type.toLowerCase()] ?? hit.type) : "";
    case "title":
      return hit.title;
    case "space":
      // The UI renders a chip with an icon; the space NAME is what the chip says.
      return hit.spaceName ?? hit.spaceKey ?? "";
    case "description":
      return hit.excerpt ?? "";
    case "ownedby":
      // The UI renders avatar + name. The name carries the information.
      return hit.ownedBy ?? "";
    case "updatedat":
      return isoDate(hit.lastModified);
    case "labels":
      return (hit.labels ?? []).join(", ");
    case "status":
      return hit.status ? (STATUS_NAMES[hit.status.toLowerCase()] ?? hit.status) : "";
    default:
      return undefined;
  }
}

function headerCell(text: string): TableCell {
  return {
    header: true,
    colspan: 1,
    rowspan: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text, marks: ["bold"] }] }],
  };
}

function textCell(text: string): TableCell {
  return {
    header: false,
    colspan: 1,
    rowspan: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/**
 * The `title` cell: a link to the result page, resolved through composition's
 * OWN scope answer.
 *
 * In a tree or space export some result pages are chapters of THIS document, so
 * an absolute `https://…` would send the reader to the web to reach a page two
 * chapters away. `ctx.pageScope` is the map `composeChapters` built; a hit it
 * knows links to the in-document anchor, everything else links absolutely.
 */
function titleCell(hit: ConfluenceSearchHit, anchor: string | undefined): TableCell {
  const label: InlineNode[] = [{ type: "text", text: hit.title }];
  let content: ExportBlock[];
  if (anchor !== undefined) {
    content = [{ type: "paragraph", content: [{ type: "link", target: { kind: "anchor", anchor }, content: label }] }];
  } else if (hit.url) {
    content = [
      { type: "paragraph", content: [{ type: "link", target: { kind: "external", href: hit.url }, content: label }] },
    ];
  } else {
    content = [{ type: "paragraph", content: label }];
  }
  return { header: false, colspan: 1, rowspan: 1, content };
}

function parseColumns(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_COLUMNS];
  const cols = raw
    .split(/[,;]/)
    .map((c) => c.trim())
    .filter(Boolean);
  return cols.length > 0 ? cols : [...DEFAULT_COLUMNS];
}

function parseMaxResults(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_RESULTS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RESULTS;
  return Math.min(n, HARD_MAX_RESULTS);
}

function parseStatuses(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** Human-readable origin for a cross-site note (never the full URL). */
function describeOrigin(url: string | undefined): string {
  if (!url) return "an unknown site";
  try {
    return new URL(url).origin;
  } catch {
    return "an unknown site";
  }
}

/**
 * The blocks a degraded list falls back to: the walker-provided body (the
 * original link, verbatim) or a reconstructed link. Never empty output for a
 * non-empty input.
 */
function linkBlocks(m: MacroInstance, url: string | undefined): ExportBlock[] {
  if (m.body && m.body.length > 0) return m.body;
  if (!url) return [];
  return [liveListLink(url, url)];
}

function liveListLink(url: string, text: string): ExportBlock {
  return {
    type: "paragraph",
    content: [{ type: "link", target: { kind: "external", href: url }, content: [{ type: "text", text }] }],
  };
}

export function confluenceListTable(columns: string[], hits: ConfluenceSearchHit[], anchorFor?: (id: string) => string | undefined): ExportBlock {
  const headerRow: TableRow = { cells: columns.map((c) => headerCell(prettyColumn(c))) };
  const bodyRows: TableRow[] = hits.map((hit) => ({
    cells: columns.map((column) =>
      column.toLowerCase() === "title"
        ? titleCell(hit, anchorFor?.(hit.id))
        : textCell(confluenceListCellText(hit, column) ?? "")
    ),
  }));
  return { type: "table", rows: [headerRow, ...bodyRows] };
}

/**
 * Per-column resolution notes.
 *
 * Two distinct failures, both of which a naive renderer shows as a blank
 * column:
 * - **unmapped** (warning): the provider named a column key we have no source
 *   for. New provider columns land here, named, instead of vanishing.
 * - **empty on every row** (info): the mapping exists but produced nothing for
 *   any of N rows. This is the shape of the `issuetype`/`type` drift the Jira
 *   round hit — a wrong guess that looks exactly like empty data.
 */
export function columnNotes(
  columns: string[],
  hits: ConfluenceSearchHit[],
  macroName: string
): ExportNote[] {
  const notes: ExportNote[] = [];
  for (const column of columns) {
    // Whether a key is mapped is a property of the KEY, not of any row, so it
    // is answered against an empty probe row — a table with zero results must
    // still name a column it could never have filled.
    if (confluenceListCellText({ id: "", title: "" }, column) === undefined) {
      notes.push({
        level: "warning",
        code: "datasource-column-unresolved",
        message: `Confluence list column "${column}" is not a field this exporter can read; it was rendered empty.`,
        macroName,
      });
      continue;
    }
    if (hits.length > 0 && hits.every((hit) => (confluenceListCellText(hit, column) ?? "") === "")) {
      notes.push({
        level: "info",
        code: "datasource-column-unresolved",
        message: `Confluence list column "${column}" was empty for all ${hits.length} row(s); the source field carried no value.`,
        macroName,
      });
    }
  }
  return notes;
}

export function confluenceListRenderer(): MacroRenderer {
  return {
    id: "confluence-list",
    macros: ["confluence-list"],
    requiresLivePort: true,
    async render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult> {
      const datasourceUrl = macroParamText(m.params, "datasourceUrl");
      // Same cross-site guard the Jira datasource uses, for the same reason: a
      // Confluence list can point at ANOTHER Confluence site, and answering it
      // with rows from ours produces a table that is wrong in a way nothing
      // about the output reveals.
      const verdict = datasourceSiteVerdict({
        ...(datasourceUrl !== undefined ? { datasourceUrl } : {}),
        ...(ctx.siteId !== undefined ? { siteBaseUrl: ctx.siteId } : {}),
      });
      if (verdict !== "same-site") {
        return {
          kind: "blocks",
          blocks: linkBlocks(m, datasourceUrl),
          bodyConsumed: true,
          notes: [
            {
              level: "warning",
              code: "datasource-cross-site",
              message:
                verdict === "cross-site"
                  ? `A Confluence list targets a different Confluence site (${describeOrigin(datasourceUrl)}) than this export is authenticated against (${describeOrigin(ctx.siteId)}); it was kept as a link instead of being answered with rows from the wrong site.`
                  : "A Confluence list could not be proven to target this export's Confluence site; it was kept as a link instead of being answered with rows that may come from a different site.",
              macroName: m.name,
            },
          ],
        };
      }

      // No live port at all → fall through to the placeholder floor, which
      // renders the link body. Same contract as the Jira renderer.
      if (!ctx.confluence) return { kind: "skip" };
      if (!ctx.confluence.searchContent) {
        return {
          kind: "skip",
          notes: [
            {
              level: "warning",
              code: "macro-degraded",
              message:
                "A Confluence list was kept as a link: this host's Confluence port does not implement content search.",
              macroName: m.name,
            },
          ],
        };
      }

      const cql = macroParamText(m.params, "cql");
      if (!cql) return { kind: "skip" };

      const columns = parseColumns(macroParamText(m.params, "columns"));
      const maximumResults = parseMaxResults(macroParamText(m.params, "maximumResults"));
      const contentStatuses = parseStatuses(macroParamText(m.params, "contentStatuses"));

      try {
        // cap+1: truncation must be a FACT. `totalSize` alone would not do — a
        // server that omits it must still not silently cut the table.
        const page = await ctx.confluence.searchContent(cql, {
          maximumResults: maximumResults + 1,
          ...(contentStatuses ? { contentStatuses } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const truncated = page.hits.length > maximumResults;
        const hits = truncated ? page.hits.slice(0, maximumResults) : page.hits;

        const anchorFor = ctx.pageScope
          ? (id: string): string | undefined => ctx.pageScope!.chapterAnchorFor(id)
          : undefined;
        const table = confluenceListTable(columns, hits, anchorFor);

        const notes: ExportNote[] = [
          {
            level: "info",
            code: "macro-rendered-via",
            message:
              hits.length > 0
                ? `Confluence list rendered as a ${hits.length}-row table.`
                : // Zero rows is ambiguous — a filter that legitimately matches
                  // nothing looks exactly like a wrong CQL translation. Carrying
                  // the composed query lets a reader tell them apart from the
                  // report alone.
                  `Confluence list matched no content; the query was: ${cql}`,
            macroName: m.name,
          },
        ];

        if (truncated) {
          const matched =
            page.totalSize !== undefined ? `${page.totalSize}` : `${maximumResults}+`;
          notes.push({
            level: "warning",
            code: "macro-degraded",
            message: `Confluence list is a sample: ${hits.length} of ${matched} matching results are shown. Add space, label or type filters to the list in Confluence to narrow what the export can show; the link under the table opens the full list.`,
            macroName: m.name,
          });
        }

        notes.push(...columnNotes(columns, hits, m.name));

        // Out-of-scope links, aggregated. Compose emits one `link-outside-scope`
        // per link; one per ROW of a 100-row table would drown the report, so
        // this states the same fact once, in the same vocabulary.
        if (ctx.pageScope && hits.length > 0) {
          const outside = hits.filter((h) => ctx.pageScope!.chapterAnchorFor(h.id) === undefined).length;
          if (outside > 0) {
            notes.push({
              level: "info",
              code: "link-outside-scope",
              message: `${outside} of ${hits.length} Confluence list row(s) point outside the export scope; they link to their absolute URLs.`,
              macroName: m.name,
            });
          }
        }

        const blocks: ExportBlock[] = [table];
        // The link stays ONLY when something was withheld, so its presence is
        // itself information (spec open question 2).
        if (truncated && datasourceUrl) {
          blocks.push(liveListLink(datasourceUrl, "Open the full list in Confluence"));
        }
        return { kind: "blocks", blocks, notes };
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (isPortError(err)) {
          return { kind: "skip", notes: [portErrorNote(m.name, err)] };
        }
        return {
          kind: "skip",
          notes: [
            {
              level: "warning",
              code: "macro-degraded",
              message: `Confluence list skipped: ${err instanceof Error ? err.message : String(err)}`,
              macroName: m.name,
            },
          ],
        };
      }
    },
  };
}

function portErrorNote(macroName: string, err: { kind: string; message: string }): ExportNote {
  let message: string;
  switch (err.kind) {
    case "permission":
      message = "Confluence list skipped: no permission to run the search.";
      break;
    case "not-found":
      message = "Confluence list skipped: the search returned not-found (invalid CQL or removed content).";
      break;
    case "rate-limited":
      message = "Confluence list skipped: rate-limited.";
      break;
    default:
      message = `Confluence list skipped: ${err.message}`;
  }
  return { level: "warning", code: "macro-degraded", message, macroName };
}
