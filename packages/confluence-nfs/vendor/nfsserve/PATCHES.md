# Pinned nfsserve source

Source: crates.io `nfsserve` 0.11.0, upstream revision `af4f1176dd709847f3dda4f1a7cd093edaadde63`.
Crate SHA-256: `ef1424b6d88c60a091931392970999ea3ceab132d968e6a5545c770fad5b97d7`.
License: BSD-3-Clause; original LICENSE and attribution retained.

Copied the crate's Cargo.toml, README, LICENSE and src/ without generated build
artifacts. Cargo uses this local source, with the helper's locked dependency graph.
No runtime or build-time source download/patch script is required.

Trailing whitespace in README.md and src/rpc.rs is normalized for repository checks.

Local functional changes in src/nfs_handlers.rs:

- READDIR calls the paginated `readdir(dirid, cookie, count)` hook, as READDIRPLUS
  already does. Upstream `readdir_simple` always restarts at zero and omits the
  client's cookie, repeating the first page indefinitely.
- READDIR/READDIRPLUS reject reply budgets at or below their 128-byte overhead
  with NFS3ERR_TOOSMALL, preventing unsigned subtraction underflow.
- Buffer the bounded directory reply until at least one entry fits (or genuine
  EOF). Return TOOSMALL for an empty non-EOF result instead of trapping clients
  in a retry loop. A zero entry estimate still probes one entry to detect EOF.

Regression proof: apps/cli/src/vfs/nfs-bridge.test.ts exercises both procedures
with small multi-page replies through the actual Rust TCP listener and Bun VFS.
Keep patches minimal; compare this file and upstream before version upgrades.

Directory mutation follow-up: vfs.rs adds a default `readdir_with_verifier` hook.
Both handlers pass the client's cookie verifier (or the observed directory
version for the initial request). The Bun adapter checks it against the exact
metadata listing used for pagination, returning BAD_COOKIE on change. This avoids
a check-then-list race and lets clients restart instead of silently skipping rows.

Wire allocation follow-up: rpcwire.rs rejects records larger than 4 MiB before
resizing and rejects more than 1,024 fragments per record (including empty ones).
xdr.rs checks byte and u32-array lengths before allocating, with a 4 MiB decoded
payload limit. This closes each malformed connection; the listener stays alive.
This is not yet a bound on total connections, pending tasks or queued responses.

Connection-budget follow-up: tcp.rs admits at most 32 connections and processes
one RPC at a time on each connection. The unbounded task/reply-channel design is
removed from rpcwire.rs. Read/idle, dispatch and reply-write deadlines are 60,
120 and 30 seconds. The transaction tracker retains at most 4,096 entries and
removes a TCP session's entries on disconnect. Capacity rejects new work rather
than evicting another live session's replay history. This does not provide replay
reconciliation across reconnects; write publication still requires its journal.

READ coherence follow-up: omit optional post-operation attributes instead of
fetching them separately before reading. The current hook cannot return
attributes and bytes from the same snapshot. This also avoids a second Markdown
materialization per READ. GETATTR remains available; clients may request it
separately. An atomic read-and-attributes hook remains the upgrade path, and this
does not establish a snapshot across multiple READ requests.

Metadata failure follow-up: ACCESS, FSSTAT and PATHCONF propagate getattr errors
instead of returning NFS3_OK with absent attributes for an expired or inaccessible
object. Their error replies contain the status and absent post-op attributes.
PATHCONF advertises the adapter's actual 255-byte name limit, with no_trunc true;
the Bun adapter and Rust bridge return NAMETOOLONG for larger UTF-8 names.
Wire regressions cover deleted-object handles on all three procedures, PATHCONF
fields, and ASCII/Unicode name boundaries. See RFC 1813 sections 3.3.4, 3.3.18,
3.3.20 and filename handling: https://www.rfc-editor.org/rfc/rfc1813.html.

- FSINFO failure replies include the required absent post-operation attributes,
  allowing the helper's identity-aware FSINFO implementation to return STALE
  without producing a truncated XDR error arm.
- ACCESS removes the directory-only LOOKUP bit for non-directory objects.

Request accounting: tcp.rs retains one atomic counter of complete received RPC
records, before dispatch. It includes mount/NULL/failed/replayed calls, even when
they do not invoke the VFS. Incomplete or oversized rejected records are not
counted. The helper reads it over the private pipe; no diagnostic payload or
unbounded request history is retained.

COMMIT follow-up: nfs_handlers.rs implements COMMIT for the existing all-FILE_SYNC
write contract. Successful writes are already durable; COMMIT validates the
handle, regular-file type and range overflow, returns post-operation attributes
and the same session verifier as WRITE, and does not call remote publication.
Read-only exports return ROFS. If WRITE ever begins returning UNSTABLE, this
handler must gain a real stable-storage flush hook before that change ships.
Real-wire tests cover full/ranged COMMIT, matching verifiers, stale handles,
directories, overflow and RO rejection.

EXCLUSIVE CREATE: deserialize its eight-byte verifier and forward it through the
VFS hook. The upstream handler omitted that field entirely. The adapter persists
the verifier with its local file and accepts only a matching existing-file replay;
a different verifier returns EXIST without truncating acknowledged bytes.


## Directory mutations

MKDIR forwards the caller's `sattr3` to the filesystem hook instead of silently
ignoring requested attributes. REMOVE and RMDIR pass an explicit directory flag
so implementations can enforce EISDIR/ENOTDIR and nonempty-directory semantics.


## Guarded CREATE

Pass the GUARDED flag into the filesystem create hook. Remove the separate
lookup-before-create check: the backend must enforce existence and creation
atomically rather than racing another request between those operations.

LOOKUP performance follow-up: omit incidental parent post-operation attributes.
Computing them enumerated all siblings for every Linux LOOKUP while listing a
large directory. The real lookup still validates parent type, identity, scope
and child access; explicit GETATTR and READDIR retain current directory revisions.
RFC 1813 section 2.5 permits absent post-op attributes (while encouraging best
effort); clients may issue GETATTR separately. The wire regression verifies
successful/missing/invalid names without sibling enumeration and explicit
GETATTR refresh. Native mutation/visibility tests cover client cache behavior.
