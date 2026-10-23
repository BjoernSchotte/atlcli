/**
 * The Jira area: navigator (queries, boards → sprints, filters, epics),
 * issue lists from JQL and the issue detail. Writes live in `jira-actions.ts`.
 */
import { parseArgs } from "@atlcli/core";
import { adfToMarkdown, jqlStatusNames, pageAgile, searchInputFromFlags, searchJql, stripOrderBy, type JiraIssue } from "@atlcli/jira";
import type { AreaModule } from "./commands.js";
import { expandNode, updateNav } from "./commands.js";
import type { Command, Ctx } from "./keymap.js";
import { jiraActions } from "./jira-actions.js";
import { pushOverlay, setChildren, withItems, type AppState, type JiraTab, type TreeNode } from "./state.js";

export const LIST_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "updated", "labels", "parent"];
const DETAIL_FIELDS = [
  "summary", "status", "issuetype", "priority", "assignee", "reporter", "labels", "components", "fixVersions",
  "parent", "duedate", "created", "updated", "description", "comment", "issuelinks", "subtasks",
];
const PAGE = 100;

/** "Not done": Jira's category, plus the statuses `flow.statusMap` counts as done. */
export function openClause(doneStatuses: string[] = []): string {
  const extra = doneStatuses.length ? ` AND status NOT IN (${doneStatuses.map((s) => JSON.stringify(s)).join(", ")})` : "";
  return `statusCategory != Done${extra}`;
}

export const mineJql = (done?: string[]) => `assignee = currentUser() AND ${openClause(done)} ORDER BY updated DESC`;
const TABS: JiraTab[] = ["details", "comments", "links", "history"];

/** Markdown for reading: round-trip ADF markers (`<!--adf:…-->`) show as `[…]`. */
export const readable = (markdown: string) => markdown.replace(/<!--adf:[\s\S]*?-->/g, "[…]");

/** Splits a filter-bar line like a shell would: quotes group words. */
export function splitWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

/** The filter bar: `--flag value …` as in `jira search`, otherwise raw JQL. */
export async function filterJql(ctx: Ctx, line: string): Promise<string> {
  const text = line.trim();
  if (!text.startsWith("--")) return text;
  const parsed = parseArgs(splitWords(text));
  return searchJql(ctx.opts.jira, searchInputFromFlags(parsed.flags, parsed._.join(" ") || undefined), ctx.opts.project);
}

/** `ORDER BY` replaced (or added). */
export function withOrder(jql: string, order: string): string {
  const where = stripOrderBy(jql);
  return `${where ? `${where} ` : ""}ORDER BY ${order}`;
}

let listSeq = 0;
let moreToken: string | undefined;

/** Loads a list; a newer load wins over an older one still in flight. */
export async function loadIssues(ctx: Ctx, title: string, jql: string): Promise<void> {
  const seq = ++listSeq;
  // A reload of the same list keeps the selection; another list starts at the top.
  const sameQuery = ctx.store.get().jira.list.query === jql;
  ctx.store.set((s) => ({ ...s, jira: { ...s.jira, list: { ...s.jira.list, title, query: jql, loading: true, error: undefined } } }));
  try {
    const result = await ctx.opts.jira.search(jql, { maxResults: PAGE, fields: LIST_FIELDS });
    if (seq !== listSeq) return;
    moreToken = result.nextPageToken;
    ctx.store.set((s) => {
      const base = sameQuery ? s.jira.list : { ...s.jira.list, items: [], selected: 0, marked: [] };
      return { ...s, jira: { ...s.jira, list: withItems(base, result.issues, (i) => i.key, Boolean(result.nextPageToken)) } };
    });
    jira.select(ctx);
  } catch (err) {
    if (seq !== listSeq) return;
    const error = err instanceof Error ? err.message : String(err);
    ctx.store.set((s) => ({ ...s, jira: { ...s.jira, list: { ...s.jira.list, loading: false, error, items: [] } } }));
  }
}

async function loadMore(ctx: Ctx): Promise<void> {
  const { list } = ctx.store.get().jira;
  if (!list.hasMore || !moreToken || list.loading) return;
  const seq = listSeq;
  await ctx.task("Loading more…", async () => {
    const result = await ctx.opts.jira.search(list.query, { maxResults: PAGE, fields: LIST_FIELDS, nextPageToken: moreToken });
    if (seq !== listSeq) return;
    moreToken = result.nextPageToken;
    ctx.store.set((s) => ({
      ...s,
      jira: { ...s.jira, list: withItems(s.jira.list, [...s.jira.list.items, ...result.issues], (i) => i.key, Boolean(result.nextPageToken)) },
    }));
  });
}

const detailRequests = new Map<string, Promise<void>>();

/** Loads (or reloads) an issue's detail. */
export function loadDetail(ctx: Ctx, key: string, force = false): Promise<void> {
  const known = ctx.store.get().jira.details[key];
  if (!force && known && known.status !== "error") return detailRequests.get(key) ?? Promise.resolve();
  if (!known) ctx.store.set((s) => ({ ...s, jira: { ...s.jira, details: { ...s.jira.details, [key]: { status: "loading" } } } }));
  const request = ctx.opts.jira
    .getIssue(key, { fields: DETAIL_FIELDS, expand: "changelog" })
    .then(
      (issue) => {
        const description = readable(adfToMarkdown(issue.fields.description, { baseUrl: ctx.opts.siteUrl })).trim();
        setDetail(ctx, key, { status: "ok", value: { issue, description } });
        // Keep the list row in step with what the detail shows (status, assignee after a write).
        ctx.store.set((s) => ({
          ...s,
          jira: { ...s.jira, list: { ...s.jira.list, items: s.jira.list.items.map((i) => (i.key === key ? { ...i, fields: { ...i.fields, ...pick(issue, LIST_FIELDS) } } : i)) } },
        }));
      },
      (err) => setDetail(ctx, key, { status: "error", error: err instanceof Error ? err.message : String(err) })
    )
    .finally(() => detailRequests.delete(key));
  detailRequests.set(key, request);
  return request;
}

function pick(issue: JiraIssue, fields: string[]): Partial<JiraIssue["fields"]> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = (issue.fields as unknown as Record<string, unknown>)[f];
  return out as Partial<JiraIssue["fields"]>;
}

function setDetail(ctx: Ctx, key: string, detail: AppState["jira"]["details"][string]): void {
  ctx.store.set((s) => ({ ...s, jira: { ...s.jira, details: { ...s.jira.details, [key]: detail } } }));
}

export function selectedIssue(state: AppState): JiraIssue | undefined {
  return state.jira.list.items[state.jira.list.selected];
}

/** The marked issues, or the selected one when none is marked. */
export function targetIssues(state: AppState): JiraIssue[] {
  const { items, marked } = state.jira.list;
  if (marked.length > 0) return items.filter((i) => marked.includes(i.key));
  const one = selectedIssue(state);
  return one ? [one] : [];
}

const query = (id: string, label: string, jql: string): Omit<TreeNode, "depth" | "parent"> => ({ id, label, kind: "query", expandable: false, data: { jql } });

const tabCommand = (by: 1 | -1): Command["run"] => (ctx) =>
  ctx.store.set((s) => ({ ...s, jira: { ...s.jira, tab: TABS[(TABS.indexOf(s.jira.tab) + by + TABS.length) % TABS.length]! } }));

const readCommands: Command[] = [
  {
    id: "jira.filter",
    title: "Filter: search flags (--assignee me --status ~Done) or JQL",
    keys: ["/"],
    area: "jira",
    bar: "filter",
    run: (ctx) =>
      ctx.store.set((s) =>
        pushOverlay(s, {
          kind: "prompt",
          title: "Filter (search flags or JQL)",
          value: s.jira.list.query,
          placeholder: "--assignee me --status ~Done   or   project = ABC ORDER BY updated DESC",
          onSubmit: async (line) => {
            if (!line.trim()) return;
            const jql = await ctx.task("Building the query…", () => filterJql(ctx, line));
            if (jql) await loadIssues(ctx, "Search", jql);
          },
        })
      ),
  },
  {
    id: "jira.sort",
    title: "Sort the list",
    keys: ["o"],
    area: "jira",
    focus: ["list", "detail"],
    run: (ctx) =>
      ctx.store.set((s) =>
        pushOverlay(s, {
          kind: "picker",
          title: "Sort by",
          items: [
            ["updated DESC", "Updated, newest first"],
            ["updated ASC", "Updated, oldest first"],
            ["created DESC", "Created, newest first"],
            ["created ASC", "Created, oldest first"],
            ["priority DESC", "Priority, highest first"],
            ["status ASC", "Status"],
            ["duedate ASC", "Due date, soonest first"],
            ["key ASC", "Key"],
            ["rank ASC", "Rank (board order)"],
          ].map(([id, label]) => ({ id: id!, label: label! })),
          query: "",
          selected: 0,
          multi: false,
          marked: [],
          allowFree: false,
          onSubmit: ([order]) => loadIssues(ctx, ctx.store.get().jira.list.title, withOrder(ctx.store.get().jira.list.query, order!)),
        })
      ),
  },
  { id: "jira.more", title: "Load more issues", keys: ["+"], area: "jira", focus: ["list"], enabled: (s) => Boolean(s.jira.list.hasMore), run: loadMore },
  { id: "jira.tab.next", title: "Next detail tab", keys: ["."], area: "jira", run: tabCommand(1) },
  { id: "jira.tab.prev", title: "Previous detail tab", keys: [","], area: "jira", run: tabCommand(-1) },
  ...TABS.map(
    (tab): Command => ({
      id: `jira.tab.${tab}`,
      title: `Show ${tab}`,
      keys: [],
      area: "jira",
      run: (ctx) => ctx.store.set((s) => ({ ...s, jira: { ...s.jira, tab } })),
    })
  ),
  {
    id: "jira.related",
    title: "List linked issues, parent and subtasks",
    keys: ["return"],
    area: "jira",
    focus: ["detail"],
    enabled: (s) => s.jira.tab === "links",
    run: async (ctx) => {
      const issue = selectedIssue(ctx.store.get());
      if (!issue) return;
      const parent = issue.fields.parent?.key;
      const jql = `issue in linkedIssues("${issue.key}") OR parent = "${issue.key}"${parent ? ` OR key = "${parent}"` : ""} ORDER BY updated DESC`;
      ctx.store.set((s) => ({ ...s, focus: "list" }));
      await loadIssues(ctx, `Related to ${issue.key}`, jql);
    },
  },
];

export const jira: AreaModule = {
  id: "jira",
  label: "Jira",
  commands: [...readCommands, ...jiraActions],

  async init(ctx) {
    const { project, board, jql } = ctx.opts;
    // JQL matches untranslated status names ("Done"), the config holds what Jira shows ("Fertig").
    if (ctx.opts.doneStatuses?.length) {
      const statuses = await ctx.task("Loading statuses…", () => ctx.opts.jira.getStatuses());
      const done = statuses ? jqlStatusNames(ctx.opts.doneStatuses.join(","), statuses).split(",") : ctx.opts.doneStatuses;
      ctx.store.set((s) => ({ ...s, jira: { ...s.jira, done } }));
    }
    const doneStatuses = ctx.store.get().jira.done;
    const roots = [
      query("q:mine", "My open issues", mineJql(doneStatuses)),
      query("q:watching", "Watching", `watcher = currentUser() AND ${openClause(doneStatuses)} ORDER BY updated DESC`),
      query("q:recent", "Recently viewed", "issuekey IN issueHistory() ORDER BY lastViewed DESC"),
      { id: "g:boards", label: project ? `Boards (${project})` : "Boards", kind: "group", expandable: true },
      ...(project ? [{ id: "g:epics", label: `Epics (${project})`, kind: "group", expandable: true }] : []),
      { id: "g:filters", label: "Favourite filters", kind: "group", expandable: true },
    ];
    updateNav(ctx, (t) => setChildren(t, undefined, roots));
    const list = jql ? loadIssues(ctx, "Search", jql) : loadIssues(ctx, "My open issues", mineJql(doneStatuses));
    if (board !== undefined) {
      const boards = ctx.store.get().jira.nav.nodes["g:boards"]!;
      await expandNode(ctx, jira, boards);
      updateNav(ctx, (t) => (t.nodes[`b:${board}`] ? { ...t, selected: `b:${board}` } : t));
    }
    await list;
  },

  async expand(ctx, node) {
    updateNav(ctx, (t) => ({ ...t, nodes: { ...t.nodes, [node.id]: { ...node, loading: true } } }));
    const children = await ctx.task(`Loading ${node.label}…`, () => childrenOf(ctx, node));
    updateNav(ctx, (t) => setChildren(t, node.id, children ?? []));
  },

  async open(ctx, node) {
    const data = node.data ?? {};
    if (typeof data.jql === "string") {
      ctx.store.set((s) => ({ ...s, focus: "list" }));
      await loadIssues(ctx, node.label, data.jql);
      return;
    }
    if (node.kind === "board") {
      const where = stripOrderBy((await ctx.task("Loading the board…", () => ctx.opts.jira.getBoardFilterJql(Number(data.boardId)))) ?? "");
      if (!where) return;
      ctx.store.set((s) => ({ ...s, focus: "list" }));
      await loadIssues(ctx, node.label, `(${where}) AND ${openClause(ctx.store.get().jira.done)} ORDER BY rank ASC`);
    }
  },

  select(ctx) {
    const issue = selectedIssue(ctx.store.get());
    if (issue) void loadDetail(ctx, issue.key);
  },

  async refresh(ctx) {
    const s = ctx.store.get();
    const issue = selectedIssue(s);
    if (issue) ctx.store.set((st) => ({ ...st, jira: { ...st.jira, details: {} } }));
    await loadIssues(ctx, s.jira.list.title, s.jira.list.query);
  },

  itemId: (s, i) => s.jira.list.items[i]?.key,
  url: (ctx) => {
    const issue = selectedIssue(ctx.store.get());
    return issue ? `${ctx.opts.siteUrl}/browse/${issue.key}` : undefined;
  },
};

async function childrenOf(ctx: Ctx, node: TreeNode): Promise<Omit<TreeNode, "depth" | "parent">[]> {
  const client = ctx.opts.jira;
  if (node.id === "g:boards") {
    const { values } = await pageAgile((startAt, maxResults) => client.listBoards({ startAt, maxResults, projectKeyOrId: ctx.opts.project }), 500);
    return values.map((b) => ({ id: `b:${b.id}`, label: `${b.name} (${b.type})`, kind: "board", expandable: b.type === "scrum", data: { boardId: b.id } }));
  }
  if (node.id === "g:filters") {
    const filters = await client.getFavouriteFilters();
    return filters.map((f) => query(`f:${f.id}`, f.name, f.jql ?? `filter = ${f.id}`));
  }
  if (node.id === "g:epics") {
    const result = await client.search(`project = "${ctx.opts.project}" AND issuetype = Epic AND ${openClause(ctx.store.get().jira.done)} ORDER BY updated DESC`, {
      maxResults: 100,
      fields: ["summary"],
    });
    return result.issues.map((e) => query(`e:${e.key}`, `${e.key} ${e.fields.summary ?? ""}`, `parent = "${e.key}" ORDER BY rank ASC`));
  }
  if (node.kind === "board") {
    const boardId = Number(node.data?.boardId);
    const [active, future] = await Promise.all([
      client.listSprints(boardId, { state: "active" }),
      client.listSprints(boardId, { state: "future" }),
    ]);
    const where = stripOrderBy(await client.getBoardFilterJql(boardId));
    return [
      ...active.values.map((sp) => query(`s:${sp.id}`, `● ${sp.name}`, `sprint = ${sp.id} ORDER BY rank ASC`)),
      ...future.values.map((sp) => query(`s:${sp.id}`, `○ ${sp.name}`, `sprint = ${sp.id} ORDER BY rank ASC`)),
      query(`bl:${boardId}`, "Backlog", `(${where}) AND (sprint IS EMPTY OR sprint IN closedSprints()) AND ${openClause(ctx.store.get().jira.done)} ORDER BY rank ASC`),
    ];
  }
  return [];
}
