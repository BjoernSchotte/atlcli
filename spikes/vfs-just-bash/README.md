# WP0 spike: Confluence virtual filesystem

De-risking pass for [`specs/confluence-virtual-filesystem/PLAN.md`](../../specs/confluence-virtual-filesystem/PLAN.md),
section 11, WP0.

Measured on 2026-09-16 on the CI container: Linux x64, **Bun 1.3.11**,
`just-bash@3.4.2`, `webdav-server@2.6.3`, repo at `b39e9ab`.

> The plan assumed Bun 1.3.14. The container pins 1.3.11, which is the version
> just-bash issue #386 was originally reported against, so the Bun findings
> below are if anything a worst case.

## Contents

- [WP0.1 — dependency install](#wp01--dependency-install)
- [WP0.2 — just-bash against an async remote filesystem](#wp02--just-bash-against-an-async-remote-filesystem)
- [WP0.3 / WP0.3b — live Confluence probes](#wp03--wp03b--live-confluence-probes)
- [WP0.4 — bundle and startup measurement](#wp04--bundle-and-startup-measurement)
- [WP0.5 — webdav-server under Bun](#wp05--webdav-server-under-bun)
- [WP0.6 — decision](#wp06--decision)

## Scripts

| Script | Work package | Needs a live tenant |
|--------|--------------|---------------------|
| `spike.ts` | WP0.2 | no |
| `webdav-spike.ts` | WP0.5 | no |
| `live-spike.ts` | WP0.3 | yes |
| `cql-text-semantics.ts` | WP0.3b | yes |
| `fake-fs.ts` | shared fake `IFileSystem` | no |

The two live scripts exit with status 78 and a message when the requested
profile is absent, so they are safe to run anywhere.

## WP0.1 — dependency install

`just-bash@3.4.2` and `webdav-server@2.6.3` are pinned exactly in
`apps/cli/package.json`. `bun install` completes with no postinstall errors
from either package. (Three postinstalls are blocked repo-wide — `wxt prepare`,
`@mongodb-js/zstd`, `node-liblzma` — all pre-existing and unrelated.)

## WP0.2 — just-bash against an async remote filesystem

`bun spikes/vfs-just-bash/spike.ts` — **15/15 pass** with
`defenseInDepth: false`, driving a 200-line fake `IFileSystem` mounted through
`MountableFs` at `/DOCSY`.

| Case | Result | Backend calls |
|------|--------|---------------|
| `ls` | pass | 2 |
| `ls -R` | pass | 9 |
| `ls -la` | pass | 5 |
| `cat` | pass | 2 |
| `grep -rn` | pass | 12 |
| `grep -rl` | pass | 12 |
| `find -name` | pass | 9 |
| `sed` (pipe) | pass | 2 |
| `sed -i` (in place) | pass | 4 |
| `awk` | pass | 2 |
| `jq` | pass | 0 |
| `echo > file` | pass | 5 |
| glob `*.md` | pass | 4 |
| `tree` | pass | 9 |
| `grep -rl … \| head` | pass | 14 |

Methods just-bash actually called across the whole run:

| Method | Calls |
|--------|-------|
| `stat` | 50 |
| `readFile` | 19 |
| `readdir` | 15 |
| `readFileBuffer` | 3 |
| `writeFile` | 3 |
| `exists` | 1 |

**Findings**

1. **`defenseInDepth: false` is required, and it is sufficient.** With the
   default (enabled) setting, *every* `exec()` throws
   `DefenseInDepthBox: critical patches failed: Module._resolveFilename`
   — just-bash issue #386, reproduced here verbatim. With it disabled, nothing
   else about the interpreter changes.
2. **The fake implements no `symlink` / `readlink`** (both throw `ENOSYS`) and
   nothing in the suite hit them. The VFS still needs them for `.by-id/`,
   `.labels/` and `.recent/` (WP4.5–4.7), but they are not on the hot path.
3. **`readdirWithFileTypes` was never called** even though the fake implements
   it; `MountableFs` does not forward the optional method in 3.4.2. WP6.1 plans
   to implement it to avoid stat storms — the 50 `stat` calls above show the
   cost is real, but the win only lands if the adapter is mounted directly
   rather than under `MountableFs`. **Re-measure in WP6.1** before counting on
   it.
4. **`stat` dominates**, 50 calls against 19 reads. The tree index (WP2.3) must
   answer `stat` from memory, which is exactly what rule 2 of section 1b
   requires anyway.

## WP0.3 / WP0.3b — live Confluence probes

**Not yet run.** The CI container has no `~/.atlcli/config.json`, so no live
tenant is reachable from here. Both scripts are written, typecheck, and skip
cleanly; they must be run on a machine holding the `mayflower` profile:

```bash
bun --conditions=development spikes/vfs-just-bash/live-spike.ts --profile mayflower --space DOCSY
bun --conditions=development spikes/vfs-just-bash/cql-text-semantics.ts --profile mayflower --space DOCSY
```

`cql-text-semantics.ts` creates one page prefixed `vfs-e2e-`, polls until the
search index has picked it up (up to 60 s), probes twenty `text ~` variants
covering whole words, prefixes, suffixes, word interiors, underscore and hyphen
compounds, `ß` and `ü`, digit sequences, camel case, dotted tokens and explicit
wildcards, prints a Markdown table, and deletes the page in a `finally`.

**Until that table exists, decision 12's guard stays at its strictest setting**
(plain literal, at least three characters, no regex metacharacters, no internal
separators). That is the conservative direction: it costs full scans, never
silently empty results. WP6.3 implements the guard so the rule is a single
function, `qualifiesForCqlShortcut()`, that the live table can tighten or relax
without touching the rest of `grep`.

## WP0.4 — bundle and startup measurement

`bun run build:cli`, single-file `dist/index.js`, `--target bun`. Startup is
the median of 12 interleaved A/B runs of `bun <bundle> --version`, first two
discarded.

| Build | `dist/index.js` | Δ size | Startup (median) | Δ startup |
|-------|-----------------|--------|------------------|-----------|
| baseline, no just-bash | 32,282,850 B | — | 940.6 ms | — |
| static `import { Bash }` | 35,829,767 B | +3.38 MB, +11.0 % | 1066.6 ms | +126 ms |
| reachable `await import()` | 35,845,799 B | +3.40 MB, +11.0 % | 1036.6 ms | **+96 ms** |
| `--external just-bash` | 32,283,563 B | +713 B | 948.2 ms | −7 ms (noise) |

**Findings**

1. **The size gate passes.** +11.0 % and +3.38 MB are both well inside the
   decision 11 gate of 25 % / 30 MB per target.
2. **A dynamic import does not defer the cost.** Bun's single-file bundler
   inlines `await import("just-bash")` into the same artifact, and the whole
   3.4 MB is parsed at process start whether or not `wiki sh` runs. The
   `--external` row isolates this: removing the code from the bundle removes
   the entire regression, so the +96 ms is parse cost, not module execution.
   **WP6.8 as written in the plan ("load just-bash through a dynamic import so
   that the startup time of other commands stays unchanged") does not achieve
   its stated goal under Bun.** The dynamic import is still worth having — it
   keeps the module off the eager execution path and leaves the door open for
   a split build — but it is not what holds the gate.
3. **The startup gate is breached on this hardware, and the number does not
   transfer.** A 940 ms `--version` is roughly ten times what this CLI costs on
   real developer hardware; this container is heavily throttled. Taking the
   baseline as a per-byte parse rate (30.8 MB → 940 ms ≈ 30 ms/MB), the same
   3.38 MB on a machine that starts the CLI in ~90 ms would cost roughly
   **10 ms**, which is inside the 15 ms gate. That is an extrapolation, not a
   measurement.
4. **`--external` is not a shipping option.** Releases go out as
   `bun build --compile` binaries for five targets, so an unbundled dependency
   would not resolve at runtime.
5. `commands: [...]` is a **runtime** registration filter in just-bash 3.4.2,
   not a build-time one, so restricting the command set (excluding `python3`,
   `js-exec`, `sqlite3`, `curl`) changes no artifact byte. It is still applied
   in WP6.2 for its security value.

## WP0.5 — webdav-server under Bun

`bun spikes/vfs-just-bash/webdav-spike.ts` — **7/7 pass**, `webdav-server@2.6.3`
bound to `127.0.0.1:0` with `requireAuthentification: false`.

| Probe | Status | Verdict |
|-------|--------|---------|
| `PROPFIND` depth 1 | 207 | multistatus lists children |
| `GET` file | 200 | body returned |
| `PUT` new file | 201 | created |
| `GET` after `PUT` | 200 | round-trips |
| `LOCK` exclusive write | 200 | returns a `locktoken` |
| `OPTIONS` | 200 | advertised |
| AppleDouble `._name` | 404 | already fast-fails |

**Findings**

1. The v2 API, the `VirtualFileSystem`, the callback style and the lock manager
   all work unmodified under Bun. No workaround, no patch.
2. `LOCK` answering with a real lock token is the prerequisite for a writable
   Finder mount, so the macOS blocker named in section 6 is cleared at the
   protocol level.
3. **The macOS half is untested.** `mount_webdav`, the Finder, and the Spotlight
   exclusions of WP7.3b cannot be exercised from a Linux container. They stay
   open against WP7.3b / WP7.9 on a local macOS runner.

## WP0.6 — decision

**Build `wiki sh` and `wiki mount` in the core, as planned.** Nothing found in
WP0.2 or WP0.5 argues against the architecture: just-bash drives a fully async
remote filesystem under Bun once defense-in-depth is off, and webdav-server
needs no workarounds at all.

On the bundle question, decision 11's two gates split:

- **Size gate: met.** +11.0 % / +3.38 MB against a 25 % / 30 MB budget.
- **Startup gate: breached as measured here (+96 ms vs 15 ms), and the
  measurement is not trustworthy for the gate's purpose** — it comes from a
  container whose baseline startup is an order of magnitude slower than the
  hardware the gate describes. The linear extrapolation lands at ~10 ms.

So the decision is **provisional**: proceed in the core, implement WP6.8's
dynamic import (it costs nothing and keeps the module off the eager execution
path), and **re-measure on real hardware in WP9.5** — macOS arm64 and Linux x64
compiled binaries, same A/B method. If the startup regression there exceeds
15 ms, fall back to decision 11's remedy and move the embedded shell behind the
plugin API, keeping the mount in the core. The VFS core in
`packages/confluence-vfs` has no just-bash dependency in either outcome, so that
fallback stays a packaging change rather than a redesign.

Open against this spike:

- WP0.3 latency and request counts — needs the `mayflower` profile.
- WP0.3b CQL text-search table — needs the `mayflower` profile; until it exists
  the decision 12 guard stays at its strictest setting.
- WP7.3b Spotlight behaviour and WP0.5's `mount_webdav` half — need macOS.
- WP9.5 startup re-measurement on release hardware.
