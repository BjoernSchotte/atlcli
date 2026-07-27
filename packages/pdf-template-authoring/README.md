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

`buildTemplateProject()` is the side-effect-free build boundary. Callers
inject the active catalog/baseline pins, verified asset store, preview
artifacts, and a PDF-owned `TemplateRuntimeMaterializer`. The result contains
stable JSON plus the exact canonical source and accepted asset bytes, but no
source document, analysis evidence, or authoring decisions. The separate
`buildGeneratedPdfTemplatePack()` gate returns distributable bytes only after
the concrete pack round-trips byte-identically and compiles with an injected
real runtime.

Repositories are optimistic and generation-based. The in-memory reference
adapter and host adapters share the same contract: mutations append immutable
generations, previews bind to one exact generation/snapshot, and undo creates
a new generation from prior authoring intent while retaining current analysis
and private-source boundaries. Filesystem locking and paths deliberately live
in the CLI adapter rather than this browser-compatible package.
