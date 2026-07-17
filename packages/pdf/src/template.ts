/**
 * Pinned atlcli Typst standard template. It uses semantic Typst elements and
 * show rules so PDF tagging/outline information survives visual styling.
 */
const EDITORIAL_DASH = String.fromCodePoint(0x2013);
const EDITORIAL_BULLET = String.fromCodePoint(0x2022);
const EDITORIAL_NESTED_BULLET = String.fromCodePoint(0x25e6);
const TASK_CHECKED = String.fromCodePoint(0x2713);
const TASK_UNCHECKED = String.fromCodePoint(0x25a1);

export const ATLCLI_TYPST_TEMPLATE = String.raw`
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

#let atlcli-doc(meta: (:), body) = {
  let is-german = meta.at("language", default: "en") == "de"
  let version-label = [Version]
  let exported-label = if is-german { [Exportiert] } else { [Exported] }
  let exporter-label = if is-german { [Exportiert von] } else { [Exported by] }
  let contents-label = if is-german { [Inhalt] } else { [Contents] }
  let end-label = if is-german { [DOKUMENTENDE] } else { [END OF DOCUMENT] }
  let pages-label = if is-german { [Seiten] } else { [Pages] }
  let indigo = rgb("#4B57A3")
  let ink = rgb("#202A44")
  let warm-slate = rgb("#74727A")
  let cover-paper = rgb("#FCFBF8")

  set document(
    title: meta.title,
    author: meta.author,
    date: meta.exported-at,
  )
  set text(
    font: "Source Serif 4",
    size: 10pt,
    fill: rgb("#172B4D"),
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
    paper: "a4",
    fill: cover-paper,
    margin: (top: 23mm, bottom: 20mm, left: 22mm, right: 22mm),
    header: context {
      let current-page = counter(page).get().first()
      let final-page = counter(page).final().first()
      if current-page > 1 and current-page < final-page {
        set text(font: "Source Sans 3", size: 8pt, fill: rgb("#6B778C"))
        grid(columns: (1fr, auto), meta.title, meta.space)
        line(length: 100%, stroke: rgb("#DFE1E6"))
      }
    },
    footer: context {
      if counter(page).get().first() > 1 {
        set text(font: "Source Sans 3", size: 8pt, fill: rgb("#6B778C"))
        align(center)[#counter(page).display("1")]
      }
    },
  )

  show heading.where(level: 1): it => {
    set text(font: "Source Sans 3", size: 18pt, weight: "semibold", fill: rgb("#172B4D"))
    block(above: 28pt, below: 14pt, sticky: true, it)
  }
  show heading.where(level: 2): it => {
    set text(font: "Source Sans 3", size: 14pt, weight: "semibold", fill: rgb("#172B4D"))
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

  v(37mm)
  block(width: 90%)[
    #set text(font: "Source Sans 3")
    #text(size: 8pt, weight: "semibold", tracking: 0.12em, fill: indigo)[CONFLUENCE SPACE / #meta.space]
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
  set page(fill: white)
  outline(title: contents-label, depth: 3)
  pagebreak()
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

// layout is intentionally scoped to the one dense-table paragraph that
// contains adaptive inline values. Ordinary table paragraphs never enter this
// helper and retain the template's normal wrapping and hyphenation behavior.
#let dense-par(body) = layout(size => body(size.width))

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

#let dense-status-badge(available-width, label, color: "#42526E") = {
  let normal = status-badge(label, color: color)
  let compact = status-badge(label, color: color, inset-x: 2pt)
  if measure(normal).width <= available-width {
    normal
  } else if measure(compact).width <= available-width {
    compact
  } else {
    box(
      width: available-width,
      fill: rgb(color).lighten(82%),
      inset: (x: 2pt, y: 2pt),
      radius: 3pt,
    )[
      #set text(
        font: "Source Code Pro",
        size: 7.5pt,
        weight: "bold",
        fill: rgb(color),
        hyphenate: true,
      )
      #set par(linebreaks: "optimized", leading: 0.72em)
      #label
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
