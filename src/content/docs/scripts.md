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

**One-liners.** `-e` runs code without a file:

```bash
atlcli script run -e 'export default (await atlcli.jira.get("ATLCLI-1")).fields.summary'
```

## Plan and apply

Every write verb (`create`, `update`, `transition`, `comment`, `createPage`, `updatePage`, `upsertPage`, `addLabels`) adds one operation to the plan instead of writing. Reads go live.

**Objects the plan creates** have placeholder ids, `plan:<n>`, where `n` is the operation number. Use them like real ids: as a parent page, as the issue to comment on, or inside text. On apply each placeholder becomes the real key or id, inside Markdown as well:

```ts
const issue = await atlcli.jira.create({ project: "ATLCLI", type: "Task", summary: "Release 2026.10" });
await atlcli.confluence.createPage({ space: "DOCS", title: "Release 2026.10", markdown: `Tracked in ${issue.key}` });
```

The plan lists the page as `(after #1)`. Once applied, the page says `Tracked in ATLCLI-187`.

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

**If a write fails** (permissions, a workflow rule, a validator), atlcli stops there. The operations before it stay applied, and the report lists every operation as applied, failed or skipped. Fix the cause and run the script again; do not apply the old plan again, since its first operations already ran.

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
- **`limits.maxWrites`**: the most operations a plan may contain (default 100).
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

Run it twice: the second run updates the same page instead of creating a new one. For running scripts from CI, see [Scripts in CI](recipes/scripts-in-ci.md).

## Limits

Scripts run with fixed limits: 64 MB of memory, 5 minutes per run, 60 seconds per Jira or Confluence call, 10,000 calls per run, and the plan's `maxWrites`. A script that hits one ends with an error that names it. See [Script API: sandbox limits](reference/scripts.md#sandbox-limits).

## Troubleshooting

**`Script failed (guest): …`**
The script threw an error. The message is the script's own error, or the error Jira or Confluence returned (for example `Jira API error (404)` for a missing issue). Catch it in the script if a missing object is expected.

**`Transition "Done" is not available for ATLCLI-12 (available: Zu erledigen, In Arbeit, Fertig)`**
Transition names come from the workflow and may be localized. Matching ignores case. For issues that already exist, the name is checked when the plan is made. For issues the plan creates, it can only be checked during apply. List the names with `atlcli jira issue transitions ATLCLI-12`.

**`Targets changed since the plan was made; nothing was written` (exit 2)**
Someone edited an issue or page between the plan and the apply. Run the script again to plan against the current state.

**`Script failed (permission-denied): Script meta.permissions does not grant "jira:write:OPS"`**
The script's `meta.permissions` does not include that project or space. Add the grant, or remove `permissions` to allow everything.

**`Applying needs confirmation: pass --yes`**
There is no terminal to ask in (CI, a pipe) or `--json` is set. Add `--yes` once you have reviewed the plan.

**`… is created by this plan and can only be read after it is applied`**
A read used a `plan:<n>` placeholder. Reads see Jira and Confluence as they are, without the plan's writes. Keep the values you need in variables instead of reading them back.

**`meta must be a self-contained literal` / `Declare meta as export const meta = { … }`**
`meta` is read before the script runs, so it cannot use variables, calls or `export { meta }`. Write the values out.

**`imports are not allowed in scripts`**
Scripts are single files without imports. Copy small helpers into the script.

## Related topics

- [Script API reference](reference/scripts.md): every verb, `meta` field, limit and output shape
- [Scripts in CI](recipes/scripts-in-ci.md): review plans in pull requests, apply after approval, scheduled housekeeping
- [Jira bulk operations](jira/bulk-operations.md): single commands for common bulk changes
- [Jira search](jira/search.md): JQL for `atlcli.jira.search`
- [Confluence search](confluence/search.md): CQL for `atlcli.confluence.search`
- [Agent skill](reference/agent-skill.md): how coding agents use `atlcli script`
