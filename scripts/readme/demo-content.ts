#!/usr/bin/env bun
/**
 * Builds the demo content the README screenshots show: an "atlcli Handbook"
 * page tree in a Confluence space, and epics, tasks, a scrum board and two
 * sprints (label `readme-demo`) in a Jira project. Writes the ids it created
 * to stdout as JSON, for `tui-screenshots.sh`.
 *
 *   bun scripts/readme/demo-content.ts --profile work --project ATLCLI --space DOCSY
 *
 * It creates content on a live site: run it against a project and a space
 * meant for tests. Status names are the site's own (they may be localized).
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: { profile: { type: "string" }, project: { type: "string" }, space: { type: "string" } },
});
if (!opts.profile || !opts.project || !opts.space) {
  console.error("usage: bun scripts/readme/demo-content.ts --profile <name> --project <key> --space <key>");
  process.exit(2);
}
const CLI = join(import.meta.dir, "../../apps/cli/src/index.ts");
const PAGES = join(import.meta.dir, "demo-pages");

async function atl(...args: string[]): Promise<any> {
  const proc = Bun.spawn(["bun", "--conditions=development", CLI, ...args, "--profile", opts.profile!, "--json"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`atlcli ${args.join(" ")} failed:\n${out}${err}`);
  return out.trim() ? JSON.parse(out) : {};
}

// ---- Confluence: the handbook tree
async function page(title: string, file: string, parent?: string): Promise<string> {
  const args = ["wiki", "page", "create", "--space", opts.space!, "--title", title, "--body", join(PAGES, file)];
  if (parent) args.push("--parent", parent);
  const result = await atl(...args);
  return String((result.page ?? result).id);
}
const root = await page("atlcli Handbook", "handbook.md");
const pages = { root, children: [] as string[] };
for (const [title, file] of [["Getting started", "getting-started.md"], ["Architecture", "architecture.md"], ["Release process", "release-process.md"]]) {
  pages.children.push(await page(title!, file!, root));
}
const runbooks = await page("Runbooks", "runbooks.md", root);
pages.children.push(runbooks, await page("Rotate API tokens", "rotate-tokens.md", runbooks), await page("Incident response", "incident-response.md", runbooks));
pages.children.push(await page("Decision log", "decision-log.md", root));

// ---- Jira: epics, tasks, board, sprints
async function issue(type: string, summary: string, description: string, parent?: string, me = false): Promise<string> {
  const args = ["jira", "issue", "create", "--project", opts.project!, "--type", type, "--summary", summary, "--description", description, "--labels", "readme-demo"];
  if (parent) args.push("--parent", parent);
  if (me) args.push("--assignee", "me");
  return (await atl(...args)).issue.key;
}

const epics = {
  tui: await issue("Epic", "Terminal UI", "A fullscreen terminal UI for Jira and Confluence: browse, edit and ship without leaving the terminal."),
  pdf: await issue("Epic", "Publication-grade PDF export", "Tagged, deterministic PDFs from any page tree, with real tables, diagrams and macros."),
  agile: await issue("Epic", "Agile workflows", "Boards, sprints and ranking from the CLI and the TUI."),
};

// Status names are the site's (often localized): pick them by category.
const statuses = (await atl("jira", "issue", "transitions", "--key", epics.tui)).transitions as { name: string; to: { statusCategory: { key: string } } }[];
const status = (category: string) => statuses.find((t) => t.to.statusCategory.key === category)!.name;
const [todo, doing, done] = [status("new"), status("indeterminate"), status("done")];


// [epic, summary, description, status, sprint (42, 43 or backlog), assigned to me]
const tasks: [keyof typeof epics, string, string, string, 42 | 43 | null, boolean][] = [
  ["tui", "Rank issues from the list with R", "Move the selected or marked issues up, down, to the top or the bottom.\n\n- Works in any list sorted by rank\n- Marked issues move as one block", done, 42, false],
  ["tui", "Start and complete sprints from the navigator", "`S` on a future sprint starts it; on the active sprint it completes it.\n\n## Acceptance\n\n- [x] Start asks for the end date (default: two weeks)\n- [x] Complete keeps open issues visible in the backlog\n- [ ] Show the sprint goal in the list title", doing, 42, true],
  ["tui", "Light theme for bright terminals", "Pick `tui.theme: light` in the config; every pane keeps a readable contrast.", todo, 42, false],
  ["tui", "Command palette finds every command by name", "`:` or `Ctrl+K` opens the palette; typing filters commands of the current pane.", done, 42, false],
  ["tui", "Drag pane borders to resize", "Mouse drag on a border resizes the navigator or the list; `<` and `>` do the same from the keyboard.", todo, 43, false],
  ["pdf", "Repeat table header rows across pages", "Long tables repeat their header row on every PDF page, like Word does.", done, 42, false],
  ["pdf", "Render Mermaid sequence diagrams as vectors", "Sequence diagrams become SVG in the PDF and keep a PNG fallback in DOCX.", doing, 42, true],
  ["pdf", "Long URLs overflow narrow table cells", "**Steps:** export a page with a 10-column table and a long Smart Link.\n\n**Expected:** the URL wraps inside its cell.\n\n**Actual:** it runs into the next column.", doing, 42, true],
  ["pdf", "Alt text for chart macros in tagged PDFs", "Charts carry the macro title as alt text so screen readers announce them.", todo, 43, false],
  ["pdf", "Native merged cells in DOCX tables", "Use Word's own `gridSpan` and `vMerge` instead of drawing borders.", todo, 43, false],
  ["agile", "Create boards from the CLI", "`atlcli jira board create --name … --project …` makes the filter, shares it and creates the board.", done, 42, false],
  ["agile", "Rank issues before or after a key", "`atlcli jira issue rank KEY… --before|--after KEY`, batched by 50.", done, null, false],
  ["agile", "Sprint review as a Confluence page", "Turn a closed sprint into a review page in the team space.", todo, null, false],
  ["agile", "Bulk-move a JQL result into a sprint", "`atlcli jira bulk move --jql … --sprint 42` with a dry run first.", todo, null, false],
];
const keys: string[] = [];
for (const [epic, summary, description, , , me] of tasks) keys.push(await issue("Task", summary, description, epics[epic], me));

const board = (await atl("jira", "board", "create", "--name", "atlcli Roadmap", "--project", opts.project!,
  "--jql", `project = ${opts.project} AND labels = readme-demo AND issuetype != Epic ORDER BY Rank ASC`)).board.id as number;
const sprint = async (name: string, goal: string) => (await atl("jira", "sprint", "create", "--board", String(board), "--name", name, "--goal", goal)).sprint.id as number;
const sprints = { 42: await sprint("Sprint 42", "TUI polish and PDF table fixes"), 43: await sprint("Sprint 43", "Accessibility and DOCX tables") };
for (const n of [42, 43] as const) await atl("jira", "sprint", "add", ...keys.filter((_, i) => tasks[i]![4] === n), "--sprint", String(sprints[n]));
const today = new Date();
const end = new Date(today.getTime() + 14 * 86_400_000);
await atl("jira", "sprint", "start", "--id", String(sprints[42]), "--start", today.toISOString().slice(0, 10), "--end", end.toISOString().slice(0, 10));
for (const [i, key] of keys.entries()) if (tasks[i]![3] !== todo) await atl("jira", "issue", "transition", "--key", key, "--to", tasks[i]![3]);
for (const epic of [epics.tui, epics.pdf]) await atl("jira", "issue", "transition", "--key", epic, "--to", doing);

await atl("jira", "issue", "comment", "--key", keys[1]!, "Starting works end to end against a live board. Completing still needs the goal in the list title.");
await atl("jira", "issue", "comment", "--key", keys[1]!, "Reviewed the confirm dialog: deleting a sprint now needs `y` twice. :+1:");
await atl("jira", "issue", "comment", "--key", keys[7]!, "Reproduced with the release-process page. The cell width comes from the authored column widths.");

console.log(JSON.stringify({ pages, epics, issues: keys, board, sprints, editIssue: keys[1] }, null, 2));
