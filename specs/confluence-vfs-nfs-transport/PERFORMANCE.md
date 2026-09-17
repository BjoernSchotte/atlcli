# Native transport performance

## Contents

- [Reproduction](#reproduction)
- [Results](#results)
- [Complete large-directory scan](#complete-large-directory-scan)
- [Interpretation and limits](#interpretation-and-limits)
- [Related material](#related-material)

## Reproduction

Install the matching NFS helper, Vim and Glow. Linux also needs davfs2 and
passwordless sudo for the native test mounts. Run from the repository root:

```sh
ATLCLI_NFS_TEST_HELPER="$PWD/packages/confluence-nfs/target/debug/atlcli-confluence-nfs" \
  bun --conditions=development scripts/bench/run-vfs-mount.ts /tmp/vfs-mount-results.json
```

The harness uses only synthetic data: 26 pages across six listed directories
for read/first-render/editor workloads, and 602 pages for `glow-scan`, with
long Unicode bodies and a 1.3 MB attachment. It runs five isolated processes
per workload and transport, alternating transport order. Each process owns a
fresh endpoint, kernel mount, VFS cache and (on Linux) davfs cache, followed
by an immediate second workload on the same mount. All mounts detach normally.
Read/Glow mounts are read-only; only the editor fixture is writable.

## Results

| Host | Workload / metric | Phase | WebDAV ms, median [min–max] | NFS ms, median [min–max] | API calls WebDAV / NFS (median) |
| --- | --- | --- | --- | --- | --- |
| mac | complete read | cold | 74.6 [71.5–79.4] | 102.8 [99.5–112.8] | 47 / 64 |
| mac | complete read | warm | 13.1 [11.8–13.6] | 4.0 [3.9–10.3] | 0 / 0 |
| mac | Glow first listing | cold | 46.8 [31.0–78.9] | 32.2 [30.0–32.7] | 33 / 21 |
| mac | Glow first listing | warm | 32.1 [31.5–33.7] | 32.5 [30.9–33.4] | 0 / 12 |
| mac | Vim save → API | cold | 516.5 [515.3–519.0] | 537.5 [533.8–539.7] | 6 / 3 |
| mac | Vim save → API | warm | 512.7 [512.4–513.0] | 527.8 [524.0–529.4] | 2 / 1 |
| linux | complete read | cold | 128.4 [99.0–133.4] | 140.1 [134.6–146.1] | 82 / 64 |
| linux | complete read | warm | 8.0 [7.0–9.9] | 24.3 [22.5–26.5] | 0 / 0 |
| linux | Glow first listing | cold | 48.8 [30.2–49.5] | 65.6 [48.5–66.4] | 22 / 23 |
| linux | Glow first listing | warm | 33.2 [30.1–34.3] | 33.9 [32.7–34.8] | 27 / 8 |
| linux | Vim save → API | cold | 508.1 [507.7–509.3] | 509.8 [509.4–510.2] | 1 / 2 |
| linux | Vim save → API | warm | 501.9 [501.8–502.6] | 505.0 [504.4–505.2] | 1 / 1 |

Full samples and median/min/max of every numeric metric are retained in
[macOS results](benchmark-extended-mac.json) and
[Linux results](benchmark-extended-linux.json). These include startup, first
listing/byte, complete-read time, API requests/payload bytes, cache hits,
protocol requests, parent/helper RSS and shutdown.

## Complete large-directory scan

The separate `glow-scan` workload waits until the native Glow TUI lists all
602 Markdown documents, then renders the selected fixture. Run it alone with:

```sh
ATLCLI_NFS_TEST_HELPER="$PWD/packages/confluence-nfs/target/debug/atlcli-confluence-nfs" \
  bun --conditions=development scripts/bench/run-vfs-mount.ts /tmp/glow-scan.json "" glow-scan
```

The table measures completed enumeration, excluding subsequent selected-file
rendering. Periodic terminal resizes force full counter redraws; observation
resolution is up to 500 ms. All five cold/warm samples per transport/host
verified the expected document count. Raw metrics, including selected rendering,
API methods/payloads, RSS and shutdown, are in [macOS](benchmark-glow-scan-mac.json)
and [Linux](benchmark-glow-scan-linux.json).

| Host | Phase | WebDAV ms, median [min–max] | NFS ms, median [min–max] |
| --- | --- | --- | --- |
| mac | cold | 3549.1 [3546.5–4395.8] | 8916.1 [8648.1–11065.2] |
| mac | warm | 1765.7 [1697.6–1882.4] | 6682.8 [6415.9–7499.5] |
| linux | cold | 4630.9 [4117.5–4680.2] | 6701.5 [6632.7–6731.9] |
| linux | warm | 2579.7 [2063.2–2597.3] | 3114.1 [3097.4–3146.6] |

NFS exceeds the 10% regression review threshold on both hosts. Explicit NFS
directory attribute validation and Glow's recursive stat/walk work make this
workload more expensive; this is evidence against a blanket NFS speed claim.
WebDAV remains the default. Cold scans materialize visited Markdown bodies for
exact sizes. Warm scans never download an already cached body again, but they
still issue roughly 1204–1208 metadata calls: the bounded 256-entry comment and
attachment listing caches cannot retain all 602 directories. A first-ever
version read on the second pass is allowed and appears in the recorded methods.
This complete-tree workload is distinct from interactive first selection and
from the approximately 500 ms editor-save measurements above.

The original macOS NFS options intermittently returned `ETIMEDOUT` from
`fdopendir`; Glow 2.1.1 then silently omitted one document. A temporary pinned
Glow diagnostic build identified the missing paths and actual errors. macOS
now uses `dumbtimer` to honor its configured retransmit timer rather than the
adaptive loopback estimate. The five-run results use the installed, unmodified
Glow binary; every scan found all 602 documents.

## Interpretation and limits

- This is a transport comparison against the same in-process synthetic API on
  each host. It does not measure Confluence network latency. Compare transports
  within one host, not macOS against Linux hardware or different Glow versions.
- API payload bytes include serialized metadata and bodies plus raw attachment
  bytes. They exclude REST envelopes, HTTP headers, compression and TLS/TCP
  overhead. Every successful synthetic API call must be accounted for.
- Warm complete reads assert zero API calls. Each phase also verifies byte
  equality; mount startup must not load all 26 page bodies.
- Glow measures time to first selectable `_index.md` and rendering under a PTY.
  It exits after rendering; background scans may continue until that exit. The
  second invocation can therefore visit uncached files and is not evidence of
  a completely warmed recursive scan. It must not be compared as if both
  transports had traversed an identical complete tree.
- Vim latency starts at `BufWritePre` (a local marker file timestamp) and ends
  when the synthetic update returns. It excludes editor startup; separate
  fields retain editor launch/exit time. Each phase asserts exactly one new
  remote version and its marker. Timestamp precision is host-dependent.
- Linux davfs2 uses `delay_upload 0`, matching the CLI-generated per-mount
  configuration. An initial five-run baseline with the davfs2 default took
  11,510.5 ms cold / 11,514.1 ms warm (median save-to-API). This was rejected
  as unacceptable and fixed; the table shows the corrected five-run matrix.
  The VFS 500 ms quiet window remains active.
- Peak RSS covers one process's startup, cold/warm workloads and shutdown;
  it is not attributed independently to each phase. NFS helper RSS is separate.

### Regression review

These are the >10% NFS latency/RSS review triggers; values are milliseconds
except RSS (bytes). Shutdown is measured once per cold/warm pair, so repeated
phase rows describe the same observation. No parent-RSS trigger occurred.

| Host | Workload / phase | Metric | NFS median vs WebDAV |
| --- | --- | --- | --- |
| mac | read / cold | `wallMs` | 102.8 vs 74.6 (+38%) |
| mac | read / cold | `startupMs` | 292.0 vs 130.3 (+124%) |
| mac | glow / cold | `startupMs` | 286.7 vs 126.8 (+126%) |
| mac | glow / cold | `shutdownMs` | 29.1 vs 25.4 (+15%) |
| mac | glow / warm | `shutdownMs` | 29.1 vs 25.4 (+15%) |
| mac | editor / cold | `startupMs` | 303.6 vs 126.0 (+141%) |
| mac | editor / cold | `shutdownMs` | 29.1 vs 22.9 (+27%) |
| mac | editor / warm | `shutdownMs` | 29.1 vs 22.9 (+27%) |
| linux | read / cold | `firstListingMs` | 13.5 vs 0.8 (+1641%) |
| linux | read / cold | `firstByteMs` | 34.5 vs 27.9 (+24%) |
| linux | read / warm | `wallMs` | 24.3 vs 8.0 (+202%) |
| linux | read / warm | `firstListingMs` | 0.6 vs 0.2 (+143%) |
| linux | read / warm | `firstByteMs` | 3.4 vs 0.9 (+284%) |
| linux | glow / cold | `wallMs` | 156.4 vs 139.2 (+12%) |
| linux | glow / cold | `glowListingMs` | 65.6 vs 48.8 (+34%) |

The macOS cold-read API count is 64 for NFS versus 47 for WebDAV
(excluding startup). Method counters locate the difference primarily in child
metadata requests: 25 versus 6 `getPageDirectChildren` calls. Both download
exactly 26 bodies for the explicit complete-read workload. NFS directory
GETATTR refreshes directory views; the native client's attribute requests
therefore cause more child metadata discovery. This is retained for directory
freshness, not presented as a speed improvement. Linux WebDAV makes 82 calls
for the same workload versus NFS's 64. Warm complete reads make zero on both. Linux cold editor work shows one extra
NFS call (`getPage`): WebDAV already fetched that body during startup (eight
startup calls versus six for NFS). This is a phase-boundary difference, not an
extra upload; each measured save creates exactly one version.

NFS on macOS starts a companion process (wrapped by native RSS measurement),
which WebDAV does not; startup includes this cost and initial protocol work.
Its longer shutdown includes companion termination/reaping. These costs are
accepted for the optional transport, while WebDAV remains the default.

Linux davfs caches the listed directory and file data locally; NFS uses its
native attribute/data cache with `actimeo=1`. The measured warm NFS read
latency is consequently higher even with zero backend calls. The first-listing
percentages include sub-millisecond WebDAV baselines. The data prove this
host-specific difference, not a general kernel-level causal profile.

Glow's Linux cold-listing regression and variable call counts are retained
as observed client behavior; asynchronous discovery means these samples do
not isolate an identical complete scan. No general Glow speed claim is made.
A fully drained, large-directory comparative scan remains separate acceptance
work. API calls after a second Glow launch must not be mistaken for violations
of the verified warm-complete-body-read invariant.

The comparison supports offering transport choice, not marketing NFS as
universally faster. Public RW acceptance still depends on the remaining
correctness, packaging and lifecycle gates.


## Related material

[Implementation plan](PLAN.md), [acceptance status](ACCEPTANCE.md),
[evidence log](EVIDENCE.md), [user guide](../../docs/agents/confluence-vfs.md).
