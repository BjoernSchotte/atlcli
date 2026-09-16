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
