/**
 * Data model for generated report pages (release notes, sprint review):
 * spec jira-content-workflows A3. Pure: Jira issues in, template-ready data
 * out. Every free-text field has a `…Md` twin that is already escaped for the
 * atlcli markdown dialect, so templates can insert it with `{{{…}}}` without
 * an issue summary like `Fix *all* the [things]` turning into formatting.
 */
import { getStoryPoints, type SprintIssueSnapshot } from "./analysis.js";
import type { StatusCategoryResolver } from "./flow.js";
import type { AdfNode, JiraIssue, SprintMetrics } from "./types.js";

export type ReportStatusCategory = "todo" | "inprogress" | "done";

export interface ReportIssue {
  key: string;
  url: string;
  /** `[KEY](url)` */
  link: string;
  summary: string;
  summaryMd: string;
  /** Opening text of the description, about two lines; absent when there is none. */
  excerpt?: string;
  excerptMd?: string;
  type: string;
  status: string;
  statusCategory: ReportStatusCategory;
  done: boolean;
  assignee?: string;
  epic?: { key: string; url: string; summary: string; summaryMd: string };
  points?: number;
}

export interface ReportGroup {
  name: string;
  nameMd: string;
  /** Epic groups only. */
  key?: string;
  url?: string;
  count: number;
  issues: ReportIssue[];
}

export interface ReportSource {
  id: string;
  name: string;
  nameMd: string;
  description?: string;
  descriptionMd?: string;
  goal?: string;
  goalMd?: string;
  state?: string;
  released?: boolean;
  /** YYYY-MM-DD */
  startDay?: string;
  endDay?: string;
  releaseDay?: string;
  /** `{date:YYYY-MM-DD}` for the dialect's date lozenge */
  releaseDateMd?: string;
}

export interface ReportData {
  kind: "release" | "sprint";
  source: ReportSource;
  issues: ReportIssue[];
  doneIssues: ReportIssue[];
  openIssues: ReportIssue[];
  byType: ReportGroup[];
  byEpic: ReportGroup[];
  contributors: Array<{ name: string; nameMd: string; count: number }>;
  metrics: {
    total: number;
    done: number;
    inProgress: number;
    todo: number;
    donePercent: number;
    points?: { committed: number; completed: number };
    sayDoRatio?: number;
  };
  generatedAt: string;
}

export interface BuildReportInput {
  kind: "release" | "sprint";
  source: {
    id: string;
    name: string;
    description?: string;
    goal?: string;
    state?: string;
    released?: boolean;
    startDate?: string;
    endDate?: string;
    releaseDate?: string;
  };
  issues: JiraIssue[];
  /** Jira site URL, for `/browse/KEY` links. */
  baseUrl: string;
  pointsField?: string;
  sprintMetrics?: SprintMetrics;
  /**
   * Each issue as of the sprint's end, by key (see `issueAt`). Issues no longer
   * in the sprint then are left out; done and points follow the snapshot.
   */
  asOf?: Map<string, SprintIssueSnapshot>;
  /** Status resolver (status map); without it, categories come from Jira. */
  resolve?: StatusCategoryResolver;
  now: Date;
}

const TYPE_ORDER = ["Epic", "Story", "Task", "Bug"];

export function buildReportData(input: BuildReportInput): ReportData {
  const base = input.baseUrl.replace(/\/+$/, "");
  const browse = (key: string) => `${base}/browse/${key}`;

  const issues = input.issues
    .filter((issue) => input.asOf?.get(issue.key)?.inSprint !== false)
    .map((issue): ReportIssue => {
      const f = issue.fields;
      const category = statusCategory(f.status, input.resolve);
      const then = input.asOf?.get(issue.key);
      const parent = f.parent;
      const isEpicParent = parent?.fields?.issuetype?.name === "Epic" || parent?.fields?.issuetype?.hierarchyLevel === 1;
      const parentSummary = parent?.fields?.summary ?? parent?.key ?? "";
      const excerpt = descriptionExcerpt(f.description);
      return {
        key: issue.key,
        url: browse(issue.key),
        link: `[${issue.key}](${browse(issue.key)})`,
        summary: f.summary ?? "",
        summaryMd: escapeMarkdown(f.summary ?? ""),
        excerpt,
        excerptMd: excerpt ? escapeMarkdown(excerpt) : undefined,
        type: f.issuetype?.name ?? "Other",
        status: f.status?.name ?? "",
        statusCategory: category,
        done: then ? then.done : category === "done",
        assignee: f.assignee?.displayName,
        epic:
          parent && isEpicParent
            ? { key: parent.key, url: browse(parent.key), summary: parentSummary, summaryMd: escapeMarkdown(parentSummary) }
            : undefined,
        points: input.pointsField ? (then?.points ?? getStoryPoints(issue, input.pointsField)) : undefined,
      };
    })
    .sort((a, b) => compareKeys(a.key, b.key));

  const byType = groupBy(issues, (issue) => issue.type)
    .map(([name, list]) => group(name, list))
    .sort((a, b) => typeRank(a.name) - typeRank(b.name) || a.name.localeCompare(b.name));

  const byEpic = groupBy(issues, (issue) => issue.epic?.key ?? "")
    .map(([key, list]) => {
      const epic = list[0]!.epic;
      return epic ? { ...group(epic.summary || key, list), key, url: epic.url } : group("No epic", list);
    })
    // Epics A–Z by name, "No epic" last.
    .sort((a, b) => Number(!a.key) - Number(!b.key) || a.name.localeCompare(b.name));

  const contributors = groupBy(
    issues.filter((issue) => issue.assignee),
    (issue) => issue.assignee!
  )
    .map(([name, list]) => ({ name, nameMd: escapeMarkdown(name), count: list.length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const done = issues.filter((issue) => issue.done).length;
  const inProgress = issues.filter((issue) => !issue.done && issue.statusCategory === "inprogress").length;
  const m = input.sprintMetrics;
  const points = input.pointsField
    ? {
        committed: m?.committedPoints ?? sum(issues.map((issue) => issue.points ?? 0)),
        completed: m?.completedPoints ?? sum(issues.filter((issue) => issue.done).map((issue) => issue.points ?? 0)),
      }
    : undefined;

  const s = input.source;
  const day = (value?: string) => (value ? calendarDay(value) : undefined);
  return {
    kind: input.kind,
    source: {
      id: s.id,
      name: s.name,
      nameMd: escapeMarkdown(s.name),
      description: s.description || undefined,
      descriptionMd: s.description ? escapeMarkdown(s.description) : undefined,
      goal: s.goal || undefined,
      goalMd: s.goal ? escapeMarkdown(s.goal) : undefined,
      state: s.state,
      released: s.released,
      startDay: day(s.startDate),
      endDay: day(s.endDate),
      releaseDay: day(s.releaseDate),
      releaseDateMd: day(s.releaseDate) ? `{date:${day(s.releaseDate)}}` : undefined,
    },
    issues,
    doneIssues: issues.filter((issue) => issue.done),
    openIssues: issues.filter((issue) => !issue.done),
    byType,
    byEpic,
    contributors,
    metrics: {
      total: issues.length,
      done,
      inProgress,
      todo: issues.length - done - inProgress,
      donePercent: issues.length ? Math.round((done / issues.length) * 100) : 0,
      points,
      sayDoRatio: input.sprintMetrics?.sayDoRatio,
    },
    generatedAt: input.now.toISOString(),
  };
}

const EXCERPT_MAX = 240;
/** Blocks whose text is not prose: an excerpt skips them. */
const NON_PROSE = new Set(["codeBlock", "table", "mediaSingle", "mediaGroup", "blockCard", "embedCard", "extension", "bodiedExtension"]);

/**
 * The opening prose of a description as one line of plain text, cut at a word
 * boundary near {@link EXCERPT_MAX} characters. Code, tables and media are
 * skipped; Data Center wiki-markup strings are only whitespace-collapsed.
 */
export function descriptionExcerpt(description: unknown, max = EXCERPT_MAX): string | undefined {
  const text =
    typeof description === "string"
      ? description
      : description && typeof description === "object"
        ? proseOf(((description as { content?: AdfNode[] }).content ?? []))
        : "";
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  if (line.length <= max) return line;
  const cut = line.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : line.slice(0, max)).replace(/[\s.,;:–-]+$/, "")}…`;
}

/**
 * `YYYY-MM-DD` in local time, as Jira shows it. Sprint dates come in UTC, so
 * a sprint ending at midnight CEST would otherwise show the day before. A
 * date without a time (versions) is returned as is.
 */
export function calendarDay(value: string): string {
  const at = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(at.getTime())) return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function proseOf(nodes: AdfNode[]): string {
  return nodes
    .map((node) => {
      if (NON_PROSE.has(node.type)) return " ";
      if (node.type === "text") return node.text ?? "";
      if (node.type === "hardBreak") return " ";
      if (node.type === "mention" || node.type === "emoji") return String(node.attrs?.text ?? "");
      if (node.type === "inlineCard") return String(node.attrs?.url ?? "");
      if (node.type === "status") return String(node.attrs?.text ?? "");
      if (node.type === "date") {
        const day = new Date(Number(node.attrs?.timestamp));
        return Number.isNaN(day.getTime()) ? "" : day.toISOString().slice(0, 10);
      }
      // Block boundaries become spaces so paragraphs do not run together.
      return node.content ? ` ${proseOf(node.content)} ` : "";
    })
    .join("");
}

function statusCategory(status: JiraIssue["fields"]["status"], resolve?: StatusCategoryResolver): ReportStatusCategory {
  const category = status && resolve ? resolve(status) : undefined;
  const key = status?.statusCategory?.key;
  if (category === "done" || (!category && key === "done")) return "done";
  if (category === "wip" || (!category && key === "indeterminate")) return "inprogress";
  return "todo";
}

function group(name: string, issues: ReportIssue[]): ReportGroup {
  return { name, nameMd: escapeMarkdown(name), count: issues.length, issues };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups];
}

function typeRank(name: string): number {
  const index = TYPE_ORDER.indexOf(name);
  return index < 0 ? TYPE_ORDER.length : index;
}

/** PROJ-2 before PROJ-10. */
function compareKeys(a: string, b: string): number {
  const [pa = "", na = "0"] = a.split("-");
  const [pb = "", nb = "0"] = b.split("-");
  return pa.localeCompare(pb) || Number(na) - Number(nb);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Escape text so markdown and the atlcli dialect render it literally. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_[\]<>{}~|#]/g, "\\$&")
    .replace(/^(\s*)([-+])(?=\s)/, "$1\\$2")
    .replace(/^(\s*\d+)([.)])(?=\s)/, "$1\\$2")
    .replace(/(^|\s)@(?=\\\[)/g, "$1\\@")
    .replace(/(^|[\s(]):(?=[a-z][a-z0-9_+-]*:)/g, "$1\\:");
}
