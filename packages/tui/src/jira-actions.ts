/**
 * Jira writes. Each one shows what it will change and asks first; bulk
 * changes over `BULK_CONFIRM` issues need a second `y`. Afterwards the
 * touched issues reload, and a toast reports the result.
 */
import {
  adfToMarkdown,
  findTransition,
  toJiraRichText,
  type AdfDocument,
  type JiraClient,
  type JiraIssue,
  type JiraUser,
} from "@atlcli/jira";
import type { Command, Ctx } from "./keymap.js";
import { LIST_FIELDS, loadDetail, selectedIssue, targetIssues } from "./jira.js";
import { pushOverlay, withItems, type Overlay, type PickerItem } from "./state.js";

export const BULK_CONFIRM = 5;

const open = (ctx: Ctx, overlay: Overlay) => ctx.store.set((s) => pushOverlay(s, overlay));

function picker(ctx: Ctx, title: string, items: PickerItem[], onSubmit: (ids: string[], free?: string) => void | Promise<void>, extra: Partial<Extract<Overlay, { kind: "picker" }>> = {}) {
  open(ctx, { kind: "picker", title, items, query: "", selected: 0, multi: false, marked: [], allowFree: false, onSubmit, ...extra });
}

function prompt(ctx: Ctx, title: string, value: string, onSubmit: (value: string) => void | Promise<void>, placeholder = "") {
  open(ctx, { kind: "prompt", title, value, placeholder, onSubmit });
}

/** Asks, then runs `apply` with a busy indicator; reloads `keys` afterwards. */
export function confirmWrite(ctx: Ctx, title: string, lines: string[], keys: string[], apply: () => Promise<string>): void {
  open(ctx, {
    kind: "confirm",
    title,
    lines,
    double: lines.length > BULK_CONFIRM,
    step: 0,
    onConfirm: async () => {
      const done = await ctx.task("Saving…", apply);
      await Promise.all(keys.map((key) => loadDetail(ctx, key, true)));
      if (done) ctx.toast("success", done);
    },
  });
}

/** Markdown → Jira rich text; conversion notes become a toast. */
function richText(ctx: Ctx, markdown: string): AdfDocument | string {
  const notes: string[] = [];
  const body = toJiraRichText(ctx.opts.jira, markdown, { onWarning: (m) => notes.push(m) });
  if (notes.length) ctx.toast("info", notes.join(" "));
  return body;
}

/** Runs `work` per issue, collecting failures; the toast names them. */
async function each(issues: JiraIssue[], work: (issue: JiraIssue) => Promise<void>): Promise<string> {
  const failed: string[] = [];
  for (const issue of issues) {
    try {
      await work(issue);
    } catch (err) {
      failed.push(`${issue.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed.length) throw new Error(`${issues.length - failed.length} of ${issues.length} done. ${failed.join(" · ")}`);
  return issues.length === 1 ? `${issues[0]!.key} updated` : `${issues.length} issues updated`;
}

const list = (issues: JiraIssue[], what: (i: JiraIssue) => string) => issues.map((i) => `${i.key}  ${what(i)}`);

// ============ Transition ============

async function transition(ctx: Ctx): Promise<void> {
  const issues = targetIssues(ctx.store.get());
  if (issues.length === 0) return;
  const transitions = await ctx.task("Loading transitions…", () => ctx.opts.jira.getTransitions(issues[0]!.key));
  if (!transitions) return;
  picker(
    ctx,
    issues.length === 1 ? `Transition ${issues[0]!.key}` : `Transition ${issues.length} issues`,
    transitions.map((t) => ({ id: t.id, label: t.name, hint: t.to?.name && t.to.name !== t.name ? `→ ${t.to.name}` : undefined })),
    ([id]) => {
      const chosen = transitions.find((t) => t.id === id)!;
      confirmWrite(
        ctx,
        `Transition to "${chosen.name}"?`,
        list(issues, (i) => `${i.fields.status?.name ?? "?"} → ${chosen.to?.name ?? chosen.name}`),
        issues.map((i) => i.key),
        () =>
          each(issues, async (issue) => {
            // Other issues may have other workflows: match by name there.
            const own = issue.key === issues[0]!.key ? chosen : findTransition(await ctx.opts.jira.getTransitions(issue.key), chosen.name);
            if (!own) throw new Error(`no transition "${chosen.name}"`);
            await ctx.opts.jira.transitionIssue(issue.key, { transition: { id: own.id } });
          })
      );
    }
  );
}

// ============ Assign ============

const userItem = (u: JiraUser): PickerItem => ({
  id: u.accountId ? `acc:${u.accountId}` : `name:${u.name}`,
  label: u.displayName,
  hint: u.emailAddress,
});

const fixedUsers: PickerItem[] = [
  { id: "me", label: "me", hint: "assign to yourself" },
  { id: "none", label: "unassigned", hint: "remove the assignee" },
];

export async function searchUserItems(client: JiraClient, query: string): Promise<PickerItem[]> {
  const q = query.trim();
  const matchesFixed = fixedUsers.filter((f) => !q || f.label.startsWith(q.toLowerCase()));
  if (!q) return fixedUsers;
  const users = await client.searchUsers(q);
  return [...matchesFixed, ...users.filter((u) => u.active !== false && (u as { accountType?: string }).accountType !== "app").map(userItem)];
}

function assign(ctx: Ctx): void {
  const issues = targetIssues(ctx.store.get());
  if (issues.length === 0) return;
  picker(
    ctx,
    issues.length === 1 ? `Assign ${issues[0]!.key}` : `Assign ${issues.length} issues`,
    fixedUsers,
    async ([id]) => {
      const client = ctx.opts.jira;
      let ref: { accountId: string } | { name: string } | null;
      let name: string;
      if (id === "none") {
        ref = null;
        name = "unassigned";
      } else if (id === "me") {
        const me = await ctx.task("Loading your user…", () => client.getCurrentUser());
        if (!me) return;
        ref = client.isCloudSite ? { accountId: me.accountId! } : { name: me.name! };
        name = me.displayName;
      } else {
        ref = id!.startsWith("acc:") ? { accountId: id!.slice(4) } : { name: id!.slice(5) };
        name = lastPicked.get(id!) ?? id!;
      }
      confirmWrite(
        ctx,
        `Assign to ${name}?`,
        list(issues, (i) => `${i.fields.assignee?.displayName ?? "unassigned"} → ${name}`),
        issues.map((i) => i.key),
        () => each(issues, (issue) => client.assignIssue(issue.key, ref))
      );
    },
    {
      search: async (q) => {
        const items = await searchUserItems(ctx.opts.jira, q);
        for (const item of items) lastPicked.set(item.id, item.label);
        return items;
      },
    }
  );
}

/** Display names of picked users, by item id (the picker returns ids). */
const lastPicked = new Map<string, string>();

// ============ Comment ============

function comment(ctx: Ctx): void {
  const issue = selectedIssue(ctx.store.get());
  if (!issue) return;
  open(ctx, {
    kind: "compose",
    title: `Comment on ${issue.key}`,
    value: "",
    preview: false,
    onSubmit: (text) =>
      confirmWrite(ctx, `Add this comment to ${issue.key}?`, text.split("\n").slice(0, 12), [issue.key], async () => {
        await ctx.opts.jira.addComment(issue.key, richText(ctx, text));
        ctx.store.set((s) => ({ ...s, jira: { ...s.jira, tab: "comments" } }));
        return `Comment added to ${issue.key}`;
      }),
  });
}

// ============ Edit ============

async function edit(ctx: Ctx): Promise<void> {
  const issue = selectedIssue(ctx.store.get());
  if (!issue) return;
  const client = ctx.opts.jira;
  const current = await ctx.task("Loading…", () => client.getIssue(issue.key, { fields: ["summary", "description"] }));
  if (!current) return;
  // Raw markdown keeps the round-trip markers (`<!--adf:…-->`), so unsupported content survives the edit.
  const before = adfToMarkdown(current.fields.description, { baseUrl: ctx.opts.siteUrl });
  prompt(ctx, `Summary of ${issue.key}`, current.fields.summary ?? "", async (summary) => {
    if (!summary.trim()) return ctx.toast("error", "The summary cannot be empty.");
    const after = await ctx.suspend(() => ctx.opts.editText(before, `${issue.key}.md`));
    const summaryChanged = summary.trim() !== (current.fields.summary ?? "");
    if (!summaryChanged && after === before) return ctx.toast("info", "No changes.");
    open(ctx, {
      kind: "diff",
      title: `Save ${issue.key}?`,
      before: `# ${current.fields.summary ?? ""}\n\n${before}`,
      after: `# ${summary.trim()}\n\n${after}`,
      onConfirm: async () => {
        const fields: Record<string, unknown> = {};
        if (summaryChanged) fields.summary = summary.trim();
        if (after !== before) fields.description = richText(ctx, after);
        const done = await ctx.task("Saving…", async () => {
          await client.updateIssue(issue.key, { fields });
          return `${issue.key} saved`;
        });
        await loadDetail(ctx, issue.key, true);
        if (done) ctx.toast("success", done);
      },
    });
  });
}

// ============ Labels ============

function labels(ctx: Ctx): void {
  const state = ctx.store.get();
  const issues = targetIssues(state);
  if (issues.length === 0) return;
  const single = issues.length === 1;
  const own = single ? (issues[0]!.fields.labels ?? []) : [];
  const known = [...new Set([...own, ...state.jira.list.items.flatMap((i) => i.fields.labels ?? [])])].sort();
  picker(
    ctx,
    single ? `Labels of ${issues[0]!.key} (tab toggles, enter applies)` : `Add labels to ${issues.length} issues`,
    known.map((l) => ({ id: l, label: l })),
    (ids, free) => {
      const wanted = [...new Set([...ids, ...(free ? free.split(/[\s,]+/).filter(Boolean) : [])])];
      if (single) {
        const add = wanted.filter((l) => !own.includes(l));
        const remove = own.filter((l) => !wanted.includes(l));
        if (add.length + remove.length === 0) return ctx.toast("info", "No changes.");
        confirmWrite(
          ctx,
          `Change the labels of ${issues[0]!.key}?`,
          [...add.map((l) => `+ ${l}`), ...remove.map((l) => `- ${l}`)],
          [issues[0]!.key],
          async () => {
            if (add.length) await ctx.opts.jira.addLabels(issues[0]!.key, add);
            if (remove.length) await ctx.opts.jira.removeLabels(issues[0]!.key, remove);
            return `${issues[0]!.key}: labels updated`;
          }
        );
      } else {
        if (wanted.length === 0) return;
        confirmWrite(
          ctx,
          `Add ${wanted.join(", ")}?`,
          list(issues, () => `+ ${wanted.join(", ")}`),
          issues.map((i) => i.key),
          () => each(issues, (issue) => ctx.opts.jira.addLabels(issue.key, wanted))
        );
      }
    },
    { multi: true, marked: own, allowFree: true }
  );
}

// ============ Sprint ============

/** The board for sprint moves: the navigator's board, the configured one, or the project's first scrum board. */
async function sprintBoard(ctx: Ctx, issue: JiraIssue): Promise<number | undefined> {
  const nav = ctx.store.get().jira.nav;
  let node = nav.selected ? nav.nodes[nav.selected] : undefined;
  while (node && node.kind !== "board") node = node.parent ? nav.nodes[node.parent] : undefined;
  if (node?.data?.boardId !== undefined) return Number(node.data.boardId);
  if (ctx.opts.board !== undefined) return ctx.opts.board;
  const project = issue.key.split("-")[0]!;
  const { values } = await ctx.opts.jira.listBoards({ projectKeyOrId: project, type: "scrum", maxResults: 1 });
  return values[0]?.id;
}

async function sprint(ctx: Ctx): Promise<void> {
  const issues = targetIssues(ctx.store.get());
  if (issues.length === 0) return;
  const client = ctx.opts.jira;
  const sprints = await ctx.task("Loading sprints…", async () => {
    const board = await sprintBoard(ctx, issues[0]!);
    if (board === undefined) throw new Error(`No scrum board found for ${issues[0]!.key.split("-")[0]}.`);
    const [active, future] = await Promise.all([client.listSprints(board, { state: "active" }), client.listSprints(board, { state: "future" })]);
    return [...active.values, ...future.values];
  });
  if (!sprints) return;
  picker(
    ctx,
    issues.length === 1 ? `Move ${issues[0]!.key} to a sprint` : `Move ${issues.length} issues to a sprint`,
    [...sprints.map((sp) => ({ id: String(sp.id), label: sp.name, hint: sp.state })), { id: "backlog", label: "Backlog", hint: "out of any sprint" }],
    ([id]) => {
      const name = id === "backlog" ? "the backlog" : sprints.find((sp) => String(sp.id) === id)!.name;
      const keys = issues.map((i) => i.key);
      confirmWrite(ctx, `Move to ${name}?`, list(issues, () => `→ ${name}`), keys, async () => {
        if (id === "backlog") await client.moveIssuesToBacklog(keys);
        else await client.moveIssuesToSprint(Number(id), keys);
        return `${keys.length === 1 ? keys[0] : `${keys.length} issues`} moved to ${name}`;
      });
    }
  );
}

// ============ Parent / epic ============

export function epicSearchJql(project: string, query: string): string {
  const q = query.trim();
  const byText = q ? ` AND (summary ~ ${JSON.stringify(`${q.replace(/["\\]/g, "")}*`)}${/^[A-Z][A-Z0-9_]*-\d+$/i.test(q) ? ` OR key = ${JSON.stringify(q.toUpperCase())}` : ""})` : "";
  return `project = ${JSON.stringify(project)} AND issuetype = Epic${byText} ORDER BY updated DESC`;
}

function parent(ctx: Ctx): void {
  const issues = targetIssues(ctx.store.get());
  if (issues.length === 0) return;
  const project = issues[0]!.key.split("-")[0]!;
  const none: PickerItem = { id: "none", label: "(no parent)", hint: "remove the parent" };
  const names = new Map<string, string>();
  picker(
    ctx,
    `Parent (epic) for ${issues.length === 1 ? issues[0]!.key : `${issues.length} issues`}`,
    [none],
    ([id]) => {
      const label = id === "none" ? "no parent" : `${id} ${names.get(id!) ?? ""}`.trim();
      confirmWrite(
        ctx,
        `Set the parent to ${label}?`,
        list(issues, (i) => `${i.fields.parent?.key ?? "none"} → ${id === "none" ? "none" : id}`),
        issues.map((i) => i.key),
        () =>
          each(issues, (issue) =>
            id === "none"
              ? ctx.opts.jira.updateIssue(issue.key, { update: { parent: [{ set: { none: true } }] } })
              : ctx.opts.jira.updateIssue(issue.key, { fields: { parent: { key: id! } } })
          )
      );
    },
    {
      search: async (q) => {
        const found = await ctx.opts.jira.search(epicSearchJql(project, q), { maxResults: 30, fields: ["summary", "status"] });
        for (const e of found.issues) names.set(e.key, e.fields.summary ?? "");
        return [none, ...found.issues.map((e) => ({ id: e.key, label: `${e.key}  ${e.fields.summary ?? ""}`, hint: e.fields.status?.name }))];
      },
    }
  );
}

// ============ Create / clone ============

/** Puts a new issue at the top of the list and selects it. */
async function showNew(ctx: Ctx, key: string): Promise<void> {
  const issue = await ctx.opts.jira.getIssue(key, { fields: LIST_FIELDS });
  ctx.store.set((s) => ({
    ...s,
    focus: "list",
    jira: { ...s.jira, list: { ...withItems(s.jira.list, [issue, ...s.jira.list.items.filter((i) => i.key !== key)], (i) => i.key, s.jira.list.hasMore), selected: 0 } },
  }));
  await loadDetail(ctx, key, true);
}

async function create(ctx: Ctx): Promise<void> {
  const client = ctx.opts.jira;
  const projects = await ctx.task("Loading projects…", () => client.listProjects({ maxResults: 100, orderBy: "key" }));
  if (!projects) return;
  const current = selectedIssue(ctx.store.get())?.key.split("-")[0];
  const preferred = ctx.opts.project ?? current;
  const items = projects.values
    .map((p) => ({ id: p.key, label: `${p.key}  ${p.name}` }))
    .sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0));
  picker(ctx, "New issue: project", items, async ([project]) => {
    const types = await ctx.task("Loading issue types…", () => client.getProjectIssueTypes(project!));
    if (!types) return;
    picker(ctx, `New ${project} issue: type`, types.filter((t) => !t.subtask).map((t) => ({ id: t.name, label: t.name })), ([type]) =>
      prompt(ctx, `New ${project} ${type}: summary`, "", async (summary) => {
        if (!summary.trim()) return ctx.toast("error", "The summary cannot be empty.");
        const description = (await ctx.suspend(() => ctx.opts.editText("", `${project}-new.md`))).trim();
        confirmWrite(
          ctx,
          `Create this ${type} in ${project}?`,
          [summary.trim(), ...(description ? ["", ...description.split("\n").slice(0, 10)] : ["(no description)"])],
          [],
          async () => {
            const created = await client.createIssue({
              fields: { project: { key: project! }, issuetype: { name: type! }, summary: summary.trim(), description: description ? richText(ctx, description) : undefined },
            });
            await showNew(ctx, created.key);
            return `${created.key} created`;
          }
        );
      })
    );
  });
}

async function clone(ctx: Ctx): Promise<void> {
  const issue = selectedIssue(ctx.store.get());
  if (!issue) return;
  const client = ctx.opts.jira;
  const source = await ctx.task("Loading…", () =>
    client.getIssue(issue.key, { fields: ["project", "summary", "description", "issuetype", "labels", "components", "parent"] })
  );
  if (!source) return;
  const f = source.fields;
  prompt(ctx, `Clone ${issue.key}: summary`, f.summary ?? "", (summary) => {
    if (!summary.trim()) return ctx.toast("error", "The summary cannot be empty.");
    confirmWrite(ctx, `Clone ${issue.key}?`, [summary.trim(), `${f.issuetype?.name ?? ""} in ${f.project.key}, linked as "clones ${issue.key}"`], [issue.key], async () => {
      const created = await client.createIssue({
        fields: {
          project: { key: f.project.key },
          issuetype: { name: f.issuetype!.name },
          summary: summary.trim(),
          description: f.description ?? undefined,
          labels: f.labels,
          components: f.components?.length ? f.components.map((c) => ({ id: c.id })) : undefined,
          parent: f.parent ? { key: f.parent.key } : undefined,
        },
      });
      let note = "";
      try {
        await client.createIssueLink({ type: { name: "Cloners" }, inwardIssue: { key: created.key }, outwardIssue: { key: issue.key } });
      } catch (err) {
        note = ` (not linked: ${err instanceof Error ? err.message : String(err)})`;
      }
      await showNew(ctx, created.key);
      return `${created.key} cloned from ${issue.key}${note}`;
    });
  });
}

const onIssue = ["list", "detail"] as Command["focus"];

export const jiraActions: Command[] = [
  { id: "jira.transition", title: "Transition (change status)", keys: ["t"], area: "jira", focus: onIssue, bar: "status", run: transition },
  { id: "jira.assign", title: "Assign", keys: ["a"], area: "jira", focus: onIssue, bar: "assign", run: assign },
  { id: "jira.comment", title: "Comment", keys: ["c"], area: "jira", focus: onIssue, bar: "comment", run: comment },
  { id: "jira.edit", title: "Edit summary and description ($EDITOR)", keys: ["e"], area: "jira", focus: onIssue, bar: "edit", run: edit },
  { id: "jira.labels", title: "Labels", keys: ["L"], area: "jira", focus: onIssue, bar: "labels", run: labels },
  { id: "jira.sprint", title: "Move to a sprint or the backlog", keys: ["s"], area: "jira", focus: onIssue, bar: "sprint", run: sprint },
  { id: "jira.parent", title: "Set the parent (epic)", keys: ["p"], area: "jira", focus: onIssue, run: parent },
  { id: "jira.create", title: "New issue", keys: ["n"], area: "jira", bar: "new", run: create },
  { id: "jira.clone", title: "Clone the issue", keys: ["N"], area: "jira", focus: onIssue, run: clone },
];
