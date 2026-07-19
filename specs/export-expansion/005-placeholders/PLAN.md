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
    optional D2 bridge), plus a new pure, **exported** `escapeCqlValue` helper
    (title-form lookup, see Host wiring). The CLI already has a CQL-quote
    escaper, but it is private and incomplete: `apps/cli/src/commands/
    search.ts:227–232`'s `escapeQuotes` only backslash-escapes `"` — no
    backslash, CR/LF, or empty-value handling — and is not exported, so the
    extension's `getIncludedPage` title lookup (Host wiring) cannot reuse it.
    `request()`'s retry/throw shape (lines 282–370: retries 429 and 5xx, then
    throws a plain `Error` whose message embeds the status as
    `"Confluence API error (NNN): …"`, the 429-exhausted case throws a
    differently-worded `"Rate limited by Confluence API after N retries"`
    with no status number at all, and a network-level failure throws
    whatever `fetch` throws — no typed status field anywhere) is load-bearing
    for the include lookup's error classification — read before implementing
    `getIncludedPage`.
  - `apps/cli/src/commands/export.ts` — ts-engine deps bag (lines 841–863);
    the `--json` report emission (line 886) currently discards `ExportNote.code`
    by mapping every note to a `"${level}: ${message}"` string (see Host
    wiring) — that must change for this plan's own E2E assertions to be
    checkable (verified: no existing task fixes this; see the new CLI report
    task below).
  - `apps/extension/utils/docx/export-deps.ts` — `prepareExportDeps` /
    `ExportDependencyLoaders` / `scanDependencies` / the `memoByKey`
    Map-keyed memoization helper (lines 6–13, 34–53, 55–65, 80–121). **Not**
    `buildResolveDeps` — no such function exists in this codebase; the real,
    and only, callsite is
    `apps/extension/entrypoints/sidepanel/TemplateSection.tsx:244–251`, which
    passes exactly today's four loaders (`getSpaceWithIcon`, `getCurrentUser`,
    `getPageOwner`, `getSpaceHomepageStorage`) into `prepareExportDeps`.
    `ExportDependencyLoaders` has no fifth slot today — adding
    `getIncludedPage` means extending the interface, `prepareExportDeps`'s
    `deps` object, and the `TemplateSection.tsx` call site together (verified:
    the Host wiring task below in the original draft named the nonexistent
    `buildResolveDeps` for this exact step — a self-contradiction against this
    Reference entry, now fixed). Test file:
    `apps/extension/tests/docx/export-deps.test.ts`.
  - `packages/docx/src/image.ts` — `EmbedImageOptions.partPath` /
    `EmbedSvgOptions.partPath` (lines 300, 315) default to `DOCUMENT_PART`
    (`word/document.xml`) via `ensureRelationship` (line 488) /
    `relsPathFor` (line 510) when omitted. **Verified gap**: `imageSeam`
    (`export.ts:644`) and `diagramSeam` (`export.ts:713`) construct their
    `embed()` calls (lines 685, 792) without `partPath` — every image/diagram
    they embed lands in `word/document.xml.rels` regardless of which part
    the calling `serializeBlocks` output is destined for. The **only**
    existing caller that gets this right is the logo pass
    (`finishLogoPass`, line 559), which explicitly threads
    `partPath: occ.part` (line 569) per occurrence. D1 must follow the logo
    pass's shape, not the (part-blind) main-body `imageSeam`/`diagramSeam`
    calls, when an included page lands in a header/footer part.
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
orchestration) is NOT required.** `UMSETZUNGSPLAN.md` lists T1.11/T1.12 as
startable immediately, even before the T0 block-model sync point, and this
plan can start and merge independently of 001/002/003/004.

**File ownership is NOT fully disjoint — corrected from an earlier draft.**
`packages/docx/src/{placeholder-map,resolver,scan}.ts` are exclusive to this
plan. `packages/docx/src/export.ts` is **not**: two other in-flight plans
touch it too (verified against their own PLAN.mds, not just
`UMSETZUNGSPLAN.md`'s "two hot files" summary, which omits this file
entirely — see `crossPlanImpacts`):

- `specs/export-expansion/003-content-features/PLAN.md` touches
  `injectContentTagAtEnd` (`export.ts:845` in that plan's line numbering).
- `specs/export-expansion/004-macro-renderer/PLAN.md` inserts its async
  macro-resolver pass "directly after `storageToBlocks`, line 235" inside
  `exportDocx` — the same call site D1's include pass (below) mirrors as its
  own pattern.

Mitigation for this plan's own PRs: D1 only **adds** new top-level functions
(`runIncludePass` and its helpers) and **one new call** in `exportDocx`
between existing steps 3b and 4 (see Architecture) — it does not edit
`injectContentTagAtEnd` or the `storageToBlocks` call site itself, so a
textual merge conflict is unlikely. A **semantic** conflict is still
possible if 004 lands first and the include pass's own `storageToBlocks`
call needs the same macro-resolution hook (see the new Risk entry below);
rebase and re-run `packages/docx/src/export.test.ts` after either 003 or 004
merges, whichever lands first relative to this plan.

The remaining shared touchpoints stay additive:

- `packages/confluence/src/client.ts` gains at most two new methods
  (`getContentProperty` for the optional D2 bridge; `escapeCqlValue`, a pure
  helper with no I/O) — additive, no signature changes.
- `apps/cli/src/commands/export.ts` deps bag and
  `apps/extension/utils/docx/export-deps.ts` /
  `apps/extension/entrypoints/sidepanel/TemplateSection.tsx` gain one new
  loader (`getIncludedPage`) each.

If the optional D2 alias bridge is deferred, this plan touches no file outside
`packages/docx` except the host wiring points for D1 listed above.

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

**Atomic-paragraph contract for the swap (corrected — an unconstrained match
would silently delete surrounding text).** docxtemplater's free-tier rawxml
module requires its tag to be the sole content of its paragraph
(`export.ts:158–167`, `CONTENT_TAG_PARA`), and the existing logo pass already
documents that it drops any other text sharing the placeholder paragraph
(`export.ts:519–521`). D1 introduces a *new*, user-authored token that is
much more likely to sit next to explanatory prose than a logo or the single
`$scroll.content` placeholder ("See our disclaimer: `$scroll.includepage.
(ENG:Imprint)`"), so an unconditional whole-paragraph swap here risks silent
document data loss. Contract: after matching the include-token regex against
`paragraphText(para)`, compare the match against the paragraph's full
(trimmed) text. Only when they are equal (the token is the paragraph's only
visible content) does the pass take the OOXML-swap route. Otherwise it skips
the swap entirely, emits `includepage-invalid-context`, and does nothing
else — the token text is left in place, and step 4's existing
`preprocessScrollText` pass blanks it for free (the base is classified
`supported`/`includePage`, and `resolveOne`'s `default:` branch already
returns `""` for it — see Resolver & document pass), preserving every other
character of that paragraph exactly as authored. No new blanking machinery
is required.

**Cycle protection blocks self-include only — corrected from an earlier
"every repeat is a cycle" draft, which directly contradicted this plan's own
body+header test requirement (see Tests).** V1 never re-parses included
content for further `$scroll.*` tokens (page-body text is a data value —
finding #7), so true multi-hop cycles (A includes B includes C includes A)
are structurally impossible regardless of any guard: nothing after the
top-level template scan ever looks for another include token. The only
real hazard is a page including *itself*, which would otherwise double its
own body inline. So the pass tracks exactly one thing — whether a resolved
ref's `pageId` equals `input.details.id` (the exported page's own id) — and
blocks only that case with `includepage-cycle`. Every other repeat
(the same target included twice in one part, or once each in body, header,
and footer — the explicit disclaimer/imprint use case from Goal & user
value) renders normally: fetches are deduplicated by a `Map<pageId,
Promise<IncludeLookupOutcome>>` (one round-trip per unique target,
however many times it's referenced), and rendered OOXML per pageId is
likewise cached and reused verbatim for every occurrence — walking
(`storageToBlocks`/`serializeBlocks`) still runs once per unique pageId, not
once per occurrence. Occurrences across different target parts (body vs.
header vs. footer) resolve independently but read the same pageId cache, so
a page fetched for the body is not re-fetched for the header.

The included page's body is rendered by the existing pipeline —
`storageToBlocks(page.storage)` → `serializeBlocks(blocks, ctx)` — with an
**image seam bound to both the included page's id AND the occurrence's
target part** (corrected — the existing `imageSeam(embedder, assets, pageId,
timings)` at `export.ts:644` and `diagramSeam` at `export.ts:713` are
per-page but NOT per-part: neither threads `partPath` into its
`embedder.embed`/`embedSvg` call, so every image/diagram they embed lands in
`word/document.xml.rels` regardless of which part the calling
`serializeBlocks` targets — verified against `image.ts`'s `partPath` default,
see Reference). An include landing in a header or footer therefore needs its
own `imageSeam(embedder, assets, page.id, timings, occ.part)` /
`diagramSeam(embedder, rasterizer, diagramTheme, timings, occ.part)` —
extending both factory functions with an optional trailing `partPath` param
that flows straight into the existing `opts.partPath` on `embed`/`embedSvg`,
exactly mirroring what the logo pass already does at `export.ts:569`.
Without this, an included page's attachment image inside a header would
render an `r:embed` relationship id that exists in
`word/document.xml.rels` but not in `word/header1.xml.rels` — a dangling
reference Word repairs by silently dropping the picture, which is exactly
the invisible-media failure mode the 004-F3 invariant exists to prevent.
This is why storage-level splicing into `details.storage` was rejected in
the design: it blurs asset ownership.

**D2 is a data change plus (optionally) one resolver branch — the branch
needs a reachability fix.** Reclassifying `never` → `unsupported` is a pure
edit of the classification tables and stays the scan panel's/report's single
source of truth for the *static* view (a template can't know ahead of time
whether a given key has a configured alias without an async probe — same
limitation as the deferred scan-time include probing below). But
`resolvePlaceholders` (`resolver.ts:332`, `:473`) short-circuits on
`cls.status !== "supported"` in BOTH the needs-loop and the resolve-loop,
*before* `resolveOne` is ever reached (verified) — so as literally described
in an earlier draft, a `$scroll.metadata` occurrence classified
`unsupported` (which it always is, alias or not) would never reach the
bridge fetcher at all, making the described behavior unreachable. The fix:
both loops gain one **named exception**, checked before the generic
`cls.status !== "supported"` skip — `cls.base === "$scroll.metadata" &&
ctx.metadataAliases?.[key(raw)]` routes to `needsContentProperty = true` /
a dedicated resolve branch instead of the unsupported short-circuit, while
the classification itself (and therefore the scan panel) is untouched. The
bridge adds one lazily-invoked `ResolveDeps` fetcher (`getContentProperty`)
and this one resolver branch; alias mappings are host-supplied plain data.
Given the added complexity this fix implies (plus the config/CLI/extension
gaps below), shipping only the reclassification and cutting the bridge to a
dedicated follow-up remains the recommended default — see Tasks and the new
Risk entry.

Classification stays the single source of truth: the scan panel (✓/⚠/✗ per
row), the resolver, and the export report all read `classifyPlaceholder`, so
both changes surface everywhere at once with no host UI work.

### Outlook — D4: PDF placeholder system

D1/D2 deliberately land in the shared classification/parsing layer that D4
(BASELINE-DESIGN §4 D4) will eventually lift into a shared package so the PDF
engine's header/footer/cover slots consume the *same* grammar (one
vocabulary, two resolution times: TS-resolved strings vs. layout-time
tokens). Nothing in this plan may bind against DOCX-only assumptions in
`placeholder-map.ts` — parsers stay pure string→struct functions. The PDF
side of `$scroll.includepage` is explicitly *reserved but not implemented*
here.

**Corrected — D4 has no real owner or folder yet; an earlier draft's claim
that it "arrives with the template system planned in folder
`specs/export-expansion/007-*`" is factually wrong, verified against two
independent sources**: `UMSETZUNGSPLAN.md`'s own Phase-4 backlog table
explicitly parks "D4 PDF-Platzhaltersystem" under "bewusst auf 'Later'
gesetzt" (T4.9) — the opposite of being scheduled into 007 — and
`specs/export-expansion/007-pdf-template-settings/PLAN.md` scopes itself to
T2.1–T2.4 (settings threading, Level-A settings, watermark, template
library) and *explicitly excludes* `packages/docx` and any placeholder work
("`packages/docx` is **not** modified here", that plan's Architecture
section). Neither the package extraction (`packages/export-placeholders`)
nor the new client methods this plan's D1 doesn't already add have an owner.
Until a real folder exists, this outlook is a statement of intent, not a
committed handoff — see `crossPlanImpacts` for the correction this implies
for `UMSETZUNGSPLAN.md`/007.

### Outlook — D5: report behavior

The new note codes introduced here (`includepage-unresolved`,
`includepage-cycle`, `includepage-invalid-context`, plus the outcome-specific
codes from the discriminated include-lookup result — see Resolver & document
pass — and the existing `placeholder-unsupported`) are meant to become part
of a stable report-code vocabulary that a future presentation-layer
filtering feature (`filterNotes`, per-code mute) could build on.

**Corrected — same D4 problem: D5 is not actually planned in folder
`specs/export-expansion/007-*` either** (verified: no mention of
`filterNotes`, note filtering, or D5 anywhere in that folder's PLAN.md).
Consequence for THIS plan, which does not change: the engine always emits
the full `ExportNote[]`, no suppression logic lands here, and note `code`
strings are chosen once and treated as public contract — but readers should
not infer a committed downstream consumer from this section; none exists
yet.

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

- [ ] `packages/docx/src/resolver.ts`: define an `IncludeLookupOutcome`
      discriminated union — corrected from an earlier draft where
      `getIncludedPage` returned bare `ConfluencePageDetails | null`, which
      conflated "not found", "no permission", "auth failure", "rate-limit
      exhausted", and "transient network/5xx failure" into one indistinguishable
      `null` (verified against `client.ts`'s `request()`: 403/404 throw
      `"Confluence API error (404): …"`, 429-after-retries throws the
      differently-worded `"Rate limited by Confluence API after N retries"`,
      5xx-after-retries throws `"Confluence API error (5NN): …"`, and a raw
      network failure throws whatever `fetch` throws — none of these carry a
      typed status field, but they ARE textually distinguishable, so
      "not found or no permission" is honest only for the 403/404 case):
      ```ts
      export type IncludeLookupOutcome =
        | { kind: "resolved"; page: ConfluencePageDetails }
        | { kind: "ambiguous"; count: number }
        | { kind: "not-found-or-forbidden" }
        | { kind: "auth-failed" }
        | { kind: "rate-limited" }
        | { kind: "transient-error"; message: string };
      ```
      Extend `ResolveDeps` (line 64) with the D1 seam:
      `getIncludedPage?: (ref: IncludePageRef) => Promise<IncludeLookupOutcome>`.
      Document that, like `getSpaceLogo`, it is consumed by the export
      orchestrator's include pass, not by the text resolver; it lives here so
      hosts wire every per-site round-trip through one deps bag. Only
      genuine 403/404 collapse into `"not-found-or-forbidden"` (Cloud makes
      them indistinguishable, so no false precision is invented there); every
      other class stays distinct so the report gives actionable guidance
      instead of blaming the page. An `AbortError` (host-initiated
      cancellation, if any host supports it) is rethrown, never swallowed
      into an outcome.
- [ ] `packages/docx/src/resolver.ts`: keep the text path safe for the new
      supported base — `resolveOne`'s `default:` branch already returns `""`
      for bases it has no case for; confirm `$scroll.includepage.*` neither
      triggers any fetch in `resolvePlaceholders`' needs-loop (line 332) nor
      appears in `unsupportedNames`, and that a surviving token (pass skipped,
      failed, or left non-atomic by the paragraph-context check below) is
      blanked by `preprocessScrollText`. Add a case comment mirroring the
      logo/content treatment.
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
      - **atomic-paragraph check (new — see Architecture)**: compare the
        regex match against the paragraph's full trimmed text. Not equal ⇒
        note `includepage-invalid-context` ("include token shares a
        paragraph with other text; only a paragraph whose sole content is
        the include token is expanded — leave it on its own line"), leave
        the token in place (it blanks via step 4, no OOXML swap attempted),
        and skip the rest of this occurrence's steps below entirely (no
        fetch);
      - per occurrence `i`: `parseIncludePageArgs` → invalid args ⇒ note
        `includepage-unresolved` ("names no page"), skip (token blanks);
      - **self-include only (corrected — see Architecture for why a
        broader "any repeat" guard contradicted this plan's own body+header
        test)**: before fetching, if `ref` is a `pageId` ref equal to
        `input.details.id`, or (after a title/space ref resolves) the
        fetched page's id equals `input.details.id`, note
        `includepage-cycle` (`"page cannot include itself; rendered
        empty."`), skip. No other repeat is blocked;
      - fetch via `deps.getIncludedPage?.(ref)`, deduplicated by a
        `Map<pageId | "title:<space>:<title>", Promise<IncludeLookupOutcome>>`
        keyed on the ref's canonical form, run through a bounded pool
        (reuse the `pLimit(ASSET_FETCH_CONCURRENCY)` shape at `export.ts:598`,
        same cap of 6) so a template with many unique include targets neither
        serializes to N round-trips nor fans out unbounded against
        Confluence — missing dep ⇒ treat as `"transient-error"`;
      - translate the outcome to a note and skip (token blanks) for every
        non-`"resolved"` kind: `"ambiguous"` ⇒ `includepage-ambiguous-title`
        naming the count (still resolves the deterministic first hit — see
        Host wiring — so this note is informational, not a skip);
        `"not-found-or-forbidden"` ⇒ `includepage-unresolved` with the
        existing honest combined wording; `"auth-failed"` ⇒
        `includepage-auth-failed` ("authentication failed while fetching the
        included page; check the export credentials"); `"rate-limited"` ⇒
        `includepage-rate-limited` ("Confluence rate-limited the include
        fetch; rendered empty — retry the export"); `"transient-error"` ⇒
        `includepage-transient-error` carrying the outcome's `message`;
      - **budget guard**: if the number of *unique* resolved target pageIds
        exceeds 25, or their cumulative `storage` byte length exceeds 2 MiB,
        stop fetching further NEW unique targets (already-fetched/cached
        targets keep rendering), note `includepage-budget-exceeded` once
        with the counts, and treat every occurrence past the budget as
        unresolved (token blanks). Both thresholds are a deliberate,
        documented v1 guess — revisit on a real large-template report;
      - render (once per unique, budget-accepted pageId — reused via the
        cache for every occurrence of that id): `storageToBlocks(page.storage
        ?? "")` → collect walk notes → `serializeBlocks(blocks, { styleNames,
        images: imageSeamForIncludedPage, diagrams: diagramSeamForIncludedPage
        })`; **the image/diagram seams are constructed PER OCCURRENCE, not
        per pageId** (corrected — see Architecture): `imageSeam(embedder,
        assets, page.id, timings, occ.part)` / `diagramSeam(embedder,
        rasterizer, diagramTheme, timings, occ.part)`, threading the
        occurrence's own target part so an attachment referenced by an
        included page embeds its relationship into THAT part's `.rels`
        (`word/document.xml.rels`, `word/header1.xml.rels`, …), never
        defaulting to `word/document.xml.rels` regardless of destination —
        sharing the export's one `ImageEmbedder` so relationship and drawing
        ids never collide across parts; store the rendered OOXML under
        rawxml key `scrollInclude${i}` (one entry per occurrence, even
        when the underlying pageId is shared — the swapped-in text differs
        only in which relationships each occurrence's part owns);
      - swap the occurrence paragraph for
        `<w:p><w:r><w:t xml:space="preserve">${DELIM_START}@scrollInclude${i}${DELIM_END}</w:t></w:r></w:p>`
        (the free-tier rawxml module requires the tag to be the paragraph's
        sole content — same contract as `CONTENT_TAG_PARA`, line 166; this
        is now guaranteed by the atomic-paragraph check above, not assumed);
      - return the `Map<string, string>` of rendered OOXML.
- [ ] `packages/docx/src/export.ts`: thread the include map into rendering —
      `renderContent(zip, bodyXml, includes)` (line 371) renders
      `doc.render({ [CONTENT_KEY]: bodyXml, ...Object.fromEntries(includes) })`.
      Extend the `ensureCodeStyle` trigger (line 308) to also check the
      include OOXML for `CODE_STYLE_ID`, and confirm included-image skip notes
      flow into the `skippedImages` tally (line 318, they share the note
      codes). Add an `includeFetchMs` leg to `ExportTimings`/`timingNote` so a
      slow include names itself in the perf note.
- [ ] `packages/docx/src/resolver.ts` (D2 bridge, optional scope — see
      Architecture for the reachability fix this requires):
      - `getContentProperty?: (pageId: string, key: string) => Promise<{ value:
        string; stringified: boolean } | null>` on `ResolveDeps` — corrected
        from a plain `Promise<string | null>` return, which loses whether a
        non-string content-property value was JSON-stringified before the
        resolver sees it, and the resolver needs exactly that fact to decide
        whether to attach the "JSON value stringified" info note;
      - `metadataAliases?: Record<string, string>` (key → content-property
        key) on `ExportInput`/`ResolveContext` plumbing;
      - in `resolvePlaceholders`'s needs-loop (line 332) and resolve-loop
        (line 473), add the named exception described in Architecture:
        `cls.base === "$scroll.metadata"` with a configured alias for that
        occurrence's key routes to `needsContentProperty = true` / a
        dedicated resolve branch *before* the generic
        `cls.status !== "supported"` skip — without this the branch below
        is unreachable, since `$scroll.metadata` stays classified
        `unsupported` regardless of alias configuration;
      - resolve via the fetcher (lazy: fire only when an aliased occurrence
        exists), count as resolved, attach the stringified-info note only
        when `stringified === true` (consistent with the open
        `$scroll.jsoncontentproperty` stance); no alias ⇒ today's unsupported
        path with the new reason.
      - **Recommendation unchanged from an earlier draft, strengthened by the
        gaps above plus the missing config/CLI/extension plumbing found below
        (Host wiring)**: ship the reclassification alone (T1.12's "S" scope)
        by default; only take on the bridge in the same PR if there is
        headroom, and if so, land the config/CLI tasks in the same commit —
        landing the resolver branch without a way for any host to actually
        set `metadataAliases` ships dead code. There is currently no
        confirmed owner for a bridge follow-up (see the corrected D4/D5
        outlook above) — if cut, say so explicitly in the PR rather than
        pointing at a folder that doesn't cover it.
- [ ] `packages/confluence/src/client.ts` (only with the D2 bridge): add
      `getContentProperty(pageId, key)` on `requestV2` (line 376) per the
      BASELINE D4 sketch (`GET /api/v2/pages/{id}/properties?key=…`, first
      result's value; non-string values JSON-stringified, returning
      `{ value, stringified }` to match the corrected port shape above).
- [ ] `packages/confluence/src/client.ts`: add a new **exported**, pure
      `escapeCqlValue(value: string): string` helper (not the private,
      incomplete `apps/cli/src/commands/search.ts:227–232` one — see
      Reference) that escapes `\` and `"` per CQL string-literal rules and
      rejects/normalizes embedded CR/LF. Used by D1's title-form include
      lookup (both CLI and extension, see Host wiring) and available for
      `apps/cli/src/commands/search.ts` to adopt later (not required by this
      plan, but the whole point of exporting it). **Coordinate with
      002-scope-orchestration**: its label-filter task (`tree-fetch.ts`,
      "shared CQL-literal builder" for `id in (...) and label in (...)`)
      needs the same escaping. Per `UMSETZUNGSPLAN.md`'s lane table, 005 is
      startable immediately while 002 starts only after 001 merges, so in
      practice 005 lands first and is the default owner exporting
      `escapeCqlValue` from `client.ts`, with 002 importing it — but if 002
      happens to land first anyway, it exports the helper instead and 005
      imports it; either order is fine, but whichever folder's PR merges
      second must grep for the other's helper before adding a second
      CQL-literal helper in the same file.
- [ ] `packages/core/src/config.ts` (D2 bridge, optional scope, only if the
      bridge ships in this PR): add `metadataAliases?: Record<string,
      string>` to `Config` (top-level, mirroring `flags`/`storage`) so
      `~/.atlcli/config.json` has somewhere to hold alias mappings; document
      the shape in the same place as the other config sections.
- [ ] `apps/cli/src/commands/config.ts` (D2 bridge, optional scope): extend
      `isValidKey` (line ~199) with `^metadataAliases\.[A-Za-z0-9_-]+$` and
      `setNestedValue`/`getNestedValue`/`deleteNestedValue` already handle
      arbitrary dotted paths generically, so `config set
      metadataAliases.docNumber my-content-property-key` works once the key
      pattern is allow-listed — today it is rejected by `isValidKey` (only
      `global.*`/`logging.*`/`profiles.<name>.*` are valid, verified). No
      bridge without this: `metadataAliases` has no other configuration
      surface today. Extension persistence/UI is explicitly deferred — CLI
      config file only in v1 (document this as an open question, see Risks).

### Host wiring

- [ ] `apps/cli/src/commands/export.ts` (deps bag, lines 841–863): implement
      `getIncludedPage(ref): Promise<IncludeLookupOutcome>`:
      - `ref.pageId` → `client.getPage(id)` (`client.ts:510`; returns
        `storage` — sufficient, the pass only needs id/title/storage);
      - title form → `client.search(cql)` (`client.ts:636`) with
        `type = page and space = "<KEY>" and title = "<Title>"`, values built
        with the new shared `escapeCqlValue` (see Resolver & document pass —
        **not** hand-rolled quote-escaping) — `ref.spaceKey ?? page.spaceKey`
        fills the bare-title form; results sorted by id for determinism;
        zero hits ⇒ `{ kind: "not-found-or-forbidden" }`; more than one hit
        ⇒ fetch the first (sorted) hit and return
        `{ kind: "ambiguous", count }` (still resolves — see Resolver);
        exactly one hit ⇒ fetch via `getPage` and return
        `{ kind: "resolved", page }`;
      - **corrected — no longer a blanket "any 4xx/5xx → null"**: catch the
        thrown `Error`, classify its message (`client.ts`'s `request()` has
        no typed status field — see Reference) —
        `/Confluence API error \(40[13]\)/` ⇒ `"not-found-or-forbidden"`,
        `/Confluence API error \(401\)/` ⇒ `"auth-failed"`,
        `/^Rate limited by Confluence API/` ⇒ `"rate-limited"`, anything else
        (5xx after retries, network failure) ⇒
        `{ kind: "transient-error", message: err.message }`; an `AbortError`
        is rethrown, not caught;
      - memoize per ref (canonical `pageId` or `space:title` key) like the
        existing `spaceInfo`/`currentUser` promises so repeated refs cost one
        round-trip, and cap concurrent lookups with the same bounded pool the
        engine's include pass uses (see Resolver & document pass) — or
        simply let the engine-side pool own the only concurrency limit and
        keep this loader concurrency-agnostic; pick one and say so in the
        implementation comment so the two don't double-throttle silently.
- [ ] `apps/extension/utils/docx/export-deps.ts` (**corrected — the target
      API in an earlier draft, `buildResolveDeps`, does not exist**; the real
      surface is `ExportDependencyLoaders` / `prepareExportDeps` /
      `scanDependencies`, verified against `export-deps.ts:6–13, 34–53,
      80–121` and the only callsite,
      `apps/extension/entrypoints/sidepanel/TemplateSection.tsx:244–251`):
      - add `getIncludedPage(ref): Promise<IncludeLookupOutcome>` to the
        `ExportDependencyLoaders` interface (a fifth loader, alongside
        `getSpaceWithIcon`/`getCurrentUser`/`getPageOwner`/
        `getSpaceHomepageStorage`);
      - wire it straight through in `prepareExportDeps`'s returned `deps`
        object (mirroring `getSpace`/`getCurrentUser` today) — unlike the
        other four loaders, it is **not** gated by `scanDependencies`'
        pre-start logic (that function decides which SINGLE, space-level
        round-trip to pre-start eagerly; `getIncludedPage` is called
        per-occurrence with dynamic refs discovered only inside the engine's
        include pass, so it stays lazy and uncalled until the pass actually
        invokes it — no pre-start branch to add);
      - `TemplateSection.tsx:244–251`: add a fifth loader to the
        `prepareExportDeps(...)` call, built on the same session-fetch
        `client` already in scope there (id → `client.getPage`, title →
        CQL search via `client.search` + the shared `escapeCqlValue`),
        memoized per ref, translating thrown errors into
        `IncludeLookupOutcome` the same way the CLI loader does;
      - extend `apps/extension/tests/docx/export-deps.test.ts` (existing
        file, real in-memory loader functions per that file's own
        convention) with `getIncludedPage` present/absent cases and a
        `scanDependencies` regression pinning that it does **not** gain an
        `includePage` entry (D1 is a document pass, not a resolver
        dependency — see Classification & parsing);
      - per `UMSETZUNGSPLAN.md:111–115, 174–177`, add one Lane-D case to the
        browser conformity harness (`apps/browser-export-harness`, T4.6) once
        that harness exists, proving the extension path renders an include
        identically to the CLI path — flag as a follow-up if the harness
        isn't ready when this plan lands, don't block on it.
- [ ] Scan-side UX note (defer, document only): probing include targets at
      scan time (✓ resolvable / ⚠ not found in the panel) requires an async
      scan seam — out of scope here; the scan shows the row as supported and
      the export report carries the truth. Record in
      `docs/reference/` placeholder table.
- [ ] `apps/cli/src/commands/export.ts` (JSON report, line 886 — **new task,
      not present in an earlier draft despite that draft's own Reference
      section flagging the gap**): the `--json` report currently maps every
      `ExportNote` to a bare `"${level}: ${message}"` string, discarding
      `code` — making this plan's own E2E assertions (`--json` containing
      `includepage-cycle`, see Tests) unverifiable as written, since the
      code string doesn't appear anywhere in the note's `message` text.
      Fix, additive and backward-compatible: keep `report.notes: string[]`
      exactly as today (any existing consumer/snapshot keeps working), and
      add a new parallel field `report.noteDetails:
      Array<{ level: string; code: string; message: string }>` sourced
      directly from `report.notes` (the engine's `ExportNote[]`) — `cliNotes`
      (host-generated, code-less warnings pushed before the engine runs,
      e.g. line 760/829) are NOT part of `noteDetails`, only genuine
      `ExportNote`s are. Add a schema/snapshot test
      (`apps/cli/src/commands/export.test.ts` or equivalent) asserting both
      fields are present and in sync, so a future report-shape change can't
      silently drop `code` again.
- [ ] `docs/` update (workflow rule "docs are first-class"): placeholder
      reference table row for `$scroll.includepage` — argument forms with
      type/constraints, one minimal and one realistic example (imprint page in
      a header, referenced from both body and header), troubleshooting
      entries for every new note code (`includepage-unresolved`,
      `includepage-cycle`, `includepage-invalid-context`,
      `includepage-ambiguous-title`, `includepage-auth-failed`,
      `includepage-rate-limited`, `includepage-transient-error`,
      `includepage-budget-exceeded`); update the `$scroll.metadata` row to
      the new wording (+ `metadataAliases` config documentation for CLI
      `~/.atlcli/config.json`, including the `config set metadataAliases.<key>
      <content-property-key>` form, if the bridge ships — explicitly note
      the extension has no equivalent UI yet if that's the case at ship
      time); document `report.noteDetails` as a stable, additive `--json`
      field.

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
      - (bridge, if shipped) **reachability regression** — this is the test
        that would have caught the earlier draft's unreachable-branch bug:
        with `metadataAliases: { docNumber: "doc-number" }` set and an
        in-memory `getContentProperty` closure backed by a plain map, assert
        the closure IS called and the value resolves — not just that it
        *would* resolve in isolation, but that it survives the
        `cls.status !== "supported"` short-circuit in both the needs-loop and
        resolve-loop; a second case with no alias configured confirms the
        fetcher is **not** called (lazy) and the unsupported path still
        fires; JSON value → `{ value, stringified: true }` → stringified text
        + info note; plain string → `{ value, stringified: false }` → no
        extra note.
- [ ] `packages/docx/src/export.test.ts` — document-pass tests on real docx
      fixtures (`buildDocx`/`para`/`runSplitPara`/`readPart`/
      `assertBalancedXml`), with `getIncludedPage` as a plain function
      returning fixture `IncludeLookupOutcome` values (real closures, no
      mocking):
      - body **and header, same target** (the plan's own disclaimer/imprint
        use case — corrected from an earlier draft where the strict global
        cycle guard would have silently blanked the second occurrence,
        contradicting this exact assertion): template with
        `para("$scroll.includepage.(ENG:Imprint)")` in `body` and `header`;
        assert the sentinel text appears in **both** `word/document.xml` and
        `word/header1.xml`, both parts balanced, `getIncludedPage`/
        `storageToBlocks` called exactly ONCE for the shared pageId (cache
        hit on the second occurrence), and **no `$scroll.` literal survives
        anywhere** (extend the existing pinning loop);
      - repeat **within the same part**: two occurrences of the same include
        in the body ⇒ both render, one fetch;
      - run-split token (`runSplitPara(["$scroll.includepage.", "(ENG:Imprint)"])`)
        is still found and replaced;
      - non-atomic paragraph: `para("See our disclaimer: $scroll.includepage.
        (ENG:Imprint)")` (prefix text) and a paragraph with **two** include
        tokens ⇒ neither is expanded to OOXML, the surrounding text
        (`"See our disclaimer: "`) survives verbatim in the output, the
        token itself is blanked, and `includepage-invalid-context` is noted
        — the regression test for silent paragraph-content loss;
      - unresolved: `getIncludedPage` returning each of
        `{ kind: "not-found-or-forbidden" }`, `{ kind: "auth-failed" }`,
        `{ kind: "rate-limited" }`, `{ kind: "transient-error", message }`
        (and a case with the dep absent) ⇒ output contains no literal in
        every case, and the report carries the matching distinct note code
        (`includepage-unresolved` / `includepage-auth-failed` /
        `includepage-rate-limited` / `includepage-transient-error`) — the
        regression test for the "every failure looks like a permission
        problem" bug;
      - ambiguous: `{ kind: "ambiguous", count: 2 }` ⇒ the resolved page
        still renders, `includepage-ambiguous-title` notes the count;
      - self-include only: an include ref resolving to the exported page's
        own id ⇒ blanked, `includepage-cycle`; a **non-self** repeated
        target (see body+header above) must NOT trigger this code — assert
        the negative explicitly;
      - header/footer image and diagram relationships (the regression test
        for the dangling-relationship bug): included page in the **footer**
        whose storage references an attachment image AND a mermaid diagram,
        with a real in-memory `AssetFetcher`/`SvgRasterizer` ⇒ the embedded
        `r:embed` relationship exists in `word/footer1.xml.rels` (not
        `word/document.xml.rels`), `assertBalancedXml` passes on
        `word/footer1.xml`, and a same-fixture image on the exported page's
        own body still lands in `word/document.xml.rels` with no id
        collision between the two;
      - asset ownership (main-body include, existing case, kept): included
        page whose storage references an attachment image, with a real
        in-memory `AssetFetcher` serving `pngFixtureBytes(…)` keyed by
        requested URL ⇒ the fetched ref carries the **included** page's id,
        the media part and relationship exist in the output, and drawing ids
        don't collide with an image on the exported page itself;
      - code style: included page with a code macro ⇒ `ensureCodeStyle` fired
        (style present in `word/styles.xml`);
      - budget: a fixture with more than 25 distinct include refs ⇒ the
        first 25 unique targets render, later ones note
        `includepage-budget-exceeded` and blank, and a repeat of an
        already-fetched target past the cutoff still renders (cache, not a
        hard stop).
- [ ] `packages/confluence/src/client.test.ts` (or equivalent) — new
      `escapeCqlValue` table: quotes, backslashes, embedded CR/LF, empty
      string, unicode/emoji titles, and the exact resulting CQL clause for a
      representative `title = "…"` construction (pin the literal output, not
      just "no exception").
- [ ] `apps/cli/src/commands/export.test.ts` (or equivalent) — JSON report
      schema/snapshot test: `report.notes` (strings) and `report.noteDetails`
      (`{level, code, message}[]`) are both present, same length, and
      `noteDetails[i].message` matches the tail of `notes[i]`; `cliNotes`
      (host warnings) appear in `notes` but never in `noteDetails`.
- [ ] E2E (workflow rule; profile `mayflower`, space `DOCSY`, built CLI
      `bun ./dist/index.js`, pattern: `scripts/e2e-template-test.sh`):
      - [ ] create an include-target page in DOCSY with unique sentinel
            content (`atlcli` page create / API), and a small bun script using
            `packages/docx/src/fixtures.ts` builders to produce a template
            containing `$scroll.includepage.(DOCSY:<title>)` in **body and
            header** (same target, per the corrected cycle behavior above)
            plus `$scroll.content`;
      - [ ] `atlcli wiki export <pageId> -t <template> -o out.docx --engine ts
            --json`: unzip and assert the sentinel appears in
            `word/document.xml` and `word/header1.xml`, and no `$scroll.`
            literal survives; assert `report.noteDetails` is present in the
            `--json` output;
      - [ ] cycle path: template including the exported page itself → report
            (`--json`) `noteDetails` contains an entry with
            `code: "includepage-cycle"`, export still succeeds;
      - [ ] permission path: include a DOCSY page carrying view restrictions
            the `mayflower` profile's token user cannot read, assert blank
            output + `includepage-unresolved` in `noteDetails`. If no such
            restricted page can be provisioned with this profile's rights,
            fall back to a nonexistent title (same code path by design:
            Cloud 403 ≡ 404) and record the restricted-page case as a
            **documented manual check** in the PR description;
      - [ ] cleanup: delete every created test page and temp template/output
            file (workflow rule).
- [ ] `bun run typecheck` and full `bun test` green before push (workflow
      rules; regression tests above double as the mandated bug-prevention
      tests for the reclassification, the never-a-literal invariant, the
      body+header duplicate-include fix, the header/footer relationship fix,
      the non-atomic-paragraph fix, and the JSON report code fix).

## Definition of Done

- `$scroll.includepage.(Title|SPACE:Title|pageId)` renders the referenced
  page's body at the placeholder position in body, header, and footer parts,
  in CLI and extension (further hosts: by wiring one optional fetcher on the
  real `ExportDependencyLoaders`/`prepareExportDeps` surface, not an
  imagined one).
- The **same** include target referenced more than once (body+header,
  header+footer, or twice in one part) renders in **every** occurrence,
  fetched and walked once and cached; only a page including **itself**
  blanks with `includepage-cycle`.
- A paragraph whose visible content is the include token AND other text
  renders the OOXML swap for **neither**; the surrounding text survives
  verbatim and `includepage-invalid-context` is noted — no silent
  paragraph-content loss.
- Included pages' attachment images and diagrams embed into the **target
  part's own** relationships file (`word/document.xml.rels`,
  `word/header1.xml.rels`, `word/footer1.xml.rels`, …, matching where the
  include actually landed) — never a dangling relationship in any part
  (the 004-F3 invariant holds on every branch, including header/footer
  includes).
- Every include-lookup failure class (not-found-or-forbidden, auth-failed,
  rate-limited, transient-error, ambiguous) renders blank (except
  `ambiguous`, which still resolves) with its own distinct note code — no
  class is misreported as a permission problem it isn't; Cloud's genuinely
  indistinguishable 403/404 stay one honest combined message.
  **No `$scroll.*` literal can survive on any path** (pinning tests
  extended).
- Include fetches run through a bounded concurrency pool and a documented
  per-export budget (unique-target count, cumulative storage size); exceeding
  it degrades deterministically with `includepage-budget-exceeded`, never an
  unbounded fan-out against Confluence.
- `$scroll.metadata.*` scans as ⚠ `unsupported` with the new actionable
  reason; nothing regresses to a literal. (If the bridge shipped: an aliased
  key actually reaches the fetcher — verified by the reachability regression
  test, not assumed — and resolves from a content property, lazily; CLI
  `config set metadataAliases.<key> <value>` works.)
- Scan panel, resolver, and report all reflect the new classifications with
  zero host-specific special cases (classification remains the single source
  for the *static* view; the metadata bridge's per-export resolution
  override is documented as the one deliberate, narrowly-scoped exception).
- The CLI `--json` report exposes note `code`s (`report.noteDetails`,
  additive, backward-compatible) so this plan's own E2E acceptance criteria
  are actually checkable from the command line.
- `packages/confluence`'s CQL escaping for the title-form include lookup goes
  through one shared, exported, tested `escapeCqlValue` — not a
  hand-rolled or duplicated quote-escaper.
- Unit + document-pass tests (no mocking) green, `bun run typecheck` clean,
  E2E on DOCSY executed and test resources cleaned up.
- `docs/` placeholder reference updated in the same PR (reference-table row
  with forms/constraints, minimal + realistic example, troubleshooting
  entries for every new note code); note codes documented as stable.

## Risks & open questions

- **Titles containing `)`** — `PLACEHOLDER_RE` (scan.ts:68) stops the argument
  group at the first `)`, so such titles cannot be referenced by title.
  Documented limitation; workaround: the `(pageId)` form. Not worth a grammar
  change in v1.
- **Bare-title colon ambiguity** — `(A: B)` parses as space `A`, title `B` by
  the first-colon rule; a same-space page literally titled "A: B" must use the
  explicit `(SPACE:A: B)` form. Pin the chosen behavior in the parser table
  test; revisit only if real templates trip on it.
- **Duplicate includes — resolved, no longer an open question.** An earlier
  draft's global visited-set treated a second include of the same page (in
  ANY part) as a cycle, which directly contradicted this plan's own
  body+header test requirement — the exact "same disclaimer in header *and*
  footer" use case named in Goal & user value literally cannot be satisfied
  by a guard that blanks the second occurrence. Decision: block only
  self-include; cache the fetch and the rendered OOXML per pageId so every
  other repeat renders (see Architecture, Resolver & document pass, Tests).
  Revisit only if a real template needs true nested-include cycle detection
  (not possible in v1 regardless — included content is never re-scanned for
  further tokens).
- **Title lookups are not unique** — CQL can return several pages for one
  title. v1: deterministic first hit (sorted by id) + `includepage-
  ambiguous-title` note naming the count, as its own distinct code (not
  folded into the generic unresolved note — see Resolver & document pass).
- **Heading collision** — an included page starting at H1 lands mid-flow.
  v1: include unchanged and note it; heading-offset harmonization belongs to
  the chapter-compose work (folder 001/A4), not here.
- **Permission wording, narrowed** — Cloud 403/404 are genuinely
  indistinguishable; we still commit to one honest combined
  `includepage-unresolved` message for that pair specifically. Every other
  failure class (auth, rate-limit, transient/5xx/network) now gets its own
  distinct code instead of being folded into the same "not found or no
  permission" message (corrected from an earlier draft that folded ALL
  throws into one message, which would misreport e.g. a transient network
  blip as a permissions problem). E2E's restricted-page leg may only be
  checkable manually (see task).
- **`packages/docx/src/export.ts` is a three-lane hot file, not this plan's
  alone** — verified against `specs/export-expansion/003-content-features/
  PLAN.md` (`injectContentTagAtEnd`) and `specs/export-expansion/
  004-macro-renderer/PLAN.md` (macro-resolver hook "directly after
  `storageToBlocks`, line 235"), neither of which `UMSETZUNGSPLAN.md`'s
  "two hot files" summary lists. This plan's own edits are additive
  (new functions, one new call site — see Dependencies), so a *textual*
  conflict is unlikely; rebase discipline still applies whenever 003 or 004
  merges around the same time.
- **The include pass has its own, second `storageToBlocks` call site that
  003's and 004's hook-in tasks don't know about.** `004-macro-renderer/
  PLAN.md` wires its async macro-resolver pass into exactly ONE call site
  (`exportDocx`'s main-body `storageToBlocks`, line 235) — not into D1's
  `runIncludePass`'s own `storageToBlocks(page.storage ?? "")` call, which
  didn't exist when that plan was written. Left unaddressed, an included
  page would silently skip Lane C's `scroll-only`/`scroll-ignore` exporter-
  sensitive handling and Lane E's macro registry (Jira tables, draw.io,
  export_view fallback) even after both lanes land — a permanent,
  easy-to-miss quality gap between main-page and included-page content that
  runs counter to this plan's own Goal ("consumed identically by CLI,
  extension, and further hosts") and to competing head-to-head with Scroll
  Word/PDF Exporter on macro fidelity. This plan does not fix it (003/004
  aren't done yet, and speculatively wiring a hook that doesn't exist yet
  isn't buildable) — flagged here as a concrete, named follow-up so it isn't
  lost: whichever of 003/004 lands second must add the same hook-in call to
  `runIncludePass`'s `storageToBlocks` invocation, with an integration test
  proving parity (an included page containing a `scroll-only`/`-ignore`
  macro or one Jira/draw.io macro behaves identically whether it's the
  exported page or an included one). See `crossPlanImpacts`.
- **Include-fetch budget is a v1 guess, not measured** — the 25-unique-target
  / 2 MiB cumulative-storage caps (Resolver & document pass) are a
  documented placeholder, chosen for parity with the existing
  `ASSET_FETCH_CONCURRENCY = 6` precedent rather than from a real large-
  template measurement. Revisit alongside T4.3's benchmark suite once it
  exists.
- **D2 bridge reachability and plumbing were previously underspecified** —
  an earlier draft described alias resolution that could never run (the
  classification-driven `unsupported` short-circuit in `resolvePlaceholders`
  pre-empts it), returned a port shape (`Promise<string | null>`) that loses
  whether a value was JSON-stringified, and had no `Config`/CLI surface to
  actually set `metadataAliases` (`isValidKey` in `apps/cli/src/commands/
  config.ts` allow-lists only `global.*`/`logging.*`/`profiles.<name>.*`
  today — verified). All three are fixed in the tasks above; given the
  combined size of the fix, cutting the bridge and shipping only the
  reclassification remains the safer default for this PR (see Resolver &
  document pass). If cut, there is currently **no confirmed owner** for a
  bridge follow-up — an earlier draft's "leave it to folder 007" pointer is
  incorrect (see the corrected D4/D5 outlook and `crossPlanImpacts`); say so
  explicitly rather than implying a handoff that doesn't exist.
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
