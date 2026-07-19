/**
 * Pinned atlcli Typst standard template. It uses semantic Typst elements and
 * show rules so PDF tagging/outline information survives visual styling.
 *
 * ## `wiki.pdf-template/v1` contract
 *
 * `atlcli-doc(meta, settings, body)` is the built-in implementation of the
 * versioned template surface `render(meta, body, settings)` (TEMPLATE-UX §7).
 * Renaming the symbol is not required — the contract names the *shape*, not the
 * symbol.
 *
 * Required `meta` keys a conforming template may rely on: `title`, `space`,
 * `version`, `author`, `language`, `exported-at` (plus the derived
 * `exporter`, `region`, `exported-label` this engine also supplies).
 *
 * `settings` is a Typst dictionary read *defensively* — every access uses
 * `settings.at("<key>", default: ...)` so sparse dictionaries and older callers
 * that pass no `settings` keep compiling. `settings: (:)` is itself the
 * backward-compatible default. Adding a settings key is non-breaking; removing
 * or renaming one bumps the `engine.api` string.
 *
 * ### Stable v1 import surface (the hook set)
 *
 * `serialize.ts` imports eight symbols from this generated `atlcli.typ`:
 * `atlcli-doc`, `callout`, `status-badge`, `table-par`, `dense-token`,
 * `dense-link`, `dense-status-badge`, `task-item`. All eight are the frozen v1
 * hook set a conforming template must export; generated content may depend on
 * these and no other, undocumented, template-local functions (TEMPLATE-UX §7).
 * Shrinking this set — relocating the five dense-table/table helpers into
 * engine-owned code so an external template overrides fewer hooks — is a
 * deliberate follow-up once a real Level-B template needs it, not part of this
 * contract's first cut.
 */
import { resolvePdfTheme } from "./theme.js";
import type { PdfThemeOptions } from "./types.js";

const EDITORIAL_DASH = String.fromCodePoint(0x2013);
const EDITORIAL_BULLET = String.fromCodePoint(0x2022);
const EDITORIAL_NESTED_BULLET = String.fromCodePoint(0x25e6);
const TASK_CHECKED = String.fromCodePoint(0x2713);
const TASK_UNCHECKED = String.fromCodePoint(0x25a1);

export function createAtlcliTypstTemplate(options: PdfThemeOptions = {}): string {
  const theme = resolvePdfTheme(options);
  return String.raw`
#let editorial-numbering(..nums) = {
  let values = nums.pos()
  let current = values.last()
  let pattern = if values.len() == 1 { "1." } else if values.len() == 2 { "a)" } else { "i." }
  text(
    font: "Source Sans 3",
    size: 0.95em,
    weight: "semibold",
    fill: rgb("#6B778C"),
    numbering(pattern, current),
  )
}

// Rotated text layer drawn under the content via set page(background: ...),
// which makes it a page Artifact in the tagged PDF by Typst's own
// page-background semantics.
#let watermark-layer(wm) = if wm == none { none } else {
  place(center + horizon, rotate(
    wm.at("angle", default: -54) * 1deg,
    text(
      font: "Source Sans 3",
      weight: "bold",
      size: wm.at("size", default: 96) * 1pt,
      fill: rgb(wm.at("color", default: "#DE350B"))
        .transparentize(100% - wm.at("opacity", default: 0.08) * 100%),
      wm.text,
    ),
  ))
}

// wiki.pdf-template/v1 render surface: render(meta, body, settings).
// settings: (:) keeps callers that pass no settings compiling; every settings
// read below must use settings.at("key", default: ...).
#let atlcli-doc(meta: (:), settings: (:), body) = {
  let is-german = meta.at("language", default: "en") == "de"
  let version-label = [Version]
  let exported-label = if is-german { [Exportiert] } else { [Exported] }
  let exporter-label = if is-german { [Exportiert von] } else { [Exported by] }
  let contents-label = if is-german { [Inhalt] } else { [Contents] }
  let end-label = if is-german { [DOKUMENTENDE] } else { [END OF DOCUMENT] }
  let pages-label = if is-german { [Seiten] } else { [Pages] }
  let indigo = rgb(settings.at("accent-color", default: "#4B57A3"))
  let org-name = settings.at("organization-name", default: none)
  let logo-path = settings.at("logo", default: none)
  let logo-alt = settings.at("logo-alt", default: "")
  let space-label = if org-name == none {
    [CONFLUENCE SPACE / #meta.space]
  } else {
    [#upper(org-name) / CONFLUENCE SPACE / #meta.space]
  }
  // Public settings say "letter"; Typst's paper catalog names it "us-letter".
  let page-size = settings.at("page", default: "a4")
  let paper-name = if page-size == "letter" { "us-letter" } else { page-size }
  let ink = rgb("#202A44")
  let warm-slate = rgb("#74727A")
  let cover-paper = rgb("${theme.colors.paper}")

  set document(
    title: meta.title,
    author: meta.author,
    date: meta.exported-at,
  )
  set text(
    font: "Source Serif 4",
    size: 10pt,
    fill: rgb("${theme.colors.ink}"),
    lang: meta.at("language", default: "en"),
    region: meta.at("region", default: none),
  )
  set par(leading: 0.74em, spacing: 10pt, justify: false)
  set list(
    marker: (
      [#text(font: "Source Sans 3", fill: rgb("#6B778C"))[${EDITORIAL_DASH}]],
      [#text(font: "Source Sans 3", fill: rgb("#6B778C"))[${EDITORIAL_BULLET}]],
      [#text(font: "Source Sans 3", fill: rgb("#6B778C"))[${EDITORIAL_NESTED_BULLET}]],
    ),
    body-indent: 0.7em,
    spacing: 8pt,
  )
  set enum(
    numbering: editorial-numbering,
    body-indent: 0.7em,
    spacing: 8pt,
  )
  set page(
    paper: paper-name,
    flipped: settings.at("orientation", default: "portrait") == "landscape",
    fill: cover-paper,
    margin: (top: 23mm, bottom: 20mm, left: 22mm, right: 22mm),
    background: watermark-layer(settings.at("watermark", default: none)),
    header: context {
      let current-page = counter(page).get().first()
      let final-page = counter(page).final().first()
      if current-page > 1 and current-page < final-page {
        set text(font: "Source Sans 3", size: 8pt, fill: rgb("#6B778C"))
        let header-text = settings.at("header-text", default: none)
        if header-text == none {
          grid(columns: (1fr, auto), meta.title, meta.space)
        } else {
          header-text
        }
        line(length: 100%, stroke: rgb("#DFE1E6"))
      }
    },
    footer: context {
      if counter(page).get().first() > 1 {
        set text(font: "Source Sans 3", size: 8pt, fill: rgb("#6B778C"))
        let footer-text = settings.at("footer-text", default: none)
        if footer-text == none and org-name == none {
          align(center)[#counter(page).display("1")]
        } else {
          grid(
            columns: (1fr, auto, 1fr),
            align(left, if footer-text == none [] else { footer-text }),
            align(center)[#counter(page).display("1")],
            align(right, if org-name == none [] else { org-name }),
          )
        }
      }
    },
  )

  show heading.where(level: 1): it => {
    set text(font: "Source Sans 3", size: 18pt, weight: "semibold", fill: rgb("${theme.colors.ink}"))
    block(above: 28pt, below: 14pt, sticky: true, it)
  }
  show heading.where(level: 2): it => {
    set text(font: "Source Sans 3", size: 14pt, weight: "semibold", fill: rgb("${theme.colors.ink}"))
    block(above: 24pt, below: 12pt, sticky: true, it)
  }
  show heading.where(level: 3): it => {
    set text(font: "Source Sans 3", size: 11.5pt, weight: "semibold", fill: rgb("#253858"))
    block(above: 18pt, below: 8pt, sticky: true, it)
  }
  show raw.where(block: true): it => block(
    fill: rgb("#F4F5F7"),
    inset: 9pt,
    radius: 4pt,
    width: 100%,
    text(font: "Source Code Pro", size: 8.5pt, it),
  )
  show table.cell: it => {
    set text(font: "Source Sans 3", size: 9pt, hyphenate: true)
    set par(linebreaks: "optimized")
    it
  }

  if settings.at("cover", default: true) {
    v(37mm)
    block(width: 90%)[
      #set text(font: "Source Sans 3")
      #if logo-path != none [
        #block(below: 18pt)[#image(logo-path, height: 12mm, width: 45mm, fit: "contain", alt: logo-alt)]
      ]
      #text(size: 8pt, weight: "semibold", tracking: 0.12em, fill: indigo, space-label)
      #v(17pt)
      #block(width: 100%)[
        #set par(leading: 0.98em)
        #text(font: "Source Serif 4", size: 31pt, weight: "semibold", fill: ink)[#meta.title]
      ]
      #v(25pt)
      #line(length: 52mm, stroke: 0.9pt + indigo)
      #v(23pt)
      #grid(
        columns: (30mm, 1fr),
        column-gutter: 12pt,
        row-gutter: 8pt,
        text(size: 7.5pt, weight: "semibold", tracking: 0.08em, fill: warm-slate, upper(version-label)),
        text(size: 9.5pt, fill: ink, meta.version),
        text(size: 7.5pt, weight: "semibold", tracking: 0.08em, fill: warm-slate, upper(exported-label)),
        text(size: 9.5pt, fill: ink, meta.exported-label),
        text(size: 7.5pt, weight: "semibold", tracking: 0.08em, fill: warm-slate, upper(exporter-label)),
        text(size: 9.5pt, fill: ink, meta.exporter),
      )
    ]
    pagebreak()
  }
  set page(fill: white)
  if settings.at("outline", default: true) {
    outline(title: contents-label, depth: 3)
    pagebreak()
  }
  body
  pagebreak()
  set page(fill: cover-paper)
  v(57mm)
  block(width: 82%)[
    #set text(font: "Source Sans 3")
    #text(size: 8pt, weight: "semibold", tracking: 0.14em, fill: indigo)[#end-label]
    #v(14pt)
    #block(width: 100%)[
      #set par(leading: 1.02em)
      #text(font: "Source Serif 4", size: 24pt, weight: "semibold", fill: ink)[#meta.title]
    ]
    #v(22pt)
    #line(length: 52mm, stroke: 0.9pt + indigo)
    #v(22pt)
    #grid(
      columns: (30mm, 1fr),
      column-gutter: 12pt,
      row-gutter: 8pt,
      text(size: 7.5pt, weight: "semibold", tracking: 0.08em, fill: warm-slate, upper(version-label)),
      text(size: 9.5pt, fill: ink, meta.version),
      text(size: 7.5pt, weight: "semibold", tracking: 0.08em, fill: warm-slate, upper(exported-label)),
      text(size: 9.5pt, fill: ink, meta.exported-label),
      text(size: 7.5pt, weight: "semibold", tracking: 0.08em, fill: warm-slate, upper(pages-label)),
      context text(size: 9.5pt, fill: ink, str(counter(page).final().first())),
    )
    #v(24pt)
    #text(size: 8.5pt, fill: warm-slate)[
      #if is-german { [Erzeugt aus Confluence mit] } else { [Generated from Confluence with] }
      #link("https://atlcli.sh/")[#text(weight: "semibold", fill: indigo)[atlcli]]
    ]
  ]
}

#let callout(kind: "info", title: none, body) = {
  let palette = (
    info: (rgb("#DEEBFF"), rgb("#0747A6")),
    note: (rgb("#EAE6FF"), rgb("#403294")),
    warning: (rgb("#FFFAE6"), rgb("#974F0C")),
    tip: (rgb("#E3FCEF"), rgb("#006644")),
    panel: (rgb("#F4F5F7"), rgb("#42526E")),
  )
  let colors = palette.at(kind, default: palette.panel)
  block(
    width: 100%,
    fill: colors.first(),
    stroke: (left: 3pt + colors.last()),
    inset: (x: 11pt, y: 9pt),
    radius: (right: 4pt),
    above: 6pt,
    below: 8pt,
  )[
    #set text(font: "Source Sans 3")
    #if title != none { text(weight: "semibold", fill: colors.last(), title); linebreak() }
    #body
  ]
}

#let status-badge(label, color: "#42526E", inset-x: 5pt) = box(
  fill: rgb(color).lighten(82%),
  inset: (x: inset-x, y: 2pt),
  radius: 3pt,
  text(font: "Source Code Pro", size: 7.5pt, weight: "bold", fill: rgb(color), label),
)

// Every table paragraph receives its real content width. Narrow cells switch
// to the simple breaker; wider cells retain the document's optimized breaker.
// 18mm approximates the usable width of one track at the existing nine-column
// dense-table boundary after cell insets.
#let table-par(body) = layout(size => {
  if size.width <= 18mm { set par(linebreaks: "simple") }
  body(size.width)
})

// Preserve the original token whenever it fits. Only an actually over-wide
// token receives rendering-only emergency break opportunities.
#let dense-token(available-width, normal, breakable) = {
  if measure(normal).width <= available-width { normal } else { breakable }
}

#let dense-link(available-width, target, full-label, compact-label, host-label) = {
  let full = text(full-label)
  let compact = text(compact-label)
  let host = text(host-label)
  let visible = if measure(full).width <= available-width {
    full
  } else if measure(compact).width <= available-width {
    compact
  } else {
    host
  }
  link(target, visible)
}

#let dense-status-badge(available-width, label, breakable-label, color: "#42526E") = {
  let normal = status-badge(label, color: color)
  let compact = status-badge(label, color: color, inset-x: 2pt)
  if measure(normal).width <= available-width {
    normal
  } else if measure(compact).width <= available-width {
    compact
  } else {
    box(
      // Typst adds horizontal inset outside an explicit box width. Subtract it
      // so the fallback badge's painted bounds never exceed the table track.
      width: available-width - 2pt,
      fill: rgb(color).lighten(82%),
      inset: (x: 1pt, y: 2pt),
      radius: 3pt,
    )[
      #set text(
        font: "Source Code Pro",
        size: 7.5pt,
        weight: "bold",
        fill: rgb(color),
        hyphenate: true,
      )
      #set par(linebreaks: "simple", leading: 0.72em)
      #breakable-label
    ]
  }
}

#let task-item(checked, body) = grid(
  columns: (1.05em, 1fr),
  column-gutter: 0.45em,
  align: top,
  text(
    font: "Source Sans 3",
    size: 8.5pt,
    weight: "semibold",
    fill: rgb(if checked { "#0052CC" } else { "#6B778C" }),
    if checked { "${TASK_CHECKED}" } else { "${TASK_UNCHECKED}" },
  ),
  body,
)
`;
}

export const ATLCLI_TYPST_TEMPLATE = createAtlcliTypstTemplate();
