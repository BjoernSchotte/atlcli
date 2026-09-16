# Confluence as a filesystem, for coding agents

Drop this into `AGENTS.md`, `CLAUDE.md`, a Cursor rule or a skill file. It is
written to be pasted, not read aloud.

---

## For the agent

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

Recursive `grep` searches current page bodies in the requested subtree, with
bounded bulk prefetch. It does not implicitly search versions or attachments.

```bash
grep -rlw kubernetes .        # whole-word matches in current Markdown
grep -rl  kubern .            # substring matches, including "kubernetes"
```

CQL never excludes possible `grep` matches: indexing can miss dotted tokens,
Markdown frontmatter and fresh writes. For `grep -q`, cached pages are checked
first; a simple positive word search may then use CQL to prioritize up to ten
candidates. Every success is verified against full Markdown. An empty or failed
CQL response falls back to the exact search. `--no-cql` disables these hints.

Use indexed previews to discover relevant pages without downloading bodies:

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
no-match. Full cold-space exact searches still need all selected bodies.
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
