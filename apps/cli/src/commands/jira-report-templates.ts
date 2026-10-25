/**
 * Bundled templates for `jira version notes` and `jira sprint review`.
 *
 * They are ordinary atlcli templates (YAML front matter + Jinja markdown)
 * rendered with the whole `ReportData` model, so a user template saved under
 * the same name — or any other name passed with `--template` — replaces them
 * without code changes. `--print-template <name>` writes one out as a start.
 * Fields ending in `Md` are pre-escaped markdown. `excerpt` is the opening
 * text of the issue description (about two lines).
 */

export const BUNDLED_REPORT_TEMPLATES: Record<string, string> = {
  "release-notes": `---
name: release-notes
description: Release notes for a Jira version, grouped by issue type
labels: [release-notes]
---
{% if source.released %}{status:green}Released{status}{% else %}{status:blue}Unreleased{status}{% endif %}{% if source.releaseDateMd %} · {{ source.releaseDateMd }}{% endif %}

{% if source.descriptionMd %}
{{ source.descriptionMd }}

{% endif %}
| Issues | Done | In progress | To do |
| --- | --- | --- | --- |
| {{ metrics.total }} | {{ metrics.done }} ({{ metrics.donePercent }}%) | {{ metrics.inProgress }} | {{ metrics.todo }} |

{% for group in byType %}
## {{ group.nameMd }} ({{ group.count }})

{% for issue in group.issues %}
- {{ issue.link }} **{{ issue.summaryMd }}**{% if not issue.done %} · *{{ issue.status }}*{% endif %}{% if issue.excerptMd %}\\
  {{ issue.excerptMd }}{% endif %}
{% endfor %}

{% endfor %}
{% if contributors | length %}
## Contributors

{% for person in contributors %}
- {{ person.nameMd }} ({{ person.count }})
{% endfor %}
{% endif %}
`,

  "release-notes-by-epic": `---
name: release-notes-by-epic
description: Release notes for a Jira version, grouped by epic
labels: [release-notes]
---
{% if source.released %}{status:green}Released{status}{% else %}{status:blue}Unreleased{status}{% endif %}{% if source.releaseDateMd %} · {{ source.releaseDateMd }}{% endif %}

{% if source.descriptionMd %}
{{ source.descriptionMd }}

{% endif %}
| Issues | Done | In progress | To do |
| --- | --- | --- | --- |
| {{ metrics.total }} | {{ metrics.done }} ({{ metrics.donePercent }}%) | {{ metrics.inProgress }} | {{ metrics.todo }} |

{% for epic in byEpic %}
## {{ epic.nameMd }}{% if epic.key %} ([{{ epic.key }}]({{ epic.url }})){% endif %}

{% for issue in epic.issues %}
- {{ issue.link }} {{ issue.type }}: **{{ issue.summaryMd }}**{% if not issue.done %} · *{{ issue.status }}*{% endif %}{% if issue.excerptMd %}\\
  {{ issue.excerptMd }}{% endif %}
{% endfor %}

{% endfor %}
`,

  "sprint-review": `---
name: sprint-review
description: Sprint review page with goal, metrics, done and carried-over work
labels: [sprint-review]
---
{% if source.goalMd %}
:::info
**Sprint goal:** {{ source.goalMd }}
:::

{% endif %}
{% if source.startDay %}{{ source.startDay }} – {{ source.endDay }} · {% endif %}{{ source.state }}

| Issues | Done | Not done |{% if metrics.points %} Points committed | Points completed |{% endif %}{% if metrics.sayDoRatio %} Say/do |{% endif %}
| --- | --- | --- |{% if metrics.points %} --- | --- |{% endif %}{% if metrics.sayDoRatio %} --- |{% endif %}
| {{ metrics.total }} | {{ metrics.done }} ({{ metrics.donePercent }}%) | {{ openIssues | length }} |{% if metrics.points %} {{ metrics.points.committed }} | {{ metrics.points.completed }} |{% endif %}{% if metrics.sayDoRatio %} {{ metrics.sayDoRatio }}% |{% endif %}

## Done ({{ doneIssues | length }})

{% for issue in doneIssues %}
- {{ issue.link }} **{{ issue.summaryMd }}**{% if issue.assignee %} · {{ issue.assignee }}{% endif %}{% if issue.excerptMd %}\\
  {{ issue.excerptMd }}{% endif %}
{% endfor %}

{% if openIssues | length %}
## Not done ({{ openIssues | length }})

{% for issue in openIssues %}
- {{ issue.link }} **{{ issue.summaryMd }}** · *{{ issue.status }}*{% if issue.assignee %} · {{ issue.assignee }}{% endif %}{% if issue.excerptMd %}\\
  {{ issue.excerptMd }}{% endif %}
{% endfor %}
{% endif %}
`,
};
