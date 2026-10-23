/**
 * Input and list-output helpers for `atlcli jira`: user references, JQL
 * building for search, clone text replacement and the issue table.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adfToMarkdown, calendarDay, escapeCsvValue, type JiraClient, type JiraField, type JiraIssue, type JiraStatus, type JiraUser } from "@atlcli/jira";
import { stripOrderBy } from "./jira-flow.js";

// ============ Users ============

/** A user for a Jira field: account id on Cloud, user name on Server/DC. */
export type UserRef = { accountId: string } | { name: string };

const ACCOUNT_ID = /^(?:[0-9a-f]{24}|\d+:[0-9a-f-]{36})$/i;

/**
 * `--assignee`, `--lead`, `--user`: `me`, an account id, an email or a name.
 * `none` and `x` mean nobody (null). Throws on an unknown or ambiguous user.
 */
export async function resolveUser(client: JiraClient, value: string): Promise<UserRef | null> {
  const v = value.trim();
  if (v === "none" || v === "x") return null;
  const user = v === "me" ? await client.getCurrentUser() : client.isCloudSite && ACCOUNT_ID.test(v) ? { accountId: v, displayName: v } : pickUser(await client.searchUsers(v), v);
  return client.isCloudSite ? { accountId: user.accountId! } : { name: user.name! };
}

/** An exact email or display-name match wins; otherwise the only active hit. */
export function pickUser(users: JiraUser[], query: string): JiraUser {
  const q = query.toLowerCase();
  const active = users.filter((u) => u.active !== false && (u as { accountType?: string }).accountType !== "app");
  const exact = active.filter((u) => u.emailAddress?.toLowerCase() === q || u.displayName.toLowerCase() === q || u.name?.toLowerCase() === q);
  const hits = exact.length > 0 ? exact : active;
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw new Error(`No user matches "${query}".`);
  const names = hits.slice(0, 5).map((u) => (u.emailAddress ? `${u.displayName} <${u.emailAddress}>` : u.displayName));
  throw new Error(`"${query}" matches several users: ${names.join(", ")}${hits.length > 5 ? ", …" : ""}. Be more specific.`);
}

// ============ JQL ============

const quote = (value: string) => JSON.stringify(value);

/** A leading `~` negates a filter value: `--status ~Done`. */
export function splitNegation(value: string): { negate: boolean; value: string } {
  return value.startsWith("~") ? { negate: true, value: value.slice(1).trim() } : { negate: false, value };
}

/**
 * `field = "a"`, or `field in ("a", "b")` for a comma-separated list; a
 * leading `~` gives `!=` / `not in`. For a field that can be empty (labels),
 * `nullable` keeps empty issues in the negation, which JQL would drop.
 */
export function jqlIn(field: string, raw: string, nullable = false): string {
  const { negate, value } = splitNegation(raw);
  const values = value.split(",").map((v) => v.trim()).filter(Boolean);
  const one = values.length === 1;
  const clause = one
    ? `${field} ${negate ? "!=" : "="} ${quote(values[0]!)}`
    : `${field} ${negate ? "not in" : "in"} (${values.map(quote).join(", ")})`;
  return negate && nullable ? `(${field} IS EMPTY OR ${clause})` : clause;
}

/**
 * `--status` values as JQL knows them. Jira shows status names in the user's
 * language ("Fertig"), but JQL matches the untranslated name ("Done"), so a
 * localized name would match nothing. Unknown names pass through; `~` stays.
 */
export function jqlStatusNames(raw: string, statuses: Array<Pick<JiraStatus, "name" | "untranslatedName">>): string {
  const { negate, value } = splitNegation(raw);
  const names = value.split(",").map((v) => v.trim()).filter(Boolean).flatMap((v) => {
    const lower = v.toLowerCase();
    const hits = statuses.filter((s) => s.name.toLowerCase() === lower || s.untranslatedName?.toLowerCase() === lower);
    return hits.length > 0 ? [...new Set(hits.map((s) => s.untranslatedName ?? s.name))] : [v];
  });
  return `${negate ? "~" : ""}${[...new Set(names)].join(",")}`;
}

/** The assignee clause; `user` is `currentUser()`, `EMPTY` or a quoted id. */
export function jqlAssignee(user: string, negate: boolean): string {
  if (user === "EMPTY") return negate ? "assignee IS NOT EMPTY" : "assignee IS EMPTY";
  return negate ? `(assignee IS EMPTY OR assignee != ${user})` : `assignee = ${user}`;
}

const PERIOD_START: Record<string, string> = { today: "startOfDay()", week: "startOfWeek()", month: "startOfMonth()", year: "startOfYear()" };

/** A JQL time: `-7d` (also m, h, w), `today|week|month|year` (their start) or `YYYY-MM-DD`. */
function jqlTime(value: string): string | undefined {
  if (PERIOD_START[value]) return PERIOD_START[value];
  if (/^-\d+[mhdw]$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return quote(value);
  return undefined;
}

/** `--created`/`--updated` → `field >= …`. */
export function jqlSince(field: string, value: string): string | undefined {
  const time = jqlTime(value);
  return time && `${field} >= ${time}`;
}

/** `--created-before`/`--updated-before` → `field < …`. */
export function jqlBefore(field: string, value: string): string | undefined {
  const time = jqlTime(value);
  return time && `${field} < ${time}`;
}

export interface SearchFilters {
  jql?: string;
  project?: string;
  /** Already resolved: `currentUser()`, `EMPTY` or a quoted id. */
  assignee?: string;
  /** `--assignee ~…`: anyone but that user. */
  notAssignee?: boolean;
  status?: string;
  type?: string;
  label?: string;
  sprint?: string;
  watching?: boolean;
  history?: boolean;
  /** Ready clauses from `jqlSince` / `jqlBefore`. */
  dates?: string[];
}

/**
 * The JQL for `jira search`: the filter flags ANDed onto the raw JQL (if any),
 * keeping the raw query's ORDER BY. `--history` orders by last viewed.
 */
export function buildSearchJql(f: SearchFilters): string {
  const parts: string[] = [];
  if (f.project) parts.push(`project = ${f.project}`);
  if (f.assignee) parts.push(jqlAssignee(f.assignee, f.notAssignee ?? false));
  if (f.status) parts.push(jqlIn("status", f.status));
  if (f.type) parts.push(jqlIn("issuetype", f.type));
  if (f.label) parts.push(jqlIn("labels", f.label, true));
  if (f.sprint) parts.push(f.sprint === "current" || f.sprint === "active" ? "sprint IN openSprints()" : `sprint = ${quote(f.sprint)}`);
  if (f.watching) parts.push("watcher = currentUser()");
  if (f.history) parts.push("issuekey IN issueHistory()");
  parts.push(...(f.dates ?? []));

  const raw = f.jql?.trim() ?? "";
  const where = stripOrderBy(raw);
  const order = raw.slice(where.length).trim() || (f.history ? "ORDER BY lastViewed DESC" : "");
  if (where && parts.length > 0) parts.unshift(`(${where})`);
  else if (where) parts.push(where);
  const predicate = parts.join(" AND ");
  if (!predicate) return order || "ORDER BY created DESC";
  return order ? `${predicate} ${order}` : predicate;
}

// ============ Clone ============

/** `--replace find:replace` pairs; split at the first colon. */
export function parseReplacements(values: string[]): Array<[string, string]> {
  return values.map((value) => {
    const at = value.indexOf(":");
    if (at <= 0) throw new Error(`Invalid --replace "${value}": use find:replace.`);
    return [value.slice(0, at), value.slice(at + 1)];
  });
}

export function replaceText(text: string, pairs: Array<[string, string]>): string {
  return pairs.reduce((acc, [find, replace]) => acc.split(find).join(replace), text);
}

/** Apply the replacements to every text node of an ADF document (or a plain string on Server/DC). */
export function replaceInBody<T>(body: T, pairs: Array<[string, string]>): T {
  if (pairs.length === 0 || body == null) return body;
  if (typeof body === "string") return replaceText(body, pairs) as T;
  return JSON.parse(JSON.stringify(body), (key, value) => (key === "text" && typeof value === "string" ? replaceText(value, pairs) : value));
}

// ============ Editor ============

/** Edit `initial` in `$VISUAL`/`$EDITOR` (default `vi`); needs a terminal. */
export async function editInEditor(initial: string, name = "atlcli.md"): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("--edit needs a terminal; use --description-file or --body-file in scripts.");
  const dir = await mkdtemp(join(tmpdir(), "atlcli-edit-"));
  const file = join(dir, name);
  try {
    await writeFile(file, initial, "utf8");
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    await new Promise<void>((resolve, reject) => {
      const child = spawn(`${editor} "${file}"`, { stdio: "inherit", shell: true });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code}.`))));
    });
    return await readFile(file, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============ Issue table ============

export const DEFAULT_COLUMNS = ["key", "type", "status", "assignee", "summary"];

/** Columns known without the field list: lower-case name → field id. */
const KNOWN_COLUMNS: Record<string, string> = Object.fromEntries(
  ["key", "id", "summary", "status", "assignee", "reporter", "priority", "created", "updated", "labels", "parent", "resolution", "duedate", "components", "fixVersions", "issuetype"].map((id) => [id.toLowerCase(), id])
);
KNOWN_COLUMNS.type = "issuetype";

const knownColumn = (column: string) => KNOWN_COLUMNS[column.toLowerCase()] ?? (/^customfield_\d+$/.test(column) ? column : undefined);

/** True when a column is a field name (`"Story Points"`), which needs the field list to resolve. */
export function needsFieldList(columns: string[]): boolean {
  return columns.some((c) => !knownColumn(c));
}

/** Each column as `key`, `id` or a field id (`customfield_10016`, `duedate`); names via `fields`. */
export function resolveColumns(columns: string[], fields: JiraField[] = []): string[] {
  return columns.map((column) => {
    const known = knownColumn(column);
    if (known) return known;
    const lower = column.toLowerCase();
    const match = fields.find((f) => f.id === column) ?? fields.find((f) => f.name.toLowerCase() === lower);
    if (!match) throw new Error(`Unknown column "${column}". Use a field id or name (see \`jira field search\`).`);
    return match.id;
  });
}

/** One cell: names of users and options, comma-joined arrays, ADF as markdown. */
export function cellValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(cellValue).filter(Boolean).join(",");
  if (typeof value !== "object") return String(value);
  const v = value as Record<string, unknown>;
  if (v.type === "doc") return adfToMarkdown(v as never).replace(/\s+/g, " ").trim();
  const named = v.displayName ?? v.name ?? v.value ?? v.key;
  return named != null ? String(named) : JSON.stringify(value);
}

export function issueCell(issue: JiraIssue, fieldId: string): string {
  if (fieldId === "key") return issue.key;
  if (fieldId === "id") return issue.id;
  return cellValue((issue.fields as unknown as Record<string, unknown>)[fieldId]);
}

export type TableFormat = { kind: "table" } | { kind: "plain"; delimiter: string } | { kind: "csv" };

/** Rows as an aligned table, delimited plain text or CSV (RFC 4180). */
export function renderTable(header: string[], rows: string[][], format: TableFormat, headers = true): string {
  const all = headers ? [header, ...rows] : rows;
  if (format.kind === "csv") return all.map((row) => row.map(escapeCsvValue).join(",")).join("\n");
  if (format.kind === "plain") return all.map((row) => row.map((c) => c.replace(/[\t\r\n]+/g, " ")).join(format.delimiter)).join("\n");
  const widths = header.map((_, i) => Math.max(...all.map((row) => row[i]!.length)));
  return all.map((row) => row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

// ============ Detail views ============

/**
 * A detail view: a title line, aligned `label  value` rows (empty values
 * left out) and titled sections (description, links, comments).
 */
export function renderDetails(
  title: string,
  rows: Array<[string, unknown]>,
  sections: Array<[string, string | undefined]> = []
): string {
  const shown = rows
    .map(([label, value]) => [label, Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value)] as const)
    .filter(([, value]) => value !== "");
  const width = Math.max(0, ...shown.map(([label]) => label.length));
  const lines = [title, "", ...shown.map(([label, value]) => `${label.padEnd(width)}  ${value}`)];
  for (const [heading, body] of sections) {
    if (body?.trim()) lines.push("", heading, ...body.trimEnd().split("\n").map((line) => (line ? `  ${line}` : "")));
  }
  return lines.join("\n");
}

/** Markdown for reading: ADF kept only for round trips (`<!--adf:…-->`) shows as `[…]`. */
const readable = (markdown: string) => markdown.replace(/<!--adf:[\s\S]*?-->/g, "[…]");

/** `issue get` as text: fields, description, links and the last comments. */
export function renderIssueView(issue: JiraIssue, baseUrl: string, commentCount = 3): string {
  const f = issue.fields;
  const day = (iso?: string) => (iso ? calendarDay(iso) : "");
  const links = (f.issuelinks ?? []).map((link) => {
    const other = link.outwardIssue ?? link.inwardIssue;
    const verb = link.outwardIssue ? link.type.outward : link.type.inward;
    const status = other?.fields?.status?.name;
    return `${verb} ${other?.key ?? "?"}${status ? `  [${status}]` : ""}${other?.fields?.summary ? `  ${other.fields.summary}` : ""}`;
  });
  const comments = f.comment?.comments ?? [];
  const recent = comments.slice(-commentCount);
  const commentText = recent
    .map((c) => `${c.author?.displayName ?? "?"} · ${day(c.created)}\n${readable(adfToMarkdown(c.body, { baseUrl })).trim()}`)
    .join("\n\n");
  const total = f.comment?.total ?? comments.length;
  return renderDetails(
    `${issue.key}  ${f.summary ?? ""}`,
    [
      ["Status", f.status?.name],
      ["Type", f.issuetype?.name],
      ["Priority", f.priority?.name],
      ["Assignee", f.assignee?.displayName ?? "(unassigned)"],
      ["Reporter", f.reporter?.displayName],
      ["Labels", f.labels],
      ["Components", (f.components ?? []).map((c) => c.name)],
      ["Fix versions", (f.fixVersions ?? []).map((v) => v.name)],
      ["Parent", f.parent ? `${f.parent.key}${f.parent.fields?.summary ? `  ${f.parent.fields.summary}` : ""}` : undefined],
      ["Due", f.duedate],
      ["Created", day(f.created)],
      ["Updated", day(f.updated)],
      ["URL", `${baseUrl}/browse/${issue.key}`],
    ],
    [
      ["Description", readable(adfToMarkdown(f.description, { baseUrl }))],
      [`Links (${links.length})`, links.join("\n")],
      [`Comments (${recent.length < total ? `last ${recent.length} of ${total}` : total})`, commentText],
    ]
  );
}
