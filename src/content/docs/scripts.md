---
title: "Automation Scripts"
description: "atlcli script: TypeScript automation for Jira and Confluence in a sandbox, planned first and applied after review"
---

# Automation Scripts

`atlcli script` runs small TypeScript (or JavaScript) programs against Jira and Confluence. A script reads live data. Its writes are not executed while it runs: they become a **plan** that you review, and nothing changes until you apply it. Scripts run in a sandbox with no network, file or Node access, so a script you did not write yourself can only do what its plan shows.

```ts
for await (const issue of atlcli.jira.search("project = ATLCLI AND updated < -180d")) {
  await atlcli.jira.comment(issue.key, "Closing as stale");
  await atlcli.jira.transition(issue.key, "Won't Do");
}
```

That is a complete script: no imports, no exports, no setup.

For thousands of issues, let the script handle one issue at a time and atlcli run it as a resumable job: see [Per-Issue Script Jobs](script-jobs.md).

## On this page

- [Prerequisites](#prerequisites)
- [Steps: your first script](#steps-your-first-script)
- [Writing scripts](#writing-scripts)
- [Plan and apply](#plan-and-apply)
- [Restricting a script](#restricting-a-script)
- [Editor support and type checking](#editor-support-and-type-checking)
- [Examples](#examples)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- An authenticated profile (`atlcli auth login`). Scripts use the active profile, or the one given with `--profile`.
- **Jira permission**: Browse Projects to read; Edit Issues, Transition Issues and Add Comments for the matching writes.
- **Confluence permission**: View to read; Add Pages and Add Labels for the matching writes.
- Optional, for type checking: `tsc` on your `PATH` (`npm install -g typescript`).

A script never gets more rights than the profile it runs with.

## Steps: your first script

1. Create a folder with editor types, a `tsconfig.json` and an example:

   ```bash
   atlcli script init scripts
   ```

   `--example <name>` writes one of the bundled examples instead (`atlcli script init --list-examples` lists them), and `--each "<jql>"` a [per-issue](script-jobs.md) skeleton.

2. Run the example. It only reads, so the plan is empty:

   ```bash
   atlcli script run scripts/example.ts
   ```

3. Write a script that changes something, `scripts/stale.ts`:

   ```ts
   for await (const issue of atlcli.jira.search(`project = ${atlcli.params.project} AND updated < -180d`, { limit: 20 })) {
     await atlcli.jira.comment(issue.key, "Closing as stale");
   }
   ```

4. Run it. You see the plan; nothing is written yet:

   ```bash
   atlcli script run scripts/stale.ts --param project=ATLCLI
   ```

   ```text
   stale → https://company.atlassian.net (profile work)
   Plan: 2 operations
       1  jira comment     ATLCLI-12 "Closing as stale"
       2  jira comment     ATLCLI-31 "Closing as stale"
   Nothing was changed. Apply with --apply, or: atlcli script apply <plan.json>
   ```

5. Apply it. atlcli asks before it writes:

   ```bash
   atlcli script run scripts/stale.ts --param project=ATLCLI --apply
   ```

   In CI, cron or any other run without a person at the terminal, add `--yes`:
   the plan is applied without asking. Without a terminal (or with `--json`),
   atlcli never waits for an answer: a run without `--yes` stops with
   `Applying needs confirmation` and writes nothing. To keep a review step,
   write the plan with `--plan-out plan.json` in one job and apply it with
   `atlcli script apply plan.json --yes` after approval, see
   [Scripts in CI](recipes/scripts-in-ci.md).

## Writing scripts

A script is an ES module, and its body is the program. These are always available:

| Name | What it is |
|---|---|
| `atlcli.jira.*`, `atlcli.confluence.*` | The verbs, see the [Script API reference](reference/scripts.md#verbs) |
| `atlcli.params` | Values from `--param name=value` (strings, unless typed in `meta`) |
| `console.log/info/warn/error` | Output to the terminal (stderr); never part of the plan |
| Top-level `await` | Works anywhere in the file |

**Searching.** `atlcli.jira.search` and `atlcli.confluence.search` are async iterators that page through all results. `limit` stops early:

```ts
for await (const page of atlcli.confluence.search("space = DOCS AND label = draft", { limit: 10 })) {
  console.log(page.id, page.title);
}
```

**Pages are Markdown.** `getPage` returns the body as Markdown, and `createPage`, `updatePage` and `upsertPage` take Markdown. The conversion is the same one `wiki docs` uses. Jira descriptions and comments are Markdown too.

**Returning a result.** `export default` sets what the run returns. A value is used as it is; a function is called with the params. The result is printed after the plan, and with `--json` it is in `plan.value`:

```ts
let open = 0;
for await (const _ of atlcli.jira.search("project = ATLCLI AND statusCategory != Done")) open++;
export default { open };
```

**Reading what no verb covers.** `atlcli.jira.rest(path)` and `atlcli.confluence.rest(path)` read any REST resource of the site, for example custom field definitions or an issue's changelog. They only read; writes always go through the verbs and the plan:

```ts
const fields = await atlcli.jira.rest("/rest/api/3/field");
const changelog = await atlcli.jira.rest("/rest/api/3/issue/ATLCLI-1/changelog", { query: { maxResults: 100 } });
```

**JQL functions.** Queries may use `linkedIssuesOf("…")`, `subtasksOf("…")`, `hasAttachments("…")` and the other [JQL functions](jira/search.md#jql-functions) atlcli resolves.

**One-liners.** `-e` runs code without a file:

```bash
atlcli script run -e 'export default (await atlcli.jira.get("ATLCLI-1")).fields.summary'
```

## Plan and apply

Every write verb adds one operation to the plan instead of writing; reads go live. Writes cover issues (create, update, transition, comment, link, assign, labels, attachments), sprints (create, start, close, move issues), pages (create, update, upsert, move, delete to trash, labels, comments, attachments) and page exports to PDF or DOCX. The [Script API reference](reference/scripts.md#verbs) lists them all.

**Objects the plan creates** have placeholder ids, `plan:<n>`, where `n` is the operation number. Use them like real ids: as a parent page, as the issue to comment on, or inside text. On apply each placeholder becomes the real key or id, inside Markdown as well:

```ts
const issue = await atlcli.jira.create({ project: "ATLCLI", type: "Task", summary: "Release 2026.10" });
await atlcli.confluence.createPage({ space: "DOCS", title: "Release 2026.10", markdown: `Tracked in ${issue.key}` });
```

The plan lists the page as `(after #1)`. Once applied, the page says `Tracked in ATLCLI-187`.

**Updates that change nothing are left out.** When `updatePage` or `upsertPage` would write the body and title the page already has, the plan skips it and lists it under `Unchanged, not planned`. The same goes for assigning an issue to its current assignee, label changes that change nothing and moving a page to the parent it already has. Re-running a report script therefore plans nothing when the report did not change. This applies to the first write to an object in a run: a later write that restores an earlier state is kept.

**Attachments and exports.** Scripts cannot read local files, so `attach` takes content the script builds (text, or base64). `confluence.export` writes a PDF or DOCX file when the plan is applied, below the directory you apply in.

**Three ways to apply:**

| Command | When |
|---|---|
| `run <file> --apply` | Interactive: shows the plan, asks, applies |
| `run <file> --apply --yes` | Scheduled jobs; no question |
| `run <file> --plan-out plan.json`, later `apply plan.json` | Review first, for example in a pull request, then apply exactly that plan |

**What apply checks.** Before the first write, atlcli checks every target against the state the plan saw:

- Issues the plan changes must not have been updated since.
- Pages the plan updates must still be at the same version.
- Pages the plan creates must still not exist.

If anything changed, nothing is written and the command exits with code 2. Run the script again to get a fresh plan. A plan file is also bound to its site and protected by a digest: a changed file, or a file made for another site, is refused.

**If a write fails** (permissions, a workflow rule, a validator), atlcli stops there. The operations before it stay applied, and the report lists every operation as applied, failed or skipped. When the plan came from a file (`--plan-out`, or `apply plan.json`), atlcli records every applied operation in `plan.json.journal.jsonl` next to it. Fix the cause and continue with the rest:

```bash
atlcli script apply plan.json --resume
```

Operations already applied are skipped, and objects they created are used as before. Applying the same plan again without `--resume` is refused, because it would repeat its comments and creates. Without a plan file there is no journal: run the script again for a fresh plan.

**Large plans.** From 200 operations on, the output lists counts per verb and the first 50 operations; `--plan-out` or `--json` has all of them. `--concurrency <n>` applies up to `n` operations at once. Operations on the same issue, page or sprint, and operations that use an object the plan creates, still run in plan order.

## Restricting a script

Without `meta`, a script may use every verb. Writes still only reach Jira or Confluence through a plan you apply. For scripts you share, or ones generated by an AI assistant, declare what the script may do:

```ts
export const meta = {
  name: "close-stale",
  description: "Comment on and close stale issues",
  permissions: ["jira:read", "jira:write:ATLCLI"],
  limits: { maxWrites: 50 },
  params: { days: { type: "number", default: 180 } },
};

for await (const issue of atlcli.jira.search(`project = ATLCLI AND updated < -${atlcli.params.days}d`)) {
  await atlcli.jira.comment(issue.key, "Closing as stale");
}
```

- **`permissions`**: once given, everything else is denied. Write grants name one project or space. A denied verb ends the run, even if the script catches the error.
- **`limits.maxWrites`**: the most operations a plan may contain (default 10,000).
- **`params`**: typed parameters with defaults. Unknown or mistyped `--param` values are rejected.

atlcli reads `meta` before any of the script's code runs. It must be written exactly as `export const meta = { … }`, a literal without variables or calls. See [Script API: meta](reference/scripts.md#meta).

## Editor support and type checking

`atlcli script init` writes `atlcli.d.ts` next to your scripts. Editors pick it up through the generated `tsconfig.json`, so you get completion for every verb, its options and its return value. Annotate `meta` to have it checked as well:

```ts
export const meta: ScriptMeta = { permissions: ["jira:read"] };
```

Check a script without running it:

```bash
atlcli script check scripts/stale.ts
```

`check` validates `meta` and runs `tsc --noEmit` when `tsc` is on your `PATH`; otherwise it says it skipped the type check. Scripts may use TypeScript syntax that can simply be removed (types, interfaces, `satisfies`). They may not use `enum` or `namespace`.

Re-run `atlcli script init` after updating atlcli: it refreshes `atlcli.d.ts` and keeps your other files.

## Examples

### Minimal: count open issues per assignee

```ts
const counts: Record<string, number> = {};
for await (const issue of atlcli.jira.search("project = ATLCLI AND statusCategory != Done", { fields: ["assignee"] })) {
  const who = (issue.fields.assignee as { displayName?: string } | null)?.displayName ?? "Unassigned";
  counts[who] = (counts[who] ?? 0) + 1;
}
export default counts;
```

### Advanced: release notes page from a fix version

```ts
export const meta = {
  name: "release-notes",
  permissions: ["jira:read", "confluence:write:DOCS"],
  params: { version: { type: "string" } },
};

const { version } = atlcli.params;
const lines: string[] = [];
for await (const issue of atlcli.jira.search(`project = ATLCLI AND fixVersion = "${version}" ORDER BY key`, { fields: ["summary", "issuetype"] })) {
  const type = (issue.fields.issuetype as { name: string }).name;
  lines.push(`- **${issue.key}** (${type}): ${issue.fields.summary}`);
}

const page = await atlcli.confluence.upsertPage({
  space: "DOCS",
  title: `Release notes ${version}`,
  markdown: `# Release ${version}\n\n${lines.join("\n") || "_No issues._"}`,
});
await atlcli.confluence.addLabels(page.id, ["release-notes"]);
export default { issues: lines.length, created: page.created };
```

```bash
atlcli script run release-notes.ts --param version=2026.10 --apply
```

Run it twice: the second run updates the same page instead of creating a new one. If nothing changed since the last run, the update is left out of the plan, and the output lists the page under `Unchanged, not planned`. For running scripts from CI, see [Scripts in CI](recipes/scripts-in-ci.md).

### Advanced: sprint rollover with a status report

Moves every unfinished issue of the active sprint into the next one, attaches a CSV of what moved, and exports the report page as PDF:

```ts
export const meta = {
  name: "sprint-rollover",
  permissions: ["jira:read", "jira:write:ATLCLI", "confluence:read", "confluence:write:DOCS"],
  params: { board: { type: "number" }, report: { type: "string" } },
};

const { board, report } = atlcli.params;
const sprints: Record<string, JiraSprint | undefined> = {};
for await (const s of atlcli.jira.sprints(board)) if (s.state !== "closed") sprints[s.state] ??= s;
const { active, future: next } = sprints;
if (!active || !next) throw new Error("Needs an active and a future sprint");

const rows = ["key,summary"];
const keys: string[] = [];
for await (const issue of atlcli.jira.search(`sprint = ${active.id} AND statusCategory != Done`, { fields: ["summary"] })) {
  keys.push(issue.key);
  rows.push(`${issue.key},"${String(issue.fields.summary).replaceAll('"', '""')}"`);
}
if (keys.length) await atlcli.jira.moveToSprint(next.id, keys);
await atlcli.confluence.attach(report, { name: `rollover-${active.name}.csv`, content: rows.join("\n") });
await atlcli.confluence.export(report, { format: "pdf", path: `reports/${active.name}.pdf` });
export default { moved: keys.length, into: next.name };
```

Closing the old sprint is a separate step on purpose: `updateSprint(active.id, { state: "closed" })` cannot be undone.

## Limits

By default a script gets 64 MB of memory, 1 hour per run, 100,000 Jira or Confluence calls and 10,000 planned writes. A script that hits a limit ends with an error that names it. Raise or lower the limits per run; `0` removes a limit:

```bash
atlcli script run migrate.ts --timeout 0 --max-calls 0 --max-writes 50000 --memory 256
```

`--max-writes` overrides `meta.limits.maxWrites`. For work on many issues, a [per-issue job](script-jobs.md) has no total limit at all: its limits apply to each issue. Each Jira or Confluence call may take up to 60 seconds. See [Script API: sandbox limits](reference/scripts.md#sandbox-limits).

## Troubleshooting

**`Script failed (guest): …`**
The script threw an error. The message is the script's own error, or the error Jira or Confluence returned (for example `Jira API error (404)` for a missing issue). Catch it in the script if a missing object is expected.

**`Transition "Done" is not available for ATLCLI-12 (available: Zu erledigen, In Arbeit, Fertig)`**
Transition names come from the workflow and may be localized. Matching ignores case. For issues that already exist, the name is checked when the plan is made. For issues the plan creates, it can only be checked during apply. List the names with `atlcli jira issue transitions ATLCLI-12`.

**`Targets changed since the plan was made; nothing was written` (exit 2)**
Someone edited an issue or page between the plan and the apply. Run the script again to plan against the current state.

**`Script failed (write-limit)` / `(host-call-limit)` / `(interrupted)`**
The run hit a limit. If the size is expected (a migration, a large space), raise it with `--max-writes`, `--max-calls` or `--timeout` (`0` for none), or turn the script into a [per-issue job](script-jobs.md). Otherwise check the script for a loop that never ends.

**`3 of 10 operations of this plan were already applied (plan.json.journal.jsonl). Continue with --resume`**
An earlier apply of this plan stopped partway. `apply plan.json --resume` applies the rest. To start over, plan again instead.

**`Script failed (permission-denied): Script meta.permissions does not grant "jira:write:OPS"`**
The script's `meta.permissions` does not include that project or space. Add the grant, or remove `permissions` to allow everything.

**`Starting sprint 1349 needs a startDate and an endDate`**
Jira starts a sprint only with both dates. Pass them with `state: "active"`, or set them on the sprint first.

**`Unknown link type "duplicates" (available: blocks / is blocked by, …)`**
Link types are the site's own and may be renamed or localized. Use one of the listed phrases, or the type's name.

**`Export path must be relative and stay inside the output directory`**
`confluence.export` writes only below the directory `apply` runs in. Use a relative path such as `reports/q3.pdf`.

**`Applying needs confirmation: pass --yes`**
There is no terminal to ask in (CI, a pipe) or `--json` is set. Add `--yes` once you have reviewed the plan.

**`… is created by this plan and can only be read after it is applied`**
A read used a `plan:<n>` placeholder. Reads see Jira and Confluence as they are, without the plan's writes. Keep the values you need in variables instead of reading them back.

**`meta must be a self-contained literal` / `Declare meta as export const meta = { … }`**
`meta` is read before the script runs, so it cannot use variables, calls or `export { meta }`. Write the values out.

**`imports are not allowed in scripts`**
Scripts are single files without imports. Copy small helpers into the script.

## Related topics

- [Per-Issue Script Jobs](script-jobs.md): one script run per issue, for thousands of issues, resumable
- [Script API reference](reference/scripts.md): every verb, `meta` field, limit and output shape
- [Scripts in CI](recipes/scripts-in-ci.md): review plans in pull requests, apply after approval, scheduled housekeeping
- [Jira bulk operations](jira/bulk-operations.md): single commands for common bulk changes
- [Jira search](jira/search.md): JQL for `atlcli.jira.search`
- [Confluence search](confluence/search.md): CQL for `atlcli.confluence.search`
- [Agent skill](reference/agent-skill.md): how coding agents use `atlcli script`
