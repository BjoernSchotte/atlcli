# DOCX Templating-Engine Decision Brief (Spec 004, Task 1)

Status: **Decision made (2026-07-16): docxtemplater free — Option A.** See PLAN.md Decisions log F1.

> **Note (2026-07-16):** the throwaway spike harness under `spike/` was **removed** after the
> decision was locked and the production code shipped (it was never part of the bun workspace
> and nothing imports it). Paths below like `spike/src/preprocess.ts`, `spike/src/verify-outputs.ts`,
> `spike/out/*.docx`, `spike/bundle/*` refer to that removed harness and are recoverable from git
> history (spike added in `45e909e`). The one reusable artifact — the OOXML image-module prototype —
> was preserved as [`specs/005-docx-image-module/image-module-prototype.ts`](../005-docx-image-module/image-module-prototype.ts) for the deferred
> image-module task. The reproduce-commands below are historical.

Author: engine spike, 2026-07-14
Scope: Task 1 only. Evidence produced by the (now-removed) `spike/` harness; findings below are self-contained.

Reproduce everything (historical — harness removed):

```bash
cd specs/004-docx-export/spike
bun install          # own package.json + lockfile; NOT part of the bun workspace
bun run all          # builds fixtures, runs both engines + preprocessor, verifies XML
```

Produced evidence artifacts (`spike/out/`):

| File | What it proves |
|---|---|
| `docx-templates-native.docx` | docx-templates native IMAGE + literal-XML injection |
| `docxtemplater-native.docx` | docxtemplater free `{@rawXml}` + self-built image module |
| `customer-preprocessed.docx` | engine-agnostic `$scroll.*` preprocessor on the real customer template (body+header+footer) |

All three `document.xml` parts validated **well-formed by `xmllint`**, and every claim
below is asserted against the produced XML by `spike/src/verify-outputs.ts`
(all checks PASS) — not "no exception thrown".

---

## TL;DR recommendation

> **Do not choose docx-templates for the MV3 side panel.** Its entire command
> engine evaluates template JS via `new Function`/`eval`/sandbox-iframe
> (`spike` verified: `node_modules/docx-templates/lib/jsSandbox.js:90` =
> `new Function('with(this){return eval(__code__)}')`), which MV3 extension-page
> CSP (`script-src 'self'`, no `'unsafe-eval'`) forbids. That nullifies its one
> headline advantage — MIT-native images — because native images are an IMAGE
> *command*, i.e. also eval-gated.
>
> **Recommended: `docxtemplater` free tier + a self-built OOXML image module**
> (~1 day, already prototyped here). It contains **zero `eval`/`new Function`**
> (verified against the built browser bundle), so it runs under MV3 CSP; its
> `{@rawXml}` raw-OOXML injection is free and block-level clean; it is smaller,
> faster, and has richer structured errors.
>
> **Strong alternative — no engine at all (Option C):** the `$scroll.*`
> preprocessor + the same self-built OOXML module already produces a fully
> correct output (`customer-preprocessed.docx`, all checks pass). Scroll
> templates are flat placeholders + one `$scroll.content` insertion point — they
> use none of an engine's loop/conditional machinery — so an engine buys us
> little beyond `{@rawXml}`.
>
> **Confidence:** *high* that docx-templates is wrong for a strict-CSP MV3 panel;
> *medium* on docxtemplater-vs-no-engine (a dependency-vs-simplicity call). The
> one assumption to confirm in the real panel: the side panel is a strict-CSP
> MV3 extension page with no `'unsafe-eval'` (the spec's "MV3-safe" language and
> §1 "pure JS in the side panel" imply yes).

---

## Result matrix

Legend: ✅ works · ⚠️ works with caveat/cost · ❌ blocked.

| # | Criterion | docx-templates (MIT) | docxtemplater (free) | Evidence |
|---|---|---|---|---|
| 1 | **Image embedding** (license fork) | ✅ MIT-native IMAGE command — **but eval-gated (❌ under MV3)** | ⚠️ needs **self-built** OOXML module (prototyped, ~1 day); free-tier has no image module | `run-docx-templates.ts`, `run-docxtemplater.ts`, `ooxml.ts` |
| 2 | **Free-form raw-XML injection** | ✅ literal-XML `\|\|…\|\|`, but **run-level** → needs block "breakout" balancing | ✅ `{@rawXml}` built-in free, **paragraph-level** → block content splices cleanly | both `-native.docx` verified |
| 3 | **Delimiter collision with `$scroll.*`** | ✅ default `+++…+++` leaves `$scroll.*` untouched | ✅ default `{…}` leaves `$scroll.*` untouched | — |
| 3b | …can the engine *replace* `$scroll.*`? | ❌ not via its data path | ❌ not via its data path | **both need a preprocessor** (see below) |
| 4 | **Malformed-template errors** | ✅ clear message, fail-fast | ✅ clear message **+ structured props** (id/offset/context/file) | `run-errors.ts` |
| 5 | **Bundle size / perf** | 334.6 KB min / 103.0 KB gz · ~18 ms | **270.1 KB min / 83.2 KB gz** · **~1.5 ms** | `bundle/`, run logs |
| 6 | **Header/footer replacement** | ✅ (via preprocessor) | ✅ (via preprocessor) | `customer-preprocessed.docx` |
| — | **Runs under MV3 CSP (no `unsafe-eval`)** | ❌ `new Function`/`eval`/iframe sandbox | ✅ **zero eval** in core + built bundle | `jsSandbox.js:90`; `grep -c` on bundles |

---

## Per-criterion evidence

### 1. Image embedding — the license fork, re-framed by MV3

- **docx-templates**: `+++IMAGE fn()+++` with a data callback returning
  `{width,height,data,extension}` embeds images MIT-natively (media part +
  relationship + content-type all handled). Verified: 3 media parts, 3
  `<a:blip r:embed>` resolving to 3 image relationships in
  `docx-templates-native.docx`. **However** the IMAGE command is evaluated by
  the JS sandbox → same eval blocker as criterion "MV3". So under MV3 this path
  is unavailable and you fall back to a self-built module anyway.
- **docxtemplater free**: no image module without the paid **Image Module**
  (commercial, excluded per Björn). The spike **built the free-tier image path
  by hand** (`specs/005-docx-image-module/image-module-prototype.ts`): write `word/media/*.png`, append an
  `.../image` relationship to `word/_rels/document.xml.rels`, add the `png`
  default to `[Content_Types].xml`, emit a `<w:drawing>`/`<pic:pic>` with EMU
  sizing referencing the rId. Verified: 3 media parts, png content-type, 3 blips
  resolving to rels in `docxtemplater-native.docx`.
- **Key consequence:** the **self-built image module is needed regardless of
  engine** once MV3 removes docx-templates' native path — and the spike proves it
  is engine-agnostic (the *same* module produced the images in
  `customer-preprocessed.docx` with no engine at all).

### 2. Free-form raw-XML injection (callouts, colored code)

Both can inject arbitrary OOXML. The difference is granularity:

- **docxtemplater `{@rawXml}`** replaces the **whole paragraph** containing the
  tag → a `<w:tbl>` callout or a shaded multi-color `<w:p>` code line drops in
  well-formed with no fuss. (Verified: callout fill `FFFAE6`, code color
  `098658`.)
- **docx-templates literal XML** (`||…||`) is spliced **inside a run's `<w:t>`**,
  so block content (tables, paragraphs) needs a manual "breakout" wrapper
  `||</w:t></w:r></w:p> …blocks… <w:p><w:r><w:t>||` to stay well-formed
  (implemented in `run-docx-templates.ts`; output verified well-formed, but the
  balancing is a foot-gun the serializer would have to get exactly right every
  time). (Verified: callout fill `DEEBFF`, code color `A31515`.)

### 3. Delimiter collision — **both engines need a preprocessor**

Neither engine treats `$scroll.*` as its own syntax (defaults are `+++…+++` and
`{…}`), so templates load **unmodified** — good. But that also means neither
engine's *data path* can replace `$scroll.title`, `$scroll.exportdate`, etc.
The realistic product mechanism is therefore an **XML-level find/replace
preprocessor** across `document.xml` + every `header*.xml`/`footer*.xml`, plus
paragraph-replacement for the single `$scroll.content` block
(`spike/src/preprocess.ts`). This layer is **engine-independent** — it is the
same code whichever engine (or no engine) sits underneath it.

> Real-Scroll caveat (documented, not a blocker): Word often splits a run like
> `$scroll.title` across multiple `<w:r>`/`<w:t>` nodes (rsid/spellcheck). The
> spike's generated template keeps each placeholder in one run. Production must
> first **normalise/merge runs** inside placeholder paragraphs before find/replace
> (a known, small addition — docxtemplater actually does exactly this run-merge
> internally for its own tags, another minor point in its favour).

### 4. Error behaviour on malformed templates (`run-errors.ts`)

| Input | docx-templates | docxtemplater |
|---|---|---|
| corrupt (non-zip) buffer | `Error: Corrupted zip: can't find end of central directory` | `Error: Corrupted zip : can't find end of central directory` |
| broken tag | `Unterminated FOR-loop ('FOR x'). Make sure each FOR loop has a corresponding END-FOR…` | `The tag beginning with "{unclosed tag" is unclosed` **+ structured `properties` {id, context, offset, file}** |

Both fail-fast with human-readable messages (both use PizZip, so zip errors are
identical). docxtemplater's structured error object is nicer for the upload-scan
UX (Task 3's "clear error, nothing stored"). Minor: docxtemplater also
`console.error`s the error internally — cosmetic noise to suppress.

### 5. Bundle size / perf

Built with `bun build --target=browser --minify` (docx-templates via its
shipped `lib/browser.js`; docxtemplater entry includes PizZip):

| Engine | minified | gzipped | fixture render |
|---|---|---|---|
| docx-templates | 334.6 KB | 103.0 KB | ~18 ms |
| **docxtemplater (+pizzip)** | **270.1 KB** | **83.2 KB** | **~1.5 ms** |
| preprocessor only (Option C) | (pizzip ~95 KB min only) | — | ~3 ms |

All render times are ~1000× under the 10 s budget (spec 008). Size difference is
minor at side-panel scale but favours docxtemplater / no-engine.

### 6. Header/footer placeholder replacement — **proven**

`customer-preprocessed.docx`, asserted by `verify-outputs.ts`:

- HEADER `word/header1.xml`: `$scroll.title` → "Q3 Architecture Overview",
  `$scroll.exportdate` → "14.07.2026" ✅
- FOOTER `word/footer1.xml`: `$scroll.exporter.fullName` → "Björn Schotte" ✅
  (native Word page-number field preserved)
- BODY: `$scroll.title`/`$scroll.space.name`/`$scroll.pagelabels`/`$scroll.content`
  replaced; **no `$scroll.` literal remains** in body/header/footer ✅

---

## Exit-criteria verdict (per §2.1)

> An engine is viable iff it can (a) replace text placeholders in body *and*
> header/footer, (b) embed images, (c) inject raw OOXML.

| Engine | (a) text body+H/F | (b) images | (c) raw OOXML | MV3-CSP | **Viable for the MV3 panel?** |
|---|---|---|---|---|---|
| docx-templates | ✅ (preproc) | ✅ native **but eval-gated** | ✅ (run-level) | ❌ | **No** — eval blocked in MV3 |
| docxtemplater (free) | ✅ (preproc) | ⚠️ self-built (~1d) | ✅ free `{@rawXml}` | ✅ | **Yes** |
| no engine (Option C) | ✅ (preproc) | ⚠️ self-built (~1d) | ✅ (preproc) | ✅ | **Yes** |

Note: strictly by the §2.1 abstract criteria (a–c) alone, *both* engines "pass".
The MV3-CSP row is the added, decisive real-world gate the spike surfaced.

---

## Cost items (explicit, per §2.1 license constraint)

1. **Self-built OOXML image module — ~1 developer-day (S).** Prototyped in
   `specs/005-docx-image-module/image-module-prototype.ts` (media part + relationship + content-type + drawing/EMU).
   Remaining production work: run-normalisation, SVG `svgBlip`+PNG fallback,
   intrinsic-size→page-width capping, alt text, dedupe of identical images.
   **This cost is incurred under docxtemplater AND under docx-templates-in-MV3
   AND under Option C** — it is not unique to docxtemplater. It does *not* quietly
   become the whole project; it's a bounded, well-understood helper.
2. **`$scroll.*` preprocessor with run-normalisation — ~1 day (S).** Engine-
   agnostic; needed in every option. Prototype (minus run-merge) in
   `spike/src/preprocess.ts`.
3. **(docx-templates only) MV3 eval workaround — HIGH risk / likely infeasible.**
   Would require running export in an offscreen document/worker with a relaxed
   CSP or shipping a WASM JS interpreter. Not recommended; this is the reason to
   avoid docx-templates here.
4. **Licenses:** docx-templates 4.15.0 = MIT; docxtemplater 3.69.0 core = MIT
   (Image Module is separate commercial — excluded); PizZip 3.2.0 = `MIT OR
   GPL-3.0` (we elect MIT); `@xmldom/xmldom` = MIT. No paid dependency in the
   recommended path.

---

## Raw-XML injection recipe (recommended engine: docxtemplater free)

**Body / block content — `{@rawXml}`:**

```ts
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

const zip = new PizZip(templateBytes);
// (preprocess $scroll.* text + reserve image rels BEFORE render — see below)
const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
doc.render({ scrollContent: bodyOoxmlString /* headings, callouts, tables, code, images */ });
const out = doc.getZip().generate({ type: "uint8array", compression: "DEFLATE" });
```

- Put `{@scrollContent}` (via the preprocessor, swapping the literal
  `$scroll.content` paragraph for a `{@scrollContent}` paragraph) — the whole
  paragraph is replaced by your OOXML, so blocks nest correctly. No breakout
  balancing.
- `{@…}` must be the **only** text in its paragraph (docxtemplater enforces this).

**Images — self-built module (works because it's pure zip surgery, no eval):**

```ts
// 1. add media part
zip.file(`word/media/${name}.png`, pngBytes);
// 2. add relationship → returns rId
//    <Relationship Id="rIdN" Type=".../image" Target="media/${name}.png"/>
//    appended to word/_rels/document.xml.rels
// 3. ensure [Content_Types].xml has <Default Extension="png" ContentType="image/png"/>
// 4. emit inline drawing referencing rId, sized in EMU (px * 9525):
//    <w:drawing><wp:inline><wp:extent cx cy/><a:graphic>…<a:blip r:embed="rIdN"/>…
```

Full reference implementation: `specs/005-docx-image-module/image-module-prototype.ts`
(`addImageRel`, `ensurePngContentType`, `imageDrawing`).

**`$scroll.*` text placeholders — preprocessor** (`spike/src/preprocess.ts`):
XML find/replace across `document.xml` + `header*.xml` + `footer*.xml`; replace
the `$scroll.content` paragraph with `{@scrollContent}` (or inject OOXML
directly and skip the engine — Option C).

---

## Decision needed (Björn)

1. **Engine choice.** Pick one:
   - **(A) docxtemplater free + self-built image module** — recommended if you
     want an engine (MV3-safe, free `{@rawXml}`, richer errors).
   - **(B) docx-templates** — only if you can guarantee the export does **not**
     run under strict MV3 CSP (e.g. offscreen doc with relaxed policy). The spike
     recommends against this.
   - **(C) No engine: preprocessor + self-built OOXML module** — recommended if
     you prefer minimal dependencies; the spike shows it already produces correct
     output and Task 2's serializer owns the body OOXML anyway.
   *Spike's lean: **A or C**, not B.*
2. **Confirm the MV3-CSP assumption.** Is the side panel a strict-CSP MV3
   extension page with no `'unsafe-eval'`? (This is the linchpin that rules out
   docx-templates.) If export can run somewhere eval is allowed, reconsider B.
3. **Accept the self-built image-module cost (~1 day)** as part of the DOCX
   project regardless of A/B/C — confirm it's in scope, not a surprise.
4. **License note:** if A, we depend only on MIT code (docxtemplater core +
   PizZip-as-MIT + xmldom). Confirm PizZip's `MIT OR GPL-3.0` dual license
   elected as MIT is acceptable to legal.
```
