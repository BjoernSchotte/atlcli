# Draft release notes — Confluence virtual filesystem

For the next **minor** release (`bun scripts/release.ts minor`, which plans
0.17.2 → 0.18.0). Additive: no existing command changes behaviour.

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
read**. Listing a directory costs one request for that directory; `ls`, `stat`
and a Finder window never fetch a page body; a branch nobody opens is never
fetched. The disk cache is a bounded LRU — 100 MB by default, attachments
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

`grep` can use Confluence's search index, which turns a subtree scan into one
query — but only when you mark the pattern as a whole word:

```bash
grep -rlw kubernetes .     # uses the index
grep -rl  kubern .         # reads the subtree, and finds "kubernetes"
```

The index matches words while `grep` matches substrings, so an unmarked pattern
takes the slower path rather than risking an empty result that reads like "not
found". The path taken is always printed on stderr.

### For agents

There is a paste-ready snippet at
[Confluence for Coding Agents](https://atlcli.sh/recipes/confluence-vfs-agents/)
for `AGENTS.md`, `CLAUDE.md` or a skill file.

---

## New

- `atlcli wiki sh` — the embedded shell
- `atlcli wiki mount`, `atlcli wiki unmount` — the OS volume
- `atlcli wiki vfs cache stats|clear` — the cache is visible and disposable
- `atlcli wiki vfs conflicts list|show|resolve|discard` — failed writes are findable
- a `vfs` config section, globally and per profile
- `@atlcli/confluence-vfs`, the functional core (experimental, 0.x)
- `ConfluenceClient.getPagesBulk`, an additive bulk body fetch

## Known limitations

- A mounted volume cannot use the CQL shortcut, so full-text search over a mount
  reads every page. Use `atlcli wiki sh` for search.
- Inside the shell, `sed -i` reports every write failure as "No such file or
  directory", so a read-only refusal loses its reason there. A redirect
  (`echo … > page/_index.md`) shows the real message.
- Confluence folders have no body, so their `_index.md` is read-only.
- Data Center: no bulk body fetch and no bulk version probe exist in REST v1, so
  prefetch falls back to one request per page.

## Before releasing

- [ ] Run the two live probes on a machine with the `mayflower` profile
      (`spikes/vfs-just-bash/live-spike.ts` and `cql-text-semantics.ts`) and fold
      the CQL table into `EVIDENCE.md`. The `grep` guard stays at its strictest
      until that table exists.
- [ ] Run `ATLCLI_WIKI_SH_E2E=1` and `ATLCLI_WIKI_MOUNT_E2E=1` against DOCSY.
- [ ] On a Mac, run the kernel half (`ATLCLI_WIKI_MOUNT_KERNEL=1`) and confirm
      the Finder mounts read-write and Spotlight leaves the volume alone.
- [ ] Re-measure startup on release hardware (WP9.5 / `EVIDENCE.md` section 1).
      On the CI container the feature adds 145 ms; the decision-11 gate is 15 ms
      and the container is roughly ten times slower than a developer machine.
- [ ] Verify the Homebrew formula and the compiled binaries with
      `atlcli wiki sh --space DOCSY -c 'ls'`.
