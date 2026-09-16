# Agent search: exact results with bounded downloads

## Contract

Default `grep` keeps the installed interpreter's Markdown matching semantics.
CQL text search is not a proven superset and must never silently exclude files.
An exhausted budget, failed request or incomplete walk is an error, not no-match.
Search results refer to the VFS metadata snapshot (configured TTL), not an atomic
snapshot of a concurrently changing Confluence site.

## Implementation

1. Harden argument parsing and filter paths before prefetch. Skip excluded
   branches, page histories and attachments during implicit recursive search.
2. Reuse versioned bodies, refresh expired metadata, and report selected files,
   fetched bodies and cache reuse. Keep the default download budget.
3. For positive quiet searches only, optionally use CQL candidates as an early
   success probe: verify full Markdown locally; no hit always falls back to the
   complete exact search. Unsupported patterns/flags bypass this optimization.
4. Add `cql --excerpt` and `cql --json` using the existing detailed REST search.
   Bound and paginate results, disclose truncation, and fetch no page bodies.
5. Improve limit diagnostics with an explicit body-free search alternative.

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
