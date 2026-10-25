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
- [Many issues: per-issue jobs](#many-issues-per-issue-jobs)
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
| `atlcli.jira.search(jql, { fields?, properties?, limit? })` | async iterator, pages transparently; `properties` returns issue properties |
| `atlcli.jira.get(key, { fields? })` | raw fields; `updated` always present |
| `atlcli.jira.create({ project, type, summary, description?, fields?, properties? })` | `description` is Markdown; for a lossless copy pass the raw value as `fields.description` (not both); returns `{ key: "plan:<n>" }` until applied |
| `atlcli.jira.update(key, { summary?, description?, fields? })` | |
| `atlcli.jira.transition(key, to, { fields?, comment? })` | checked against available transitions when planning (not for issues the plan creates); `fields` fill the transition screen (e.g. resolution), `comment` is Markdown |
| `atlcli.jira.transitions(key)` / `history(key, { fields? })` / `watchers(key)` | reads: transitions with target status and category; changelog oldest first; watchers |
| `atlcli.jira.addWatcher(key, user)` / `removeWatcher` | skipped when nothing would change |
| `atlcli.jira.notify(key, { subject, markdown, to: { users?, groups?, reporter?, assignee?, watchers?, voters? } })` | Jira sends the e-mail on apply; a write like any other, show it before applying |
| `atlcli.jira.setStatus(key, status, { fields?, comment? })` | best effort on apply: a direct transition into that status, else no change (listed after apply) |
| `atlcli.jira.comment(key, markdown \| { raw })` | `{ raw }` sends ADF (Cloud) or wiki markup (DC) unchanged |
| `atlcli.jira.link(from, type, to)` | reads as a sentence: `link("A-1", "blocks", "A-2")`; type name or either phrase, checked when planning |
| `atlcli.jira.assign(key, user)` | `"me"`, email, display name or account id, resolved when planning; `null` unassigns |
| `atlcli.jira.addLabels(key, labels)` / `removeLabels` | |
| `atlcli.jira.attach(key, { name, content, encoding? })` | content comes from the script (text, or `encoding: "base64"`), max 10 MB |
| `atlcli.jira.copyAttachment(id, toIssue)` | copies an existing attachment on apply, any size, bytes never in the plan; skipped if the target has the same name and size |
| `atlcli.jira.boards({ project?, name? })` / `sprints(boardId, { state? })` | async iterators |
| `atlcli.jira.createSprint({ board, name, goal?, startDate?, endDate? })` | scrum boards only |
| `atlcli.jira.updateSprint(id, { name?, goal?, startDate?, endDate?, state? })` | `state: "active"` needs both dates; `"closed"` only from active |
| `atlcli.jira.moveToSprint(sprintId, keys)` | |
| `atlcli.confluence.search(cql, { limit? })` | async iterator of `{ id, title, spaceKey }` |
| `atlcli.confluence.getPage(id)` | `{ id, title, spaceKey, version, parentId?, markdown }` |
| `atlcli.confluence.getPage(id, { storage: true })` | storage XHTML as stored plus `properties` (`atlcli.copiedFrom`), for lossless copies |
| `atlcli.confluence.children(id)` | direct child pages, page-tree order |
| `atlcli.confluence.createPage({ space, title, markdown \| storage, parentId?, properties? })` | `storage` is sent unchanged; `properties` become content properties |
| `atlcli.confluence.updatePage(id, { title?, markdown })` | replaces the whole body |
| `atlcli.confluence.upsertPage({ space, title, markdown, parentId? })` | updates the page with that exact title, else creates it |
| `atlcli.confluence.addLabels(pageId, labels)` / `removeLabels` | removing an absent label is fine |
| `atlcli.confluence.comments(pageId)` / `comment(pageId, markdown)` | footer comments |
| `atlcli.confluence.movePage(id, { parentId })` | within the page's space |
| `atlcli.confluence.deletePage(id)` | to the space's trash; later writes to it in the plan throw |
| `atlcli.confluence.archivePage(id)` | archives the page (Confluence finishes it in the background) |
| `atlcli.confluence.attachments(pageId)` / `attach(pageId, { name, content, encoding? })` | same name → new version |
| `atlcli.confluence.export(pageId, { format: "pdf" \| "docx", path? })` | file written below the apply directory when applied |
| `atlcli.confluence.copyAttachment(attachmentId, sourcePageId, toPageId)` | bytes copied on apply, never in the plan; skipped if the target has the same name and size |
| `atlcli.jira.rest(path, { query? })` / `atlcli.confluence.rest(path, { query? })` | read-only GET of any REST resource (`/rest/…`; Confluence also `/api/v2/…`), up to 5 MB; for data no verb covers. There is no write counterpart |
| `await atlcli.render(input, { vars?, format?, source?, parent?, unit? })` | renders a template with `--var`/`--vars-file`/`--now`; strings are text, objects ADF, `format: "storage"` for pages; warnings go to the plan, `--strict` makes them fail (`template` error kind) |

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
  report says which ran. A plan applied from a file keeps a journal
  (`plan.json.journal.jsonl`): after fixing the cause, continue with
  `atlcli script apply plan.json --resume`. Without `--resume` a second apply
  of the same plan is refused.

- **Unchanged writes are skipped.** An `updatePage` or `upsertPage` that would
  leave body and title as they are is not planned; so are an `assign` to the
  current assignee, label changes that change nothing and a `movePage` to the
  current parent. They are listed under `Unchanged, not planned` and in
  `plan.skipped`. "No changes planned" after a re-run is the expected result.
- **`deletePage` is a write like any other** but the plan shows it as
  `page DELETE`. Point it out to the user before applying.
- **Limits:** the defaults are 1 hour, 100,000 calls, 10,000 writes and 64 MB;
  `0` lifts `--timeout`, `--max-calls` or `--max-writes`. Large plans print
  counts per verb and the first 50 operations; `--concurrency <n>` applies
  independent operations in parallel (same issue/page stays in order).

`atlcli script check <file>` validates `meta` and type-checks the file against
`atlcli.d.ts` when `tsc` is on PATH. `atlcli script init [dir]` writes
`atlcli.d.ts`, `tsconfig.json` and an example script (`--each "<jql>"`: a
per-issue skeleton; `--example <name>`, `--list-examples`: bundled examples).

JQL in `atlcli.jira.search` and `--each` may use the client-side functions
`linkedIssuesOf`, `subtasksOf`, `childrenOf`, `issuesInEpics`, `parentsOf`,
`epicsOf`, `hasSubtasks`, `hasLinks`, `hasAttachments`, `hasComments`,
`hasWorklogs`, see [jira-search.md](jira-search.md#jql-functions).

## Many issues: per-issue jobs

For hundreds or tens of thousands of issues, write the script for one issue
and let atlcli run it as a resumable job:

```ts
export const meta = { each: { jql: "project = PROJ AND updated < -365d", fields: ["status"] } };
export default async (issue, params) => {
  await atlcli.jira.setStatus(issue.key, "Won't Do");
};
```

```bash
atlcli script run close.ts --json                # plans every issue into a job; writes nothing
atlcli script jobs <job-id> --json               # counts and failed issues, for the user
atlcli script apply <job-id> --yes --json        # after the user agreed
atlcli script run close.ts --apply --yes         # plan + apply issue by issue (trusted routine)
atlcli script resume <job-id> --yes              # after a stop; --script <file> with a fix
```

- `--each "<jql>"` works without `meta.each`; the default export is then
  required. Limits apply per issue (60 s, 500 calls, 50 writes); there is no
  total limit. `--concurrency` (default 4), `--max-failures` (default 10%).
- The job snapshots the matching issue ids first; outcomes go to
  `~/.atlcli/jobs/<id>/`. Failed and unfinished issues are retried on resume.
- **Make the script safe to run twice.** Resume may repeat an issue. Status,
  labels, assignee and page updates that change nothing are skipped
  automatically; comments, creates and attachments are not, so guard them
  (e.g. skip issues that already carry a marker label).
- Applying a job is a write like any other: show the user the counts from
  `run`/`jobs` first.

## Restricting a script

`meta` is optional. Declare it for shared or generated scripts:

```ts
export const meta = {
  name: "close-stale",
  permissions: ["jira:read", "jira:write:PROJ"],   // anything else is denied
  limits: { maxWrites: 50 },                        // default 10000
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
- Re-applying a plan after a `failed` report without `--resume`: its first operations already ran. Use `apply plan.json --resume`, or plan again.
- One big plan for thousands of issues, when each issue's change stands alone. Use a per-issue job (`--each`).
- Comments or creates in a per-issue script without a guard against running twice.
- Reading back a page or issue the same script just planned to write and expecting the new state.
- Guessing transition names. Read them with `atlcli jira issue transitions <key>` first.
