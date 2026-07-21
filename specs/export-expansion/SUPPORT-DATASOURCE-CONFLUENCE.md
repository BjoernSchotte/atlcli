# Datasource smart links — support the Confluence list ("Confluence search") provider

Status: Plan, 2026-07-21. Follow-up to `SUPPORT-DATASOURCE-JIRA.md`, which built
the provider registry this plan extends by one entry plus a renderer.

## Reference

- Predecessor (read first): `specs/export-expansion/SUPPORT-DATASOURCE-JIRA.md` —
  the multi-provider research, the closed ADF envelope schema, the resolution
  decision (documented product APIs, never `/gateway/api/object-resolver`), and
  the degradation contract.
- Registry to extend: `packages/confluence/src/datasource.ts` — `CONFLUENCE_SEARCH`
  is already registered as `known-unsupported`, so today it degrades with a
  precise note instead of vanishing (verified, see [Evidence](#evidence)).
- Renderer pattern to mirror: `packages/export-macros/src/jira.ts`.
- Existing search seams this plan builds on: `ConfluenceClient.search(cql, …)`
  and `.searchPages(cql, …)` (`packages/confluence/src/client.ts:859,919`);
  `TreeSource.searchPages?(cql, ctx)` (`packages/confluence/src/tree-fetch.ts:97`);
  `ConfluenceContentPort` (`packages/export-macros/src/types.ts:170`);
  `escapeCqlValue` (already used for label batches).
- Live artifact: DOCSY page `1126236229` ("M1 Abnahme Abschnitt 7.6").

## Evidence — the real artifact

Unlike the Jira plan, which had to infer this provider's serialization, we now
have an observed sample. **The inference was correct**: the Confluence-search
provider uses the identical `<a data-datasource>` form.

```html
<a href="https://<site>/wiki/search?text=&contributors=70121%3A666cbd78-…"
   data-card-appearance="block"
   data-datasource="{…}">
```

```jsonc
{
  "id": "768fc736-3af4-4a8f-b27e-203602bff8ca",   // matches the researched UUID exactly
  "parameters": {
    "cloudId": "ca7c5cc9-632e-4985-b88e-fb2a96c0b9ca",
    "contributorAccountIds": ["70121:666cbd78-32fa-4764-90a1-d3368305f07b"],
    "searchString": ""                             // EMPTY — see trap 1
  },
  "views": [{ "type": "table", "properties": { "columns": [
    { "key": "type" }, { "key": "title" }, { "key": "space" },
    { "key": "description" }, { "key": "ownedBy" }, { "key": "updatedAt" },
    { "key": "labels" }, { "key": "status" }
  ]}}]
}
```

Current behaviour (verified live, PDF export of that page):

```
notesByCode: { "datasource-provider-unsupported": 1 }
warning: A Confluence search results datasource table is not rendered by this
         exporter yet; it was kept as a link.
```

### What it looks like in Confluence (observed, same page)

The rendered card is a scrollable table: **Type** (a content-type glyph), **Title**
(a link), **Space** (a chip with icon), **Description** (a truncated excerpt),
**Owned by** (avatar + display name), then `updatedAt`, `labels`, `status` behind
a **horizontal scrollbar**. Its footer reads **"Synced just now · 2.817 items"**.

Two facts from that footer and that scrollbar drive the design below, and both
contradict assumptions carried over from the Jira provider:

1. **2 817 rows.** This list filters on one contributor and nothing else. For
   Jira, truncation was an edge case; here it is the **normal case**, and a
   100-row cap would show 3.5 % of the result set.
2. **Eight columns need a horizontal scrollbar in a browser.** A PDF page cannot
   scroll. This is a layout problem the Jira table (seven narrower columns, short
   values) never really hit.

…and the `href` renders as a link. **The registry works as designed** — this is a
named, visible degradation, not a silent drop. That is the floor this plan raises.

## Three traps the artifact exposes

**1. `searchString` is empty; the query lives in the filters.** A consumer that
keys on `searchString` finds nothing to search and would render an empty table
or conclude "no query". Here the entire query is `contributorAccountIds`. This is
the same class as Jira's `jql` XOR `filter` — the query is not always where the
obvious field is. The renderer must **compose CQL from all present parameters**
and treat "no parameters at all" (not "no searchString") as the empty case.

**2. `parameters` values are arrays, not flat strings.** Jira's were scalars
(`jql`, `filter`, `cloudId`). `contributorAccountIds` is a list, and per the
`@atlaskit` type declarations so are `spaceKeys`, `labels`, `entityTypes`,
`contentStatuses`, `ancestorPageIds`, `contributorAccountIds`, `creatorAccountIds`,
`contentARIs`. The parameter→query mapping is therefore a **list-aware** join
(CQL `in (…)`), and every literal must go through `escapeCqlValue`.

**3. Four of the eight columns are not plain search-result fields.**
`type`, `title`, `space` and `updatedAt` come straight off a CQL search result.
`description`, `ownedBy`, `labels` and `status` do not — they need expansions or
follow-up lookups. A naive implementation renders four empty columns, which is
the same failure mode as the Jira `issuetype`/`type` drift that would have blanked
the first column. **Verify each column against a real response before trusting a
mapping.**

## Architecture

Same shape as the Jira provider: registry entry + `toParams` + a renderer that
consumes the existing ports. No new resolution mechanism, no object-resolver.

### 1. Registry entry

`packages/confluence/src/datasource.ts`: flip `CONFLUENCE_SEARCH` from
`known-unsupported` to `supported`, with `macroName: "confluence-list"` (a
synthetic name — there is no legacy macro to collide with) and a `toParams`
that maps the observed parameters onto `MacroParameter[]`.

### 2. Parameter → CQL mapping

| Parameter | CQL fragment | Notes |
|---|---|---|
| `searchString` | `text ~ "…"` | Omit entirely when empty (trap 1) |
| `spaceKeys` | `space in (…)` | |
| `labels` | `label in (…)` | |
| `entityTypes` | `type in (…)` | Map Atlassian's vocabulary to CQL's (`page`, `blogpost`, …) — verify, do not assume identity |
| `contentStatuses` | `status in (…)` | |
| `ancestorPageIds` | `ancestor in (…)` | |
| `contributorAccountIds` | `contributor in (…)` | The artifact's only filter |
| `creatorAccountIds` | `creator in (…)` | |
| `lastModified*` | `lastmodified >= … / <= …` | Relative dates (`today`) resolve against the export's timezone — see Open questions |
| `contentARIs` | — | Degrade with a note; ARIs are not CQL-addressable |
| `shouldMatchTitleOnly` | `title ~ "…"` instead of `text ~ "…"` | Modifier, not a filter |

All fragments `AND`-joined; every literal through `escapeCqlValue`. If **no**
parameter yields a fragment, degrade with a note rather than issuing an unbounded
site-wide search.

### 3. A new port, or reuse?

`ConfluenceContentPort` (`types.ts:170`) exposes `getPageStorage`/`getPageStorageById`
— no search. `TreeSource.searchPages` exists but returns **ids only** (`{ id }[]`),
which is deliberate: the tree walker only needs ids for label filtering.

This renderer needs id **plus** title, space, type, timestamps and more. So:
**extend `ConfluenceContentPort` with a `searchContent(cql, opts)` method**
returning the fields the columns need, rather than widening `TreeSource.searchPages`
(whose narrow return type is load-bearing for the "filtered pages are never
loaded" invariant). Both hosts already construct a `ConfluenceContentPort`
(`packages/export-wiring/src/ports.ts`), so wiring is one adapter method per host
and the extension inherits it through the session ports.

### 4. Column resolution — the part to measure, not assume

Determine per column, **against a real response**, whether it is available from
the search call, from an expansion, or needs a second lookup:

| Column | Expected source | Confidence |
|---|---|---|
| `type`, `title`, `space`, `updatedAt` | search result directly | high |
| `labels` | expansion (`metadata.labels`) | medium |
| `description` | excerpt / `body.view` excerpt | **low — verify** |
| `ownedBy` | `history.ownedBy` / owner lookup | **low — verify** |
| `status` | content status (current/draft/archived) | medium |

Rule: a column that cannot be resolved renders **empty with one note naming the
column**, never a blank table and never a silent gap. Batch whatever is batchable;
a per-row lookup on a 50-row table is an unacceptable cost profile.

### 5. Internal links — the thing that makes this feel finished

A Confluence list is a list of **pages**. In a tree or space export, some of
those pages are **in the same document**. Rendering their titles as absolute
`https://…` links would send the reader out to the web to reach a page two
chapters away.

The export pipeline already solves this class of problem: `composeChapters` takes
a `resolveExternalUrl` callback and emits `link-outside-scope` notes for targets
outside the export. The renderer must produce link targets that participate in
that mechanism — internal targets where the page is in scope, absolute otherwise,
with the existing note vocabulary. **Do not invent a second link-resolution
path.**

### 6. Volume — truncation is the normal case here

Atlassian stores no row limit (same closed envelope), and the observed list has
**2 817 matches**. So unlike Jira, "how many rows" is a primary design question,
not a safety valve:

- Keep the measured-truncation mechanism from Jira (request N+1, slice, note) —
  truncation must remain a **fact**, never a guess.
- **Raise the note's prominence**: at 100 of 2 817 the table is a sample, and the
  note must say so in those words (count shown, count matched), not merely
  "truncated".
- **Keep the link to the live list underneath the table.** This reverses the Jira
  decision (table replaces link) deliberately: when the reader is seeing 3.5 % of
  the data, the route to the rest is not clutter, it is the point. See Open
  question 2 — now answered by evidence rather than by symmetry.
- A list this size is usually a sign the author wants a *filtered* view. The note
  should be actionable, i.e. mention that adding space/label filters in Confluence
  narrows what the export can show.

### 7. Layout — eight columns do not fit a page

The browser gives the card a horizontal scrollbar; a PDF page has no such escape.
The repo already has the machinery and the vocabulary for this —
`table-text-scaled` and `table-overflow-warned` (`packages/pdf/src/serialize.ts:994,1001`),
plus `table-geometry-clamped` and `table-shape-approximated`. **The renderer must
emit a normal table block and let the existing serializer handle overflow**, so a
datasource table degrades exactly like any other wide table and the user gets the
note vocabulary they already know. Do not add a datasource-specific layout path.

Cell content must be **text**, since three of the columns are visual in the UI:
`Type` is a glyph → the content-type name; `Space` is a chip with an icon → the
space name; `Owned by` is an avatar + name → the display name. Avatars are not
fetched (they would be an asset-budget item for decoration; the name carries the
information).

## Tasks

- [ ] `packages/confluence/src/datasource.ts`: `CONFLUENCE_SEARCH` → `supported`,
      `toParams` implementing the mapping table, list-aware and `escapeCqlValue`d.
      Degrade when no fragment can be built or when only `contentARIs` is present.
- [ ] `packages/export-macros/src/types.ts`: extend `ConfluenceContentPort` with
      `searchContent(cql, { columns, maximumResults, signal })`.
- [ ] `packages/export-wiring/src/ports.ts`: implement it over `ConfluenceClient.search`
      for both hosts (one adapter; the extension inherits it via the session ports).
- [ ] `packages/export-macros/src/confluence-list.ts` (new): the renderer —
      CQL → rows → table blocks, honouring the author's column order, resolving
      link targets through the in-scope mechanism, truncation probe, per-column
      degradation notes.
- [ ] Register it in `createRegistry`/`defaultRegistry`.
- [ ] New note codes in `EXPORT_NOTE_CODES` for the column-unresolvable and
      no-query cases; **regenerate the API reports**.
- [ ] Docs: extend the datasource section of
      `src/content/docs/confluence/macro-compatibility.md` with the second
      provider, its supported filters, and what degrades.

## Tests

**NEVER mock HTTP** (port fakes for our own ports, real `Response` objects, real
`Bun.serve` stubs for CLI-level tests — the established patterns).

- [ ] `datasource.test.ts`: the **real artifact from page 1126236229** as a
      fixture; empty `searchString` + `contributorAccountIds` yields
      `contributor in (…)` and **no** `text ~` fragment (trap 1); array params
      become `in (…)` lists (trap 2); CQL literals are escaped, incl. a value
      containing a quote; no-fragment case degrades.
- [ ] Renderer tests against a port fake: the author's eight columns render in
      order; an unresolvable column is empty **with a note**; truncation emits the
      note; row cap honoured.
- [ ] In-scope link test: a result page that is part of the export links
      internally; one outside links absolutely and emits `link-outside-scope`.
- [ ] Cross-engine parity: identical note codes and table shape from the PDF and
      DOCX paths (extend `engine-parity.test.ts`).
- [ ] Volume: a result set far larger than the cap renders exactly `cap` rows,
      emits a note naming **both** counts, and keeps the live-list link; a result
      set below the cap emits no truncation note and no link.
- [ ] Layout: an eight-column table routes through the existing overflow path
      (`table-text-scaled` / `table-overflow-warned`) rather than a bespoke one;
      `Type`/`Space`/`Owned by` render as text, not as empty cells where the UI
      shows a glyph, chip or avatar.
- [ ] Regression: the Jira provider and the legacy `ac:structured-macro` path are
      unchanged.
- [ ] **Mutation-test every load-bearing assertion** (revert → red → restore).

## E2E

- [ ] Page `1126236229` (read-only, do not modify): **before** — link plus
      `datasource-provider-unsupported`; **after** — a real table with the
      author's eight columns and a `macro-rendered-via` note, in **both** PDF and
      DOCX.
- [ ] Tree export of the M1 corpus: the Confluence list on 7.6 and the Jira table
      on 7.7 both render **in the same document**, alongside the legacy Jira macro
      on Kapitel 4 — three macro forms, one export.

## Definition of Done

- A Confluence list authored in the current editor renders as a real table in
  both formats and from both hosts, with the author's column selection and order.
- A column that cannot be resolved is empty **and named in a note** — never a
  silently blank column.
- The query is composed from **all** present parameters; an empty `searchString`
  with filters present still queries correctly, and a parameter set that yields no
  fragment degrades rather than issuing an unbounded search.
- Result pages that are inside the export link internally, through the existing
  scope mechanism.
- Truncation is measured, not guessed, and the note names both the shown and the
  matched count — at 100 of 2 817 the reader must be able to tell it is a sample.
- A truncated table keeps a link to the live list; an untruncated one does not.
- Wide tables degrade through the **existing** overflow vocabulary, not a
  datasource-specific layout path; glyph/chip/avatar columns render as text.
- The Jira provider, the legacy macro path, and the unknown-provider degradation
  are all unchanged.
- `bun run test`, `bun run typecheck`, `bun run check:browser` green.

## Risks

- **Column vocabulary is under-documented.** The Jira provider already proved the
  keys drift (`issuetype` vs `type`). Here `description`/`ownedBy`/`status` are
  low-confidence guesses about their source. Mitigation: verify each against a
  real response in the first task; a wrong guess must degrade visibly, not blank.
- **Cost profile.** Unlike a Jira JQL search (one call), the columns may force
  expansions or follow-up lookups. A 100-row list inside a 200-page export could
  multiply calls. Mitigation: batch aggressively, honour the existing macro
  resolution budget and concurrency limiter, and measure before shipping a
  default cap above 100.
- **CQL is not a superset of the datasource filters.** `contentARIs` has no CQL
  equivalent, and Atlassian may add filters that do not map. The no-fragment
  degradation is what keeps that honest.
- **Empty results are ambiguous.** A table with zero rows can mean "the filter
  legitimately matches nothing" or "our CQL translation is wrong". The renderer
  should emit an informational note carrying the composed CQL so a user can tell
  the two apart from the report alone.

## Open questions

1. **Relative date filters.** `lastModified` supports relative values, and
   Atlassian's own resolver sends an `origin-timezone` header. Which timezone does
   an export use — the machine's, the site's, or a fixed UTC? A reproducible
   export arguably needs a fixed one. **Proposal: reuse whatever the existing
   `exportedAt`/`SOURCE_DATE_EPOCH` reproducibility mechanism establishes**, and
   note the resolved window in the report.
2. ~~**Should the rendered table be a snapshot or carry the link too?**~~
   **Answered by the artifact (2 817 items):** keep the link under the table. A
   reader seeing 100 of 2 817 rows needs the route to the rest, so consistency
   with Jira would be the wrong kind of consistency here. Remaining sub-question:
   should the link also appear when the table is *not* truncated? **Proposal:
   no** — show it only when something was withheld, so its presence carries
   information.
3. **`description` column semantics.** Confluence's search excerpt is
   highlight-marked HTML in some responses. Do we strip to plain text, or render
   the highlight? **Proposal: plain text** — the highlight refers to a search term
   that may not even exist here (empty `searchString`).
4. **Third provider (JSM Assets)** stays `known-unsupported`. Nothing in the
   corpus uses it, and its AQL query language is a separate integration. Revisit
   only if a real artifact appears.
