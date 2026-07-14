# PDF Export — typst.ts in the Offscreen Document, atlcli Standard Template

Status: **Planned**

Spec ID: `005-pdf-export`
Depends on: `003-page-detection-read-path`, `004-docx-export` Task 2 (shared `ExportBlock` intermediate model), `002-extension-workspace` Task 5 (offscreen WASM proof)
Related strategy: FAHRPLAN Phase 1 Task 1.4 · `TYPST-EXPORT-ANGLE.md` §1b, §5.2, §7.5 Schritt 4 · `EXPORT-QUALITY-ANGLE.md` §3–§5, §7 (quality proofs 1+3)
Origin: FAHRPLAN Phase 1 — "PDF-Export"

---

## 1. Overview

Secondary export path, but the one with **visible world-class potential**: compile the
detected page to PDF via `typst.ts` (Apache-2.0 WASM compiler) running in the extension's
**offscreen document**, using an **atlcli-owned standard Typst template** with embedded
open fonts — deliberately *not* a customer-template path (that's DOCX's job, per the
research verdict).

The cheap-but-decisive quality proofs from EXPORT-QUALITY §7 ship inside this spec, because
they are what turns "a PDF export" into "visibly better than Scroll":

- **beautiful-mermaid** diagrams embedded as native vector SVG,
- native **code highlighting** (Typst `raw`/syntect — no extra tooling),
- one **Tagged PDF (PDF/UA-1)** reference document with cover + bookmarks as the
  accessibility/archival proof point.

### Goals

- "Export as PDF" button in the panel: page → `ExportBlock[]` (004's walker) → Typst
  markup → offscreen compile → downloaded PDF.
- atlcli standard template (`tech-doc` flavor, single layout for the PoC): cover (title,
  space, version, date, exporter), TOC with correct page numbers (Typst computes them —
  a 🏆 over the Word path), numbered headings, header with running chapter title, footer
  with page numbers, PDF outline/bookmarks from headings, internal links.
- Confluence semantics mapped: callout boxes (styled per EXPORT-QUALITY §4 example),
  status → inline badge, code blocks with syntax highlighting + language label, tables
  with repeated headers and basic merges, images (attachment blobs), expand macro inlined.
- Open fonts bundled and embedded — **Inter** (text; weights 400/500/600) +
  **JetBrains Mono** (code; weights 400/700), per decision F2; the `atlcli.typ` template
  is designed sans-serif-only. Font files and versions are **pinned** (exact release
  recorded in the repo); **no fallback to locally installed fonts** — otherwise the 006
  quality comparison isn't reproducible. Deterministic output.
- Tagged PDF on by default (Typst ≥ 0.14); one reference export validated as PDF/UA-1.
- Compile runs off the panel thread (offscreen doc), panel shows progress and stays
  responsive; errors surface as readable messages, not hangs.

### Non-goals

- No customer .docx/.typ template support, no template upload for PDF (Phase 2's design
  system + `brand.typ` add themes; PoC ships exactly one good layout).
- No corporate font upload (Phase 2, EXPORT-QUALITY §3 strategy step b).
- No PDF/A profile selection UI — default output + the single tagged reference doc suffice.
- No multi-page/page-tree export; no PlantUML/draw.io/Gliffy embedding (v1 roadmap).
- No mermaid.js fallback for exotic diagram types (beautiful-mermaid's 6 types only;
  others render as code blocks with a report note).

---

## 2. Architecture

### 2.1 Process topology

```
side panel                     service worker              offscreen document
──────────                     ──────────────              ──────────────────
blocks = walker(storage)   ──▶ ensureOffscreen()      ──▶  typst.ts compiler (WASM)
typstSrc = serialize(blocks)   route compile-request       + bundled fonts
images fetched as blobs    ──▶ (transferables)        ──▶  vfs: main.typ, template.typ,
                                                            images/*, fonts/*
report + PDF bytes         ◀── compile-response       ◀──  PDF bytes | diagnostics
```

- **Serialization (blocks → Typst source) happens in the panel** — pure string work,
  fully unit-testable in bun without WASM.
- **Only the compile runs offscreen.** Message protocol (002's `messages.ts`) gains
  `compile-typst { files: Map<path, bytes>, mainPath }` → `{ ok, pdf } | { ok: false,
  diagnostics }`. Large payloads: images/fonts passed as ArrayBuffers (structured clone;
  measure — if cloning ~10 MB payloads is slow, switch to a Blob-URL handoff, noted as
  fallback).
- Offscreen doc initializes the typst.ts compiler once and caches it (font parsing is the
  expensive part); idle-timeout teardown after N minutes.
- **Fonts and WASM ship inside the extension** (no CDN at runtime — the privacy story
  "only `*.atlassian.net`" must hold; use the packaged compiler module, not
  `all-in-one-lite`'s CDN loading).

### 2.2 Typst template (`assets/typst/atlcli.typ`)

Single entry `#show: atlcli-doc.with(meta: (…))` providing: cover page, `outline()`,
heading numbering, running header via heading query, footer page numbers, `callout()`
(per the EXPORT-QUALITY §4 reference implementation), `status-badge()`, code block
styling, table defaults (`table.header` repeat), image figure with optional caption,
document metadata (title/author → PDF metadata, required for UA-1).

### 2.3 Block serializer

`typstSerialize(blocks: ExportBlock[], opts): { main: string, assets: AssetRef[] }` in the
extension (or `packages/confluence` if it stays dependency-free — preferred, keeps it
under the isomorphism gate and testable).

Normative mappings:

| ExportBlock | Typst |
|---|---|
| heading(n) | `#heading(level: n)[…]` (template numbers + bookmarks) |
| callout(kind, title) | `#callout(kind: …, title: …)[…]` |
| codeBlock(lang) | ` ```lang … ``` ` (native highlighting) |
| table (colspan/rowspan) | `#table` with `table.cell(colspan:, rowspan:)` |
| image(attachment) | `#figure(image("images/<n>.<ext>"), caption: alt?)` + **alt text** (UA-1 requires it; fall back to filename) |
| mermaid code block | beautiful-mermaid SVG → `image("images/dN.svg")` (vector) |
| statusBadge | `#status-badge(color:)[TEXT]` |
| link | `#link(url)[text]` |
| unknown macro | omitted + report line (never raw storage XML in output) |

Escaping is a first-class concern: Typst markup characters (`#`, `*`, `_`, `@`, `<`, `[`,
`$`, `\``) in Confluence text must be escaped — dedicated escape function with a
character-table test (this is the classic injection-bug source in markup generators).

### 2.4 Error/diagnostics model

Typst diagnostics (source spans) map back to a block index via line markers
(`// blk:<i>` comments emitted by the serializer) → panel shows "failed at: <block type>
'<heading text>'…" instead of raw Typst spans. Compile timeout (60 s hard) → readable
error + offscreen teardown.

---

## 3. Task breakdown

### Task 1 — typst.ts vendored + offscreen compile round-trip

- [ ] `@myriaddreamin/typst.ts` (+ web compiler WASM) bundled into the extension **without runtime CDN access**; build script copies WASM + font assets into `dist/`
- [ ] `compile-typst` message implemented; a hardcoded "hello world" .typ compiles to a valid PDF end-to-end (panel button in debug section) — extends 002's WASM smoke into the real thing
- [ ] Compiler instance cached across compiles (second compile measurably faster — timed assertion in manual check, logged)
- [ ] Compile error (syntactically broken .typ) returns diagnostics, panel shows readable failure; 60 s timeout enforced
- [ ] Bundle-size figure recorded (WASM + fonts) in this file — input for store-packaging sanity later

### Task 2 — Fonts

- [ ] Inter (400/500/600) + JetBrains Mono (400/700) bundled as **pinned files with recorded release versions** (version + source URL + checksum noted in `assets/fonts/README.md`)
- [ ] Compiler configured to use only the bundled fonts; a compile referencing a non-bundled font **fails loudly** rather than silently substituting (test with a deliberately wrong font name) — no local-font fallback exists in WASM, and none is added
- [ ] **Full character sets bundled for Phase 1** (incl. Latin Extended for umlauts etc.); subsetting is an explicit later optimization, not done now
- [ ] Font licenses (OFL) copied into `apps/extension/assets/fonts/`
- [ ] PDF output embeds the fonts (verify via PDF inspection in Task 6)

### Task 3 — atlcli Typst template

- [ ] `atlcli.typ` per §2.2: cover, TOC, numbered headings, running header, page-number footer, callout/status/code/table/figure helpers
- [ ] Compiles standalone with a demo document (checked into `assets/typst/demo.typ`) — the template's own regression fixture
- [ ] Document metadata (title/author/date) lands in PDF metadata

### Task 4 — Serializer

- [ ] `typstSerialize` implements the §2.3 table; unit tests per block type (string-level assertions, no WASM needed)
- [ ] Escape function with full character-table test + a hostile fixture (page text containing Typst syntax) — pinning test that output compiles and renders the text literally
- [ ] Image assets: attachment blobs → vfs paths; SVG passes through as vector; alt-text rule applied
- [ ] Mermaid: beautiful-mermaid for the 6 supported types → SVG asset; unsupported types → code block + report (tests for both routes)
- [ ] `// blk:<i>` markers emitted; diagnostic-to-block mapping unit-tested

### Task 5 — Panel flow

- [ ] "Export as PDF" on the loaded page: fetch images (session auth — mock-test credentials), serialize, compile, download `"<page-title>.pdf"`
- [ ] Progress states (fetching assets → compiling → done) rendered; panel responsive during compile (compile is offscreen)
- [ ] Export report: duration, image count, skipped/unsupported items — same report surface as 004
- [ ] Full-pipeline test with the shared 004 fixture: blocks → typst source snapshot; compile smoke where runnable (see §4 note)

### Task 6 — Quality proofs + manual E2E **[E2E: user]**

Joint session (space `DOCSY`, same feature-zoo test page as 004, delete after):

- [ ] Export the test page: cover, TOC **with correct page numbers**, bookmarks panel populated, internal TOC links click-navigate
- [ ] Callouts, status badges, tables (repeated header across a page break), nested lists render correctly
- [ ] Code block shows native syntax highlighting; a mermaid flowchart appears as crisp vector (zoom to 400% — no rasterization)
- [ ] Images embedded and positioned sanely; fonts embedded (PDF properties / `pdffonts` if available)
- [ ] **Tagged-PDF reference:** export validated as tagged (Acrobat/veraPDF or PAC if available; minimum: Typst UA-1 export mode succeeds, which validates strictly) — the reference PDF is archived in this spec dir
- [ ] Duration for the ~2,000-word page recorded (input to 006; WASM path is the slower one — this is the number that matters)

---

## 4. Test plan

- **Unit (fast, no WASM):** serializer per block type, escaping table, diagnostics mapping, template-demo source snapshot.
- **Integration:** panel flow with mocked compile responses; image-fetch credential assertions.
- **Compile-level:** if typst.ts runs under bun in CI (Node path is officially supported — probe early in Task 1), add a CI job compiling the demo doc + one fixture; otherwise compile checks are manual-E2E only and the serializer snapshots carry CI weight. Record which way it went here.
- **Manual E2E (Task 6):** visual quality, tagged-PDF validation, performance number.

## 5. Definition of done

- Tasks 1–6 checked; reference Tagged PDF archived in the spec dir.
- Whole repo green incl. `check:browser` (serializer isomorphic if placed in packages/).
- No runtime network access except `*.atlassian.net` during export (verified in 006's network-log check, pre-checked here in Task 6).
- Compile of the E2E page < 10 s target met or the measured number + analysis documented for 006's verdict.

## 6. Risks and open questions

1. **typst.ts API stability / PDF export surface** — the browser PDF path is less "advertised" than SVG/canvas (research §1b). Task 1 is deliberately first and minimal: if PDF bytes can't be produced reliably in the offscreen doc, escalate before any template work (fallback ladder: compile in a Web Worker inside the panel; server/bridge is out of scope for the PoC).
2. **WASM + fonts bundle size** (likely 10–30 MB). Fine for load-unpacked PoC; store packaging limits arrive later — recorded, not solved, here.
3. **Compile performance on big pages** — WASM is the slow path per typst.ts docs. The 006 budget check decides whether "good enough"; incremental-compile features of typst.ts are the known lever if not.
4. **UA-1 strictness can fail exports** (Typst refuses on violations, e.g. missing alt text). Default export mode stays plain tagged PDF; UA-1 is the *reference* proof. Alt-text fallback rule (§2.3) keeps the reference viable.
5. **Structured-clone payload cost** for image-heavy pages — measured in Task 5; Blob-URL handoff is the prepared fallback.
6. **`table.cell` rowspan edge cases** mirror 004's merged-cell reef; same policy: basic merges correct, deep nesting degrades with a report line.

### Decisions log

- **F1 — serializer location**: ❓ open (proposal: `packages/confluence` next to the walker, isomorphism-gated).
- **F2 — bundled font set**: ✅ (Björn, 2026-07-14; refined 2026-07-15) Inter 400/500/600 + JetBrains Mono 400/700 (OFL), files and versions pinned, no local-font fallback, full charsets in Phase 1 (subsetting later); no serif face in the PoC — template designed sans-only.
