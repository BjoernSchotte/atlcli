# Datasource smart links — support the modern Jira table macro

Status: Plan, 2026-07-21. Standalone follow-up, opened from a live E2E finding
during spec `010-extension-integration` verification. Spans `packages/confluence`
and `packages/export-macros`; benefits the CLI and the extension identically.

## Reference

- Trigger: live E2E against DOCSY page `1126236245` ("M1 Abnahme Abschnitt 7.7"),
  2026-07-21 — see [Evidence](#evidence).
- Existing renderer this plan reuses (does **not** replace):
  `packages/export-macros/src/jira.ts:138-215` (`jiraMacroRenderer`, JQL branch at
  `:186-203`), `JiraIssuePort.searchJql` (`packages/export-macros/src/types.ts:162-168`).
- Hook point: `packages/confluence/src/export-blocks.ts` — the `<a>` handler in
  `walkInline` (`:1898`), and the `unknown`-block construction (`:1526-1562`).
- Session ports that make this work token-free in the panel:
  `apps/extension/utils/macros/session-ports.ts` (spec 010 wave 1).
- Shared host wiring: `packages/export-wiring` (spec 010 wave 2).

## Motivation

The modern Confluence Cloud editor no longer emits
`<ac:structured-macro ac:name="jira">` when a user inserts a Jira issue table. It
emits a **datasource smart link**. Our entire Jira macro path — including the
session ports built in spec 010 specifically so the extension can render Jira
tables through the user's own browser session with no token to configure — keys
on the legacy macro name and therefore **never fires** on content authored today.

This is not a future concern. Atlassian announced that the Jira Legacy macro
becomes the **Jira Data Center macro** and stops supporting Jira *Cloud* issues,
with existing Cloud instances **auto-converted** to the datasource form. The
cutover was **2026-05-22** — two months before this plan was written. On a Cloud
site, the legacy path is effectively already dead; the DOCSY corpus contains zero
legacy `jira` macros and at least one datasource link.

### Evidence

Storage format of the live page (no `ac:structured-macro` anywhere on it):

```html
<a href="https://<site>.atlassian.net/issues/?jql=project%20in%20(GROW)%20and%20status%20in%20(Review)%20ORDER%20BY%20created%20DESC"
   data-card-appearance="block"
   data-datasource="{&quot;id&quot;:&quot;d8b75300-dfda-4519-b6cd-e49abbd50401&quot;,
     &quot;parameters&quot;:{&quot;cloudId&quot;:&quot;ca7c5cc9-…&quot;,
                        &quot;jql&quot;:&quot;project in (GROW) and status in (Review) ORDER BY created DESC&quot;},
     &quot;views&quot;:[{&quot;type&quot;:&quot;table&quot;,&quot;properties&quot;:{&quot;columns&quot;:[
        {&quot;key&quot;:&quot;issuetype&quot;},{&quot;key&quot;:&quot;key&quot;},{&quot;key&quot;:&quot;summary&quot;},
        {&quot;key&quot;:&quot;assignee&quot;},{&quot;key&quot;:&quot;priority&quot;},{&quot;key&quot;:&quot;status&quot;},
        {&quot;key&quot;:&quot;updated&quot;}]}}]}">https://<site>.atlassian.net/issues/?jql=…</a>
```

Measured behaviour today (`wiki export … --format pdf --report json`):

| | Result |
|---|---|
| Single page 7.7 | `exit 0`, `complete: true`, **`notes: []`** |
| Whole M1 tree (62 PDF pages) | `exit 0`, `complete: true`, **`notes: []`** |
| PDF body | the raw percent-encoded JQL URL as running text |
| `grep -rn "data-datasource" packages/*/src apps/*/src apps/extension/utils` | **0 hits** |

So the user loses a table, gets a URL blob in its place, and **the report says
nothing is wrong**. That directly violates this program's standing rule —
*never silently drop* — which every other degradation path here honours with a
typed note.

## Research findings

Atlassian documents almost none of this. The high-confidence findings below come
from Atlassian's own shipped npm packages (`@atlaskit/adf-schema@56.1.10`,
`@atlaskit/link-datasource@6.1.11`, `@atlaskit/linking-common@11.0.1`,
`@atlaskit/linking-types@15.0.0`, `@atlaskit/link-client-extension@7.1.0`) —
first-party **implementation**, not contract. Confidence is marked per claim.

### 1. It is a multi-provider mechanism (high confidence)

`id` identifies a **datasource provider** and is a **global constant, not
per-site** (compiled literals in the bundle every Cloud site loads; the ARI form
is `ari:cloud:linking-platform:datasource/<uuid>`, platform-scoped with no tenant
segment). Three providers are confirmed:

| Constant | UUID | `parameters` shape |
|---|---|---|
| `JIRA_LIST_OF_LINKS_DATASOURCE_ID` | `d8b75300-dfda-4519-b6cd-e49abbd50401` | `{ cloudId } & XOR<{ jql }, { filter }>` |
| `ASSETS_LIST_OF_LINKS_DATASOURCE_ID` | `361d618a-3c04-40ad-9b27-3c8ea6927020` | `{ workspaceId, schemaId, aql, version? }` |
| `CONFLUENCE_SEARCH_DATASOURCE_ID` | `768fc736-3af4-4a8f-b27e-203602bff8ca` | `{ cloudId, searchString?, spaceKeys?, labels?, entityTypes?, … }` |

The mechanism is generic by construction, which is why this plan builds a
registry rather than a Jira special case:

- The schema types `parameters` and `views[].properties` as bare untyped objects.
  Nothing about JQL appears in it.
- **Provider selection is server-driven**: on paste, the editor calls the
  smart-link resolver and reads a `datasources[]` array off the response, taking
  `datasources[0]`. The client never maps URLs to providers.
- **Rendering is generic, only editing is hardcoded**: `DatasourceTableView`
  renders any `datasourceId`; a separate `isDatasourceConfigEditable` allowlist
  gates only the config modal. An unknown provider still renders as a table.

**Consequence:** Atlassian can add providers with no schema change and no notice.
An unknown `id` must therefore be a first-class, gracefully-degrading case.

Third-party/Forge registration: **no public path found** (the Forge module
reference has no datasource module; `graph:smartLinks` covers single-entity
previews only). Not confirmed either way — possibly an unpublished partner
programme. Treat as unknown, not as impossible.

### 2. Schema (high confidence — from `adf-schema` JSON schema)

```jsonc
{
  "id": "<uuid>",                 // required, string
  "parameters": { /* untyped */ },// required, object
  "views": [                      // required, array, minItems 1
    { "type": "table",            // required — see below
      "properties": { "columns": [ { "key": "…", "width": 123, "isWrapped": true } ] } }
  ]
}
```

`additionalProperties: false` — **no other keys are legal**.

- `views[].type`: **`"table"` is the only member** today
  (`DatasourceAdfView = DatasourceAdfTableView`, a one-member union). There is no
  `inline`/`list` view type — switching a card to inline in the editor converts
  the node to a plain `inlineCard` and **drops the datasource entirely**.
- `columns[].key`: datasource schema property keys supplied at runtime. For the
  Jira provider they behave as JQL field names — Atlassian's own sort code appends
  `ORDER BY <columnKey> <dir>` into `parameters.jql`. *Medium* confidence that a
  key is always a valid Jira field id: the key set has drifted (older Atlassian
  fixtures use `issue`/`type` where the 2026 artifact has `key`/`issuetype`).
- `width`/`isWrapped` are presentation-only.
- `data-card-appearance`: the type union is `'block' | 'embed' | 'inline'`, and a
  datasource can only live on a block card, so `"block"` is the only value that
  co-occurs with `data-datasource`. (`"card"` never appears in the union —
  unverified whether it is ever emitted.)

### 3. Resolution: no documented API (high confidence)

- **Atlassian's own export runs the live React component in a browser.**
  `useIsInPDFRender()` reads `shouldControlDataExport` off the smart-card context;
  when set, page size goes 20 → 100, the height cap is removed, and the component
  auto-pages until exhausted. There is **no server-side storage→table transform to
  borrow**.
- **Internal object-resolver** (`/gateway/api/object-resolver`,
  `POST /datasource/{id}/fetch/data`) is undocumented, unversioned and
  session-cookie authenticated. **We do not build on it.** An open, unanswered
  2024 developer-community question asks for exactly this capability.
- **Third-party exporters have the same gap**: CONFCLOUD-77735 (Scroll PDF
  Exporter, 59 votes, unresolved) records that the v2 export endpoint returns only
  static content. Users report the new macro exporting as a truncated image or a
  bare hyperlink, with "use the legacy macro" as the only workaround — a
  workaround that expired on 2026-05-22.

**Therefore:** read `parameters` and query the **documented product API**. For
Jira that is the issue-search API on the site identified by `parameters.cloudId`.
We already have that port.

### 4. ADF form (high confidence)

The node is `blockCard`; `attrs.datasource` is byte-for-byte the JSON in
`data-datasource`, and `attrs.url` is the `href`. `inlineCard`/`embedCard` cannot
carry a datasource. Confluence REST v2 can return `body-format=atlas_doc_format`,
which would avoid HTML-entity decoding and the lossy storage↔ADF round trip
Atlassian itself warns about. **Not adopted in this plan** (our whole pipeline is
storage-format based) but see [Open questions](#open-questions).

## Architecture

**One translator, no second renderer.** `jiraMacroRenderer`'s JQL branch already
does precisely what a datasource table needs:

```ts
const columns = parseColumns(macroParamText(m.params, "columns"));
const maximumIssues = parseMaxIssues(macroParamText(m.params, "maximumIssues"));
const issues = await ctx.jira.searchJql(jql, { columns, maximumIssues });
return { kind: "blocks", blocks: [issueTable(columns, issues)], notes: [/* rendered-via */] };
```

So the work is to turn a datasource element into the `MacroInstance` shape that
renderer already consumes, and let the existing chain do the rest — inheriting
`sourcePage` binding, the fallback chain, report notes, the session ports (spec
010 wave 1) and the shared wiring (wave 2) for free.

### 1. Provider registry — `packages/confluence/src/datasource.ts` (new)

Pure, isomorphic, no IO. Responsibilities:

1. Detect `<a data-datasource>` (block level).
2. HTML-entity-decode and `JSON.parse` the attribute; validate against the closed
   schema (`id`, `parameters`, `views` only; `views` non-empty).
3. Look the `id` up in a **provider table**. A provider declares:

```ts
interface DatasourceProvider {
  id: string;                       // the global UUID
  label: string;                    // for report notes, e.g. "Jira work items"
  status: "supported" | "known-unsupported";
  macroName?: string;               // target macro for supported providers
  toParams?(ds: Datasource): MacroParameter[] | { degrade: string };
}
```

Registered from day one:

| Provider | Status | Behaviour |
|---|---|---|
| Jira work items | `supported` | → `macroName: "jira"`, params below |
| JSM Assets | `known-unsupported` | link + note naming the provider |
| Confluence search | `known-unsupported` | link + note naming the provider |
| *anything else* | unknown | link + note carrying the raw `id` |

Distinguishing `known-unsupported` from unknown matters: the first is a precise
"we recognise this and have not implemented it" message the user can act on; the
second must also print the id so a **newly introduced** Atlassian provider is
identifiable from a report alone, without a code change.

### 2. Parameter mapping (Jira)

| Datasource | → `MacroParameter` | Note |
|---|---|---|
| `parameters.jql` | `jqlQuery` | Preserve verbatim — the user's sort lives in it as a trailing `ORDER BY`, so rewriting it would silently reorder their table |
| `views[0].properties.columns[].key` | `columns` (comma-joined) | Honour the user's chosen columns rather than a fixed set |
| — | `maximumIssues` | **Not stored by Atlassian.** Default 100 (matching Atlassian's own export page size) with a hard cap; see Open questions |
| `parameters.filter` | *(none)* | Degrade + note — resolving a saved filter needs a second API call |
| `parameters.cloudId` | *(guard only)* | See below |

### 3. Emission point — `export-blocks.ts`

`<a data-datasource>` must be intercepted **before** the inline walk. The current
`<a>` handler (`:1898`) turns it into a `{ type: "link" }`, which is exactly the
raw-URL output we see today. Because `data-card-appearance="block"` is
block-level, the interception belongs in the block walk and emits the same
`{ type: "unknown", macroName, params, macroId?, sourcePage? }` shape the macro
extractor already produces at `:1526-1562` — including the `sourcePage` binding,
so a datasource on a **child page** of a tree export resolves against that page
(spec 010 Architecture point 6).

### 4. Degradation — four cases, all noted, none silent

| Case | Output | Note code |
|---|---|---|
| Unknown provider id | link (existing `href`) | `datasource-provider-unknown`, includes the id |
| Known but unimplemented (Assets, Confluence search) | link | `datasource-provider-unsupported`, names the provider |
| Jira `filter` variant (no `jql`) | link | `datasource-filter-unsupported` |
| `cloudId` ≠ the export's site | link | `datasource-cross-site` |

The `cloudId` guard is not pedantry: Atlassian's config modal offers a site
selector (`/gateway/api/v2/accessible-products`), so a Confluence page can
legitimately embed a table from **another** Jira site. Querying our own site with
that JQL would return *plausible but wrong* rows — the worst possible failure. If
we cannot prove the `cloudId` matches the site we are authenticated against, we
degrade instead of guessing.

Malformed JSON, a missing `views` entry, or a non-`table` view type degrade the
same way rather than throwing: one broken element must never fail a 200-page
export.

### 5. What is deliberately **not** in scope

- No use of `/gateway/api/object-resolver` (undocumented, session-bound).
- No Assets or Confluence-search rendering — registered as known, not built.
- No saved-`filter` resolution in v1 (see Open questions).
- No ADF intake path (`atlas_doc_format`) — recorded as a seam, not built.
- No change to the legacy `ac:structured-macro ac:name="jira"` path: Data Center
  customers keep it, and it must keep working (regression test below).

## Tasks

- [ ] `packages/confluence/src/datasource.ts` (new): pure parser + provider
      registry + `toParams` mapping. Exported from `index.browser.ts` and added to
      `BROWSER_ENTRYPOINTS` in `scripts/check-browser-build.ts` (and its verbatim
      pin in `check-browser-build.test.ts`) if a new entrypoint is warranted.
- [ ] `packages/confluence/src/export-blocks.ts`: intercept
      `<a data-datasource>` at block level before the inline walk; emit the
      `unknown` block with `macroName`/`params`/`macroId`/`sourcePage`; degrade
      with a typed note per the table above. Add the new note codes to the
      existing note-code union (`:274-411`).
- [ ] `packages/export-macros/src/jira.ts`: accept the datasource-sourced instance
      unchanged if possible; only extend if the column-key vocabulary differs from
      the legacy `columns` parameter (verify against a real response before
      assuming).
- [ ] Report surfacing: confirm the new note codes group correctly in the CLI
      report and in the panel's report view (`PdfReportView`, DOCX report view) —
      "1 datasource table rendered live" must be visible without expanding.
- [ ] Docs: `src/content/docs/confluence/macro-compatibility.md` gains a
      datasource section (the three providers, what renders, what degrades and
      why), and the Jira-macro entry notes the 2026-05-22 Cloud cutover.

## Tests

Hard rule inherited from the program: **never mock HTTP.** Pure-function tests,
port fakes for our own ports, real `Response` objects where a transport is needed.

- [ ] `packages/confluence/src/datasource.test.ts` (new): entity-decoding;
      schema validation incl. `additionalProperties`; the exact 2026 artifact from
      page 7.7 as a fixture; unknown id → degrade + id in the note; Assets and
      Confluence-search ids → named degrade; `filter` variant → degrade; malformed
      JSON → degrade, never throw; non-`table` view → degrade; **`ORDER BY` inside
      the JQL survives verbatim** (regression against silent re-sorting).
- [ ] `packages/confluence/src/export-blocks.test.ts` (extend): a
      `<a data-datasource>` produces an `unknown` block, **not** a `link` block;
      `sourcePage` is bound on a multi-page export; a datasource inside a
      paragraph does not corrupt surrounding inline content.
- [ ] `packages/export-macros/src/jira.test.ts` (extend): a datasource-sourced
      `MacroInstance` renders through the **same** code path as a legacy one and
      produces an equivalent table (port fake, no HTTP); the user's column order is
      honoured.
- [ ] Regression: the legacy `ac:structured-macro ac:name="jira"` path is
      unchanged (Data Center customers).
- [ ] E2E against DOCSY page `1126236245` (the page that exposed this):
      **before** — raw URL in the PDF, `notes: []`; **after** — an issue table and
      a `macro-rendered-via` note. Run both engines (PDF and DOCX/ts) so the two
      hosts' output agrees. Clean up nothing — 7.7 is pre-existing content, do not
      modify or delete it.
- [ ] Extension parity: the same page exported from the panel renders the table
      through the **session** ports with no token configured (manual step in the
      spec-010 release protocol).

## Definition of Done

- A Jira datasource table authored in the current Confluence Cloud editor renders
  as a real issue table in **both** PDF and DOCX, from **both** the CLI and the
  extension, with a `macro-rendered-via` note.
- No datasource element is ever dropped silently: every degradation path emits a
  typed, user-visible note naming the provider (and the raw id when unknown).
- A datasource whose `cloudId` names a different site degrades rather than being
  answered with rows from the wrong site.
- The user's JQL — including its trailing `ORDER BY` — is passed through verbatim.
- The legacy macro path is untouched and still green.
- Adding a second provider later is a registry entry, not a new code path.
- `bun run test`, `bun run typecheck`, `bun run check:browser` green.

## Risks

- **Column-key vocabulary drift** (medium confidence finding): datasource column
  keys are schema property keys, not guaranteed Jira field ids, and Atlassian's own
  key set has changed over time. If a key is not a valid field, the search API may
  reject or ignore it. Mitigation: validate against the real API in the E2E step
  before trusting the mapping, and degrade a bad column rather than failing the
  table.
- **Undocumented format.** Everything here is read off Atlassian's shipped
  implementation. The schema is closed today, but the *contents* of `parameters`
  are provider-defined and can change without notice. Mitigation: the parser
  validates only the outer envelope and treats provider parameters permissively;
  the E2E page is the canary.
- **New providers appear silently.** Atlassian adds providers server-side. Our
  unknown-id note is what makes that visible instead of mysterious — it must
  include the raw id, and it must not be downgraded to a debug-level message.
- **No resolved data is stored**, so every export re-queries. A large table on a
  many-page export multiplies API calls; the existing macro-resolution budget and
  concurrency limiter apply, but the cost profile is worth watching.
- **This plan assumes the site is Jira Cloud.** Data Center users keep the legacy
  macro; if a site has both, both paths must coexist — covered by the regression
  test, but worth a release-note line.

## Open questions

1. **Saved `filter` variant** — degrade in v1 (proposal) or resolve via
   `/rest/api/3/filter/{id}` right away? Degrading is honest and cheap; resolving
   is one extra call and one extra failure mode. **Proposal: degrade in v1**, ship
   the note, and revisit if the note actually shows up in real corpora.
2. **`maximumIssues` default.** Atlassian's own export uses page size 100 and
   auto-pages until exhausted; we cannot page indefinitely inside an export. Is
   100 the right default, and what is the hard cap? **Proposal: default 100, cap
   configurable, and a note when the table is truncated** — a silently truncated
   table would repeat exactly the class of bug this plan fixes.
3. **ADF intake** (`body-format=atlas_doc_format`) — worth adopting for
   datasources specifically, given that storage↔ADF is lossy by Atlassian's own
   warning? **Proposal: not now**; record the seam and revisit if entity-decoding
   proves fragile.
4. **Assets / Confluence-search providers** — do they warrant their own follow-up,
   or is "known-unsupported with a clear note" the permanent answer? Depends on
   whether they appear in real customer content; the unknown/unsupported notes
   will tell us.
5. **Where does this land?** It is engine work (`packages/confluence`,
   `packages/export-macros`) benefiting both hosts, discovered during spec 010.
   Own folder, or folded into a spec-010 wave? **Proposal: its own change, merged
   independently**, since it is not extension-specific and the CLI needs it just
   as much.
