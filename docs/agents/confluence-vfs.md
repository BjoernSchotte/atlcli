# Confluence as a filesystem, for coding agents

Drop this into `AGENTS.md`, `CLAUDE.md`, a Cursor rule or a skill file. It is
written to be pasted, not read aloud.

---

## For the agent

For native tools outside the shell, `wiki mount` defaults to WebDAV. Development
builds also offer experimental read-only NFS on macOS/Linux with
`--transport nfs`. See the [mount guide](../../src/content/docs/confluence/virtual-filesystem.md)
for the matching helper prerequisite. The NFS option does not accelerate OS grep
through CQL; use the shell below for indexed search.

Confluence is available as a filesystem through `atlcli wiki sh`. Use it instead
of asking a human to copy page content, and instead of an MCP tool call, when
you need to read, search or edit Confluence.

### The single-command form

```bash
atlcli wiki sh --space <SPACE> -c '<shell script>'
```

It runs a real bash interpreter and exits with **the script's** exit code, so
`&&`, `||` and `$?` work from the outside. Prefer one `-c` call doing several
things over several calls.

### The shape of the tree

```
/<SPACE>/                          the space
  _index.md                        the home page's body
  _attachments/                   home page attachments
  .versions/                      home page versions, read-only
  .comments.md                    home page comments, read-only
  <slug>-<id>/                     every page is a directory
    _index.md                      its body
    <child-slug>-<child-id>/       child pages nest
    _attachments/                  files
    .versions/                     up to 50 previous versions, read-only
    .comments.md                   comments, read-only
  .by-id/<id>.md                   any page by id
  .labels/<label>/                 pages with a label
  .recent/{24h,7d,30d}/            recently changed
  .search/<cql>/                   a CQL query, resolved on access
```

`<slug>-<id>`: **the id resolves, the slug is decoration.** A path keeps working
after a page is renamed. `<slug>-<id>.md` is a short form for the body.

Comment and attachment listings share concurrent requests and remain cached in
the current VFS session for the metadata TTL (60 seconds by default). External
comment changes appear on the next read after expiry. Each listing cache retains
at most 256 pages; failed requests are retried on the next access.

### Reading

```bash
atlcli wiki sh --space DOCSY -c 'ls'
atlcli wiki sh --space DOCSY -c 'cat architecture-623869955/_index.md'
atlcli wiki sh --space DOCSY -c 'ls .recent/7d/'
atlcli wiki sh --space DOCSY -c 'cat .by-id/623869955.md'     # when you only have an id
```

### Searching — read this part

Recursive `grep` uses CQL-selected page bodies in the requested subtree, with
bounded bulk prefetch. It does not implicitly search versions or attachments.

```bash
grep -rlw kubernetes .        # whole-word matches in current Markdown
grep -rl  kubern .            # substring matches, including "kubernetes"
```

Normal recursive `grep` is **index-backed by default**. The shell translates
supported literal patterns, phrases, fixed strings and simple alternatives to
CQL. Confluence selects pages within the requested subtree; only those bodies
are loaded and verified by grep. Candidate paths use `/SPACE/.by-id/ID.md` and
can be passed directly to `cat`. A space-wide hierarchy walk is unnecessary.

```bash
grep -r -i retrospektive *           # default: indexed candidates, verified lines
grep --no-cql -r -i retrospektive *  # exhaustive Markdown search, bounded downloads
```

Diagnostics disclose that index gaps and indexing delay can omit matches. An
empty index result means no indexed candidates, not proof that current Markdown
contains no match. `grep -q` stops after the first verified candidate. Complex
regexes, inversion (`-v`), per-file counts (`-c`), nonmatching filenames (`-L`),
pattern files (`-f`) and path filters use a visible exhaustive fallback. Explicit
files and stdin are searched directly. Index failures also fall back within the
same download budget; truncated candidate lists return exit 2 (unless `-q` has
already verified a positive match). `--no-cql` is a VFS extension, not a standard
grep flag; standard `-v` continues to mean inverted matching.

The optional `cql` backup command also supports previews without body downloads:

```bash
cql --excerpt --limit 20 'text ~ "retrospektive"'
cql --json --limit 20 'text ~ "retrospektive"' | jq '.results[].path'
# Fetch only the selected result, then run an exact search on it:
cat /DOCSY/.by-id/623869955.md | grep -ni retrospektive
```

`--limit` defaults to 100 (range 1–1000). JSON includes `source`, `results`,
`complete`, `truncated` and, when available, `totalSize`. Completeness refers to
Confluence's index, not all current Markdown; missing excerpts remain empty.
Text output reports truncation in diagnostics. Search remains restricted to the
current mounted space. Legacy `cql '<query>'` continues to print paths only.

Exact recursive search applies include/exclude filters before downloading and
skips excluded branches. Warm bodies are reused; expired metadata is refreshed
using the configured tree TTL (60 seconds by default). A search is not an atomic
snapshot of concurrent edits. Budget exhaustion returns exit 2, never a false
no-match. An exhaustive cold-space search still needs all selected bodies.
Narrow the path or use previews when the budget is reached; piping to `head`
limits output, not downloads.

For queries a path cannot express — dates, anything with a `/` — use `cql`:

```bash
atlcli wiki sh --space DOCSY -c 'cql "label = \"runbook\" AND created >= \"2026/01/01\""'
```

### Keep results small

Listings and searches can be large. Pipe through `head`, `wc -l` or `grep -c`
rather than reading everything:

```bash
atlcli wiki sh --space DOCSY -c 'grep -rlw kubernetes . | head -20'
atlcli wiki sh --space DOCSY -c 'ls .recent/24h/ | wc -l'
```

### Writing — off unless you ask

Writing requires `--mode rw`, and deletion additionally requires
`--allow-delete`. If you were not given those flags, **do not add them**; ask
first.

```bash
atlcli wiki sh --space DOCSY --mode rw -c '
  sed -i "s/1.28/1.31/" architecture-623869955/_index.md
  grep -n "1.31" architecture-623869955/_index.md
'

# Create a page
atlcli wiki sh --space DOCSY --mode rw -c 'echo "# Release notes" > release-notes.md'
```

Deletion moves a page to the **trash**; there is no purge.

Every write is versioned. If the page changed since you read it, the VFS merges;
if the merge conflicts, the write fails with `EBUSY` and your content is kept —
check `atlcli wiki vfs conflicts list` and tell the user rather than retrying.

Rapid updates to the same page are bundled until 500 ms after the latest write,
including writes through different aliases. Only one update per page runs at a
time; writes arriving during it wait for the next batch and retain normal
version/conflict checks. Flushing waits for queued and running updates.
`--sync-writes` disables the delay and bundling, while retaining serialization.
This is save coalescing; retry backoff for API errors is a separate mechanism.
A stale replay whose title and storage content already match the server succeeds
without creating another version, even if its old merge base has been evicted.
This comparison ignores only outer storage whitespace, not content differences.

### Machine-readable output

```bash
atlcli wiki sh --space DOCSY --json -c 'ls'
```

gives `{ stdout, stderr, exitCode, diagnostics, cacheHits, cacheMisses, prefetched }`.

In interactive mode, **Tab** completes commands and paths (`gr<Tab>` → `grep`,
`cat _i<Tab>` → `cat _index.md`). Directories end in `/`; completion reads only
directory metadata, never page bodies. `cd` and environment variables persist
between inputs. Completion supports unquoted and backslash-escaped paths.

### Useful extra commands inside the shell

| Command | Use it for |
|---------|-----------|
| `page-url <path>` | A link to give the user |
| `page-id <path>` | The id, for another tool |
| `cql '<query>'` | Anything a path cannot express |
| `vfs-status` | Mode, cache state, request counters |

### Things that will surprise you

- **Every page is a directory**, even one with no children. `cat page-123` is
  `EISDIR`; you want `cat page-123/_index.md` or `cat page-123.md`.
- **`rm` needs `-r`** for the same reason.
- **You only see what your account can see.** A page you may not view is
  `ENOENT`, not "forbidden".
- **A recursive command may abort** naming a prefetch limit. That is deliberate:
  narrow the path rather than raising the limit unasked.
- **`sed -i` reports every write failure as "No such file or directory."** If a
  write fails oddly, retry it as `echo ... > path` to see the real reason.

---

## For whoever is setting this up

The shortest useful snippet, if the above is too long for your context budget:

```markdown
For Confluence, use `atlcli wiki sh --space DOCSY -c '<bash>'`. Spaces and pages
are directories; a page's body is `_index.md`; names are `<slug>-<id>` and the id
is what resolves. Search current page bodies with `grep -rlw <word> <subtree>`.
Narrow the subtree to bound reads; `head` only limits output. Writing needs `--mode rw`, deletion
also `--allow-delete`; do not add them unless asked.
```

Full documentation: [Virtual Filesystem](https://atlcli.dev/confluence/virtual-filesystem/).


### Find recently changed pages without body downloads

```bash
find . -type f -name '*.md' -mtime -7
find . -type f -name '*.md' -newermt '2026-09-01T00:00:00Z'
```

This indexed fast path searches current page files only and returns stable
`.by-id` paths; attachments and generated virtual files are excluded, as the
command diagnostic states. `-newer FILE`, combined time predicates and
`-print0` are also supported. CQL date bounds are widened for account timezone
and minute precision, then checked against exact page metadata. No bodies are
fetched. Index lag can omit recent changes. Other find expressions retain the
filesystem-metadata walk; `--no-cql` on `wiki sh` disables acceleration.

Experimental NFS handles distinguish generated files in each selected space.
NFS exposes the same empty indexer marker files as WebDAV at the volume root,
plus an empty `.fseventsd` directory. These synthetic entries and common desktop
metadata probes at the root require no Confluence requests. They are local mount
entries, not wiki pages. This does not guarantee that every indexer honors them.
Both mount transports emit one warning per session after 50 distinct successful
file reads within 10 seconds without a recent listing of their parent directories.
Repeated NFS byte ranges count as one file; failed reads and marker files do not
count. Listings suppress the hint for 10 seconds (up to 4096 recent directories).
This heuristic reports possible indexing; it neither blocks reads nor detects
every crawler. The warning contains counts, not page names or contents.
Expired object handles also fail metadata/access probes with `ESTALE`.
NFS advertises a 255-byte filename-component limit and rejects longer UTF-8
names with `ENAMETOOLONG`; names are never silently truncated.
macOS mounts use `locallocks`; Linux uses `nolock`. Advisory locks are local
to the client: they coordinate processes on that client, not other clients or
Confluence edits. No NLM/NSM lock service runs. Native tests verify nonblocking
`flock` contention/release and shared POSIX read locks on the current RO mounts;
write-lock/editor-save acceptance still requires the pending RW implementation.
Mount options reject malformed values before opening a cache or starting a
server: `--mode` accepts only `ro` or `rw`, and `--port` accepts decimal integers
from 0 to 65535 (0 chooses an available port). Missing option values are errors.
Experimental NFS additionally rejects `rw`, `--sync-writes` and `--allow-delete`
until write acceptance passes. WebDAV remains the default transport.

Development tests now cover TextEdit safe-save and VS Code autosave on a native
macOS NFS mount, plus Vim/native saves and real DOCSY publication on Linux.
These are individual write gates, not general RW acceptance; see the
[write evidence](../../specs/confluence-vfs-nfs-transport/EVIDENCE.md). Development
RW shutdown reports counts of retained pending pages, interrupted replacements,
local editor entries and unresolved publications. Keep the staging journal when
this notice appears: locally durable bytes do not prove Confluence publication.
Development NFS publication waits for 500 ms without newer writes to a page.
If an editor sends a valid partial document and pauses longer, Confluence can
receive an intermediate version before later blocks arrive. Automatic publication
does not detect the end of an editor save; fsync confirms local durability only.
After restart, successful reconciliation of an interrupted publication also
schedules any newer durable edits, without requiring another editor save.
Development publication processes one page at a time to bound retained page
images; a slow upload can delay other pages. The public recovery CLI remains
part of the pending RW acceptance work. Clean staged pages refresh from newer
core-cache versions during access; dirty pages retain local bytes. This follows
the existing cache freshness window and does not provide immediate remote-edit
visibility. Conflicts detected during local publication preparation can be
corrected by another editor save. Persisted uncertain publication results remain
protected for reconciliation; this is not a general conflict-resolution UI.

NFS is not generally faster than WebDAV. The current synthetic native comparison
shows different results by OS and cache state; see the [measured results and
limits](../../specs/confluence-vfs-nfs-transport/EVIDENCE.md#slice-55--isolated-peak-rss-and-shutdown-benchmarks).
Its per-run peak RSS and normal shutdown measurements include startup and cleanup.

NFS sets `actimeo=1` on both systems and disables negative-name caching
(`nonegnamecache` on macOS, `lookupcache=positive` on Linux). The core metadata
TTL remains 60 seconds by default: directly reopening a cached page checks its
version after that TTL, even without a directory listing. Warm reads within the
TTL make no additional API calls. Allow the core TTL, the one-second kernel
attribute cache and backend response time for external changes; this is not an
instantaneous-consistency promise. Native synthetic tests advance the core clock
past its TTL and verify updated bytes and a previously absent file through the
real OS client within five seconds, without flushing kernel caches.
NFS READDIR/READDIRPLUS entry attributes do not enumerate each child directory.
Listing a child directory fetches its children on demand. An explicit directory
GETATTR still refreshes its listing to validate pagination state.
Attachment directory listings and stat use exact Confluence size metadata without
downloading attachment contents. A read downloads the attachment through the
shared body cache; subsequent ranges reuse it.
An NFS attachment handle also survives a filename change within its owner page.
Recovery matches the attachment ID in that page's cached metadata listing; it
does not download sibling attachments or search the whole space. Reusing the
old filename for a different attachment never redirects the original handle.
If an attachment moves to another owner page, recovery uses its ID and fresh
owner metadata. The new owner must belong to a selected export space; moves
outside the export return `ESTALE` without downloading the attachment. No
whole-space search is used.
READ currently omits optional NFS attributes rather than combining bytes with
separately fetched attributes from another version. Clients can use GETATTR;
normal paths can refresh between READ requests when a page changes externally.
For a stable whole-document snapshot, read `.versions/<n>.md`: all ranges of
that file refer to the same historical version, even after a cache miss or a
page move within the export. For example, `cat page-123/.versions/7.md` reads
version 7; `cat page-123/_index.md` reads the current document.
For current Markdown pages and page aliases, GETATTR derives the modification
time from the same materialized Markdown used for its exact byte size when
Confluence supplies the version timestamp. A cold fetch therefore cannot pair
the newer body's size with the preceding metadata lookup's older timestamp.
Rendered Markdown cache entries carry a format revision as well as the
Confluence version. After this upgrade, older Markdown entries are refreshed
only when requested; cached attachments are retained. Offline reads of an old
Markdown format require one online read before becoming available again.
Mutable generated files such as `.comments.md` use a session-local observed-change
timestamp in NFS. It stays stable while the rendered bytes are unchanged and
advances on content changes, even when the page version and byte length stay the
same. This is not a Confluence authoring timestamp; existing metadata TTLs still
bound when external changes become visible.

Historic `.versions/<n>.md` uses that version's own timestamp in its Markdown
and NFS attributes, not the current page timestamp. If the historic response
omits it, the Markdown omits it and NFS reports an unknown time (Unix epoch).
Historical Markdown omits current parent IDs and location URLs, which could
otherwise change its bytes after a move. It has a separate cache representation
from editable current Markdown; both share the existing disk budget and cleanup.
After upgrading, visit a version path online once before using it offline, even
if the corresponding current page was already cached.
Handles for `.comments.md`, `.versions` and its version files follow their
owner page across rename/reparent operations within the export.

When a refreshed listing observes a moved page or folder, the shared tree index
removes its old parent association while retaining its already loaded children.
Refreshing the old parent afterwards therefore cannot erase the relocated subtree.

Existing page/body handles also survive a page move after the changed hierarchy
is observed: the adapter resolves the same page ID within the selected spaces.
Attachment files and their `_attachments` directory also retain their handles
when the owning page moves, without requiring a lookup of its new location.
Moving outside the export or deleting the page expires these handles. Folder directory handles are recovered through space-checked folder and ancestor
metadata, including when an ancestor page moves. Inconsistent ancestry returns a
retryable error. The folder’s generated `_index.md` follows its owning folder
handle and keeps its identity after relocation. Attachment handles also follow
independent renames and owner changes within the selected export.
NFS ACCESS grants reading for regular files and reading/lookup for directories;
write operations remain rejected. Deleted or replaced identities report `ESTALE`; look up the path again, or remount
after a helper restart. Single-space and combined-space native reads are covered
by the [NFS evidence](../../specs/confluence-vfs-nfs-transport/EVIDENCE.md).

The NFS helper uses the pinned local nfsserve patch for correct multi-page
READDIR results. Rebuild the helper alongside source updates; an older helper
can repeat the first directory page. See its [patch notes](../../packages/confluence-nfs/vendor/nfsserve/PATCHES.md).

If a directory changes during NFS pagination, the server returns `BAD_COOKIE`;
restart the listing if the OS does not retry automatically. A kernel may finish
returning entries it buffered before a change; reopen the directory after the
metadata freshness window to obtain the updated listing. Directory timestamps
track changes observed by this mount. Source builds require bridge-version-3
helpers; rebuild an older companion binary before mounting.

Each NFS session retains at most 65,536 handles, including root and volume
markers. At capacity, new object lookups return `ENOSPC`; existing handles keep
working. Remount to reset the session, or select fewer spaces. Handles confirmed
stale release capacity, but their numeric IDs are never reused in that session.
Directory revisions retain fixed-size hashes rather than copies of listings.
Each directory request resolves at most 32 entries concurrently and drains a
failed batch before returning its error; large listings remain paginated.
Transport benchmarks distinguish local protocol requests from Confluence API
requests: NFS counts complete received RPC records (including mount calls and
retries), while WebDAV counts received HTTP requests. Counter queries use the
private helper pipe and do not themselves count as NFS traffic. Neither counter
retains filenames, credentials or content.

The experimental NFS listener rejects RPC records over 4 MiB, more than 1,024
fragments per record, and XDR arrays exceeding 4 MiB before allocating their
payload. Malformed connections are closed; reconnect with a valid request.

NFS accepts at most 32 simultaneous TCP connections and handles requests in order
within each connection. Idle or incomplete requests disconnect after 60 seconds;
clients can reconnect. Dispatch and response-write deadlines are 120 and 30
seconds. Cancelled bridge calls release their pending-response records and
concurrency permits; a still-running blocking pipe write retains its permit
until the write finishes, so cancellation cannot bypass the 32-call bound. Replay tracking is capped at 4,096 entries; exceeding capacity closes
the requesting connection. These limits do not change WebDAV or the VFS shell.

For a native release-mode development helper, run
`bun scripts/build-nfs-helper.ts /tmp/atlcli-nfs-helper` with Rust 1.92.0 installed.
Set `ATLCLI_NFS_HELPER` to the emitted executable. The adjacent build manifest
records checksums and protocol identity; see the [helper build guide](../../packages/confluence-nfs/README.md).

Unix CLI archives built with NFS include `atlcli-confluence-nfs` beside `atlcli`
and dependency notices. Keep both executables together. The shell installer
verifies the release checksum and accepts only the expected regular files before
installing them. A downgrade to an older CLI-only archive removes the previous
NFS companion, so it cannot be mistaken for a matching helper. If checksums cannot
be retrieved or verified, installation stops; retry once the release assets are
available. Homebrew companion support is prepared in [tap draft PR #1](https://github.com/BjoernSchotte/homebrew-tap/pull/1)
and is not available from the published tap until that change is merged.


## Mermaid

A fenced `mermaid` block writes a native `mermaid` macro for **Mermaid Integration
for Confluence**. That app must be installed. Inline sources round-trip through
Markdown; attachment-backed variants remain preserved raw macros. See
[macro syntax and examples](../../src/content/docs/confluence/macros.md#mermaid-diagrams).


After an NFS mount process is killed with SIGKILL, its helper exits when the
private pipe closes, but the OS volume can remain attached. `wiki mount list`
keeps that record and reports `orphaned`; it must not be mistaken for a working
server. Run `atlcli wiki mount unmount <mountpoint>` using the same `--cache-dir`
if one was specified. Once detached, start a fresh mount: old filehandles do not
survive a helper restart. Handles carry a fresh random session identity, so their
validity does not depend on the wall clock. The recovery command uses regular unmount, without
forced or lazy detachment. Close applications using the volume if it is busy.
