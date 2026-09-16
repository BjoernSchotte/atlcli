# Agent search: exact results with bounded downloads

## Contract

Default recursive `grep` selects candidates using Confluence's CQL index and
verifies those candidates against generated Markdown. This intentionally adopts
index completeness: index gaps or delayed updates may omit pages. Diagnostics
always disclose that limitation. `--no-cql` retains exhaustive Markdown search.
The user explicitly selected this fast default; `cql` remains only a backup.
An exhausted budget, failed request or incomplete walk is an error, not no-match.
Search results refer to the VFS metadata snapshot (configured TTL), not an atomic
snapshot of a concurrently changing Confluence site.

## Implementation

1. Harden argument parsing and filter paths before prefetch. Skip excluded
   branches, page histories and attachments during implicit recursive search.
2. Reuse versioned bodies, refresh expired metadata, and report selected files,
   fetched bodies and cache reuse. Keep the default download budget.
3. Translate supported literal patterns, phrases, fixed strings and simple regex
   alternatives to bounded CQL expressions. Scope by root page IDs and ancestors
   before querying; do not traverse all descendants. Load only candidate bodies.
   Use stable `.by-id` paths in results. No indexed candidates returns exit 1;
   truncated results return exit 2 unless quiet search verifies a positive match.
   Complex regex, inversion, counts, pattern files and path filters visibly fall
   back to exhaustive search. Explicit files and stdin remain direct searches.
4. Add `cql --excerpt` and `cql --json` using the existing detailed REST search.
   Bound and paginate results, disclose truncation, and fetch no page bodies.
5. Keep download-limit diagnostics actionable through ordinary grep inputs and
   document the nonstandard --no-cql exhaustive option.

## Validation

- Differential tests against the bundled grep over the same Markdown corpus:
  literals, regexes, punctuation, Unicode, multiple patterns, inversion, context,
  counts, filenames, quiet mode, filters and invalid arguments.
- Count body downloads for cold, warm, filtered and changed-page searches.
- Verify CQL false positives/negatives, pagination and bounded results.
- DOCSY live read/write fixtures with cleanup in `finally`; MAYFLOWER read-only
  search previews and small bounded probes only. No tenant content in fixtures.
- Focused suites, typecheck, CLI build, then local commit; no push.

## Unresolved questions

None blocking. Full exact cold-space grep inherently needs all selected bodies;
the implementation must expose this boundary instead of promising equivalence
between Confluence's text index and Markdown.
