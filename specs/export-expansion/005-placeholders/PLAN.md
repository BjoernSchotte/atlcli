# 005 — Placeholders: includepage & metadata

Status: Plan, 2026-07-19. Lane D of `specs/export-expansion/UMSETZUNGSPLAN.md`
(T1.11 / T1.12), detailed against `specs/export-expansion/BASELINE-DESIGN.md`
§4 Cluster D (D1, D2; outlook on D4/D5).

## Reference

- Plan of record: `specs/export-expansion/UMSETZUNGSPLAN.md` — Lane D, tasks
  T1.11 (`$scroll.includepage.(…)` document pass) and T1.12
  (`$scroll.metadata.(…)` reclassification). Lane D is listed under
  "immediately and independently startable (even before T0)".
- Design: `specs/export-expansion/BASELINE-DESIGN.md` §4 — D1 (includepage as
  a document pass), D2 (metadata reclassification + content-property alias
  bridge), D4 (PDF placeholder system, outlook), D5 (report behavior, outlook).
- Code owned by this plan (Lane D file ownership):
  - `packages/docx/src/placeholder-map.ts` — classification
    (`classifyPlaceholder`, `UNSUPPORTED_PREFIXES` line 220, `NEVER_PREFIXES`
    line 240) and argument parsers (`parsePagePropertyArgs`, `parseLogoArgs`).
  - `packages/docx/src/resolver.ts` — `ResolveDeps` (line 64), lazy-fetch
    contract, `resolvePlaceholders` / `resolveOne`.
  - `packages/docx/src/export.ts` — document passes: `$scroll.content` rawxml
    swap (`CONTENT_TAG_PARA` line 166, `injectContentTag` line 831), logo pass
    (`startLogoPass` line 474 / `finishLogoPass` line 530), PUA delimiters
    `DELIM_START`/`DELIM_END` (lines 152–153), `renderContent` (line 371),
    `preprocessScrollText` (line 876).
  - `packages/docx/src/scan.ts` — `PLACEHOLDER_RE` (line 68),
    `documentPartNames` (line 82), `scanZip` (line 120).
- Host seams touched (wiring only, additive):
  - `packages/confluence/src/client.ts` — `getPage` (line 510, returns
    `storage`), `search` (line 636, CQL), `requestV2` (line 376, for the
    optional D2 bridge).
  - `apps/cli/src/commands/export.ts` — ts-engine deps bag (lines 841–863).
  - `apps/extension/utils/docx/export-deps.ts` — `buildResolveDeps`.
- Test infrastructure: `packages/docx/src/fixtures.ts` (`buildDocx`, `para`,
  `runSplitPara`, `readPart`, `assertBalancedXml`, `pngFixtureBytes`),
  patterns in `packages/docx/src/placeholder-map.test.ts`,
  `packages/docx/src/resolver.test.ts`, `packages/docx/src/export.test.ts`.

## Goal & user value

Two `$scroll.*` placeholder families move to their honest, useful state in the
shared DOCX placeholder system (consumed identically by CLI, extension, and
further hosts):

1. **D1 — `$scroll.includepage.(…)` becomes supported.** A Word template can
   embed the body of *another* Confluence page at any position — cover-page
   disclaimer, company imprint, standard appendix. JTBD: "I maintain legal and
   organizational boilerplate once, centrally in Confluence, and every export
   pulls it in automatically." Today the prefix is classified `unsupported`
   ("cross-page include is out of scope in v1") and renders empty — a visible
   gap in the scan panel for teams migrating existing template estates.
2. **D2 — `$scroll.metadata.(…)` gets an honest classification.** Today it is
   `never` ("third-party app — we will never support it"). Publicly documented
   placeholder conventions carry no such caveat, so our ✗ is possibly factually
   wrong and needlessly final. It becomes `unsupported` with a reason that
   tells users what to do — plus an optional bridge: an alias mapping from
   metadata keys to Confluence content properties, which is where cloud
   metadata apps store their values in practice.

Both changes keep the system's core invariant: **never leak a literal** — every
`$scroll.*` token either resolves or is blanked with a structured report note.

## Dependencies

**None on other export-expansion work — explicitly, folder 001 (scope &
orchestration) is NOT required.** Lane D owns a disjoint file set
(`packages/docx/src/{placeholder-map,resolver,export,scan}.ts`); Lanes A/C/E
own `packages/confluence/src/export-blocks.ts` and the serializers.
`UMSETZUNGSPLAN.md` lists T1.11/T1.12 as startable immediately, even before the
T0 block-model sync point. This plan can merge in any order relative to
001/002/…; the only shared touchpoints are additive:

- `packages/confluence/src/client.ts` gains at most one new method (D2 bridge,
  `getContentProperty`) — additive, no signature changes.
- `apps/cli/src/commands/export.ts` deps bag and
  `apps/extension/utils/docx/export-deps.ts` gain one optional field each.

If the optional D2 alias bridge is deferred, this plan touches no file outside
`packages/docx` except the two host wiring points for D1.

## Architecture (isomorphic)

Everything lands in the isomorphic `@atlcli/docx` engine; hosts (CLI,
extension, further hosts) only wire fetchers into the existing `ResolveDeps`
port. No `chrome.*`, no `node:*`, no direct network calls inside the engine —
the same code runs in bun and in the browser bundle (`index.browser.ts`).

**D1 is a document pass, not a text placeholder.** The resolver produces
strings; an included page is OOXML. So D1 follows the two existing document
passes in `packages/docx/src/export.ts`:

- like `$scroll.content`: the placeholder **paragraph** is swapped for a
  docxtemplater **rawxml tag paragraph** written with the Private-Use-Area
  delimiters (`DELIM_START`/`DELIM_END`, U+E000/U+E001), and the rendered OOXML
  flows in as a *data value* — never re-parsed for tags, so literal braces and
  `$scroll.*` examples inside the included page survive verbatim;
- like the logo pass: occurrences are found by scanning paragraphs of all
  `documentPartNames(zip)` parts (body **and** headers/footers), the fetch leg
  is async and failure-tolerant, and every failure branch leaves the token in
  place for `preprocessScrollText` to blank (never-a-literal holds on every
  path).

The included page's body is rendered by the existing pipeline —
`storageToBlocks(page.storage)` → `serializeBlocks(blocks, ctx)` — with an
**image seam bound to the included page's id** (the existing
`imageSeam(embedder, assets, pageId, timings)` at `export.ts:644` is already
per-page), so attachments referenced by the included page fetch from *its*
attachment namespace, not the exported page's. This is why storage-level
splicing into `details.storage` was rejected in the design: it blurs asset
ownership.

**D2 is a data change plus (optionally) one resolver branch.** Reclassifying
`never` → `unsupported` is a pure edit of the classification tables. The alias
bridge adds one lazily-invoked `ResolveDeps` fetcher (`getContentProperty`) and
one resolver branch; alias mappings are host-supplied plain data.

Classification stays the single source of truth: the scan panel (✓/⚠/✗ per
row), the resolver, and the export report all read `classifyPlaceholder`, so
both changes surface everywhere at once with no host UI work.

### Outlook — D4: PDF placeholder system

D1/D2 deliberately land in the shared classification/parsing layer that D4
(BASELINE-DESIGN §4 D4) will lift into a shared package so the PDF engine's
header/footer/cover slots consume the *same* grammar (one vocabulary, two
resolution times: TS-resolved strings vs. layout-time tokens). Nothing in this
plan may bind against DOCX-only assumptions in `placeholder-map.ts` — parsers
stay pure string→struct functions. The PDF side of `$scroll.includepage` is
explicitly *reserved but not implemented* here; it arrives with the template
system planned in folder `specs/export-expansion/007-*` (PDF template &
placeholder plan), which also owns the package extraction
(`packages/export-placeholders`) and the new client methods beyond the
optional D2 bridge.

### Outlook — D5: report behavior

The new note codes introduced here (`includepage-unresolved`,
`includepage-cycle`, plus the existing `placeholder-unsupported`) become part
of the stable report-code vocabulary that D5's presentation-layer filtering
(`filterNotes`, per-code mute) builds on — planned in folder
`specs/export-expansion/007-*`. Consequence for this plan: the engine always
emits the full `ExportNote[]`; no suppression logic lands here, and note
`code` strings are chosen once and treated as public contract.

## Tasks

### Classification & parsing

- [ ] `packages/docx/src/placeholder-map.ts`: remove the
      `$scroll.includepage` entry from `UNSUPPORTED_PREFIXES` (line 221) and
      classify the base as
      `{ status: "supported", dependency: "includePage" }`; add
      `"includePage"` to the `PlaceholderDependency` union (line 43). Like
      `spaceLogo`, this dependency is *not* fetched by the text resolver — it
      marks the base as handled by a document pass.
- [ ] `packages/docx/src/placeholder-map.ts`: add `IncludePageRef`
      (`{ spaceKey?: string; title?: string; pageId?: string }`) and
      `parseIncludePageArgs(raw): IncludePageRef | null`, following the
      `parsePagePropertyArgs` conventions (quote stripping, whitespace
      trimming). Argument forms:
      - `(Title)` — title in the exported page's space (spaceKey left unset;
        the host fills in the current space),
      - `(SPACE:Title)` — split on the **first** colon; left side is the space
        key, right side the title (titles may themselves contain colons),
      - `(pageId)` — an all-digits argument is a page id,
      - empty/missing group → `null` (invalid; pass emits a note, token is
        blanked).
- [ ] `packages/docx/src/placeholder-map.ts` (D2): move `$scroll.metadata`
      from `NEVER_PREFIXES` (line 242) to `UNSUPPORTED_PREFIXES` with the new,
      vendor-neutral reason:
      `"metadata values live in a third-party app; map the key to a content property in the export settings to resolve it"`.
      The reason string appears verbatim in the scan panel and report — it
      must state the remedy, not just the gap.
- [ ] Verify no scan/report regression from the bucket move: `scanZip`
      (`packages/docx/src/scan.ts:120`) and `resolvePlaceholders`
      (`packages/docx/src/resolver.ts:318`) are classification-driven, so
      `$scroll.metadata.*` now lands in the ⚠ bucket and the
      `placeholder-unsupported` note path with no further code changes —
      pinned by tests, not assumed.

### Resolver & document pass

- [ ] `packages/docx/src/resolver.ts`: extend `ResolveDeps` (line 64) with
      the D1 seam:
      `getIncludedPage?: (ref: IncludePageRef) => Promise<ConfluencePageDetails | null>`
      (`null` = not found *or* not readable — Cloud returns indistinguishable
      403/404). Document that, like `getSpaceLogo`, it is consumed by the
      export orchestrator's include pass, not by the text resolver; it lives
      here so hosts wire every per-site round-trip through one deps bag.
- [ ] `packages/docx/src/resolver.ts`: keep the text path safe for the new
      supported base — `resolveOne`'s `default:` branch already returns `""`
      for bases it has no case for; confirm `$scroll.includepage.*` neither
      triggers any fetch in `resolvePlaceholders`' needs-loop (line 332) nor
      appears in `unsupportedNames`, and that a surviving token (pass skipped
      or failed) is blanked by `preprocessScrollText`. Add a case comment
      mirroring the logo/content treatment.
- [ ] `packages/docx/src/export.ts`: implement `runIncludePass(zip, deps,
      input, notes)` and call it in `exportDocx` **between step 3b
      (`finishLogoPass`, line 278) and step 4 (`preprocessScrollText`,
      line 297)** so a failed include is guaranteed to be blanked downstream:
      - occurrence scan: for each part in `documentPartNames(zip)`, walk
        `splitParagraphs(xml)` and match an include-token regex against
        `paragraphText(para)` (reuse the logo pass's paragraph-scan shape,
        `startLogoPass` lines 477–486) — headers/footers are covered because
        `documentPartNames` enumerates them and docxtemplater renders those
        parts too;
      - per occurrence `i`: `parseIncludePageArgs` → invalid args ⇒ note
        `includepage-unresolved` ("names no page"), skip (token blanks);
      - fetch via `deps.getIncludedPage?.(ref)`; `null`/missing dep/throw ⇒
        note `includepage-unresolved` with the honest permission wording:
        `"page not found or you lack permission to read it; rendered empty."`
        — deliberately ONE message, no false 403/404 precision;
      - **cycle protection**: a `visited: Set<pageId>` seeded with the
        exported page's own id (`input.details.id`). A ref resolving to an
        already-visited id ⇒ note `includepage-cycle`
        (`"cyclic or repeated include of "<title>" skipped; rendered empty."`),
        skip. v1 does not expand include tokens *inside* included content
        (page-body text is data, never parsed for placeholders — finding #7),
        so the set is the complete guard: self-include and duplicate includes
        are caught, and unbounded recursion is structurally impossible;
      - render: `storageToBlocks(page.storage ?? "")` → collect walk notes →
        `serializeBlocks(blocks, { styleNames, images: imageSeamForIncludedPage,
        diagrams })` where the image seam is constructed with the *included*
        page's id (reuse `imageSeam(embedder, assets, page.id, timings)`,
        line 644, sharing the export's one `ImageEmbedder` so relationship and
        drawing ids never collide); store the OOXML under rawxml key
        `scrollInclude${i}`;
      - swap the occurrence paragraph for
        `<w:p><w:r><w:t xml:space="preserve">${DELIM_START}@scrollInclude${i}${DELIM_END}</w:t></w:r></w:p>`
        (the free-tier rawxml module requires the tag to be the paragraph's
        sole content — same contract as `CONTENT_TAG_PARA`, line 166);
      - return the `Map<string, string>` of rendered OOXML.
- [ ] `packages/docx/src/export.ts`: thread the include map into rendering —
      `renderContent(zip, bodyXml, includes)` (line 371) renders
      `doc.render({ [CONTENT_KEY]: bodyXml, ...Object.fromEntries(includes) })`.
      Extend the `ensureCodeStyle` trigger (line 308) to also check the
      include OOXML for `CODE_STYLE_ID`, and confirm included-image skip notes
      flow into the `skippedImages` tally (line 318, they share the note
      codes). Add an `includeFetchMs` leg to `ExportTimings`/`timingNote` so a
      slow include names itself in the perf note.
- [ ] `packages/docx/src/resolver.ts` (D2 bridge, optional scope): add
      `getContentProperty?: (pageId: string, key: string) => Promise<string | null>`
      to `ResolveDeps` and `metadataAliases?: Record<string, string>` (key →
      content-property key) to `ExportInput`/`ResolveContext` plumbing. When an
      alias exists for the key of a `$scroll.metadata.(key)` occurrence,
      resolve it via the fetcher (lazy: fire only when an aliased occurrence
      exists) and count it as resolved; JSON values are stringified with an
      info note (consistent with the open `$scroll.jsoncontentproperty`
      stance); no alias ⇒ today's unsupported path with the new reason. If cut
      for time, ship the reclassification alone (T1.12's "S" scope) and leave
      the bridge to folder 007's shared-package work.
- [ ] `packages/confluence/src/client.ts` (only with the D2 bridge): add
      `getContentProperty(pageId, key)` on `requestV2` (line 376) per the
      BASELINE D4 sketch (`GET /api/v2/pages/{id}/properties?key=…`, first
      result's value; non-string values JSON-stringified).

### Host wiring

- [ ] `apps/cli/src/commands/export.ts` (deps bag, lines 841–863): implement
      `getIncludedPage`:
      - `ref.pageId` → `client.getPage(id)` (`client.ts:510`; returns
        `storage` — sufficient, the pass only needs id/title/storage);
      - title form → `client.search(cql)` (`client.ts:636`) with
        `type = page and space = "<KEY>" and title = "<Title>"` (values
        CQL-escaped; `ref.spaceKey ?? page.spaceKey` fills the bare-title
        form), results sorted by id for determinism, first hit fetched via
        `getPage`; more than one hit additionally surfaces in the pass note;
      - any 4xx/5xx → `null` (the pass owns the user-facing message);
      - memoize per ref like the existing `spaceInfo`/`currentUser` promises
        so repeated refs cost one round-trip.
- [ ] `apps/extension/utils/docx/export-deps.ts`: mirror the same
      `getIncludedPage` in `buildResolveDeps` on the session-fetch client
      (id → `getPage`, title → CQL search), memoized per ref — further hosts
      get the feature by implementing the same one optional fetcher.
- [ ] Scan-side UX note (defer, document only): probing include targets at
      scan time (✓ resolvable / ⚠ not found in the panel) requires an async
      scan seam — out of scope here; the scan shows the row as supported and
      the export report carries the truth. Record in
      `docs/reference/` placeholder table.
- [ ] `docs/` update (workflow rule "docs are first-class"): placeholder
      reference table row for `$scroll.includepage` — argument forms with
      type/constraints, one minimal and one realistic example (imprint page in
      a header), troubleshooting entries for `includepage-unresolved` /
      `includepage-cycle`; update the `$scroll.metadata` row to the new
      wording (+ alias mapping config for CLI `~/.atlcli/config.json` if the
      bridge ships).

### Tests (no mocking)

Hard rule for this plan: **no mocking** — no `mock()`, no spies, no stubbed
modules. Unit deps are real in-memory implementations (plain async functions
over fixture data, counting calls with plain closures where the lazy contract
is asserted); documents are real `.docx` packages built with the
`packages/docx/src/fixtures.ts` builders; E2E runs the built CLI against the
real Confluence site.

- [ ] `packages/docx/src/placeholder-map.test.ts` — table-driven, following
      the existing `parsePagePropertyArgs` describe-block pattern:
      - classification: `$scroll.includepage`, `$scroll.includepage.(X)` in
        all three arg forms → `supported` + dependency `includePage`;
        `$scroll.metadata`, `$scroll.metadata.(docNumber)` → `unsupported`
        with the new reason (regression test for the reclassification);
        `$scroll.custom.*` stays `never` (pin the neighbor);
      - `parseIncludePageArgs` table: `(Title)`, `(SPACE:Title)`,
        `(DOCSY:A: colon title)` (first-colon split), `(123456)` → pageId,
        `( "Quoted Title" )` (trim + quote strip), `()` / missing group →
        `null`.
- [ ] `packages/docx/src/resolver.test.ts`:
      - `$scroll.includepage.(X)` through `resolvePlaceholders` with a
        call-counting real `getIncludedPage` closure: resolves to `""` in the
        values map (text path never renders it), the fetcher is **not**
        called by the resolver, and the base does not appear in
        `unsupportedNames`;
      - `$scroll.metadata.(key)` emits the `placeholder-unsupported` note
        carrying the new reason text;
      - (bridge, if shipped) aliased key resolves via an in-memory
        `getContentProperty` backed by a plain map — lazy (uncalled without an
        aliased occurrence), JSON value → stringified + note.
- [ ] `packages/docx/src/export.test.ts` — document-pass tests on real docx
      fixtures (`buildDocx`/`para`/`runSplitPara`/`readPart`/
      `assertBalancedXml`), with `getIncludedPage` as a plain function
      returning fixture `ConfluencePageDetails` whose `storage` holds sentinel
      content:
      - body **and header** include: template with
        `para("$scroll.includepage.(ENG:Imprint)")` in `body` and `header`;
        assert the sentinel text appears in `word/document.xml` and
        `word/header1.xml`, both parts balanced, and **no `$scroll.` literal
        survives anywhere** (extend the existing pinning loop);
      - run-split token (`runSplitPara(["$scroll.includepage.", "(ENG:Imprint)"])`)
        is still found and replaced;
      - unresolved: `getIncludedPage` returning `null` (and a second case:
        dep absent) ⇒ output contains no literal, report carries
        `includepage-unresolved` with the "not found or you lack permission"
        wording;
      - cycle: include ref resolving to the exported page's own id, and the
        same target included twice ⇒ one rendered occurrence max,
        `includepage-cycle` note, no literal;
      - asset ownership: included page whose storage references an attachment
        image, with a real in-memory `AssetFetcher` serving
        `pngFixtureBytes(…)` keyed by requested URL ⇒ the fetched ref carries
        the **included** page's id, the media part and relationship exist in
        the output, and drawing ids don't collide with an image on the
        exported page itself;
      - code style: included page with a code macro ⇒ `ensureCodeStyle` fired
        (style present in `word/styles.xml`).
- [ ] E2E (workflow rule; profile `mayflower`, space `DOCSY`, built CLI
      `bun ./dist/index.js`, pattern: `scripts/e2e-template-test.sh`):
      - [ ] create an include-target page in DOCSY with unique sentinel
            content (`atlcli` page create / API), and a small bun script using
            `packages/docx/src/fixtures.ts` builders to produce a template
            containing `$scroll.includepage.(DOCSY:<title>)` in **body and
            header** plus `$scroll.content`;
      - [ ] `atlcli wiki export <pageId> -t <template> -o out.docx --engine ts
            --json`: unzip and assert the sentinel appears in
            `word/document.xml` and `word/header1.xml`, and no `$scroll.`
            literal survives;
      - [ ] cycle path: template including the exported page itself → report
            (`--json`) contains `includepage-cycle`, export still succeeds;
      - [ ] permission path: include a DOCSY page carrying view restrictions
            the `mayflower` profile's token user cannot read, assert blank
            output + `includepage-unresolved`. If no such restricted page can
            be provisioned with this profile's rights, fall back to a
            nonexistent title (same code path by design: Cloud 403 ≡ 404) and
            record the restricted-page case as a **documented manual check**
            in the PR description;
      - [ ] cleanup: delete every created test page and temp template/output
            file (workflow rule).
- [ ] `bun run typecheck` and full `bun test` green before push (workflow
      rules; regression tests above double as the mandated bug-prevention
      tests for the reclassification and the never-a-literal invariant).

## Definition of Done

- `$scroll.includepage.(Title|SPACE:Title|pageId)` renders the referenced
  page's body at the placeholder position in body, header, and footer parts,
  in CLI and extension (further hosts: by wiring one optional fetcher).
- Included pages' attachment images embed via the included page's own
  attachment namespace; failures degrade to report notes, never dangling
  relationships (the 004-F3 invariant holds on every branch).
- Cycle/self/duplicate includes and unresolved/permission failures render
  blank with `includepage-cycle` / `includepage-unresolved` notes; the honest
  single "not found or no permission" wording is used; **no `$scroll.*`
  literal can survive on any path** (pinning tests extended).
- `$scroll.metadata.*` scans as ⚠ `unsupported` with the new actionable
  reason; nothing regresses to a literal. (If the bridge shipped: an aliased
  key resolves from a content property, lazily.)
- Scan panel, resolver, and report all reflect the new classifications with
  zero host-specific special cases (classification remains the single source).
- Unit + document-pass tests (no mocking) green, `bun run typecheck` clean,
  E2E on DOCSY executed and test resources cleaned up.
- `docs/` placeholder reference updated in the same PR (reference-table row
  with forms/constraints, minimal + realistic example, troubleshooting
  entries); note codes documented as stable.

## Risks & open questions

- **Titles containing `)`** — `PLACEHOLDER_RE` (scan.ts:68) stops the argument
  group at the first `)`, so such titles cannot be referenced by title.
  Documented limitation; workaround: the `(pageId)` form. Not worth a grammar
  change in v1.
- **Bare-title colon ambiguity** — `(A: B)` parses as space `A`, title `B` by
  the first-colon rule; a same-space page literally titled "A: B" must use the
  explicit `(SPACE:A: B)` form. Pin the chosen behavior in the parser table
  test; revisit only if real templates trip on it.
- **Duplicate includes** — the visited-set treats a second include of the same
  page as a cycle (blank + note), per the BASELINE sketch. A legitimate
  use case exists (same disclaimer in header *and* footer). Open question for
  review: keep the strict guard (v1, simplest honest behavior) or cache the
  rendered OOXML per pageId and allow repeated occurrences while still
  blocking self-include. Recommendation: strict in v1, revisit on first user
  report — the note text says exactly what happened.
- **Title lookups are not unique** — CQL can return several pages for one
  title. v1: deterministic first hit (sorted by id) + note naming the count.
- **Heading collision** — an included page starting at H1 lands mid-flow.
  v1: include unchanged and note it; heading-offset harmonization belongs to
  the chapter-compose work (folder 001/A4), not here.
- **Permission wording** — Cloud 403/404 are indistinguishable; we commit to
  one honest combined message rather than false precision. E2E's restricted-
  page leg may only be checkable manually (see task).
- **D2 ground truth** — where cloud metadata apps *actually* store values is
  not reliably documented publicly; before any compatibility claim, a real-
  instance test is required. The alias bridge deliberately makes the mapping
  user-controlled data instead of guessing. JSON property values: v1
  stringifies with a note.
- **Scan-time include probing** (✓/⚠ per target in the panel) needs an async
  scan seam — deferred; the report is the source of truth until then.
- **Interaction with tree/space export (folder 001)** — when chapters are
  composed, includes still resolve against the template once per export (the
  root page is `details`, consistent with `$scroll.title` semantics). No code
  coupling, but worth one integration test when both lanes have merged.
