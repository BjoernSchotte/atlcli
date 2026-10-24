---
name: atlcli
description: >-
  Drives the atlcli CLI for Jira and Confluence: JQL/CQL search, issue
  create/update/transition/comment/link with Markdown descriptions and
  comments, attachments, subtasks, boards, sprints, epics, worklogs and
  timers, flow metrics (cycle time, aging, cumulative flow), bulk JQL edits,
  saved filters, release notes and sprint review pages, Confluence page CRUD,
  labels, comments, page history, Markdown
  workspace sync (wiki docs pull/push), Confluence as a shell or filesystem
  (wiki sh/mount), page templates, DOCX and PDF export, DOCX and PDF import
  as Confluence pages, static-site publishing, wiki content audits, Jira
  hygiene audits with a rules file and baseline, and a daily digest of what
  changed across Jira and Confluence. Use whenever
  "atlcli" is mentioned, and whenever a task touches Jira or Confluence at
  all, such as reading or filing a ticket, commenting, updating a status,
  assigning work, checking a board or sprint, preparing a standup, logging
  time, finding or editing a wiki page, exporting a page to Word or PDF, or
  importing a Word or PDF file into the wiki, even when the user never names
  the tool. Also covers atlcli invocation rules, profiles and credentials,
  JSON output and error codes, and the confirmation discipline required
  before any write.
license: Apache-2.0
metadata:
  tags: atlcli, jira, confluence, atlassian, cli
---

# atlcli

`atlcli` is installed and authenticated against the user's Atlassian site.
This skill was checked against the atlcli source at commit f3ccf080 plus
`atlcli skill`, after release v2026.10.4. v2026.10.4 does not have
`atlcli skill`, and it still has argument-parsing, `--help` and exit-code
behaviour that this skill no longer warns about. On any version other than
that source, follow rule 7 before relying on a detail here. The skill ships
with atlcli: `atlcli skill` prints the copy built from the same source as the
installed binary. A copy installed with `atlcli skill --install` or from the
repository stays as it was installed; when unsure whether this copy is
current, run `atlcli skill`.

Where the linked files are missing, `atlcli skill <path>` prints one, with the
path as linked, for example `atlcli skill references/safety.md`.

## Rules that apply to every invocation

1. **Confirm before writing.** Reads are free; every create, update,
   transition, comment, link, attach, delete, push, import, or bulk operation
   needs explicit user approval for that specific action. Some writes have no
   `--confirm` gate at all, such as `jira issue unlink --link <id>` and a DOCX
   export over an existing file. Never enable the git plugin or install its
   hook unless the user asks: the hook runs `wiki docs push` on every
   `git commit`. See [references/safety.md](references/safety.md).
2. **Always pass `--json`.** Some commands print tables without it. With
   `--json`, stdout carries only JSON, and every error comes back on stdout
   as `{"error":{"code":"ATLCLI_ERR_…"}}` with exit code 1, including an HTTP
   error from Jira or Confluence (`details.status` holds the HTTP status).
   Help and progress text go to stderr. `atlcli audit jira` exits 2 when it
   lists findings at `--fail-on`, which is a result, not a failure.
3. **Quote values with spaces as one argument.** `--jql 'project = PROJ'` and
   `--jql='project = PROJ'` mean the same. Switches such as `--json`,
   `--confirm` and `--dry-run` never take a value, so they can stand anywhere.
   A value that looks like a flag, such as `-foo`, needs the `=` form. See
   [references/invocation.md](references/invocation.md#flag-grammar).
4. **Discover with the bare group or `--help`.** `atlcli jira issue` prints
   the group help and makes no API call, and `--help` on a verb prints help
   without running it.
5. **Resolve names before using them.** Transition names are workflow actions
   (`Start Progress`), not statuses (`In Progress`). Issue types, account
   IDs, custom field IDs, board and page IDs all get looked up, never guessed.
6. **Write descriptions and comments as Markdown, never as hand-written ADF.**
   `--description`, `--description-file`, `comments add|edit --body` and
   `--body-file` convert Markdown to ADF. Reading with `--format markdown`
   turns content without a Markdown form into `<!--adf:…-->` markers that
   convert back exactly; leave them in place. Underline, text colour,
   subscript and superscript read as `<u>`, `<span style="color: …">`,
   `<sub>` and `<sup>`, and convert back as well. Details in
   [references/jira-issues.md](references/jira-issues.md).
7. **Verify the installed surface before promising a capability.** Run the
   bare group and read what that build actually offers. The atlcli
   documentation site follows the source and can describe things the
   installed release does not have yet.
8. **`jira issue comment` posts its positional text.** It is an alias of
   `comments add`, so `atlcli jira issue comment --key PROJ-101 list` posts
   "list". Read, edit and delete comments with
   `jira issue comments list|edit|delete`.
9. **Never push with `--force` unasked.** `wiki docs push` refuses a page
   that changed in Confluence since the last pull and fails with
   `ATLCLI_ERR_VALIDATION`, listing those pages; `--force` overwrites them.
   Run `wiki docs pull` or `wiki docs sync` to merge instead. See
   [references/confluence-docs-sync.md](references/confluence-docs-sync.md).

## Routing

| Task | Read |
| --- | --- |
| Anything that writes; `--dry-run` and `--confirm` semantics | [references/safety.md](references/safety.md) |
| Flag grammar, help discovery, JSON shapes, error codes | [references/invocation.md](references/invocation.md) |
| Profiles, credentials, config defaults, feature flags, logs, `doctor` | [references/auth-and-config.md](references/auth-and-config.md) |
| Read, create, update, transition, comment, link, attach an issue; Markdown descriptions and comments; history; subtasks | [references/jira-issues.md](references/jira-issues.md) |
| Find issues: JQL, convenience filters, saved filters, CSV/JSON export and import | [references/jira-search.md](references/jira-search.md) |
| Boards, sprints, sprint review pages, epics, velocity/burndown, flow metrics (cycle time, aging, cumulative flow), the status map, worklogs and timers | [references/jira-agile.md](references/jira-agile.md) |
| Bulk JQL changes and moves, projects, components, versions, release notes pages, custom fields, issue templates, watchers, webhooks | [references/jira-bulk-and-admin.md](references/jira-bulk-and-admin.md) |
| Confluence: find pages, create/delete/copy/move them, replace a whole body, page tasks to Jira issues, and page metadata: labels, comments, history, Jira links, spaces | [references/confluence-pages.md](references/confluence-pages.md) |
| **Editing text that already exists on a page**, one page or many: `wiki docs` init/pull/status/push/sync, conflicts, file format, macros, the git plugin | [references/confluence-docs-sync.md](references/confluence-docs-sync.md) |
| Confluence as a shell or filesystem: `wiki sh`, `wiki mount`, `wiki vfs` | [references/confluence-vfs.md](references/confluence-vfs.md) |
| Confluence page templates: storage levels, rendering, creating pages from them | [references/confluence-templates.md](references/confluence-templates.md) |
| Exporting Confluence pages to DOCX or PDF, export jobs | [references/confluence-export.md](references/confluence-export.md) |
| PDF export options in depth, PDF template packs (`pdf-template`) | [references/confluence-pdf.md](references/confluence-pdf.md) |
| **Creating pages from a Word or PDF file**: `wiki import` preview and confirm, page trees, in-place update, batch | [references/confluence-import.md](references/confluence-import.md) |
| A static Astro or Starlight site from Confluence pages: `wiki publish` | [references/confluence-publish.md](references/confluence-publish.md) |
| Content health of a synced docs directory: stale pages, orphans, broken links (`audit wiki`) | [references/confluence-audit.md](references/confluence-audit.md) |
| Jira hygiene: stuck or unassigned work, stale and overdue issues, rules file, baseline (`audit jira`) | [references/jira-audit.md](references/jira-audit.md) |
| What changed since the last look, what waits on the user, a standup note: `atlcli digest` | [references/digest.md](references/digest.md) |
| Many changes or changes needing logic, as one reviewed plan: TypeScript scripts with `atlcli script` (plan, then apply) | [references/scripts.md](references/scripts.md) |
| Plugins (`git`, `drawio`), `models`, `log`, `update`, `completion` | [references/plugins-and-local-tools.md](references/plugins-and-local-tools.md) |
| This skill's own files, printing or installing it: `atlcli skill` | [references/plugins-and-local-tools.md](references/plugins-and-local-tools.md#skill) |

`atlcli research` and `atlcli chat` send Jira and Confluence content to the
Anthropic API and need `ANTHROPIC_API_KEY`. Use them only when the user asks
for them by name.

## Command groups

```
jira  project issue board sprint worklog epic analyze bulk filter export
      import search me my watch unwatch watchers webhook subtask component
      version field template
wiki  page space docs search my recent template export import publish
      sh mount vfs
top   auth completion config doctor flag log models plugin update version
      release-info research chat pdf-template digest audit skill tui
      script
```

`atlcli tui` is an interactive fullscreen browser for people; it fails without
a terminal, so agents use the commands above instead.

Some commands are gated behind feature flags: without its flag
`atlcli audit` fails with `Audit feature is not enabled`, although the root
help lists it. Enabling one
with `atlcli flag set <name> true --global` edits `~/.atlcli/config.json`, so
ask first. Enabled plugins add their own top-level commands (`atlcli git`,
`atlcli drawio`). Check `atlcli flag list` and `atlcli plugin list --json` when
a documented capability seems missing.

## Starting a Jira task

```bash
atlcli auth status --json                 # which site am I on
atlcli config list --json                 # defaults that silently scope commands
atlcli jira me --json                     # my accountId, for --assignee
atlcli jira project types --key PROJ --json   # valid --type values
atlcli jira issue transitions --key PROJ-101 --json   # valid --to values
```

## Reporting back

Quote the exact command that ran and the key or ID that came back. When a
multi-step sequence fails partway, say which steps applied. atlcli writes are
not transactional and the earlier calls already landed. The exception is
`wiki import`: a confirmed run deletes the pages it created if publication or
read-back verification fails.
