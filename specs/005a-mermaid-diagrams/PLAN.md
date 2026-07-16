# Mermaid Diagrams — beautiful-mermaid → SVG for the DOCX and PDF export paths

Status: **Done** (2026-07-16 — engine + extension host; Word E2E passed after finding #1
(svgBlip flattening). CLI exports mermaid as source blocks until a Node rasterizer host lands.
Open: the two spec-008 benchmark items in Task 6.)

Spec ID: `005a-mermaid-diagrams`
Depends on: `005-docx-image-module` (**must be merged** — this spec embeds SVG through the media-part/relationship/EMU plumbing 005 builds), `004-docx-export` Task 2 (the `ExportBlock` model whose `codeBlock` carries the diagram source), `004-docx-export` Task 5 (the pinned descope path this spec replaces)
Sequencing: **directly after `005-docx-image-module`** (Björn, 2026-07-16). Numbered `005a` rather than `009` because it is the natural completion of the image work, not a new phase — mermaid is "SVG → the same embed path 005 just built". Resolves spec 004 decision **F2**.
Related strategy: `~/code/rovo-skills/research/EXPORT-QUALITY-ANGLE.md` §1 (beautiful-mermaid — verified), §7 item 1 ("der günstigste sichtbare Wow-Effekt"), §6 benchmark row 9 · `007-pdf-export` §3 Task list (the PDF path consumes the same SVG natively)
Origin: spec 004 decision **F2** (2026-07-16) — mermaid deferred out of the DOCX PoC because rendering it needs the image module that F3 had already deferred to spec 005.

---

## 1. Overview

Spec 004 descoped mermaid and **pinned the fallback**: a ```mermaid block renders as an
uncolored `AtlcliCode` code block carrying its diagram source plus a
`code-highlight-skipped` report note, and emits no `<w:drawing>`/`blip`/`r:embed` — the
reader sees readable diagram source, never a broken image. This spec replaces that
fallback with real rendering for the diagram types we support, and **keeps the pinned
fallback as the route for everything else**.

The renderer is [`beautiful-mermaid`](https://github.com/lukilabs/beautiful-mermaid)
(Craft Docs / Luki Labs, MIT, v1.1.3): mermaid source → SVG string, synchronously and
without a DOM. One rendered SVG serves **both** export paths:

```
codeBlock{language: "mermaid"}  (from the Confluence code macro — already modelled)
  → renderDiagram(source, theme)          // beautiful-mermaid, sync, headless
  → SVG string
      ├─ DOCX (this spec): svgBlip + PNG@2x fallback, embedded via 005's image module
      └─ PDF  (spec 007):  native vector, no rasterization
  → unsupported type / render error → the 004 pinned code-block path + report note
```

### What this spec must prove

1. **The diagram renders** — the 6 supported types produce correct SVG in the MV3 side panel.
2. **Word shows it** — svgBlip with a mandatory PNG@2x fallback, through 005's plumbing, at
   sane size, with no dangling relationship on the failure branch.
3. **Everything else degrades exactly as today** — an unsupported type or a render error
   takes the 004-pinned code-block route. The 004 pin tests stay meaningful (see Task 5).
4. **The bundle survives it** — elkjs is heavy (§2.3); the diagram path must be lazy and
   must not regress the panel's baseline load.

### Goals

- `renderDiagram(source, theme)` — a pure, synchronous, DOM-free transform, unit-testable
  in bun.
- The 6 beautiful-mermaid types render: **Flowchart, State, Sequence, Class, ER, XY-Chart**.
- DOCX embedding: SVG → `svgBlip` + PNG@2x raster fallback (both, always — §2.4).
- Diagram theme is derived from the same brand colors as the rest of the export, so
  diagrams, callouts and body text come from one color source (EXPORT-QUALITY §4).
- Unsupported types (Gantt, Pie, Mindmap, Timeline, Git-Graph, C4, Sankey, Quadrant,
  Journey, …) and render errors → the pinned code-block path + a report line naming the type.
- Lazy-loaded: no diagram code in the panel's initial bundle (the `highlight.ts` pattern).

### Non-goals

- **No mermaid.js fallback for exotic types.** EXPORT-QUALITY §1 recommends real mermaid.js
  for the types beautiful-mermaid lacks, but mermaid.js needs a DOM (→ offscreen document)
  and is a large second renderer. Exotics take the code-block path; revisit only if real
  pages demand it. Out of scope here, consistent with `007-pdf-export` §55.
- **No PDF wiring** — spec 007 owns that; this spec only guarantees the SVG string is
  produced by shared, reusable code so 007 embeds it natively.
- No diagram editing/preview UI in the panel.
- No Confluence diagram *macros* (draw.io, Gliffy, PlantUML, Mermaid-marketplace macros) —
  only fenced ```mermaid code blocks, which is what `storageToBlocks` already models.

---

## 2. Architecture

### 2.1 Verification status of beautiful-mermaid (probed 2026-07-16 — not assumed)

EXPORT-QUALITY §1 verified the library by repo inspection. That check greppped for
`node:`/`fs`/`path`/`puppeteer`/`canvas`/`jsdom`/`document.`/`window.` — it did **not**
check `eval`/`new Function`, which is precisely what ruled out `docx-templates` at the 004
Task-1 gate. Re-probed against the published tarballs; findings:

| Question | Result |
|---|---|
| Identity / license | `beautiful-mermaid@1.1.3`, **MIT**, runtime deps `elkjs ^0.11.0` + `entities ^7.0.1` |
| Own renderer? | Yes — own parser/layout/renderer/text-metrics; **mermaid.js is not a dependency** |
| `entities` collision | None — already a direct dep of `@atlcli/confluence` (the 004 entity fix) |
| **MV3 CSP (the 004 killer)** | ✅ **Clean.** `beautiful-mermaid/dist`: 0 `eval(`, 0 `new Function`, 0 DOM access |
| elkjs reachable path | ✅ Clean — see below |
| Synchronicity | `renderMermaidSVG` / `renderMermaidSync` return SVG strings with no `await` |

**The elkjs chain, in detail** (this is the part worth not hand-waving): beautiful-mermaid
does `import ELKBundled from "elkjs/lib/elk.bundled.js"` and constructs `new ELKBundled()`
**with no arguments**. In `elk.bundled.js` the `ELKNode` constructor only builds a real
`new Worker(url)` when `options.workerUrl` is passed; with no options it falls through to
`require('./elk-worker.min.js').Worker` — the **FakeWorker**, a plain JS object, not a Web
Worker. Counts on the actually-bundled files: `elk.bundled.js` → 0 `eval(`, 0 `new Function`;
`elk-worker.min.js` → 0 `eval(`, 0 `new Function`. The two `new Worker` sites in
`elk.bundled.js` sit behind the `workerUrl`/`workerFactory` guard and are unreachable on our
path. The single `new Function` hit in `elk-worker.js` is a **false positive** —
`new Function$lambda$0$Type`, a GWT-generated class name — and that file is not the one
bundled.

**Conclusion: no `'unsafe-eval'` needed.** Unlike docx-templates, beautiful-mermaid is
compatible with our MV3 CSP (`script-src 'self' 'wasm-unsafe-eval'`).

### 2.2 License — elkjs is EPL-2.0, not MIT **[decision gate M1]**

EXPORT-QUALITY §1 records beautiful-mermaid as MIT and frames the stack as permissive.
That is true of beautiful-mermaid itself, but its **runtime dependency `elkjs` is
EPL-2.0** (Eclipse Public License 2.0) — a **weak-copyleft** license, not a permissive one.
This matters here specifically because:

- the repo relicensed **MIT → Apache-2.0** on 2026-07-16 (`8e8a634`), and
- 004's F1 decision tracked license purity explicitly ("all-MIT … PizZip **elected MIT**
  from its dual license"), i.e. license posture is a decision Björn makes, not an
  implementation detail.

EPL-2.0 is *usable* here — it is not GPL, it does not reach into our own code, and it
permits distribution in object-code form inside a larger work. But it is file-level
copyleft with a source-availability obligation for the EPL-covered files, and shipping it
inside a bundled `.crx` is a distribution. **This is a Björn call at the Task-1 gate**, the
same shape as F1 — not something this spec assumes away. Options if EPL-2.0 is unwanted:
pin the fallback (mermaid stays a code block, i.e. keep 004's descope permanently), or
render diagrams server-side later (FAHRPLAN Phase 5), or accept EPL-2.0 with an attribution
note. Recommendation is to **accept** — EPL-2.0 in a dependency is routine and the
obligation is satisfied by attribution + pointing at elkjs's public source — but the call
is his.

### 2.3 Bundle weight **[Task-1 spike]**

`elk.bundled.js` is **~1.5 MB minified** (elkjs unpacked is ~8 MB; the beautiful-mermaid
tarball adds ~450 KB). This is the same shape as 004's risk 4, where the naive Shiki entry
produced "a ~10 MB output of per-language chunks" and had to be replaced with fine-grained
imports. Requirements:

- The diagram path is reached **only** through a dynamic `import()` inside the serializer,
  exactly like `highlight.ts` — a page with no mermaid block must not pay for it.
- The Task-1 spike records the real emitted chunk size and the panel's load delta, and
  checks against the Chrome Web Store package limit.

**Known bundling hazard:** `elk.bundled.js` contains `require.resolve('web-worker')` (in a
try/catch) and `require('web-worker')` on the `workerUrl` branch — CJS requires inside what
we bundle for the browser. These are guarded/unreachable at runtime, but bundlers resolve
statically: WXT/Vite may fail to resolve `web-worker`, or the leftover `require` may trip
the `check:extension-output` node-globals scan. Expect to need an alias/stub or an
`optimizeDeps`/external entry. **Prove this in Task 1 before building on it** — it is the
most likely source of a nasty surprise.

### 2.4 DOCX embedding — SVG plus a mandatory PNG fallback

Word's `svgBlip` support is version-dependent (004 risk 5; 005 risk 1), so an embedded SVG
**always** carries a PNG@2x raster fallback in the same `<a:blip>`. The SVG is the vector
copy modern Word renders; the PNG is what older Word shows.

The raster step is the one genuinely new mechanic in this spec: beautiful-mermaid emits
SVG, and nothing in our stack rasterizes. Options, in preference order:

1. **Side-panel canvas** — the panel is a real document: `<img src=blob:…svg>` →
   `canvas.drawImage` → `toBlob("image/png")` at 2× the SVG's intrinsic size. Simple, but
   **async** and DOM-bound, so it belongs in the panel shell, not in the pure engine.
2. **`OffscreenCanvas` + `createImageBitmap(svgBlob)`** — keeps it out of the DOM, but SVG
   decode support in `createImageBitmap` is not universal; verify before relying on it.

Either way the rasterizer is a **host capability, not engine code** — it is injected, the
same way 006 injects `TemplateSource`/`AssetFetcher`/`OutputSink`. That keeps the engine
DOM-free and lets a Node/server host supply its own rasterizer later (FAHRPLAN Phase 5).
If rasterization fails, the block takes the pinned code-block path rather than embedding a
vector Word might not draw.

### 2.5 Where the renderer lives **[open question M2]**

`renderDiagram` is a pure transform over an `ExportBlock`, and **both** export paths need
it — DOCX here, PDF in 007. Its home therefore depends on the unresolved 005/006 ordering:

- **If 006 has landed:** it belongs in the isomorphic engine package alongside the
  serializers.
- **If not:** it lands in `apps/extension/utils/docx/` and 006 moves it, exactly as
  `005-docx-image-module/PLAN.md:38` already anticipates for the image module.

This surfaces a **naming tension worth raising against 006**: 006 deliberately chose
`packages/docx` over `packages/export` because the Python `docxtpl` path holds the
`packages/export` name. But if that package ends up holding the shared `ExportBlock`
serializers, the mermaid renderer *and* 007's Typst serializer, then "docx" is the wrong
name for it — PDF would import `@atlcli/docx` to render a PDF. Flagging here; the decision
belongs to 006, not to this spec.

---

## 3. Task breakdown (ordered)

### Task 1 — License + bundling gate **[decision gate]**

- [x] **M1 ratified by Björn**: EPL-2.0 (elkjs) accepted, or mermaid stays permanently
      descoped. Recorded in the Decisions log with the reasoning (§2.2).
- [x] Bundling hazard (§2.3) proven or solved in a throwaway spike: beautiful-mermaid
      imports and renders inside the built MV3 panel with the `web-worker` require resolved
      (alias/stub/external), `check:extension-output` still clean, CSP not relaxed.
- [x] Real emitted chunk size + panel load delta recorded; confirmed lazy (a mermaid-free
      page loads no diagram chunk).
- [x] Rasterization approach (§2.4) picked with evidence, not from docs.

### Task 2 — Renderer module (pure)

- [x] `renderDiagram(source, theme): { kind: "svg"; svg: string } | { kind: "unsupported"; diagramType?: string } | { kind: "failed"; reason: string }` — synchronous, DOM-free, no host globals.
- [x] Diagram-type detection so an unsupported type is reported **by name** ("Gantt diagrams are not supported") rather than as a generic failure.
- [x] Unit tests per supported type (Flowchart, State, Sequence, Class, ER, XY-Chart) asserting real SVG landmarks; per unsupported type asserting the `unsupported` route; malformed source asserting `failed` (never a throw escaping the module).
- [x] `bun run check:browser` covers the module — it must stay isomorphic.

### Task 3 — DOCX embed path

- [x] SVG → svgBlip + PNG@2x fallback embedded via 005's media-part/relationship/content-type/EMU plumbing; unique element ids reused from 005 (no collisions with page images).
- [x] Injected rasterizer interface (§2.4); the panel supplies the browser implementation.
- [x] Width-capped to the content width like any other image; diagram source text carried as `<wp:docPr descr=…>` alt text (accessibility — the source *is* the description).
- [x] Failure on any leg (render, raster, embed) → pinned code-block path + report line, **no dangling relationship** (the 004/005 skip invariant, pinning test).

### Task 4 — Theme coupling

- [x] Diagram theme derived from the export's brand colors (beautiful-mermaid derives its scheme from two base values via `color-mix()` — EXPORT-QUALITY §4), so diagrams match callouts/body.
- [x] Default theme when no brand colors are configured; test both.

### Task 5 — Replace the descope, keep the fallback honest

- [x] Serializer routes `codeBlock{language:"mermaid"}` to the diagram path; **all other** code blocks unchanged.
- [x] The 004 pin tests are **updated, not deleted**: `packages/confluence/src/export-blocks.test.ts` (walker still models mermaid as a `codeBlock` carrying source — unchanged) stays as-is; `apps/extension/tests/docx/serialize.test.ts`'s "renders a mermaid block as a code block, never a broken image" is **retargeted to an unsupported type** (e.g. a Gantt diagram), so the "never a broken image" invariant keeps a live guard instead of being silently dropped when the supported path starts emitting drawings.
- [x] Report lines distinguish the three routes: rendered / unsupported-type / render-failed.

### Task 6 — Manual E2E **[E2E: user]**

- [x] A DOCSY test page with one diagram of each supported type + one exotic (Gantt) exports; open in Word: diagrams crisp, correctly sized, exotic shows as readable source. (Björn, 2026-07-16, page 1119158277, real Mayflower Prüfvorlage — after finding #1 was fixed.)
- [x] Zoom to 400% in a modern Word → vector (svgBlip active, not the raster fallback). (Proven via Björn's Word print-PDF: the 6 diagrams appear as vector paths; the PDF's only raster XObjects are the template logos/footer.)
- [x] Compare against Scroll's output on the same page (Scroll has no mermaid rendering — this is a **differentiator** shot for spec 008's benchmark row 9). *(Done 2026-07-16, Scroll Office export of page 1119158277: **0 of 7 mermaid blocks rendered** — all seven stay `scroll-codecontentdivline` source-text blocks, 0 `<w:drawing>` for diagrams, 0 svgBlip; atlcli renders 6 of 7 as vector drawings with a named report note for the 7th. Benchmark row 9 input recorded.)*
- [ ] Export duration delta recorded vs. the 004 baseline (spec 008 input). *(open — spec 008 input)*
- [ ] Test page deleted afterwards. *(page 1119158277 kept for now — also useful for the Scroll comparison; delete after 008 row 9)*

---

## 4. Test plan

- **Unit:** renderer per supported type (SVG landmarks), per unsupported type (named report),
  malformed source (no escaping throw); theme derivation.
- **Integration:** full export with a mermaid page → unzip, assert media part + relationship
  + content-type + `svgBlip` **and** PNG fallback present, EMU sizing sane; failure injection
  on each leg → code-block route + report line + no dangling relationship.
- **Real infra (repo directive):** real PizZip unzip on the produced `.docx`; mock only
  `chrome.*`/network. Real fixture SVG/PNG bytes, no stubs.
- **Bundle gate:** a mermaid-free export loads no diagram chunk (the lazy-load assertion).
- Repo-wide green: `bun test`, `typecheck`, `build`, `check:browser`, `check:extension-output`.

## 5. Definition of done

- The 6 supported types render into the exported `.docx` as svgBlip + PNG@2x, width-capped,
  with the diagram source as alt text.
- Unsupported types and every failure leg take the 004-pinned code-block path with a report
  line naming the reason; no dangling relationships; the "never a broken image" invariant
  still has a live test guarding it (Task 5).
- Diagram path is lazy; recorded chunk size and load delta are within the Task-1 budget.
- M1 (EPL-2.0) ratified and recorded; attribution added if accepted.
- E2E: a real page with diagrams opens clean in Word, vector at 400%; duration delta recorded.

## 6. Risks and open questions

1. **M1 — elkjs EPL-2.0** (§2.2). Decision gate; not an implementation detail.
2. **Bundling `web-worker` requires** (§2.3) — the most likely nasty surprise; Task 1 proves it.
3. **Bundle weight** — 1.5 MB minified on a lazy chunk. Acceptable only if genuinely lazy;
   Shiki (004 risk 4) is the precedent for how this goes wrong.
4. **SVG→PNG rasterization** (§2.4) — net-new mechanic, DOM-bound, async; the injected-seam
   design keeps it out of the engine but it is the least-proven leg.
5. **svgBlip Word-version support** — mitigated by the mandatory PNG fallback (004 risk 5).
6. **M2 — renderer placement + the `packages/docx` naming tension** (§2.5) — belongs to 006's
   decision, surfaced here because this spec is the second consumer that makes it concrete.
7. **Only 6 of ~15 mermaid types.** Honest coverage; the common ones are covered
   (EXPORT-QUALITY §1 calls them "mit Abstand häufigsten"). If real customer pages lean on
   exotics, the mermaid.js-in-offscreen fallback returns as its own spec.

### Decisions log

- **Numbering `005a`** (Björn, 2026-07-16) — mermaid runs directly after the image module
  rather than at the end of the queue, because it is the same embed path.
- **M1 — elkjs EPL-2.0**: ✅ **accepted** (2026-07-16) — Björn ordered the implementation with
  the spec's "accept" recommendation on the table; EPL-2.0 is weak copyleft, does not reach our
  code, and the source-availability obligation is satisfied by attribution + pointing at elkjs's
  public source. Attribution added to the repository `NOTICE` file and noted in
  `reference/docx-engine.md`.
- **M2 — renderer placement**: ✅ resolved (Björn, 2026-07-16) — the renderer is its own
  **format-agnostic adapter package `@atlcli/diagram`** (`packages/diagram/src/index.ts`),
  NOT part of `@atlcli/docx`: "das soll adapter sein, da wir das später auch für pdf export
  brauchen, also nicht eng an docx binden". `@atlcli/docx` consumes it for the svgBlip+PNG
  embed; spec 007 consumes the same SVG natively. This also dissolves the §2.5 naming
  tension: the DOCX package no longer holds cross-format code.
- **Task-1 spike results** (2026-07-16): the `web-worker` require hazard (§2.3) did NOT
  materialize — Vite's CJS transform removes the guarded requires (0 `require(` in the emitted
  chunk) and `bun build --target=browser` bundles clean (no node:/bun: specifiers). Emitted
  diagram chunk: **1.5 MB raw / ~472 KB gzip**, loaded via dynamic import behind the existing
  lazy engine chunk — the panel's initial bundle is unchanged, and diagram-type detection runs
  BEFORE the chunk import, so unsupported-only pages never load it. Total extension output
  4.68 MB (well under store limits). Rasterization (§2.4): option 1 (panel `<canvas>`), with a
  decode timeout so a hung decode degrades to the code-block route instead of freezing the
  export. beautiful-mermaid emits a Google-Fonts `@import` in its SVG `<style>` — the engine
  strips it (offline determinism; Word/rasterizers don't load external resources anyway).
- **Task-6 Word E2E finding #1** (Björn, 2026-07-16): first Word export rendered every diagram
  black with missing arrowheads — Word's svgBlip renderer supports neither CSS custom
  properties nor `color-mix()` nor (reliably) `<style>` class rules, which is ALL of
  beautiful-mermaid's styling; the PNG fallback in the same blip was pixel-perfect. Fixed by
  `flattenSvgStyles` in `@atlcli/diagram` (`3b1fb63`): the full custom-property/color-mix/class
  cascade is resolved into literal presentation attributes and the `<style>` blocks dropped.
  Also the portability prerequisite for 007's SVG consumers (resvg/Typst, same limits).
