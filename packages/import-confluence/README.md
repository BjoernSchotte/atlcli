# `@atlcli/import-confluence`

Host-neutral Confluence publication transactions shared by semantic importers.

The package accepts prepared `ImportDocumentV2` values and an injected client
port. It owns target projection, attachment/media correlation, semantic
readback, and exact owned-page rollback. Source parsing, review policy,
comments, updates, recipes, batch orchestration, authentication, and CLI output
remain owned by their format or host packages.
