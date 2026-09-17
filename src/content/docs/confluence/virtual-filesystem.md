---
title: "Virtual Filesystem"
description: "Work on Confluence with ls, cat, grep and sed — as a shell or as a mounted volume"
---

# Virtual Filesystem

Confluence as a filesystem. Spaces are directories, pages are directories with
an `_index.md` body, and `ls`, `cat`, `grep`, `find` and `sed` work on them.

Two ways in, sharing one core:

| Command | What you get | Best for |
|---------|--------------|----------|
| `atlcli wiki sh` | an embedded shell over Confluence | agents, scripts, full-text search |
| `atlcli wiki mount` | a real OS volume over loopback WebDAV | editors, the Finder, Explorer |

**On this page**

- [A cache, not a copy](#a-cache-not-a-copy)
- [Prerequisites](#prerequisites)
- [The embedded shell](#the-embedded-shell)
- [The mounted volume](#the-mounted-volume)
- [What the tree looks like](#what-the-tree-looks-like)
- [Writing](#writing)
- [Search current page bodies](#search-current-page-bodies)
- [Options reference](#options-reference)
- [Configuration](#configuration)
- [Maintenance](#maintenance)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## A cache, not a copy

This is the one thing to understand before anything else, because it is what
separates the virtual filesystem from [Sync](/confluence/sync/).

**The VFS loads only what you actually read.** Listing a directory costs one
request for that directory. Shell `ls` and `stat` never fetch a page body. OS mounts must report exact
file sizes: listing file entries can fetch their contents when uncached.
Listing child page directories does not fetch those children’s bodies. A branch you never open is never fetched at all.

Three consequences:

- **The cache is bounded and disposable.** It has a size limit (100 MB by
  default, attachments included) and evicts least-recently-used entries as it
  writes. `atlcli wiki vfs cache clear` is always safe: nothing here is a source
  of truth, so clearing it only costs the next read one request.
- **Prefetch has a ceiling.** A recursive `grep` that would need more than 300
  page bodies stops and tells you, rather than quietly downloading a space.
- **It is not a local copy.** If you want every page of a space on disk, as
  files you can commit, use `atlcli wiki docs pull`. That is what it is for, and
  the two formats are deliberately different — VFS paths carry page IDs and
  `docs pull` paths do not, so the directories are not interchangeable.

## Prerequisites

- An authenticated profile: `atlcli auth login`
- **View** permission on the space you open. Everything below shows exactly what
  your own account can see — Confluence filters server-side, and a page you may
  not view is simply not there.
- **Edit** permission as well, if you pass `--mode rw`.
- Data Center works, with two differences noted where they matter.

## The embedded shell

```bash
# One command, a real exit code — the form to give an agent
atlcli wiki sh --space DOCSY -c 'ls'

# Interactive
atlcli wiki sh --space DOCSY

# A script on stdin
cat script.sh | atlcli wiki sh --space DOCSY
```

The shell is a real bash interpreter (`just-bash`) with pipes, redirection,
loops, globs and roughly fifty commands, over a filesystem that happens to be
Confluence. What it does **not** have is network access: `curl`, `wget`,
`python3` and `sqlite3` are not registered, on purpose.

In interactive mode, **Tab** completes commands and paths (`gr<Tab>` → `grep`,
`cat _i<Tab>` → `cat _index.md`). Directories end in `/`; completion reads only
directory metadata, never page bodies. `cd` and environment variables persist
between inputs. Completion supports unquoted and backslash-escaped paths.

### A minimal example

```bash
atlcli wiki sh --space DOCSY -c '
  ls
  cat getting-started-623869001/_index.md | head -20
'
```

### A realistic agent workflow

```bash
# Find the pages that mention a term, read one, edit it, and check the result
atlcli wiki sh --space DOCSY --mode rw -c '
  grep -rlw kubernetes . > /tmp/hits
  page-url "$(head -1 /tmp/hits)"
  sed -i "s/kubernetes 1.28/kubernetes 1.31/" architecture-623869955/_index.md
  grep -n "1.31" architecture-623869955/_index.md
  vfs-status
'
```

### Extra commands

| Command | What it does |
|---------|--------------|
| `cql '<query>'` | Run a CQL query, print paths. Takes queries a directory name cannot hold |
| `page-id <path>` | The Confluence page ID |
| `page-url <path>` | The page's URL |
| `vfs-status` | Mode, spaces, cache state and counters |

## The mounted volume

```bash
atlcli wiki mount ~/confluence --space DOCSY
atlcli wiki mount list
atlcli wiki mount unmount ~/confluence
```

With one selected space, its pages appear directly at the mountpoint. With
multiple spaces (`--space DOCSY,OTHER`), each space has its own subdirectory.
The WebDAV URLs remain `/DOCSY/` and `/OTHER/`; the CLI selects the matching
mount URL. This does not change paths inside `wiki sh`.

| Platform | How it attaches | Notes |
|----------|-----------------|-------|
| **macOS** | `mount_webdav`, run for you | No kernel extension, no admin rights. `LOCK` is implemented, so the volume mounts **read-write** rather than read-only |
| **Windows** | `net use`, run for you | Any edition. The WebClient refuses files over **50 MB**, which affects large attachments only |
| **Linux** | printed instructions | `davfs2` needs root, so atlcli prints the `mount -t davfs` command (and an fstab line) instead of running it |

The server binds to `127.0.0.1` on a random port and is unauthenticated there,
because anything that can reach it can already read your files. Binding anywhere
else **requires** a bearer token and is refused without one.

:::caution[Search over a mount is slow]
Recursive search over an OS mount is controlled by the calling tool and can
read history and attachments. Use `atlcli wiki sh` for bounded current-page search.
:::

## What the tree looks like

```
/                                    every space you can see
├── .me.json                         who you are, and which profile
└── DOCSY/
    ├── _space.json                  space metadata (read-only)
    ├── _index.md                    the space home page's body
    ├── getting-started-623869001/   every page is a directory
    │   └── _index.md                its body
    ├── architecture-623869955/
    │   ├── _index.md
    │   ├── deployment-623870112/    child pages nest
    │   ├── _attachments/            metadata is free; bytes on open
    │   ├── .versions/               up to 50, read-only
    │   └── .comments.md             footer and inline comments, read-only
    ├── .by-id/623869955.md          any page by ID, as a symlink
    ├── .labels/runbook/             pages carrying a label
    ├── .recent/{24h,7d,30d}/        recently changed
    └── .search/text ~ "kubernetes"/ a CQL query, resolved on access
```

### Names

A page is `<slug>-<id>`. **The ID is what resolves and the slug is decoration**,
so a path keeps working after the page is retitled:

```bash
cat old-title-623869955/_index.md   # still works after a rename
cat architecture-623869955.md       # the short form for the body
```

:::note[Every page is a directory]
Including pages with no children. Deciding otherwise would mean asking
Confluence whether each listed page has children — one request per entry on
every `ls` — or guessing, which makes `ls -R` and `grep -r` silently skip
subtrees. A directory that turns out to hold only `_index.md` is the cheaper
surprise.
:::

### The convenience directories

`.labels/`, `.recent/` and `.search/` resolve **on access**. There is no
registration step:

```bash
atlcli wiki sh --space DOCSY -c '
  ls .labels/runbook/
  ls .recent/7d/
  ls ".search/text ~ \"kubernetes\" AND type = page"
'
```

Their entries are symlinks into `.by-id/`, so a page has exactly one home in the
tree however many views point at it.

Two listings are deliberately partial, and say so in their own `README`:

- **`.labels/`** lists only labels this session has seen. Confluence has no
  endpoint that enumerates the labels used in a space, and finding out means
  reading every page. Any label still resolves whether or not it is listed.
- **`.by-id/`** lists nothing. Populating it would mean enumerating the space.

## Writing

**Writing is off by default.** `--mode rw` enables create, update, rename and
move; deletion needs `--allow-delete` as well, and only ever moves a page to the
**trash** — the VFS calls no purge endpoint anywhere.

```bash
atlcli wiki sh --space DOCSY --mode rw --allow-delete -c '
  echo "# Release notes" > release-notes.md      # creates a page
  sed -i "s/draft/final/" release-notes-*/_index.md
  mkdir runbooks                                  # a page with an empty body
  mv release-notes-623869999 runbooks/            # moves it
  rm -r runbooks/release-notes-623869999          # to the trash
'
```

| What you do | What Confluence sees |
|-------------|----------------------|
| `echo > new.md`, `touch` | `POST /pages`, with the parent from the directory |
| `sed -i`, an editor save | `PUT /pages/{id}` at version + 1 |
| `mv a b` in one directory | a title change (which costs a version) |
| `mv a dir/` | a reparent |
| `mv` into another space | the v1 positional move |
| `mkdir x` | a page with an empty body |
| `rm -r x` | the trash. Never a purge |
| `cp a b` | `copyPage` |

After creating a page, the name you used keeps working for the rest of the
session even though the canonical name now carries the new ID.

### Conflicts

Every write checks the version it was based on. If the page changed underneath
you, the VFS refetches and runs a three-way merge, and retries when the merge is
clean. When it is not, the write fails with `EBUSY` and **your content is kept**:

```bash
atlcli wiki vfs conflicts list
atlcli wiki vfs conflicts show 623869955
atlcli wiki vfs conflicts discard 623869955
```

Discarding a conflict file is a local operation, so it works in read-only mode
and without `--allow-delete`.

### A warning worth reading

Some pages do not survive the Markdown round trip — a two-column layout, an
inline colour span. The VFS warns once per page when you write one, naming it,
rather than flattening it silently. Macros generally *do* round-trip.

## Search current page bodies

Recursive `grep` selects candidates through CQL within the requested subtree.
It bulk-prefetches candidate bodies up to the configured limit, then runs grep
on their Markdown. Versions, comments and attachments are not traversed implicitly;
read or search their explicit file paths separately.

```bash
grep -rlw kubernetes architecture-623869955  # whole words
grep -rl kubern architecture-623869955      # substrings
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

## Options reference

### `atlcli wiki sh`

| Option | Type | Default | Required | Notes |
|--------|------|---------|----------|-------|
| `--space <KEY[,KEY]>` | string list | the profile's space | yes, unless configured | Spaces to mount |
| `-c <script>` | string | — | no | Run one script; exit with its exit code |
| `--mode ro\|rw` | enum | `ro` | no | Write posture |
| `--allow-delete` | flag | off | no | Needed for `rm`, on top of `rw` |
| `--confirm` | flag | off | no | Skip terminal confirmation for deletion and cross-space moves; does not grant write/delete permission |
| `--sync-writes` | flag | off | no | Shell/WebDAV: disable 500 ms coalescing; rejected by NFS |
| `--cache-dir <path>` | path | `~/.atlcli/vfs` | no | Cache root |
| `--offline` | flag | off | no | Read the cache only; issue no requests |
| `--cwd <path>` | path | the first space | no | Starting directory |
| `--timeout <ms>` | number | `120000` | no | Wall-clock limit for the script |
| `--prefetch-max <n>` | number | `300` | no | Ceiling on one prefetch |
| `--cache-max-mb <n>` | number | `100` | no | Disk cache ceiling |
| `--no-cql` | flag | off | no | Use exhaustive Markdown search instead of index selection |
| `--json` | flag | off | no | stdout, stderr, exit code and counters as JSON |

### `atlcli wiki mount`

| Option | Type | Default | Required | Notes |
|--------|------|---------|----------|-------|
| `<mountpoint>` | path | — | yes | Where to attach the volume |
| `--space <KEY[,KEY]>` | string list | the profile's space | yes, unless configured | Spaces to expose |
| `--mode ro\|rw` | enum | `ro` | no | Write posture |
| `--allow-delete` | flag | off | no | Needed for deletion |
| `--sync-writes` | flag | off | no | Shell/WebDAV: disable 500 ms coalescing; rejected by NFS |
| `--cache-dir <path>` | path | `~/.atlcli/vfs` | no | Cache root |
| `--port <n>` | number | a free port | no | Bind to a fixed port |

## Configuration

Set defaults in `~/.atlcli/config.json`, globally or per profile. A profile's
value wins, key by key.

```json
{
  "vfs": {
    "cacheDir": "~/.atlcli/vfs",
    "mode": "ro",
    "spaces": ["DOCSY"],
    "cacheMaxMb": 100,
    "prefetchMaxPages": 300,
    "cqlGrep": true
  }
}
```

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `cacheDir` | string | `~/.atlcli/vfs` | Inside it, always partitioned by profile and account |
| `mode` | `"ro"` \| `"rw"` | `"ro"` | A flag still overrides this |
| `spaces` | string[] | — | Used when `--space` is absent |
| `cacheMaxMb` | number | `100` | Bodies and attachment blobs share this budget |
| `prefetchMaxPages` | number | `300` | Hard ceiling for one prefetch |
| `cqlGrep` | boolean | `true` | Accepted for compatibility; narrowing is disabled |

## Maintenance

```bash
atlcli wiki vfs cache stats          # size, entries, age
atlcli wiki vfs cache clear          # always safe
atlcli wiki vfs conflicts list       # writes that could not be merged
```

## Troubleshooting

### Browsing a page with Glow

For a single-space mount, open `glow -t <mountpoint>/<page-directory>/`
to select its Markdown files, or open `_index.md` directly. Glow recursively
scans directories, including `_attachments`; attachment metadata is shared
within the tree TTL so this does not issue one attachment-list request per
file property. Only files actually read require attachment downloads.

### Linux editor save briefly appears empty

With davfs2, inode attributes may lag an editor save for about one second.
If an immediate reopen appears empty, wait briefly and reopen it. A native
Vim save test verified complete content after metadata refresh and independent
Confluence API readback. davfs2 also queues uploads: allow a clean unmount to
flush them before stopping the server.

### Linux mount lists fail with `Invalid argument`

With Linux 6.16 or newer, davfs2 1.7.1 can mount successfully but fail to
list directories because its FUSE read buffer is too small. Upgrade to a
fixed davfs2 package (upstream 1.7.2), or set `buf_size 64` in the global
section of `/etc/davfs2/davfs2.conf`, then unmount and mount again.
Back up the configuration before editing it. See the
[upstream fix](https://github.com/alisarctl/davfs2/commit/4c6a10d7854a34ecf0cda5ee750441602a2da945).

Keep the atlcli server running while remounting. On Linux, Ctrl-C/SIGTERM
now tries `umount`, then `sudo -n umount` without a password prompt. If the
mount is busy or permissions prevent detaching, the server stays running:
close files and leave the mount directory, then retry Ctrl-C. Alternatively
run `sudo umount <mountpoint>` manually and retry. `wiki mount unmount` also
keeps the server and state intact when detaching fails.


### The Finder mounts the volume read-only

That happens when `LOCK` is unavailable. atlcli implements it, so if you see
this, check that nothing is intercepting the loopback connection, and that you
mounted the URL atlcli printed rather than an older one.

### A write fails with `EROFS`

Writing is off by default. Add `--mode rw`. If the message mentions
`--allow-delete`, the operation was a deletion, which needs that flag as well.

### A write fails and mentions a Confluence folder

Confluence folders have no body, so their `_index.md` is metadata only and
cannot be written. Create a page instead.

### `grep` says "full scan"

This indicates the exhaustive path: the pattern or options cannot use the indexed
shortcut, or `--no-cql` was set. Narrow the subtree to stay within the body budget.
Supported literal patterns use indexed selection by default.

### An externally created page is missing from a cached listing

Tree listings have a 60-second TTL. Wait for expiry, or run with a fresh
`--cache-dir` when verifying a newly created page from another client.

### A space key resolves to a different key

Use the canonical key named in the error. Space keys can contain lowercase
letters; the VFS rejects aliases rather than returning a misleading empty tree.

### A recursive command aborts naming the prefetch limit

The subtree needs more page bodies than the ceiling allows. Narrow the path, or
raise it deliberately with `--prefetch-max`.

### Requests fail with a rate-limit message

Confluence throttles bursts. atlcli retries with the server's `Retry-After` and
caps concurrency at 8; if you still hit it, the message says how long it waited.

### `sed -i` reports "No such file or directory" for a page that exists

A known rough edge in the embedded shell: `sed -i` reports every write failure
that way, so a read-only refusal loses its reason. Try the same write as a
redirect (`echo ... > page/_index.md`) to see the real message.

### `--offline` says there is no cached session

Offline mode needs to know which account the cache belongs to, and finding out
costs a request. Run the command once without `--offline` first.

### Everything is slower than it looks like it should be

Confluence API latency dominates; the protocol does not. Check `vfs-status`
for the cache hit rate — a cold cache pays one request per directory and one
bulk request per group of bodies read.

## Experimental NFS transport (development builds)

WebDAV remains the default. macOS and Linux development builds can select an
additional **experimental NFSv3** transport, read-only by default. Use
`--mode rw` for durable local staging and automatic Confluence publication.
Final distribution acceptance is tracked in the implementation specification;
this remains experimental. Windows should continue using WebDAV.

From the repository root, build the pinned helper and point the CLI at it:

```bash
cargo build --locked --manifest-path packages/confluence-nfs/Cargo.toml
export ATLCLI_NFS_HELPER="$PWD/packages/confluence-nfs/target/debug/atlcli-confluence-nfs"
bun --conditions=development run --cwd apps/cli src/index.ts \
  wiki mount ~/mnt/docsy --profile mayflower --space DOCSY --mode ro --transport nfs
```

For writable DOCSY:

```bash
atlcli wiki mount ~/mnt/docsy --profile mayflower --space DOCSY --mode rw --transport nfs
# In another terminal, after attaching with the printed command on Linux:
vim ~/mnt/docsy/newpage.md
```

No frontmatter is required: the filename supplies the initial title. After
creation, `newpage.md` remains an alias to the assigned page ID; subsequent
saves update that page. This is a virtual alias, not an OS symlink.

NFS acknowledges writes after durable local staging. Valid snapshots publish
automatically after 500 ms without newer writes; rapid saves coalesce. Local
fsync/COMMIT does **not** confirm Confluence publication, and an editor pause can
produce an intermediate wiki version. Transient API failures use bounded retry
backoff/jitter; denial, conflicts and unknown outcomes retain recovery bytes.
`--sync-writes` is rejected for NFS. Deletion requires `--allow-delete` and moves
pages to trash. Recursive OS removal is not atomic and can fail on generated
read-only views; use the page's `_index.md` for targeted trash.

When shutdown reports pending recovery, retain the journal path printed at
startup. Inspect it with `atlcli wiki mount recovery <journal.sqlite>` and export
bytes with `--id <page-id> --output <new-file>`. Remounting the same profile,
cache and selected spaces resumes eligible publication; ambiguous remote results
need positive reconciliation before another mutation.

For a combined read-only export, use `--space DOCSY,mayflower`; the mount then
contains one directory per space. A single-space export exposes its contents
directly. `wiki mount list` reports the selected transport; `wiki mount unmount
<path>` and Ctrl-C use the usual cleanup flow.

macOS uses its native `mount_nfs` client. Linux requires the NFS client package
(commonly `nfs-common`); atlcli prints the explicit privileged mount command.
The server must remain running. Busy mounts keep the server alive: close files,
leave the mounted directory and retry unmount. On helper failure, remount after
recovery; old NFS filehandles are not reusable after a helper restart.

The helper must be executable and compatible with the CLI. Missing helpers fail
without falling back to WebDAV or downloading anything. Development uses the
explicit environment variable; companion-aware review archives place the matching
helper beside the CLI. Loopback access is not isolation from other local users.

## Related topics

- [Sync](/confluence/sync/) — a complete local copy, which this is not
- [Search](/confluence/search/) — CQL, in full
- [File Format](/confluence/file-format/) — the frontmatter these files carry
- [CLI Commands](/reference/cli-commands/) — every flag


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


### Removing a page subtree

`rm -r PAGE_DIRECTORY` refreshes the subtree metadata before writing, refuses
more than 5,000 descendants or unsupported non-page children, then trashes
children before parents. Confluence does not cascade a page trash operation.
This requires `--mode rw --allow-delete`; no purge occurs. REST deletion is not
atomic: an API failure can leave a partly trashed subtree, and concurrent remote
changes after the preflight are outside that snapshot.


### macOS editor saves

TextEdit's temporary `*.sb-*` directories and backups stay in mount-local memory
instead of becoming wiki pages. The final replacement updates the existing page
ID with normal version/conflict checks. Staged files have a 64 MiB retained-byte
ceiling; failed replacements retain the draft until the client removes it or
the mount closes. The original remote page remains intact during staging.
TextEdit may warn that local document-version history is unavailable on this
volume; Confluence page versions remain available.
