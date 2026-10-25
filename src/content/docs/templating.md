---
title: "Templating"
description: "Variables, built-ins and control paragraphs for copies and templates in Jira and Confluence"
---

# Templating

Copies and templates in atlcli render [Jinja](https://jinja.palletsprojects.com/en/stable/templates/)
expressions: `Audit {{ year }}` becomes `Audit 2026`. The same rules apply everywhere, whether the template is
a live object people maintain in Jira or Confluence (a template project, a
template issue, a template page tree) or a local file.

| Operation | What renders |
|-----------|--------------|
| [`jira project copy-issues`](/jira/copy-issues/) | Summary, description, labels, comments, component and version names, `--fields` |
| [`jira issue clone`](/jira/issues/#clone-issue) | Summary, description, labels |
| [`jira template apply`](/jira/templates/) | Summary, description, labels, due date, other fields |
| [`wiki page copy`](/confluence/pages/#copy-page), with `--tree` | Titles and bodies, including macro parameters |
| [`atlcli.render()`](/reference/scripts/#atlclirender) in scripts | Whatever the script passes |
| [`wiki template`](/confluence/templates/) | Page templates (Markdown; see [differences](#wiki-template)) |

The syntax is Jinja, as implemented by [Nunjucks](https://mozilla.github.io/nunjucks/templating.html).
Code is never rendered: code blocks, inline code, code and noformat macros, and
`{code}` regions keep their `{{ … }}` and `{% … %}` as written.

Templates render inside a QuickJS sandbox without access to files, network or
the environment, with limits of 5 seconds and 64 MB per render and an output
budget per field and run.

## Breaking: templates use Jinja

atlcli used Handlebars before. Templates written for it do not render the same
way any more, and there is no converter: rewrite them with this table.

| Handlebars (old) | Jinja (new) |
|------------------|-------------|
| `{{@today}}`, `{{@year}}`, … | `{{ today }}`, `{{ year }}`, … (built-ins are plain names) |
| `{{#if x}}…{{else}}…{{/if}}` | `{% if x %}…{% else %}…{% endif %}` |
| `{{#unless x}}…{{/unless}}` | `{% if not x %}…{% endif %}` |
| `{{#each items}}{{this}} {{@index}}{{/each}}` | `{% for item in items %}{{ item }} {{ loop.index0 }}{% endfor %}` |
| `{{#with x}}…{{/with}}` | No equivalent: write `x.field`, or `{% set %}` |
| `{{@root.x}}` | `{{ x }}` (outer names stay visible inside loops) |
| `{{formatDate d "DD.MM.YYYY"}}` | `{{ d \| date("DD.MM.YYYY") }}` |
| `{{dateAdd @today 14 "d"}}` | `{{ today \| dateAdd(14, "d") }}` |
| `{{lowercase x}}`, `{{uppercase x}}` | `{{ x \| lower }}`, `{{ x \| upper }}` |
| `{{default x "fb"}}` | `{{ x \| default("fb") }}` |
| `{{replace s "a" "b"}}` | `{{ s \| replace("a", "b") }}` |
| `(eq a "x")`, `(ne a "x")` | `a == "x"`, `a != "x"` |
| `(and a b)`, `(or a b)`, `(not a)` | `a and b`, `a or b`, `not a` |
| `{{{x}}}` | `{{ x }}` (output is never HTML-escaped) |
| `\{{x}}` | `{% raw %}{{ x }}{% endraw %}` |
| `{{~x}}` | `{{- x }}`, `{{ x -}}` |
| `{{! note }}` | `{# note #}` (kept as written in copies, with a warning) |

## Prerequisites

- An atlcli version with templating (`atlcli template vars --help` works).
- For live templates: read access to the template project or space.

## Steps

1. Write variables into the template: `Release {{ version }}` in a summary,
   `{% for system in systems %}` rows in a table.
2. Check what the template needs:

   ```bash
   atlcli template vars --jql "project = TPLREL"
   ```

3. Give the values with `--var` or a vars file and plan:

   ```bash
   atlcli jira project copy-issues --from TPLREL --to REL --var version=4.2 --plan-out plan.json
   ```

4. Read **Template warnings** in the plan, then apply.

## Syntax

### Variables and context

| Expression | Value |
|------------|-------|
| `{{ version }}` | A value from `--var version=…` or the vars file |
| `{{ team.lead }}` | A nested value (`--var team.lead=Ann`, or YAML) |
| `{{ source.key }}`, `{{ source.summary }}`, `{{ source.fields.duedate }}` | The original issue (copy-issues, clone) |
| `{{ source.title }}`, `{{ source.id }}` | The original page (page copy) |
| `{{ parent.title }}`, `{{ parent.id }}` | The rendered parent copy (page copy `--tree`) |

### Built-ins

Built-ins are plain names. A variable of the same name (`--var`, vars file,
declaration) and the operation's context (`source`, `parent`) win over a
built-in. Dates use the clock frozen for the run, read in **UTC**, so a plan made again on another machine gives the same dates; see
[`--now`](#repeating-a-run).

| Built-in | Example | Notes |
|----------|---------|-------|
| `today` | `2026-10-25` | Always ISO; feed it to `dateAdd` |
| `date` | `2026-10-25` | Wiki templates may set another format |
| `now`, `datetime` | `2026-10-25T08:30:00.000Z` | |
| `year`, `month`, `day` | `2026`, `10`, `25` | |
| `quarter` | `4` | Write `Q{{ quarter }}` for `Q4` |
| `week` | `43` | ISO week |
| `weekday`, `time` | `Sunday`, `09:30` | |
| `user`, `profile`, `space`, `project` | | From the profile and target, where known |
| `uuid` | `2f1c…` | Different per field and issue or page; the same again for the same `--now`, so a re-plan repeats it |

### Filters and operators

| Filter or operator | Example | Result |
|--------------------|---------|--------|
| `dateAdd(n, unit)` | `{{ today \| dateAdd(14, "d") }}` | 14 days later; units `d`, `w`, `m`, `y`; months clamp to the month end |
| `date(format)` | `{{ today \| date("DD.MM.YYYY") }}` | `25.10.2026` |
| `default(fallback)` | `{{ owner \| default("Team") }}` | `Team` when `owner` is missing; `default("Team", true)` also replaces empty and false values |
| `replace(from, to)` | `{{ source.summary \| replace("2025", "2026") }}` | |
| `lower`, `upper` | `{{ team \| upper }}` | |
| `==`, `!=`, `and`, `or`, `not`, `in` | `{% if region == "eu" %}…{% endif %}` | For conditions |
| `~`, `+ - * /` | `{{ "Q" ~ quarter }}` | String concatenation, arithmetic |
| `is defined` | `{% if owner is defined %}…{% endif %}` | Test for a missing value |

All other Nunjucks built-in filters work too: `length`, `join`, `sort`,
`first`, `last`, `truncate`, `title`, `trim`, `dictsort`, `groupby`,
`selectattr`, `sum`, `round` and more.

Blocks work inside one text: `{% if internal %}(internal){% endif %}`,
`{% for system in systems %}{{ system }} {% endfor %}`. Loops also take
`{% else %}` (for an empty list) and dictionaries (`{% for k, v in owners %}`);
`{% set %}` and macros work as in Jinja.

### Control paragraphs

In rich text (Jira descriptions and comments, Confluence pages) a block can
span whole paragraphs, list items or table rows. A paragraph that holds
nothing but a block tag controls the paragraphs next to it and is removed from
the result:

```
{% if internal %}
This paragraph only appears with --var internal=true.
{% else %}
This one otherwise.
{% endif %}
```

The same works one level up:

- **List items**: a list item holding only `{% for system in systems %}`, an
  item with `{{ system }}`, and an item with `{% endfor %}` give one item per
  system.
- **Table rows**: a row whose first cell holds only
  `{% for system in systems %}`, a row with `{{ system }}` /
  `{{ owners[system] }}`, and a row with `{% endfor %}` give one row per
  system. The control rows disappear, other cells included: when
  those hold content, the plan warns (`dropped-content`).

Supported control tags: `{% if … %}`, `{% elif … %}`, `{% else %}`,
`{% endif %}`, `{% for x in … %}`, `{% for k, v in … %}` and `{% endfor %}`.
Inside a repeated block the loop variable and `loop.index` (from 1),
`loop.index0`, `loop.first`, `loop.last` and `loop.length` are set; variables
of the run stay visible (`{{ year }}`).

Control tags must pair up within the same parent (the same panel, cell or
list). If they don't, they stay as written and the plan warns.

## Unresolved expressions

Rendering is tolerant: an expression that cannot be filled stays exactly as
written, and the run lists it as a template warning with its location
(`SUP-1 summary 1:8  Unresolved {{ versoin }}`). The same goes for:

- an `{% if %}` or `{% for %}` block whose subject cannot be resolved: the
  whole block stays as written, so someone else's Jinja, Ansible or Helm
  snippet in a copied issue survives unchanged;
- unknown filters and functions (`unknown-helper`);
- an expression that runs across a mention, link or image, and a link that
  renders to an invalid URL.

A syntax error (an unclosed `{% if %}`, for example) keeps the whole field or
page unchanged and warns with `parse-error`. `{{ x | default("…") }}` and
`{% if x is defined %}` never warn about a missing `x`.

Use `--strict` to fail the run instead, for example in CI, where a silent
leftover is a bug:

```bash
atlcli jira project copy-issues --from TPLREL --to REL --var version=4.2 --strict
```

To keep template syntax literally, wrap it in
`{% raw %}{{ x }}{% endraw %}`. Jinja comments (`{# … #}`) also stay as
written, with a warning: in copied text they are the author's text.

In Jira wiki markup and plain-text fields, warnings give the line and column
in the field. In rich text (ADF descriptions, Confluence pages) they name the
field or page and the expression, without a position.

## Variables

### `--var`

```bash
--var version=4.2 --var internal=true --var team.lead=Ann --var 'systems=["IAM","Backup"]'
```

A bare `--var flag` is `true`; values that parse as JSON (numbers, `true`,
arrays, objects) are taken as such.

### `--vars-file`

One YAML file for values and, optionally, declarations. The same file can
serve several operations, for example a Jira copy and a page tree copy for the
same audit.

```yaml
variables:            # optional declarations
  year:    { type: number, required: true, description: "Audit year" }
  quarter: { type: select, options: [Q1, Q2, Q3, Q4], default: Q1 }
  kickoff: { type: date }
values:
  year: 2026
  systems: [IAM, Backup, Logging]
```

A file without `variables:` or `values:` is all values (`year: 2026`).

| Declaration key | Type | Default | Notes |
|-----------------|------|---------|-------|
| `type` | `string`, `number`, `date`, `boolean`, `select` | `string` | Values are converted and checked |
| `required` | boolean | `false` | Missing → prompt at a terminal, else error |
| `default` | string | none | Used when no value is given |
| `options` | list | none | Required for `select` |
| `description` | string | none | Shown in prompts and `template vars` |

**Precedence:** `--var` over the file's `values`, over a declared `default`.
Declarations in the file win over a Jira template's own.

Without a terminal, with `--json` or with `--yes`, atlcli never prompts: a
missing required variable fails the command and names it.

### `atlcli template vars`

Lists the variables a template uses, with declarations and where each is used:

```bash
atlcli template vars --jira-template release
atlcli template vars --issue TPL-1
atlcli template vars --jql "project = TPLAUDIT"
atlcli template vars --page 12345 --tree
atlcli template vars --file ./release.json
```

`--json` adds a `skeleton`: a `values:` file ready to fill in.

```bash
atlcli template vars --page 12345 --tree --json | jq -r .skeleton > audit-2026.yml
```

## Repeating a run

Built-ins render with the time the plan was made, and the plan records it
(`Templates: rendered at …`). Applying never renders again: it writes exactly
what the plan shows. To plan again with the same dates, for example to resume
a copy after midnight, pass that time:

```bash
atlcli jira project copy-issues --from TPLREL --to REL --var version=4.2 --now 2026-10-25T08:30:00.000Z
```

## Examples

### Minimal: one issue from a saved template

```bash
atlcli jira template save release --issue TPL-1        # records {{ version }} as a variable
atlcli jira template apply release --project REL --var version=4.2
```

### Realistic: a yearly audit in Jira and Confluence

`audit-2026.yml`:

```yaml
variables:
  year: { type: number, required: true }
values:
  year: 2026
  systems: [IAM, Backup, Logging]
```

```bash
# Issues: one per control, with a table row per system in each description
atlcli jira project copy-issues --from TPLAUDIT --to AUD26 --vars-file audit-2026.yml --strict --plan-out jira.json

# Pages: the audit handbook tree, titled "Audit {{ year }}"
atlcli wiki page copy --id 12345 --tree --title "Audit {{ year }}" --vars-file audit-2026.yml --plan-out pages.json

atlcli script apply jira.json
atlcli script apply pages.json
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `{{ x }}` stays in the result | No value, a typo, or the expression crosses a mention, link or image | Read the template warnings; run `atlcli template vars`; keep an expression within plain text |
| An old template renders oddly or not at all | It uses Handlebars syntax (`{{#if}}`, `{{@today}}`) | Rewrite it with the [migration table](#breaking-templates-use-jinja) |
| `parse-error`: a field or page is copied unchanged | A Jinja syntax error, such as an unclosed `{% if %}` | Fix the tags the warning names |
| Jinja or Helm snippets in a description | Their variables are not defined in this run | They stay as written, with a warning; put them in a code block to silence it |
| Data Center: `{{text}}` monospace changed | Monospace text equals a variable name | Wrap it as `{% raw %}{{text}}{% endraw %}` |
| `control row is removed with the content of its other cells` | A table row holding `{% for %}`, `{% else %}` or `{% endfor %}` in its first cell has text in other cells | Leave the other cells of control rows empty |
| `Missing required template variables` | A declared required variable has no value and there is no terminal | Pass `--var` or `--vars-file` |
| `Template output limit exceeded` | A loop produced more than 1 MB in one field, or 16 MB in the run | Check the loop's data |
| `Template loop limit exceeded` | More than 100,000 `{% for %}` items in one run (nested loops multiply) | Check the loop's data |
| Dates differ between two plans | Each plan renders with its own time | Pass the first plan's time as `--now` |

## wiki template

Confluence page templates (`atlcli wiki template`) share the built-ins and
filters, but keep their own rules: Markdown with frontmatter declarations,
missing values render empty, and code fences render too. A line that holds
only a block tag (`{% if %}`, `{% endfor %}`) disappears with its line break.
Templates written for Handlebars need the [migration](#breaking-templates-use-jinja).

## Related topics

- [Copy Issues](/jira/copy-issues/): recurring projects from a template project
- [Jira templates](/jira/templates/): templates with variables
- [Pages](/confluence/pages/#copy-page): page and page tree copies
- [Script API](/reference/scripts/#atlclirender): `atlcli.render()`
- [Confluence templates](/confluence/templates/): page templates
