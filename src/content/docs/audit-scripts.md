---
title: "Custom Audit Rules"
description: "Write audit rules in TypeScript: checks per issue or page, fixes as reviewable plans, and reports in TypeScript or Jinja"
---

# Custom Audit Rules

Every check of `atlcli audit jira` and `atlcli audit wiki` is a small TypeScript script, and so is every check you add. A rule gets one item at a time, an issue or a page, and returns a finding or nothing. atlcli loads the data once for all rules, runs the rules read-only in the [script sandbox](scripts.md), and applies severities, the [rules file](jira/audit-rules.md), the baseline and the report the same way for built-in and custom rules.

A rule can also:
- propose a fix (`export async function fix`), which `--fix` turns into a plan you review and apply;
- build its own report (`export function report`), in TypeScript or with a [Jinja](templating.md) template.

## Prerequisites

- The audit feature flag: `atlcli flag set audit true --global`
- For type checking in your editor: the types `atlcli audit init` writes (`atlcli.d.ts`)

## Steps

1. Write a skeleton and the types into `./.atlcli/audit/`:

   ```bash
   atlcli audit init                       # a Jira rule
   atlcli audit init --product confluence  # a wiki rule (see Wiki rules)
   ```

2. Edit `.atlcli/audit/bug-without-component.ts`:

   ```ts
   export const meta = {
     audit: {
       id: "team/bug-without-component",
       product: "jira",
       title: "Bugs need a component",
       fields: ["components"],
       defaults: "warning",
       profiles: { strict: "error" },
     },
   };

   export default (issue: JiraIssue, rule: AuditRule) => {
     const type = issue.fields.issuetype as { name?: string } | null;
     const components = issue.fields.components as unknown[] | null;
     if (type?.name !== "Bug" || components?.length) return;
     return rule.finding({ detail: "Bug without a component." });
   };
   ```

3. Check that it loads, then run the audit. Rules in `.atlcli/audit/` run with every audit started in this directory:

   ```bash
   atlcli audit jira --project ATLCLI --list-rules
   atlcli audit jira --project ATLCLI --checks team/bug-without-component
   ```

4. Optional: propose a fix and apply it after review (see [Fixes](#fixes)).

## Where rules come from

Rules load in this order. A rule with the id of an earlier one replaces it and keeps its place in the report; the report notes "… replaces the built-in rule".

| Order | Source |
|---|---|
| 1 | The built-in rules (`--print-rule <id>` prints one) |
| 2 | `~/.atlcli/audit/*.ts` |
| 3 | `./.atlcli/audit/*.ts` |
| 4 | `scripts:` in the [rules file](jira/audit-rules.md#rule-scripts) (`confluence.scripts:` for wiki rules), relative to that file |
| 5 | `--script <file>`, repeatable |

Files ending in `.d.ts` are skipped, and so are rules for the other product, except ones named with `--script`, which then fail.

To adapt a built-in, print it, change it, and keep its id:

```bash
atlcli audit jira --print-rule hygiene/stale > .atlcli/audit/stale.ts
atlcli audit wiki --print-rule content/stale > .atlcli/audit/wiki-stale.ts
```

A replacement keeps the built-in's older check name (`--checks stale`).

## Reference

### `meta.audit`

| Key | Type | Default | Description |
|---|---|---|---|
| `id` | `"<group>/<name>"`, lower case | required | Unique id; the group is the category unless `category` says otherwise |
| `product` | `jira`, `confluence` | required | Which audit runs it |
| `title` | string | the id | Heading in reports |
| `category` | string | the id's group | Used by `--checks <category>` |
| `kind` | `flag`, `age`, `until` | `flag` | `flag`: a finding or not. `age`/`until`: compare a number of days with thresholds through `rule.severity(days)` |
| `scope` | `item`, `run` | `item` | `item`: `default(item, rule)` per item. `run`: `default(data, rule)` once (see [Run-scope rules](#run-scope-rules)) |
| `items` | `open`, `done` | `open` | Jira: open issues, or issues done in the last 90 days |
| `fields` | string list | `[]` | Extra Jira fields to load |
| `needs` | string list | `[]` | Host data to prepare, see [Facts](#facts) |
| `defaults` | setting | `warning` for `flag` rules | The setting in every profile, in the [rules-file grammar](jira/audit-rules.md#rule-settings): `warning`, `off`, `{ warning: 30d, error: 60d }` |
| `profiles` | `{ minimal?, default?, strict? }` | — | Settings per profile; wins over `defaults` |
| `options` | `{ name: [allowed values] }` | — | Extra settings the rules file may set, read from `rule.config` |
| `description` | string | — | Free text |

Settings from the rules file (`rules`, `overrides`) apply to custom ids like to built-in ones.

### The `rule` argument

| Member | Description |
|---|---|
| `rule.config` | The effective setting for this item: level, thresholds and options after profile, rules file and overrides |
| `rule.facts` | What atlcli worked out for the item (see [Facts](#facts)) |
| `rule.now` | Milliseconds since the epoch, the same for the whole run |
| `rule.severity(days)` | For `age`/`until` rules: `{ severity, threshold, limit }` of the most severe threshold passed, or `undefined` |
| `rule.finding({ … })` | Marks a return value as a finding |

### Findings

Return `rule.finding({ … })`, a list of them, or nothing:

| Field | Required | Description |
|---|---|---|
| `detail` | yes | The text after the item |
| `severity` | no | Defaults to the configured level |
| `ageDays` | no | Sorts findings and shows in reports |
| `key`, `summary`, `status`, `assignee` | no | For run-scope rules: what the finding is about |
| `subject` | no | What the baseline records (default: the key) |
| `updated` | no | When the item last changed (ISO), for the legacy cutoff |

### Facts

Jira rules get these in `rule.facts`. Some need an entry in `meta.audit.needs`, so atlcli loads the extra data only when a rule asks.

| Fact | Needs | Description |
|---|---|---|
| `category` | — | `todo`, `wip` or `done`, after `--status-map` |
| `epic`, `subtask` | — | Issue type level |
| `created`, `startedAt` | — | When the issue was created and first moved to in progress |
| `currentFrom`, `statusId`, `statusName` | — | The current status and since when |
| `inOpenSprint` | `sprint` | In an open sprint |
| `points` | `points` | Story points (`--points-field` or detected) |
| `flagged`, `flaggedSince` | `flagged` | Flagged, and since when |
| `percentiles` | `cycle-percentiles` or `status-percentiles` | P-values of the done reference set for `p85`-style thresholds |
| `projectUsesVersions` | `versions` | For `items: "done"`: the project has versions |

`changelog` in `needs` loads each issue's history into `issue.changelog`.

### Run-scope rules

A rule with `scope: "run"` runs once. It gets `{ open, done, now }` and can read more through `atlcli.*`, for checks across many issues or across Jira and Confluence:

```ts
export const meta = { audit: { id: "team/epic-overload", product: "jira", scope: "run", defaults: "warning" } };

export default async ({ open }: { open: JiraIssue[] }) => {
  const perEpic = new Map<string, number>();
  for (const issue of open) {
    const parent = (issue.fields.parent as { key?: string } | null)?.key;
    if (parent) perEpic.set(parent, (perEpic.get(parent) ?? 0) + 1);
  }
  return [...perEpic].filter(([, n]) => n > 40).map(([key, n]) => ({ key, detail: `${n} open children.` }));
};
```

### Wiki rules

Rules with `product: "confluence"` run in `atlcli audit wiki` over the pages of the synced directory. The item is an `AuditPage`, built from the sync database:

| Field | Description |
|---|---|
| `id`, `title`, `spaceKey`, `url` | The page |
| `path`, `synced` | Local file relative to the sync root; `synced: false` and `path: null` for pages only in Confluence (`--include-remote`) |
| `parentId`, `ancestors` | Place in the tree |
| `contentType`, `status` | `page`, …; `current`, `draft`, `archived`, … |
| `version`, `versionCount`, `wordCount` | History and size |
| `createdAt`, `createdBy`, `lastModified`, `lastModifiedBy` | Users are `{ id, displayName, active }`; `active` is `null` until `--refresh-users` ran |
| `labels`, `restricted` | Labels; view or edit restrictions |
| `orphan`, `brokenLinks` | No incoming links and no parent; broken internal links `{ target, text, line }` (needs `links`) |
| `externalLinks` | `{ url, domain, text, line }`, plus `httpStatus`, `httpError`, `broken` with `http` (needs `links`) |
| `contributors` | Everyone who edited the page (needs `contributors`) |

`meta.audit.needs` for wiki rules: `links` (link graph), `http` (check external URLs; slow), `contributors`, `remote` (list unsynced pages through the API), `folders` (local folder problems). `fields` and `items` do not apply.

A wiki run-scope rule gets `{ pages, folderIssues, now }`; each folder issue is `{ file, code, message }`.

A wiki `fix` gets a third argument with the rule's id and effective config, so options set in the rules file reach the fix:

```ts
export const meta = {
  audit: { id: "team/owner-label", product: "confluence", title: "Pages need an owner label", options: { label: [] } },
};

export default (page: AuditPage, rule: AuditRule) => {
  if (page.labels.some((l) => l.startsWith("owner-"))) return;
  return rule.finding({ detail: "No owner-* label." });
};

export async function fix(_finding: AuditFinding, page: AuditPage, rule: AuditFixRule) {
  if (page.synced) await atlcli.confluence.addLabels(page.id, [rule.config.options?.label?.[0] ?? "owner-unknown"]);
}
```

```yaml
confluence:
  rules:
    team/owner-label: { severity: warning, label: [owner-docs] }
```

Fixes can use every Confluence write verb, `atlcli.confluence.archivePage(id)` included (Confluence archives in the background).

### Read-only

Rules only read. A write verb (`atlcli.jira.update`, `atlcli.confluence.addLabels`, …) ends the run with `permission-denied: audit rules only read`. Rules run in batches of 200 items per sandbox, with the [script limits](scripts.md) per batch.

## Fixes

A rule proposes a change with a `fix` export. It runs only with `--fix`, once per listed finding, and its writes become a plan like any [script](scripts.md) plan:

```ts
export async function fix(finding: AuditFinding, issue: JiraIssue) {
  await atlcli.jira.update(issue.key, { fields: { components: [{ name: "General" }] } });
}
```

```bash
atlcli audit jira --project ATLCLI --checks team/bug-without-component --fix                 # show the plan
atlcli audit jira --project ATLCLI --checks team/bug-without-component --fix --apply         # apply it (asks first)
atlcli audit jira --project ATLCLI --fix --plan-out fixes.json && atlcli script apply fixes.json
```

Only listed findings are fixed: quiet, legacy and baseline findings are not. Fixable findings carry `"fixable": true` in the JSON report.

## Reports

Three ways to a Markdown report; none needs a template.

1. **The default template:** `--markdown`. `--print-template` prints it, as a start for your own.
2. **A Jinja template file:** `--template report.md.j2` renders the report model; other templates in the same directory can be `{% include %}`d.

   ```jinja
   # Audit {{ generatedAt | date }}
   {% for f in findings %}
   - {{ f.key }} ({{ f.severity }}): {{ f.detail }}
   {% endfor %}
   ```

3. **TypeScript:** a rule exports `report(model)` and returns the Markdown, built freely or with a Jinja string through `atlcli.render`:

   ```ts
   export async function report(model: AuditReport) {
     const owners: Record<string, AuditFinding[]> = {};
     for (const f of model.findings) (owners[f.assignee ?? "unassigned"] ??= []).push(f);
     return atlcli.render(
       "# Audit\n{% for owner, list in owners | dictsort %}\n## {{ owner }} ({{ list | length }})\n{% for f in list %}- {{ f.key }}: {{ f.detail }}\n{% endfor %}{% endfor %}",
       { vars: { owners } },
     );
   }
   ```

   It runs with `--markdown` or `--report`; with several rules exporting `report`, `--report-script <id>` picks one (default: the last loaded).

`--report <file>` writes the report to a file; otherwise it goes to stdout. The model is the [JSON report](jira/audit.md#schema-version-3) plus `groups` (findings per rule with `title`) and `notes`.

## Examples

Minimal: a flag rule for done issues without a fix version in one project only.

```ts
export const meta = { audit: { id: "team/release-hygiene", product: "jira", items: "done", fields: ["fixVersions"] } };

export default (issue: JiraIssue, rule: AuditRule) =>
  (issue.fields.fixVersions as unknown[]).length ? undefined : rule.finding({ detail: "Done without a fix version." });
```

Advanced: an age rule with thresholds per profile, a fix that asks the assignee, and a rules file that tightens it for one project.

```ts
export const meta = {
  audit: {
    id: "team/waiting-for-customer",
    product: "jira",
    kind: "age",
    title: "Waiting for the customer too long",
    profiles: { default: { warning: "14d", error: "30d" }, strict: { warning: "7d", error: "14d" } },
  },
};

const DAY = 86_400_000;

export default (issue: JiraIssue, rule: AuditRule) => {
  if (rule.facts.statusName !== "Waiting for customer") return;
  const days = (rule.now - Date.parse(String(rule.facts.currentFrom ?? rule.facts.created))) / DAY;
  const hit = rule.severity(days);
  if (hit) return rule.finding({ severity: hit.severity, detail: `Waiting for ${Math.floor(days)} d.`, ageDays: days });
};

export async function fix(finding: AuditFinding, issue: JiraIssue) {
  await atlcli.jira.comment(issue.key, `Still waiting after ${finding.ageDays} days. Can we close this?`);
}
```

```yaml
# .atlcli/audit-rules.yaml
overrides:
  - match: { project: SUPPORT }
    rules:
      team/waiting-for-customer: { warning: 3d, error: 7d }
```

## Troubleshooting

**`meta.audit.id: expected "<group>/<name>"`.**
Ids are lower case with one slash, such as `team/stale-review`.

**My rule never reports anything.**
Run with `--list-rules` to see that it loads, and `--min-level info` in case its level is below the rules file's `minLevel`. An `age` rule without thresholds is off: give it `defaults` or `profiles`.

**`Audit rule … returned …; return rule.finding({ detail }) or nothing`.**
A return value needs a `detail` string.

**`permission-denied: audit rules only read`.**
Move the write into `export async function fix`.

**`export function report must return the report text`.**
Return the Markdown string; `console.log` goes to stderr and is not the report.

## Related topics

- [Jira Audit](jira/audit.md)
- [Wiki Audit](confluence/audit.md)
- [Audit Rules](jira/audit-rules.md)
- [Automation Scripts](scripts.md) and the [Script API](reference/scripts.md)
- [Templating](templating.md): Jinja syntax and filters
