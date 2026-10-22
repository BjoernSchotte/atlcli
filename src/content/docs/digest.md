---
title: "Daily Digest"
description: "atlcli digest: what changed since your last look and what waits on you, across Jira and Confluence"
---

# Daily Digest

`atlcli digest` shows, in one view, what changed in Jira and Confluence since your last look and what is waiting on you. It runs a fixed, small set of queries (about 20 requests with the defaults), so it is fast enough for a shell profile or a cron job.

## Prerequisites

- An authenticated profile with Jira and Confluence access (`atlcli auth login`)
- **Jira permission**: Browse Projects for the issues you work on
- **Confluence permission**: View for the spaces you work in
- For the sprint section: a scrum board, set with `--board` or `defaults.board` (kanban boards have no sprints and are skipped)
- For the project overview: Jira project keys, set with `--project` or `digest.projects`
- For `--summarize`: `ANTHROPIC_API_KEY` in the environment

## Steps

1. Run the digest:

   ```bash
   atlcli digest
   ```

   The first run covers the last 24 hours. Each later run starts where the previous one ended (see [The last-run marker](#the-last-run-marker)).

2. Look back over a fixed window instead, without moving the marker:

   ```bash
   atlcli digest --since 7d
   ```

3. Add an overview of whole projects, whoever worked on them:

   ```bash
   atlcli digest --project GROW,VDS --since 2d
   ```

   To get the overview on every run, set `digest.projects` once (see [Project overview](#project-overview)).

4. Paste the Markdown version into a standup note:

   ```bash
   atlcli digest --markdown > standup.md
   ```

## What the digest shows

| Product | Section | What it lists |
|---|---|---|
| Jira | Waiting on you | Unresolved issues assigned to you that are not in a done status, by priority |
| Jira | Changed | Issues you are assigned to, reported or watch that changed in the window, each with its changes (`status: To Do → In Progress by Ann · 3h ago`) |
| Jira | Sprint | Each active sprint of the board: progress bar, to do / in progress / done counts, your open issues, days left |
| Jira project | Completed · Created · Changed | Per project from `--project` or `digest.projects`: issues moved into a done status, issues created, and issues changed in the window, by anyone, with assignee and change lines |
| Confluence | Mentions | Pages and comments that mention you |
| Confluence | Comments on your pages | New comments on your 50 most recently modified pages |
| Confluence | Open inline comments | Unresolved inline comments on your 10 most recently modified pages (`--max-pages`), oldest first. These are not limited to the window: they wait on you. |
| Confluence | Your pages edited | Your pages that someone else edited |
| Confluence | Watched pages changed | Pages and blog posts you watch that someone else edited |
| Confluence | Recently changed in space | Pages changed in `--space` (or `defaults.space`); only when a space is set |

A page that matches several sections appears once, in the first one in this order: mentions, your pages, watched, recent. In `--json` output its entry lists the other sections in `alsoIn`.

Your own edits and comments are left out. Pass `--include-own` to keep them; your own Jira changes are then marked `(you)`.

Empty sections are not printed. If nothing changed, the digest says `Nothing new since <window>.`

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `--since` | `lastrun`, `<n>m`, `<n>h`, `<n>d`, `<n>w`, `today`, `yesterday`, ISO date or datetime | `lastrun` | Start of the window. `m` means **minutes** here (in `jira worklog` it means months). `today` and `yesterday` start at local midnight. At most 30 days back. |
| `--only` | `jira` or `confluence` | both | Run one product only |
| `--space` | space key(s), comma-separated | `defaults.space` | Enables "Recently changed in space" |
| `--board` | board id | `defaults.board` | Enables the sprint section (scrum boards only) |
| `--project` | project key(s), comma-separated | `digest.projects` | Enables the project overview |
| `--status-map` | `"<status>=todo\|wip\|done,…"` | `flow.statusMap` | Override status categories, see [Status mapping](jira/flow-metrics.md#status-mapping) |
| `--limit` | integer ≥ 1 | `10` | Items per section; a cut section is listed under warnings |
| `--max-pages` | integer ≥ 1 | `10` | Your pages checked for open inline comments |
| `--include-own` | flag | off | Keep your own edits and comments |
| `--no-mark` | flag | off | Never move the last-run marker |
| `--markdown` | flag | off | Markdown output with `##`/`###` headings and links |
| `--json` | flag | off | JSON output (`schemaVersion: "1"`); every section key is present, `[]` when empty, and the queries are included |
| `--summarize` | flag | off | Add a short summary from Anthropic, see [Summaries](#summaries) |
| `--verbose` | flag | off | Print every JQL/CQL query, the request count and the duration to stderr |

## Project overview

The personal sections only show what concerns you. The project overview shows everything that happened in whole projects: per project, the issues **completed** (moved into a done status in the window), **created** and **changed**, by anyone, including you.

Set the projects once in `~/.atlcli/config.json`, globally or per profile. A profile's list replaces the global one, and `--project` replaces both:

```json
{
  "digest": { "projects": ["GROW"] },
  "profiles": {
    "work": { "digest": { "projects": ["GROW", "VDS", "ADMIN"] } }
  }
}
```

| Option | Type | Default | Constraints |
|---|---|---|---|
| `digest.projects` | string[] | `[]` | Jira project keys |

The overview reads up to 200 changed issues across all projects in one search, plus one bulk changelog request. Each list is cut at `--limit`.

"Done" follows the Jira status category (To Do, In Progress, Done), not status names. If a workflow puts a done status in another category, map it with `flow.statusMap` or `--status-map`, e.g. `"Fertig=done"`. The map also applies to "Waiting on you" and the sprint counts.

## The last-run marker

The marker lives in `~/.atlcli/profiles/<profile>/digest-state.json`, with one entry per product:

```json
{
  "schemaVersion": 2,
  "jira": { "lastRunAt": "2026-10-22T07:58:12.311Z" },
  "confluence": { "lastRunAt": "2026-10-22T07:58:12.311Z" }
}
```

- A product's marker moves to the **start** of the run, so changes made while the digest ran are not lost.
- It moves only when `--since` was not given (or was `lastrun`), none of that product's sections failed and `--no-mark` was not passed. Peeking with `--since 7d` never moves it.
- Each product starts from its own marker. If Confluence was down yesterday, today's run catches up on Confluence while Jira stays current.
- The window starts 5 minutes before the marker, because search indexes trail writes. Items in that overlap can show up twice across two runs.

## Summaries

`--summarize` sends the rendered Markdown digest to Anthropic in one model call and prints a short summary above the digest (in `--json`, in the `summary` field).

:::caution[What is sent]
Only the digest itself: issue keys, page and issue titles, statuses, people's names and section names. No page bodies, issue descriptions or comment text. Before the call, the CLI prints `Sending digest (N items: …) to Anthropic.` to stderr.
:::

- The key is read from `ANTHROPIC_API_KEY` only. Flags such as `--api-key` are refused.
- Without a key, or if the call fails, the digest is still printed with a warning, and the exit code stays 0.
- The model treats titles as data, never as instructions.

## Examples

Minimal:

```bash
atlcli digest
```

Jira only, last week, with the sprint of board 42:

```bash
atlcli digest --only jira --since 7d --board 42
```

A standup note every weekday at 8:45, with a summary:

```bash
# crontab -e
45 8 * * 1-5  ANTHROPIC_API_KEY=... atlcli digest --markdown --summarize > ~/notes/standup.md 2>/dev/null
```

Debug which queries run:

```bash
atlcli digest --since 2h --verbose --json > /dev/null
```

## Exit codes and partial failures

Each section is fetched on its own. A failing section is listed under **Warnings** and the rest is still printed.

| Situation | Exit code | Marker |
|---|---|---|
| Everything succeeded | 0 | Moves for both products |
| Some sections failed | 0 | Moves only for products without a failed section |
| Every section failed | 1 | Unchanged |

## Troubleshooting

**A fresh mention or comment is missing.**
Confluence search can trail writes by up to a minute. The next `lastrun` digest picks it up, because its window overlaps the previous one by 5 minutes.

**"Changed" lists issues without any change lines.**
On Jira Data Center there is no bulk changelog API, so the digest lists the issues without change details.

**The marker did not move.**
A section of that product failed (see the warnings), or the run used `--since` or `--no-mark`.

**`truncated: jira.waiting` under warnings.**
More items matched than `--limit`. Raise `--limit`, or use `atlcli jira my` for the full list.

**Finished issues show up in "Waiting on you", or "Completed" stays empty.**
The workflow puts a done status into the To Do or In Progress category. Map it: `--status-map "Fertig=done"` or `flow.statusMap`. Better still, move the status to the Done category in the Jira workflow.

**`truncated: jira.projects` under warnings.**
More than 200 issues changed in the projects during the window. Narrow `--since` or the project list.

**The digest reaches back only 30 days.**
That is the upper bound, to keep queries cheap after a long break. A warning says so.

## Related topics

- [Jira search and `jira my`](jira/search.md)
- [Confluence search: `wiki my` and `wiki recent`](confluence/search.md)
- [Configuration: defaults and profiles](configuration.md)
- [Research](reference/research.md), the agentic alternative for open questions
