# Security review — Confluence virtual filesystem (WP9.1)

Reviewed: the whole VFS diff — `packages/confluence-vfs`, `apps/cli/src/vfs`,
`apps/cli/src/commands/wiki-{sh,mount,vfs}.ts`, and
`ConfluenceClient.getPagesBulk`.

Every claim below is **enforced by a test**, named in the last column, so it
stays true rather than being true on the day it was written. The tests live in
`packages/confluence-vfs/src/security.test.ts` unless stated otherwise.

## What this feature actually adds to the attack surface

Three things, and it is worth being precise about them:

1. **A shell that can write to Confluence.** Off by default, gated twice.
2. **An HTTP server**, on loopback, with no authentication by default.
3. **A disk cache holding page content**, under the user's home directory.

Everything below is about those three.

## 1. Deletion is the trash, never a purge

| Claim | Test |
|-------|------|
| The client port declares no purge endpoint | "the client port exposes no purge endpoint" |
| No source file calls anything purge-shaped | "no source file calls anything purge-shaped" |
| A delete leaves the page recoverable | "a delete leaves the page recoverable" |

`deletePage` is Confluence's trash. An administrator can restore from it. The
VFS offers no route to `DELETE /content/{id}?status=trashed`, which is the call
that actually destroys content.

## 2. Writing is gated twice, and the gates are one function

| Claim | Test |
|-------|------|
| Every file that reaches a Confluence write also references the guard | "every file that writes to Confluence also references the guard" |
| `ro` refuses create, update, mkdir, rename, copy and delete | "refuses every mutating operation in ro mode" |
| **Nothing reaches the tenant when the mode refuses** | same test, asserting all ten write methods at zero |
| `rm` stays refused in `rw` until `--allow-delete` | "keeps delete gated behind allowDelete even in rw mode" |
| The refusal is visible through the shell | `wiki-shell.test.ts`, "refuses every write in ro mode" |
| The refusal is a 403 through WebDAV, not a 500 | `webdav-fs.test.ts`, "refuses a PUT with 403 in ro mode" |

`assertWritable` in `mode.ts` is the only function that can say yes. The
structural test cannot prove the guard runs on every path — the per-operation
tests do that — but it catches a whole new module written without one, which is
the realistic regression.

**Nothing raises the mode implicitly.** The default is `ro`; a config file the
user wrote can change it; a flag can change it; nothing else can.

## 3. Generated views are read-only whatever the flags

| Claim | Test |
|-------|------|
| `.versions/`, `.comments.md`, `_space.json` and `.me.json` refuse writes with every flag set | "refuses to write any of them, even with every flag set" |
| They refuse deletion too | "refuses to delete them too" |
| A Confluence folder's `_index.md` refuses writes | `write-back.test.ts` |

## 4. No credential leaves the process

| Claim | Test |
|-------|------|
| The audit log carries no token, password or authorization header | "keeps the token out of the audit log, the cache and the snapshot" |
| The audit log records *what was touched*, never what was written | "records what was touched, never what was written" |
| `.me.json` carries nothing secret | "keeps .me.json free of anything secret" |

The audit log holds timestamp, profile, account ID, operation, path, page ID,
versions, result and error **code**. Not the error message, because a message
can quote content; not the body, because a log of bodies would be a second
uncontrolled copy of the space.

Tokens are held by `ConfluenceClient` and never passed into the VFS core — the
core takes a client, not a credential. `VfsOptions` carries a profile *name*.

## 5. Visibility is Confluence's, and the cache never undermines it

| Claim | Test |
|-------|------|
| A restricted page is `ENOENT`, never `EACCES`, in listings, by path and by ID | "hides it from every route" |
| One profile's cache gives another profile nothing | "gives one profile nothing from another profile's cache" |
| The same holds against a live tenant | `apps/cli/src/e2e/wiki-vfs-permissions.e2e.test.ts` (gated) |
| A cache path cannot escape its directory | `body-cache.test.ts`, "refuses to let a profile or account name escape" |

The cache path is always
`<cacheDir>/<profile>/<accountId>/<siteHash>.db`. Dropping any of the three
segments would let one caller read content another caller's token returned, so
the construction is not optional and the profile and account names are
sanitized against traversal.

`404` maps to `ENOENT` rather than `EACCES` on purpose: Confluence answers 404
for a page that exists but is restricted, and answering `EACCES` would confirm
its existence.

## 6. The WebDAV server

| Claim | Test |
|-------|------|
| Loopback is unauthenticated; any other binding is **refused** without a token | `webdav-fs.test.ts`, "refuses a non-loopback binding without a token" |
| The generated token has real entropy | "generates a token with enough entropy to be worth having" |
| Bearer comparison is length-independent | `webdav-server.ts`, `timingSafeEqual` |
| The filesystem refuses to serialize itself | `ConfluenceWebdavSerializer` |

Serialization is refused because `webdav-server` can persist a filesystem's
state to disk: for a live view of a tenant that would be both stale and an
unbounded second copy of content the user may no longer be allowed to see.

## 7. The embedded shell

- **No network access.** `curl`, `wget`, `python3`, `js-exec` and `sqlite3` are
  not registered. Verified by `wiki-shell.test.ts`, "keeps the network commands
  out of the shell entirely".
- **Bounded.** 8 MB of output and 120 s of wall clock per script, by default.
- **`defenseInDepth: false`**, which is a real reduction and worth stating
  plainly. It is a *secondary* layer by upstream's own threat model; the
  interpreter's sandbox, the command allow-list and the absence of network
  access are the primary ones and stay on. atlcli runs these scripts locally
  with the user's own rights, so the layer being removed protects against an
  attacker who already has everything it would protect. It is off because
  just-bash 3.4.2 throws on every `exec()` under Bun (issue #386), reproduced in
  `spikes/vfs-just-bash/`. A `TODO` in `wiki-shell.ts` links the issue.

## 8. Denial of service against the user's own tenant

The demand principle is a security property as much as a performance one: a
filesystem that can be walked into downloading a whole space is a filesystem an
indexer can turn into a rate-limit incident.

| Guard | Default | Test |
|-------|---------|------|
| Prefetch ceiling | 300 pages | `invariants.test.ts` |
| Recursive walk budget | 5,000 nodes | `invariants.test.ts` |
| Disk cache | 100 MB, enforced during writes | `body-cache.test.ts` |
| Request concurrency | 8 | `options.ts` |
| Spotlight exclusions **served**, not 404'd | — | `webdav-fs.test.ts` |
| Indexer sweep reported | 50 unlisted reads in 10 s | `webdav-perf.test.ts` |

## Residual risks, stated rather than closed

1. **`defenseInDepth: false`**, as above. Re-enable when upstream #386 is fixed
   (plan WP10).
2. **The loopback server is unauthenticated.** Any local process running as the
   user can read the mounted spaces through it while a mount is up. That is the
   same trust boundary as the user's own files, and the alternative — a token
   the OS mount client would have to carry — is not something `mount_webdav`
   supports. Documented.
3. **The cache is unencrypted** on disk, like every other atlcli cache and like
   `docs pull` output. It is bounded and deletable; `atlcli wiki vfs cache
   clear` is the documented remedy.
4. **Live permission isolation is unverified against a real tenant.** The test
   exists and is gated (WP9.2); it needs two profiles on one site.
5. **Third-party code:** `just-bash@3.4.2` (Apache-2.0, beta) and
   `webdav-server@2.6.3` (Unlicense), both pinned exactly.
