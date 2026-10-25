---
title: "Templating"
description: "Variables, built-ins and control paragraphs for copies and templates in Jira and Confluence"
---

# Templating

Copies and templates in atlcli render `{{…}}` expressions: `Audit {{year}}`
becomes `Audit 2026`. The same rules apply everywhere, whether the template is
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

The syntax is [Handlebars](https://handlebarsjs.com/guide/). Code is never
rendered: code blocks, inline code, code and noformat macros, and `{code}`
regions keep their `{{…}}` as written.

## Prerequisites

- An atlcli version with templating (`atlcli template vars --help` works).
- For live templates: read access to the template project or space.

## Steps

1. Write variables into the template: `Release {{version}}` in a summary,
   `{{#each systems}}` rows in a table.
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
| `{{version}}` | A value from `--var version=…` or the vars file |
| `{{team.lead}}` | A nested value (`--var team.lead=Ann`, or YAML) |
| `{{source.key}}`, `{{source.summary}}`, `{{source.fields.duedate}}` | The original issue (copy-issues, clone) |
| `{{source.title}}`, `{{source.id}}` | The original page (page copy) |
| `{{parent.title}}`, `{{parent.id}}` | The rendered parent copy (page copy `--tree`) |

### Built-ins

Built-ins start with `@`. Dates use the clock frozen for the run, read in
**UTC**, so a plan made again on another machine gives the same dates; see
[`--now`](#repeating-a-run).

| Built-in | Example | Notes |
|----------|---------|-------|
| `@today` | `2026-10-25` | Always ISO; feed it to `dateAdd` |
| `@date` | `2026-10-25` | Wiki templates may set another format |
| `@now`, `@datetime` | `2026-10-25T08:30:00.000Z` | |
| `@year`, `@month`, `@day` | `2026`, `10`, `25` | |
| `@quarter` | `4` | Write `Q{{@quarter}}` for `Q4` |
| `@week` | `43` | ISO week |
| `@weekday`, `@time` | `Sunday`, `09:30` | |
| `@user`, `@profile`, `@space`, `@project` | | From the profile and target, where known |
| `@uuid` | `2f1c…` | Different per field and issue or page; the same again for the same `--now`, so a re-plan repeats it |

### Helpers

| Helper | Example | Result |
|--------|---------|--------|
| `dateAdd date n unit` | `{{dateAdd @today 14 "d"}}` | 14 days later; units `d`, `w`, `m`, `y`; months clamp to the month end |
| `formatDate date format` | `{{formatDate @today "DD.MM.YYYY"}}` | `25.10.2026` |
| `default value fallback` | `{{default owner "Team"}}` | `Team` when `owner` is empty or missing |
| `replace text from to` | `{{replace source.summary "2025" "2026"}}` | |
| `lowercase`, `uppercase` | `{{uppercase team}}` | |
| `eq`, `ne`, `and`, `or`, `not` | `{{#if (eq region "eu")}}…{{/if}}` | For conditions |

Blocks work inside one text: `{{#if internal}}(internal){{/if}}`,
`{{#each systems}}{{this}} {{/each}}`. Handlebars' own `lookup` and `log`,
partials and custom helpers are not available.

### Control paragraphs

In rich text (Jira descriptions and comments, Confluence pages) a block can
span whole paragraphs, list items or table rows. A paragraph that holds
nothing but a block tag controls the paragraphs next to it and is removed from
the result:

```
{{#if internal}}
This paragraph only appears with --var internal=true.
{{else}}
This one otherwise.
{{/if}}
```

The same works one level up:

- **List items**: a list item holding only `{{#each systems}}`, an item with
  `{{this}}`, and an item with `{{/each}}` give one item per system.
- **Table rows**: a row whose first cell holds only `{{#each systems}}`, a row
  with `{{this}}` / `{{@root.owners.IAM}}`, and a row with `{{/each}}` give one
  row per system. The control rows disappear.

Supported: `#if`, `#unless`, `#each`, `#with`, with `{{else}}`. Inside `#each`
and `#with`, `this` is the item, `@index`, `@first`, `@last` and `@key` are
set, and variables of the run are reached through `@root`
(`{{@root.year}}`).

Control tags must pair up within the same parent (the same panel, cell or
list). If they don't, they stay as written and the plan warns.

## Unresolved expressions

Rendering is tolerant: an expression that cannot be filled stays exactly as
written, and the run lists it as a template warning with its location
(`SUP-1 summary 1:8  Unresolved {{versoin}}`). The same goes for unknown
helpers, partials, text that is not Handlebars at all (Jinja's
`{{ x | default('a') }}`), an expression that runs across a mention, link or
image, and a link that renders to an invalid URL.

Use `--strict` to fail the run instead, for example in CI, where a silent
leftover is a bug:

```bash
atlcli jira project copy-issues --from TPLREL --to REL --var version=4.2 --strict
```

To keep a literal `{{…}}`, write `\{{…}}`. `{{../x}}` and a bare `{{this}}`
outside a loop also stay as written.

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
atlcli jira template save release --issue TPL-1        # records {{version}} as a variable
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

# Pages: the audit handbook tree, titled "Audit {{year}}"
atlcli wiki page copy --id 12345 --tree --title "Audit {{year}}" --vars-file audit-2026.yml --plan-out pages.json

atlcli script apply jira.json
atlcli script apply pages.json
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `{{x}}` stays in the result | No value, a typo, or the expression crosses a mention, link or image | Read the template warnings; run `atlcli template vars`; keep an expression within plain text |
| `{{year}}` is empty inside `#each` | Inside a loop, plain names refer to the item | Write `{{@root.year}}` |
| Jinja or Helm snippets in a description | They are not Handlebars | They stay as written, with a warning; put them in a code block to silence it |
| Data Center: `{{text}}` monospace changed | Monospace text equals a variable name | Escape it as `\{{text}}` |
| `Missing required template variables` | A declared required variable has no value and there is no terminal | Pass `--var` or `--vars-file` |
| `Template output limit exceeded` | A loop produced more than 1 MB in one field, or 16 MB in the run | Check the loop's data |
| `Template loop limit exceeded` | More than 100,000 `{{#each}}` items in one run (nested loops multiply) | Check the loop's data |
| Dates differ between two plans | Each plan renders with its own time | Pass the first plan's time as `--now` |

## wiki template

Confluence page templates (`atlcli wiki template`) share the built-ins and
helpers, but keep their own rules: Markdown with frontmatter declarations,
missing values render empty, and code fences render too. Nothing changed for
existing templates.

## Related topics

- [Copy Issues](/jira/copy-issues/): recurring projects from a template project
- [Jira templates](/jira/templates/): templates with variables
- [Pages](/confluence/pages/#copy-page): page and page tree copies
- [Script API](/reference/scripts/#atlclirender): `atlcli.render()`
- [Confluence templates](/confluence/templates/): page templates
