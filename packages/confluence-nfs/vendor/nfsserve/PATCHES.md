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
