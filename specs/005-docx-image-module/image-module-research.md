# Old docxtemplater Image Module — Research for Our Own DOCX Image Module

Status: **Research note** (read-only investigation, 2026-07-14). Feeds the deferred
image-embedding follow-up task (PLAN.md Decisions log **F3**).

Scope: analyse the ~8-year-old open-source `docxtemplater-image-module-free` and distill
what our **own** OOXML image module (docxtemplater FREE engine; paid Image Module excluded)
can reuse or must rewrite. Compares against the spike prototype in
`image-module-prototype.ts`.

Primary source (all cited inline):
- Repo: https://github.com/evilc0des/docxtemplater-image-module-free
- `package.json`: https://raw.githubusercontent.com/evilc0des/docxtemplater-image-module-free/master/package.json
- `es6/index.js`, `es6/templates.js`, `es6/imgManager.js`, `es6/docUtils.js` (master branch)
- `licence.md`: https://raw.githubusercontent.com/evilc0des/docxtemplater-image-module-free/master/licence.md

---

## TL;DR

- **License: MIT (dual `MIT OR GPL-3.0`, we elect MIT).** Same posture as PizZip already
  in our tree. We may replicate patterns freely and may even vendor verbatim, provided we
  keep the copyright notice. Attribution obligation is minimal but real for verbatim code.
- **Most valuable liftables:** (1) the fuller `<w:drawing>` inline template — it carries
  `wp:effectExtent`, `cNvGraphicFramePr`, aspect-ratio locks, and the `a14:useLocalDpi`
  extLst that our spike fragment omits; (2) the `ImgManager` rId = `max(existing)+1`
  allocation + media-filename collision loop; (3) the **generic** content-type
  `<Default Extension=… >` dedup (our spike hardcodes only PNG); (4) the `px * 9525`
  EMU conversion with `Math.round` (matches our spike exactly).
- **Biggest MV3 gap:** dimension detection. The module gets sizes from the node `image-size`
  library reading a `Buffer`, and its zip/DOM layer assumes node `Buffer` + old `xmldom`.
  A strict-CSP MV3 panel needs an in-browser PNG/JPEG (and GIF) header decoder and
  `Uint8Array`/`ArrayBuffer` instead of `Buffer`. No `eval` is involved, so CSP itself is
  fine — the blocker is node primitives, not policy.
- **vs our spike:** our `ooxml.ts` prototype is the right shape (engine-agnostic PizZip
  surgery, `docPrId` passed in) but is **thinner** than the old module. The old module
  reveals four concrete gaps our prototype must close (see §6): static `docPr`/`cNvPr` ids
  (multi-image id collision), PNG-only content-type, missing effectExtent/aspect-locks, and
  no svgBlip path.

---

## 1. License & provenance

- `package.json` (source above): `"name": "docxtemplater-image-module-free"`,
  `"version": "1.1.1"`, `"license": "MIT"`, author "Dk Saha", `"main": "js/index.js"`,
  runtime dependency **`xmldom ^0.1.27`** only.
- `licence.md` is a **dual license: MIT OR GPL-3.0**. MIT block: `Copyright (c) 2013 Edgar
  HIPP`. This is the same lineage and same dual-license structure as PizZip, which the
  engine decision already elects as MIT (engine-decision.md §Cost items 4). We elect MIT.
- **Provenance / lineage:** the GitHub repo page states it is *"forked from
  MaxRcd/open-docxtemplater-image-module."* That project is itself the community
  open-source counterpart to docxtemplater's author's **commercial** Image Module (Edgar
  HIPP — hence the 2013 MIT copyright). So the chain is: Edgar HIPP's original open module →
  `MaxRcd/open-docxtemplater-image-module` → `evilc0des/...-free` (v1.1.1, adds browser
  build + docxtemplater 3.x compat). The `docxtemplater ^3.0.0` in devDependencies confirms
  it targets the 3.x module API.

**Verdict — can we replicate patterns / vendor?**
- **Replicate structure & XML templates (not verbatim code): unrestricted.** Facts, OOXML
  schema shapes, and API contracts are not copyrightable; MIT additionally grants the right
  outright. This is the recommended path for our TS rewrite.
- **Vendor verbatim JS: permitted under MIT**, but obligates us to preserve the
  `Copyright (c) 2013 Edgar HIPP` notice + MIT text (e.g. in a `THIRD_PARTY_LICENSES` /
  NOTICE file). Since the code is 8-year-old ES5-ish JS depending on node `Buffer` and old
  `xmldom` (see §4), verbatim vendoring buys us little and imports the MV3 problems. **Prefer
  replicate-patterns-in-TS; do not vendor.**

## 2. How it inserts an image into OOXML (the concrete recipe)

Four coordinated edits to the `.docx` zip. Our own module must do the same four.

### 2.1 The `<w:drawing>` inline fragment (`es6/templates.js` → `getImageXml`)

Verbatim template (interpolations `${rId}`, `${size[0]}`=cx EMU, `${size[1]}`=cy EMU; the
module strips `\t`/`\n` for compactness):

```xml
<w:drawing>
  <wp:inline distT="0" distB="0" distL="0" distR="0">
    <wp:extent cx="${size[0]}" cy="${size[1]}"/>
    <wp:effectExtent l="0" t="0" r="0" b="0"/>
    <wp:docPr id="2" name="Image 2" descr="image"/>
    <wp:cNvGraphicFramePr>
      <a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>
    </wp:cNvGraphicFramePr>
    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:nvPicPr>
            <pic:cNvPr id="0" name="Picture 1" descr="image"/>
            <pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr>
          </pic:nvPicPr>
          <pic:blipFill>
            <a:blip r:embed="rId${rId}">
              <a:extLst>
                <a:ext uri="{28A0092B-C50C-407E-A947-70E740481C1C}">
                  <a14:useLocalDpi xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" val="0"/>
                </a:ext>
              </a:extLst>
            </a:blip>
            <a:srcRect/>
            <a:stretch><a:fillRect/></a:stretch>
          </pic:blipFill>
          <pic:spPr bwMode="auto">
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="${size[0]}" cy="${size[1]}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/><a:ln><a:noFill/></a:ln>
          </pic:spPr>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>
```

Notes that matter for our rewrite:
- **The `r:embed` value is `rId${rId}`** — the module stores `rId` as a bare number and
  prefixes `rId` in the template. Our module should store the full `rIdN` string (as the
  spike does) to avoid a double-prefix bug.
- **`wp:inline` does NOT declare the `wp:` namespace here.** The module relies on
  `xmlns:wp=…wordprocessingDrawing` already being declared on `<w:document>` (Word's
  default). Our spike, by contrast, declares `xmlns:wp` inline on `<wp:inline>` — **more
  robust**; keep that. (Same for `a:` — the old fragment redeclares `xmlns:a` on each
  `a:graphic`/`a:graphicFrameLocks`, which is belt-and-suspenders and harmless.)
- **`wp:docPr id="2"` and `pic:cNvPr id="0"` are hardcoded constants.** For a single image
  this is fine; for **multiple images in one document these ids collide** (all become id 2 /
  id 0). Word tolerates duplicate drawing ids in practice but it is technically invalid and
  some validators/accessibility tooling complain. Our module must allocate **unique docPr
  ids** (the spike already threads a `docPrId` param — keep and auto-increment it).
- A `getImageXmlCentered` variant wraps the same drawing in `<w:p><w:pPr><w:jc w:val="center"/>…`
  (`%%` prefix, see §3). A `getPptxImageXml` variant emits `<p:pic>` for PPTX — irrelevant to us.

### 2.2 Media bytes (`es6/imgManager.js`)

- Written to `${prefix}/media/${realImageName}` via `zip.file(path, data, {binary:true})`
  — i.e. `word/media/<name>.<ext>` for the main document part (`prefix` is the part's
  directory). Matches spike (`word/media/…`).
- **Filename collision loop:** if the target name already exists in the zip it appends
  `(${i})` and retries — `image(1).png`, `image(2).png`, … Our spike sidesteps this with a
  monotonic `spikeImage${n}` counter; either works, but the collision-aware approach is safer
  if image names come from attachment filenames.

### 2.3 Relationship wiring (`ImgManager.loadImageRels` / add-relationship)

- Loads the part's rels doc from `word/_rels/document.xml.rels` (created empty by cloning a
  `<Relationships>` template if absent).
- **rId allocation:** scans all `Relationship/@Id` matching `/^rId[0-9]+$/`, takes the max
  numeric suffix, new id = `rId${max+1}`. **Identical logic to our spike's `addImageRel`.**
- Appends:
  ```xml
  <Relationship Id="rId${n}"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
    Target="media/${realImageName}"/>
  ```
  (`Target` is relative to `word/`, i.e. `media/foo.png`.) Matches spike exactly.
- Mechanism difference: the old module manipulates the rels via **`xmldom` DOM nodes**; the
  spike does **string/regex splice** before `</Relationships>`. Both fine; the regex splice
  is lighter and avoids the `xmldom` dependency (see §4).

### 2.4 Content-type registration (`ImgManager.addExtensionRels`)

- Reads `[Content_Types].xml`, checks existing `<Default>` tags for the image's extension,
  and if absent appends:
  ```xml
  <Default Extension="png" ContentType="image/png"/>
  ```
  — **generic over extension** (png/jpeg/jpg/gif/…), with dedup. Our spike only ensures the
  **png** default (`ensurePngContentType`, hardcoded). **Lift the generic+dedup version**
  and add an extension→MIME map (`png→image/png`, `jpg`/`jpeg→image/jpeg`, `gif→image/gif`,
  `svg→image/svg+xml`).

### 2.5 EMU sizing / DPI (`es6/docUtils.js` → `convertPixelsToEmus`)

```js
return Math.round(pixel * 9525);
```

- **`9525 EMU/px` = 914400 EMU/inch ÷ 96 dpi.** Assumes 96 DPI. **Byte-identical to the
  spike** (`EMU_PER_PX = 9525`), except the spike does not `Math.round` (its px inputs are
  already integers, but **add `Math.round` to be safe** once intrinsic sizes come from a
  decoder). No page-width capping in either — that stays our own addition (PLAN.md §2.3
  "intrinsic-size→page-width capping").

## 3. docxtemplater module-API contract + version-compat risk

The module implements the **docxtemplater 3.x module lifecycle** (`es6/index.js`):

- **Constructor / `set(options)`** — receives `{getImage, getSize, ...}`; `getImage(tagValue,
  tagName)` returns image bytes, `getSize(imgBytes, tagValue, tagName)` returns `[wPx, hPx]`.
  These two callbacks are the module's entire data-input contract (base64/path/URL are the
  caller's concern — the module only sees bytes + a size).
- **`parse(placeHolderContent)`** — matches tags by prefix: **`%image`** = inline,
  **`%%image`** = centered. Returns `{type:"placeholder", value, module:"<name>"}`.
- **`postparse(parsed)`** — expands each placeholder to the enclosing container it must
  replace: `w:p` (centered) or `w:t`/run (inline) for DOCX, `p:sp` for PPTX. This is the
  "which XML node do I swap out" step.
- **`render(part, options)`** — sync path: `getImage` → `ImgManager` allocates rId + writes
  media + rel + content-type → `getSize` → `convertPixelsToEmus` → `templates.getImageXml`.
- **`resolve(...)`** — async mirror of `render` (Promise-wrapped `getImage`/`getSize`), for
  `doc.renderAsync()`.
- **`getFileType()` / traits** — distinguishes docx vs pptx to pick container + template.

**Version-compat risk — HIGH, flag explicitly.** This module was written against
docxtemplater **3.0.x**; our engine decision pins **docxtemplater 3.69.0**. Across 3.x the
module interface changed materially: modern modules use `set(options)`, an
`optionsTransformer`, a `matchers()`/`parse` split, `postparse` with a `getTraits('expandPair')`
mechanism, and a different `render` signature (`{part}` with a `filePath`/`scopeManager`).
A verbatim drop-in of this 8-year-old module against 3.69 is **unlikely to work** without
rewriting the lifecycle hooks. **Consequence for us:** do **not** try to run this module.
Our decision (F3) is already the right one — build our own. And note our chosen integration
is **not even a docxtemplater module**: the spike inserts images by **raw PizZip surgery**
around `{@rawXml}` (engine-agnostic), sidestepping the module API entirely. So the module
lifecycle above is **reference only** — we lift the OOXML mechanics, not the hook contract.

## 4. Browser / MV3 fitness

The module *can* run in a browser (it ships a browserify build and MaxRcd's fork advertises
browser support), and critically it contains **no `eval`/`new Function`** — so strict-CSP
(`script-src 'self'`, no `'unsafe-eval'`) is **not** the blocker here (unlike docx-templates;
engine-decision.md). The blockers are **node primitives**:

| Assumption in old module | MV3 problem | Replacement for our module |
|---|---|---|
| `image-size ^0.5.1` for `getSize` | reads a node `Buffer`; the lib is node-oriented and pulls `fs` in some paths | **in-browser header decoder**: read PNG IHDR (bytes 16–24) for W/H; JPEG SOF0/2 marker scan; GIF logical-screen bytes 6–9. ~40 lines over a `DataView`/`Uint8Array`. No lib needed. |
| `Buffer` for media bytes | not in MV3 without a polyfill | `Uint8Array`/`ArrayBuffer` from our session-fetched `Blob` (`await blob.arrayBuffer()`) |
| `xmldom ^0.1.27` for rels/content-type DOM edits | pure-JS so it *runs*, but it is an ancient, unmaintained dep | our spike already avoids it — **string/regex splice** on the rels + content-types parts (no dep) |
| `jszip 2.x` (tests) | — | we use **PizZip** (already chosen); same `.file()` API |
| base64/path `getImage` inputs | path implies `fs` | our input is a **`Blob`/`Uint8Array`** from a session fetch — no path, no fs |

**No CSP/eval issues** to solve — the adaptation is purely swapping node types for
web types + writing the dimension decoder. That decoder is the single biggest new piece the
old module does *not* give us (it delegated to `image-size`).

## 5. Reuse vs. rewrite — recommendation

**Rewrite in TS; lift patterns + XML templates; do not vendor.** MIT permits vendoring but
the 8-year-old node-coupled JS + stale API make it a net negative. Concretely:

**Lift (structure / literal XML, re-typed):**
1. The **`getImageXml` inline fragment** in §2.1 — adopt its extra elements
   (`wp:effectExtent`, `wp:cNvGraphicFramePr` + `graphicFrameLocks noChangeAspect`,
   `picLocks`, `a14:useLocalDpi` extLst, `pic:spPr` `noFill`/`ln`). These make Word treat the
   image as a well-formed, aspect-locked picture; our spike fragment lacks them.
2. **rId = `max(existing rIdN)+1`** allocation — identical to spike; keep.
3. **Generic content-type `<Default>` + dedup** (§2.4) — replace the spike's PNG-only
   `ensurePngContentType` with an extension→MIME map.
4. **`px * 9525` + `Math.round`** EMU conversion — keep; add rounding.
5. **Media filename collision handling** (`(i)` suffix) if names derive from attachments.

**Rewrite / add (not in the old module or wrong for us):**
- **In-browser dimension decoder** (PNG/JPEG/GIF headers) — replaces `image-size` (§4).
- **Unique `docPr`/`cNvPr` ids per image** — fixes the old module's hardcoded `id="2"`/`id="0"`
  collision; thread an incrementing counter (spike's `docPrId` is the seed).
- **`Uint8Array`/`Blob` I/O**, **PizZip**, **regex-splice rels/CT** (no `xmldom`).
- **Input = our `ExportBlock` `image` node** (`packages/confluence` export model, PLAN.md
  §2.3) → attachment download URL → session fetch → `Blob`. The module takes bytes+ext+intrinsic
  size, returns `{ drawingXml, mediaWrites, relPatch, ctPatch }` for the serializer to splice
  at `{@rawXml}`. Engine-agnostic, exactly like the spike.
- **svgBlip + PNG@2x fallback** — the old module has **no SVG path** at all. PLAN.md §2.3/§Risk 5
  require `<asvg:svgBlip>` (in the blip's extLst) with a rasterized PNG fallback in the same
  `a:blip r:embed`. This is net-new; design it in from the start.
- **Page-width capping / alt text** — intrinsic px → cap to content width; `descr`/`title`
  from attachment alt text (the old module hardcodes `descr="image"`).

### 5.1 Explicit diff vs `image-module-prototype.ts`

| Concern | spike `ooxml.ts` | old module | What the follow-up task should build |
|---|---|---|---|
| Inline drawing completeness | minimal (`extent`, `docPr`, `blip`, `stretch`, `spPr/xfrm/prstGeom`) | + `effectExtent`, `cNvGraphicFramePr`+aspect locks, `picLocks`, `useLocalDpi`, `noFill` | adopt the fuller fragment (§2.1) |
| `wp:` namespace | declared inline on `wp:inline` (robust) | relies on document-root decl | keep spike's inline decl |
| docPr / cNvPr id | `docPrId` param (unique-capable) but `cNvPr` reuses it | **hardcoded `2`/`0`** (collision) | auto-increment a shared counter; unique per image |
| rId allocation | `max+1` over `document.xml.rels` | `max+1` (same) | keep |
| Content-type | **PNG only**, hardcoded | generic `<Default>` + dedup | ext→MIME map + dedup |
| EMU | `*9525`, no round | `*9525` + `Math.round` | add round |
| Dimension source | caller passes `wPx,hPx` | `image-size` (node) | **in-browser header decoder** |
| Multiple images / dedup | monotonic counter, no image-content dedup | filename-collision loop, no content dedup | optional: hash-dedup identical images (both lack it) |
| SVG | none | none | **svgBlip + PNG fallback** (new) |
| Deps | PizZip + regex splice (no xmldom) | `xmldom` + Buffer | keep spike's dep-free approach |

**Bottom line:** the spike prototype is the correct skeleton and is in several ways *better*
than the 8-year-old module (dep-free splice, inline namespaces, parameterized docPr). The old
module's value is a **more complete, Word-blessed drawing fragment**, a **generic
content-type helper**, and confirmation of the **rId/EMU mechanics**. The two things neither
has — and that our follow-up must add — are an **in-browser dimension decoder** and an
**svgBlip fallback path**.

---

## Sources

- Repo tree + fork note: https://github.com/evilc0des/docxtemplater-image-module-free
- `package.json` (MIT, v1.1.1, xmldom/image-size deps): https://raw.githubusercontent.com/evilc0des/docxtemplater-image-module-free/master/package.json
- `licence.md` (MIT OR GPL-3.0, © 2013 Edgar HIPP): https://raw.githubusercontent.com/evilc0des/docxtemplater-image-module-free/master/licence.md
- `es6/index.js` (parse/postparse/render/resolve, getImage/getSize): master branch
- `es6/templates.js` (`getImageXml` fragment, §2.1): https://raw.githubusercontent.com/evilc0des/docxtemplater-image-module-free/master/es6/templates.js
- `es6/imgManager.js` (media path, rId, content-types, §2.2–2.4): master branch
- `es6/docUtils.js` (`convertPixelsToEmus` = `Math.round(pixel*9525)`, §2.5): master branch
- Local comparison: `image-module-prototype.ts`, `engine-decision.md`, `PLAN.md` (F3).
