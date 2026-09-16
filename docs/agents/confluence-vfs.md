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
Attachment directory listings and stat use exact Confluence size metadata without
downloading attachment contents. A read downloads the attachment through the
shared body cache; subsequent ranges reuse it.

Existing page/body handles also survive a page move after the changed hierarchy
is observed: the adapter resolves the same page ID within the selected spaces.
Moving outside the export or deleting the page expires the handle. This does not
yet promise handle recovery for moved folders or attachment views.
Deleted or replaced identities report `ESTALE`; look up the path again, or remount
after a helper restart. Single-space and combined-space native reads are covered
by the [NFS evidence](../../specs/confluence-vfs-nfs-transport/EVIDENCE.md).

The NFS helper uses the pinned local nfsserve patch for correct multi-page
READDIR results. Rebuild the helper alongside source updates; an older helper
can repeat the first directory page. See its [patch notes](../../packages/confluence-nfs/vendor/nfsserve/PATCHES.md).

If a directory changes during NFS pagination, the server returns `BAD_COOKIE`;
restart the listing if the OS does not retry automatically. Directory timestamps
track changes observed by this mount. Source builds require bridge-version-2
helpers; rebuild an older companion binary before mounting.

The experimental NFS listener rejects RPC records over 4 MiB, more than 1,024
fragments per record, and XDR arrays exceeding 4 MiB before allocating their
payload. Malformed connections are closed; reconnect with a valid request.

NFS accepts at most 32 simultaneous TCP connections and handles requests in order
within each connection. Idle or incomplete requests disconnect after 60 seconds;
clients can reconnect. Dispatch and response-write deadlines are 120 and 30
seconds. Replay tracking is capped at 4,096 entries; exceeding capacity closes
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
