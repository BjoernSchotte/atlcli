# Copy a recurring Jira project with `atlcli script`

Status: plan, not implemented.

## Use case

A team runs the same project every cycle, for example a yearly internal audit:
one Jira project, one issue per control, each with a description of what to
check and an attached evidence template. For the next cycle they want a fresh
project with the same issues, descriptions and attachments intact, while
workflow state starts from zero: no status history, no assignee, no dates.

CSV export and re-import loses attachments and rich text, and "create project
with shared settings" copies only configuration, not issues.

The same shape covers recurring processes in general: releases, onboarding,
QA passes. Each run is a fresh set of issues created from a curated template
project, for example `TPL-RELEASE`, instead of from whatever ran last time. A
process change then goes into the template once, rather than into scattered
automation rules, and each run starts clean: no inherited comments, assignees
or steps nobody remembers adding.

A third case is splitting a project. Tickets that piled up in one project,
for example dev work on a support board, get a new home project. Some are
moved with Jira's own bulk move. Others must stay where they are, because
the old team still reports on them, and get cloned in bulk instead:
hundreds at once, with their subtasks and links, a link back to the
original, and optionally comments, assignee and status. The original keeps
its full history; the copy cannot have it, because the Jira API cannot write
a change history or backdate comments.

## What already works

| Need | Today |
|------|-------|
| Create the empty target project | `atlcli jira project create` (outside the sandbox) |
| Iterate over the source issues | `jira.search(jql, { fields })` |
| Create issues in the target | `jira.create({ project, type, summary, fields })` |
| Rebuild links between controls | `jira.link(from, type, to)` with `plan:n` references |
| Parent/epic structure | `jira.create({ fields: { parent: { key: "plan:n" } } })` |
| Labels | `fields.labels` on create |
| Reset status/assignee/dates | nothing to do: those fields are simply not copied |
| Review before writing | dry-run plan, `--apply` to execute |

## Gaps

### 1. Copying attachments (blocker)

`jira.attach` carries the file content inside the plan (utf8 or base64, at most
`MAX_ATTACHMENT_BYTES` = 10 MB decoded), and the script would first have to
read the bytes, which the sandbox cannot do at all. Evidence templates are
often larger, and binary content in the plan file makes plans huge.

Also, both client methods hold the whole file in memory:
`JiraClient.downloadAttachment()` returns a `Buffer`, and
`uploadAttachment()` takes one.

### 2. Lossless descriptions (verify, then document)

`jira.create({ description })` takes Markdown and converts it, so ADF to
Markdown to ADF loses panels, tables with merged cells, mentions and media.

The host already spreads `fields` before setting `description`, so
`jira.create({ fields: { description: source.fields.description } })` passes
the raw value through: ADF on Cloud, wiki markup on Data Center. This is
untested and undocumented, and when both `description` and
`fields.description` are given, the Markdown one silently wins.

### 3. Custom fields across projects (docs only)

Custom field ids (`customfield_10xxx`) are site-wide. They carry over when the
target project uses the same field configuration and screens, which "shared
settings" gives you. Otherwise `create` fails with Jira's field error at apply
time. That is acceptable, but the guide must say so.

## Design

### New write verb `jira.copyAttachment`

```ts
jira.copyAttachment(attachmentId: string, toIssue: string): PlanRef
```

- `attachmentId` is an id from `jira.get(key, { fields: ["attachment"] })`.
  `toIssue` is an issue key or a `plan:n` reference to an issue this plan
  creates.
- **Plan time:** the verb reads the attachment metadata
  (`GET /attachment/{id}` via the existing `getAttachment`). It records
  `{ attachmentId, to, filename, size }` in the plan and fails early if the
  attachment does not exist. **No bytes go into the plan.**
- **Precondition** `jira-attachment-unchanged { id, size }`: Jira attachments
  are immutable, so an existing id with the same size proves the source is
  the one that was reviewed. A deleted source fails apply cleanly, before the
  upload.
- **Apply:**
  1. Create a private temp dir: `mkdtemp(join(tmpdir(), "atlcli-attach-"))`,
     mode 0700.
  2. Stream the download into `<dir>/<id>`:
     `Bun.write(path, response)` writes the body as it arrives, so RAM stays
     flat.
  3. Compare the written size with the recorded size; on a mismatch, abort
     without uploading.
  4. Upload with `Bun.file(path)` as the multipart part, under the original
     filename. Bun reads the file lazily while sending, and a retry simply
     re-reads it.
  5. Remove the temp dir in `finally`, on success, error and abort alike.
- **No-op skip** like the other verbs: if the target issue already has an
  attachment with the same filename and size, the operation is skipped. That
  makes a re-run after a partial apply safe.
- It is a PRODUCER: the result `plan:n` is the new attachment id.
- The only remaining limit is the Jira attachment size limit of the target
  site. No `MAX_ATTACHMENT_BYTES` check applies, because nothing travels
  through the sandbox.

### One implementation, every surface

The copy is a capability of atlcli itself; the script verb is only one of its
surfaces. The logic lives once, and every surface calls it:

```
packages/jira  client.ts           downloadAttachmentToFile(), uploadAttachment(Blob)   (no fs; browser-safe)
packages/jira  attachment-copy.ts  copyAttachment(client, id, toKey, { signal })        (node-only: tmpdir, streams, cleanup, size check)
   ├── CLI     jira issue attachment copy <id>|<key> <filename> --to <key>
   ├── CLI     jira issue clone <key> --attachments
   └── script  jira.copyAttachment(id, toIssue)   (adds plan, precondition, no-op skip)
```

- `attachment-copy.ts` is exported from the node entry only, never from
  `index.browser.ts`, because it uses `node:fs` and `node:os` like `export.ts`.
  The extension bundle stays fs-free.
- `jira issue attachment copy` addresses the source the same way as
  `attachment download`: by id, or by key plus filename.
- `jira issue clone --attachments` copies every attachment of the source issue
  after the create. Clone already copies the description as raw ADF,
  losslessly, so it covers one control end to end. A failed attachment copy
  does not fail the clone: the new issue key is printed with a per-file
  warning, so nothing gets cloned twice.
- For a whole project there is `jira project copy-issues` (next section).

### `jira project copy-issues` (plan / apply)

```
atlcli jira project copy-issues (--from <project> [--jql "<extra filter>"] | --jql "<selection>")
    --to <project>
    [--no-attachments] [--no-links] [--no-subtasks] [--fields a,b]
    [--replace <find:replace> ...]
    [--link-source] [--comments] [--keep-assignee] [--keep-status]
    [--plan-out plan.json] [--apply] [--yes] [--max-writes <n>]
atlcli script apply plan.json        # applies a plan written by copy-issues
```

**Implementation: a built-in script, not a second engine.** The command runs a
script bundled with the CLI (`apps/cli/src/builtin-scripts/copy-issues.ts`,
embedded as text at build time) through the same sandbox, with its flags as
`meta.params`. As a result:

- **Same plan format.** The plan is `atlcli.script-plan/1`, with the built-in
  script's name and SHA-256 in `plan.script`. It renders with the existing
  `renderPlan`. `--plan-out`, `--apply`, `--yes` and `--json` behave exactly
  as in `script run`, so CLI parsing and the confirmation prompt are reused
  (factor out of `script.ts`).
- **Same apply.** `atlcli script apply plan.json` works unchanged: drift
  checks via preconditions, `plan:n` resolution, the no-op skips, the
  partial-apply report. There is no separate apply code path to secure.
- **Same limits.** Timeout, calls and memory work as in `script run`. The
  write budget defaults to the planned count, because the user reviews the
  plan; `--max-writes` caps it. A fixed 100 would make the command useless
  for real projects.
- **Readable source.** The built-in script doubles as the guide's example,
  and `atlcli jira project copy-issues --print-script` prints it, so a team
  can fork it into their own `atlcli script` when they need more.

**Selection.** With `--from`, the set is `project = FROM [AND (jql)]`. Without
it, `--jql` alone is the selection and may span several projects, for
example `project = SUP AND labels = dev`. Exactly one of the two forms must be
given, and the `--to` project is excluded from the selection, so a copy never
copies itself.

**Defaults and opt-ins.** The defaults fit the template and recurring cases:
clean copies. A bulk clone for a project split adds the opt-ins.

| Flag | Default | Effect |
|------|---------|--------|
| `--no-subtasks` | subtasks on | By default the subtasks (and other children) of every selected issue are added to the set even when the JQL does not match them |
| `--link-source` | off | Adds a "Cloners" link from each copy to its original, as `jira issue clone` does. A site without that link type gets one plan warning, and links are skipped |
| `--comments` | off | Copies comments in order as new comments, each headed "Originally by <display name> on <date>". Author and timestamp cannot be set through the API |
| `--keep-assignee` | off | Keeps the assignee when that user can be assigned in `TO` (checked at plan time); otherwise unassigned, with a warning |
| `--keep-status` | off | Best effort. After the create, if the new issue's first transitions offer a target status with the same name, that transition is planned; otherwise the copy stays in its initial status, with a warning. No multi-step path search across workflows |

**What the script plans, per source issue:**

1. **Order:** a parent comes before its children. The script collects all
   issues first, adds the subtasks unless `--no-subtasks`, then sorts them
   topologically by `parent`. A parent outside the set is dropped from the
   copy's parent field, with a `console.warn`.
2. `jira.create` in `TO`:
   - copies summary, issue type, raw description (ADF or DC wiki), labels,
     components and fix versions by name where they exist in `TO`, plus the
     custom fields listed in `--fields`
   - sets `parent` to the parent's `plan:n`
   - never sets status, assignee, reporter override, due date, start date or
     sprint
   - `--replace find:replace` (repeatable) applies to the summary and the
     description, as in `jira issue clone`. The CLI validates the flags with
     `parseReplacements` and passes the pairs as a param. The sandbox cannot
     import, so the built-in script carries a copy of `replaceInBody`: the
     same few lines (a reviver over `text` keys; a plain string on DC). A
     parity test runs both on the same ADF fixtures, so the two cannot
     drift. The description stays ADF. This is how a template carries placeholders such as
     `{{version}}` or `{{quarter}}`. A placeholder left over after the
     replacements is a plan warning that lists the issue key and the token
     (regex `\{\{[\w.-]+\}\}`), so a forgotten `--replace` is caught before
     apply.
3. `jira.copyAttachment` for each attachment (unless `--no-attachments`).
4. Links (unless `--no-links`), in a second pass once every issue has a ref:
   - a link between two copied issues is recreated between the copies
   - a link to an issue outside the set keeps its target (for example a
     shared policy issue)
   - each pair is planned once, not from both ends
5. **Opt-ins**, after the issue's create:
   - `--link-source`: `jira.link(copy, "Cloners", original)`
   - `--comments`: one `jira.comment` per source comment
   - `--keep-assignee`: the assignee on create
   - `--keep-status`: one `jira.transition` when a same-name target exists
   A comment body is ADF on Cloud. `jira.comment` takes Markdown today, so
   lossless comment copies need the same raw-ADF passthrough as descriptions:
   accept an ADF object as the comment body, as part of gap 2.
6. `plan.value`: a summary shown under the plan, with counts of issues,
   subtasks pulled in, attachments with their total bytes, links, comments
   and transitions, plus the warnings.

**Plan-time checks, before anything is written:**

- `TO` exists and is not `FROM`.
- Every issue type used in `FROM` exists in `TO`. A missing one fails the
  plan and lists them.
- Each name in `--fields` resolves to a field id. Whether it is on the `TO`
  create screen is reported, using the create metadata.
- `TO` already has issues: this is a warning, not an error. The command plans
  a copy, not a sync. Re-running after a partial apply is done with
  `script apply` on the same plan, whose skips handle the already-applied
  part. A fresh `copy-issues` against a half-filled target would duplicate
  issues, and the warning says so.

**Output example (dry run):**

```
Plan: copy-issues  AUDIT24 → AUDIT25   (148 issues, 212 attachments / 64.3 MB, 37 links)
  1  issue CREATE   AUDIT25  Control  "AC-01 Access reviews"          ← AUDIT24-1
  2  attachment COPY evidence-template.xlsx (2.4 MB)  10432 → plan:1
  ...
Nothing written. Re-run with --apply, or save with --plan-out plan.json.
```

### Client changes (`packages/jira`)

- `downloadAttachmentToFile(contentUrl, path, { signal })`:
  - reuses the same request, retry, 429 and session-redirect handling as
    `downloadAttachment`
  - streams the body to `path`
  - factor the shared part out of `downloadAttachment` rather than copying it
- `uploadAttachment(key, filename, data: Buffer | Blob)`: accept a `Blob`,
  which a `BunFile` is, and keep the `Buffer` overload for the existing
  callers.
- Both stay in the token/session auth model; the session redirect allowlist
  (spec 010) applies to the download unchanged.

### Port and sandbox (`packages/script-runtime`)

- `port.ts`:
  - `jiraAttachmentInfo(id) → { id, filename, size, mimeType }`
  - `jiraCopyAttachment(id, toKey) → { id }`
- `verbs.ts`:
  - the verb, its plan op, the precondition
  - the entry in `WRITE_VERBS`
- `apply.ts`: resolve the `plan:n` target before the copy, like `jira.attach`.
- `apps/cli/src/commands/script-port.ts`: `jiraCopyAttachment` calls the
  shared `copyAttachment`. The temp dir comes from `os.tmpdir()`, never from
  script input, so a plan cannot steer where bytes are written.
- `script.ts` `renderPlan`: show something like
  `attachment COPY evidence.xlsx (2.4 MB) 10432 → plan:3`.

### Raw descriptions

- Document `fields.description` as the lossless path for copying: the value
  from `jira.get` goes in unchanged.
- Plan time rejects `description` together with `fields.description` ("pass
  one of description (Markdown) or fields.description (raw)").
- Make the no-op comparison for updates aware of raw descriptions, if it
  compares descriptions.

## Example script (for the guide)

```ts
const source = "AUDIT24";
const target = "AUDIT25";
const created = new Map<string, string>(); // source key → plan ref

for await (const issue of jira.search(`project = ${source} ORDER BY key`, {
  fields: ["summary", "issuetype", "description", "labels", "parent", "attachment", "issuelinks"],
})) {
  const f = issue.fields;
  const ref = jira.create({
    project: target,
    type: f.issuetype.name,
    summary: f.summary,
    fields: {
      description: f.description,
      labels: f.labels,
      ...(f.parent && created.has(f.parent.key) ? { parent: { key: created.get(f.parent.key) } } : {}),
    },
  });
  created.set(issue.key, ref);
  for (const a of f.attachment ?? []) jira.copyAttachment(a.id, ref);
}
// Links in a second pass, once every issue has a plan ref.
```

The guide finishes the link pass. It needs parents ordered before children:
sort by hierarchy, or do two passes.

## Tests

- **Runtime unit tests:**
  - the plan op holds no bytes
  - the precondition records the size
  - a missing attachment fails at plan time
  - `plan:n` targets resolve
  - the no-op skip works
  - `description` with `fields.description` is rejected
- **Host tests:**
  - against a local HTTP server: the download is streamed to a file, then
    uploaded from it
  - a size mismatch aborts before the upload
  - the temp dir is gone after success, error and abort
  - a 429 is retried
- **CLI tests:**
  - the rendered plan line
  - `issue attachment copy` by id and by key plus filename
  - `issue clone --attachments`, including the per-file warning path
- **`copy-issues` (against a port stub, no QuickJS shortcuts):**
  - parent-before-child order
  - a parent outside the set is dropped with a warning
  - links: internal ones are rewired, external ones kept, each pair once
  - a missing issue type fails the plan
  - `--no-attachments` and `--no-links`
  - `--replace` changes the summary and ADF description text nodes while
    leaving the ADF structure unchanged
  - a placeholder left over produces a warning naming the issue and the token
  - `--jql` alone works, `--from` with `--jql` works, and giving neither or
    both forms wrongly is a usage error
  - the `--to` project is excluded from the selection
  - subtasks outside the JQL are pulled in, and `--no-subtasks` leaves them
    out
  - `--link-source` plans one Cloners link per copy; a site without the link
    type gets a warning
  - `--comments` keeps the order and the "Originally by" header, and the
    body stays ADF
  - `--keep-assignee`: assignable users are kept, others are unassigned with
    a warning
  - `--keep-status`: a same-name transition is planned, and no match gives a
    warning without a transition
  - the write budget defaults to the planned count, and `--max-writes` caps it
  - a plan written by `--plan-out` applies through `script apply`
  - `--print-script` prints a script that passes `script check`
- **Live E2E for `copy-issues` (ATLCLI into a temporary second project):**
  - source: an epic with two children, one link inside the set, one link to
    an outside issue, an ADF table description, and attachments including
    one above 10 MB
  - dry run, then apply
  - compare structure, ADF and attachment SHA-256 values
  - run `script apply` on the same plan again: everything is skipped
  - a project-split run: `--jql` selecting one parent whose subtask does not
    match, with `--link-source --comments --keep-assignee --keep-status`;
    check that the subtask came along, the Cloners link exists, the comment
    order and header are right, the assignee is kept, and the status is
    matched or a warning was given
  - delete the issues and the temporary project
- **Browser build guard:** `attachment-copy.ts` never reaches
  `index.browser.ts` (`scripts/check-browser-build.ts`).
- **Live E2E (ATLCLI):**
  - copy two issues with an ADF description (table plus panel) and one
    attachment above 10 MB
  - compare the description ADF and the attachment SHA-256
  - re-run: everything skipped
  - delete the test issues afterwards
- **Data Center:** `fields.description` as a wiki string; check the
  attachment copy if a DC instance is available.

## Docs

- Jira issues guide/reference:
  - `issue attachment copy`
  - `issue clone --attachments`
  - a guide page "Copy a recurring project" built around `jira project
    copy-issues` (prerequisites: shared settings, issue types, custom fields;
    dry run, apply, re-run after a partial apply; troubleshooting)
  - a reference entry for `copy-issues`: flags with type, default and
    constraints
  - a guide section "Recurring processes from a template project":
    - keep a template project as the single source of the process
    - put `{{placeholders}}` in summaries and descriptions and fill them with
      `--replace`
    - change the process in the template, not in past runs
    - example: `copy-issues --from TPL-RELEASE --to REL --jql "labels = core"
      --replace "{{version}}:2026.11"` (a run can target an existing project
      such as `REL`, alongside earlier runs)
  - a guide section "Running on a schedule":
    - atlcli has no scheduler; use cron or CI
    - recommended: the scheduled job runs `--plan-out` and publishes the plan
      (CI artifact), and a person reviews it and runs `script apply`
    - `--apply --yes` unattended skips that review; document it as possible
      but not recommended
  - a guide section "Bulk clone for a project split":
    - move what changes owner with Jira's bulk move; clone what both teams
      need
    - example: `copy-issues --jql "project = SUP AND labels = dev" --to DEV
      --link-source --comments --keep-assignee --keep-status --plan-out
      plan.json`
    - what carries over: subtasks, links, attachments, the description, and
      optionally comments, assignee and status
    - what cannot: change history, original comment authors and dates
      (comments are headed instead), workflow state across unrelated
      workflows
    - review the warnings in the plan before `script apply`
  - an alternative in the same guide: steps kept as a Confluence task list
    become issues with `wiki page tasks-to-issues`, and `--sync` ticks the
    tasks off as the issues finish. Link to its reference.
- `reference/scripts.md`: the verb, the precondition, and the raw-description
  note.
- `scripts.md` guide: "Copy a recurring project" with the example, the custom
  field caveat, and how to re-run after a partial apply.
- `skills/atlcli/references/scripts.md`: same verb and caveats.

## Out of scope

- Copying worklogs, change history, votes or watchers. History cannot be
  written through the API; comments are an opt-in (`--comments`).
- Cross-site copy. The verb works within one profile; across sites it would
  need two clients in one port, so it is a later extension.
- `confluence.copyAttachment`: the same pattern, add when asked.
- Creating the project from inside a script, which stays
  `atlcli jira project create`. `copy-issues` expects `TO` to exist.
- Sync semantics (updating an earlier copy): `copy-issues` only creates.
- Process drift detection, for example reporting which running instances
  lack a step added to the template since: a compare/sync feature, a later
  spec of its own.
- A template as code in Git (YAML/Markdown instead of a template project): a
  different source with its own format, a later spec.
- A built-in scheduler.

## Delivery order

1. Client streaming, `attachment-copy.ts`, `issue attachment copy`,
   `issue clone --attachments`.
2. Script verb `jira.copyAttachment`, and the `fields.description` guard and
   test.
3. `jira project copy-issues` as a built-in script, the shared run/apply CLI
   plumbing, and the guide.

These are separate PRs, each with its own live E2E.

## Open questions

1. Should `copyAttachment` also accept a whole issue (`copyAttachments(fromKey,
   toKey)`) as sugar, or is the loop in the script enough?
2. Should the no-op skip compare filename and size only, or also hash the
   target attachment? Hashing costs a download per check.
3. `copy-issues`: copy components and fix versions by name, which needs
   them to exist in `TO`, or create the missing ones as part of the plan?
4. `copy-issues`: should rank order be kept? That needs `PUT /rank` per
   issue, which adds many writes.
5. `--comments`: copy the comments' attachments references and @mentions as
   they are (the mentions then notify people again), or strip mentions to
   plain names?
6. `--keep-status`: is the same-name, one-step rule enough, or is an explicit
   `--status-map "In Progress:Doing"` wanted?
