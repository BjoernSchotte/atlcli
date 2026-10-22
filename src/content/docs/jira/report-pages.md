---
title: "Release Notes and Sprint Review Pages"
description: "Generate Confluence release notes and sprint review pages from Jira, with your own templates"
---

# Release Notes and Sprint Review Pages

`atlcli jira version notes` and `atlcli jira sprint review` collect a version's or sprint's issues from Jira, render them through a template and create or update a Confluence page. Optionally the page is exported to PDF or DOCX in the same run.

## Prerequisites

- Authenticated profile with Jira and Confluence access (`atlcli auth login`)
- **Jira permission**: Browse Projects
- **Confluence permission**: Add Pages in the target space

## Release notes

```bash
# Preview: prints the rendered markdown and whether the page would be created or updated
atlcli jira version notes "2.4.0" --project PROJ --space DOCS --dry-run

# Create or update the page
atlcli jira version notes "2.4.0" --project PROJ --space DOCS --parent 12345

# Group by epic instead of issue type, and export a PDF
atlcli jira version notes 10042 --space DOCS --group-by epic --export release-2.4.0.pdf
```

The version is given by id or by exact name (a name needs `--project`). All issues with that fix version are included.

## Sprint review

```bash
atlcli jira sprint review 456 --space TEAM --dry-run
atlcli jira sprint review 456 --space TEAM --parent 67890 --export sprint-42.pdf
```

The page shows the sprint goal, dates, issue and story-point counts, and done and not-done work. Story points come from `--points-field`, or the detected story points field; without one, point columns are left out. Scope change is not shown on the page; use `atlcli jira sprint report` for it.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `<id\|name>` / `<sprintId>` | positional | required | Version id or name; sprint id |
| `--project` | project key | `defaults.project` | Needed to find a version by name |
| `--space` | space key | `defaults.space` | Space of the page (required) |
| `--parent` | page ID | space root | Parent page for a new page |
| `--title` | string | `Release notes – <version>` / `Sprint review – <sprint>` | Page title |
| `--group-by` | `type` \| `epic` | `type` | Release notes only: picks the bundled template |
| `--template` | template name | `release-notes`, `release-notes-by-epic`, `sprint-review` | Template to render (see below) |
| `--var` | `name=value`, repeatable | none | Extra template variables |
| `--points-field` | field ID | detected (sprint) | Story points field |
| `--status-map` | `"<status>=todo\|wip\|done,…"` | `flow.statusMap` | Which statuses count as done (see [Status mapping](flow-metrics.md#status-mapping)) |
| `--dry-run` | flag | off | Print the markdown and the planned action; write nothing |
| `--force` | flag | off | Overwrite a same-title page atlcli did not create |
| `--export` | path ending in `.pdf` or `.docx` | none | Export the page after writing it; an existing file is replaced |
| `--export-template` | path or name | `report` (PDF) | Export template (as `atlcli wiki export --template`) |
| `--list-templates` | flag | off | List the bundled templates |
| `--print-template` | template name | none | Print a bundled template to start your own |

## PDF layout

A report PDF uses the built-in [Report template](../confluence/pdf-template-from-yaml.md#curated-report-template) and is laid out for reading on screen or sending around:

- no cover page; a title block with space, version, and export date opens page 1,
- the title in the running header from page 2, the export date and "page x of y" in the footer,
- a contents page only when the report has 8 or more sections (`##` headings),
- issue keys shown as pills (`ATLCLI-53`) that link to Jira,
- each issue with its summary in bold and the first two lines or so of its description,
- no closing "End of document" page.

Pass `--export-template <pack>` to use your own PDF template instead; it then decides about the cover, title block, and closing page, and the contents rule above still applies. DOCX exports keep the bundled DOCX template.

## Running it again

atlcli stores an identity (`kind`, Jira site, version or sprint id, content hash) in the page property `atlcli.jira-report`. The next run finds the page by title and identity and:

| Situation | Action |
|-----------|--------|
| No page with the title | `create` |
| atlcli's page for this version/sprint, content changed | `update` (new page version) |
| atlcli's page, nothing changed | `unchanged` (no new page version) |
| A page with the title exists but atlcli did not create it for this version/sprint | Stops with an error; use `--title` or `--force` |

## Templates

Templates are ordinary [atlcli templates](../confluence/templates.md): YAML front matter plus markdown with Handlebars. The whole report data model is passed in, so a template can loop over issues, groups and contributors however you like.

atlcli ships three:

| Name | Used by | Layout |
|------|---------|--------|
| `release-notes` | `version notes` (default) | Status, description, counts, one section per issue type, contributors |
| `release-notes-by-epic` | `version notes --group-by epic` | Same, one section per epic |
| `sprint-review` | `sprint review` | Goal panel, dates, counts, done and not done |

To customise one, print it, edit it and save it as a template at any level. A template with the same name as a bundled one replaces it; any other name is used with `--template`.

```bash
atlcli jira version notes --print-template release-notes > release-notes.md
$EDITOR release-notes.md
atlcli wiki template create release-notes --file release-notes.md   # or --profile <name> / --space <KEY>
```

Minimal custom template:

```markdown
---
name: changelog
---
{{#each doneIssues}}
- {{{link}}} {{{summaryMd}}}
{{/each}}
```

With the description excerpt on its own line (a trailing `\` is a line break):

```markdown
{{#each doneIssues}}
- {{{link}}} **{{{summaryMd}}}**{{#if excerptMd}}\
  {{{excerptMd}}}{{/if}}
{{/each}}
```

Grouped by epic, with each issue's assignee:

```markdown
---
name: epic-digest
labels: [release-notes]
---
{{#each byEpic}}
## {{{nameMd}}}
{{#each issues}}
- {{{link}}} {{{summaryMd}}}{{#if assignee}} ({{assignee}}){{/if}}
{{/each}}
{{/each}}
```

:::tip[Use triple braces for `…Md` fields]
Fields ending in `Md` and `link` are already escaped markdown. Insert them with `{{{…}}}` so Handlebars does not escape them again. Plain fields such as `summary` are raw text.
:::

### Template variables

| Variable | Type | Description |
|----------|------|-------------|
| `kind` | `release` \| `sprint` | Report kind |
| `source.id`, `source.name`, `source.nameMd` | string | Version or sprint |
| `source.descriptionMd` | string | Version description |
| `source.goalMd` | string | Sprint goal |
| `source.state` | string | Sprint state |
| `source.released` | boolean | Version released |
| `source.startDay`, `source.endDay`, `source.releaseDay` | `YYYY-MM-DD` | Dates |
| `source.releaseDateMd` | string | `{date:…}` lozenge for the release date |
| `issues`, `doneIssues`, `openIssues` | issue list | All, done, not done; sorted by key. On a sprint review, as of the sprint's end (see [As of the sprint](analytics.md#as-of-the-sprint)) |
| `byType`, `byEpic` | group list | Groups with `name`, `nameMd`, `count`, `issues`; epic groups also `key`, `url`; "No epic" last |
| `contributors` | list | `name`, `nameMd`, `count` (assignees) |
| `metrics.total`, `.done`, `.inProgress`, `.todo`, `.donePercent` | number | Counts |
| `metrics.points.committed`, `.completed` | number | With a story points field |
| `metrics.sayDoRatio` | number | Sprint only, with a story points field |
| `generatedAt` | ISO timestamp | Render time |

Each issue has `key`, `url`, `link` (`[KEY](url)`), `summary`, `summaryMd`, `excerpt` and `excerptMd` (the opening prose of the description as one line, about 240 characters, code and tables skipped; absent when the description is empty), `type`, `status`, `statusCategory` (`todo`, `inprogress`, `done`), `done`, `assignee`, `points`, and `epic` (`key`, `url`, `summary`, `summaryMd`).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Several versions are named …` | Version names repeat across projects or archives | Pass the version id |
| `A page "…" already exists … not created by atlcli` | Title clash with a hand-written page | `--title "…"` or `--force` |
| Text like `&#x27;` on the page | A custom template used `{{field}}` for an `…Md` field | Use `{{{field}}}` |
| Finished issues listed under "Not done" | The done status sits in Jira's In Progress category | `--status-map "Fertig=done"` or `flow.statusMap`; see [Completed work](analytics.md#completed-work) |
| An issue that is done today is listed under "Not done" on a sprint review | It was finished after the sprint ended | Expected: the review shows the sprint as of its end |
| `--json` with `--export` prints two JSON documents | The page result, then the export report | Parse them one by one, for example with `jq -s` |

## Related Topics

- [Boards and Sprints](boards-sprints.md)
- [Projects and Versions](projects.md)
- [Templates](../confluence/templates.md)
- [Export](../confluence/export.md)
- [Sprint Reporting recipe](../recipes/sprint-reporting.md)
