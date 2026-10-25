---
title: "Per-Issue Script Jobs"
description: "Run an atlcli script once per issue over thousands of Jira issues: planned first, applied in batches, resumable after a stop"
---

# Per-Issue Script Jobs

A per-issue job runs a [script](scripts.md) once for every issue a JQL query matches. Use it for tens of thousands of issues: atlcli takes a snapshot of the matching issues, works through them in batches, records every outcome on disk and continues where it stopped after a crash, Ctrl-C or a fixed bug.

```ts
export const meta = { each: { jql: "project = ATLCLI AND statusCategory != Done AND updated < -180d" } };

export default async (issue) => {
  await atlcli.jira.setStatus(issue.key, "Won't Do");
};
```

## On this page

- [Prerequisites](#prerequisites)
- [Steps: review, then apply](#steps-review-then-apply)
- [Writing a per-issue script](#writing-a-per-issue-script)
- [Two ways to run](#two-ways-to-run)
- [Stopping and resuming](#stopping-and-resuming)
- [Options](#options)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- An authenticated profile (`atlcli auth login`) with the Jira permissions the script's writes need, as for any [script](scripts.md#prerequisites).
- Disk space under `~/.atlcli/jobs`: about 1 KB per issue with changes.

## Steps: review, then apply

1. Write a per-issue script, or start from a skeleton for your query:

   ```bash
   atlcli script init scripts --each "project = ATLCLI AND updated < -180d"
   ```

   This writes `scripts/each.ts`, plus `atlcli.d.ts` and `tsconfig.json` for editor support.

2. Plan it. Nothing changes; every issue gets its own plan:

   ```bash
   atlcli script run scripts/each.ts
   ```

   ```text
   each → https://company.atlassian.net (profile work) · job 20261025-091500-each-3f2a
   Issues: 12480 · 11902 planned, 578 unchanged
   Planned operations this run: 11902 (11902 jira.setStatus)
     ATLCLI-12    jira setStatus   ATLCLI-12 → "Won't Do"
     …
   Nothing was changed. Review the plans, then apply: atlcli script apply 20261025-091500-each-3f2a
   ```

3. Review. `atlcli script jobs <id>` shows the counts; the plans are in `~/.atlcli/jobs/<id>/plans.jsonl`, one line per issue.

4. Apply the reviewed plans. atlcli asks first; add `--yes` in CI:

   ```bash
   atlcli script apply 20261025-091500-each-3f2a --concurrency 8
   ```

   Each issue's plan is checked against the issue as it is now. An issue someone edited since planning is reported as `drift` and left alone; all others are applied.

## Writing a per-issue script

The default export is called once per issue, with the issue and the params:

```ts
export const meta = {
  each: { jql: "project = ATLCLI AND labels is not EMPTY", fields: ["labels"] },
  params: { label: { type: "string" } },
};

export default async (issue: JiraIssue, params: { label: string }) => {
  const labels = issue.fields.labels as string[];
  if (!labels.includes(params.label)) await atlcli.jira.addLabels(issue.key, [params.label]);
};
```

- **`meta.each.jql`** selects the issues. `--each "<jql>"` on the command line overrides it, and works for scripts without `meta.each` too. The query may use [JQL functions](jira/search.md#jql-functions) such as `subtasksOf("…")`.
- **`meta.each.fields`** are the fields each issue comes with. The default is `summary`, `status`, `assignee`, `priority`, `issuetype` and `labels`. Read more with `atlcli.jira.get(issue.key, { fields: [...] })`.
- Every verb works as in a normal script, including reads of other issues, Confluence pages and [`atlcli.jira.rest`](reference/scripts.md#jira).
- Each issue runs in its own sandbox. Nothing carries over from one issue to the next.

**Make it safe to run twice.** An issue can be planned or applied a second time: when you resume after a crash, or re-run the script on the same query. Status changes, labels, assignments and page updates that change nothing are skipped automatically ([unchanged updates](reference/scripts.md#unchanged-updates)). Comments, creates and attachments are not. Guard them yourself, for example with a marker label:

```ts
export default async (issue: JiraIssue) => {
  if ((issue.fields.labels as string[]).includes("stale-asked")) return;
  await atlcli.jira.comment(issue.key, "Is this still needed?");
  await atlcli.jira.addLabels(issue.key, ["stale-asked"]);
};
```

## Two ways to run

| Command | What happens | When |
|---|---|---|
| `script run x.ts` | Plans every issue into the job, writes nothing. Then `script apply <id>` | You want to review what will change |
| `script run x.ts --apply` | Plans and applies each issue right away, after one confirmation with the issue count | Routine jobs you trust; scheduled runs with `--yes` |

In both modes the job directory `~/.atlcli/jobs/<id>/` holds:

| File | Content |
|---|---|
| `job.json` | Query, params, target site, mode, limits and state |
| `script.ts` | The script the job runs |
| `items.jsonl` | The snapshot: id and key of every matching issue |
| `plans.jsonl` | One line per issue with its planned operations (review mode) |
| `results.jsonl` | One line per issue with its outcome when applied |

The snapshot is taken once, at the start. Issues that start matching later are not included, and issues that the script itself moves out of the query are still processed. An issue deleted after the snapshot is reported as `gone`.

## Stopping and resuming

A job stops early when you press Ctrl-C (the issues in progress finish first), when too many issues fail, or when the process dies. Continue it with:

```bash
atlcli script resume <job-id> --yes
```

Issues already done are skipped; failed issues and issues not reached yet are run again. To fix a bug in the script first, pass the fixed file:

```bash
atlcli script resume <job-id> --script scripts/each.ts
```

`atlcli script jobs` lists all jobs with their progress; `atlcli script jobs <job-id>` shows one, with the issues that are not done and why.

## Options

| Flag | Applies to | Type | Default | Notes |
|---|---|---|---|---|
| `--each "<jql>"` | run | JQL | `meta.each.jql` | Turns on per-issue mode |
| `--apply` | run | switch | off | Plan and apply issue by issue |
| `--yes` | run, apply, resume | switch | off | No confirmation; required without a terminal |
| `--concurrency <n>` | run, apply, resume | 1–32 | 4 | Issues in flight at once. Jira's rate limits apply; atlcli waits when Jira asks it to |
| `--max-failures <n\|n%>` | run, resume | count or percentage | `10%` (at least 10) | Failed issues (script errors, failed writes) after which the job stops |
| `--max-items <n>` | run, resume | positive integer | all | Process at most `n` issues in this run; the rest on resume |
| `--timeout`, `--max-calls`, `--max-writes`, `--memory` | run | as for [scripts](reference/scripts.md#sandbox-limits) | 60s, 500, 50, 64 MB | Per issue, not per job |
| `--script <file>` | resume | path | the job's script | Continue with a fixed script. Not for applying a reviewed job |

There is no limit on the number of issues or on the total number of writes.

## Examples

### Minimal: label every open bug

```bash
atlcli script run -e 'export default async (issue) => atlcli.jira.addLabels(issue.key, ["triage"])' \
  --each "project = ATLCLI AND type = Bug AND statusCategory != Done" --apply
```

Issues that already carry the label are skipped, so running it again changes nothing.

### Realistic: close inactive issues across many projects, in CI

```ts
// close-inactive.ts
export const meta = {
  each: { jql: "statusCategory != Done AND updated < -365d AND project in (OPS, WEB, APP)", fields: ["status"] },
  params: { status: { type: "string", default: "Won't Do" } },
};

export default async (issue: JiraIssue, params: { status: string }) => {
  await atlcli.jira.comment(issue.key, `Closed after a year without activity. Reopen if still relevant.`);
  await atlcli.jira.setStatus(issue.key, params.status);
};
```

```bash
# Monday: plan and publish the counts for review
atlcli script run close-inactive.ts --json > plan-summary.json
# After approval: apply exactly the reviewed plans
atlcli script apply "$(jq -r .job.id plan-summary.json)" --yes --concurrency 8
```

More scripts to start from: `atlcli script init --list-examples`.

## Troubleshooting

**`Stopped: 25 failures (limit 10%; change with --max-failures)`**
Many issues failed in the same way, usually a script bug or a missing permission. `atlcli script jobs <job-id>` lists the failed issues and the errors. Fix the cause, then `atlcli script resume <job-id> --script <fixed file>`.

**`Stopped: the script is invalid`**
The script cannot run at all, for example because it has no `export default async (issue) => …`. Fix it and resume with `--script`.

**`In per-issue mode (--each) the script must export a function`**
Per-issue scripts need a default-export function. Top-level code runs too, but once per issue.

**Issues show as `drift` after `script apply <job-id>`**
Someone changed these issues after they were planned. They are not changed. Run the script again on them (for example `--each "key in (…)"`) to plan against their current state.

**`The plans of job … were modified after planning`**
`plans.jsonl` was edited. atlcli applies only the plans it made; re-run the script to plan again.

**`Job … is not fully planned yet`**
Planning stopped before every issue had a plan. `atlcli script resume <job-id>` finishes it; then apply.

**A comment appears twice after a crash**
An issue was applied, but the process died before recording it, so resume applied it again. Guard comments and creates with a marker, see [Make it safe to run twice](#writing-a-per-issue-script).

**The process uses about 1 GB of memory**
Every issue runs in a fresh sandbox; under Bun the memory levels off around 1.2 GB however many issues run. Lower it by running fewer issues per process with `--max-items` and resuming.

## Related topics

- [Automation Scripts](scripts.md): writing scripts, plans and apply
- [Script API](reference/scripts.md): verbs, limits, job files and JSON output
- [Jira search](jira/search.md#jql-functions): JQL functions for the query
- [Jira bulk operations](jira/bulk-operations.md): one command for a single kind of change
- [Scripts in CI](recipes/scripts-in-ci.md): plans as artifacts, apply after approval
