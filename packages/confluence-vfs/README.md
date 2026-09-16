# @atlcli/confluence-vfs

Confluence as a filesystem, as a functional core.

This package maps Confluence spaces, pages, attachments, labels and versions
onto POSIX filesystem semantics — `stat`, `readdir`, `readFile`, `writeFile`,
`rename`, `rm` — and nothing else. It contains no shell, no server, no CLI and
no `node:fs`. The two frontends live in `apps/cli`:

| Frontend | Adapter | What it gives you |
|----------|---------|-------------------|
| `atlcli wiki sh` | `apps/cli/src/vfs/just-bash-fs.ts` | an embedded bash over the VFS |
| `atlcli wiki mount` | `apps/cli/src/vfs/webdav-fs.ts` | a real OS mount over loopback WebDAV |

## A cache, not a mirror

The binding invariant (plan section 1b): **only what was actually read reaches
the disk.** `ls`, `stat` and `PROPFIND` never fetch a body. Directories load one
level at a time. Prefetch has a hard ceiling. The disk cache is a bounded LRU
that can be deleted at any moment without losing anything.

That is what separates this from `docs pull`, which makes a complete local copy
and remains the right tool when a complete local copy is what you want.

## Design

- `types.ts` — `VfsNode`, `VfsStat`, `VfsDirent`, `VfsError`.
- `vfs.ts` — the `ConfluenceVfs` interface both frontends adapt.
- `options.ts` — everything the core needs, passed in; it reads no config file.
- `client-port.ts` — the exact slice of `ConfluenceClient` the VFS may use.
- `errors.ts` — HTTP to POSIX, and the 429 retry band.
- `mode.ts` — the single gate every mutating operation passes through.
- `testing/` — `FakeConfluenceClient`, the substrate of every unit test.

Permissions are **not** this package's job. Confluence filters server-side per
caller, so a restricted page answers `ENOENT` here exactly as it answers 404
there. What the package must get right instead is never sharing a cache across
profiles, which is why the cache path always carries the profile and account ID.

See [`specs/confluence-virtual-filesystem/PLAN.md`](../../specs/confluence-virtual-filesystem/PLAN.md).
