# Confluence VFS live verification — 2026-09-16

PR #202 baseline: `5bb1bf296576fdc744885475478f6deadc6b4cf5`.
Local follow-up branch: `codex/pr202-vfs-live-fixes`.
Environment: macOS arm64, Bun 1.3.14, profile `mayflower`.

## Contents

- [Scope and results](#scope-and-results)
- [Bugs found and fixed](#bugs-found-and-fixed)
- [CQL measurements](#cql-measurements)
- [Reproduction](#reproduction)
- [Remaining boundaries](#remaining-boundaries)

## Scope and results

Only DOCSY received writes, exclusively to disposable test pages. The requested
MAYFLOWER space has the canonical API key `mayflower`; all its checks used `ro`.
The additional read harness blocked non-GET/HEAD requests at `fetch`, covering
both REST versions. No existing user page was edited. Test pages were moved to
trash, not purged; local test caches and mounted volumes were removed.

| Surface | Result |
|---|---|
| Focused core, shell, WebDAV, CLI and built-bundle tests | 428 passed, 0 failed |
| DOCSY live shell + WebDAV + native kernel suite | 12 passed, 0 failed |
| Additional real-client checks | 22 passed: 8 read checks per space and 6 DOCSY write checks |
| Built CLI, both spaces | Listing, reading homepage Markdown and bounded `find` passed |
| Built CLI, DOCSY writes | `sed -i` and `mv` passed with independent API readback |
| Built CLI native mount lifecycle, both spaces | Mount, read and unmount passed in `ro` mode |
| Typecheck | 4/4 tasks passed |
| CLI build | Passed, including patched WebDAV dependency |

Read checks covered listing/stat without cached bodies, Markdown reads, warm
cache reuse, `.by-id`, space metadata, attachment listings, historical versions,
comments, labels/recent directory listings, bounded `find`, local `EROFS`, WebDAV
PROPFIND/GET with exact content length, and cached offline reads without network.
Only sampled pages were read in MAYFLOWER, not a full-space crawl.

DOCSY checks covered create, edit, rename, actual reparenting, attachment upload
and readback, overlapping concurrent edits producing `EBUSY` with local conflict
preservation, and trash. Native filesystem checks additionally created and
updated a page through `mount_webdav`; API readback confirmed the new content.

The original live suite failed at shell rename. Its combined grep/find test took
29.5 seconds. After limiting recursive grep to current page bodies, that same
test took about 0.31 seconds on a subsequent run. These are individual timings,
not a benchmark or a guarantee across spaces.

One later auxiliary run received HTTP 409 while its direct API client was
preparing the simulated competing edit, before the VFS conflict assertion.
A fresh serial run passed all 22 checks. The final creation-ledger check found
14/14 recorded suite pages already absent from current content, with no cleanup
failures; separate probe pages were cleaned in their own `finally` blocks.

## Bugs found and fixed

1. **Shell rename mistakes aliases for destination directories.** Both old and
   new slugs resolve to the same page ID, so ordinary `mv old-ID new-ID` tried to
   move the page inside itself. The shell handles this Confluence-specific alias
   rename before delegating ordinary moves. Regression and real API readback pass.
2. **CQL silently loses valid grep matches.** Whole-word syntax is insufficient
   to guarantee equivalence. Automatic narrowing was removed; explicit `cql`
   remains available. Regression includes a dotted token missed by the live index.
3. **Recursive grep escapes its intended prefetch scope.** After prefetch it
   previously walked histories, attachments and generated views again. It now
   passes explicit current-body files to grep and respects the prefetch ceiling.
   Explicit body-file scope no longer includes that page's descendants.
4. **Space aliases silently expose empty trees.** REST v1 accepts differently
   cased keys while the homepage lookup does not. VFS now reports the canonical
   key instead of presenting an empty space.
5. **Native mount deadlock.** Synchronous mount/unmount subprocesses blocked the
   loopback server they needed. Async subprocesses keep the server responsive;
   the regression child performs an HTTP request back to the parent process.
6. **WebDAV `If` parser crashes or skips conditions.** The installed dependency
   inverted both its untagged-path branch and its nonempty-condition check.
   The checked-in Bun patch fixes those branches and tagged mount-relative paths.
   HTTP regressions prove rejection of invalid tokens/ETags and acceptance of
   valid tagged/untagged lock tokens. Native macOS writes now pass.

The live tests also now perform a real reparent, avoid double-trash cleanup
warnings, check native writes, and avoid synchronous filesystem calls against an
in-process WebDAV server.

## CQL measurements

The spec's temporary DOCSY probe was indexed before measurement and deleted in
`finally`. Of 20 assumptions, 17 agreed with the live index. The differences:

| Probe | CQL hit | Original assumption |
|---|---|---|
| `zqxcompound`, with underscore and hyphen compound fixtures | yes | no |
| `hyphen`, inside a hyphen compound | yes | no |
| `zqxdotted`, inside `prefix.zqxdotted.suffix` | **no** | yes |

The first query cannot distinguish underscore from hyphen tokenization because
both compounds share the same prefix in the fixture. The dotted-token miss is
unambiguous and sufficient to invalidate the automatic whole-word guard.
Other probes confirmed whole-word matches, explicit wildcard prefixes, and
non-matches for unmarked prefixes/interiors and the tested umlaut transliterations.

The original latency spike sampled 20 DOCSY pages: space lookup 116 ms,
homepage/children lookup 307 ms, sequential body reads 1,924 ms. Its reported
21 requests count only instrumented REST v1 attempts: REST v2 is missing from
that counter. Do **not** interpret its zero for children or its total as actual
network request counts. Its shell runs over a snapshot, not the production VFS.

## Reproduction

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build:cli
bun run test packages/confluence-vfs/src apps/cli/src/vfs \
  apps/cli/src/commands/wiki-sh.test.ts \
  apps/cli/src/commands/wiki-mount.test.ts \
  apps/cli/src/e2e/wiki-sh-built.e2e.test.ts --timeout 30000

ATLCLI_E2E_PROFILE=mayflower ATLCLI_WIKI_SH_E2E=1 \
ATLCLI_WIKI_MOUNT_E2E=1 ATLCLI_WIKI_MOUNT_KERNEL=1 \
bun run test apps/cli/src/e2e/wiki-sh-live.e2e.test.ts \
  apps/cli/src/e2e/wiki-mount-live.e2e.test.ts --timeout 30000

bun --conditions=development spikes/vfs-just-bash/cql-text-semantics.ts \
  --profile mayflower --space DOCSY
bun dist/index.js wiki sh --profile mayflower --space mayflower --mode ro \
  -c 'ls | wc -l; cat _index.md | wc -c'
```

Additional probes used temporary harnesses outside the repository; their output
contained assertions and aggregates, not MAYFLOWER page contents. A separate
creation ledger allowed cleanup even when the initial native-write run crashed.

## Remaining boundaries

### Follow-up: recursive searches through folders

A user-reported `grep -r -i <term> *` failure was reproduced read-only in the
larger space. The tree walker sent folder IDs to the page direct-children
endpoint, which returns 404. It now dispatches folders to `getFolderChildren`.
The fake client now rejects the wrong endpoint too, and a regression searches
through two nested folders. After the fix, the same live walk reaches the
expected 300-page prefetch guard (1,419 candidate pages), with zero bodies fetched.
The 386 focused VFS tests pass. The original failure was not caused by glob quoting.

- This is a targeted feature verification, not a new full-repository test run.
- Finder/editor UI, actual Spotlight indexing behaviour, Windows WebClient,
  Linux kernel mounts, Homebrew and release-binary startup gates remain unverified.
  The native macOS check proves the exclusion file is readable, not that an
  indexer honours it.
- Two-profile permission isolation was not run; only `mayflower` was authorized.
- Listings have a 60-second tree-cache TTL. A page created by another client was
  initially absent from a still-fresh snapshot; the built write probe used a fresh
  cache. This expected cache behaviour is now documented.
- No push, merge or release was performed.

## Related topics

- [Plan](./PLAN.md)
- [Earlier measurements](./EVIDENCE.md)
- [Release checklist](./RELEASE-NOTES.md)
- [User documentation](../../src/content/docs/confluence/virtual-filesystem.md)

### Interactive completion follow-up

Added readline Tab completion for registered commands and virtual paths, using
directory metadata only. Session cwd and environment now persist across inputs.
Validated command and body-path completion plus persistent `cd` in a real Bun
PTY against DOCSY with profile `mayflower`, strictly read-only. The harness uses
`TERM=xterm-256color`; Bun disables terminal editing under `TERM=dumb`. No pages
were created or changed. Temporary cache removed. Focused shell/CLI tests: 60
passed; workspace typecheck: 4/4 successful.

### Agent search planning and bounded downloads (2026-09-16)

Implemented exact recursive grep planning, filter pruning before prefetch,
normalized option parsing (including bundled flags and multiple expressions),
version-aware cache refresh, and scoped positive `grep -q` CQL hints. CQL never
excludes potential exact matches. `grep`, `fgrep` and `egrep` share the budget.
A per-operation budget also bounds direct reads, pattern files and refetches
following cache eviction. Budget failures return an error, not no-match.

Added `cql --excerpt` / `cql --json` with bounded cursor pagination, mounted-space
checks, explicit truncation and no page-body reads. Direct `.by-id` stat is now
metadata-only; reading a result fetches one body without walking ancestors.
Fixed explicit-file TTL refresh, symlink stat semantics and the recursive walk's
previous silent default depth-ten truncation.

Reproduce the live proof with:

```bash
bun --conditions=development scripts/vfs-search-live.ts
```

The script creates five synthetic DOCSY pages, changes one remotely, and trashes
all fixtures in `finally`. MAYFLOWER has both transport and global GET-only guards;
its preview checks reject any body-fetch API call. Logs contain aggregate metrics
only. A fresh temporary cache is removed after each run. The final run produced:

| Operation | ms | HTTP requests | Body downloads | Storage bytes |
|---|---:|---:|---:|---:|
| DOCSY exact, five cold fixture pages | 766 | 10 | 5 | 194 |
| DOCSY exact, warm cache | 3 | 0 | 0 | 0 |
| DOCSY quiet, warm cache | 3 | 0 | 0 | 0 |
| DOCSY exact after one remote edit and TTL expiry | 517 | 8 | 1 | 39 |
| DOCSY by-id with zero budget | 204 | 3 | 0 | 0 |
| DOCSY by-id exact, metadata already cached | 70 | 1 | 1 | 33 |
| DOCSY excluded files | 186 | 2 | 0 | 0 |
| DOCSY over-budget exact search | 165 | 5 | 0 | 0 |
| DOCSY CQL-prioritized quiet subtree, warm hierarchy/cold target | 368 | 2 | 1 | 58 |
| DOCSY quiet explicit cold file | 175 | 2 | 1 | 39 |
| MAYFLOWER indexed retrospektive, first five results | 337 | 1 | 0 | 0 |
| MAYFLOWER indexed craftsmanship, five results | 272 | 1 | 0 | 0 |

These are individual measured runs, not latency guarantees or a benchmark against
an MCP server. HTTP counts include all fetch calls, not only the client's v1
transport observer. Storage bytes measure returned body strings, not total wire
bytes. The quiet-subtree measurement follows a metadata-only budget check, so its
hierarchy is warm. Retrospektive was explicitly truncated; craftsmanship's index
response was complete. All five results in each preview included excerpts.

Synthetic indexing needed nine two-second waits on the final run. The exact
search found current content independently of that index lag. This reinforces
why a missing CQL hit cannot justify an exact no-match result.

The built CLI also passed a MAYFLOWER JSON preview test: three results, explicit
truncation, zero prefetched bodies, 857 ms including process startup and setup.
Unit/integration comparisons cover real just-bash over the same Markdown,
Unicode, punctuation, regexes, counts, context, inversion, multiple patterns,
pattern files, filters, CQL false positives/negatives/outages, stale versions,
missing bulk results, tiny caches, independent concurrent budgets and deep trees.

Final validation: 539 tests passed across 23 affected test files (1,475 assertions),
workspace typecheck 4/4 and build 35/35 successful. No push performed.


## Default indexed grep — 2026-09-16

This supersedes the earlier default-exhaustive contract above. The user chose
CQL candidate selection for ordinary recursive grep, with visible index-gap
warnings. Bodies still determine actual matching lines. `--no-cql` explicitly
requests exhaustive search; standard `-v` remains inverted matching.

Final GET-only MAYFLOWER measurements, using ordinary shell commands:

| Operation | ms | HTTP requests | New bodies | Storage bytes |
|---|---:|---:|---:|---:|
| `grep -r -i craftsmanship *`, cold | 1154 | 7 | 6 | 41412 |
| Same command, warm | 547 | 1 | 0 | 0 |
| `grep -r -i retrospektive *`, budget 10 | 1087 | 2 | 0 | 0 |
| Same command, budget 100 | 1562 | 2 | 68 | 687557 |

Craftsmanship returned eight lines from five indexed candidates plus the explicit
root body selected by `*`. Retrospektive returned 148 lines after verifying 68
indexed candidates, instead of downloading the previously reported 1,418-page
subtree. Budget 10 returned exit 2 before body downloads. Only the first command
needed one root hierarchy request; subsequent commands needed none. Results are
individual runs, not latency guarantees or an MCP comparison. Index omissions
and lag remain possible and are disclosed for every indexed search.

The built CLI independently passed the cold craftsmanship command with the
mayflower profile: 1,717 ms including process startup, six prefetched bodies,
eight lines, exit 0. Temporary caches were removed; no MAYFLOWER writes occurred.

The committed `scripts/vfs-search-live.ts` also passed DOCSY read/write tests,
remote-edit refresh, exact search and download-budget checks. Its default indexed
quiet subtree search took 461 ms, three HTTP requests and one 58-byte body.
Synthetic indexing required six two-second waits using the actual generated
query. All five synthetic pages were trashed in `finally`. MAYFLOWER excerpt
backup checks still used one request and zero bodies each.

Validation: 553 tests passed across 25 files (1,573 assertions), workspace
typecheck 4/4 and build 35/35 successful. Tests cover indexed false positives,
empty results, outages, truncation, quiet early exit, explicit files, aliases,
version refresh, scope restrictions, unsupported-pattern fallback and exhaustive
opt-out. No push performed.


## Remaining-plan closure: CLI controls and telemetry

`--sync-writes` now disables write coalescing in both frontends. Interactive
shell deletion and cross-space moves ask once before mutation; `--confirm`
skips that prompt, while noninteractive scripts retain the existing mode/delete
gates. One readline reader handles both shell commands and answers. Tests cover
force flags, relative cross-space paths and filenames after `--`.

HTTP request and 429 counters now cover v1, v2, attachments and retries; shell
JSON and `vfs-status` expose them. Custom clients without instrumentation report
unavailable rather than a fabricated zero. A real local HTTP regression verifies
both REST versions plus attachment transports.

Validation: command and real-interpreter regressions, workspace typecheck/build,
12 DOCSY live shell/WebDAV/native-macOS tests and the synthetic search harness
passed. The search harness removed all five temporary DOCSY pages; MAYFLOWER
remained GET-only. API reports regenerated for the additive public methods.

User accepted single-profile testing for this iteration: no second identity is
available. Windows is unavailable; Linux native validation will run separately
on the user's homelab. Neither is represented as a passing platform test.


## Indexed find and complete shell load test

WP6.4 now accelerates explicit current-page file searches with `-type f -name
'*.md'` and `-mtime`, `-newer` or `-newermt`. Non-page queries still use the
metadata walk. Index timestamp bounds are conservative and returned page
metadata is checked before output. Truncation fails visibly; no bodies load.

The DOCSY live harness passed both -mtime and -newermt in 695 ms combined,
three HTTP requests and zero body downloads, with fixture cleanup. The search
index briefly disagreed between successive requests; the harness now waits
boundedly for the actual grep query, rather than treating one preview response
as proof that every replica is caught up.

WP9.3 now drives real just-bash grep across a 5,000-page fake: cold 31 ms,
seven client calls and fifty bodies; warm 8 ms, one search and zero bodies;
no hierarchy requests. These are synthetic transport-free timings. Twenty
indexed-find/grep tests passed. Cache bytes were 10,630 after both cold and warm
runs; a generous two-second CI ceiling guards against accidental space walks.
