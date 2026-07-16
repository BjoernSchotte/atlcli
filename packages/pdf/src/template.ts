/**
 * Pinned atlcli Typst standard template. It uses semantic Typst elements and
 * show rules so PDF tagging/outline information survives visual styling.
 */
export const ATLCLI_TYPST_TEMPLATE = String.raw`
#let atlcli-doc(meta: (:), body) = {
  set document(
    title: meta.title,
    author: meta.author,
    date: meta.exported-at,
  )
  set text(font: "Inter", size: 10pt, fill: rgb("#172B4D"))
  set par(leading: 0.68em, justify: false)
  set page(
    paper: "a4",
    margin: (top: 23mm, bottom: 20mm, left: 22mm, right: 22mm),
    header: context {
      if counter(page).get().first() > 1 {
        set text(size: 8pt, fill: rgb("#6B778C"))
        grid(columns: (1fr, auto), meta.title, meta.space)
        line(length: 100%, stroke: rgb("#DFE1E6"))
      }
    },
    footer: context {
      set text(size: 8pt, fill: rgb("#6B778C"))
      align(center)[#counter(page).display("1")]
    },
  )

  show heading.where(level: 1): it => {
    set text(size: 18pt, weight: "semibold", fill: rgb("#172B4D"))
    block(above: 18pt, below: 8pt, it)
  }
  show heading.where(level: 2): it => {
    set text(size: 14pt, weight: "semibold", fill: rgb("#172B4D"))
    block(above: 14pt, below: 6pt, it)
  }
  show heading.where(level: 3): it => {
    set text(size: 11.5pt, weight: "semibold", fill: rgb("#253858"))
    block(above: 10pt, below: 4pt, it)
  }
  show raw.where(block: true): it => block(
    fill: rgb("#F4F5F7"),
    inset: 9pt,
    radius: 4pt,
    width: 100%,
    text(font: "JetBrains Mono", size: 8.5pt, it),
  )
  show table.cell: it => {
    set text(size: 9pt)
    it
  }

  align(center + horizon)[
    #block(width: 82%)[
      #text(size: 30pt, weight: "semibold", fill: rgb("#172B4D"))[#meta.title]
      #v(12pt)
      #text(size: 11pt, fill: rgb("#6B778C"))[#meta.space]
      #v(24pt)
      #line(length: 72pt, stroke: 2pt + rgb("#0052CC"))
      #v(24pt)
      #grid(
        columns: (auto, 1fr),
        column-gutter: 12pt,
        row-gutter: 5pt,
        [*Version*], [#meta.version],
        [*Exported*], [#meta.exported-label],
        [*Exporter*], [#meta.exporter],
      )
    ]
  ]
  pagebreak()
  outline(title: [Contents], depth: 3)
  pagebreak()
  body
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
    #if title != none { text(weight: "semibold", fill: colors.last(), title); linebreak() }
    #body
  ]
}

#let status-badge(label, color: "#42526E") = box(
  fill: rgb(color).lighten(82%),
  inset: (x: 5pt, y: 2pt),
  radius: 3pt,
  text(size: 7.5pt, weight: "semibold", fill: rgb(color), label),
)
`;
