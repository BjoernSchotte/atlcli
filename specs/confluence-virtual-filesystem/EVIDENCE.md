# Confluence VFS — measurements

**Current acceptance (2026-09-16):** [LIVE-RESULTS.md](./LIVE-RESULTS.md)
contains DOCSY write/read, MAYFLOWER read-only, indexed grep/find and synthetic
5,000-page shell results. [RELEASE-VALIDATION.md](./RELEASE-VALIDATION.md)
contains the compiled macOS binary proof and startup comparison. The original
container measurements below are historical, not the current acceptance status.

| Gate | Current status |
| --- | --- |
| Live Cloud shell and native macOS mount | Passed; synthetic resources cleaned |
| CQL semantics | Measured; indexed default explicitly accepts index gaps |
| Request/429 counters and CLI write controls | Implemented; focused checks pass |
| 5,000-page indexed shell | Tested with 50 candidates; cold 31 ms, warm 8 ms, 10,630 cache bytes; zero warm body reads |
| Finder / Spotlight | Finder listing verified; mdutil says indexing/search disabled |
| Native mount performance | Synthetic 500-page walk: 2,165 ms/zero bodies; warm 100-page listing: 13 ms/zero calls; native grep: 353 ms/101 bodies; RELEASE-VALIDATION |
| TextEdit safe-save | Passed after local staging/backup fix; native save and independent API readback |
| Compiled macOS artifact | 9 tests / 33 assertions passed; compiled live DOCSY listing: 876 ms, four requests, zero bodies |
| Artifact growth / startup | +3.22% passes; +88–99 ms exceeds gate, accepted by user |
| Full current suite/build/typecheck | 9,008 pass / 40 skip / zero failures; 44,544 assertions; typecheck 4/4; build 35/35 |
| Linux / Windows | Native Linux artifact tests and read-only davfs2 mount pass after buffer fix; Linux writes and Windows unverified |
| Live permission isolation | Second identity missing; interim boundary accepted |
| Homebrew lifecycle | Formula/equivalent command checked; installed version outdated |

Numbers behind the decisions in
[`PLAN.md`](./PLAN.md). Each section says what was measured, on what, and what
is still missing.

**Environment for everything below unless stated otherwise:** Linux x64 CI
container, Bun 1.3.11, `just-bash@3.4.2`, `webdav-server@2.6.3`. The container is
heavily throttled — `atlcli --version` takes ~940 ms against ~90 ms on ordinary
developer hardware — so **absolute times here are not transferable**. Request
counts are.

---

## 1. Bundle and startup (WP0.4)

`bun run build:cli`, single-file `dist/index.js`, `--target bun`. Startup is the
median of 12 interleaved A/B runs of `bun <bundle> --version`, first two
discarded.

| Build | `dist/index.js` | Δ size | Startup | Δ startup |
|-------|-----------------|--------|---------|-----------|
| baseline, no just-bash | 32,282,850 B | — | 940.6 ms | — |
| static `import { Bash }` | 35,829,767 B | +3.38 MB, +11.0 % | 1066.6 ms | +126 ms |
| reachable `await import()` | 35,845,799 B | +3.40 MB, +11.0 % | 1036.6 ms | +96 ms |
| `--external just-bash` | 32,283,563 B | +713 B | 948.2 ms | −7 ms (noise) |

**Against decision 11's two gates:**

- **Size gate (25 % / 30 MB per target): met**, at +11.0 % and +3.38 MB.
- **Startup gate (15 ms): breached as measured (+96 ms), on hardware the gate
  does not describe.** Scaling by the container's per-byte parse rate
  (30.8 MB → 940 ms ≈ 30 ms/MB) puts the same 3.38 MB at roughly **10 ms** on a
  machine that starts the CLI in ~90 ms. That is an extrapolation.

**Two findings worth more than the numbers:**

1. **A dynamic import does not defer the cost under Bun.** The bundler inlines
   `await import("just-bash")` into the same artifact and the whole 3.4 MB is
   parsed at process start whether or not `wiki sh` runs. The `--external` row
   isolates it: removing the code removes the entire regression, so the +96 ms
   is parse cost, not module execution. WP6.8's stated goal ("so that the
   startup time of other commands stays unchanged") is not achievable this way.
   The dynamic import is kept anyway — it keeps the module off the eager
   execution path and leaves a split build possible.
2. **`--external` is not a shipping option.** Releases are `bun build --compile`
   binaries for five targets, so an unbundled dependency would not resolve.
3. `commands: [...]` is a **runtime** registration filter, not a build-time one,
   so restricting the command set changes no artifact byte. It is applied for
   its security value, not its size.

**Open:** re-measure on release hardware (macOS arm64, Linux x64 compiled
binaries) in WP9.5. If the regression there exceeds 15 ms, decision 11's remedy
applies — the embedded shell moves behind the plugin API and the mount stays in
the core. The VFS core has no just-bash dependency either way, so that stays a
packaging change.

---

## 2. just-bash against an async remote filesystem (WP0.2)

`bun spikes/vfs-just-bash/spike.ts` — **15/15 pass** with
`defenseInDepth: false`, against a fake `IFileSystem` mounted through
`MountableFs`.

| Case | Backend calls | Case | Backend calls |
|------|---------------|------|---------------|
| `ls` | 2 | `sed -i` | 4 |
| `ls -R` | 9 | `awk` | 2 |
| `ls -la` | 5 | `jq` | 0 |
| `cat` | 2 | `echo > file` | 5 |
| `grep -rn` | 12 | glob `*.md` | 4 |
| `grep -rl` | 12 | `tree` | 9 |
| `find -name` | 9 | `grep -rl … \| head` | 14 |
| `sed` (pipe) | 2 | | |

Methods called across the whole run: `stat` 50, `readFile` 19, `readdir` 15,
`readFileBuffer` 3, `writeFile` 3, `exists` 1.

**Findings:**

- `defenseInDepth: false` is **required** (every `exec()` throws
  `DefenseInDepthBox: critical patches failed: Module._resolveFilename` under
  Bun — issue #386, reproduced) and **sufficient** (nothing else changes).
- `stat` dominates, 50 calls against 19 reads, which is why the tree index must
  answer `stat` from memory.
- `readdirWithFileTypes` was never called under `MountableFs` in 3.4.2, even
  though the fake implemented it.

---

## 3. webdav-server under Bun (WP0.5)

`bun spikes/vfs-just-bash/webdav-spike.ts` — **7/7 pass** on `127.0.0.1:0`.

| Probe | Status | Probe | Status |
|-------|--------|-------|--------|
| `PROPFIND` depth 1 | 207 | `LOCK` exclusive | 200 + token |
| `GET` | 200 | `OPTIONS` | 200 |
| `PUT` | 201 | AppleDouble `._name` | 404 |
| `GET` after `PUT` | 200 | | |

No workaround and no patch. `LOCK` returning a real token is the prerequisite
for a writable Finder mount, so the macOS blocker named in plan section 6 is
cleared at the protocol level. The `mount_webdav`/Finder half needs a Mac.

---

## 4. Request cost of a mounted volume (WP7.7)

`apps/cli/src/vfs/webdav-perf.test.ts`, against a fake tenant. Confluence API
latency dominates the protocol by an order of magnitude, so the **request count
is what decides the outcome**; the wall-clock numbers WP7.7 asks for need a Mac.

| Operation | Requests | Bodies fetched |
|-----------|----------|----------------|
| `PROPFIND` on a space (10 sections) | 1 listing | 0 |
| `PROPFIND` on one section (50 pages) | 1 listing | 0 |
| A 500-page walk (11 directories) | 11 listings | 0 |
| Repeat listing within the TTL | 0 | 0 |
| `PROPFIND` on a 100-entry directory | ≤ 2 | 0 |
| Opening three pages | 3 | 3 |

**Two defects this measurement found**, both fixed:

- A `PROPFIND` over a 100-entry directory issued **801 requests**. Every child's
  `stat` started its version probe before any finished, so each saw the same set
  of missing versions. De-duplicating the probe per directory brought it to 2.
- A `GET` hung. `Content-Length` came from the *estimated* size, so the client
  waited for bytes that never arrived. A real read now measures exactly while
  `PROPFIND` keeps the estimate.

---

## 5. Demand-principle invariants

Asserted as tests rather than measured once, so they cannot quietly regress.

| Invariant | Where | What it asserts |
|-----------|-------|-----------------|
| `ls`/`stat` across 5,050 pages fetch no bodies | `resolver.test.ts` | 10 listings + 100 stats → 0 body fetches, 11 listing requests |
| Requests track directories visited, not space size | `tree-index.test.ts` | identical counts for a 3-page and a 500-page space |
| A branch nobody enters stays unloaded | `tree-index.test.ts` | siblings still `"unloaded"` after a walk |
| Revalidation costs nothing for unvisited branches | `tree-index.test.ts` | one probe + one listing, scoped to one directory |
| Every convenience directory lists without bodies | `virtual-dirs.test.ts` | `.by-id`, `.labels`, `.recent`, `.search`, `_attachments`, `.versions` → 0 |
| Ten attachments list with zero bytes downloaded | `virtual-dirs.test.ts` | metadata only |
| The LRU ceiling holds *during* writes | `body-cache.test.ts` | asserted inside the write loop, not after |
| An over-budget prefetch downloads nothing | `page-store.test.ts` | 0 bulk requests on abort |
| `ls -R` through the shell fetches no bodies | `wiki-shell.test.ts` | end to end, real interpreter |

---

## 5a. The shipped artifact (WP9.5)

The whole feature — `just-bash`, `webdav-server` and the VFS core — measured the
same way as section 1, against the same baseline.

| Build | `dist/index.js` | Δ size | Startup | Δ startup |
|-------|-----------------|--------|---------|-----------|
| WP0.4 baseline | 32,282,850 B | — | 989.2 ms | — |
| with the whole feature | 36,838,969 B | +4.35 MB, **+14.1 %** | 1135.1 ms | **+146 ms** |

- **Size gate (25 % / 30 MB): met**, with room.
- **Startup gate (15 ms): breached on this container**, by the same margin and
  for the same reason as section 1 — it is parse cost, on hardware whose
  baseline is roughly ten times a developer machine's. The linear scaling puts
  it near 15 ms on real hardware, which is the boundary, so **this is the
  measurement that must be repeated on release hardware before shipping.**

Smoke-tested from the built bundle by
`apps/cli/src/e2e/wiki-sh-built.e2e.test.ts`, which runs `dist/index.js` as a
child process against a local Confluence stand-in: listing, reading, `grep`, the
`ro` refusal, the `--json` shape, the exit code, the extra commands and the
maintenance commands all work in the artifact. That is the only test that can
catch the dynamic `import("just-bash")` failing to resolve inside the bundle.

### Full-suite result

`bun run test` over the whole repository: **8,883 pass, 45 skip, 26 fail.**

**None of the 26 are in this feature.** They are `pdf-compiler-browser`,
`import-pdf`, `plugin-git`, the action-registry benchmark, the extension and the
release/consumer-smoke scripts. Checked rather than assumed: the same three
representative files run at `origin/main` in a clean worktree give the
**identical** 31 pass / 10 fail, and the failures are `ENOENT` on `poppler`,
which is not installed in this container. They are an environment gap, not a
regression.

## 6. Historical open measurements (superseded by current status above)

| What | Needs | Work package |
|------|-------|--------------|
| Live latency and request counts against a real tenant | the `mayflower` profile | WP0.3 |
| **CQL text-search semantics** — where the index's word boundary actually falls | the `mayflower` profile | WP0.3b |
| Startup on release hardware | macOS arm64 and Linux x64 binaries | WP9.5 |
| `mount_webdav`, the Finder, editor open-and-save | a Mac | WP7.7, WP7.9 |
| Whether the Spotlight exclusions are honoured on a WebDAV volume | a Mac | WP7.3b |
| Windows WebClient behaviour and the 50 MB limit | Windows | WP7.8 |
| Live permission isolation between two profiles | two tenants or a restricted page | WP9.2 |

The scripts for the two live probes are written and skip cleanly without a
profile:

```bash
bun --conditions=development spikes/vfs-just-bash/live-spike.ts --profile mayflower --space DOCSY
bun --conditions=development spikes/vfs-just-bash/cql-text-semantics.ts --profile mayflower --space DOCSY
```

**Historical policy, superseded:** the whole-word guard did not guarantee index
completeness. Ordinary grep now uses indexed candidates with visible limitations
and body verification; `--no-cql` selects exhaustive bounded search.
