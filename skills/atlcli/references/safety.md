---
name: safety
description: Which atlcli commands write, how to preview them, and the confirmation discipline before any mutation.
metadata:
  tags: safety, write-operations, dry-run, confirm, destructive
---

# Write operations and safety

Reads are free; writes land immediately in a system other people use.

## Contents

- [Read-only commands](#read-only-commands)
- [Confirmation rule](#confirmation-rule)
- [Preview before writing](#preview-before-writing)
- [Destructive commands](#destructive-commands)
- [Other writes with no gate](#other-writes-with-no-gate)
- [Resolve names before acting](#resolve-names-before-acting)
- [Anti-patterns](#anti-patterns)

## Read-only commands

Safe to run without asking, at any time:

```
jira me · jira my · jira search · jira issue get|transitions|history|pages|attachments
jira issue comments list · jira project list|get|types · jira board list|get|backlog|issues
jira sprint list|get|issues|report · jira epic list|get|issues|progress
jira analyze velocity|burndown|scope-change|predictability|flow|aging|cfd
jira filter list|get · jira field list|get|options|search · jira subtask list
jira component list|get · jira version list|get · jira watchers · jira template list|get
jira worklog list|report · jira worklog timer status · jira webhook list
wiki page get|list|children|history|diff|comments|issues · wiki page label list
wiki space list|get · wiki search · wiki my · wiki recent · wiki docs status|diff|check
wiki template list|show|validate|render · wiki export template list
wiki export jobs list|show · wiki import recipe validate|list|show
wiki vfs cache stats · wiki vfs conflicts list|show
auth status|list · config list|get · flag list|get · log list|show
plugin list · models list · doctor · version · release-info
research · chat   (no Atlassian writes; research keeps local session files)
digest --no-mark · audit jira (without --update-baseline or --prune-baseline)
skill · skill <path> · skill --list
```

Any other `list`, `get`, or `status` verb follows the same pattern. Group help
(`atlcli jira issue` with no arguments) is also read-only and makes no API call.

`jira issue comment --key <key> <text>` is the same command as
`jira issue comments add`. It posts whatever follows as the body of a new
comment, so `jira issue comment --key PROJ-101 list` posts "list". Read comments
with `jira issue comments list --key <key>`. atlcli can remove a comment again
only with `jira issue comments delete --key <key> --id <id> --confirm`, which is
itself a destructive command.

A plain `atlcli digest` is read-only on Jira and Confluence but moves the
user's last-run marker, so the user's next digest starts after your run. Pass
`--no-mark` unless the user asks for their own digest, and treat
`--summarize` like `research` and `chat`: it sends data to Anthropic. See
[digest.md](digest.md).

`atlcli audit jira --update-baseline` and `--prune-baseline` rewrite the
profile's audit baseline, which decides what later audits and the digest
report. Ask first, and run them only with the selection and rules the
baseline was built with. See [jira-audit.md](jira-audit.md#baseline).

`atlcli skill --install <skills-root>` writes `<skills-root>/atlcli/` and
overwrites the skill's files there. Ask first and name the directory. See
[plugins-and-local-tools.md](plugins-and-local-tools.md#skill).

These read from Atlassian but write a local file. Treat them as local writes:
confirm the output path, and never overwrite an existing file the user did not
name. `jira issue attachment download` refuses an existing file without
`--overwrite`, and a PDF `wiki export` refuses one without `--force`; a DOCX
`wiki export` and `jira template export` overwrite without asking.

```
jira export -o <file> · jira template export · jira issue attachment download
wiki export <page> · wiki docs pull · wiki template export · wiki publish *
```

## Confirmation rule

Get explicit approval for each write before running it, stating the exact
command and its target. An approval covers the operation that was described and
nothing more: approval to update `PROJ-101` is not approval to update the six
issues that look like it.

Writes are not transactional. Creating an issue and transitioning it are two
API calls; a failed second call leaves the first applied. Report what
succeeded, then act on the remainder.

## Preview before writing

Two kinds of preview exist, and the flag decides which.

**`--dry-run`**: the command runs its lookups and prints what it would change,
then stops. Run it first and show the user the result.

```bash
atlcli jira bulk transition --jql 'project = PROJ AND status = Open' \
  --to 'Start Progress' --dry-run --json
atlcli wiki page delete --cql 'label=to-delete' --dry-run --json
atlcli wiki docs convert ./docs --to-new-editor --dry-run --json
atlcli jira version notes 10001 --space DOCS --dry-run --json
```

`--dry-run` is accepted by:

- `jira bulk edit|transition|label|delete|link-page|move`
- `jira import`
- `jira sprint review` and `jira version notes` (print the rendered page and
  whether it would create, update or leave it unchanged)
- `wiki page create` in template mode (prints the rendered Markdown)
- `wiki page sort`
- `wiki page label add|remove` (CQL form)
- `wiki page delete|archive` (`--id` and `--cql` forms)
- `wiki docs sync` (writes nothing, deletes nothing)
- `wiki docs convert`
- `wiki import` (never prompts, never writes)
- `wiki publish refresh|run` (`plan` never activates anything)
- `audit wiki --fix`

**Preview by default, write on `--confirm`**: these commands write nothing
until `--confirm` is added, so the plain run is the preview.

- `wiki import <file>` and the batch and `--update-page` forms. `--confirm` and
  `--dry-run` together fail with `ATLCLI_ERR_VALIDATION`. `--update-page` with
  `--confirm` checks `--expect-version <n>` only when it is given, although the
  help calls it required; without it, the `target-diverged` check against the
  import baseline still refuses a page edited since the import.
- `wiki page tasks-to-issues --id <id> --project <key>` and `--sync`: without
  `--confirm` the output has `dryRun: true` plus the plan.

Where a command takes both `--confirm` and `--dry-run` and you pass both,
`--dry-run` wins for `jira bulk delete` and `wiki page delete|archive`.

For `wiki docs push`, there is no `--dry-run`. The preview is
`atlcli wiki docs status --json` plus `atlcli wiki docs diff <file>`, then push
with `--validate`:

```bash
atlcli wiki docs status --json
atlcli wiki docs diff ./docs/architecture.md
atlcli wiki docs push ./docs --validate --strict --json
```

## Destructive commands

These require an explicit destructive flag. Never pass that flag on the
strength of an inferred intent: the user has to have asked for that specific
deletion. Any verb taking `--confirm` or `--force` belongs in this class, even
if it is not listed below.

```
jira issue delete --key <key> --confirm [--delete-subtasks]
jira issue comments delete --key <key> --id <id> --confirm
jira issue unlink --link <id>                     # deletes at once, no --confirm
jira issue unlink --from <key> --to <key> --confirm
jira issue attachment delete <id>|<key> <filename> --confirm
jira bulk delete --jql <query> --confirm          # deletes every match
jira sprint delete --id <id> --confirm
jira filter delete <id> --confirm
jira component delete <id> --confirm
jira version delete <id> --confirm
jira template delete <name> --confirm
jira worklog delete --issue <key> --id <id> --confirm
wiki page delete --id <id> --confirm
wiki page delete --cql <query> --confirm          # deletes every match
wiki page archive --id <id> --confirm
wiki page comments delete --comment <id> --confirm
wiki page restore --id <id> --version <n> --confirm   # reversible: history is kept
wiki page label add|remove <label> --cql <query> --confirm   # every match
wiki docs convert <dir> --to-new-editor|--to-legacy-editor --confirm   # whole tree
wiki docs push --delete-folders                   # deletes remote folders, no --confirm
wiki template delete <name> --force               # local template
wiki export template delete <name> --confirm      # local Word template
wiki export jobs clear --before <duration> --confirm
wiki publish prune --confirm                      # local publication state
log clear [--before <date>] --confirm             # no --before clears all logs
```

`jira issue unlink --link <id>` deletes the link at once. The `--from`/`--to`
form and `jira issue attachment delete` fail without `--confirm` and name the
link or attachments they would remove in the error, so the first run without it
shows what would go.

`wiki docs convert` on a single file needs no `--confirm`; on a directory it
fails unless `--confirm` or `--dry-run` is present. `wiki page label add|remove`
with `--cql` fails unless `--confirm` or `--dry-run` is present, and
`wiki page delete|archive` fail without one of the two in every form.

`wiki template delete` prompts in an interactive terminal and fails with
`Use --force to delete in non-interactive mode` otherwise.

`jira bulk delete` processes up to `--limit` matches (default 1000).
`wiki page delete --cql` is capped at a fixed 1000 with no override. Always run
the same query through `--dry-run` first and show the user the match list and
count before the real run.

`jira bulk *` accepts `--issues K1,K2,...` in place of `--jql`.

`atlcli audit wiki --fix` (behind the `audit` feature flag) applies its "safe"
actions with no confirmation flag: labels on Confluence pages and a local
report file. It gates the rest (archive, delete) behind an interactive prompt. `--dry-run` works
alongside `--fix` and is the only preview. Never pass `--fix` on the strength of
an inferred intent.

## Other writes with no gate

These write and have no `--confirm`. Your own confirmation is the only
safeguard.

- `plugin install|remove|enable|disable` write to `~/.atlcli/plugins/` and
  `~/.atlcli/plugins.json`. `config set|unset` and `flag set|unset` edit
  `~/.atlcli/config.json` (`flag set` without `--global` edits the project
  `.atlcli/config.json`).
- `auth login|init|logout|delete|switch|rename`, `config set|unset` and
  `flag set|unset` change the user's stored state. Leave them to the user.
- `jira webhook register|delete|refresh|serve`.
- `jira template save|import` and `wiki template create|init|copy` refuse to
  overwrite an existing template unless `--force` is given.
- `wiki sh` and `wiki mount` are read-only unless `--mode rw`. Writes then
  reach Confluence. `rm` additionally needs `--allow-delete` and only moves
  pages to the trash. `--confirm` on `wiki sh` skips the terminal prompts for
  `rm` and cross-space `mv`; it does not unlock anything by itself.
- `wiki docs push` has no remote-change check: for each file it reads the
  current page and writes the local content as the next version, replacing
  whatever is there. Only `wiki docs sync` merges. Run `wiki docs diff <file>`
  first.
- `wiki docs pull --force` overwrites local modifications. `wiki docs sync`
  writes both ways unless `--dry-run`, and resolves conflicts per
  `--on-conflict` (`merge` by default, `local` overwrites the remote page).
- `jira worklog timer stop` logs a worklog to Jira. `timer start` and
  `timer cancel` only touch the local `~/.atlcli/timer.json`.
- `jira issue comment|comments add|comments edit`, `jira issue attach` (with or
  without `--comment`), `jira issue link`, `jira bulk move` and the other
  `create`, `update`, `assign`, `transition` verbs write at once.
- `wiki publish build|run` execute the build of the Astro project named in the
  publication project file, so they run that project's code. `wiki publish
  prune` needs `--confirm`.
- `wiki export` overwrites an existing DOCX output file without asking. For PDF
  an existing output file needs `--force`.
- `chat` and `research` send Atlassian content to the Anthropic API and need
  `ANTHROPIC_API_KEY` in the environment. Run them only when the user asked.
- The built-in `git` plugin is disabled by default. `atlcli git hook install`
  writes a `.git/hooks/post-commit` hook that runs `wiki docs push`, so every
  commit in that repository writes to Confluence, and `plugin disable git`
  does not remove the hook. `atlcli git hook remove` does, but only exists while the plugin is enabled. Never enable the
  plugin or install the hook unless the user asks.
- `models pull table-transformer` downloads about 30 to 116 MB plus a runtime
  of about 100 MB.
- `jira sprint review` and `jira version notes` create or update a Confluence
  page. `--force` takes over an existing page of the same title that atlcli did
  not create.

## Resolve names before acting

Never guess an identifier. Look it up, then use the value that came back.

| Need | Resolve with |
| --- | --- |
| Transition name | `jira issue transitions --key <key> --json` |
| Issue type | `jira project types --key <PROJECT> --json` |
| Account ID | `jira me --json`, or the `assigneeId` on a returned issue |
| Custom field ID | `jira field search "story point" --json` |
| Board / sprint ID | `jira board list --json`, `jira sprint list --board <id> --json` |
| Page ID | `wiki search --cql ... --json`, or frontmatter `atlcli.id` |
| Component / version ID | `jira component list --project <key> --json` |

Transition names are workflow **actions**, not target statuses:
`--to 'In Progress'` fails where `--to 'Start Progress'` succeeds. The
`transitions` response carries both: `transitions[].name` is what `--to`
takes, `transitions[].to.name` is the status it lands in.

## Anti-patterns

- Running a write command to "see what it does". Group help
  (`atlcli jira issue`) answers that with no API call.
- Passing `--confirm` because the command asked for it. `--confirm` is the
  user's decision, expressed to you, not a flag to satisfy the parser.
- Skipping `--dry-run` on a JQL- or CQL-scoped bulk operation. The query is
  the blast radius and it is easy to widen by one clause.
- Writing `--confirm` or `--dry-run` directly before a positional
  (`jira filter delete --confirm 10001`). The parser reads the next token as the
  flag's value and the id goes missing. Put the boolean flag last.
- Retrying a failed multi-step sequence from the top. Re-check state first;
  the earlier steps already applied.
