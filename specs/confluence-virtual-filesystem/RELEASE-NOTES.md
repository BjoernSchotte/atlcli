# Draft release notes — Confluence virtual filesystem

For the next **minor** release (`bun scripts/release.ts minor`, which plans
0.17.2 → 0.18.0). New VFS command surface; see the indexed-search contract below.

---

## Confluence as a filesystem

`atlcli wiki sh` gives you Confluence as a shell. Spaces are directories, pages
are directories whose body is `_index.md`, and `ls`, `cat`, `grep`, `find` and
`sed` work on them.

```bash
atlcli wiki sh --space DOCSY -c 'grep -rlw kubernetes . | head'
```

It is a real bash interpreter over a filesystem that happens to be Confluence:
pipes, redirection, loops, globs, `awk`, `jq`. The exit code is the script's, so
it composes from the outside. There is no network access inside it — `curl`,
`python3` and `sqlite3` are not registered.

`atlcli wiki mount` attaches the same tree as an operating-system volume, so any
editor can open it:

```bash
atlcli wiki mount ~/confluence --space DOCSY
```

macOS and Windows need no kernel extension, no driver and no administrator
rights; Linux prints the `davfs2` command rather than asking for your password.

### A cache, not a copy

This is the part worth understanding. The VFS loads **only what you actually
read**. Listing a directory costs one request for that directory; shell `ls` and `stat` never fetch page bodies. OS mounts load uncached
file contents when needed to advertise exact sizes and avoid truncated native
reads. Unvisited child page directories remain unloaded. The disk cache is a bounded LRU — 100 MB by default, attachments
included — that is safe to delete at any moment, and a recursive operation that
would need more than 300 page bodies stops and says so rather than quietly
downloading a space.

If you want a complete local copy, as files you can commit, `atlcli wiki docs
pull` is still the tool for that. The two are deliberately different.

### Writing is off by default

`--mode rw` enables create, update, rename and move. Deletion additionally needs
`--allow-delete`, and deletion is always the **trash** — no purge endpoint is
called anywhere in the feature.

Every write is a versioned compare-and-swap with a three-way merge. If the page
changed under you and the merge conflicts, the write fails loudly and your
content is kept on disk:

```bash
atlcli wiki vfs conflicts list
```

### Search

Recursive `grep` uses CQL by default to select candidate pages, then fetches
only their current bodies and verifies actual Markdown with grep. Matching lines
and line numbers come from the bodies. CQL index gaps and indexing lag can omit
pages; a diagnostic states this explicitly.

```bash
grep -ri retrospektive *             # indexed candidates, local verification
grep --no-cql -ri retrospektive *    # exhaustive bounded search
find . -type f -name '*.md' -mtime -7
```

Unsupported grep patterns/options use bounded full scans. Explicit file operands
are checked directly. Historical versions and attachments are not traversed
implicitly. `--no-cql` is a VFS extension; standard `-v` still inverts matching.
`cql` remains an optional backup; agents can use normal grep.

Time-filtered find uses CQL only for the constrained `-type f -name '*.md'`
page-file form with supported conjunctions of `-mtime`, `-newer`, `-newermt`
and optional `-print`/`-print0`. It verifies metadata timestamps with zero page
body downloads, returns `.by-id` paths, and excludes attachments/virtual files.
Other expressions retain ordinary traversal. Index delay can omit results;
more than 1,000 candidates fails visibly and emits no partial result.

### For agents

There is a paste-ready snippet at
[Confluence for Coding Agents](https://atlcli.sh/recipes/confluence-vfs-agents/)
for `AGENTS.md`, `CLAUDE.md` or a skill file.

---

## New

- `atlcli wiki sh` — the embedded shell, with command/path tab completion
- `--sync-writes` for shell and mount; terminal mutation prompts with `--confirm` bypass
- Real HTTP-attempt and 429 counters in shell JSON and `vfs-status`
- `atlcli wiki mount`, `atlcli wiki unmount` — the OS volume
- `atlcli wiki vfs cache stats|clear` — the cache is visible and disposable
- `atlcli wiki vfs conflicts list|show|resolve|discard` — failed writes are findable
- a `vfs` config section, globally and per profile
- `@atlcli/confluence-vfs`, the functional core (experimental, 0.x)
- `ConfluenceClient.getPagesBulk`, an additive bulk body fetch

## Known limitations

- A mounted volume has no shell prefetch budget. Use `atlcli wiki sh` for
  bounded current-page searches.
- Inside the shell, `sed -i` reports every write failure as "No such file or
  directory", so a read-only refusal loses its reason there. A redirect
  (`echo … > page/_index.md`) shows the real message.
- Confluence folders have no body, so their `_index.md` is read-only.
- Data Center: no bulk body fetch and no bulk version probe exist in REST v1, so
  prefetch falls back to one request per page.

## Acceptance status before releasing

- [x] Live mayflower/DOCSY read/write and MAYFLOWER read-only probes, with cleanup.
- [x] Gated shell and mount E2E, including native macOS kernel mount writes.
- [x] Finder listing and macOS mdutil indexing/search-disabled observation.
- [x] TextEdit safe-save: native save and API readback passed after staging/backup fix.
- [x] Compiled macOS arm64 executable: nine artifact smoke tests pass.
- [x] Artifact growth gate: +3.22%, within both thresholds.
- [x] Startup measured: +88–99 ms exceeds the 15 ms gate. **User accepted the
      overhead for now**, so optional-shell packaging is deferred, not silently
      treated as a passing measurement.
- [x] Final repository checks: 9,008 passed, 40 skipped, zero failures; typecheck and build pass.
- [x] Native Linux x64 artifact tests and read-only davfs2 mount; davfs2 1.7.1 needs `buf_size 64` on kernel 6.17.
- [x] Native Linux full cold reads and filesystem edits with independent API readback; synthetic page cleaned.
- [ ] Native Linux GUI editor-specific safe-save behaviour.
- [ ] Windows WebClient and indexing; no Windows environment is available.
- [ ] Two-identity live permission isolation; only mayflower is configured.
- [ ] Actual Homebrew installation/test lifecycle for the new artifact. Formula
      inspection and equivalent executable command pass, but installed 0.17.1
      is older than formula 0.17.2 and `brew test` refuses it.

See [LIVE-RESULTS.md](./LIVE-RESULTS.md),
[RELEASE-VALIDATION.md](./RELEASE-VALIDATION.md) and [PLAN.md](./PLAN.md).
WP10 remains after v1. No release is authorized by these draft notes.
