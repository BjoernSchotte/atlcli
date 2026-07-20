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
  const map: Record<string, string> = { key: "Key", summary: "Summary", status: "Status" };
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
    async render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult> {
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
          const issues = await ctx.jira.searchJql(jql, { columns, maximumIssues });
          const table = issueTable(columns, issues);
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
