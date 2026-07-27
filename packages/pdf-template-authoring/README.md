# `@atlcli/pdf-template-authoring`

Browser-compatible functional core for importing design suggestions into PDF
template projects.

The package owns deterministic candidates, decisions, layer resolution,
staleness reconciliation, the host-neutral import journey, and application
ports. It does not read files, parse DOCX, render terminal output, localize
copy, or depend on the PDF renderer.

`TemplatePreviewCompiler` is one of those ports. A preview request names a
purpose (`design-review`, `compatibility-proof`, or `asset-contact-sheet`) and
contains structured input, including the exact import-view summary for a
design review. Results contain a digest, page count, typed page/region
references, and either bytes or an opaque asset handle—never a filesystem path
or DOM node. The PDF package provides the Typst implementation; CLI and browser
hosts only provide model resolution and persistence.
