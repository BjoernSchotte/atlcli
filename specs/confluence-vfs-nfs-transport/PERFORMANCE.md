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
ATLCLI_NFS_TEST_HELPER="$PWD/packages/confluence-nfs/target/release/atlcli-confluence-nfs" \
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
| mac | complete read | cold | 74.7 [73.0–78.4] | 80.4 [80.1–85.7] | 47 / 64 |
| mac | complete read | warm | 13.2 [13.2–13.6] | 3.8 [2.8–6.9] | 0 / 0 |
| mac | Glow first listing | cold | 33.8 [30.9–48.5] | 31.3 [30.6–32.0] | 18 / 25 |
| mac | Glow first listing | warm | 32.1 [31.5–32.9] | 31.9 [29.0–34.0] | 10 / 9 |
| mac | Vim save → API | cold | 516.9 [515.5–520.2] | 534.6 [534.1–536.0] | 6 / 3 |
| mac | Vim save → API | warm | 511.7 [510.8–512.9] | 527.7 [525.8–530.5] | 2 / 1 |
| linux | complete read | cold | 125.7 [89.6–133.4] | 112.6 [111.1–117.7] | 82 / 64 |
| linux | complete read | warm | 8.8 [7.2–10.0] | 19.9 [18.2–20.8] | 0 / 0 |
| linux | Glow first listing | cold | 49.9 [32.8–50.4] | 50.3 [49.6–67.9] | 23 / 21 |
| linux | Glow first listing | warm | 32.9 [31.0–34.4] | 33.5 [33.1–35.1] | 25 / 14 |
| linux | Vim save → API | cold | 508.3 [506.4–511.5] | 509.4 [508.9–510.3] | 1 / 2 |
| linux | Vim save → API | warm | 501.9 [501.5–502.6] | 504.1 [502.7–504.5] | 1 / 1 |

Final release-helper samples and median/min/max of every numeric metric are in
[macOS results](benchmark-final-mac.json) and [Linux results](benchmark-final-linux.json).
Each host completed 80 records: four workloads × two transports × five runs ×
two cache phases. Helpers were built in release mode from the Slice 163 source;
these are local native review bundles, not downloaded CI artifacts. Earlier
benchmark files remain historical evidence. The current data include startup,
first listing/byte, API requests/payload bytes, cache hits, protocol requests,
parent/helper RSS and shutdown.

## Complete large-directory scan

The separate `glow-scan` workload waits until the native Glow TUI lists all
602 Markdown documents, then renders the selected fixture. Run it alone with:

```sh
ATLCLI_NFS_TEST_HELPER="$PWD/packages/confluence-nfs/target/release/atlcli-confluence-nfs" \
  bun --conditions=development scripts/bench/run-vfs-mount.ts /tmp/glow-scan.json "" glow-scan
```

The table measures completed enumeration, excluding subsequent selected-file
rendering. Periodic terminal resizes force full counter redraws; observation
resolution is up to 500 ms. All five cold/warm samples per transport/host
verified the expected document count. Raw metrics, including selected rendering,
API methods/payloads, RSS and shutdown, are in [macOS](benchmark-final-mac.json)
and [Linux](benchmark-final-linux.json).

| Host | Phase | WebDAV ms, median [min–max] | NFS ms, median [min–max] |
| --- | --- | --- | --- |
| mac | cold | 3514.2 [3497.4–3664.4] | 7599.8 [7562.4–7647.4] |
| mac | warm | 1732.3 [1698.3–1766.3] | 5614.4 [5549.3–5633.1] |
| linux | cold | 4583.6 [4063.8–4665.7] | 5699.0 [5645.7–5716.1] |
| linux | warm | 2563.6 [2046.2–2613.4] | 2098.9 [2080.7–2131.8] |

Cold NFS scans exceed the 10% regression review threshold on both hosts.
The warm Linux NFS scan is faster; macOS remains slower in both phases. Explicit NFS
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
| mac | read / cold | `startupMs` | 279.8 vs 127.7 (+119%) |
| mac | glow / cold | `startupMs` | 272.3 vs 126.8 (+115%) |
| mac | glow-scan / cold | `startupMs` | 274.5 vs 127.0 (+116%) |
| mac | glow-scan / cold | `wallMs` | 8292.5 vs 4190.0 (+98%) |
| mac | glow-scan / cold | `firstByteMs` | 7600.9 vs 3516.8 (+116%) |
| mac | glow-scan / cold | `glowScanMs` | 7599.8 vs 3514.2 (+116%) |
| mac | glow-scan / cold | `shutdownMs` | 33.8 vs 25.8 (+31%) |
| mac | glow-scan / warm | `wallMs` | 6323.4 vs 2397.6 (+164%) |
| mac | glow-scan / warm | `firstListingMs` | 98.0 vs 65.9 (+49%) |
| mac | glow-scan / warm | `firstByteMs` | 5616.6 vs 1733.1 (+224%) |
| mac | glow-scan / warm | `glowListingMs` | 98.0 vs 65.9 (+49%) |
| mac | glow-scan / warm | `glowScanMs` | 5614.4 vs 1732.3 (+224%) |
| mac | glow-scan / warm | `shutdownMs` | 33.8 vs 25.8 (+31%) |
| mac | editor / cold | `startupMs` | 291.8 vs 128.5 (+127%) |
| linux | read / cold | `firstListingMs` | 12.1 vs 0.7 (+1557%) |
| linux | read / cold | `firstByteMs` | 33.9 vs 24.8 (+36%) |
| linux | read / warm | `wallMs` | 19.9 vs 8.8 (+125%) |
| linux | read / warm | `firstListingMs` | 0.7 vs 0.4 (+91%) |
| linux | read / warm | `firstByteMs` | 3.1 vs 1.4 (+126%) |
| linux | glow-scan / cold | `wallMs` | 5789.3 vs 4671.5 (+24%) |
| linux | glow-scan / cold | `firstByteMs` | 5715.6 vs 4599.2 (+24%) |
| linux | glow-scan / cold | `glowScanMs` | 5699.0 vs 4583.6 (+24%) |
| linux | glow-scan / warm | `firstListingMs` | 63.8 vs 47.0 (+36%) |
| linux | glow-scan / warm | `glowListingMs` | 63.8 vs 47.0 (+36%) |

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

Glow's first-listing timings and variable call counts are retained
as observed client behavior; asynchronous discovery means these samples do
not isolate an identical complete scan. No general Glow speed claim is made.
The separately measured fully drained scan above provides the complete-tree
comparison. API calls after a second Glow launch must not be mistaken for violations
of the verified warm-complete-body-read invariant.

The comparison supports offering transport choice, not marketing NFS as
universally faster. Public RW is enabled; full CI run 35266459209 and the final requirement audit
passed. [ACCEPTANCE.md](ACCEPTANCE.md) records the experimental go decision and
retains these measured limitations.


## Related material

[Implementation plan](PLAN.md), [acceptance status](ACCEPTANCE.md),
[evidence log](EVIDENCE.md), [user guide](../../docs/agents/confluence-vfs.md).
