# Mermaid macro roundtrip

Implement the verified inline JSON body of Mermaid Integration for Confluence
in the shared Markdown converter. Reuse this converter for docs pull/push and
VFS writes. Decode the same body into Mermaid code blocks in Storage and Cloud
ADF export adapters, reusing the existing PDF/DOCX renderers.

Preserve unsupported and attachment-backed macro variants as raw XML. No new
renderer, dependencies, image uploads, DOCX import inference or video assets.

Validation: converter edge cases, theme/multiple/nested blocks, cold-cache VFS
create/read/update, existing converter and export adapter suites, full typecheck,
and a temporary DOCSY page proving native browser rendering before and after a
VFS edit. Trash the temporary page after verification.

Unresolved questions: none for the verified inline variant. Attachment-backed
v2 source expansion is outside this change and remains losslessly preserved.

## Verified

- 694 targeted converter, VFS, PDF and DOCX tests passed.
- Full `bun run typecheck` passed (all four workspace tasks).
- DOCSY live: inline macro rendered in the browser; VFS read returned a Mermaid
  fence; VFS write changed both diagram labels; REST reread retained the source
  and native macro; Cloud ADF decoded into the existing export diagram path.
- Browser showed both updated labels. Temporary test page moved to trash.
