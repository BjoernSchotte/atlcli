/**
 * Bundled templates for `jira version notes` and `jira sprint review`.
 *
 * They are ordinary atlcli templates (YAML front matter + Handlebars markdown)
 * rendered with the whole `ReportData` model, so a user template saved under
 * the same name — or any other name passed with `--template` — replaces them
 * without code changes. `--print-template <name>` writes one out as a start.
 * Fields ending in `Md` are pre-escaped markdown: insert them with `{{{…}}}`.
 */

export const BUNDLED_REPORT_TEMPLATES: Record<string, string> = {
  "release-notes": `---
name: release-notes
description: Release notes for a Jira version, grouped by issue type
labels: [release-notes]
---
{{#if source.released}}{status:green}Released{status}{{else}}{status:blue}Unreleased{status}{{/if}}{{#if source.releaseDateMd}} · {{{source.releaseDateMd}}}{{/if}}

{{#if source.descriptionMd}}
{{{source.descriptionMd}}}

{{/if}}
| Issues | Done | In progress | To do |
| --- | --- | --- | --- |
| {{metrics.total}} | {{metrics.done}} ({{metrics.donePercent}}%) | {{metrics.inProgress}} | {{metrics.todo}} |

{{#each byType}}
## {{{nameMd}}} ({{count}})

{{#each issues}}
- {{{link}}} {{{summaryMd}}}{{#unless done}} · *{{status}}*{{/unless}}
{{/each}}

{{/each}}
{{#if contributors.length}}
## Contributors

{{#each contributors}}
- {{{nameMd}}} ({{count}})
{{/each}}
{{/if}}
`,

  "release-notes-by-epic": `---
name: release-notes-by-epic
description: Release notes for a Jira version, grouped by epic
labels: [release-notes]
---
{{#if source.released}}{status:green}Released{status}{{else}}{status:blue}Unreleased{status}{{/if}}{{#if source.releaseDateMd}} · {{{source.releaseDateMd}}}{{/if}}

{{#if source.descriptionMd}}
{{{source.descriptionMd}}}

{{/if}}
| Issues | Done | In progress | To do |
| --- | --- | --- | --- |
| {{metrics.total}} | {{metrics.done}} ({{metrics.donePercent}}%) | {{metrics.inProgress}} | {{metrics.todo}} |

{{#each byEpic}}
## {{{nameMd}}}{{#if key}} ([{{key}}]({{{url}}})){{/if}}

{{#each issues}}
- {{{link}}} {{type}}: {{{summaryMd}}}{{#unless done}} · *{{status}}*{{/unless}}
{{/each}}

{{/each}}
`,

  "sprint-review": `---
name: sprint-review
description: Sprint review page with goal, metrics, done and carried-over work
labels: [sprint-review]
---
{{#if source.goalMd}}
:::info
**Sprint goal:** {{{source.goalMd}}}
:::

{{/if}}
{{#if source.startDay}}{{source.startDay}} – {{source.endDay}} · {{/if}}{{source.state}}

| Issues | Done | Not done |{{#if metrics.points}} Points committed | Points completed |{{/if}}{{#if metrics.sayDoRatio}} Say/do |{{/if}}
| --- | --- | --- |{{#if metrics.points}} --- | --- |{{/if}}{{#if metrics.sayDoRatio}} --- |{{/if}}
| {{metrics.total}} | {{metrics.done}} ({{metrics.donePercent}}%) | {{openIssues.length}} |{{#if metrics.points}} {{metrics.points.committed}} | {{metrics.points.completed}} |{{/if}}{{#if metrics.sayDoRatio}} {{metrics.sayDoRatio}}% |{{/if}}

## Done ({{doneIssues.length}})

{{#each doneIssues}}
- {{{link}}} {{{summaryMd}}}{{#if assignee}} · {{assignee}}{{/if}}
{{/each}}

{{#if openIssues.length}}
## Not done ({{openIssues.length}})

{{#each openIssues}}
- {{{link}}} {{{summaryMd}}} · *{{status}}*{{#if assignee}} · {{assignee}}{{/if}}
{{/each}}
{{/if}}
`,
};
