---
name: scripts
description: atlcli script, TypeScript automation scripts for Jira and Confluence in a sandbox; writes are planned first and applied in a separate, confirmed step.
metadata:
  tags: script, automation, typescript, plan, apply, bulk, sandbox
---

# Scripts

`atlcli script` runs TypeScript (or plain JavaScript) against Jira and
Confluence in a QuickJS sandbox. Reads go live. Writes are never executed
while the script runs: they become a **plan**, and nothing changes until the
plan is applied. Use a script when one command per change would be many
commands, or when the change needs logic (loops, conditions, cross-product
links).

## Contents

- [Writing a script](#writing-a-script)
- [Verbs](#verbs)
- [Plan, then apply](#plan-then-apply)
- [Restricting a script](#restricting-a-script)
- [Output and exit codes](#output-and-exit-codes)
- [Anti-patterns](#anti-patterns)

## Writing a script

No imports, no exports, no setup: `atlcli.*`, `atlcli.params` and `console`
are always there, and top-level `await` works.

```ts
for await (const issue of atlcli.jira.search("project = PROJ AND updated < -180d", { limit: 50 })) {
  await atlcli.jira.comment(issue.key, "Closing as stale");
  await atlcli.jira.transition(issue.key, "Won't Do");
}
```

Inline code needs no file: `atlcli script run -e '<code>'`. `export default`
sets the result (a value, or a function called with the params).

The sandbox has no `fetch`, no Node APIs and no imports. Transition names are
the workflow's own (they may be localized, e.g. "Fertig"); matching ignores
case.

## Verbs

| Verb | Notes |
| --- | --- |
| `atlcli.jira.search(jql, { fields?, limit? })` | async iterator, pages transparently |
| `atlcli.jira.get(key, { fields? })` | raw fields; `updated` always present |
| `atlcli.jira.create({ project, type, summary, description?, fields? })` | `description` is Markdown; returns `{ key: "plan:<n>" }` until applied |
| `atlcli.jira.update(key, { summary?, description?, fields? })` | |
| `atlcli.jira.transition(key, to)` | checked against available transitions when planning (not for issues the plan creates) |
| `atlcli.jira.comment(key, markdown)` | |
| `atlcli.confluence.search(cql, { limit? })` | async iterator of `{ id, title, spaceKey }` |
| `atlcli.confluence.getPage(id)` | `{ id, title, spaceKey, version, parentId?, markdown }` |
| `atlcli.confluence.createPage({ space, title, markdown, parentId? })` | |
| `atlcli.confluence.updatePage(id, { title?, markdown })` | replaces the whole body |
| `atlcli.confluence.upsertPage({ space, title, markdown, parentId? })` | updates the page with that exact title, else creates it |
| `atlcli.confluence.addLabels(pageId, labels)` | |

Objects the plan creates are referenced as `plan:<n>`, also inside text (a page
body naming a new issue key gets the real key at apply). Reads of such objects
fail until the plan is applied, and reads never see the plan's own writes.

## Plan, then apply

```bash
atlcli script run cleanup.ts --param project=PROJ                 # dry run: prints the plan
atlcli script run cleanup.ts --param project=PROJ --plan-out plan.json --json
atlcli script apply plan.json --yes --json                         # after the user agreed
atlcli script run cleanup.ts --apply --yes                         # plan + apply in one go
```

- **Applying is a write.** Show the user the plan first: operation count, each
  line, and the target site. Apply only after the user agreed to that plan.
  See [safety.md](safety.md).
- **Without a terminal, `--yes` is required.** The same holds with `--json`.
- **Digest check:** `apply` refuses a plan file that was changed after it was
  written, and a plan made for another site.
- **Drift check:** before the first write, every target is checked against the
  state the plan saw (issue `updated`, page version, a title still absent).
  Any drift aborts with nothing written; re-run the script to plan again.
- **First failure stops the run.** Earlier operations stay written, and the
  report says which ran.

- **Unchanged pages are skipped.** An `updatePage` or `upsertPage` that would
  leave body and title as they are is not planned. It is listed under
  `Unchanged, not planned` and in `plan.skipped`. "No changes planned" after a
  re-run is the expected result.
- **Limits:** the defaults are 5 minutes, 10,000 calls, 100 writes and 64 MB.
  Raise them only for a run the user expects to be large: `--timeout 30m`,
  `--max-calls`, `--max-writes` (overrides `meta.limits.maxWrites`),
  `--memory <MB>`.

`atlcli script check <file>` validates `meta` and type-checks the file against
`atlcli.d.ts` when `tsc` is on PATH. `atlcli script init [dir]` writes
`atlcli.d.ts`, `tsconfig.json` and an example script.

## Restricting a script

`meta` is optional. Declare it for shared or generated scripts:

```ts
export const meta = {
  name: "close-stale",
  permissions: ["jira:read", "jira:write:PROJ"],   // anything else is denied
  limits: { maxWrites: 50 },                        // default 100
  params: { days: { type: "number", default: 180 } },
};
```

It must be that literal shape (`export const meta = { … }`); it is read before
any code runs. A denied permission or exceeding `maxWrites` ends the run.
Declared params are typed and unknown params are rejected. Undeclared params
pass through as strings.

## Output and exit codes

- `--json` prints `{ schemaVersion, plan }` and, after an apply, `report` too.
- `report.status` is `applied`, `drift` or `failed`; `report.operations` has
  one entry per operation, with `applied`, `failed` or `skipped`.
- Script output from `console.*` goes to stderr.

| Exit | Meaning |
| --- | --- |
| 0 | planned, or applied |
| 1 | script error (`kind`: guest, invalid-script, permission-denied, write-limit, deadline, …), failed write, usage |
| 2 | drift: targets changed since the plan; nothing written |

## Anti-patterns

- Running `--apply --yes` before the user has seen the plan.
- Re-applying a plan after a `failed` report. Its first operations already ran, so run the script again for a fresh plan instead.
- Reading back a page or issue the same script just planned to write and expecting the new state.
- Guessing transition names. Read them with `atlcli jira issue transitions <key>` first.
