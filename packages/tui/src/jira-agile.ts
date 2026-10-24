/**
 * Agile writes: boards and sprints from the navigator, rank from the list.
 * Like every write, each one shows what it changes and asks first.
 */
import type { JiraIssue } from "@atlcli/jira";
import { expandNode, updateNav } from "./commands.js";
import { confirmWrite } from "./jira-actions.js";
import { jira, targetIssues } from "./jira.js";
import type { Command, Ctx } from "./keymap.js";
import { pushOverlay, withItems, type AppState, type TreeNode } from "./state.js";

const open = (ctx: Ctx, overlay: Parameters<typeof pushOverlay>[1]) => ctx.store.set((s) => pushOverlay(s, overlay));

/** The board a navigator node belongs to (the board itself, or one of its sprints / its backlog). */
export function boardNode(state: AppState): TreeNode | undefined {
  const nav = state.jira.nav;
  let node = nav.selected ? nav.nodes[nav.selected] : undefined;
  while (node && node.kind !== "board") node = node.parent ? nav.nodes[node.parent] : undefined;
  return node;
}

const onNav = (state: AppState) => (state.jira.nav.selected ? state.jira.nav.nodes[state.jira.nav.selected] : undefined);
const isScrum = (state: AppState) => boardNode(state)?.data?.type === "scrum";

/** Reloads a navigator node's children and keeps it open. */
async function reload(ctx: Ctx, id: string): Promise<void> {
  const node = ctx.store.get().jira.nav.nodes[id];
  if (!node) return;
  await jira.expand(ctx, node);
  await expandNode(ctx, jira, ctx.store.get().jira.nav.nodes[id]!);
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// ============ Boards ============

function newBoard(ctx: Ctx): void {
  const project = ctx.opts.project;
  open(ctx, {
    kind: "prompt",
    title: "New board: name",
    value: "",
    placeholder: project ? `Board on project ${project}` : "",
    onSubmit: (name) => {
      if (!name.trim()) return ctx.toast("error", "The name cannot be empty.");
      open(ctx, {
        kind: "picker",
        title: `New board "${name.trim()}": type`,
        items: [
          { id: "scrum", label: "Scrum", hint: "sprints and a backlog" },
          { id: "kanban", label: "Kanban", hint: "a continuous flow" },
        ],
        query: "",
        selected: 0,
        multi: false,
        marked: [],
        allowFree: false,
        onSubmit: ([type]) => {
          const askProject = (then: (key: string) => void) =>
            project
              ? then(project)
              : open(ctx, { kind: "prompt", title: "Project key for the board", value: "", placeholder: "ABC", onSubmit: (key) => (key.trim() ? then(key.trim().toUpperCase()) : undefined) });
          askProject((key) =>
            confirmWrite(
              ctx,
              `Create this ${type} board?`,
              [name.trim(), `In ${key}, on a new filter "project = ${key} ORDER BY Rank ASC" shared with the project`],
              [],
              async () => {
                const board = await ctx.opts.jira.createBoard({ name: name.trim(), type: type as "scrum" | "kanban", projectKeyOrId: key });
                await reload(ctx, "g:boards");
                updateNav(ctx, (t) => (t.nodes[`b:${board.id}`] ? { ...t, selected: `b:${board.id}` } : t));
                return `Board "${board.name}" created`;
              }
            )
          );
        },
      });
    },
  });
}

function deleteBoard(ctx: Ctx, node: TreeNode): void {
  const id = Number(node.data?.boardId);
  open(ctx, {
    kind: "picker",
    title: `Delete the board ${node.label}?`,
    items: [
      { id: "board", label: "Delete the board", hint: "its filter and issues stay" },
      { id: "filter", label: "Delete the board and its filter", hint: "issues stay" },
    ],
    query: "",
    selected: 0,
    multi: false,
    marked: [],
    allowFree: false,
    onSubmit: ([what]) =>
      open(ctx, {
        kind: "confirm",
        title: `Delete ${node.label}${what === "filter" ? " and its filter" : ""}?`,
        lines: ["Sprints on this board go with it. Issues are not touched.", "This cannot be undone."],
        double: true,
        step: 0,
        onConfirm: async () => {
          const done = await ctx.task("Deleting…", async () => {
            const filterId = what === "filter" ? await ctx.opts.jira.getBoardFilterId(id) : undefined;
            await ctx.opts.jira.deleteBoard(id);
            if (filterId) await ctx.opts.jira.deleteFilter(filterId);
            return `Board ${node.label} deleted`;
          });
          if (!done) return;
          updateNav(ctx, (t) => ({ ...t, selected: "g:boards" }));
          await reload(ctx, "g:boards");
          ctx.toast("success", done);
        },
      }),
  });
}

// ============ Sprints ============

function newSprint(ctx: Ctx): void {
  const board = boardNode(ctx.store.get())!;
  open(ctx, {
    kind: "prompt",
    title: `New sprint on ${board.label}: name`,
    value: "",
    placeholder: "Sprint 12",
    onSubmit: (name) => {
      if (!name.trim()) return ctx.toast("error", "The name cannot be empty.");
      confirmWrite(ctx, `Create the sprint "${name.trim()}"?`, [`On ${board.label}, not started`], [], async () => {
        await ctx.opts.jira.createSprint({ name: name.trim(), originBoardId: Number(board.data!.boardId) });
        await reload(ctx, board.id);
        return `Sprint "${name.trim()}" created`;
      });
    },
  });
}

function startOrClose(ctx: Ctx, node: TreeNode): void {
  const board = boardNode(ctx.store.get())!;
  const id = Number(node.data!.sprintId);
  const name = String(node.data!.name);
  if (node.data!.state === "active") {
    confirmWrite(ctx, `Complete the sprint "${name}"?`, ["Open issues stay in the closed sprint until you move them (s)."], [], async () => {
      await ctx.opts.jira.closeSprint(id);
      await reload(ctx, board.id);
      return `Sprint "${name}" completed`;
    });
    return;
  }
  const end = new Date(Date.now() + 14 * 86_400_000);
  open(ctx, {
    kind: "prompt",
    title: `Start "${name}": end date`,
    value: isoDay(end),
    placeholder: "YYYY-MM-DD",
    onSubmit: (endDate) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())) return ctx.toast("error", "The end date must be YYYY-MM-DD.");
      const startDate = isoDay(new Date());
      confirmWrite(ctx, `Start the sprint "${name}"?`, [`${startDate} → ${endDate.trim()}`], [], async () => {
        await ctx.opts.jira.startSprint(id, { startDate, endDate: endDate.trim() });
        await reload(ctx, board.id);
        return `Sprint "${name}" started`;
      });
    },
  });
}

function deleteSprint(ctx: Ctx, node: TreeNode): void {
  const board = boardNode(ctx.store.get())!;
  const name = String(node.data!.name);
  open(ctx, {
    kind: "confirm",
    title: `Delete the sprint "${name}"?`,
    lines: ["Its issues move to the backlog.", "This cannot be undone."],
    double: true,
    step: 0,
    onConfirm: async () => {
      const done = await ctx.task("Deleting…", async () => {
        await ctx.opts.jira.deleteSprint(Number(node.data!.sprintId));
        return `Sprint "${name}" deleted`;
      });
      if (!done) return;
      updateNav(ctx, (t) => ({ ...t, selected: board.id }));
      await reload(ctx, board.id);
      ctx.toast("success", done);
    },
  });
}

// ============ Rank ============

export type RankMove = "top" | "up" | "down" | "bottom";

/**
 * Where `moving` (in list order) goes for `move`: before or after which other
 * issue of the list, and the list order afterwards. Undefined when the issues
 * are already there.
 */
export function rankPlan(items: JiraIssue[], moving: string[], move: RankMove): { before?: string; after?: string; order: JiraIssue[] } | undefined {
  const isMoving = (i: JiraIssue) => moving.includes(i.key);
  const block = items.filter(isMoving);
  const rest = items.filter((i) => !isMoving(i));
  const first = items.findIndex(isMoving);
  const last = items.length - 1 - [...items].reverse().findIndex(isMoving);
  let at: number; // insert position in `rest`
  let anchor: { before?: string; after?: string };
  if (move === "top" || move === "up") {
    const above = move === "top" ? rest[0] : [...items.slice(0, first)].reverse().find((i) => !isMoving(i));
    if (!above || items.indexOf(above) > first) return undefined;
    at = rest.indexOf(above);
    anchor = { before: above.key };
  } else {
    const below = move === "bottom" ? rest[rest.length - 1] : items.slice(last + 1).find((i) => !isMoving(i));
    if (!below || items.indexOf(below) < last) return undefined;
    at = rest.indexOf(below) + 1;
    anchor = { after: below.key };
  }
  const order = [...rest.slice(0, at), ...block, ...rest.slice(at)];
  return order.every((i, n) => i === items[n]) ? undefined : { ...anchor, order };
}

function rank(ctx: Ctx): void {
  const state = ctx.store.get();
  if (!/ORDER BY\s+rank\b/i.test(state.jira.list.query)) {
    return ctx.toast("info", "Sort the list by rank first (o → Rank), then reorder.");
  }
  const issues = targetIssues(state);
  if (issues.length === 0) return;
  const keys = state.jira.list.items.filter((i) => issues.includes(i)).map((i) => i.key);
  const label = keys.length === 1 ? keys[0]! : `${keys.length} issues`;
  open(ctx, {
    kind: "picker",
    title: `Move ${label}`,
    items: [
      { id: "up", label: "Up", hint: "above the issue before" },
      { id: "down", label: "Down", hint: "below the issue after" },
      { id: "top", label: "To the top", hint: "of the list" },
      { id: "bottom", label: "To the bottom", hint: state.jira.list.hasMore ? "of the loaded issues" : "of the list" },
    ],
    query: "",
    selected: 0,
    multi: false,
    marked: [],
    allowFree: false,
    onSubmit: ([move]) => {
      const items = ctx.store.get().jira.list.items;
      const plan = rankPlan(items, keys, move as RankMove);
      if (!plan) return ctx.toast("info", `${label} is already there.`);
      confirmWrite(ctx, `Move ${label} ${plan.before ? `above ${plan.before}` : `below ${plan.after}`}?`, keys, [], async () => {
        const failed = await ctx.opts.jira.rankIssues({ issues: keys, before: plan.before, after: plan.after });
        if (failed.length) throw new Error(`Not moved: ${failed.map((f) => `${f.issueKey} (${f.errors.join("; ") || "refused"})`).join(", ")}`);
        // Jira's search shows a new rank only after a few seconds: reorder here instead of reloading.
        ctx.store.set((s) => {
          const list = withItems(s.jira.list, plan.order, (i) => i.key, s.jira.list.hasMore);
          return { ...s, jira: { ...s.jira, list: { ...list, selected: plan.order.findIndex((i) => i.key === keys[0]) } } };
        });
        return `${label} moved`;
      });
    },
  });
}

export const agileActions: Command[] = [
  // Pane-specific: in the navigator these come before the area-wide `n` (new issue).
  { id: "jira.sprint.new", title: "New sprint (on the selected board)", keys: ["n"], area: "jira", focus: ["nav"], enabled: isScrum, run: newSprint },
  { id: "jira.board.new", title: "New board", keys: ["n"], area: "jira", focus: ["nav"], run: newBoard },
  {
    id: "jira.sprint.state",
    title: "Start or complete the selected sprint",
    keys: ["S"],
    area: "jira",
    focus: ["nav"],
    enabled: (s) => onNav(s)?.kind === "sprint",
    run: (ctx) => startOrClose(ctx, onNav(ctx.store.get())!),
  },
  {
    id: "jira.agile.delete",
    title: "Delete the selected board or sprint",
    keys: ["d"],
    area: "jira",
    focus: ["nav"],
    enabled: (s) => onNav(s)?.kind === "board" || onNav(s)?.kind === "sprint",
    run: (ctx) => {
      const node = onNav(ctx.store.get())!;
      if (node.kind === "board") deleteBoard(ctx, node);
      else deleteSprint(ctx, node);
    },
  },
  { id: "jira.rank", title: "Reorder (rank) the issue on boards and in the backlog", keys: ["R"], area: "jira", focus: ["list", "detail"], run: rank },
];
