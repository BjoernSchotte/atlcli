# Issue #134: embedded Whiteboards as linked cards

## Goal

Render an embedded Confluence `native-embed:whiteboard` ADF extension as one
deterministic, clickable neutral Smart Card in DOCX and tagged PDF. The baseline
uses only the URL already present in page ADF and behaves identically in
CLI/Node/Bun, MV3, ordinary browsers, and Forge-shaped browser consumers.

The card is a navigation fallback. It must never claim that Whiteboard pixels,
editable content, metadata, or a preview were exported.

## Security and architecture decisions

1. Add one pure, offline renderer to `@atlcli/export-macros`, ordered before the
   generic unresolved-extension floor and marked `requiresLivePort: false`.
2. Validate the untrusted macro URL against the trusted Confluence page/site
   context. Accept only a canonical tenant-local
   `/wiki/spaces/{spaceKey}/whiteboard/{id}` route.
3. Reject external or cross-tenant hosts, protocol-relative URLs, credentials,
   unsupported schemes, fragments, malformed routes/identifiers, and relative
   URLs that cannot be resolved against trusted context.
4. Emit the established neutral `smartCard` block with the deterministic label
   `Atlassian Whiteboard`. DOCX and PDF receive no Whiteboard-specific branch.
5. A valid card replaces its provisional `macro-not-rendered` note with one
   informational `macro-rendered-via` outcome and does not degrade the document.
6. An absent or unsafe destination preserves a visible unknown-block fallback
   and an explicit degraded warning without echoing identifiers or URLs.
7. Embedded boards remain in their source page during page/tree/space export.
   A direct Whiteboard tree child remains non-traversable and is reported
   separately as `unsupported-child-type`.
8. No atlcli package imports Forge, WXT, React, extension APIs, browser DOM
   APIs, or a host application for this feature, and no Whiteboard HTTP request
   is added.

## Implementation order

- [ ] Pin valid, invalid, repeated, and nested ADF fixtures with synthetic IDs.
- [ ] Implement tenant-local Whiteboard URL canonicalization and linked-card
      rendering in the shared macro registry.
- [ ] Reconcile valid/invalid macro outcomes without leaking source values.
- [ ] Prove shared Smart Card link semantics in DOCX and tagged PDF.
- [ ] Prove CLI/Node/Bun export adds no Whiteboard request.
- [ ] Prove packed MV3 side-panel/offscreen behavior and dependency boundaries.
- [ ] Prove ordinary-browser behavior under the neutral browser harness.
- [ ] Add a Forge-shaped injected-page-read consumer proof with no Forge import
      or `read:whiteboard:confluence` requirement.
- [ ] Prove embedded-tree retention and honest direct-child non-traversal.
- [ ] Update user documentation and generated public API reports if required.
- [ ] Run focused tests, full workspace tests, typecheck, production/package
      gates, and the required live E2E with private artifacts cleaned up.

## Acceptance matrix

| Shape | Acquisition boundary | Required proof |
| --- | --- | --- |
| CLI / Node / Bun | Existing authenticated page read | Same card in DOCX/PDF; zero extra Whiteboard requests |
| MV3 | Existing ambient-session page read | Side-panel/offscreen use shared renderer after packed build |
| Ordinary browser | Caller-injected page read | Public browser contract works under strict CSP |
| Forge-shaped browser | Injected `requestConfluence`-like adapter | Same package contract; no Forge import or added scope |
| Tree / space | Existing page/tree reads | Embedded link retained; direct child remains unsupported |

## Evidence policy

- Record only synthetic tenant, space, page, account, and Whiteboard values.
- Inspect DOCX relationships and tagged-PDF link annotations/text, rather than
  treating serializer input alone as end-to-end proof.
- Keep functional rendering proof separate from dependency/CSP/host-lifecycle
  proof.
- Treat CI as a regression gate, not as a substitute for the required live E2E
  and artifact cleanup.

## Unresolved questions

- Confirm the exact trusted source-context field already carried into macro
  resolution and whether it contains a site origin, a source page URL, or both.
- Confirm which existing Forge-shaped consumer smoke is authoritative for this
  repository and whether it runs fully locally or also needs an external pinned
  consumer check.
- Confirm whether canonical Whiteboard navigation needs any query parameter.
  Until proven necessary, the renderer will drop all query parameters.
