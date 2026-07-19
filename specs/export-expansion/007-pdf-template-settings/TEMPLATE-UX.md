# PDF Template UX — Product Model Without a Template Studio

Status: **Product direction — proposed follow-up to the built-in PDF export**

Related spec: `007-pdf-export`

This document captures the product decision for customizable PDF output after the
built-in `atlcli` Typst template has shipped and passed its quality gates. It is not part
of the implementation scope of Spec 007 itself.

> **Normative scope note.** Only §7 (minimal template contract) and §9 (security and
> reproducibility) are normative for the `export-expansion` series. Everything else in
> this document is product vision, not a committed implementation plan — its actual
> delivery status is tracked by
> [`007-pdf-template-settings/PLAN.md`](./PLAN.md) (Level A settings + the
> `.wiki-pdf-template` container) and
> [`012-pdf-template-migration/PLAN.md`](../012-pdf-template-migration/PLAN.md)
> (full design-token migration + a second curated template). Levels B/C wireframes and
> the market comparison in §2/§6 are not scoped to any folder yet.

---

## 1. Product verdict

Do not build a general-purpose visual PDF template editor.

Use three complementary levels instead:

1. **Curated Typst templates with generated brand settings** for normal users.
2. **A Git-friendly Typst template package** for developers, designers and agencies.
3. **A focused PDF stationery importer** for organizations that already have a branded
   PDF letterhead.

The stationery importer is deliberately a short calibration wizard, not a design studio.
It lets a user upload an existing PDF, assign first/continuation/last-page roles and draw
the rectangular area in which semantic content may flow.

The product must not promise arbitrary PDF-to-Typst conversion. A finished PDF can be a
high-fidelity page background, but it no longer contains the source document's reliable
flow regions, paragraph styles, table behavior or pagination rules.

---

## 2. What established template products actually do

The market converges on four authoring models. Each model is good for a different type
of document.

| Model | Authoring surface | Best for | Structural limit |
|---|---|---|---|
| DOCX placeholders | Microsoft Word | Business users and freely designed office documents | Final pagination depends on a compatible Office rendering engine |
| HTML/CSS placeholders | Code editor or web builder | Developers and web designers | High-end paged-media behavior still requires specialist CSS and preview tooling |
| Existing PDF plus fields | Uploaded PDF with positioned overlays | Forms, certificates, labels and fixed layouts | Fields have fixed coordinates; arbitrary long content does not reflow |
| Code-based templates | Typst or another typesetting language | Reproducible, versioned document systems | Needs strong preview, validation and a simpler default path for non-technical users |

DOCX products use Word as the visual editor instead of recreating it. Paged-media
products let HTML content flow across pages. PDF form products preserve an existing PDF
as a fixed page and place named fields on top. Systems that need long, semantic and
high-quality documents ultimately require a real layout source such as HTML/CSS or
Typst.

The important product distinction is therefore:

- **fixed page filling** repeats coordinates;
- **document generation** flows semantic content through a page model.

Confluence pages require the second model.

---

## 3. The `$scroll.content` idea

### 3.1 Correct model in a Typst template

A single content slot is the right abstraction in source-based templates:

```typst
#let render(meta, body, settings: (:)) = {
  set document(title: meta.title, author: meta.author)
  set page(/* page master */)

  // Optional cover and outline.
  body
}
```

The engine passes `body` once. Typst paginates it across as many pages as necessary.
The page background, header and footer repeat; the content slot itself is not cloned.

This is already close to the current internal `atlcli-doc(meta, body)` seam.

### 3.2 Why a visible marker in a PDF is not sufficient

A visible `$scroll.content` string in an exported PDF is normally just positioned glyphs.
It does not describe:

- the full width and height of the intended flow area;
- first-page versus continuation-page behavior;
- safe distances from letterhead, footer or page decorations;
- how headings, tables, images and code blocks may break;
- the behavior of a cover, outline or final page;
- whether the marker itself should remain visible.

Text extraction is not a reliable contract either. A PDF producer may split the marker
into multiple text runs, subset its font, convert it to paths or change its reading order.

A marker may be offered as an optional best-effort hint, but the user must confirm the
detected rectangle visually. A named PDF form field such as `atlcli.content` is a more
reliable coordinate marker, but it still describes only a rectangle; the actual document
flow remains Typst's responsibility.

---

## 4. No general PDF-to-Typst converter

A useful general-purpose converter would need to reconstruct semantic source from a
format in which most layout decisions have already been flattened. No credible converter
currently provides that contract.

Possible transformations solve narrower problems:

- **Embed PDF directly:** highest visual fidelity, but the page remains a fixed graphic.
- **Convert PDF to SVG:** useful as a vector background fallback, but not editable
  semantic Typst source.
- **Extract text or run OCR:** recovers some content, not the original layout system.
- **Generate absolute Typst positions:** may resemble the source visually, but is not a
  maintainable or reflowing template.

The product wording must therefore be **Use PDF as page background**, not **Convert PDF
to template**.

---

## 5. Recommended product levels

### 5.1 Level A — curated templates and brand settings

This is the default path in the future PDF tab.

The user selects a template and sees only the controls declared by its manifest:

- logo;
- accent color;
- font choice from an approved set;
- A4 or Letter;
- cover on/off;
- outline on/off;
- header and footer text;
- optional organization metadata.

The extension generates the settings form. Templates may expose only a small, bounded
set of input types: text, boolean, choice, color, bounded number and validated asset.

This is customization, not free-form layout editing.

### 5.2 Level B — Git-friendly Typst package

Advanced users work in their existing editor and Typst toolchain:

```text
my-template/
├── wiki-pdf-template.json
├── template.typ
├── assets/
│   ├── logo.svg
│   └── fonts/
├── LICENSES/
└── README.md
```

The source folder remains reviewable and versionable in Git. Distribution to the
extension uses a deterministic `.wiki-pdf-template` archive so users import one file, not
a loose folder tree.

Suggested future commands:

```text
atlcli pdf-template init my-template
atlcli pdf-template preview my-template --fixture feature-zoo
atlcli pdf-template validate my-template
atlcli pdf-template pack my-template
```

These commands are product proposals, not existing functionality.

### 5.3 Level C — PDF stationery importer

This path is for an existing corporate letterhead or branded page design. The uploaded
PDF remains an immutable background. `atlcli` stores the selected pages and flow geometry
as a normal template package and generates the small Typst wrapper automatically.

The importer should support:

- one source PDF;
- first-page background;
- continuation-page background;
- optional last-page background;
- one required rectangular body flow region;
- optional first-page and last-page region overrides;
- preview against canonical short and long fixtures;
- numeric margin editing alongside drag handles.

It should not support arbitrary text boxes, shape editing, layers or a component palette.

---

## 6. Low-fidelity stationery-import flow

### Step 1 — upload and preflight

```text
┌──────────────────────────────────────────────────────────────┐
│ Import PDF stationery                                      × │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Drop a PDF here                                             │
│  or [ Choose PDF ]                                           │
│                                                              │
│  The PDF will be used as page artwork.                       │
│  Your Confluence content remains selectable and searchable.  │
│                                                              │
│                                          [ Cancel ] [ Next ]  │
└──────────────────────────────────────────────────────────────┘
```

After upload, run a preflight for:

- encrypted or password-protected files;
- page count, page size, crop box and rotation;
- PDF version compatibility;
- file size and active content;
- annotations and form fields;
- fonts and license-relevant embedded assets;
- mixed page dimensions.

The result is one of **Ready**, **Ready with warnings** or **Can't use**.

### Step 2 — assign page roles

```text
┌────────────────────────────────────────────────────────────────────┐
│ Choose page roles                                             2/4 │
├────────────────────────────────────────────────────────────────────┤
│ Source pages                                                      │
│                                                                    │
│  ┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐                │
│  │ page 1 │   │ page 2 │   │ page 3 │   │ page 4 │                │
│  │ thumb  │   │ thumb  │   │ thumb  │   │ thumb  │                │
│  └────────┘   └────────┘   └────────┘   └────────┘                │
│                                                                    │
│ First page          [ Page 1 ▾ ]                                   │
│ Continuation pages  [ Page 2 ▾ ]   Repeat for body overflow        │
│ Last page           [ None   ▾ ]   Optional                        │
│                                                                    │
│                              [ Back ] [ Continue to content area ]  │
└────────────────────────────────────────────────────────────────────┘
```

Defaults:

- a one-page PDF repeats page 1 for all body pages;
- a two-page PDF proposes page 1 as first and page 2 as continuation;
- three or more pages require explicit assignment;
- the last-page background is always optional;
- page roles may point to the same source page.

### Step 3 — draw the content area

```text
┌────────────────────────────────────────────────────────────────────┐
│ Set content area                                              3/4 │
├────────────────────────────────────────────────────────────────────┤
│ Page role  [ Continuation ▾ ]                                      │
│                                                                    │
│       ┌──────────────────── page preview ────────────────────┐      │
│       │  COMPANY LOGO                              HEADER    │      │
│       │                                                      │      │
│       │      ┌────────────────────────────────────────┐      │      │
│       │      │                                        │      │      │
│       │      │       Drag the content area            │      │      │
│       │      │       using these handles              │      │      │
│       │      │                                        │      │      │
│       │      └────────────────────────────────────────┘      │      │
│       │  ADDRESS · LEGAL · PAGE NUMBER                       │      │
│       └──────────────────────────────────────────────────────┘      │
│                                                                    │
│ Top  [ 32 mm ]  Right [ 22 mm ]  Bottom [ 25 mm ]  Left [ 22 mm ] │
│ □ Use the continuation area on the first page                      │
│ □ Use the continuation area on the last page                       │
│                                                                    │
│                           [ Back ] [ Preview with real content ]    │
└────────────────────────────────────────────────────────────────────┘
```

The only canvas interaction is resizing and moving one rectangular safe area. Numeric
margin controls are always available for accuracy and keyboard accessibility.

If `$scroll.content` or a supported form-field marker is detected, show a proposed
rectangle with the message **Content area detected — please confirm**. Never save an
unconfirmed automatic detection.

### Step 4 — validate with real document flow

```text
┌────────────────────────────────────────────────────────────────────┐
│ Preview and save                                              4/4 │
├────────────────────────────────────────────────────────────────────┤
│ Preview source [ Current Confluence page ▾ ]                        │
│                                                                    │
│  [ First ]       [ Body 2 ]       [ Body 3 ]       [ Last ]       │
│  thumbnail       thumbnail        thumbnail        thumbnail       │
│                                                                    │
│  ✓ Content stays inside the safe area                              │
│  ✓ Header and footer do not overlap                                │
│  ✓ Table header repeats                                            │
│  ! Background text is decorative and not exposed to screen readers│
│                                                                    │
│ Template name [ Acme Technical Documentation            ]          │
│                                                                    │
│                         [ Back ] [ Save template ] [ Export PDF ]   │
└────────────────────────────────────────────────────────────────────┘
```

Preview should exercise more than the current page:

- a short one-page document;
- a long document that creates at least three body pages;
- a wide and multi-page table;
- code and a vector diagram;
- a page break near the bottom of the content rectangle;
- first, continuation and optional last-page transitions.

This compiler-backed preview is the quality surface. A supplied screenshot is never
trusted as validation evidence.

---

## 7. Minimal template contract

The public API should be versioned before third-party packages are accepted:

```typst
#let render(meta, body, settings: (:)) = {
  // Template page model and style rules.
  body
}
```

Required inputs:

- `meta.title`;
- `meta.space`;
- `meta.version`;
- `meta.author`;
- `meta.language`;
- `meta.exported-at`;
- `body`;
- `settings`.

The engine should own safe default implementations for semantic components such as
callouts and statuses. A template may override documented hooks, but generated content
must not depend on undocumented template-local functions. The current direct imports of
`atlcli-doc`, `callout` and `status-badge` need to become a stable
`wiki.pdf-template/v1` boundary first.

Example manifest:

```json
{
  "schemaVersion": 1,
  "id": "com.acme.tech-doc",
  "name": "Acme Tech Doc",
  "version": "1.0.0",
  "engine": {
    "kind": "typst",
    "api": "wiki.pdf-template/v1",
    "entry": "template.typ"
  },
  "settings": {
    "accent": {
      "type": "color",
      "default": "#0052CC"
    },
    "logo": {
      "type": "asset",
      "accept": ["image/svg+xml", "image/png"]
    },
    "cover": {
      "type": "boolean",
      "default": true
    }
  }
}
```

Stationery-specific geometry belongs in the manifest, not in a magic text replacement:

```json
{
  "page": {
    "width": "210mm",
    "height": "297mm",
    "contentBox": {
      "top": "32mm",
      "right": "22mm",
      "bottom": "25mm",
      "left": "22mm"
    }
  },
  "backgrounds": {
    "first": { "file": "assets/letterhead.pdf", "page": 1 },
    "body": { "file": "assets/letterhead.pdf", "page": 2 },
    "last": null
  }
}
```

---

## 8. Accessibility and PDF standards

An imported PDF page is page artwork, not semantic content.

Typst page backgrounds and foregrounds are not exposed to assistive technology. Tags
from a PDF embedded as an image are not retained in the compiled document. Therefore:

- backgrounds must be treated as decorative;
- meaningful document content must be generated again as semantic Typst content;
- essential address, legal or contact information must not exist only in the background;
- imported backgrounds require explicit checks before claiming PDF/UA or PDF/A;
- the output PDF version must be compatible with the embedded source PDF;
- the final generated PDF must be validated again after composition.

If a requested conformance profile cannot preserve the imported background safely, the
product should explain the incompatibility and require a native Typst template rather
than silently weakening the claim.

---

## 9. Security and reproducibility

Template packages execute only inside the existing isolated compiler environment:

- no remote imports or runtime downloads;
- no access outside the job-scoped virtual filesystem;
- bounded archive, asset, font and output sizes;
- path-traversal rejection;
- deterministic manifest and archive ordering;
- pinned template API and compiler compatibility range;
- font and license inventory;
- diagnostics mapped to template file and line;
- compilation against the canonical feature zoo before import succeeds.

The extension must render its own preview. A package-provided PDF or screenshot is
documentation only and cannot stand in for compilation.

---

## 10. Delivery order

1. Finish and prove the built-in Spec 007 template and export pipeline.
2. Stabilize `wiki.pdf-template/v1` around `render(meta, body, settings)`.
3. Ship two or three curated templates with manifest-generated brand settings.
4. Add Git folder validation and deterministic `.wiki-pdf-template` packaging.
5. Add package import, compiler-backed preview and diagnostics to the PDF tab.
6. Run a separate PDF stationery-import spike.
7. Add the four-step stationery wizard only after the spike proves PDF embedding,
   page-role mapping, flow geometry and accessibility behavior.

Word export remains a separate tab and continues to use `.docx` templates and
`$scroll.*` placeholders. Both formats consume the same semantic `ExportBlock` content,
but their template contracts intentionally remain different.

---

## 11. Explicit non-goals

- No Canva-style design canvas.
- No arbitrary text boxes, shapes, layers or component palette.
- No claim that any uploaded PDF becomes an editable template.
- No hidden OCR-based conversion presented as deterministic.
- No coupling of Word template behavior to the Typst package API.
- No public template marketplace in the first iteration.
- No accessibility claim based solely on the source PDF's tags.

---

## 12. Open product questions

1. Should the first release support organization-distributed packages, personal imports,
   or both?
2. Are custom fonts permitted in browser-local packages, and which license evidence is
   required?
3. Does a last-page background contain flowing content, or is it an appended static page?
4. Should stationery settings allow different content rectangles for odd and even pages?
5. Is an `atlcli.content` PDF form-field marker worth standardizing, or is manual rectangle
   confirmation sufficient?
6. Which PDF/A and PDF/UA profiles, if any, are supported when PDF page artwork is used?

---

## 13. Research basis

- Typst templates are functions wrapping document content:  
  <https://typst.app/docs/tutorial/making-a-template/>
- Typst page backgrounds, headers and footers repeat around flowing body content:  
  <https://typst.app/docs/reference/layout/page/>
- Typst figures remain in flow by default and can optionally float:  
  <https://typst.app/docs/reference/model/figure/>
- Typst accessibility guidance, including embedded PDF limitations:  
  <https://typst.app/docs/guides/accessibility/>
- Fixed PDF templates versus dynamic reflowing templates:  
  <https://www.useanvil.com/docs/api/pdf-templates/>
- Existing PDF as static background with positioned dynamic fields:  
  <https://support.pdfgeneratorapi.com/en/article/how-to-upload-your-existing-pdf-document-as-a-template-o3g0bv/>
- DOCX placeholder and repetition model:  
  <https://carbone.io/documentation/design/overview/template-feature.html>
- DOCX templates as a business-user authoring surface:  
  <https://plumsail.com/docs/documents/v1.x/document-generation/docx-classic/>
- Paged-media flow, page masters and print CSS:  
  <https://www.princexml.com/doc/paged/>
