---
title: "Script API"
description: "Reference for atlcli script: commands, meta, verbs, sandbox limits, plan file, JSON output and exit codes"
---

# Script API

Reference for [Automation Scripts](../scripts.md). The task-oriented guide comes first. This page lists every command, field, verb and limit.

## On this page

- [Commands](#commands)
- [Globals](#globals)
- [meta](#meta)
- [Verbs](#verbs)
- [atlcli.render](#atlclirender)
- [Attachments](#attachments)
- [Exports](#exports)
- [Placeholders](#placeholders)
- [Preconditions](#preconditions)
- [Sandbox limits](#sandbox-limits)
- [Unchanged updates](#unchanged-updates)
- [Plan file](#plan-file)
- [Apply journal](#apply-journal)
- [Per-issue jobs](#per-issue-jobs)
- [JSON output](#json-output)
- [Exit codes and error kinds](#exit-codes-and-error-kinds)
- [Related topics](#related-topics)

## Commands

| Command | What it does |
|---|---|
| `atlcli script run <file>` | Runs the script and prints the plan. Writes nothing |
| `atlcli script run -e <code>` | Same, for inline code (`--eval` is the long form) |
| `atlcli script apply <plan.json>` | Applies a plan written with `--plan-out`; `--resume` continues a stopped apply |
| `atlcli script run <file> --each "<jql>"` | Per-issue job: plans (or with `--apply` applies) the script once per issue. See [Per-issue jobs](#per-issue-jobs) |
| `atlcli script apply <job-id>` | Applies the reviewed plans of a per-issue job |
| `atlcli script resume <job-id>` | Continues a per-issue job that stopped |
| `atlcli script jobs [job-id]` | Lists per-issue jobs, or shows one with the issues not done |
| `atlcli script check <file>` | Validates `meta`; type-checks with `tsc --noEmit` when `tsc` is on `PATH` |
| `atlcli script init [dir]` | Writes `atlcli.d.ts`, `tsconfig.json` and `example.ts` (default dir: `.`); `--each "<jql>"` writes `each.ts`, `--example <name>` a bundled example |

| Flag | Commands | Type | Default | Notes |
|---|---|---|---|---|
| `--param <name=value>` | run | string, repeatable | none | Available as `atlcli.params`; typed when declared in `meta.params` |
| `--plan-out <file>` | run | path | none | Writes the plan file, also when `--apply` is given |
| `--apply` | run | switch | off | Applies after planning; asks first |
| `--yes` | run, apply, resume | switch | off | Applies without asking. Required without a terminal or with `--json` |
| `--resume` | apply | switch | off | Continues an apply of this plan that stopped; see [Apply journal](#apply-journal) |
| `--concurrency <n>` | run, apply, resume | 1–32 | 1 for plans, 4 for jobs | Operations (plans) or issues (jobs) in flight at once |
| `--each <jql>` | run, init | JQL | `meta.each.jql` | Per-issue mode; for `init`, writes `each.ts` for this query |
| `--max-failures <n\|n%>` | run, resume | count or percentage | `10%`, at least 10 | Failed issues after which a job stops |
| `--max-items <n>` | run, resume | positive integer | all | Issues a job processes in this run |
| `--script <file>` | resume | path | the job's script | Continue a planning or streaming job with a fixed script |
| `--example <name>` | init | string | none | Writes `<name>.ts`; `--list-examples` lists them |
| `--profile <name>` | run, apply | string | active profile | Also `ATLCLI_PROFILE` |
| `--timeout <duration>` | run | `90s`, `10m`, `1h`, `500ms`; bare number = seconds; `0` = none | `1h` (jobs: `60s` per issue) | Whole run, CPU and waiting |
| `--max-writes <n>` | run | integer ≥ 0; `0` = none | `meta.limits.maxWrites`, else 10,000 (jobs: 50 per issue) | Overrides `meta.limits.maxWrites` |
| `--max-calls <n>` | run | integer ≥ 0; `0` = none | 100,000 (jobs: 500 per issue) | Jira and Confluence calls per run |
| `--memory <MB>` | run | positive integer | 64 | Script memory |
| `--var <name=value>` | run | string, repeatable | none | Template variable for [`atlcli.render`](#atlclirender); `a.b=v` nests, JSON values are parsed |
| `--vars-file <file>` | run | YAML path | none | Template values and declarations; see [Templating](/templating/#variables) |
| `--now <iso>` | run | ISO date/time | time of planning | Clock for `@today`/`@now`; recorded in the plan |
| `--strict` | run | switch | off | Any template warning ends the run (`template` error kind) |
| `--json` | all | switch | off | One JSON document on stdout; script output stays on stderr |
| `--force` | init | switch | off | Overwrites `tsconfig.json` and `example.ts`; `atlcli.d.ts` is always refreshed |

## Globals

| Name | Type | Notes |
|---|---|---|
| `atlcli.params` | `Readonly<Record<string, string \| number \| boolean>>` | Frozen. Strings unless declared in `meta.params` |
| `atlcli.jira`, `atlcli.confluence` | objects of verbs | Frozen; see [Verbs](#verbs) |
| `atlcli.render(input, options?)` | function | Renders a template; see [atlcli.render](#atlclirender) |
| `console.log`, `info`, `warn`, `error` | functions | To stderr; objects are printed as JSON |
| `export default` | value or function | Optional. A function is awaited with `atlcli.params`; its result, or the value, becomes `plan.value`. In a per-issue job it is required and called as `default(issue, params)` |

The sandbox has no `fetch`, timers, `process`, `require`, file system or imports.

## meta

Optional. It is read statically before the script runs, so it must be written as `export const meta = { … }` with literal values only.

| Field | Type | Default | Required | Constraints |
|---|---|---|---|---|
| `name` | string | file name, `inline` for `-e` | no | lowercase letters, digits, `-` |
| `description` | string | none | no | |
| `permissions` | string[] | none: all verbs allowed | no | each `jira:read`, `jira:write:<PROJECT>`, `confluence:read` or `confluence:write:<SPACE>`. Once given, everything else is denied |
| `limits.maxWrites` | integer | 10,000 | no | > 0; most operations in one plan |
| `each.jql` | string | none | no | Per-issue mode: the issues the default export runs for. `--each` overrides it |
| `each.fields` | string[] | `summary`, `status`, `assignee`, `priority`, `issuetype`, `labels` | no | Fields each issue comes with |
| `params.<name>.type` | `"string"` \| `"number"` \| `"boolean"` | none | yes, per param | name: letters, digits, `_`, not starting with a digit |
| `params.<name>.default` | matches `type` | none (then the param is required) | no | |
| `params.<name>.description` | string | none | no | |

Unknown fields are errors, so a misspelled field fails instead of being ignored. With `params` declared, `--param` values are converted to the declared type (`"true"`/`"false"` for booleans, finite numbers for numbers); unknown names and missing required ones are errors.

Minimal and full:

```ts
export const meta = { permissions: ["jira:read"] };
```

```ts
export const meta: ScriptMeta = {
  name: "sprint-housekeeping",
  description: "Label unestimated issues in the active sprint",
  permissions: ["jira:read", "jira:write:ATLCLI"],
  limits: { maxWrites: 200 },
  params: {
    label: { type: "string", default: "needs-estimate" },
    dryRunOnly: { type: "boolean", default: false, description: "Return the keys instead of planning" },
  },
};
```

## Verbs

Reads return live data. Writes return placeholder ids (see [Placeholders](#placeholders)) and add one operation to the plan. Arguments are validated; invalid ones throw a catchable `TypeError`.

### Jira

| Verb | Returns | Permission | Plan |
|---|---|---|---|
| `jira.search(jql, { fields?, properties?, limit? })` | async iterator of `{ id, key, fields, properties? }` | `jira:read` | read; pages of 100. `properties` names issue property keys to return |
| `jira.get(key, { fields? })` | `{ id, key, fields }`, `fields.updated` always present | `jira:read` | read |
| `jira.rest(path, { query? })` | JSON | `jira:read` | read only (GET). `path` is site-relative and starts with `/rest/`, e.g. `/rest/api/3/field`; no query string in it (use `query`), no `..`. Responses up to 5 MB |
| `jira.create({ project, type, summary, description?, fields?, properties? })` | `{ id, key }` placeholders | `jira:write:<project>` | create; no precondition. `description` is Markdown; `fields.description` is sent unchanged (ADF from `get`, for lossless copies). Not both. `properties` sets issue properties by key |
| `jira.update(key, { summary?, description?, fields? })` | `null` | `jira:write:<project of key>` | update; issue unchanged |
| `jira.transition(key, to)` | `null` | `jira:write:<project of key>` | transition; issue unchanged. `to` is matched by name, ignoring case; checked against the issue's transitions when the issue exists |
| `jira.setStatus(key, status)` | `null` | `jira:write:<project of key>` | best-effort transition; issue unchanged. On apply, takes a transition available then whose target status (or name) is `status`; with none, nothing changes and the apply output lists it under `Status unchanged`. For issues whose workflow is not known at plan time, such as ones the plan creates. Left out when the issue already has that status |
| `jira.comment(key, body)` | `{ id }` placeholder | `jira:write:<project of key>` | comment; no precondition. `body` is Markdown, or `{ raw }`: the site's own format (ADF on Cloud, wiki markup on Data Center), sent unchanged |
| `jira.link(from, type, to)` | `null` | `jira:write` for both projects | link; no precondition. Reads as a sentence: `link("A-1", "blocks", "A-2")`. `type` is the link type's name or either phrase (`"is blocked by"` swaps the issues); checked at plan time |
| `jira.assign(key, user)` | `null` | `jira:write:<project of key>` | assignment; issue unchanged. `user` is `"me"`, an email, a display name or an account id, resolved at plan time; `null` unassigns. Left out when already assigned so |
| `jira.addLabels(key, labels)` | `null` | `jira:write:<project of key>` | labels; issue unchanged. Left out when every label is already set |
| `jira.removeLabels(key, labels)` | `null` | `jira:write:<project of key>` | labels; issue unchanged. Left out when none of the labels is set |
| `jira.attach(key, { name, content, encoding? })` | `{ id }` placeholder | `jira:write:<project of key>` | attachment; no precondition. See [Attachments](#attachments) |
| `jira.copyAttachment(id, toIssue)` | `{ id }` placeholder, or the existing attachment's id when skipped | `jira:read`, `jira:write:<project of toIssue>` | copy; attachment unchanged. `id` comes from `fields.attachment`; the bytes are copied on apply and never enter the script or the plan, so there is no size cap. See [Attachments](#attachments) |
| `jira.boards({ project?, name?, limit? })` | async iterator of `{ id, name, type, projectKey? }` | `jira:read` | read; pages of 50 |
| `jira.sprints(boardId, { state?, limit? })` | async iterator of `{ id, name, state, boardId?, startDate?, endDate?, goal? }` | `jira:read` | read; pages of 50 |
| `jira.createSprint({ board, name, goal?, startDate?, endDate? })` | `{ id }` placeholder | `jira:write:<project of board>` | create; no precondition. Scrum boards only |
| `jira.updateSprint(id, { name?, goal?, startDate?, endDate?, state? })` | `null` | `jira:write:<project of board>` | update; sprint state unchanged. `state: "active"` starts a future sprint and needs both dates; `"closed"` completes an active one |
| `jira.moveToSprint(sprintId, keys)` | `null` | `jira:write` for the board's and every issue's project | move; no precondition. Not into a closed sprint |

`description` and comment bodies are Markdown. They become Atlassian Document Format on Cloud and stay text on Data Center. `fields` passes raw Jira field values through (`{ labels: ["x"], priority: { name: "High" } }`). Dates are ISO 8601 with an offset, e.g. `"2026-11-02T09:00:00.000Z"`. Sprint ids may be numbers, numeric strings or placeholders of `createSprint`.

Once `meta.permissions` is declared, sprint writes on a board that belongs to no project are denied, because no grant can name it.

### Confluence

| Verb | Returns | Permission | Plan |
|---|---|---|---|
| `confluence.search(cql, { limit? })` | async iterator of `{ id, title, spaceKey }` | `confluence:read` | read; pages of 100 |
| `confluence.getPage(id)` | `{ id, title, spaceKey, version, parentId?, markdown }` | `confluence:read` | read |
| `confluence.rest(path, { query? })` | JSON | `confluence:read` | read only (GET), relative to the Confluence base (`/wiki` on Cloud): `/rest/api/…` or `/api/v2/…`. Same rules as `jira.rest` |
| `confluence.getPage(id, { storage: true })` | `{ id, title, spaceKey, version, parentId?, storage, properties }` | `confluence:read` | read; storage XHTML as stored, `properties` holds `atlcli.copiedFrom` when set |
| `confluence.children(id)` | `[{ id, title, spaceKey }]` | `confluence:read` | read; direct child pages in page-tree order |
| `confluence.createPage({ space, title, markdown \| storage, parentId?, properties? })` | `{ id }` placeholder | `confluence:write:<space>` | create; title still absent. `storage` is sent unchanged (lossless copies); `properties` become content properties |
| `confluence.updatePage(id, { title?, markdown })` | `{ id }` | `confluence:write:<space of page>` | replaces the body; page version unchanged. Keeps the title unless given. Left out when body and title would not change |
| `confluence.upsertPage({ space, title, markdown, parentId? })` | `{ id, created }` | `confluence:write:<space>` | becomes an update of the page with that exact title, else a create |
| `confluence.addLabels(pageId, labels)` | `null` | `confluence:write:<space of page>` | labels; no precondition |
| `confluence.removeLabels(pageId, labels)` | `null` | `confluence:write:<space of page>` | labels; no precondition. A label the page does not have counts as removed |
| `confluence.comments(pageId)` | `[{ id, authorId?, created?, status, markdown, replies }]` | `confluence:read` | read; footer comments |
| `confluence.comment(pageId, markdown)` | `{ id }` placeholder | `confluence:write:<space of page>` | footer comment; no precondition |
| `confluence.movePage(id, { parentId })` | `{ id }` | `confluence:write:<space of page>` | move; page version unchanged. Within the page's space. Left out when the page already has that parent |
| `confluence.deletePage(id)` | `null` | `confluence:write:<space of page>` | moves the page to the space's trash; page version unchanged. Later writes to it in the same plan throw |
| `confluence.attachments(pageId)` | `[{ id, name, mediaType, size, version }]` | `confluence:read` | read |
| `confluence.attach(pageId, { name, content, encoding? })` | `{ id }` placeholder | `confluence:write:<space of page>` | attachment; no precondition. An attachment of the same name gets a new version |
| `confluence.copyAttachment(attachmentId, sourcePageId, toPageId)` | `{ id }` | `confluence:write:<space of target>` | copies the bytes host-side when applied; left out when the target already has a file of that name and size |
| `confluence.export(pageId, { format, path? })` | `{ path }` | `confluence:read` | writes a local `pdf` or `docx` file when applied. See [Exports](#exports) |

Creating the same title twice in one plan is an error; use `upsertPage`, which also finds pages the plan itself creates.

Comments, labels and attachments do not change a page's version, so they never take the version precondition away from a later `updatePage` on the same page.

### Attachments

Scripts have no file system access, so attachment content comes from the script: text by default, or base64 with `encoding: "base64"`. The limit is 10 MB per attachment after decoding. The content is stored in the plan file, so a plan with attachments grows by their size.

To copy an attachment that already exists in Jira, use `jira.copyAttachment` instead. The plan holds only the reference (id, filename, size); on apply, atlcli downloads the file into a private temporary folder, checks its size, uploads it and removes the folder. Any size works, and the plan stays small. [`jira project copy-issues`](/jira/copy-issues/) is built on it.

```ts
const rows = ["key,status"];
for await (const issue of atlcli.jira.search("project = ATLCLI AND sprint in openSprints()", { fields: ["status"] })) {
  rows.push(`${issue.key},${(issue.fields.status as { name: string }).name}`);
}
await atlcli.confluence.attach("123456", { name: "sprint-status.csv", content: rows.join("\n") });
```

### Exports

`confluence.export` runs `atlcli wiki export` when the plan is applied, with the same profile and the export's defaults. `path` is relative, uses `/`, must not contain `..` and must end in `.pdf` or `.docx`; it defaults to `<pageId>.<format>`. Files land below the directory `apply` runs in; missing folders are created and an existing file is overwritten. Because a plan file can be edited, the path is checked again right before writing. Two exports to the same path in one plan are an error.

## Placeholders

A write that creates something returns `plan:<n>`, where `n` is its operation number. A placeholder:

- works as an argument to later verbs (`issue.key`, `parentId`, `pageId`), which records a `dependsOn` link;
- is replaced inside text as well. A Markdown body containing `plan:3` gets the real key or id when applied, provided operation 3 creates an issue or page;
- cannot be read: `jira.get` or `confluence.getPage` with a placeholder throws, because the object does not exist yet.

Reads never see the plan's own writes. A page read after a planned `updatePage` still returns the old body.

## Preconditions

The first write to an existing object records the state the plan saw. Later writes to the same object depend on that first operation instead of recording their own.

| Precondition | Recorded by | Checked on apply |
|---|---|---|
| Issue unchanged | `jira.update`, `jira.transition`, `jira.setStatus`, `jira.assign`, `jira.addLabels`, `jira.removeLabels` | `fields.updated` is the same |
| Attachment unchanged | `jira.copyAttachment` (on the source attachment) | the attachment still exists with the same size |
| Sprint unchanged | `jira.updateSprint` on an existing sprint | `state` is the same |
| Page unchanged | `confluence.updatePage`, `upsertPage` on an existing page, `movePage`, `deletePage` | `version` is the same |
| Title absent | `confluence.createPage`, `upsertPage` on a new page | no page with that title in the space |

All preconditions are checked before the first write. If any fails, nothing is written. Between that check and each write there is a short window. A concurrent page edit in it makes the update fail on the version check. A concurrent issue edit in it is overwritten, because Jira has no conditional update.

## Sandbox limits

| Limit | Default | Set with | When hit |
|---|---|---|---|
| Memory | 64 MB | `--memory` | `memory` |
| Stack | 512 KB | fixed | `guest` (stack overflow) |
| Run time, CPU and waiting | 1 hour (jobs: 60 seconds per issue) | `--timeout`; `0` = none | `interrupted` (busy loop) or `deadline` (waiting) |
| One Jira or Confluence call | 60 seconds | fixed | catchable error `Host call timed out` |
| Calls per run | 100,000 (jobs: 500 per issue) | `--max-calls`; `0` = none | `host-call-limit` |
| Planned writes | 10,000 (jobs: 50 per issue) | `meta.limits.maxWrites`, `--max-writes` (wins); `0` = none | `write-limit` |

`host-call-limit`, `write-limit` and `permission-denied` end the run even if the script catches the error.

## Unchanged updates

The first `updatePage` to a page in a run, or the `upsertPage` that turns into one, is compared with the page as it is now. Both bodies go through the same Markdown → Storage → Markdown conversion. If title and body are equal, no operation is planned. The write appears in `skipped` instead, and the text output lists it as `Unchanged, not planned`. Later writes to a page the plan already changed are always kept, because reads show the state before the plan.

The same applies to the first write of these verbs to an object:

| Verb | Left out when |
|---|---|
| `jira.assign` | the issue already has that assignee (or none, for `null`) |
| `jira.addLabels` | every label is already set |
| `jira.removeLabels` | none of the labels is set |
| `jira.setStatus` | the issue already has that status |
| `jira.copyAttachment` | the target issue already has an attachment with that filename and size |
| `confluence.movePage` | the page already has that parent |

Other verbs are always planned. Re-running a script that only uses verbs from this section and `updatePage`/`upsertPage` therefore plans nothing once its work is done.

## Plan file

`--plan-out` writes canonical JSON (sorted keys), so equal plans are equal bytes.

| Field | Type | Notes |
|---|---|---|
| `schema` | `"atlcli.script-plan/1"` | |
| `createdAt` | ISO 8601 | |
| `script.name` | string | `meta.name`, else the file name, else `inline` |
| `script.path` | string | relative to the working directory; absent for `-e` |
| `script.sha256` | hex | SHA-256 of the script source |
| `script.meta` | object | validated `meta` |
| `params` | object | resolved parameters |
| `target.baseUrl` | URL | site the plan was made for |
| `target.profile` | string | profile name; never credentials |
| `operations[]` | array | `{ seq, verb, args, precondition?, dependsOn }` |
| `skipped[]` | array | `{ verb, target, title?, reason: "unchanged" }`; writes left out, see [Unchanged updates](#unchanged-updates). `target` is a page id or issue key |
| `value` | JSON | the script's result |
| `digest` | hex | SHA-256 over the canonical JSON of all other fields |

`apply` refuses a file whose digest does not match, whose operations are out of order, or whose `target.baseUrl` differs from the profile's site.

## Apply journal

Applying a plan file writes `<plan file>.journal.jsonl` next to it: a first line `{ "plan": "<digest>" }`, then `{ "seq", "result" }` for each applied operation, written before the next one starts.

| Situation | What `apply` does |
|---|---|
| No journal, or a journal with no applied operation | Applies the plan |
| Journal of this plan with applied operations, no `--resume` | Refuses: applying twice would repeat writes |
| `--resume` | Skips the applied operations; their results stand in for `plan:<n>` references and page versions. Preconditions are checked only for the rest |
| Every operation already applied | Reports that and writes nothing |
| Journal of another plan | Refuses; move the journal away |

`run --plan-out` starts a new journal (and removes an old one at that path) when it writes the plan.

With `--concurrency` above 1, an operation waits for its `dependsOn` and for every earlier operation that names the same issue, page or sprint. After a failure no new operation starts; the ones in flight finish.

## Per-issue jobs

`script run --each` (or a script with `meta.each`) runs the default export once per issue. See the [guide](../script-jobs.md).

1. **Snapshot.** The query runs once; the id and key of every issue go to `items.jsonl`.
2. **Batches of 100.** The issues are read by id with `meta.each.fields`. Each runs in its own sandbox with the per-issue limits, `--concurrency` at a time.
3. **Outcome per issue,** one JSON line `{ id, key, status, operations?, ops?, value?, error? }`:

| Status | Meaning | Done on resume? |
|---|---|---|
| `planned` | Plan stored in `plans.jsonl` (review mode) | yes |
| `unchanged` | The script planned nothing | yes |
| `applied` | All operations applied | yes |
| `gone` | Deleted or no longer visible since the snapshot | yes |
| `error` | The script failed for this issue (`kind: message`) | no, retried |
| `failed` | A write failed; earlier writes of this issue stay applied | no, retried |
| `drift` | The issue changed between plan and apply; nothing written | no |

A job stops when `--max-failures` is reached, when the script is invalid, or on Ctrl-C (in-flight issues finish). `job.json` records the state:

| Field | Notes |
|---|---|
| `schema` | `"atlcli.script-job/1"` |
| `id`, `createdAt`, `updatedAt` | |
| `script` | `{ name, path?, sha256 }`; the source is kept as `script.ts` |
| `params`, `jql`, `fields`, `target` | as run |
| `mode` | `plan` (review first) or `stream` (`--apply`) |
| `phase` | `planning`, `planned` or `applying` |
| `stopped` | why the last run stopped early; absent otherwise |
| `limits`, `concurrency`, `maxFailures` | per-issue limits and settings |
| `total` | issues in the snapshot |
| `plansDigest` | SHA-256 of `plans.jsonl` once planning finished; `apply` refuses an edited file |

## JSON output

| Command | stdout |
|---|---|
| `run` | `{ "schemaVersion": "1", "plan": { … } }` |
| `run --apply`, `apply` | `{ "schemaVersion": "1", "plan": { … }, "report": { "status": "applied", "drift": [], "operations": [ … ] } }` |
| `check` | `{ "schemaVersion": "1", "meta": { … }, "typecheck": { "status": "ok" \| "skipped" \| "errors", … } }` |
| `init` | `{ "schemaVersion": "1", "dir": "…", "written": [ … ], "kept": [ … ] }` |
| `run --each`, `apply <job-id>`, `resume` | `{ "schemaVersion": "1", "job": { … }, "run": { "<status>": n }, "counts": { "done", "byStatus" }, "operations": { "<verb>": n } }` |
| `jobs` | `{ "schemaVersion": "1", "jobs": [ … ] }`; with an id `{ "schemaVersion": "1", "job", "counts", "errors": [ … ] }` |

`report.operations[]` entries are `{ seq, verb, status: "applied" | "failed" | "skipped", result?, error? }`. Failures print the standard error shape, `{ "error": { "code", "message", "details" } }`. For a script error, `details.kind` holds the error kind. For drift or a failed write, `details.report` holds the report.

## atlcli.render

```ts
const summary = await atlcli.render("Audit {{year}}: {{source.summary}}", { source: issue.fields });
const body = await atlcli.render(page.storage, { format: "storage", parent: { title } });
```

Renders a [template](/templating/) with the run's `--var`/`--vars-file`
values and the frozen `--now`. It is not a write and needs no permission.

| Option | Type | Default | Notes |
|---|---|---|---|
| `vars` | object | none | Merged over the run's values for this call |
| `format` | `"text"`, `"adf"`, `"storage"`, `"wikimarkup"` | a string is text, an object ADF | Storage and wiki markup must be named |
| `source` | any JSON | none | Available as `{{source.…}}` |
| `parent` | any JSON | none | Available as `{{parent.…}}` |
| `unit` | string | `render#<n>` | Names the value in warnings |

Unresolved expressions stay as written; each becomes a template warning in the
plan (`plan.renderWarnings`) and in the text output. With `--strict` the first
call that warns ends the run. The plan records the clock as
`plan.templating.now`.

## Exit codes and error kinds

| Exit | Meaning |
|---|---|
| 0 | Planned, or applied |
| 1 | Script error, failed write, invalid plan, usage error, or a job that stopped early |
| 2 | Drift: targets changed since the plan; nothing written |

| Kind | Cause |
|---|---|
| `guest` | The script threw, including errors returned by Jira or Confluence |
| `invalid-script` | Syntax error, an import, invalid `meta` or params |
| `permission-denied` | A verb outside `meta.permissions` |
| `write-limit` | More writes than `meta.limits.maxWrites` |
| `interrupted` | CPU time limit (busy loop) |
| `deadline` | Run time limit while waiting |
| `memory` | Memory limit |
| `host-call-limit` | More calls than `--max-calls` |
| `template` | `atlcli.render` with `--strict` and warnings, or a template output limit |

## Related topics

- [Automation Scripts](../scripts.md): the guide, with examples and troubleshooting
- [Per-Issue Script Jobs](../script-jobs.md): running a script over thousands of issues
- [Scripts in CI](../recipes/scripts-in-ci.md): plans as pull request artifacts, apply after approval
- [CLI Commands](cli-commands.md#scripts): the command overview
- [Authentication](../authentication.md): profiles a script runs with
