---
title: "Access Audit"
description: "atlcli audit access: who can see and change what in Confluence spaces and Jira projects, with fix plans that remove access after review"
---

# Access Audit

`atlcli audit access` answers who can see and change what in Confluence and Jira. It reads space permissions and space roles, Jira permission schemes and project roles, groups and users, and with `--pages` the restrictions of pages, into one model joined on Atlassian account ids. It then finds:
- spaces and projects anyone can open without logging in, or every licensed user can edit or administer;
- deactivated accounts and empty groups that still hold access;
- spaces and projects without an active administrator, with only one, or with an external one;
- pages nobody active can edit, and inactive accounts in page restrictions.

It only reports. What your account may not read is listed as incomplete, not guessed. Changes happen only when you ask for them with `--fix`, as a plan you review first.

Every check is a TypeScript rule script that runs read-only in the [script sandbox](scripts.md). The rules file, baseline and report formats work as for [Jira Audit](jira/audit.md), and you can add or replace rules (see [Writing your own access rule](#writing-your-own-access-rule)).

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- The audit feature flag, shared with Jira and Wiki Audit:

  ```bash
  atlcli flag set audit true --global
  ```

- No admin rights are needed to start. What you can read decides what the audit sees:

| Data | Readable with a normal API token | Without the right |
|---|---|---|
| Space permissions, role mode, space roles and role assignments | For every space you can view | Spaces you cannot view are not listed at all |
| Permission schemes and which scheme a project uses | Yes | The project is listed as incomplete |
| Project role members | Only with **Administer Projects** for that project | The project is listed as incomplete; role-based access is missing and the admin rules skip it |
| Users (status, account type, external, guest) and group members | Yes | The run notes that their status is unknown |
| Page restrictions (`--pages`) | For every page you can view | Pages you cannot view are not listed |
| Applying fixes | Admin rights on the space; **Administer Projects** for role changes; Jira admin rights for permission scheme changes | The apply fails with 403 |

Projects and spaces you cannot see do not show up anywhere in the report, so a clean report covers only what your account sees.

## Steps

1. Audit one space and one project:

   ```bash
   atlcli audit access --space DOCSY --project ATLCLI
   ```

   Warnings and errors are listed; info findings are counted as quiet. The lines below the findings say what was read (`Read 1 space(s), 1 project(s), …`) and what was incomplete.

2. Widen the scope. Without `--space` and `--project`, every shared space and every project you can see is read:

   ```bash
   atlcli audit access
   ```

3. Accept what you already know about, so that only new findings show up from now on:

   ```bash
   atlcli audit access --update-baseline
   ```

4. Include page restrictions for the spaces that need it (one request per page):

   ```bash
   atlcli audit access --space DOCSY --pages --min-level info
   ```

5. Plan fixes, review the plan, then apply it:

   ```bash
   atlcli audit access --space DOCSY --checks stale --fix
   atlcli audit access --space DOCSY --checks stale --fix --apply
   ```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `--space` | keys (comma-separated) or `'*'` | all shared spaces when neither `--space` nor `--project` is given | Spaces to read; `'*'` is every space except personal ones |
| `--project` | keys (comma-separated) or `'*'` | all projects when neither `--space` nor `--project` is given | Projects to read |
| `--product` | `confluence`, `jira`, `both` | `both` | Only this product; the other's `--space`/`--project` is ignored |
| `--personal` | flag | off | With `--space '*'` (or no scope): include personal spaces |
| `--pages` | flag | off | Also read the page restrictions of the spaces in scope; needs spaces in scope |
| `--max-pages` | integer ≥ 1 | `5000` | Stop reading pages after this many; the report is then partial |
| `--rules` | file path | first rules file found | Rules file; its `access:` section is used |
| `--checks` | comma-separated | all active rules | Only these rule ids or categories (`exposure`, `stale`, `admin`, `reach`, `hygiene`, `pages`). Turns rules off, never on |
| `--min-level` | `info`, `warning`, `error` | rules file `minLevel` | List findings from this level; lower ones are counted as quiet |
| `--fail-on` | `info`, `warning`, `error`, `never` | `error` | Exit 2 when a listed finding reaches this level |
| `--update-baseline` | flag | off | Accept every current finding into the baseline |
| `--prune-baseline` | flag | off | Remove baseline entries no finding matches any more |
| `--no-baseline` | flag | off | Ignore the baseline |
| `--markdown` | flag | off | Markdown report (the default Jinja template) |
| `--template` | file path | — | Render the report with your own [Jinja](templating.md) template |
| `--output` | file path | stdout | Write the report to this file, replaced only once complete |
| `--format` | `md`, `json`, `jsonl`, `csv` | from the `--output` extension, else the text report | Report format |
| `--report` | file path | — | Same as `--format md --output <file>` |
| `--json` | flag | off | JSON report (`schemaVersion: "3"`, `product: "access"`) |
| `--script` | file path, repeatable | — | Add a rule script |
| `--list-rules` | flag | off | List the rules with their source |
| `--print-rule` | rule id | — | Print a rule's script, built-ins included |
| `--fix` | flag | off | Plan the `fix` exports of the listed findings; nothing changes |
| `--apply` | flag | off | With `--fix`: apply the plan (asks first; `--yes` skips the question) |
| `--plan-out` | file path | — | With `--fix`: save the plan for `atlcli script apply` |

The rules file is the first of `--rules`, `./.atlcli/audit-rules.yaml`, `~/.atlcli/profiles/<profile>/audit-rules.yaml` and `~/.atlcli/audit-rules.yaml`. The baseline is `~/.atlcli/profiles/<profile>/audit-access-baseline.json`. Report files and formats work as described in [Jira Audit: report files and formats](jira/audit.md#report-files-and-formats); in CSV and Markdown the assignee column holds the principal.

## Rules

Each rule judges one kind of item: `resources` (spaces and projects), `spaces`, `projects`, `pages` (only with `--pages`) or `users`. `--list-rules` lists them, `--print-rule <id>` prints one.

| Rule | Items | `minimal` / `default` / `strict` | Finds | Fix |
|---|---|---|---|---|
| `exposure/anonymous-space` | spaces | error / error / error | Anyone can view, edit or administer the space without logging in | Removes the anonymous access |
| `exposure/anonymous-project` | projects | error / error / error | The permission scheme gives anyone Browse Projects or more | Deletes those grants from the scheme |
| `exposure/all-users` | spaces, projects | off / warning / warning | Every licensed user can edit (info) or administer (warning) | — |
| `stale/inactive-user-grant` | spaces, projects | off / warning / warning | A deactivated or closed account holds access | Removes the account's space access, its project role memberships and the scheme grants naming it |
| `stale/empty-group-grant` | spaces, projects | off / info / info | A group without active members holds access | — |
| `stale/inactive-in-restriction` | pages | off / off / info | An inactive account is named in a view or edit restriction | Removes the account from the restriction |
| `admin/no-active-admin` | spaces, projects | error / error / error | No active user and no group with members administers it | — |
| `admin/single-admin` | spaces, projects | off / off / info | Exactly one active administrator and no admin group | — |
| `admin/external-admin` | spaces, projects | off / warning / warning | An external collaborator or guest administers it | — |
| `reach/broad-admin` | users | off / off / info | Someone administers more than `max` (default 10) spaces and projects, directly or through groups | — |
| `hygiene/direct-user-grants` | spaces, projects | off / off / info | More than `max` (default 10) users granted one by one instead of through a group | — |
| `hygiene/unmigrated-access` | spaces | off / off / info | During the move to space roles (`ROLES_TRANSITION`), users or groups hold access without a role | — |
| `pages/locked-out` | pages | off / warning / warning | An edit restriction only inactive accounts or empty groups pass | — |

`minLevel` is `warning` in `minimal` and `default` and `info` in `strict`, so info findings are listed only with `--min-level info` or `extends: strict`.

### Access levels

Every grant has a level: `read`, `write` or `admin`.

- **Confluence:** `administer:space` is admin. `create`, `update`, `delete`, `archive` and `restrict_content` on pages, blog posts, attachments, whiteboards, databases, folders and embeds are write. Everything else is read, including `delete:space`, which means "delete own content", not deleting the space. A space role gets the level of its permissions.
- **Jira:** Administer Projects is admin. Browse Projects plus any permission that changes issues (create, edit, transition, delete, assign, …) is write. Browse Projects alone is read. A holder without Browse Projects or Administer Projects has no access.
- **Team-managed Jira projects** show their access level (open, limited) as application role grants that include Administer Projects. Those all-users grants count as edit access at most, because administration there goes through the Administrator role.

Site and product admins are not counted as administrators of a space or project. A grant to every licensed user does count, so `admin/no-active-admin` stays silent where everyone administers (for example on Jira Free).

### Coverage and incomplete resources

A space or project whose grants could not be read completely is kept with `complete: false` and a note, and the report lists it:

```
Read 12 space(s), 8 project(s), 143 user(s), 21 group(s).
Incomplete: project OPS: role members not readable (not permitted; needs Administer Projects).
```

Rules see what was readable. `admin/no-active-admin` and `admin/single-admin` skip incomplete resources, because a missing role member could be the admin. `--max-pages` cuts the page list and marks the report partial (`pages (--max-pages 5000)`), so counts are lower bounds.

### Space roles

Confluence Cloud sites move from space permissions to space roles. `status` in each space finding, and `mode` on the space item, is the site's mode:

| Mode | Access comes from | `removeSpaceAccess` removes |
|---|---|---|
| `PRE_ROLES` | Space permission records | The principal's permission records |
| `ROLES_TRANSITION` | Roles, plus permission records outside roles ("custom access") | The role assignment and the matching permission records |
| `ROLES` | Role assignments | The role assignment |

For Jira projects, `status` is `classic` or `team`.

## Fixes

Three built-in rules propose a fix. `--fix` runs them for listed findings only (not for quiet or baseline findings) and shows the plan with space or project, principal and access; nothing changes until you apply it.

```bash
atlcli audit access --project '*' --checks stale --fix                           # the plan
atlcli audit access --project '*' --checks stale --fix --apply                   # apply after a question (--yes skips it)
atlcli audit access --project '*' --checks stale --fix --plan-out access-fix.json
atlcli script apply access-fix.json                                             # apply the saved plan
```

- `exposure/anonymous-space` removes anonymous access with `confluence.removeSpaceAccess`.
- `exposure/anonymous-project` deletes the `anyone` grants from the permission scheme. A scheme is shared: this changes **every project that uses it**. A custom rule that declares `meta.permissions` needs `jira:write:*` for this.
- `stale/inactive-user-grant` removes the account from the space, from each project role it holds, and deletes the scheme grants that name it.
- `stale/inactive-in-restriction` writes the restriction without the account. It never lifts a restriction entirely: when the account is the last one named, the fix logs `<page>: removing <name> would lift the <read|update> restriction; left as is.` and plans nothing.

The plan checks the live state: access that is already gone shows as skipped (`no access`, `not in role`, `no such grant`).

:::caution
Confluence Free and Jira Free do not allow changing permissions through REST. Confluence answers 403 ("using the Free Edition"), and Jira Free has no custom permission schemes. Plans can be reviewed there, but not applied.
:::

## Rules file

The `access:` section of the [rules file](jira/audit-rules.md) takes `extends`, `minLevel`, `rules` and `scripts`, like the `confluence:` section for wiki rules:

```yaml
# .atlcli/audit-rules.yaml
access:
  extends: default
  minLevel: warning
  rules:
    exposure/all-users: off
    admin/single-admin: info
    hygiene/direct-user-grants: { severity: info, max: ["25"] }
    reach/broad-admin: { severity: info, max: ["5"] }
  scripts:
    - rules/access-team.ts       # relative to this file
```

Option values are text: write `max: ["25"]` or `max: "25"`, not `max: 25`. A rule that is off in the profile you extend (here `hygiene/direct-user-grants` in `default`) needs `severity` as well as its option.

## Writing your own access rule

`atlcli audit init --product access` writes a skeleton and the types (`atlcli.d.ts`) to `./.atlcli/audit/`. An access rule has `product: "access"` and picks its items with `meta.audit.items`:

| `items` | The rule gets | Key fields |
|---|---|---|
| `resources` (default) | each space and project (`AccessResource`) | `kind`, `key`, `name`, `mode`, `scheme`, `grants`, `complete`, `note` |
| `spaces`, `projects` | only spaces or only projects | as above |
| `pages` | each page read with `--pages` (`AccessPage`) | `id`, `title`, `spaceKey`, `read`, `update`, `inheritedRead` |
| `users` | each user with what they reach (`AccessUserItem`) | `accountId`, `displayName`, `active`, `status`, `accountType`, `external`, `guest`, `access` |

A grant is `{ principal, level, operations, role?, grantIds? }`. A principal is `{ type, id, name }` with `type` one of `user`, `group`, `anonymous`, `all-users`, `product-admins` or `dynamic` (decided per issue: reporter, assignee, project lead); users add `active`, `accountType` and `external`, groups add `activeMembers`. A run-scope rule (`scope: "run"`) gets `{ resources, pages, users, groups, coverage, userAccess }` once.

Pass `principal` to `rule.finding` to name who holds the access. It shows in the report, and the default baseline subject becomes `<kind>:<key>|<type>:<id>`, so accepting one principal's finding does not hide another's. Findings target a `space`, `project`, `page` or `user`.

```ts
// .atlcli/audit/no-contractor-admins.ts
export const meta = {
  audit: {
    id: "team/no-contractor-admins",
    product: "access",
    title: "Contractors do not administer",
    items: "spaces",
    defaults: "warning",
  },
};

export default (space: AccessResource, rule: AuditRule) =>
  space.grants
    .filter((g) => g.level === "admin" && g.principal.type === "group" && g.principal.name.startsWith("contractors"))
    .map((g) => rule.finding({ principal: g.principal, detail: `${g.principal.name} administers this space.` }));

// Removes all of the group's access to the space, not only admin.
export async function fix(finding: AuditFinding, space: AccessResource) {
  await atlcli.confluence.removeSpaceAccess(space.key, { type: "group", id: finding.principal!.id });
}
```

```bash
atlcli audit access --space DOCSY --list-rules
atlcli audit access --space DOCSY --checks team/no-contractor-admins --fix
```

The verbs for reading and changing access (`confluence.spacePermissions`, `jira.projectRoles`, `confluence.removeSpaceAccess`, `jira.removeRoleActor`, …) are listed in the [Script API](reference/scripts.md#verbs). More on rule scripts: [Custom Audit Rules](audit-scripts.md).

## Examples

Minimal: who can get into one space and one project.

```bash
atlcli audit access --space DOCSY --project ATLCLI
```

Realistic: a nightly CI job over everything the service account sees. It fails on error findings (anonymous access, no active admin), keeps the findings as CSV, and saves a fix plan for someone to review:

```bash
status=0
atlcli audit access --fail-on error --output access.csv || status=$?
atlcli audit access --checks exposure,stale --fix --plan-out access-fix.json
exit $status
```

After review: `atlcli script apply access-fix.json`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The audit ran; no listed finding reached `--fail-on` |
| 1 | A request failed, or the arguments or the rules file were wrong |
| 2 | A listed finding reached `--fail-on` (default: an error) |

## Troubleshooting

**`Incomplete: project KEY: role members not readable (…; needs Administer Projects)`.**
Your account cannot read the project's role members. The project's role-based access is missing and the admin rules skip it. Run with an account that has **Administer Projects** for it, or accept the gap.

**A space or project is missing from the report.**
Your account cannot see it. Neither Confluence nor Jira lists what you cannot view, so the audit cannot report it.

**`--pages reads page restrictions of spaces; add --space.`**
`--pages` needs spaces in scope. Add `--space`, or drop `--product jira`.

**`… checks page restrictions; run with --pages to include it.`**
`stale/inactive-in-restriction` and `pages/locked-out` run only with `--pages`.

**`Partial: pages (--max-pages 5000) hit a limit`.**
The page cap was reached. Raise `--max-pages` or narrow `--space`.

**`Users could not be looked up (…); their status is unknown.`**
Inactive-account rules cannot judge those users. Check the profile's credentials and run again.

**`--fix --apply` fails with 403 "using the Free Edition".**
Confluence Free does not allow permission changes through REST. Change access in the space settings instead. Jira Free has no custom permission schemes, so scheme fixes fail there as well.

**`exposure/all-users` lists every project on Jira Free.**
Jira Free gives every user admin rights, so the finding is correct. Turn the rule off in the `access:` section if that is intended.

**The inactive-in-restriction fix plans nothing for a page.**
The account is the last one in that restriction, and removing it would lift the restriction. The fix logs this and leaves the page as it is; change the restriction by hand.

**`Audit feature is not enabled`.**
Run `atlcli flag set audit true --global`.

## Related topics

- [Custom Audit Rules](audit-scripts.md)
- [Audit Rules](jira/audit-rules.md): rules-file grammar
- [Jira Audit](jira/audit.md) and [Wiki Audit](confluence/audit.md)
- [Script API](reference/scripts.md): the access verbs
- [Automation Scripts](scripts.md): plans and `atlcli script apply`
