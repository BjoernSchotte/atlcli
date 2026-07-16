# DOCX Image Module — self-built OOXML image embedding for the DOCX export

Status: **Implemented** (2026-07-16 — module in `packages/docx/src/image.ts`, seam through
serializer/export/env, hosts wired: extension session fetch + CLI token fetcher; E2E passed
against DOCSY. SVG deferred per §Non-goals: rasterized PNG fallback needs a canvas, not isomorphic.)

Spec ID: `005-docx-image-module`
Depends on: `004-docx-export` (the export flow this extends — docxtemplater free engine, `ExportBlock` model, session-auth asset fetch seam)
Related: `image-module-research.md` (analysis of the old open module + gaps), `image-module-prototype.ts` (the working OOXML prototype from the spec-004 spike), `004-docx-export/scroll-placeholder-mapping.md` context
Origin: spec 004 Decision **F3** (2026-07-16, Björn) — image embedding deferred to a follow-up task; v1 DOCX export omits images with a report line.

---

## 1. Overview

The v1 DOCX export (spec 004) ships **without embedded images** — an `image` `ExportBlock`
produces a report line ("image skipped — embedding not yet available") and is omitted from
the body. This spec closes that gap: build a **self-built OOXML image module** so page
images are fetched (session auth) and embedded into the exported `.docx`.

The engine decision (spec 004, Option A: docxtemplater free) means there is **no library
image support** — docxtemplater's Image Module is the excluded paid tier, and `docx-templates`'
native images are eval-gated (blocked by our MV3 CSP). So the image path is hand-built OOXML
plumbing on the PizZip archive, exactly the ~1-day effort estimated at the spec-004 gate and
already prototyped in [`image-module-prototype.ts`](image-module-prototype.ts).

### Goals

- An `image` `ExportBlock` (attachment ref or external URL) is fetched as bytes (session-auth
  fetch for attachments; the same seam 004 uses) and embedded into the `.docx`:
  media part (`word/media/imageN.ext`) + relationship (`document.xml.rels` `r:embed`) +
  content-type default/override + a `<w:drawing>`/`<pic:pic>` with correct EMU sizing.
- **Unique element ids** across multiple images (the prototype's static `docPr`/`cNvPr` ids
  collide — see research §5), generic content-types (not PNG-only), aspect-ratio locks +
  `effectExtent`, and dimension detection **in the browser** (decode PNG/JPEG/GIF headers via
  a DataView — no node `image-size`/`Buffer`; research §4).
- Images cap to page/content width; alt text carried onto `<wp:docPr descr=…>` (accessibility).
- Failed/oversized/unsupported image → the existing report line, export still succeeds (no
  dangling relationship — the 004 skip-path invariant stays true on the failure branch).
- Isomorphic-ready: the module lives where the export engine lives (today `apps/extension`; if
  spec 006 isomorphic-export lands first, it belongs in the `@atlcli/docx` package).

### Non-goals

- No SVG rendering pipeline beyond **svgBlip + PNG@2x fallback** (research: net-new; do it only
  if cheap). No mermaid/diagram rendering (separate concern).
- No image *editing* (crop/resize beyond width-cap scaling).
- No chart/SmartArt image generation — only embedding of raster/vector image assets.

---

## 2. Architecture (from research + prototype)

Reuse `image-module-prototype.ts` as the skeleton (engine-agnostic, operates on a raw PizZip
instance), closing the gaps `image-module-research.md` §5 lists against it:

| Concern | Prototype today | This spec must build |
|---|---|---|
| Element ids (`docPr`/`cNvPr`) | static → collide | auto-increment unique per image |
| Content-types | PNG hardcoded | generic `<Default Extension=…>` with dedup |
| Drawing fragment | minimal | + `effectExtent`, aspect-locks, `a14:useLocalDpi` |
| Dimensions | (n/a) | in-browser PNG/JPEG/GIF header decoder (DataView) |
| SVG | none | svgBlip + PNG@2x fallback (if cheap) |
| Dedup | none | optional: dedupe identical image bytes → one media part |

License: the reference open module is MIT (research §1); we **replicate patterns in TS**, do
not vendor. All-permissive.

---

## 3. Task breakdown (outline — detail on pickup)

- [x] Promote `image-module-prototype.ts` into the real module (unique ids, generic
      content-types, richer drawing fragment); unit tests on the produced OOXML (unzip + assert
      media part, relationship, content-type, blip r:embed, EMU sizing).
      → `packages/docx/src/image.ts` + `image.test.ts` (24 tests). Bonus: byte-identical dedup
      (one media part per distinct image), docPr ids seeded above the template's existing drawings.
- [x] In-browser dimension decoder (PNG/JPEG/GIF via DataView) + tests with real fixture bytes.
- [x] Wire into the 004 export flow: `image` block → session-auth fetch (mock-fetch test asserts
      `credentials: "include"`) → embed; failure → report line, no dangling rel (pinning test).
      → `SerializeContext.images` seam; `ExportInput.assets`/`embedImages`; `image-embed-failed`
      warning note; report gains `embeddedImages`. Extension resolves wiki-relative refs against
      the tab's Confluence root; CLI resolves via REST attachment listing (`tokenAssetFetcher`),
      because `/download/attachments/…` answers 401 to API-token Basic auth (E2E finding).
- [x] Width-capping + alt text on `docPr descr`.
- [x] svgBlip + PNG@2x fallback — **deferred** (spike verdict: not cheap; the mandatory PNG
      fallback needs rasterization, i.e. a canvas — not isomorphic). SVG degrades to a report line.
- [x] E2E: DOCSY test page with a real PNG attachment + a missing-attachment image, exported via
      `--engine ts` — PNG embedded (media part byte-identical, drawing scaled by `ac:width`,
      alt text carried), missing image → warning note, no dangling rel. Page cleaned up.
      Scroll-reference visual comparison remains open for Björn's next manual pass.
- [x] E2E extension (2026-07-16, Björn, real Mayflower Prüfvorlage): panel export embedded both
      test PNGs (intrinsic 400×200; `ac:width="150"` scaled 300×300 → 150×150), alt texts carried,
      our rIds/docPr ids coexist with the template's own logo image (ids seeded above the
      template's max), missing attachment degraded, no `$scroll` literals left. **Finding:** Cloud
      302s `/wiki/download/attachments/…` to `api.media.atlassian.com`; that origin had to be
      added to `host_permissions` — outside it the redirect hop falls back to plain CORS, whose
      wildcard ACAO rejects `credentials:"include"` (fix `b95572c`).

## 4. Test plan

- Unit: OOXML landmarks on the produced `.docx` (real PizZip unzip, no stubs — per repo directive);
  dimension decoder against real PNG/JPEG/GIF header bytes; unique-id + content-type-dedup checks.
- Integration: 004 export flow with images → session-fetch credentials, embed, failure→report.
- E2E: real page with images vs. Scroll output.

## 5. Definition of done

- Page images embed correctly (media + rel + content-type + drawing, unique ids), width-capped,
  alt text present; failures degrade to report lines with no dangling references.
- Repo-wide gates green (`bun test`, `typecheck`, `build`, `check:browser`, `check:extension-output`).
- E2E parity with Scroll on an image-bearing page (last v1 gap closed).

## 6. Risks

1. **svgBlip Word-version support** — mandatory PNG@2x fallback whenever SVG is embedded.
2. **Large/many images** — memory + `.docx` size; cap dimensions, consider dedup.
3. **Placement fidelity** — inline vs floating; v1 targets inline at intrinsic (capped) size,
   matching the converter's `ExportBlock.image` model.
