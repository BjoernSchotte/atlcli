/**
 * Pinned atlcli Typst standard template. It uses semantic Typst elements and
 * show rules so PDF tagging/outline information survives visual styling.
 *
 * ## `wiki.pdf-template/v1` contract
 *
 * `atlcli-doc(meta, settings, body)` is the built-in implementation of the
 * versioned template surface `render(meta, body, settings)` (TEMPLATE-UX §7).
 *
 * ## Fully declarative presentation (spec 012)
 *
 * This file authors **no presentation literal** any more. `createAtlcliTypstTemplate`
 * is a function of a validated `WikiPdfTemplateDesignV1`: static design
 * (typography roles, color tokens, semantic palettes, component spacing) is
 * interpolated into the generated Typst when the template string is built, and
 * the settings-driven subset (accent, organization name, page size/orientation,
 * cover/outline) plus the localized labels are read from the emitted
 * `settings.design` / `settings.labels` dict at Typst runtime. The engine code
 * here is a *consumer* of design values, never their author — so a second
 * curated template is a different manifest, not a fork of this file.
 *
 * `settings` is still read defensively: every `settings.at("design"/"labels", …)`
 * read falls back to the built-in's own values interpolated at generation time,
 * so `settings: (:)` keeps compiling (the 007 backward-compatibility contract).
 *
 * ### Stable v1 import surface (the hook set)
 *
 * `serialize.ts` imports eight symbols from this generated `atlcli.typ`:
 * `atlcli-doc`, `callout`, `status-badge`, `table-par`, `dense-token`,
 * `dense-link`, `dense-status-badge`, `task-item`. All eight are the frozen v1
 * hook set a conforming template must export.
 */
import {
  BUILTIN_PDF_DESIGN,
  BUILTIN_PDF_FALLBACK_LABELS,
} from "./builtin-template.js";
import type {
  WikiPdfTemplateDesignV1,
  WikiPdfTemplateImageDecorationV1,
  WikiPdfTemplatePageBorderV1,
} from "@atlcli/template-pack";
import {
  projectPdfDesignThroughCatalog,
  readPdfDesignCapability,
} from "./design-catalog.js";
import { typstString } from "./escape.js";
import type { PdfTemplateVisualsV1 } from "./template-pack.js";

const EDITORIAL_DASH = String.fromCodePoint(0x2013);
const EDITORIAL_BULLET = String.fromCodePoint(0x2022);
const EDITORIAL_NESTED_BULLET = String.fromCodePoint(0x25e6);
const TASK_CHECKED = String.fromCodePoint(0x2713);
const TASK_UNCHECKED = String.fromCodePoint(0x25a1);
const SYMBOL_FALLBACK_FONTS = ["Noto Sans Symbols2", "Noto Emoji"] as const;

/**
 * Generate the pinned Typst template for a design. All presentation values come
 * from `design`; a missing key throws a clear error here rather than producing
 * an `undefined` token that would fail the Typst compile.
 */
export function createAtlcliTypstTemplate(
  design: WikiPdfTemplateDesignV1 = BUILTIN_PDF_DESIGN,
  labels: Record<string, string> = BUILTIN_PDF_FALLBACK_LABELS,
  visuals?: PdfTemplateVisualsV1
): string {
  const catalogDesign = projectPdfDesignThroughCatalog(design);
  const fonts = catalogDesign.typography.fonts;
  const roles = catalogDesign.typography.roles;
  const colors = catalogDesign.tokens.colors;
  const layout = catalogDesign.tokens.layout;
  const ratios = catalogDesign.tokens.ratios;
  const callouts = catalogDesign.semanticPalettes.callouts;
  const margin = catalogDesign.page.margin;

  const need = <T>(map: Record<string, T>, key: string, kind: string): T => {
    const value = map[key];
    if (value === undefined) throw new Error(`PDF template design is missing ${kind} "${key}"`);
    return value;
  };
  const L = (key: string): string => need(layout, key, "layout length");
  const C = (key: string): string => need(colors, key, "color token");
  const RN = (key: string): number => need(ratios, key, "ratio");
  const F = (role: "body" | "heading" | "mono"): string => fonts[role];
  const fontStack = (font: string): string =>
    `(${[font, ...SYMBOL_FALLBACK_FONTS].map(typstString).join(", ")})`;
  const roleOf = (key: string) => need(roles, key, "typography role");
  const rsize = (key: string): string => roleOf(key).size;
  const rweight = (key: string): string => {
    const weight = roleOf(key).weight;
    if (weight === undefined) throw new Error(`PDF template role "${key}" is missing a weight`);
    return weight;
  };
  const rtrack = (key: string): string => {
    const tracking = roleOf(key).tracking;
    if (tracking === undefined) throw new Error(`PDF template role "${key}" is missing tracking`);
    return tracking;
  };
  const roleFont = (key: string): string => {
    const font = roleOf(key).font;
    if (font === undefined) throw new Error(`PDF template role "${key}" is missing a font`);
    return F(font);
  };
  const callout = (kind: keyof typeof callouts): { bg: string; fg: string } => {
    const palette = need(callouts, kind as string, "callout palette");
    return { bg: palette.background, fg: palette.foreground };
  };
  const label = (key: string): string => labels[key] ?? "";

  // Gen-time defaults for the settings-driven subset (backward-compat with
  // `settings: (:)`); overridden at runtime by the emitted `settings.design`.
  const accentDefault = catalogDesign.branding.accent;
  const pageDefault = catalogDesign.page.size;
  const orientDefault = catalogDesign.page.orientation;
  const coverDefault = catalogDesign.features.cover.enabled ? "true" : "false";
  const outlineDefault = catalogDesign.features.outline.enabled ? "true" : "false";
  const outlineDepthDefault = catalogDesign.features.outline.depth;

  // Running-head mode. This is static design (not settings-driven), so it is
  // resolved and interpolated when the template string is generated: the
  // `chapter` branch is EMITTED ONLY for a chapter-mode design, which is what
  // keeps the default (`title`) path character-identical to the pre-feature
  // template and therefore byte-identical in the compiled PDF.
  //
  // `title` and `custom` generate the same source on purpose: an explicit
  // `header-text` setting wins in every mode (007 behavior, unchanged), so
  // `custom` declares the template's intent and falls back to the title when no
  // `headerText` is supplied.
  const headerMode = readPdfDesignCapability<string>(
    catalogDesign,
    "features.header.mode"
  );
  const headerResolution =
    headerMode === "chapter"
      ? String.raw`          // Chapter running head ("Kolumnentitel"): the level-1 heading that owns
          // this page. Three decisions are load-bearing here; all three were
          // verified against the pinned compiler, none is an assumption:
          //   1. OPEN-ON-PAGE. here() inside a page header resolves to the TOP
          //      of the page, so a before-here selector EXCLUDES a chapter that
          //      opens on this very page and lags one page behind at every
          //      chapter opening. Comparing page indices is what fixes that, so
          //      the == branch below must keep matching this page's own page
          //      index — never a strictly-before comparison.
          //   2. OUTLINED FILTER. The table of contents renders its own level-1
          //      heading, so an unfiltered query names the whole document
          //      "Contents". That heading is the only one with outlined: false,
          //      and "appears in the table of contents" is exactly what a
          //      chapter is.
          //   3. FIRST ON PAGE. When SEVERAL chapters begin on one page the head
          //      names the FIRST of them, not the last. The head sits at the top
          //      of the page and the content immediately below it starts with
          //      that first chapter; naming a later one contradicts what the
          //      reader sees. This is also what Word's STYLEREF field does by
          //      default (search the page top-down, take the first match; if the
          //      style is absent from the page, fall back to the one still
          //      running) — its \l switch is what reverses the on-page search to
          //      bottom-up and yields the last. For the normal case — at most one
          //      chapter per page, which is what composeChapters produces with
          //      its default per-chapter pageBreak — first and last are the same
          //      heading, so this refinement is a no-op there (pinned by the
          //      approved one-chapter-per-page byte-stability fixture).
          // Front matter (no chapter heading yet) falls back to the document
          // title, never to an empty head.
          let chapters = query(heading.where(level: 1)).filter(h => h.outlined)
          let opening = chapters.filter(h => h.location().page() == here().page())
          let running = chapters.filter(h => h.location().page() < here().page())
          let chapter-head = if opening.len() > 0 { atlcli-outline-title.at(opening.first().location()) } else if running.len() > 0 { atlcli-outline-title.at(running.last().location()) } else { meta.title }
          grid(columns: (1fr, auto), chapter-head, meta.space)`
      : String.raw`          grid(columns: (1fr, auto), meta.title, meta.space)`;

  const info = callout("info");
  const note = callout("note");
  const warning = callout("warning");
  const tip = callout("tip");
  // New semantic roles remain backward compatible with existing v1 template
  // manifests: success inherits tip and error inherits warning when omitted.
  const success = callouts.success ? callout("success") : tip;
  const error = callouts.error ? callout("error") : warning;
  const panel = callout("panel");
  const hasDecorations = (visuals?.decorations.length ?? 0) > 0;
  const visualSource = hasDecorations
    ? `\n\n${typstVisualSource(visuals)}\n\n`
    : "\n\n";
  const pageBackgroundSource = hasDecorations
    ? `context {
      watermark-layer(settings.at("watermark", default: none))
      template-page-decorations()
    }`
    : 'watermark-layer(settings.at("watermark", default: none))';
  const headerDecorationSource = hasDecorations
    ? "\n      template-header-decorations()"
    : "";
  const footerDecorationSource = hasDecorations
    ? "\n      template-footer-decorations()"
    : "";

  return String.raw`
#let editorial-numbering(..nums) = {
  let values = nums.pos()
  let current = values.last()
  let pattern = if values.len() == 1 { "1." } else if values.len() == 2 { "a)" } else { "i." }
  text(
    font: ${fontStack(F("heading"))},
    size: ${rsize("numbering")},
    weight: "${rweight("numbering")}",
    fill: rgb("${C("muted")}"),
    numbering(pattern, current),
  )
}

// Keep the document heading's rich inline presentation separate from the
// plain navigation label used by outlines and running heads. Typst's default
// outline entry reuses the heading body verbatim, which would otherwise copy
// Confluence highlights and foreground colors into the table of contents.
#let atlcli-outline-title = state("atlcli-outline-title", none)

// Rotated text layer drawn under the content via set page(background: ...),
// which makes it a page Artifact in the tagged PDF by Typst's own
// page-background semantics. The watermark dictionary is always fully
// populated by the resolver, so no per-field defaults are needed here.
#let watermark-layer(wm) = if wm == none { none } else {
  place(center + horizon, rotate(
    wm.angle * 1deg,
    text(
      font: ${fontStack(F("heading"))},
      weight: "bold",
      size: wm.size * 1pt,
      fill: rgb(wm.color)
        .transparentize(100% - wm.opacity * 100%),
      wm.text,
    ),
  ))
}${visualSource}// wiki.pdf-template/v1 render surface: render(meta, body, settings).
// settings: (:) keeps callers that pass no settings compiling; every settings
// read below falls back to a built-in default interpolated at generation time.
#let atlcli-doc(meta: (:), settings: (:), body) = {
  let design = settings.at("design", default: (:))
  let labels = settings.at("labels", default: (:))
  let brand = design.at("branding", default: (:))
  let page-config = design.at("page", default: (:))
  let features = design.at("features", default: (:))
  let cover-config = features.at("cover", default: (:))
  let outline-config = features.at("outline", default: (:))

  let version-label = labels.at("version", default: ${typstString(label("version"))})
  let exported-label = labels.at("exported", default: ${typstString(label("exported"))})
  let exporter-label = labels.at("exporter", default: ${typstString(label("exporter"))})
  let contents-label = labels.at("contents", default: ${typstString(label("contents"))})
  let end-label = labels.at("endOfDocument", default: ${typstString(label("endOfDocument"))})
  let pages-label = labels.at("pages", default: ${typstString(label("pages"))})
  let space-prefix = labels.at("spacePrefix", default: ${typstString(label("spacePrefix"))})
  let generated-with = labels.at("generatedWith", default: ${typstString(label("generatedWith"))})

  let indigo = rgb(brand.at("accent", default: "${accentDefault}"))
  let org-name = brand.at("organization-name", default: none)
  let logo-path = settings.at("logo", default: none)
  let logo-alt = settings.at("logo-alt", default: "")
  let space-label = if org-name == none {
    [#space-prefix / #meta.space]
  } else {
    [#upper(org-name) / #space-prefix / #meta.space]
  }
  // Public settings say "letter"; Typst's paper catalog names it "us-letter".
  let page-size = page-config.at("size", default: "${pageDefault}")
  let paper-name = if page-size == "letter" { "us-letter" } else { page-size }
  let ink = rgb("${C("coverTitleInk")}")
  let warm-slate = rgb("${C("warmSlate")}")
  let cover-paper = rgb("${C("paper")}")

  set document(
    title: meta.title,
    author: meta.author,
    date: meta.exported-at,
  )
  set text(
    font: ${fontStack(F("body"))},
    size: ${rsize("body")},
    fill: rgb("${C("ink")}"),
    lang: meta.at("language", default: "en"),
    region: meta.at("region", default: none),
  )
  set par(leading: ${L("paragraphLeading")}, spacing: ${L("paragraphSpacing")}, justify: false)
  set list(
    marker: (
      [#text(font: ${fontStack(F("heading"))}, fill: rgb("${C("muted")}"))[${EDITORIAL_DASH}]],
      [#text(font: ${fontStack(F("heading"))}, fill: rgb("${C("muted")}"))[${EDITORIAL_BULLET}]],
      [#text(font: ${fontStack(F("heading"))}, fill: rgb("${C("muted")}"))[${EDITORIAL_NESTED_BULLET}]],
    ),
    body-indent: ${L("listBodyIndent")},
    spacing: ${L("listSpacing")},
  )
  set enum(
    numbering: editorial-numbering,
    body-indent: ${L("enumBodyIndent")},
    spacing: ${L("enumSpacing")},
  )
  set page(
    paper: paper-name,
    flipped: page-config.at("orientation", default: "${orientDefault}") == "landscape",
    fill: cover-paper,
    margin: (top: ${margin.top}, bottom: ${margin.bottom}, left: ${margin.left}, right: ${margin.right}),
    background: ${pageBackgroundSource},
    header: context {${headerDecorationSource}
      let current-page = counter(page).get().first()
      let final-page = counter(page).final().first()
      if current-page > 1 and current-page < final-page {
        set text(font: ${fontStack(F("heading"))}, size: ${rsize("runningHead")}, fill: rgb("${C("muted")}"))
        let header-text = settings.at("header-text", default: none)
        if header-text == none {
${headerResolution}
        } else {
          header-text
        }
        line(length: 100%, stroke: rgb("${C("hairline")}"))
      }
    },
    footer: context {${footerDecorationSource}
      if counter(page).get().first() > 1 {
        set text(font: ${fontStack(F("heading"))}, size: ${rsize("runningHead")}, fill: rgb("${C("muted")}"))
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
    set text(font: ${fontStack(F("heading"))}, size: ${rsize("h1")}, weight: "${rweight("h1")}", fill: rgb("${C("ink")}"))
    block(above: ${L("h1Above")}, below: ${L("h1Below")}, sticky: true, it)
  }
  show heading.where(level: 2): it => {
    set text(font: ${fontStack(F("heading"))}, size: ${rsize("h2")}, weight: "${rweight("h2")}", fill: rgb("${C("ink")}"))
    block(above: ${L("h2Above")}, below: ${L("h2Below")}, sticky: true, it)
  }
  show heading.where(level: 3): it => {
    set text(font: ${fontStack(F("heading"))}, size: ${rsize("h3")}, weight: "${rweight("h3")}", fill: rgb("${C("heading3")}"))
    block(above: ${L("h3Above")}, below: ${L("h3Below")}, sticky: true, it)
  }
  show raw.where(block: false): it => box(
    fill: rgb("${C("codeBackground")}"),
    inset: (x: ${L("inlineCodeInsetX")}, y: ${L("inlineCodeInsetY")}),
    radius: ${L("inlineCodeRadius")},
    text(font: ${fontStack(F("mono"))}, size: ${rsize("code")}, it),
  )
  show raw.where(block: true): it => block(
    fill: rgb("${C("codeBackground")}"),
    inset: ${L("codeInset")},
    radius: ${L("codeRadius")},
    width: 100%,
    text(font: ${fontStack(F("mono"))}, size: ${rsize("code")}, it),
  )
  show table.cell: it => {
    set text(font: ${fontStack(F("heading"))}, size: ${rsize("tableCell")}, hyphenate: true)
    set par(linebreaks: "optimized")
    it
  }

  if cover-config.at("enabled", default: ${coverDefault}) {
    v(${L("coverTopPad")})
    block(width: ${RN("coverBlockWidth")}%)[
      #set text(font: ${fontStack(F("heading"))})
      #if logo-path != none [
        #block(below: ${L("coverLogoBelow")})[#image(logo-path, height: ${L("coverLogoHeight")}, width: ${L("coverLogoWidth")}, fit: "contain", alt: logo-alt)]
      ]
      #text(size: ${rsize("coverEyebrow")}, weight: "${rweight("coverEyebrow")}", tracking: ${rtrack("coverEyebrow")}, fill: indigo, space-label)
      #v(${L("coverEyebrowGap")})
      #block(width: 100%)[
        #set par(leading: ${L("coverTitleLeading")})
        #text(font: ${fontStack(roleFont("coverTitle"))}, size: ${rsize("coverTitle")}, weight: "${rweight("coverTitle")}", fill: ink)[#meta.title]
      ]
      #v(${L("coverTitleGap")})
      #line(length: ${L("coverRuleLength")}, stroke: ${L("coverRuleStroke")} + indigo)
      #v(${L("coverMetaGap")})
      #grid(
        columns: (${L("coverMetaColLabel")}, 1fr),
        column-gutter: ${L("coverMetaColGutter")},
        row-gutter: ${L("coverMetaRowGutter")},
        text(size: ${rsize("coverMetaLabel")}, weight: "${rweight("coverMetaLabel")}", tracking: ${rtrack("coverMetaLabel")}, fill: warm-slate, upper(version-label)),
        text(size: ${rsize("coverMetaValue")}, fill: ink, meta.version),
        text(size: ${rsize("coverMetaLabel")}, weight: "${rweight("coverMetaLabel")}", tracking: ${rtrack("coverMetaLabel")}, fill: warm-slate, upper(exported-label)),
        text(size: ${rsize("coverMetaValue")}, fill: ink, meta.exported-label),
        text(size: ${rsize("coverMetaLabel")}, weight: "${rweight("coverMetaLabel")}", tracking: ${rtrack("coverMetaLabel")}, fill: warm-slate, upper(exporter-label)),
        text(size: ${rsize("coverMetaValue")}, fill: ink, meta.exporter),
      )
    ]
    pagebreak()
  }
  set page(fill: white)
  if outline-config.at("enabled", default: ${outlineDefault}) {
    show outline.entry: it => context {
      let title = atlcli-outline-title.at(it.element.location())
      link(
        it.element.location(),
        it.indented(it.prefix(), [
          #title
          #box(width: 1fr, it.fill)
          #it.page()
        ]),
      )
    }
    outline(title: contents-label, depth: outline-config.at("depth", default: ${outlineDepthDefault}))
    pagebreak()
  }
  body
  pagebreak()
  set page(fill: cover-paper)
  v(${L("closingTopPad")})
  block(width: ${RN("closingBlockWidth")}%)[
    #set text(font: ${fontStack(F("heading"))})
    #text(size: ${rsize("closingEyebrow")}, weight: "${rweight("closingEyebrow")}", tracking: ${rtrack("closingEyebrow")}, fill: indigo)[#end-label]
    #v(${L("closingEyebrowGap")})
    #block(width: 100%)[
      #set par(leading: ${L("closingTitleLeading")})
      #text(font: ${fontStack(roleFont("closingTitle"))}, size: ${rsize("closingTitle")}, weight: "${rweight("closingTitle")}", fill: ink)[#meta.title]
    ]
    #v(${L("closingTitleGap")})
    #line(length: ${L("closingRuleLength")}, stroke: ${L("closingRuleStroke")} + indigo)
    #v(${L("closingMetaGap")})
    #grid(
      columns: (${L("coverMetaColLabel")}, 1fr),
      column-gutter: ${L("coverMetaColGutter")},
      row-gutter: ${L("coverMetaRowGutter")},
      text(size: ${rsize("closingMetaLabel")}, weight: "${rweight("closingMetaLabel")}", tracking: ${rtrack("closingMetaLabel")}, fill: warm-slate, upper(version-label)),
      text(size: ${rsize("closingMetaValue")}, fill: ink, meta.version),
      text(size: ${rsize("closingMetaLabel")}, weight: "${rweight("closingMetaLabel")}", tracking: ${rtrack("closingMetaLabel")}, fill: warm-slate, upper(exported-label)),
      text(size: ${rsize("closingMetaValue")}, fill: ink, meta.exported-label),
      text(size: ${rsize("closingMetaLabel")}, weight: "${rweight("closingMetaLabel")}", tracking: ${rtrack("closingMetaLabel")}, fill: warm-slate, upper(pages-label)),
      context text(size: ${rsize("closingMetaValue")}, fill: ink, str(counter(page).final().first())),
    )
    #v(${L("closingColophonGap")})
    #text(size: ${rsize("colophon")}, fill: warm-slate)[
      #generated-with
      #link("https://atlcli.sh/")[#text(weight: "semibold", fill: indigo)[atlcli]]
    ]
  ]
}

#let callout(kind: "info", title: none, custom_color: none, icon: none, icon_alt: none, body) = {
  let palette = (
    info: (rgb("${info.bg}"), rgb("${info.fg}")),
    note: (rgb("${note.bg}"), rgb("${note.fg}")),
    warning: (rgb("${warning.bg}"), rgb("${warning.fg}")),
    tip: (rgb("${tip.bg}"), rgb("${tip.fg}")),
    success: (rgb("${success.bg}"), rgb("${success.fg}")),
    error: (rgb("${error.bg}"), rgb("${error.fg}")),
    panel: (rgb("${panel.bg}"), rgb("${panel.fg}")),
  )
  let colors = palette.at(kind, default: palette.panel)
  let background = if custom_color == none { colors.first() } else { custom_color.lighten(85%) }
  let foreground = if custom_color == none { colors.last() } else { custom_color }
  block(
    width: 100%,
    fill: background,
    stroke: (left: ${L("calloutStroke")} + foreground),
    inset: (x: ${L("calloutInsetX")}, y: ${L("calloutInsetY")}),
    radius: (right: ${L("calloutRadius")}),
    above: ${L("calloutAbove")},
    below: ${L("calloutBelow")},
  )[
    #set text(font: ${fontStack(F("heading"))})
    #if icon != none {
      let styled-icon = text(weight: "semibold", fill: foreground, icon)
      if icon_alt == none {
        styled-icon
      } else {
        box(figure(styled-icon, alt: icon_alt, outlined: false))
      }
      h(${L("calloutIconGap")})
    }
    #if title != none { text(weight: "semibold", fill: foreground, title); linebreak() }
    #body
  ]
}

#let status-badge(label, color: "${C("neutral")}", inset-x: ${L("statusBadgeInsetX")}) = box(
  fill: rgb(color).lighten(${RN("statusBadgeLighten")}%),
  inset: (x: inset-x, y: ${L("statusBadgeInsetY")}),
  radius: ${L("statusBadgeRadius")},
  text(font: ${fontStack(F("mono"))}, size: ${rsize("statusBadge")}, weight: "${rweight("statusBadge")}", fill: rgb(color), label),
)

// Every table paragraph receives its real content width. Narrow cells switch
// to the simple breaker; wider cells retain the document's optimized breaker.
#let table-par(body) = layout(size => {
  if size.width <= ${L("denseTableThreshold")} { set par(linebreaks: "simple") }
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

#let dense-status-badge(available-width, label, breakable-label, color: "${C("neutral")}") = {
  let normal = status-badge(label, color: color)
  let compact = status-badge(label, color: color, inset-x: ${L("denseBadgeCompactInsetX")})
  if measure(normal).width <= available-width {
    normal
  } else if measure(compact).width <= available-width {
    compact
  } else {
    box(
      // Typst adds horizontal inset outside an explicit box width. Subtract it
      // so the fallback badge's painted bounds never exceed the table track.
      width: available-width - ${L("denseBadgeWidthAdjust")},
      fill: rgb(color).lighten(${RN("statusBadgeLighten")}%),
      inset: (x: ${L("denseBadgeInsetX")}, y: ${L("denseBadgeInsetY")}),
      radius: ${L("denseBadgeRadius")},
    )[
      #set text(
        font: ${fontStack(F("mono"))},
        size: ${rsize("statusBadge")},
        weight: "${rweight("statusBadge")}",
        fill: rgb(color),
        hyphenate: true,
      )
      #set par(linebreaks: "simple", leading: ${L("denseBadgeLeading")})
      #breakable-label
    ]
  }
}

#let task-item(checked, body) = grid(
  columns: (${L("taskGridMarker")}, 1fr),
  column-gutter: ${L("taskGridGutter")},
  align: top,
  text(
    font: ${fontStack(F("heading"))},
    size: ${rsize("taskMarker")},
    weight: "${rweight("taskMarker")}",
    fill: rgb(if checked { "${C("taskChecked")}" } else { "${C("taskUnchecked")}" }),
    if checked { "${TASK_CHECKED}" } else { "${TASK_UNCHECKED}" },
  ),
  body,
)
`;
}

const SAFE_VISUAL_LENGTH_RE =
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:pt|mm|cm|in)$/;

function visualLength(value: string, path: string): string {
  if (!SAFE_VISUAL_LENGTH_RE.test(value)) {
    throw new Error(`PDF template visual has unsafe ${path}`);
  }
  return value;
}

function scopeCondition(
  scope: WikiPdfTemplateImageDecorationV1["scope"]
): string {
  if (scope === "all") return "true";
  if (scope === "first") return "current-page == 1";
  if (scope === "odd") return "calc.rem(current-page, 2) == 1";
  return "calc.rem(current-page, 2) == 0";
}

function imageDecorationSource(
  decoration: WikiPdfTemplateImageDecorationV1,
  assetPath: string,
  index: number
): string {
  const placement = decoration.placement;
  const fit = placement.fit ?? "contain";
  const image = `image(${typstString(assetPath)}, width: ${visualLength(
    placement.width,
    `decorations[${index}].placement.width`
  )}, height: ${visualLength(
    placement.height,
    `decorations[${index}].placement.height`
  )}, fit: ${typstString(fit)})`;
  const content =
    placement.rotation === undefined || placement.rotation === 0
      ? image
      : `rotate(${placement.rotation}deg, origin: center, ${image})`;
  return `if ${scopeCondition(decoration.scope)} {
    pdf.artifact(kind: "other", place(
      top + left,
      dx: ${visualLength(placement.x, `decorations[${index}].placement.x`)},
      dy: ${visualLength(placement.y, `decorations[${index}].placement.y`)},
      ${content},
    ))
  }`;
}

function borderDecorationSource(
  border: WikiPdfTemplatePageBorderV1,
  index: number
): string {
  const inset = border.inset;
  return `pdf.artifact(kind: "other", place(
    top + left,
    dx: ${visualLength(inset.left, `decorations[${index}].inset.left`)},
    dy: ${visualLength(inset.top, `decorations[${index}].inset.top`)},
    rect(
      width: 100% - ${visualLength(inset.left, `decorations[${index}].inset.left`)} - ${visualLength(inset.right, `decorations[${index}].inset.right`)},
      height: 100% - ${visualLength(inset.top, `decorations[${index}].inset.top`)} - ${visualLength(inset.bottom, `decorations[${index}].inset.bottom`)},
      fill: none,
      stroke: ${visualLength(border.stroke.width, `decorations[${index}].stroke.width`)} + rgb(${typstString(border.stroke.color)}),
    ),
  ))`;
}

function typstVisualSource(
  visuals: PdfTemplateVisualsV1 | undefined
): string {
  const byLayer: Record<
    WikiPdfTemplateImageDecorationV1["layer"],
    string[]
  > = {
    "page-background": [],
    header: [],
    footer: [],
  };
  for (const [index, decoration] of (visuals?.decorations ?? []).entries()) {
    if (decoration.kind === "page-border") {
      byLayer["page-background"].push(
        borderDecorationSource(decoration, index)
      );
      continue;
    }
    const asset = visuals?.assets[decoration.asset as keyof typeof visuals.assets];
    if (!asset) {
      throw new Error(
        `PDF template decoration "${decoration.id}" has no resolved asset`
      );
    }
    byLayer[decoration.layer].push(
      imageDecorationSource(decoration, asset.vfsPath, index)
    );
  }
  const definition = (
    name: string,
    entries: readonly string[]
  ): string => `#let ${name}() = context {
  let current-page = counter(page).get().first()
  ${entries.join("\n  ")}
}`;
  return [
    definition("template-page-decorations", byLayer["page-background"]),
    definition("template-header-decorations", byLayer.header),
    definition("template-footer-decorations", byLayer.footer),
  ].join("\n\n");
}

export const ATLCLI_TYPST_TEMPLATE = createAtlcliTypstTemplate();
