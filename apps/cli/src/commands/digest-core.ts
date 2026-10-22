/**
 * Pure core of `atlcli digest` (spec digest-flow-metrics B1): since
 * resolution, query strings, filtering, de-duplication, the marker state and
 * rendering. No IO; `now` is always passed in.
 */
import type { ConfluenceSearchResult } from "@atlcli/confluence";
import type { JiraChangelogEntry, JiraIssue } from "@atlcli/jira";
import { buildMyIssuesJql } from "./jira.js";
import { buildMyPagesCql, buildRecentPagesCql } from "./search.js";

export type DigestProduct = "jira" | "confluence";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A stale marker cannot reach further back than this. */
export const DIGEST_MAX_LOOKBACK_DAYS = 30;
/** `lastrun` reaches back this far before the marker, because search indexes lag writes. */
export const DIGEST_LASTRUN_OVERLAP_MINUTES = 5;
/** Comments are looked up on this many of your most recently modified pages. */
export const DIGEST_COMMENT_PAGES = 50;

// ── since ────────────────────────────────────────────────────────────────

export interface DigestSince {
  at: Date;
  source: "lastrun" | "explicit" | "default";
  label: string;
  warning?: string;
}

/**
 * `<n>m|h|d|w` (here `m` means minutes), `today`, `yesterday` (local
 * midnight), an ISO date or datetime, or `lastrun` (also the default). Without
 * a marker, `lastrun` falls back to 24 hours.
 */
export function resolveDigestSince(input: string | undefined, now: Date, lastRunAt: Date | undefined): DigestSince {
  const value = (input ?? "lastrun").trim();
  let since: DigestSince;
  if (value === "lastrun") {
    since = lastRunAt
      ? {
          at: new Date(lastRunAt.getTime() - DIGEST_LASTRUN_OVERLAP_MINUTES * MINUTE_MS),
          source: "lastrun",
          label: `last run (${lastRunAt.toISOString()})`,
        }
      : { at: new Date(now.getTime() - DAY_MS), source: "default", label: "the last 24h (no previous run)" };
  } else {
    since = { at: parseExplicitSince(value, now), source: "explicit", label: value };
  }
  if (since.at.getTime() > now.getTime()) {
    throw new Error(`--since ${value} is in the future.`);
  }
  const floor = now.getTime() - DIGEST_MAX_LOOKBACK_DAYS * DAY_MS;
  if (since.at.getTime() < floor) {
    since = {
      ...since,
      at: new Date(floor),
      warning: `since was clamped to ${DIGEST_MAX_LOOKBACK_DAYS} days.`,
    };
  }
  return since;
}

function parseExplicitSince(value: string, now: Date): Date {
  const relative = /^(\d+)\s*([mhdw])$/i.exec(value);
  if (relative) {
    const unit = { m: MINUTE_MS, h: 60 * MINUTE_MS, d: DAY_MS, w: 7 * DAY_MS }[relative[2].toLowerCase() as "m"];
    return new Date(now.getTime() - Number(relative[1]) * unit);
  }
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (value === "today") return midnight;
  if (value === "yesterday") return new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - 1);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date) return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) return new Date(value);
  throw new Error(`Invalid --since "${value}". Use 24h, 7d, 90m, today, yesterday, an ISO date, or lastrun.`);
}

export function sinceMinutes(since: DigestSince, now: Date): number {
  return Math.max(1, Math.ceil((now.getTime() - since.at.getTime()) / MINUTE_MS));
}

// ── queries ──────────────────────────────────────────────────────────────

export interface DigestQueries {
  waiting: string;
  changed: string;
  mentions: string;
  myPagesEdited: string;
  myPageIds: string;
  watched: string;
  recent?: string;
}

/** Every JQL/CQL string the digest runs, except the comment query (see `buildCommentsCql`). */
export function buildDigestQueries(opts: { minutes: number; space?: string }): DigestQueries {
  const window = `now("-${opts.minutes}m")`;
  return {
    waiting: `${buildMyIssuesJql({})} ORDER BY priority DESC, updated DESC`,
    changed: `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -${opts.minutes}m ORDER BY updated DESC`,
    mentions: `mention = currentUser() AND lastmodified >= ${window} ORDER BY lastmodified DESC`,
    myPagesEdited: `${buildMyPagesCql({})} AND lastmodified >= ${window} ORDER BY lastmodified DESC`,
    myPageIds: `${buildMyPagesCql({})} ORDER BY lastmodified DESC`,
    watched: `watcher = currentUser() AND type in (page, blogpost) AND lastmodified >= ${window} ORDER BY lastmodified DESC`,
    ...(opts.space
      ? { recent: `${buildRecentPagesCql({ space: opts.space, since: `-${opts.minutes}m` })} ORDER BY lastModified DESC` }
      : {}),
  };
}

/** New comments on the given pages (CQL scopes comments by `container`). */
export function buildCommentsCql(pageIds: string[], minutes: number): string | undefined {
  if (pageIds.length === 0) return undefined;
  return `type = comment AND container IN (${pageIds.join(", ")}) AND created >= now("-${minutes}m") ORDER BY created DESC`;
}

// ── result model ─────────────────────────────────────────────────────────

export interface DigestIssue {
  key: string;
  summary: string;
  status: string;
  priority?: string;
  url: string;
}

export interface DigestChange {
  at: string;
  author: string;
  you: boolean;
  field: string;
  from: string | null;
  to: string | null;
}

export interface DigestIssueChange extends DigestIssue {
  roles: string[];
  /** Empty when the site gives no change details (Data Center). */
  changes: DigestChange[];
}

export interface DigestSprint {
  id: number;
  name: string;
  daysLeft: number | null;
  counts: { todo: number; wip: number; done: number };
  yoursOpen: number;
  progress: string;
}

export interface DigestPage {
  id: string;
  title: string;
  space?: string;
  url?: string;
  lastModified?: string;
  lastModifiedBy?: string;
  alsoIn?: string[];
}

export interface DigestComment {
  id: string;
  pageId?: string;
  pageTitle?: string;
  author?: string;
  created?: string;
  url?: string;
  location?: string;
}

export interface DigestV1 {
  schemaVersion: "1";
  generatedAt: string;
  since: { at: string; source: DigestSince["source"]; label: string };
  profile: string;
  me: { displayName?: string };
  jira?: { waiting: DigestIssue[]; changed: DigestIssueChange[]; sprints: DigestSprint[] };
  confluence?: {
    mentions: DigestPage[];
    myPagesEdited: DigestPage[];
    comments: DigestComment[];
    openInline: DigestComment[];
    watched: DigestPage[];
    recent: DigestPage[];
  };
  warnings: Array<{ section: string; message: string }>;
  truncated: string[];
  queries?: Record<string, string>;
  summary?: string;
}

export interface DigestRawSprint {
  id: number;
  name: string;
  endDate?: string;
  issues: JiraIssue[];
}

/** What the shell fetched. A missing section was not fetched (failed or out of scope). */
export interface DigestRawInput {
  profile: string;
  since: DigestSince;
  products: DigestProduct[];
  me: { jiraAccountId?: string; confluenceAccountId?: string; displayName?: string };
  jiraBaseUrl?: string;
  jira: {
    waiting?: JiraIssue[];
    changed?: JiraIssue[];
    /** `undefined` when the site gives no change details (Data Center). */
    changelogs?: Map<string, JiraChangelogEntry[]>;
    sprints?: DigestRawSprint[];
  };
  confluence: {
    mentions?: ConfluenceSearchResult[];
    myPagesEdited?: ConfluenceSearchResult[];
    comments?: ConfluenceSearchResult[];
    openInline?: ConfluenceSearchResult[];
    watched?: ConfluenceSearchResult[];
    recent?: ConfluenceSearchResult[];
  };
  errors: Array<{ section: string; message: string }>;
  queries?: Record<string, string>;
}

const PAGE_SECTION_ORDER = ["mentions", "myPagesEdited", "watched", "recent"] as const;
type PageSection = (typeof PAGE_SECTION_ORDER)[number];

function issueUrl(base: string | undefined, key: string): string {
  return `${base ?? ""}/browse/${key}`;
}

function toDigestIssue(issue: JiraIssue, base: string | undefined): DigestIssue {
  return {
    key: issue.key,
    summary: issue.fields.summary ?? "",
    status: issue.fields.status?.name ?? "",
    ...(issue.fields.priority?.name ? { priority: issue.fields.priority.name } : {}),
    url: issueUrl(base, issue.key),
  };
}

function short(value: string | null): string | null {
  if (value === null) return null;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

function toDigestPage(item: ConfluenceSearchResult): DigestPage {
  return {
    id: item.id,
    title: item.title,
    ...(item.spaceKey ? { space: item.spaceKey } : {}),
    ...(item.url ? { url: item.url } : {}),
    ...(item.lastModified ? { lastModified: item.lastModified } : {}),
    ...(item.lastModifiedBy ? { lastModifiedBy: item.lastModifiedBy } : {}),
  };
}

function toDigestComment(item: ConfluenceSearchResult): DigestComment {
  return {
    id: item.id,
    ...(item.container?.id ? { pageId: item.container.id } : {}),
    ...(item.container?.title ? { pageTitle: item.container.title } : {}),
    ...(item.creator ? { author: item.creator } : {}),
    ...(item.created ? { created: item.created } : {}),
    ...(item.url ? { url: item.url } : {}),
    ...(item.location ? { location: item.location } : {}),
  };
}

function byNewest<T extends { id: string }>(time: (t: T) => string | undefined) {
  return (a: T, b: T) => (time(b) ?? "").localeCompare(time(a) ?? "") || a.id.localeCompare(b.id);
}

/** Turn the raw fetch into the versioned digest. */
export function buildDigest(input: DigestRawInput, opts: { now: Date; includeOwn: boolean; limit: number }): DigestV1 {
  const { includeOwn, limit } = opts;
  const truncated: string[] = [];
  const cap = <T>(section: string, items: T[]): T[] => {
    if (items.length > limit) truncated.push(section);
    return items.slice(0, limit);
  };
  const since = input.since.at.getTime();

  const digest: DigestV1 = {
    schemaVersion: "1",
    generatedAt: opts.now.toISOString(),
    since: { at: input.since.at.toISOString(), source: input.since.source, label: input.since.label },
    profile: input.profile,
    me: input.me.displayName ? { displayName: input.me.displayName } : {},
    warnings: [
      ...(input.since.warning ? [{ section: "since", message: input.since.warning }] : []),
      ...input.errors,
    ],
    truncated,
  };

  if (input.products.includes("jira")) {
    const me = input.me.jiraAccountId;
    const base = input.jiraBaseUrl;
    const changed: DigestIssueChange[] = [];
    for (const issue of input.jira.changed ?? []) {
      const roles = [
        ...(me && issue.fields.assignee?.accountId === me ? ["assignee"] : []),
        ...(me && issue.fields.reporter?.accountId === me ? ["reporter"] : []),
      ];
      const entry: DigestIssueChange = {
        ...toDigestIssue(issue, base),
        roles: roles.length ? roles : ["watching"],
        changes: [],
      };
      const log = input.jira.changelogs?.get(issue.key);
      if (input.jira.changelogs) {
        for (const history of log ?? []) {
          if (Date.parse(history.created) < since) continue;
          const you = Boolean(me) && history.author?.accountId === me;
          if (you && !includeOwn) continue;
          for (const item of history.items) {
            entry.changes.push({
              at: history.created,
              author: history.author?.displayName ?? "",
              you,
              field: item.field,
              from: short(item.fromString ?? item.from),
              to: short(item.toString ?? item.to),
            });
          }
        }
        if (entry.changes.length === 0) continue;
      }
      changed.push(entry);
    }

    const sprints = (input.jira.sprints ?? []).map((raw): DigestSprint => {
      const counts = { todo: 0, wip: 0, done: 0 };
      let yoursOpen = 0;
      for (const issue of raw.issues) {
        const key = issue.fields.status?.statusCategory?.key;
        const category = key === "done" ? "done" : key === "indeterminate" ? "wip" : "todo";
        counts[category]++;
        if (category !== "done" && me && issue.fields.assignee?.accountId === me) yoursOpen++;
      }
      const total = raw.issues.length;
      const width = 20;
      const filled = total ? Math.round((counts.done / total) * width) : 0;
      return {
        id: raw.id,
        name: raw.name,
        daysLeft: raw.endDate ? Math.max(0, Math.ceil((Date.parse(raw.endDate) - opts.now.getTime()) / DAY_MS)) : null,
        counts,
        yoursOpen,
        progress: `[${"█".repeat(filled)}${"─".repeat(width - filled)}] ${total ? Math.round((counts.done / total) * 100) : 0}%`,
      };
    });

    digest.jira = {
      waiting: cap("jira.waiting", (input.jira.waiting ?? []).map((i) => toDigestIssue(i, base))),
      changed: cap("jira.changed", changed),
      sprints,
    };
  }

  if (input.products.includes("confluence")) {
    const me = input.me.confluenceAccountId;
    const notMine = (item: ConfluenceSearchResult, by: "lastModifiedById" | "creatorId") =>
      includeOwn || !me || item[by] !== me;
    const c = input.confluence;

    const seen = new Map<string, DigestPage>();
    const pages = {} as Record<PageSection, DigestPage[]>;
    for (const section of PAGE_SECTION_ORDER) {
      const list: DigestPage[] = [];
      const items = [...(c[section] ?? [])]
        .filter((item) => notMine(item, "lastModifiedById"))
        .sort(byNewest((item) => item.lastModified));
      for (const item of items) {
        const first = seen.get(item.id);
        if (first) {
          if (!first.alsoIn?.includes(section)) first.alsoIn = [...(first.alsoIn ?? []), section];
          continue;
        }
        const page = toDigestPage(item);
        seen.set(item.id, page);
        list.push(page);
      }
      pages[section] = cap(`confluence.${section}`, list);
    }

    const comments = (c.comments ?? [])
      .filter((item) => notMine(item, "creatorId"))
      .sort(byNewest((item) => item.created))
      .map(toDigestComment);
    const openInline = (c.openInline ?? [])
      .filter((item) => notMine(item, "creatorId") && /^(open|reopened)$/i.test(item.resolutionStatus ?? ""))
      .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? "") || a.id.localeCompare(b.id))
      .map(toDigestComment);

    digest.confluence = {
      mentions: pages.mentions,
      myPagesEdited: pages.myPagesEdited,
      comments: cap("confluence.comments", comments),
      openInline: cap("confluence.openInline", openInline),
      watched: pages.watched,
      recent: pages.recent,
    };
  }

  if (input.queries) digest.queries = input.queries;
  return digest;
}

/** Products none of whose sections failed. */
export function succeededProducts(digest: DigestV1, products: DigestProduct[]): DigestProduct[] {
  return products.filter((p) => !digest.warnings.some((w) => w.section.startsWith(`${p}.`)));
}

/** True when at least one section came back (skipped and failed sections are both absent). */
export function anySectionSucceeded(input: Pick<DigestRawInput, "jira" | "confluence">): boolean {
  return [...Object.values(input.jira), ...Object.values(input.confluence)].some((value) => value !== undefined);
}

// ── marker state ─────────────────────────────────────────────────────────

export interface DigestState {
  schemaVersion: 2;
  jira?: { lastRunAt: string };
  confluence?: { lastRunAt: string };
}

/** Parse `digest-state.json`; schemaVersion 1 (`{ lastRunAt }`) counts for both products. */
export function parseDigestState(raw: unknown): DigestState {
  const value = raw as { schemaVersion?: number; lastRunAt?: string; jira?: { lastRunAt?: string }; confluence?: { lastRunAt?: string } };
  const valid = (s: unknown): s is string => typeof s === "string" && !Number.isNaN(Date.parse(s));
  if (value?.schemaVersion === 1 && valid(value.lastRunAt)) {
    return { schemaVersion: 2, jira: { lastRunAt: value.lastRunAt }, confluence: { lastRunAt: value.lastRunAt } };
  }
  if (value?.schemaVersion === 2) {
    return {
      schemaVersion: 2,
      ...(valid(value.jira?.lastRunAt) ? { jira: { lastRunAt: value.jira.lastRunAt } } : {}),
      ...(valid(value.confluence?.lastRunAt) ? { confluence: { lastRunAt: value.confluence.lastRunAt } } : {}),
    };
  }
  throw new Error("unrecognised digest state");
}

/**
 * Which markers move: a product's marker advances to the run start only when
 * its since came from the marker (or the no-marker default), none of its
 * sections failed and `--no-mark` was not given.
 */
export function nextDigestState(
  prev: DigestState,
  opts: {
    runStartedAt: Date;
    succeeded: DigestProduct[];
    sinceSources: Partial<Record<DigestProduct, DigestSince["source"]>>;
    noMark: boolean;
  }
): DigestState {
  const next: DigestState = { ...prev, schemaVersion: 2 };
  if (opts.noMark) return next;
  for (const product of opts.succeeded) {
    const source = opts.sinceSources[product];
    if (source === "lastrun" || source === "default") {
      next[product] = { lastRunAt: opts.runStartedAt.toISOString() };
    }
  }
  return next;
}

// ── rendering ────────────────────────────────────────────────────────────

export function relativeAge(iso: string | undefined, now: Date): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / MINUTE_MS));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const TITLES: Record<string, string> = {
  waiting: "Waiting on you",
  changed: "Changed",
  mentions: "Mentions",
  comments: "Comments on your pages",
  openInline: "Open inline comments",
  myPagesEdited: "Your pages edited",
  watched: "Watched pages changed",
  recent: "Recently changed in space",
};

function changeLine(change: DigestChange, now: Date): string {
  const value = change.from === null ? `→ ${change.to ?? ""}` : `${change.from} → ${change.to ?? ""}`;
  return `${change.field}: ${value} by ${change.author}${change.you ? " (you)" : ""} · ${relativeAge(change.at, now)}`;
}

function isEmpty(d: DigestV1): boolean {
  const lists = [
    ...(d.jira ? [d.jira.waiting, d.jira.changed, d.jira.sprints] : []),
    ...(d.confluence ? Object.values(d.confluence) : []),
  ];
  return lists.every((list) => list.length === 0);
}

interface Block {
  heading: string;
  lines: Array<{ text: string; md: string; sub?: string[] }>;
}

function blocks(d: DigestV1, now: Date): Array<{ product: string; blocks: Block[] }> {
  const out: Array<{ product: string; blocks: Block[] }> = [];
  if (d.jira) {
    const b: Block[] = [];
    const issueLine = (i: DigestIssue, extra = "") => ({
      text: `${i.key}  [${i.status}]  ${i.summary}${extra}`,
      md: `[${i.key}](${i.url}) ${escapeMd(i.summary)} · *${i.status}*${extra}`,
    });
    if (d.jira.waiting.length) {
      b.push({ heading: `${TITLES.waiting} (${d.jira.waiting.length})`, lines: d.jira.waiting.map((i) => issueLine(i, i.priority ? ` · ${i.priority}` : "")) });
    }
    if (d.jira.changed.length) {
      b.push({
        heading: `${TITLES.changed} (${d.jira.changed.length})`,
        lines: d.jira.changed.map((i) => ({ ...issueLine(i, ` · ${i.roles.join(", ")}`), sub: i.changes.map((c) => changeLine(c, now)) })),
      });
    }
    for (const s of d.jira.sprints) {
      const left = s.daysLeft === null ? "" : ` — ${s.daysLeft} day(s) left`;
      const text = `${s.progress}  to do ${s.counts.todo} · in progress ${s.counts.wip} · done ${s.counts.done} · yours open ${s.yoursOpen}`;
      b.push({ heading: `Sprint ${s.name}${left}`, lines: [{ text, md: `\`${s.progress}\` to do ${s.counts.todo} · in progress ${s.counts.wip} · done ${s.counts.done} · yours open ${s.yoursOpen}` }] });
    }
    out.push({ product: "Jira", blocks: b });
  }
  if (d.confluence) {
    const b: Block[] = [];
    const pageLine = (p: DigestPage) => {
      const by = p.lastModifiedBy ? ` — ${p.lastModifiedBy}` : "";
      const meta = `${p.space ? ` (${p.space})` : ""}${by}${p.lastModified ? ` · ${relativeAge(p.lastModified, now)}` : ""}`;
      return { text: `${p.title}${meta}`, md: `${p.url ? `[${escapeMd(p.title)}](${p.url})` : escapeMd(p.title)}${escapeMd(meta)}` };
    };
    const commentLine = (c: DigestComment) => {
      const meta = `${c.author ?? "?"} on ${c.pageTitle ?? c.pageId ?? "?"} · ${relativeAge(c.created, now)}`;
      return { text: meta, md: c.url ? `[${escapeMd(meta)}](${c.url})` : escapeMd(meta) };
    };
    for (const section of ["mentions", "comments", "openInline", "myPagesEdited", "watched", "recent"] as const) {
      const list = d.confluence[section];
      if (!list.length) continue;
      b.push({
        heading: `${TITLES[section]} (${list.length})`,
        lines: section === "comments" || section === "openInline" ? (list as DigestComment[]).map(commentLine) : (list as DigestPage[]).map(pageLine),
      });
    }
    out.push({ product: "Confluence", blocks: b });
  }
  return out.filter((p) => p.blocks.length > 0);
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]|<>])/g, "\\$1");
}

function warningLines(d: DigestV1): string[] {
  const lines = d.warnings.map((w) => `${w.section}: ${w.message}`);
  if (d.truncated.length) lines.push(`truncated: ${d.truncated.join(", ")} (raise --limit)`);
  return lines;
}

export function renderDigestText(d: DigestV1, now: Date): string {
  const lines: string[] = [];
  if (d.summary) lines.push(d.summary.trim(), "");
  lines.push(`Digest since ${d.since.label}${d.me.displayName ? ` · ${d.me.displayName}` : ""}`);
  if (isEmpty(d)) {
    lines.push("", `Nothing new since ${d.since.label}.`);
  } else {
    for (const product of blocks(d, now)) {
      lines.push("", product.product);
      for (const block of product.blocks) {
        lines.push(`  ${block.heading}`);
        for (const line of block.lines) {
          lines.push(`    ${line.text}`);
          for (const sub of line.sub ?? []) lines.push(`      ${sub}`);
        }
      }
    }
  }
  const warnings = warningLines(d);
  if (warnings.length) lines.push("", "Warnings:", ...warnings.map((w) => `  - ${w}`));
  return lines.join("\n");
}

export function renderDigestMarkdown(d: DigestV1, now: Date): string {
  const lines: string[] = [];
  if (d.summary) lines.push(d.summary.trim(), "");
  lines.push(`# Digest since ${escapeMd(d.since.label)}`);
  if (isEmpty(d)) {
    lines.push("", `Nothing new since ${escapeMd(d.since.label)}.`);
  } else {
    for (const product of blocks(d, now)) {
      lines.push("", `## ${product.product}`);
      for (const block of product.blocks) {
        lines.push("", `### ${escapeMd(block.heading)}`, "");
        for (const line of block.lines) {
          lines.push(`- ${line.md}`);
          for (const sub of line.sub ?? []) lines.push(`  - ${escapeMd(sub)}`);
        }
      }
    }
  }
  const warnings = warningLines(d);
  if (warnings.length) lines.push("", "## Warnings", "", ...warnings.map((w) => `- ${escapeMd(w)}`));
  return `${lines.join("\n")}\n`;
}

/** Number of listed items, for the `--summarize` disclosure line. */
export function digestItemCount(d: DigestV1): number {
  return (
    (d.jira ? d.jira.waiting.length + d.jira.changed.length + d.jira.sprints.length : 0) +
    (d.confluence ? Object.values(d.confluence).reduce((n, list) => n + list.length, 0) : 0)
  );
}
