---
title: "Copy Issues"
description: "Copy Jira issues into another project with descriptions, subtasks, links and attachments, as a reviewable plan"
---

# Copy Issues

`atlcli jira project copy-issues` copies a set of issues into another project:
summaries, descriptions (unchanged, as rich text), labels, subtasks and child
issues, links and attachments. The result is a **plan** you review first;
nothing is written until you apply it.

Typical uses:

- **Recurring projects and processes**: a yearly audit, a release checklist,
  onboarding. Copy last cycle's issues, or better a curated template project,
  into a fresh project with every status, assignee and date starting from zero.
- **Splitting a project**: tickets that piled up in one project get a second
  home. Move the ones that change owner with Jira's bulk move; clone the ones
  both teams need with `copy-issues`.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **The target project exists.** Create it in Jira, or with
  [`atlcli jira project create`](/jira/projects/#create-project). Use shared
  settings, or the same issue types and fields, so the copies fit.
- **Jira permissions**: Browse Projects on the source; Create Issues, Create
  Attachments and Link Issues on the target (Assign Issues and Transition
  Issues for `--keep-assignee` and `--keep-status`).

## Steps

1. **Plan** (writes nothing):

   ```bash
   atlcli jira project copy-issues --from AUDIT24 --to AUDIT25 --plan-out audit25.json
   ```

   The plan lists every create, attachment copy and link, followed by a summary
   (issues, subtasks pulled in, attachments with total size, links) and any
   warnings.

2. **Review** the plan and its warnings.

3. **Apply**:

   ```bash
   atlcli script apply audit25.json
   ```

   Or plan and apply in one go with `--apply` (asks first; `--yes` skips the
   question).

## What is copied

| Copied | Not copied (by default) |
|--------|-------------------------|
| Summary, issue type, description (as is: ADF on Cloud, wiki markup on Data Center) | Status, assignee, reporter, dates, sprint |
| Labels, components and fix versions (by name) | Comments |
| Subtasks and child issues of selected issues, parents before children | Change history, worklogs, votes, watchers |
| Links: rewired between copies, kept to issues outside the selection | Rank order |
| Attachments, any size | |

Each copy gets the hidden issue property `atlcli.copiedFrom` with its
original's key. It is what makes a re-run safe (see below).

Summaries, descriptions, labels, comments, component and version names and
`--fields` values are [templates](/templating/) in Jinja syntax: `{{ year }}` takes a value from
`--var` or `--vars-file`, `{{ source.key }}` names the original, `{{ today }}`
the date of the plan. A `{{ … }}`, or an `{% if %}`/`{% for %}` block, that
nothing fills is copied as written and listed under **Template warnings** in
the plan, so foreign Jinja, Ansible or Helm snippets survive unchanged.

## Options

| Flag | Type | Default | Notes |
|------|------|---------|-------|
| `--to <KEY>` | project key | required | Target project; never part of the selection |
| `--from <KEY>` | project key | none | Source project. Give `--from`, `--jql`, or both |
| `--jql <query>` | JQL | none | With `--from`: an extra filter. Alone: the whole selection, may span projects. No `ORDER BY` |
| `--no-subtasks` | switch | subtasks on | Copy only what the JQL matches, not the children of matched issues |
| `--no-attachments` | switch | attachments on | |
| `--no-links` | switch | links on | |
| `--fields <ids>` | comma-separated field ids | none | Extra fields to copy, e.g. `customfield_10010,duedate` |
| `--var <name=value>` | string, repeatable | none | Template variable; `a.b=v` nests, JSON values (`n=5`, `list=["a"]`) are parsed |
| `--vars-file <file>` | YAML path | none | Values and optional declarations; see [Templating](/templating/#variables) |
| `--now <iso>` | ISO date/time | time of planning | Freezes `today`/`now`; repeat a plan exactly |
| `--strict` | switch | off | Fails the plan on any template warning |
| `--replace <find:replace>` | string, repeatable | none | Legacy find/replace in summary and description, applied before templates; split at the first colon |
| `--link-source` | switch | off | Links each copy to its original with **Cloners** ("clones") |
| `--comments` | switch | off | Copies comments in order, each headed *Originally by \<name\> on \<date\>* |
| `--keep-mentions` | switch | off | With `--comments`: keep @mentions. Without it they become plain names, so nobody is notified again |
| `--keep-assignee` | switch | off | Keeps the assignee; the user must be assignable in the target |
| `--keep-status` | switch | off | Moves each copy to its original's status when a direct transition exists |
| `--status-map <from:to>` | string, repeatable | none | Status to aim for instead of the same name; implies `--keep-status` |
| `--plan-out <file>` | path | none | Writes the plan file |
| `--apply`, `--yes` | switches | off | Apply after planning; `--yes` without asking |
| `--max-writes <n>` | positive integer | 100,000 | Caps the number of planned writes |
| `--max-calls <n>`, `--timeout <d>`, `--memory <MB>` | | 100,000 / `30m` / 256 | Planning limits, as for `atlcli script` |
| `--print-script` | switch | off | Prints the built-in script and exits |

## Examples

### Minimal: next year's audit

```bash
atlcli jira project copy-issues --from AUDIT24 --to AUDIT25 --apply
```

### Recurring processes from a template project

Keep the process in one template project, for example `TPL-RELEASE`, and copy
it for every run. A change to the process goes into the template once; every
run starts clean, without old comments, assignees or steps nobody remembers
adding.

Write [template variables](/templating/) into summaries and descriptions and
fill them per run:

```bash
atlcli jira project copy-issues --from TPLREL --to REL \
  --var version=2026.11 --var release_date=2026-11-15 \
  --plan-out release-2026.11.json
```

A variable nothing fills stays as written and is listed under **Template
warnings** with the issue and field, so a forgotten `--var` is caught before
anything is written; `--strict` makes it fail the plan. The target can be a
project that already holds earlier runs.

A description can repeat parts per value. With a vars file like

```yaml
# audit-2026.yml
values:
  year: 2026
  systems: [IAM, Backup, Logging]
```

a table row whose first cell is `{% for system in systems %}`, a row with
`{{ system }}`, and a row with `{% endfor %}` become one row per system. See
[control paragraphs](/templating/#control-paragraphs).

```bash
atlcli jira project copy-issues --from TPLAUDIT --to AUD26 --vars-file audit-2026.yml --apply
```

`--replace` still works and runs before the templates, for sources that use
other placeholder styles.

### Bulk clone for a project split

```bash
atlcli jira project copy-issues --jql "project = SUP AND labels = dev" --to DEV \
  --link-source --comments --keep-assignee --keep-status --plan-out split.json
```

- Subtasks come along even when the JQL does not match them.
- `--link-source` links each copy to its original, so the old team can follow it.
- Comments are copied with a header, since the API cannot set their original
  author or date.
- Statuses follow by name; use `--status-map "In Progress:In Arbeit"` when the
  target workflow names them differently.
- The original keeps its full history. The copy cannot have it: Jira's API does
  not allow writing change history.

### Running on a schedule

atlcli has no scheduler; use cron or your CI. The recommended setup keeps the
review step:

```bash
# Scheduled job: plan only, publish the plan (for example as a CI artifact)
atlcli jira project copy-issues --from TPLREL --to REL --var "version=$VERSION" --strict \
  --plan-out plan.json --json > plan-summary.json

# A person reviews plan.json, then:
atlcli script apply plan.json
```

`--apply --yes` in the job works too, but writes without anyone looking at the
plan.

### Steps on a Confluence page instead

If the steps live as a task list on a Confluence page, turn them into issues
with `atlcli wiki page tasks-to-issues`; `--sync` ticks the tasks off as the
issues are done. See [Meeting notes to Jira](/recipes/meeting-notes-to-jira/).

## Re-running after a partial apply

Planning again with the same flags finds the copies made so far through their
`atlcli.copiedFrom` property and plans only what is missing: issues not yet
copied, attachments the copy lacks (same name and size counts as present), and
links not yet made. Comments and statuses are only planned for new copies.

Do **not** apply the same plan file twice: a plan records creates, so it would
create the issues again. Plan again instead.

The plan header shows the time templates rendered at
(`Templates: rendered at …`). Pass it as `--now` when you plan again, so
`{{ today }}` gives the same date as in the copies already made, for example
after midnight.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Apply fails on create: issue type not valid | The target project lacks an issue type used in the source | Add the type to the target's scheme, or narrow the selection with `--jql` |
| Apply fails on create: field cannot be set | A copied or `--fields` field is not on the target's create screen | Add it to the screen, or leave it out of `--fields` |
| Apply fails with `--keep-assignee` | A user cannot be assigned in the target project | Grant Assignable User, or run without `--keep-assignee` |
| `Status unchanged (no direct transition)` after apply | The target workflow has no direct transition into that status | Use `--status-map`, or move those issues by hand |
| Warning: parent is not copied | A selected issue's parent is outside the selection | Widen the selection, or accept the copy without a parent |
| Warning: no Cloners link type | The site has no Cloners link type | Copies are made without `--link-source` links |
| A `{{ … }}` stays in the copy | No value given, a typo, or the expression runs across a mention or link | Check **Template warnings**; `atlcli template vars --jql "…"` lists what the source needs |
| `Script failed (template)` | `--strict` and at least one template warning | Fix the warnings, or run without `--strict` |

After a failed apply, fix the cause and [plan again](#re-running-after-a-partial-apply).

## Under the hood

The command runs a built-in [`atlcli script`](/reference/scripts/) in the same
sandbox as any script, so the plan file, its preconditions and the apply report
are the standard ones. `--print-script` prints it; copy it and run your own
version with `atlcli script run` when you need different rules.

## Related topics

- [Attachments](/jira/attachments/): `attachment copy` for single files
- [Issues](/jira/issues/#clone-issue): `issue clone --attachments` for one issue
- [Projects](/jira/projects/): create the target project
- [Automation scripts](/reference/scripts/): plan files, `script apply`, verbs
- [Templating](/templating/): variables, built-ins, control paragraphs
