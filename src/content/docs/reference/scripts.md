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
- [HTTP and secrets](#http-and-secrets)
- [Files](#files)
- [State](#state)
- [Imports](#imports)
- [Script tests](#script-tests)
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
| `atlcli script check <file>` | Validates `meta` and imports; type-checks with `tsc --noEmit` when `tsc` is on `PATH` |
| `atlcli script test <file\|dir>` | Replays the recorded cases in `<name>.test.json` without a site and compares the plans. See [Script tests](#script-tests) |
| `atlcli script test <file> --record <case>` | Plans once against the site (nothing changes) and stores what the script read and planned as a case |
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
| `--now <iso>` | run | ISO date/time | time of planning | Clock for `today`/`now`; recorded in the plan |
| `--strict` | run | switch | off | Any template warning ends the run (`template` error kind) |
| `--json` | all | switch | off | One JSON document on stdout; script output stays on stderr |
| `--force` | init | switch | off | Overwrites `tsconfig.json` and `example.ts`; `atlcli.d.ts` is always refreshed |
| `--record <case>` | test | string | none | Records (or re-records) the case; takes `--param`, `--each <KEY>`, `--var`, `--now`, `--profile` |
| `--case <name>` | test | string | all cases | Runs one case |
| `--update` | test | switch | off | Rewrites each case's expected plan from what the script plans now |

## Globals

| Name | Type | Notes |
|---|---|---|
| `atlcli.params` | `Readonly<Record<string, string \| number \| boolean>>` | Frozen. Strings unless declared in `meta.params` |
| `atlcli.jira`, `atlcli.confluence` | objects of verbs | Frozen; see [Verbs](#verbs) |
| `atlcli.render(input, options?)` | function | Renders a template; see [atlcli.render](#atlclirender) |
| `atlcli.http` | object of verbs | External HTTP; see [HTTP and secrets](#http-and-secrets) |
| `atlcli.secret(name)` | function, synchronous | A reference to a secret for HTTP requests, never its value; see [HTTP and secrets](#http-and-secrets) |
| `atlcli.files` | object of verbs | Local files below the working directory; see [Files](#files) |
| `atlcli.state` | object of verbs | The script's key-value store between runs; see [State](#state) |
| `console.log`, `info`, `warn`, `error` | functions | To stderr; objects are printed as JSON |
| `export default` | value or function | Optional. A function is awaited with `atlcli.params`; its result, or the value, becomes `plan.value`. In a per-issue job it is required and called as `default(issue, params)` |

The sandbox has no `fetch`, timers, `process` or `require`. HTTP, files and state go through `atlcli.*`; other files of the script load with relative [imports](#imports).

## meta

Optional. It is read statically before the script runs, so it must be written as `export const meta = { … }` with literal values only.

| Field | Type | Default | Required | Constraints |
|---|---|---|---|---|
| `name` | string | file name, `inline` for `-e` | no | lowercase letters, digits, `-` |
| `description` | string | none | no | |
| `permissions` | string[] | none: all Jira, Confluence and file verbs allowed | no | each `jira:read`, `jira:write:<PROJECT>`, `jira:write:*`, `confluence:read`, `confluence:write:<SPACE>`, `confluence:write:*`, `file:read`, `file:write` or `http:<host>`. Once given, everything else is denied. HTTP always needs an `http:` grant |
| `secrets` | string[] | none | for `atlcli.secret` | upper-case letters, digits and `_`; each must be set as `ATLCLI_SECRET_<NAME>` where the script runs and where the plan is applied |
| `limits.maxWrites` | integer | 10,000 | no | > 0; most operations in one plan |
| `each.jql` | string | none | no | Per-issue mode: the issues the default export runs for. `--each` overrides it |
| `each.fields` | string[] | `summary`, `status`, `assignee`, `priority`, `issuetype`, `labels` | no | Fields each issue comes with |
| `params.<name>.type` | `"string"` \| `"number"` \| `"boolean"` | none | yes, per param | name: letters, digits, `_`, not starting with a digit |
| `params.<name>.default` | matches `type` | none (then the param is required) | no | |
| `params.<name>.description` | string | none | no | |

Grants:

| Grant | Allows |
|---|---|
| `jira:write:*`, `confluence:write:*` | writes to every project or space, and the REST writes (`jira.request` on a path that names no project, `confluence.request`) |
| `file:read`, `file:write` | `files.read`/`files.list`, `files.write` |
| `http:hooks.slack.com` | HTTP to that host on its default port |
| `http:*.example.com` | every subdomain of `example.com`, not `example.com` itself |
| `http:localhost:8080` | that host and port; plain `http:` works only for `localhost`, `127.0.0.1` and `[::1]` |

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
| `jira.transition(key, to, { fields?, comment? })` | `null` | `jira:write:<project of key>` | transition; issue unchanged. `to` is matched by name, ignoring case; checked against the issue's transitions when the issue exists. `fields` are set on the transition screen as raw Jira values (e.g. `{ resolution: { name: "Done" } }`); `comment` is Markdown, added with the transition |
| `jira.setStatus(key, status, { fields?, comment? })` | `null` | `jira:write:<project of key>` | best-effort transition; issue unchanged. On apply, takes a transition available then whose target status (or name) is `status`; with none, nothing changes and the apply output lists it under `Status unchanged`. For issues whose workflow is not known at plan time, such as ones the plan creates. Left out when the issue already has that status |
| `jira.transitions(key)` | `[{ name, to: { name, category? } }]` | `jira:read` | read; transitions available now. `category` is `new`, `indeterminate` or `done` |
| `jira.history(key, { fields? })` | `[{ at, author?, field, from, to }]` | `jira:read` | read; the issue's changes, oldest first; `fields` limits them, e.g. `["status"]` |
| `jira.watchers(key)` | `[{ accountId?, displayName? }]` | `jira:read` | read |
| `jira.addWatcher(key, user)` | `null` | `jira:write:<project of key>` | watcher; no precondition. `user` resolved like `assign`. Left out when the user already watches |
| `jira.removeWatcher(key, user)` | `null` | `jira:write:<project of key>` | watcher; no precondition. Left out when the user does not watch |
| `jira.notify(key, { subject, markdown, to })` | `null` | `jira:write:<project of key>` | e-mail sent by Jira on apply; no precondition. `to`: `users` (resolved like `assign`), `groups`, `reporter`, `assignee`, `watchers`, `voters`; at least one |
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
| `jira.request(method, path, { body?, query? })` | `{ id, key }` placeholders | `jira:write:<project>` when the path names an issue or project (`/issue/ABC-1…`, `/project/ABC…`), else `jira:write:*` | REST write; no precondition. `method` is `POST`, `PUT`, `PATCH` or `DELETE`; `path` follows the `jira.rest` rules. Once applied, the placeholder stands for the response's `key` or `id` |
| `jira.comments(key)` | `[{ id, author?, created?, updated?, markdown }]` | `jira:read` | read; all comments, oldest first |
| `jira.updateComment(key, commentId, body)` | `null` | `jira:write:<project of key>` | edit; no precondition. `body` as for `comment` |
| `jira.deleteComment(key, commentId)` | `null` | `jira:write:<project of key>` | delete; no precondition |
| `jira.worklogs(key)` | `[{ id, author?, started, timeSpentSeconds, markdown? }]` | `jira:read` | read |
| `jira.addWorklog(key, { timeSpent, started?, comment? })` | `{ id }` placeholder | `jira:write:<project of key>` | worklog; no precondition. `timeSpent` is `"1h 30m"`, `"2d"` (1d = 8h, 1w = 5d) or seconds; `comment` is Markdown |
| `jira.versions(project)` | `[{ id, name, project?, description?, released, archived, startDate?, releaseDate? }]` | `jira:read` | read |
| `jira.createVersion(project, { name, description?, startDate?, releaseDate?, released?, archived? })` | `{ id }` placeholder, or the existing version's id | `jira:write:<project>` | create; dates as `2026-11-01`. Left out when the project has a version of that name |
| `jira.updateVersion(id, { name?, description?, startDate?, releaseDate?, released?, archived? })` | `null` | `jira:write:<project of version>` | update; `released: true` releases it. Left out when nothing changes |
| `jira.components(project)` | `[{ id, name, project?, description?, lead? }]` | `jira:read` | read |
| `jira.createComponent(project, { name, description?, lead? })` | `{ id }` placeholder, or the existing component's id | `jira:write:<project>` | create; `lead` resolved like `assign`. Left out when the name exists |
| `jira.updateComponent(id, { name?, description?, lead? })` | `null` | `jira:write:<project of component>` | update. Left out when nothing changes |
| `jira.rank(keys, { before } \| { after })` | `null` | `jira:write` for every issue's project | rank; no precondition. Puts `keys`, in this order, right before or after the other issue |
| `jira.deleteIssue(key, { subtasks? })` | `null` | `jira:write:<project of key>` | delete (no trash); issue unchanged. `subtasks: true` deletes its subtasks too |
| `jira.clone(key, { project?, summary?, link?, attachments? })` | `{ id, key }` placeholders | `jira:read`, `jira:write:<target project>` | create; no precondition. Copies summary, description, type and labels, and within the project its components and parent; links the clone as "Cloners" unless `link: false` |
| `jira.links(key)` | `[{ id, type, direction, phrase, issue: { key, summary?, status? } }]` | `jira:read` | read; `direction` is `outward` ("blocks") or `inward` ("is blocked by") |
| `jira.unlink(key, linkId)` | `null` | `jira:write:<project of key>` | removes the link; left out when the issue has no such link |
| `jira.fields()` | `[{ id, name, custom, type? }]` | `jira:read` | read; once per run |
| `jira.fieldId(name)` | string | `jira:read` | the id of a field by id or name, ignoring case: `fieldId("Story Points")` → `"customfield_10016"`. Two fields of that name are an error naming both ids |
| `jira.users(query)` | `[{ accountId?, name?, displayName?, email?, active }]` | `jira:read` | read; users matching a name or email |
| `jira.attachments(key)` | `[{ id, filename, size, mimeType, created?, author? }]` | `jira:read` | read |

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
| `confluence.archivePage(id)` | `null` | `confluence:write:<space of page>` | archives the page; page version unchanged. Confluence archives in the background, so the page can read as current for a moment |
| `confluence.attachments(pageId)` | `[{ id, name, mediaType, size, version }]` | `confluence:read` | read |
| `confluence.attach(pageId, { name, content, encoding? })` | `{ id }` placeholder | `confluence:write:<space of page>` | attachment; no precondition. An attachment of the same name gets a new version |
| `confluence.copyAttachment(attachmentId, sourcePageId, toPageId)` | `{ id }` | `confluence:write:<space of target>` | copies the bytes host-side when applied; left out when the target already has a file of that name and size |
| `confluence.export(pageId, { format, path? })` | `{ path }` | `confluence:read` | writes a local `pdf` or `docx` file when applied. See [Exports](#exports) |
| `confluence.request(method, path, { body?, query? })` | `{ id }` placeholder | `confluence:write:*` | REST write below the Confluence base (`/rest/api/…`, `/api/v2/…`); no precondition |
| `confluence.properties(pageId)` | `{ [key]: value }` | `confluence:read` | read; all content properties |
| `confluence.setProperty(pageId, key, value)` | `null` | `confluence:write:<space of page>` | property; left out when it already has this value |
| `confluence.deleteProperty(pageId, key)` | `null` | `confluence:write:<space of page>` | property; left out when the page has no such key |
| `confluence.restrictions(pageId)` | `{ read: { accountIds, groupIds }, update: { accountIds, groupIds } }` | `confluence:read` | read |
| `confluence.setRestrictions(pageId, { read?, update? })` | `null` | `confluence:write:<space of page>` | replaces the given operations' users and groups; an operation left out keeps its own. Left out when nothing changes |
| `confluence.versions(pageId)` | `[{ number, when?, by?, message?, minorEdit? }]` | `confluence:read` | read; newest first, up to 200 |
| `confluence.descendants(pageId, { limit? })` | async iterator of `{ id, title, spaceKey }` | `confluence:read` | read; every page below it, at any depth (CQL `ancestor`) |
| `confluence.spaces({ type?, limit? })` | async iterator of `{ id?, key, name, type }` | `confluence:read` | read; `type` is `global` or `personal` |
| `confluence.inlineComments(pageId)` | `[{ id, authorId?, created?, status?, selection?, markdown, replies }]` | `confluence:read` | read; Cloud |
| `confluence.createBlogPost({ space, title, markdown })` | `{ id }` placeholder | `confluence:write:<space>` | create; read it back with `getPage` |

Creating the same title twice in one plan is an error; use `upsertPage`, which also finds pages the plan itself creates.

Comments, labels and attachments do not change a page's version, so they never take the version precondition away from a later `updatePage` on the same page.

### Attachments

Attachment content comes from the script, for example read with [`files.read`](#files): text by default, or base64 with `encoding: "base64"`. The limit is 10 MB per attachment after decoding. The content is stored in the plan file, so a plan with attachments grows by their size.

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

## HTTP and secrets

| Verb | Returns | Permission | Plan |
|---|---|---|---|
| `http.get(url, { headers?, query? })` | `{ status, headers, text, json? }` | `http:<host>` | read, while planning. Follows up to five redirects, each checked against the grants; `authorization` and `cookie` do not follow to another origin. Every status comes back; none throws. `json` is set for JSON responses. Up to 10 MB |
| `http.request(method, url, { headers?, body?, json? })` | `null` | `http:<host>` | planned; sent on apply. `method` is `POST`, `PUT`, `PATCH` or `DELETE`; `json` sets the body and `content-type`. A status of 300 or more fails the operation |
| `secret(name)` | string | name in `meta.secrets` | a reference (`{secret:NAME}`), synchronous |

URLs are `https:` only; plain `http:` works for `localhost`, `127.0.0.1` and `[::1]`. Credentials in the URL (`user:pw@`) are refused; send them in a header. Hosts that resolve to private, loopback or link-local addresses are refused, except the local names above. Each call has 60 seconds.

`atlcli.secret("NAME")` never hands the script the value. It returns a reference that the host replaces with the value of the environment variable `ATLCLI_SECRET_NAME`, only in the URL, headers and body of an HTTP request: right away for `http.get`, on apply for `http.request`. Plans, journals, script output and test fixtures hold only the reference, and a value a service echoes back reaches the script as the reference again. A secret cannot be part of a URL's host. A declared secret that is not set fails the run before any code runs.

```ts
export const meta = { permissions: ["jira:read", "http:hooks.slack.com"], secrets: ["SLACK_WEBHOOK"] };

let open = 0;
for await (const _ of atlcli.jira.search("project = ATLCLI AND priority = Highest AND statusCategory != Done")) open++;
await atlcli.http.request("POST", `https://hooks.slack.com/services/${atlcli.secret("SLACK_WEBHOOK")}`, {
  json: { text: `${open} open blockers in ATLCLI` },
});
```

## Files

| Verb | Returns | Permission | Plan |
|---|---|---|---|
| `files.read(path, { encoding? })` | string | `file:read` | read; up to 10 MB; `encoding: "base64"` for binary files |
| `files.list(dir?)` | `[{ name, type, size }]` | `file:read` | read; `type` is `file` or `directory`; default `.` |
| `files.write(path, content, { encoding? })` | `{ path }` | `file:write` | planned; written on apply, folders created, an existing file replaced. Left out when the file already has this content |

Paths are relative to the working directory, use `/`, and contain no `..` or empty segments. A symbolic link that leads outside the working directory is refused, and `files.write` never writes through a link. Writing one path twice in a plan is an error. Paths are checked when planning and again on apply, because a plan file can be edited. The content travels in the plan file.

## State

| Verb | Returns | Plan |
|---|---|---|
| `state.get(key)` | the value, or `null` | read |
| `state.set(key, value)` | `null` | planned; JSON values up to 1 MB. Left out when the key already has this value |
| `state.delete(key)` | `null` | planned; left out when the key is not set |

Each script has one store, named after `meta.name` or the file name, kept as JSON in `~/.atlcli/state/<name>.json` and written atomically. No permission is needed. Reads go live and do not see the plan's own `set`. The first write to a key records the value it planned against; if another run changed the key before this plan is applied, that is drift and nothing is written.

```ts
const since = (await atlcli.state.get("since")) ?? "-7d";
for await (const issue of atlcli.jira.search(`project = ATLCLI AND created >= "${since}"`)) {
  await atlcli.jira.addLabels(issue.key, ["new"]);
}
await atlcli.state.set("since", new Date().toISOString().slice(0, 10));
```

## Imports

A script can import other files relatively: `import { line } from "./lib/format.ts"`. `.ts`, `.js`, no extension and `index.ts` resolve as usual. Only files below the script's directory load; packages, `node:` modules, URLs and paths leaving the directory are refused before the script runs. Imported files are type-stripped like the script.

`script.sha256` in the plan covers the script and every file it imports, so a changed helper changes the plan. A per-issue job keeps the imported files with its script, so `resume` runs the same code. Audit rule scripts can import helpers the same way. `atlcli script init` writes a `tsconfig.json` that type-checks imported files.

## Script tests

`atlcli script test` checks a script without a site. A case is recorded once against the site and replayed offline:

1. `atlcli script test triage.ts --record "two open bugs"` plans the script against the site (nothing changes). Every Jira, Confluence, HTTP, file and state read goes to `triage.test.json` next to the script, with the planned operations as the expected result. With `--each ATLCLI-12` the case runs for one issue of a per-issue script.
2. `atlcli script test triage.ts` (or a directory) replays each case: reads come from the fixture, and the plan must equal the expected one: operations, unchanged writes and result. A difference fails with a diff (`-` expected, `+` actual). A read the fixture has no answer for fails and names the call.
3. After an intended change, `--update` rewrites the expected plans.

A script that exports `function test(plan)` gets it called after each case with `{ operations, skipped, value }`; a thrown error fails the case. A case may then leave out `expect`.

The test file:

| Field | Notes |
|---|---|
| `schema` | `"atlcli.script-test/1"` |
| `baseUrl` | site the cases were recorded against; Markdown conversion uses it |
| `cases[].name` | unique per file |
| `cases[].params`, `item`, `now`, `vars` | parameters, the issue (per-issue scripts), the frozen clock and template values |
| `cases[].fixture.calls[]` | `{ method, args, result }` or `{ method, args, error }` per host read, in order; repeated identical calls answer in order, then repeat the last |
| `cases[].expect` | `{ operations, skipped, value }` |

The fixture holds what the script read from the site: review it before committing it. Secret values are never recorded; replays use stand-ins. Exit code 1 when a case fails.

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
| Issue unchanged | `jira.update`, `jira.transition`, `jira.setStatus`, `jira.assign`, `jira.addLabels`, `jira.removeLabels`, `jira.deleteIssue` | `fields.updated` is the same |
| Attachment unchanged | `jira.copyAttachment` (on the source attachment) | the attachment still exists with the same size |
| Sprint unchanged | `jira.updateSprint` on an existing sprint | `state` is the same |
| Page unchanged | `confluence.updatePage`, `upsertPage` on an existing page, `movePage`, `deletePage`, `archivePage` | `version` is the same |
| Title absent | `confluence.createPage`, `upsertPage` on a new page | no page with that title in the space |
| State unchanged | `state.set`, `state.delete` | the key holds the value the plan saw (or is still unset) |

All preconditions are checked before the first write. If any fails, nothing is written. Between that check and each write there is a short window. A concurrent page edit in it makes the update fail on the version check. A concurrent issue edit in it is overwritten, because Jira has no conditional update.

## Sandbox limits

| Limit | Default | Set with | When hit |
|---|---|---|---|
| Memory | 64 MB | `--memory` | `memory` |
| Stack | 512 KB | fixed | `guest` (stack overflow) |
| Run time, CPU and waiting | 1 hour (jobs: 60 seconds per issue) | `--timeout`; `0` = none | `interrupted` (busy loop) or `deadline` (waiting) |
| One Jira, Confluence or HTTP call | 60 seconds | fixed | catchable error `Host call timed out` |
| HTTP response, file read or write | 10 MB | fixed | catchable error |
| State value | 1 MB serialized | fixed | catchable error |
| Calls per run | 100,000 (jobs: 500 per issue) | `--max-calls`; `0` = none | `host-call-limit` |
| Planned writes | 10,000 (jobs: 50 per issue) | `meta.limits.maxWrites`, `--max-writes` (wins); `0` = none | `write-limit` |

`host-call-limit`, `write-limit` and `permission-denied` end the run even if the script catches the error.

## Unchanged updates

The first `updatePage` to a page in a run, or the `upsertPage` that turns into one, is compared with the page as it is now. Both bodies go through the same Markdown → Storage → Markdown conversion. If title and body are equal, no operation is planned. The write appears in `skipped` instead, and the text output lists it as `Unchanged, not planned`. Later writes to a page the plan already changed are always kept, because reads show the state before the plan.

The same applies to the first write of these verbs to an object:

| Verb | Left out when |
|---|---|
| `jira.assign` | the issue already has that assignee (or none, for `null`) |
| `jira.addWatcher` / `jira.removeWatcher` | the user already watches / does not watch |
| `jira.addLabels` | every label is already set |
| `jira.removeLabels` | none of the labels is set |
| `jira.setStatus` | the issue already has that status |
| `jira.copyAttachment` | the target issue already has an attachment with that filename and size |
| `confluence.movePage` | the page already has that parent |
| `jira.createVersion` / `jira.createComponent` | the project has one of that name (its id is returned) |
| `jira.updateVersion` / `jira.updateComponent` | every given field already has that value |
| `jira.unlink` | the issue has no such link |
| `confluence.setProperty` / `deleteProperty` | the property already has that value / is not set |
| `confluence.setRestrictions` | the restrictions are already those users and groups |
| `files.write` | the file already has that content |
| `state.set` / `state.delete` | the key already has that value / is not set |

Other verbs are always planned. Re-running a script that only uses verbs from this section and `updatePage`/`upsertPage` therefore plans nothing once its work is done.

## Plan file

`--plan-out` writes canonical JSON (sorted keys), so equal plans are equal bytes.

| Field | Type | Notes |
|---|---|---|
| `schema` | `"atlcli.script-plan/1"` | |
| `createdAt` | ISO 8601 | |
| `script.name` | string | `meta.name`, else the file name, else `inline` |
| `script.path` | string | relative to the working directory; absent for `-e` |
| `script.sha256` | hex | SHA-256 of the script source and every file it imports |
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
