# @atlcli/export-blocks

Dependency-free, renderer-neutral content contracts shared by DOCX, PDF, and
web publishing.

The package owns the structured `ExportBlock` and `InlineNode` model,
`ExportNote` vocabulary, versioned bounded runtime validation, exhaustive pure
visitors, and presentation-neutral helpers that consume those resolved shapes.
It deliberately contains no ADF or Storage parser, Confluence client, host
adapter, Node API, or renderer implementation.

Existing consumers may continue importing these contracts from
`@atlcli/confluence`; that package re-exports this package for compatibility.
New renderer and publishing packages should depend on this package directly.
