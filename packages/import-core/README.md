# `@atlcli/import-core`

Source-neutral semantic import contracts and pure Confluence target
projections shared by the DOCX and PDF importers.

The package accepts in-memory values only. It owns no parser, filesystem,
network, CLI, browser-extension, authentication, or live Confluence client.
Source evidence and confidence remain in their source package and are linked
through stable `sourceRefs`; ADF and Storage never contain those diagnostics.
