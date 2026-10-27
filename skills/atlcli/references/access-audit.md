---
name: access-audit
description: atlcli audit access, who can see and change what in Confluence spaces and Jira projects; coverage of what the account can read, rules, the access rules-file section, rule scripts and --fix plans that remove access.
metadata:
  tags: audit, access, permissions, roles, restrictions, governance
---

# Access audit

`atlcli audit access` reads space permissions and space roles, Jira
permission schemes and project roles, groups and users (and with `--pages`
page restrictions) into one model, and reports exposure, stale access and
admin gaps. It writes nothing unless `--fix --apply` applies a reviewed plan.
`--update-baseline` and `--prune-baseline` write a local baseline file.

## Contents

- [Running it](#running-it)
- [What the account can read](#what-the-account-can-read)
- [Rules](#rules)
- [Rules file and rule scripts](#rules-file-and-rule-scripts)
- [Fixes](#fixes)
- [Output and exit codes](#output-and-exit-codes)
- [Anti-patterns](#anti-patterns)

## Running it

Needs the `audit` feature flag, like `audit jira` (see
[jira-audit.md](jira-audit.md#enabling-and-help)). Help:
`atlcli audit access --help`.

```bash
atlcli audit access --space DOCSY --project ATLCLI --json
atlcli audit access --json                                   # every shared space and every visible project
atlcli audit access --product confluence --checks exposure --json
atlcli audit access --space DOCSY --pages --min-level info --json
```

- `--space KEYS|'*'`, `--project KEYS|'*'`: comma-separated keys. Without
  both, everything of `--product` (`confluence`, `jira`, default `both`) is
  read. `'*'` skips personal spaces unless `--personal`.
- `--pages` reads each page's restrictions in the spaces in scope (one
  request per page, cap `--max-pages`, default 5000). It needs spaces in
  scope: `--pages reads page restrictions of spaces; add --space.`
- `--checks` takes rule ids or categories (`exposure`, `stale`, `admin`,
  `reach`, `hygiene`, `pages`); `--min-level`, `--fail-on`, `--rules`,
  `--script`, `--list-rules`, `--print-rule` work as in `audit jira`.

## What the account can read

A normal API token reads space permissions and role assignments of spaces it
can view, permission schemes, users and group members. Project role members
need **Administer Projects** for that project; without it the project is
listed as incomplete (`Incomplete: project KEY: role members not readable
(not permitted; needs Administer Projects).`), its role-based access is
missing, and `admin/no-active-admin` and `admin/single-admin` skip it.
Spaces and projects the account cannot see are not listed at all, so a clean
report covers only what the account sees. Say so when reporting results.

`diagnostics` holds `Read N space(s), …`, the incomplete resources and notes
such as `Users could not be looked up`. `partial` lists page lists cut at
`--max-pages`.

## Rules

| Rule | Items | minimal / default / strict | Fix |
|---|---|---|---|
| `exposure/anonymous-space` | spaces | error / error / error | remove anonymous access |
| `exposure/anonymous-project` | projects | error / error / error | delete the scheme's `anyone` grants (scheme-wide) |
| `exposure/all-users` | spaces, projects | off / warning / warning (edit: info, admin: warning) | — |
| `stale/inactive-user-grant` | spaces, projects | off / warning / warning | remove space access, role memberships, direct grants |
| `stale/empty-group-grant` | spaces, projects | off / info / info | — |
| `stale/inactive-in-restriction` | pages | off / off / info | drop the account from the restriction |
| `admin/no-active-admin` | spaces, projects | error / error / error | — |
| `admin/single-admin` | spaces, projects | off / off / info | — |
| `admin/external-admin` | spaces, projects | off / warning / warning | — |
| `reach/broad-admin` | users | off / off / info (option `max`, 10) | — |
| `hygiene/direct-user-grants` | spaces, projects | off / off / info (option `max`, 10) | — |
| `hygiene/unmigrated-access` | spaces | off / off / info | — |
| `pages/locked-out` | pages | off / warning / warning | — |

Levels: Confluence `administer:space` is admin; create, update, delete,
archive or restrict_content on content (page, blogpost, attachment, …) is
write; the rest is read, including `delete:space` (delete own content).
Jira Administer Projects is admin, Browse Projects plus an issue-changing
permission is write, Browse Projects alone is read, nothing without Browse.
In team-managed projects, all-users grants count as write at most. Site and
product admins are not counted as admins; a grant to all users is.

Spaces carry the site's role mode in `status`: `PRE_ROLES`,
`ROLES_TRANSITION` or `ROLES`. Projects: `classic` or `team`.

## Rules file and rule scripts

The rules file's `access:` section takes `extends`, `minLevel`, `rules`,
`scripts`. Option values are text, and a rule off in the profile needs
`severity` with its option:

```yaml
access:
  extends: default
  rules:
    exposure/all-users: off
    hygiene/direct-user-grants: { severity: info, max: ["25"] }
```

Rule scripts have `product: "access"` and `meta.audit.items` of
`resources` (default), `spaces`, `projects`, `pages` or `users`. Items:
`AccessResource` (`kind`, `key`, `mode`, `scheme`, `grants`, `complete`),
`AccessPage` (`read`, `update`, `inheritedRead`), `AccessUserItem`
(`active`, `external`, `guest`, `access`). A grant is
`{ principal, level, operations, role?, grantIds? }`; pass `principal` to
`rule.finding` so the finding names who holds access. `atlcli audit init
--product access` writes a skeleton (writes files: ask first). Docs page:
Access Audit (`/access-audit/`).

## Fixes

`--fix` plans the `fix` exports of listed findings; `--plan-out f.json` saves
the plan for `atlcli script apply f.json`; `--fix --apply` applies after a
prompt (`--yes` only with the user's go). Show the plan first: these changes
remove people's access.

- Verbs: `confluence.removeSpaceAccess` (`ROLES`: role assignment;
  `ROLES_TRANSITION`: role and matching permission records; `PRE_ROLES`:
  permission records), `jira.removeRoleActor`, `jira.deletePermissionGrant`
  (changes every project using the scheme). See [scripts.md](scripts.md#verbs).
- Already-removed access is skipped (`no access`, `not in role`,
  `no such grant`).
- `stale/inactive-in-restriction` never lifts a restriction: if the account
  is the last one named, the fix only logs.
- Confluence Free (403 "using the Free Edition") and Jira Free (no custom
  permission schemes) refuse permission changes via REST: plans cannot be
  applied there. On Jira Free every user is admin, which `exposure/all-users`
  reports.

## Output and exit codes

Report options are those of `audit jira` (`--json` schemaVersion 3 with
`product: "access"`, `--output`, `--format md|json|jsonl|csv`, `--markdown`,
`--template`); see [jira-audit.md](jira-audit.md#report-files-and-formats).
Findings target `space`, `project`, `page` or `user` and carry `principal`
`{ type, id, name }`; CSV and Markdown show it as the assignee. Baseline:
`~/.atlcli/profiles/<profile>/audit-access-baseline.json`, subject
`<kind>:<key>|<type>:<id>`. Exit 0 ran, 1 failed or wrong arguments, 2 a
listed finding reached `--fail-on` (default `error`): a result, not a failure.

## Anti-patterns

- Reading a clean report as "nobody has access": incomplete and invisible
  resources are not judged.
- Applying `exposure/anonymous-project` fixes without checking which other
  projects share the scheme.
- `--fix --apply --yes` without the user having seen the plan.
- Expecting page rules without `--pages`.

Related: [jira-audit.md](jira-audit.md), [confluence-audit.md](confluence-audit.md),
[scripts.md](scripts.md), [safety.md](safety.md).
