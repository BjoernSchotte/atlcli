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
- [Placeholders](#placeholders)
- [Preconditions](#preconditions)
- [Sandbox limits](#sandbox-limits)
- [Unchanged updates](#unchanged-updates)
- [Plan file](#plan-file)
- [JSON output](#json-output)
- [Exit codes and error kinds](#exit-codes-and-error-kinds)
- [Related topics](#related-topics)

## Commands

| Command | What it does |
|---|---|
| `atlcli script run <file>` | Runs the script and prints the plan. Writes nothing |
| `atlcli script run -e <code>` | Same, for inline code (`--eval` is the long form) |
| `atlcli script apply <plan.json>` | Applies a plan written with `--plan-out` |
| `atlcli script check <file>` | Validates `meta`; type-checks with `tsc --noEmit` when `tsc` is on `PATH` |
| `atlcli script init [dir]` | Writes `atlcli.d.ts`, `tsconfig.json` and `example.ts` (default dir: `.`) |

| Flag | Commands | Type | Default | Notes |
|---|---|---|---|---|
| `--param <name=value>` | run | string, repeatable | none | Available as `atlcli.params`; typed when declared in `meta.params` |
| `--plan-out <file>` | run | path | none | Writes the plan file, also when `--apply` is given |
| `--apply` | run | switch | off | Applies after planning; asks first |
| `--yes` | run, apply | switch | off | Applies without asking. Required without a terminal or with `--json` |
| `--profile <name>` | run, apply | string | active profile | Also `ATLCLI_PROFILE` |
| `--timeout <duration>` | run | `90s`, `10m`, `1h`, `500ms`; bare number = seconds | `5m` | Whole run, CPU and waiting |
| `--max-writes <n>` | run | positive integer | `meta.limits.maxWrites`, else 100 | Overrides `meta.limits.maxWrites` |
| `--max-calls <n>` | run | positive integer | 10,000 | Jira and Confluence calls per run |
| `--memory <MB>` | run | positive integer | 64 | Script memory |
| `--json` | all | switch | off | One JSON document on stdout; script output stays on stderr |
| `--force` | init | switch | off | Overwrites `tsconfig.json` and `example.ts`; `atlcli.d.ts` is always refreshed |

## Globals

| Name | Type | Notes |
|---|---|---|
| `atlcli.params` | `Readonly<Record<string, string \| number \| boolean>>` | Frozen. Strings unless declared in `meta.params` |
| `atlcli.jira`, `atlcli.confluence` | objects of verbs | Frozen; see [Verbs](#verbs) |
| `console.log`, `info`, `warn`, `error` | functions | To stderr; objects are printed as JSON |
| `export default` | value or function | Optional. A function is awaited with `atlcli.params`; its result, or the value, becomes `plan.value` |

The sandbox has no `fetch`, timers, `process`, `require`, file system or imports.

## meta

Optional. It is read statically before the script runs, so it must be written as `export const meta = { … }` with literal values only.

| Field | Type | Default | Required | Constraints |
|---|---|---|---|---|
| `name` | string | file name, `inline` for `-e` | no | lowercase letters, digits, `-` |
| `description` | string | none | no | |
| `permissions` | string[] | none: all verbs allowed | no | each `jira:read`, `jira:write:<PROJECT>`, `confluence:read` or `confluence:write:<SPACE>`. Once given, everything else is denied |
| `limits.maxWrites` | integer | 100 | no | > 0; most operations in one plan |
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
| `jira.search(jql, { fields?, limit? })` | async iterator of `{ id, key, fields }` | `jira:read` | read; pages of 100 |
| `jira.get(key, { fields? })` | `{ id, key, fields }`, `fields.updated` always present | `jira:read` | read |
| `jira.create({ project, type, summary, description?, fields? })` | `{ id, key }` placeholders | `jira:write:<project>` | create; no precondition |
| `jira.update(key, { summary?, description?, fields? })` | `null` | `jira:write:<project of key>` | update; issue unchanged |
| `jira.transition(key, to)` | `null` | `jira:write:<project of key>` | transition; issue unchanged. `to` is matched by name, ignoring case; checked against the issue's transitions when the issue exists |
| `jira.comment(key, markdown)` | `{ id }` placeholder | `jira:write:<project of key>` | comment; no precondition |

`description` and comment bodies are Markdown. They become Atlassian Document Format on Cloud and stay text on Data Center. `fields` passes raw Jira field values through (`{ labels: ["x"], priority: { name: "High" } }`).

### Confluence

| Verb | Returns | Permission | Plan |
|---|---|---|---|
| `confluence.search(cql, { limit? })` | async iterator of `{ id, title, spaceKey }` | `confluence:read` | read; pages of 100 |
| `confluence.getPage(id)` | `{ id, title, spaceKey, version, parentId?, markdown }` | `confluence:read` | read |
| `confluence.createPage({ space, title, markdown, parentId? })` | `{ id }` placeholder | `confluence:write:<space>` | create; title still absent |
| `confluence.updatePage(id, { title?, markdown })` | `{ id }` | `confluence:write:<space of page>` | replaces the body; page version unchanged. Keeps the title unless given. Left out when body and title would not change |
| `confluence.upsertPage({ space, title, markdown, parentId? })` | `{ id, created }` | `confluence:write:<space>` | becomes an update of the page with that exact title, else a create |
| `confluence.addLabels(pageId, labels)` | `null` | `confluence:write:<space of page>` | labels; no precondition |

Creating the same title twice in one plan is an error; use `upsertPage`, which also finds pages the plan itself creates.

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
| Issue unchanged | `jira.update`, `jira.transition` | `fields.updated` is the same |
| Page unchanged | `confluence.updatePage`, `upsertPage` on an existing page | `version` is the same |
| Title absent | `confluence.createPage`, `upsertPage` on a new page | no page with that title in the space |

All preconditions are checked before the first write. If any fails, nothing is written. Between that check and each write there is a short window. A concurrent page edit in it makes the update fail on the version check. A concurrent issue edit in it is overwritten, because Jira has no conditional update.

## Sandbox limits

| Limit | Default | Set with | When hit |
|---|---|---|---|
| Memory | 64 MB | `--memory` | `memory` |
| Stack | 512 KB | fixed | `guest` (stack overflow) |
| Run time, CPU and waiting | 5 minutes | `--timeout` | `interrupted` (busy loop) or `deadline` (waiting) |
| One Jira or Confluence call | 60 seconds | fixed | catchable error `Host call timed out` |
| Calls per run | 10,000 | `--max-calls` | `host-call-limit` |
| Planned writes | 100 | `meta.limits.maxWrites`, `--max-writes` (wins) | `write-limit` |

`host-call-limit`, `write-limit` and `permission-denied` end the run even if the script catches the error.

## Unchanged updates

The first `updatePage` to a page in a run, or the `upsertPage` that turns into one, is compared with the page as it is now. Both bodies go through the same Markdown → Storage → Markdown conversion. If title and body are equal, no operation is planned. The write appears in `skipped` instead, and the text output lists it as `Unchanged, not planned`. Later writes to a page the plan already changed are always kept, because reads show the state before the plan.

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
| `skipped[]` | array | `{ verb, target, title?, reason: "unchanged" }`; writes left out, see [Unchanged updates](#unchanged-updates) |
| `value` | JSON | the script's result |
| `digest` | hex | SHA-256 over the canonical JSON of all other fields |

`apply` refuses a file whose digest does not match, whose operations are out of order, or whose `target.baseUrl` differs from the profile's site.

## JSON output

| Command | stdout |
|---|---|
| `run` | `{ "schemaVersion": "1", "plan": { … } }` |
| `run --apply`, `apply` | `{ "schemaVersion": "1", "plan": { … }, "report": { "status": "applied", "drift": [], "operations": [ … ] } }` |
| `check` | `{ "schemaVersion": "1", "meta": { … }, "typecheck": { "status": "ok" \| "skipped" \| "errors", … } }` |
| `init` | `{ "schemaVersion": "1", "dir": "…", "written": [ … ], "kept": [ … ] }` |

`report.operations[]` entries are `{ seq, verb, status: "applied" | "failed" | "skipped", result?, error? }`. Failures print the standard error shape, `{ "error": { "code", "message", "details" } }`. For a script error, `details.kind` holds the error kind. For drift or a failed write, `details.report` holds the report.

## Exit codes and error kinds

| Exit | Meaning |
|---|---|
| 0 | Planned, or applied |
| 1 | Script error, failed write, invalid plan, usage error |
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
| `host-call-limit` | More than 10,000 calls |

## Related topics

- [Automation Scripts](../scripts.md): the guide, with examples and troubleshooting
- [Scripts in CI](../recipes/scripts-in-ci.md): plans as pull request artifacts, apply after approval
- [CLI Commands](cli-commands.md#scripts): the command overview
- [Authentication](../authentication.md): profiles a script runs with
