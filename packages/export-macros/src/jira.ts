/**
 * Jira macro renderer (spec 004, T1.8/E2).
 *
 * Renders a single Jira issue as a bold external link + status inline node, and
 * a JQL query as a real styled `{ type: "table" }` block that flows through the
 * DOCX/PDF theme pipeline unchanged — the differentiator over a plain
 * placeholder or a flat text dump.
 */
import type { ExportBlock, ExportNote, InlineNode, TableCell, TableRow } from "@atlcli/confluence";
import { macroParamText } from "./params.js";
import type {
  JiraIssueRef,
  MacroExportContext,
  MacroInstance,
  MacroRenderer,
  MacroRenderResult,
} from "./types.js";
import { isAbortError, isPortError } from "./types.js";

const DEFAULT_COLUMNS = ["key", "summary", "status"];
const DEFAULT_MAX_ISSUES = 20;
const HARD_MAX_ISSUES = 100;

/**
 * Does a datasource table target the SAME Jira site this export is
 * authenticated against?
 *
 * This is not pedantry. Atlassian's datasource config modal has a site selector
 * (`/gateway/api/v2/accessible-products`), so a Confluence page can legitimately
 * embed a table from a *different* Jira site. Running that JQL against OUR site
 * returns plausible-looking but wrong rows — the worst available failure mode,
 * because nothing about the output says it is wrong.
 *
 * The proof we use is the datasource element's own `href`: Atlassian generates
 * it as the "view in Jira" URL for the selected site, so its origin IS the
 * target site. Comparing it with `ctx.siteId` (the base URL the Jira port is
 * bound to) answers exactly the question that matters — "would the rows come
 * from the site the user's table points at?" — with no extra API call.
 *
 * Deliberately fail-safe: anything we cannot compare is `"unprovable"`, which
 * the renderer degrades on. Guessing here is what this function exists to
 * prevent.
 */
export type DatasourceSiteVerdict = "same-site" | "cross-site" | "unprovable";

export function datasourceSiteVerdict(args: {
  /** The datasource element's `href`. */
  datasourceUrl?: string;
  /** The site our ports are authenticated against (`MacroExportContext.siteId`). */
  siteBaseUrl?: string;
}): DatasourceSiteVerdict {
  const target = originOf(args.datasourceUrl);
  const ours = originOf(args.siteBaseUrl);
  if (target === undefined || ours === undefined) return "unprovable";
  return target === ours ? "same-site" : "cross-site";
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Map a Jira `statusCategory.colorName` to a Confluence status color name the
 * engines already render. Jira uses `blue-gray`, `yellow`, `green`, etc.;
 * Confluence status colors are `grey`/`blue`/`yellow`/`green`/`red`/`purple`.
 */
export function jiraStatusColor(categoryColor: string | undefined): string {
  switch ((categoryColor ?? "").toLowerCase()) {
    case "green":
    case "success":
      return "green";
    case "yellow":
    case "inprogress":
    case "in-progress":
      return "yellow";
    case "blue-gray":
    case "blue-grey":
    case "new":
    case "todo":
      return "blue";
    case "brown":
    case "red":
      return "red";
    case "purple":
      return "purple";
    default:
      return "grey";
  }
}

function issueLink(issue: JiraIssueRef): InlineNode {
  return {
    type: "link",
    target: { kind: "external", href: issue.url },
    content: [{ type: "text", text: issue.key, marks: ["bold"] }],
  };
}

function headerCell(text: string): TableCell {
  return {
    header: true,
    colspan: 1,
    rowspan: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text, marks: ["bold"] }] }],
  };
}

function cellFor(issue: JiraIssueRef, column: string): TableCell {
  const col = column.toLowerCase();
  let content: ExportBlock[];
  if (col === "key") {
    content = [{ type: "paragraph", content: [issueLink(issue)] }];
  } else if (col === "summary") {
    content = [{ type: "paragraph", content: [{ type: "text", text: issue.summary }] }];
  } else if (col === "status") {
    content = [
      {
        type: "paragraph",
        content: [{ type: "status", text: issue.status, color: issue.statusColor }],
      },
    ];
  } else {
    const value = issue.fields?.[col] ?? "";
    content = [{ type: "paragraph", content: [{ type: "text", text: value }] }];
  }
  return { header: false, colspan: 1, rowspan: 1, content };
}

export function issueTable(columns: string[], issues: JiraIssueRef[]): ExportBlock {
  const headerRow: TableRow = { cells: columns.map((c) => headerCell(prettyColumn(c))) };
  const bodyRows: TableRow[] = issues.map((issue) => ({
    cells: columns.map((c) => cellFor(issue, c)),
  }));
  return { type: "table", rows: [headerRow, ...bodyRows] };
}

function prettyColumn(c: string): string {
  const map: Record<string, string> = {
    key: "Key",
    summary: "Summary",
    status: "Status",
    // Datasource column vocabulary (`views[].properties.columns[].key`) is the
    // provider's schema keys, which do not always match the legacy macro's
    // `columns` names — the 2026 Jira provider says `issuetype` where the macro
    // path says `type`. Label them the same either way.
    issuetype: "Type",
    duedate: "Due date",
  };
  const lc = c.toLowerCase();
  return map[lc] ?? c.charAt(0).toUpperCase() + c.slice(1);
}

function parseColumns(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_COLUMNS];
  const cols = raw
    .split(/[,;]/)
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  return cols.length > 0 ? cols : [...DEFAULT_COLUMNS];
}

function parseMaxIssues(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_ISSUES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_ISSUES;
  return Math.min(n, HARD_MAX_ISSUES);
}

/** Human-readable origin for a cross-site note (never the full URL with its JQL). */
function describeOrigin(url: string | undefined): string {
  return originOf(url) ?? "an unknown site";
}

/**
 * The blocks a degraded datasource falls back to: the walker-provided body
 * (the original link, verbatim), or a reconstructed link when a caller built
 * the instance without one. Never empty output for a non-empty input.
 */
function datasourceLinkBlocks(m: MacroInstance, datasourceUrl: string | undefined): ExportBlock[] {
  if (m.body && m.body.length > 0) return m.body;
  if (!datasourceUrl) return [];
  return [
    {
      type: "paragraph",
      content: [
        {
          type: "link",
          target: { kind: "external", href: datasourceUrl },
          content: [{ type: "text", text: datasourceUrl }],
        },
      ],
    },
  ];
}

function portErrorNote(macroName: string, err: { kind: string; message: string }): ExportNote {
  let message: string;
  switch (err.kind) {
    case "permission":
      message = "Jira issue(s) skipped: no permission to view.";
      break;
    case "not-found":
      message = "Jira issue(s) skipped: not found (deleted/renamed issue or invalid JQL).";
      break;
    case "rate-limited":
      message = "Jira issue(s) skipped: rate-limited.";
      break;
    default:
      message = `Jira issue(s) skipped: ${err.message}`;
  }
  return { level: "warning", code: "macro-degraded", message, macroName };
}

export function jiraMacroRenderer(): MacroRenderer {
  return {
    id: "jira",
    macros: ["jira", "jiraissues"],
    requiresLivePort: true,
    webRenderModel: { kind: "jira-data", dependencies: ["jira"] },
    async render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult> {
      // Cross-site guard runs BEFORE the port check: a datasource pointing at
      // another Jira site must degrade to its link with a stated reason, not
      // fall through to a placeholder that says nothing about why.
      const datasourceUrl = macroParamText(m.params, "datasourceUrl");
      if (macroParamText(m.params, "datasourceId") !== undefined) {
        const verdict = datasourceSiteVerdict({
          ...(datasourceUrl !== undefined ? { datasourceUrl } : {}),
          ...(ctx.siteId !== undefined ? { siteBaseUrl: ctx.siteId } : {}),
        });
        if (verdict !== "same-site") {
          return {
            kind: "blocks",
            blocks: datasourceLinkBlocks(m, datasourceUrl),
            bodyConsumed: true,
            notes: [
              {
                level: "warning",
                code: "datasource-cross-site",
                message:
                  verdict === "cross-site"
                    ? `A Jira datasource table targets a different Jira site (${describeOrigin(datasourceUrl)}) than this export is authenticated against (${describeOrigin(ctx.siteId)}); it was kept as a link instead of being answered with rows from the wrong site.`
                    : "A Jira datasource table could not be proven to target this export's Jira site; it was kept as a link instead of being answered with rows that may come from a different site.",
                macroName: m.name,
              },
            ],
          };
        }
      }

      if (!ctx.jira) return { kind: "skip" };

      const serverIdNote: ExportNote[] = [];
      if (macroParamText(m.params, "serverId")) {
        serverIdNote.push({
          level: "info",
          code: "macro-rendered-via",
          message: "Jira macro `serverId` (linked second site) is ignored in this version.",
          macroName: m.name,
        });
      }

      const key = macroParamText(m.params, "key");
      const jql = macroParamText(m.params, "jqlQuery") ?? macroParamText(m.params, "jql");

      try {
        if (key) {
          const issue = await ctx.jira.getIssue(key.trim());
          const line: ExportBlock = {
            type: "paragraph",
            content: [
              issueLink(issue),
              { type: "text", text: ` ${issue.summary} ` },
              { type: "status", text: issue.status, color: issue.statusColor },
            ],
          };
          return {
            kind: "blocks",
            blocks: [line],
            notes: [
              {
                level: "info",
                code: "macro-rendered-via",
                message: `Jira issue ${issue.key} rendered live.`,
                macroName: m.name,
              },
              ...serverIdNote,
            ],
          };
        }

        if (jql) {
          const columns = parseColumns(macroParamText(m.params, "columns"));
          const maximumIssues = parseMaxIssues(macroParamText(m.params, "maximumIssues"));
          // Ask for one row past the cap so truncation is a FACT, not a guess
          // (same probe the children renderer uses). A table silently cut at
          // the cap is the same class of defect as a silently dropped macro —
          // and a datasource stores no row limit at all, so this cap is ours.
          const fetched = await ctx.jira.searchJql(jql, {
            columns,
            maximumIssues: maximumIssues + 1,
          });
          const truncated = fetched.length > maximumIssues;
          const issues = truncated ? fetched.slice(0, maximumIssues) : fetched;
          const table = issueTable(columns, issues);
          const truncationNote: ExportNote[] = truncated
            ? [
                {
                  level: "warning",
                  code: "macro-degraded",
                  message: `Jira table truncated to ${maximumIssues} of ${maximumIssues}+ matching issues.`,
                  macroName: m.name,
                },
              ]
            : [];
          return {
            kind: "blocks",
            blocks: [table],
            notes: [
              {
                level: "info",
                code: "macro-rendered-via",
                message: `Jira JQL rendered as a ${issues.length}-issue table.`,
                macroName: m.name,
              },
              ...truncationNote,
              ...serverIdNote,
            ],
          };
        }

        // Neither key nor JQL → fall through (export_view / placeholder).
        return { kind: "skip" };
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
              message: `Jira macro skipped: ${err instanceof Error ? err.message : String(err)}`,
              macroName: m.name,
            },
          ],
        };
      }
    },
  };
}
