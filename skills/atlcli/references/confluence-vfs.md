---
name: confluence-vfs
description: Confluence as a filesystem: the embedded shell (wiki sh), the OS mount (wiki mount) and the cache and conflict commands (wiki vfs).
metadata:
  tags: confluence, shell, vfs, mount, grep, webdav, nfs
---

# Confluence as a filesystem

Spaces are directories, pages are directories, and a page's body is the
Markdown file `_index.md` inside it. Three commands share one core:

| Command | Use it for |
| --- | --- |
| `wiki sh` | Agents and scripts: search page bodies, read pages, edit one or a few pages. |
| `wiki mount` | A real OS volume for editors and the Finder. A long-running foreground server. Not for agents. |
| `wiki vfs` | Maintain the local cache and list unmerged writes. |

The tree is a cache, not a copy. Listing a directory costs one request,
`ls` and `stat` never fetch bodies, and a recursive operation that would need
more than 300 page bodies stops with exit code 2 instead of downloading a
space. For a complete local copy use `wiki docs pull`
([confluence-docs-sync.md](confluence-docs-sync.md)).

## Which tool for which job

| Job | Tool |
| --- | --- |
| Find pages that mention a term, read a few | `wiki sh -c 'grep -rlw …'` |
| Small edit to one page | `wiki sh --mode rw -c 'sed -i …'` |
| Edit many pages, review a diff, keep files in git | `wiki docs` |
| Create a page with a known parent and title | `wiki page create` or `wiki docs add` |
| Keep a folder open in an editor | `wiki mount` (user's own terminal) |

`wiki sh` writes through a versioned compare-and-swap with a three-way merge
(`atlcli wiki vfs conflicts` lists merges that failed). `wiki docs push` has
no such check, so the shell is the safer way to change a page that other people
edit. Treat every `--mode rw` call as a Confluence write: the confirmation
rules in [safety.md](safety.md) apply.

## The shell

```bash
atlcli wiki sh --space DOCS -c 'ls'
atlcli wiki sh --space DOCS -c 'grep -rlw kubernetes . | head -20'
atlcli wiki sh --space DOCS -c 'cat getting-started-12345/_index.md | head -40'
atlcli wiki sh --space DOCS --json -c 'cat architecture-67890/_index.md'
```

- `-c <script>` runs one script. The exit code of the CLI is the script's bash
  exit code. Without `-c` and without a terminal, the script is read from stdin.
- `--json` returns `stdout`, `stderr`, `exitCode`, `diagnostics` and request
  counters in one document.
- `--space <KEY[,KEY]>` is required unless the profile has a default space or
  the config has `vfs.spaces`.
- The shell is an embedded bash with pipes, redirection and about fifty
  commands. `curl`, `wget`, `python3` and `sqlite3` do not exist in it.
- Extra commands: `cql '<query>'` (paths of matching pages), `page-id <path>`,
  `page-url <path>`, `vfs-status`.
- `--offline` reads only the cache. `--timeout <ms>` bounds the script
  (default 120000). `--prefetch-max <n>` raises the 300-body ceiling.

A page directory is named `<slug>-<id>`. The id resolves; the slug is
decoration, so a path survives a rename. `cat architecture-67890.md` is the
short form for the body. Besides `_index.md` a page directory holds
`_attachments/`, `.versions/` (read-only) and `.comments.md` (read-only). The
space root holds `_space.json`, `.by-id/`, `.labels/<label>/`,
`.recent/{24h,7d,30d}/` and `.search/<cql>/`; these resolve on access.

A page file starts with an `atlcli:` frontmatter block (`id`, `title`,
`version`, `parentId`, `labels`, `lastModified`, `url`). The `title` key sets the
page title on save.

### Searching

Recursive `grep` first asks the Confluence index for candidate pages in the
requested subtree, then verifies the lines against the Markdown. The path taken
is printed on stderr.

```bash
grep -rlw kubernetes .          # index-backed candidates, verified locally
grep --no-cql -r -i foo .       # exhaustive; bounded by the download budget
find . -type f -name '*.md' -mtime -7   # recently changed, no body downloads
```

An empty index result means no indexed candidates, not proof that no page
contains the text, because the index lags. Complex regexes, `-v`, `-c`, `-L`
and `-f` fall back to a visible full scan. Exit code 2 means the budget ran out
or the candidate list was truncated, never a clean "no match".

## Editing a page

```bash
atlcli wiki sh --space DOCS --mode rw -c '
  sed -i "s/kubernetes 1.28/kubernetes 1.31/" architecture-67890/_index.md
  grep -n "1.31" architecture-67890/_index.md
'
```

- Writing is off by default (`--mode ro`). `--mode rw` allows create, update,
  rename and move. `rm` needs `--allow-delete` as well and only moves the page
  (and with `rm -r` its descendants) to the trash.
- `rm` and a cross-space `mv` prompt on a terminal unless `--confirm` is set.
  Without a terminal, `--mode rw` and `--allow-delete` are enough, so an agent
  must get the user's approval before passing them.
- `echo "# Title" > new.md` creates a page under the current directory's page.
  `mkdir x` creates a page with an empty body. `mv a b` in one directory
  renames, `mv a dir/` reparents.
- A conflicting concurrent edit makes the write fail with `EBUSY` and keeps your
  content: `atlcli wiki vfs conflicts list`, `show <id>`, `discard <id>`.
- The shell warns once per page, naming it, when the page does not survive the
  Markdown round trip (for example multi-column layouts and inline colour
  spans). Do not save such a page through the shell. Use the Confluence editor.
- `sed -i` reports every write failure as `No such file or directory`. Repeat
  the write as `echo … > file` to see the real error (`EROFS` means read-only
  mode, a denial of your own credentials is `EACCES`).
- Writes are coalesced for 500 ms. `--sync-writes` persists each write at once.

## Mounting

```bash
atlcli wiki mount ~/confluence --space DOCS            # read-only, WebDAV
atlcli wiki mount ~/confluence --space DOCS --mode rw
atlcli wiki mount list
atlcli wiki mount unmount ~/confluence
```

`mount` runs in the foreground until Ctrl-C, so an agent cannot use it from a
tool call that must return. It exists for the user's editors and the Finder.
The default transport is WebDAV on `127.0.0.1`: `mount_webdav` on macOS, `net
use` on Windows, and printed `davfs2` instructions on Linux. Recursive search
over a mount can walk history and attachments, so search with `wiki sh` instead.

`--transport nfs` is experimental and macOS and Linux only. It needs the helper
binary `atlcli-confluence-nfs` next to the `atlcli` executable (or
`ATLCLI_NFS_HELPER` set) and the platform NFS client, and it never falls back to
WebDAV. With `--mode rw`, saves are staged in a local journal and published
after 500 ms without newer writes. `atlcli wiki mount recovery <journal.sqlite>
[--id <page-id> --output <file>]` exports staged bytes the helper could not
publish. The helper's `--version` prints JSON and starts no listener; it is not
a command to run on its own.

## Maintenance

```bash
atlcli wiki vfs cache stats
atlcli wiki vfs cache clear      # always safe; the cache is never the source of truth
atlcli wiki vfs conflicts list
```

Config defaults live under `vfs` in `~/.atlcli/config.json` (`cacheDir`, `mode`,
`spaces`, `cacheMaxMb`, `prefetchMaxPages`). A `mode` of `rw` there makes every
`wiki sh` call writable without a flag, so check it before assuming read-only.

## Pitfalls

- Pass `--mode rw` only for the call that needs to write.
- A page listing is cached for 60 seconds. A page created elsewhere can be
  missing from `ls` until then.
- `.labels/` lists only labels already seen in the session, and `.by-id/` lists
  nothing, though both resolve any name you ask for.
- Confluence folders have no body: their `_index.md` cannot be written.

Related: [confluence-docs-sync.md](confluence-docs-sync.md),
[confluence-pages.md](confluence-pages.md), [safety.md](safety.md).
