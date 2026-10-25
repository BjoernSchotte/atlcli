# Templating for Jira and Confluence operations

Status: implemented (2026-10-25) in one PR on branch spec/operation-templating;
see [Implementation notes](#implementation-notes) for where the build differs.

## Goal

One template engine for every atlcli operation that writes content. A
template is either a live object (a template issue, template project or
template page that people maintain in the Jira or Confluence UI) or a
local file. The same variables, built-ins and helpers work everywhere:

```bash
atlcli jira project copy-issues --from TPL-AUDIT --to AUD26 --vars-file audit-2026.yml
atlcli jira template apply release --project REL --var version=4.2
atlcli wiki page copy --id 12345 --tree --title "Audit {{year}}" --vars-file audit-2026.yml
```

```js
// atlcli script
const summary = atlcli.render("Audit {{year}}: {{source.summary}}", { source });
```

## What exists today

- `wiki template` (`packages/core/src/templates/`): Handlebars engine, typed
  variables in YAML frontmatter (string, number, date, boolean, select;
  required, default), `--var key=value` with interactive prompts, built-ins
  as Handlebars data variables (`@date`, `@user`, `@space`, `@uuid`, …),
  helpers `formatDate`, `lowercase`, `uppercase`, three storage levels,
  template packs.
- `jira template`: a JSON snapshot of an issue's fields. No variables;
  `apply` takes only `--summary`, `--description`, `--assignee`.
- `jira project copy-issues --replace`: plain find/replace on summary and
  description, plus a warning for leftover `{{…}}`.
- `wiki page copy`: copies one page; no tree, no rendering.
- `atlcli script`: everything is possible, but only in code.

## Decisions

| Topic | Decision |
|-------|----------|
| Driver | One shared engine for all writing operations; use cases follow from it |
| Template source | Both live objects and local files |
| Language | Full Handlebars everywhere (`if`, `each`, `with`, `unless`, helpers) |
| Declaration | Inferred from content; optional YAML manifest via `--vars-file`; nothing extra stored in Jira/Confluence |
| Unresolved `{{…}}` | Tolerant: stays literal, warning in plan; `--strict` turns warnings into failure |
| Code | `codeBlock`, `code` marks, `<code>`/`<pre>`, code/noformat macros, `{code}`/`{noformat}` are never rendered |
| Render time | Plan time; `@now` frozen in the plan; apply writes the planned values |
| Architecture | Shared render core plus format adapters (text, ADF, storage XHTML, wiki markup, Markdown) |
| `wiki template` | Moves onto the shared core with no behaviour change |
| Copy behaviour | Copies now always render. `{{@today}}` in a source issue gets replaced, while today it is copied literally |
| Delivery | One PR |

Rejected approaches:

- **Round-trip via Markdown** (ADF/storage → Markdown → Handlebars → back):
  lossy for panels, mentions, media and merged tables; copy-issues would lose
  fidelity it has today.
- **Engine only in the script runtime**: doesn't solve the ADF problem, just
  moves it, and forces every CLI operation to become a script.
- **Logic-free subset / two dialects**: discussed; full Handlebars chosen.

## Design

### 1. Render core (`packages/core/src/templates/render.ts`)

```ts
renderText(source: string, ctx: RenderContext, opts?: RenderOptions):
  { text: string; warnings: RenderWarning[] }
```

The existing `TemplateEngine` delegates to it: one Handlebars instance, one
helper set. The core stays browser-safe (spec 001), so `randomUUID` comes from
`globalThis.crypto`, not `node:crypto`.

**Context**

- User variables at the root: `{{year}}`, `{{customer}}`.
- Built-ins as data variables (existing): `@date`, `@datetime`, `@time`,
  `@year`, `@month`, `@day`, `@weekday`, `@user`, `@profile`, `@space`,
  `@uuid`, `@title`, `@parent`.
  New: `@today` (alias of `@date`), `@now`, `@quarter`, `@week` (ISO week),
  `@project`.
- Operation context:
  - Jira copy/clone: `source.key`, `source.summary`, `source.project`,
    `source.fields.<id>`.
  - Page copy: `source.id`, `source.title`; in trees, `parent.title` and
    `parent.id` of the rendered parent copy.

**Helpers**: existing `formatDate`, `lowercase`, `uppercase`; new
`dateAdd <date> <n> "d|w|m|y"`, `default <value> <fallback>`,
`replace <s> <from> <to>`, `eq`, `ne`, `and`, `or`, `not`. Nothing more;
complex logic belongs in `atlcli script`.

**Tolerant semantics**: implemented through `Handlebars.parse()` plus an AST
pass before compiling. Handlebars' default would render missing values as
empty and silently cut text.

- `{{path}}` that resolves neither in the context nor as a helper: the
  original source slice (from the node's `loc`) stays literal, with a warning
  `{ path, unit, line, column }`.
- `{{#if unknown}}` / `{{#unless unknown}}` treat the path as falsy, with a
  warning.
- `{{#unknownHelper}}…{{/unknownHelper}}` stays literal in full.
- Parse error (for example Jinja `{{ x | default('a') }}`): this text unit
  stays literal, with one warning. Other units still render.
- `\{{…}}` stays literal (native Handlebars).
- `opts.strict`: every warning becomes an error.

**Security** (live objects are edited by UI users, so this is a trust
boundary):

- No partials or helper registration from content.
- Handlebars' prototype-access protection stays on (the default since 4.6).
- `noEscape: true`; escaping is the adapter's job.
- Output limit per unit (default 1 MB) and per run (default 16 MB), so `{{#each}}` over a
  large array can't explode; exceeding it is an error.

**Determinism**: `@now` is captured once per run. The plan records it, and
apply uses the rendered values from the plan. `--now <iso>` pins it for a
reproducible re-plan, for example a resume after midnight.

### 2. Format adapters (`packages/core/src/templates/adapters/`)

Each adapter breaks its input into text units, calls `renderText()` and
reassembles. Structure is never rebuilt; only text changes. An input without
any `{{` comes back **identical** (same object for ADF, same bytes for
strings).

**Text** (summary, labels, custom fields, version/component names):

- One unit per value.
- After rendering, values are checked against the field type: a label with
  whitespace, a non-numeric number field, or an unparsable date is an error.
  Select options are matched by name.
- Unsupported field types (user, cascading select, …) are copied unrendered,
  with an info note.

**ADF** (Cloud descriptions, comments):

- **Inline units:** adjacent `text` nodes inside one inline container
  (paragraph, heading, table-cell paragraph, …) form one unit, with an offset
  map. The Jira editor splits text at marks, so `{{cus` + **`tomer}}`** still
  resolves. The output takes the marks of the node where the expression
  starts. Mustaches that sit entirely inside one node keep that node's marks
  exactly.
- Non-text inline nodes (`mention`, `emoji`, `inlineCard`, `hardBreak`,
  `date`, `status`, `mediaInline`) are unit boundaries. An expression
  crossing one stays literal, with a warning.
- `link` mark `href` is rendered as its own unit. If the result is not a
  valid URL, the original is kept, with a warning.
- **Control paragraphs:** a paragraph whose entire trimmed text is exactly one
  of `{{#if …}}`, `{{else}}`, `{{/if}}`, `{{#unless …}}`, `{{/unless}}`,
  `{{#each …}}`, `{{/each}}`, `{{#with …}}`, `{{/with}}` controls its
  sibling block nodes in the same parent (`doc`, `panel`, `tableCell`,
  `listItem`, `expand`, `layoutColumn`, …). Control paragraphs are removed
  from the output. Inside `#each`, `this`, item fields, `@index`, `@first`
  and `@last` are available to the repeated siblings.
- One level up:
  - A `listItem` whose only content is a control paragraph controls sibling
    list items.
  - A `tableRow` whose first cell's only content is a control paragraph
    controls sibling rows. That row is removed.
- Unbalanced or crossing control blocks: the controls stay literal and the
  content renders normally, with a warning.
- `{{#if x}}text{{/if}}` within one paragraph is handled by the inline unit.
- Never rendered: `codeBlock`, text with a `code` mark.
- Implementation: control blocks compile to a small tree (`if`/`each`/…
  nodes over sibling ranges). Conditions and `each` targets are evaluated by
  the core (`renderText` of the bare expression, with the result typed), so
  Handlebars semantics stay identical.

**Storage XHTML** (Confluence):

- Uses the existing storage parse/serialize path (the one behind the nested
  macro scanner from #340). No new parser.
- Units are text nodes per block element, as in ADF. `<p>`, `<li>` and
  `<tr>` (first `<td>`/`<th>`) work as control elements.
- `ac:parameter` values are rendered, so a Jira macro with
  `project = {{project}}` works.
- Skipped: `ac:plain-text-body`, `<code>`, `<pre>`, the `code`/`noformat`
  macros.
- Output text is XHTML-escaped.

**Wiki markup** (Jira DC descriptions, comments):

- Plain text unit with `{code}`/`{noformat}` regions skipped.
- The `{{monospace}}` collision is mostly defused by tolerant mode, since an
  unknown name stays literal. It goes wrong only when monospace text equals a
  variable name; `\{{` escapes that, and the guide documents it.

**Markdown** (`wiki template`): unchanged. The whole document renders,
including code fences, so existing templates keep working.

### 3. Variables, `--vars-file`, validation

Shared flags, parsed by one helper in `apps/cli`:

- `--var key=value` (repeatable; `a.b=value` for nested values)
- `--vars-file <path.yml>`
- `--now <iso>`
- `--strict`

**File format** (local, trusted):

```yaml
variables:            # optional declarations, same schema as wiki-template frontmatter
  year:    { type: number, required: true, description: "Audit year" }
  quarter: { type: select, options: [Q1, Q2, Q3, Q4], default: Q1 }
  kickoff: { type: date }
values:
  year: 2026
  systems: [IAM, Backup, Logging]   # arrays/objects for {{#each}}
```

A file without top-level `variables:` / `values:` counts entirely as values.

**Precedence** (high → low):

1. `--var`
2. `values` from the file
3. declared `default`
4. in a TTY, a prompt for declared required variables

`jira template` declarations count at the same level as the file's
`variables`; on a conflict the file wins.

**Validation** (reusing `validation.ts`):

- `--var` strings are converted to the declared type (number, boolean,
  ISO date, select checked against `options`). Undeclared ones stay strings.
- A declared required variable without a value is a hard error, listing all
  of them, before anything is planned.
- A merely used (inferred) variable without a value is tolerant: literal,
  with a warning.
- A variable that is declared or given but never used gets an info note, which
  catches `--var` typos.
- No prompts with `--json`, without a TTY, or with `--yes`; it fails cleanly
  instead (CI-proof, like copy-issues).

**`atlcli template vars <source>`** (new, read-only):

- Sources: `--jira-template <name>`, `--issue <key>` / `--jql <q>`,
  `--page <id> [--tree]`, or a local file.
- Lists every variable used, with its declaration and where it is used
  (object, field, line).
- `--json` emits a `values:` skeleton for a vars file.

### 4. Operations

All of them show render warnings in a block in the plan or output and as
`warnings[]` in JSON.

**`jira project copy-issues` / `jira issue clone`:**

- copy-issues renders inside its built-in script through `atlcli.render()`,
  the same verb user scripts get.
- Rendered fields: summary, description, comments (`--comments`), labels,
  text and number custom fields, and version/component names created in the
  target.
- Rendering happens at plan time, so the plan diff shows the final text.
- `--replace` keeps working (released in 2026.10.10). It's applied *before*
  rendering and documented as legacy. The leftover-`{{…}}` warning is removed;
  render warnings replace it.
- The plan header shows the frozen `@now`, so a resume can pass `--now`.
- `clone` gets the same flags and renders directly (no plan).

**`jira template`:**

- The template JSON gets an optional `variables` block (wiki-template schema).
- `apply`:
  - accepts `--var` / `--vars-file` / `--now` / `--strict`
  - prompts for missing declared required variables in a TTY
  - renders summary, description, labels and custom fields
- `save --issue` keeps placeholders as they are and writes the inferred
  variables into `variables` as required strings.
- `get` shows the variables.
- Older templates without `variables` keep working: inference only.

**`wiki page copy`:**

- Single page (direct, as today): `--title` and the body are templates.
- New `--tree`: copies the page and its descendants, rendering titles and
  bodies, with `parent.*` available. Runs through plan/apply as the built-in
  script `copy-pages.script`, like copy-issues. Confluence verbs are added to
  the script runtime where they are missing (create page with a parent, copy
  attachment, content property).
- Page attachments are copied along, so `ri:attachment` references stay valid.
- Preflight: duplicate titles in the target space after rendering are a plan
  error.
- Resume via the content property `atlcli.copiedFrom`, by re-planning, as in
  copy-issues.

**Script runtime:**

- `atlcli.render(input, { vars?, format?, source? })` is a host function; the
  engine never loads into QuickJS.
- `format` is detected automatically: a string means text, and an object with
  `type: "doc"` means ADF. `"storage"` and `"wikimarkup"` must be given
  explicitly.
- Returns the rendered value. Warnings go into the plan, or the run report for
  runs without a plan.
- The script's `--var` / `--vars-file` values arrive through the existing
  param mechanism and are merged automatically. `vars` in the call wins.
- Types in `script-types.ts`; it is not a write, so it is not recorded in the
  plan.

### 5. Error handling

**Hard errors**, before anything is planned or written:

- a declared required variable is missing
- an invalid type or select value
- a rendered value fails its field type
- a title collision in `--tree`
- an output limit is exceeded

**Warnings**, kept in the plan and in `warnings[]`:

- unresolved expressions
- parse errors per unit
- unbalanced control blocks
- expressions crossing inline nodes
- invalid link URLs
- unused variables

`--strict` makes any warning fail the run. It's meant for CI, where a silent
literal leftover is a bug.

Apply never renders again: it writes the planned values.

## Tests

- **`renderText`:**
  - each tolerant case (unknown path, unknown helper, `if` on unknown, parse
    error, `\{{`)
  - every built-in with a fixed `now`, `dateAdd` across month and year ends
  - helpers, output limit
  - prototype access blocked (`{{constructor.constructor}}`,
    `{{__proto__}}`)
  - `strict`
- **ADF adapter fixture matrix:**
  - placeholder split across marks
  - mention/emoji/hardBreak boundaries
  - code mark and codeBlock untouched
  - control paragraphs at doc, panel, tableCell, listItem and tableRow level
  - nested `each` in `if`, `@index`/`@first`/`@last`
  - unbalanced and crossing blocks
  - link href valid and invalid
  - an input without `{{` returns the identical object (regression guard for
    copy fidelity)
- **Storage adapter:** the same matrix plus `ac:parameter`, code macros,
  XHTML escaping, and the nested-macro fixtures from #340.
- **Wiki markup:** `{code}`/`{noformat}` skipped, monospace with an unknown
  name stays literal.
- **`wiki template`:** the existing tests pass unchanged (migration guard).
- **Vars:**
  - precedence
  - type conversion
  - required → error listing all of them
  - prompt in a TTY; failure without a TTY, with `--json` and with `--yes`
  - short-form file
  - unused-variable info
- **Operations:**
  - plan snapshots for copy-issues, `page copy --tree`
  - clone and template apply output
  - `--replace` before rendering
  - `--now` reproducibility (a re-plan with the same `--now` is identical)
  - title collision
  - `template vars --json` skeleton
- **Script:** `atlcli.render` text/ADF/storage, vars merge, warnings in the
  plan.
- **Live E2E** (clean up afterwards):
  - kiteweave, temporary projects: copy-issues with `--vars-file`, including
    `#each` table rows, control paragraphs, a split placeholder and a link
    href
  - DOCSY: `page copy --tree` with rendered titles and bodies, and an
    `ac:parameter` in a Jira macro
  - ATLCLI: `jira template save` + `apply --var`

## Docs

- New guide `src/content/docs/templating.md` (sidebar):
  - syntax, built-ins, helpers
  - control paragraphs with screenshots of a template issue and page
  - tolerant vs `--strict`, vars file, precedence
  - examples per operation (minimal and realistic)
  - troubleshooting: "why does `{{x}}` stay put", DC monospace, Jinja
    snippets, `--now` for resume
- Updates:
  - `jira/copy-issues.md` (`--replace` as legacy)
  - `jira/templates.md`
  - `jira/issues.md` (clone)
  - `confluence/pages.md` (copy, `--tree`)
  - `confluence/templates.md` (shared built-ins, new helpers)
  - `reference/scripts.md` (`atlcli.render`)
  - `reference/cli-commands.md`
- Agent skill `skills/atlcli/references/`: `jira-issues.md`, `confluence-pages.md`,
  `confluence-templates.md`, `scripts.md`, plus
  a templating section.
- API report for `@atlcli/core` (`bun scripts/api-report.ts --update`).

## Out of scope

- Project configuration templates (workflows, schemes, screens): Jira's
  "shared configuration" covers that.
- Templating in `tasks-to-issues`, `jira issue create`, comments add and
  digests. They can attach later through the same flags and core.
- Storing variable declarations on Jira/Confluence objects.
- A Markdown change in `wiki template` (code fences stay rendered).
- Scheduling or recurrence itself (CI/cron, as documented for copy-issues).

## Delivery order (commits within the one PR)

1. Render core + text adapter; `wiki template` on the core; vars parser
   (`--var`, `--vars-file`, `--now`, `--strict`).
2. ADF adapter including control paragraphs.
3. Storage XHTML and wiki markup adapters.
4. `atlcli.render()` + copy-issues/clone.
5. `jira template` variables.
6. `wiki page copy` templating + `--tree` (plan/apply, Confluence verbs).
7. `atlcli template vars`.
8. Docs, skill, API report, live E2E.

## Resolved questions (2026-10-25)

1. `--replace` stays indefinitely as legacy: no deprecation warning, applied
   before rendering, docs point to `--var`.
2. The variable listing lives in a new top-level namespace:
   `atlcli template vars`, covering every source.
3. Output limit: 1 MB per unit and 16 MB per run as fixed defaults; inside
   scripts the runtime's `--max-memory` caps it on top.

## Implementation notes

Built from `specs/operation-templating/IMPLEMENTATION.md` (16 tasks). Where the
build differs from the design above:

- **Storage adapter:** there is no storage serializer to reuse (`parseXml` in
  `export-blocks.ts` has neither offsets nor output, and core cannot depend on
  `@atlcli/confluence`). `adapters/storage.ts` is a small offset tokenizer that
  prints from the original string: untouched tokens keep their bytes; a text
  token that changes is re-serialized (entities decoded, `& < >` and nbsp
  re-encoded).
- **Numbers concatenate:** with `noEscape`, Handlebars joins mustache values
  with `+`, so `{{year}}{{year}}` added up to `4052`. `render.ts` rewrites
  every mustache to `{{__atlcliStr …}}` before compiling (regression test in
  `render.test.ts`).
- **`wiki template`** shares the helper factory and built-ins
  (`createTemplateHandlebars`, `getBuiltinVariables`) but keeps its own render
  loop: missing values still render empty there, by design.
- **`default`** may take an unresolved first argument without a warning; that
  is what it is for.
- **Control blocks** inside `#each`/`#with` resolve plain paths against the
  item; the run's variables are `@root.x`. `../x` is not supported in control
  paragraphs.
- **`@uuid`** is derived from the frozen clock, so a re-plan with the same
  `--now` repeats it.
- **Script runtime:** `ScriptPort.render` and the new Confluence operations
  (`confluenceGetPageStorage`, `confluenceChildren`, `confluenceCopyAttachment`)
  are optional, so hosts without them fail with a clear message.
  `atlcli.render` returns a Promise in the guest. The new read is
  `confluence.getPage(id, { storage: true })`, not a separate verb. A plan
  records `templating` only when the run called `atlcli.render`, and
  `renderWarnings` only when there are any.
- **Page tree resume** finds earlier copies by a CQL title search plus the
  `atlcli.copiedFrom` content property (no property search). A copy into
  another space without `--parent` goes to that space's top level.
- **Single page copy** now creates the copy from rendered storage instead of
  `client.copyPage`, and copies the attachments too (`--no-attachments`).
- **Attachments between pages** are copied in memory (download, then upload).
- **`page.ts`/`docs.ts`** keep their own `--var` parsing (strings only); only
  `wiki template` moved to the shared `parseVarAssignments`.
- **Clone** has no `--fields`; its render warnings are in
  `cloned.templateWarnings`.

### E2E (2026-10-25)

- **kiteweave**, temporary projects TPLSRC/TPLDST (both deleted to trash):
  - copy-issues with `--vars-file` and `--comments`: 12 of 12 checks passed.
    Covered: split placeholder across bold, mention kept, `{{@today}}`, link
    href `/browse/{{source.key}}`, code block and Jinja untouched, `#each`
    table rows with `dateAdd @root.kickoff`, `#if` paragraphs, rendered
    comment, `{{nope}}` kept with a warning.
  - Re-plan with the plan's `--now`: "No changes planned".
  - `clone --strict` failed before creating anything.
  - `clone --vars-file` rendered the summary.
- **mayflower ATLCLI:**
  - `jira template save` recorded `version`.
  - `apply` without `--var` failed naming it; with `--var version=4.2` it
    created "E2E template release 4.2" with label `rel-4.2`.
  - Issues ATLCLI-193/194 and the template are deleted.
- **mayflower DOCSY:**
  - `wiki page copy --tree`: 11 of 11 checks passed. Covered: titles, parent
    link, `{{parent.title}}`, Jira macro `jqlQuery` parameter, nested info
    macro, code macro untouched, `#each` list items, image attachment copied,
    `atlcli.copiedFrom` property.
  - Re-plan: nothing to do, attachment unchanged.
  - Single page copy with attachment.
  - All five pages are deleted.
