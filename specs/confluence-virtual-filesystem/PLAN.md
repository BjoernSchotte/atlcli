# Confluence Virtual Filesystem for Coding Agents

Status: concept with decisions recorded, not yet implemented

Plan date: 2026-09-15 (research), 2026-09-16 (decisions, task plan)

Planned against: `2617984`

Priority: P2

Estimated effort: L, roughly 6-7 focused weeks for one person across ten
independently reviewable work packages (section 11), including the spike, the
write path, the WebDAV mount, documentation, and a live proof against Cloud

Risk: MED for the read path; HIGH for the write path until conflict and merge
behaviour is proven against real concurrent Confluence editing

Supersedes: none

Builds on: `spec/mcp-over-code.md`, `spec/local-storage-plan.md`,
`spec/sqlite-sync-foundation.md`

**Goal:** coding agents (Claude Code, Codex, Cursor, and others) work on Confluence content directly with `ls`, `cd`, `cat`, `grep`, `find` and `sed`. Visibility matches the authenticated user exactly. No MCP tool calls required.

Sources: three parallel research passes (just-bash, mount technologies, Atlassian auth and prior art), every source verified live on 2026-09-15. Findings older than six months are marked **[dated]**.

---

## 1. Summary

- **Feasible, and in the near term.** atlcli already has every building block: `ConfluenceClient` (hierarchy, search, versions, move, trash), `storageToMarkdown` and `markdownToStorage`, path mapping (`hierarchy.ts`, index pattern), frontmatter carrying the page ID, and the SQLite sync database.
- **Architecture:** one shared **VFS core** (pure logic: path to page, cache, write-back, search acceleration) with **two frontends, both in v1**:
  1. **`atlcli wiki sh`**, an embedded bash built on **just-bash** (Vercel Labs). No mount, no driver, works everywhere.
  2. **`atlcli wiki mount`**, a real OS mount through a **local WebDAV server** on loopback. Free of kernel extensions on macOS and Windows; Linux needs `davfs2`.
- **Not chosen:** FUSE. macFUSE is proprietary, FUSE-T is free for non-commercial use only, the Node bindings are untested under Bun, and Windows needs the WinFsp installer.
- **just-bash with defense-in-depth disabled.** Three known risks (the Bun crash with defense-in-depth active, `fetch` inside the backend, and `grep -r` without a cache) are covered by that setting and by the cache design.
- **Permissions:** Confluence enforces visibility server-side per caller. The VFS needs no access-control logic of its own, only the user's profile token used consistently and a **profile-scoped cache**.
- **Writing is part of the core from the start.** The `ro`/`rw` mode is a parameter, default `ro`.

---

## 1a. Decisions (2026-09-16)

| # | Question | Decision | Consequence |
|---|----------|----------|-------------|
| 1 | just-bash variant | **3.4.2 with `defenseInDepth: false`** | `ctx.origCommand` stays available for the `grep` and `find` overrides; pin the version; watch Bun issue #386 and re-enable defense-in-depth once it is fixed |
| 2 | Mount in v1? | **Yes**, `wiki sh` and `wiki mount` both belong to v1 | The core must carry both adapters from the start; WebDAV specifics (LOCK, ETag, AppleDouble files) are part of the plan |
| 3 | OAuth 3LO | **No, API tokens are enough** (Cloud scoped and classic, Data Center PAT) | No app registration effort and no shared points budget; concurrency capped near 8 with `Retry-After` handling against burst limits |
| 4 | Path scheme | **Slug with ID suffix**: `architecture-623869955.md` | Paths are collision-free and stay resolvable across renames; the slug exists only for readability |
| 5 | Cache location | **Freely configurable** via `--cache-dir` or config `vfs.cacheDir`, default `~/.atlcli/vfs/` | Inside the chosen directory, partitioning by profile and account ID stays mandatory for permission isolation |
| 6 | Write access | **Parameterized** `--mode ro\|rw` (default `ro`) plus `--allow-delete`; the write path is built in directly | Write-back, conflict handling and the audit log are part of phase 1, not a retrofit |

### Detail decisions

| # | Question | Decision | Consequence |
|---|----------|----------|-------------|
| 7 | `mkdir` in `rw` mode | **Always a page with an empty body, no `--folders` flag** | The folder API is cloud-only (`requestV2` with no deployment branch) and folders have no body, so writing `_index.md` would have to fail there. Existing folders stay readable with a read-only `_index.md`. WP5.4 shrinks accordingly |
| 8 | `.search/` queries | **Lazy resolution, no registration step**, plus a losable list of the last twenty queries | State is never a prerequisite for correctness, and a daemon restart loses nothing that matters. Limitation: directory names cannot contain a slash, so such queries go through the `cql` command |
| 9 | Conflict files | **Persisted** under `<cacheDir>/conflicts/`, with base and server version in the frontmatter | An edit the server rejected must not vanish with the session. Deleting a conflict file is a local operation, so it is allowed in `ro` mode and without `--allow-delete`. A dedicated subcommand makes open conflicts discoverable outside the shell |
| 10 | Confirmation without a terminal | **`--allow-delete` is the confirmation**, no third flag | A third gate behind write mode and delete permission adds no protection. With a terminal, `rm` and cross-space `mv` prompt interactively and `--confirm` skips that (repo convention; `--yes` exists nowhere). Real protection: delete means trash, plus the audit log |
| 11 | Bundle size | **Two measured gates instead of a number**: startup regression above 15 ms, artifact growth above 25 percent or 30 MB per target | If a gate is breached, the mount stays in the core and only the embedded shell becomes an optional package through the plugin API, because `webdav-server` is plain JavaScript with no WASM |
| 12 | `grep` shortcut | **Conservative guard**: CQL only for plain literals at word boundaries, the chosen path always on stderr, with an off switch | The CQL text search matches by word, not by substring. A silently empty `grep` is a correctness bug rather than a performance topic, because the agent reads it as "does not occur". WP0.3b measures the real behaviour against live content |

---

## 1b. Demand principle (binding invariant)

The VFS is a **virtual** filesystem with a cache, **not** a mirror. That is what separates it fundamentally from `docs pull`, which creates a complete local copy.

**Invariant:** only what was actually needed for a cache hit is written to the real filesystem. No operation materializes a whole space or subtree speculatively.

Four hard rules follow:

1. **Directories load one at a time.** A `readdir` of one directory costs at most one request (`direct-children`). A space-wide `descendants` pass happens only for an explicitly recursive operation and is then scoped to the subtree being walked. Metadata for a branch never entered is not fetched.
2. **Bodies only on a real read.** `ls`, `stat` and `PROPFIND` trigger no body fetch. Sizes come from the cache or are estimated; only the `GET` yields the exact length.
3. **Prefetch is capped.** The fallback prefetch for `grep` has a hard ceiling. On reaching it the operation aborts with an explanatory message instead of quietly downloading a space. Going past it requires an explicit flag.
4. **The disk cache is a bounded LRU.** The size limit is enforced during an operation, not afterwards. Attachment blobs count against it.

One test pins the invariant down: `ls` and `stat` across a space of 5,000 pages must not write a single body row into the cache.

---

## 2. Why a filesystem instead of MCP

Evidence from 2025 and 2026 (details in section 14):

- Anthropic, "Code execution with MCP": tool definitions as a file tree, 150k tokens down to 2k in one workflow **[dated, 2025-11]**.
- Vercel, "How to build agents with filesystems and bash": agent cost 1.00 USD down to 0.25 USD per run **[dated, 2026-01]**.
- Arize, "MCP vs CLI skills" (2026-05): equal correctness; on the hard tier roughly 2.00 USD and 71 calls for MCP against roughly 0.19 USD and 7 calls for a CLI plus a skill.
- **Counter-evidence**, Vercel and Braintrust, "Testing if bash is all you need" (2026-01): bash and filesystem alone on semi-structured data reached 53 to 63 percent correctness at seven times the cost of SQL. The lesson: the VFS needs a **structured search path** (CQL), otherwise `grep -r` burns tokens and API budget.
- Atlassian itself validated "CLI over MCP" with the **Teamwork Graph CLI** (GA 2026-06-30), but ships no file view, requires OAuth, and bills enriched searches in Rovo credits.

**What sets atlcli apart:** a file view with real `grep`, free REST access without credits, Data Center support, an offline cache, and the existing Markdown conversion.

---

## 3. Requirements

### Must
- Read spaces, the page tree, page content as Markdown, attachments, labels and versions.
- Visibility exactly as the user of the active profile sees it (Cloud API token, Data Center PAT).
- `ls`, `cat`, `find`, `grep -r` and `tree` at acceptable speed for spaces of 1,000 to 5,000 pages.
- Read-only by default, writing through a parameter (`--mode rw`).
- No kernel driver and no administrator rights on the default path.
- **Demand-driven:** only content actually read reaches the disk, never a complete space copy. See section 1b.

### Should
- Write: create and change a page (`echo`, `sed -i`, an editor), rename, move (`mv`), send to trash (`rm`).
- Convenience directories: search, labels, recently changed, versions, comments.
- Reuse inside the built-in `chat` and `research` agent as a bash tool.

### Non-goals (v1)
- **A complete local copy.** The VFS mirrors no space; `docs pull` remains the right tool for that. See section 1b.
- Editing whiteboards, databases or embeds (listed as placeholders only).
- Creating Confluence folders (decision 7); existing folders are read.
- Jira as a filesystem (possible later through the same core: `/jira/ATLCLI/ATLCLI-123.md`).
- Purge (permanent deletion) and space administration.
- OAuth 2.0 (3LO) (decision 3).

---

## 4. Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│ Frontends (imperative shell)                                 │
│  A) atlcli wiki sh  ── just-bash ── IFileSystem adapter      │
│  B) atlcli wiki mount ── webdav-server v2 ── FS adapter      │
│  C) chat/research agent ── bash tool ── (reuses A)           │
└───────────────┬──────────────────────────────────────────────┘
                │  VfsNode API (stat/readdir/read/write/rename/rm)
┌───────────────▼──────────────────────────────────────────────┐
│ packages/confluence-vfs (functional core)                    │
│  • PathMapper:   /DOCSY/parent/child.md ⇄ pageId            │
│  • TreeIndex:    partial space tree (id, title, parent)      │
│  • BodyCache:    (pageId, version) → Markdown, SQLite/disk   │
│  • SearchBridge: grep/find → CQL, then local regex           │
│  • WriteBack:    version+1, 409 handling, three-way merge    │
│  • VirtualDirs:  /.search/, /.labels/, /.recent/, /.versions │
└───────────────┬──────────────────────────────────────────────┘
                │
        ConfluenceClient (existing) ── REST v2 / v1 / DC v1
```

The "functional core, imperative shell" principle applies: the core knows neither just-bash nor WebDAV, only a narrow asynchronous Node-style API. Both frontends are thin adapters. Tests run against the core with a fake client.

---

## 5. Frontend A: embedded shell with just-bash

### Why just-bash
- The only maintained JS or TS library combining a **bash interpreter with an asynchronous, pluggable filesystem**. Apache-2.0, matching atlcli.
- As of 2026-09-15: version **3.4.2** (2026-08-22), last commits 2026-09-07, 4.3k stars, roughly 876k downloads per week, still labelled beta.
- Commands: `ls cat find grep rg sed awk jq yq sort head tail wc tree diff xargs` and more, plus pipes, redirections, loops, functions, globs and heredocs.
- `IFileSystem` is fully asynchronous (`readFile`, `writeFile`, `readdir`, `stat`, `mkdir`, `rm`, `mv` and the rest). Only `resolvePath` and `getAllPaths` are synchronous, and `getAllPaths` may return an empty array. A subagent tested a 40-line fake REST backend through `MountableFs.mount("/confluence", fs)`: `ls -R`, `grep -rn`, `find -name`, `sed`, `awk`, `jq`, `echo > file` and globs all worked, and only `stat`, `readdir`, `readFile` and `writeFile` were called.
- Prior art using exactly this pattern: Dropbox (`just-bash-dropbox`), S3 and Postgres (`just-bash-openfs`), Redis (Upstash, 2026-04), SQLite (Turso AgentFS), Chroma (Mintlify ChromaFs, 2026-03).

### Risks and countermeasures

| Risk | Finding | Measure |
|------|---------|---------|
| **Bun incompatibility** | 3.4.2 throws `DefenseInDepthBox: critical patches failed` on every `exec()` under Bun 1.3.x (issue #386, open, unanswered). | Set `defenseInDepth: false`; the host code is trusted by design per the upstream threat model. Alternatives are the `just-bash/browser` export or pinning 2.14.5, which is what `@ai-sdk/sandbox-just-bash` pins. If needed, `bun patch`; atlcli already uses `patchedDependencies`. |
| **Backend IO in the untrusted scope** | With defense-in-depth active, `fetch`, timers and `process.env` are blocked inside `IFileSystem`, and `fetch` surfaces as `ENOENT`. | Wrap every backend method in `DefenseInDepthBox.runTrustedAsync()`, which is what upstream commit #397 of 2026-09-07 did for lazy providers, or disable defense-in-depth. |
| **`grep -r` costs N requests** | just-bash walks the tree with one `stat` and one `readFile` per file; the `searchFiles` hook (issue #185) is not merged. | Override `grep` through `defineCommand` plus `ctx.origCommand`: CQL first, then the original grep over the matching bodies only (section 8). |
| Package size | 22.6 MB unpacked, 16 runtime dependencies (QuickJS, sql.js, undici and others). | Restrict the command set through `commands: [...]`, leaving Python, js-exec and sqlite unloaded; measure the effect on `bun build --compile`. |
| Beta status, remote-backend issues without maintainer replies | Issues #181, #185 and #386 are open. | Carry small workarounds ourselves, pin the version, keep conformance tests in this repo. |

### Usage

```bash
# Single command, agent friendly, real exit code
atlcli wiki sh --space DOCSY -c 'grep -rl "Kubernetes" /DOCSY | head'

# Interactive session
atlcli wiki sh --space DOCSY
/DOCSY $ ls
/DOCSY $ cat "getting-started-623869001.md"
/DOCSY $ find . -name "*.md" -newer .recent/7d

# Script from stdin
cat script.sh | atlcli wiki sh --space DOCSY --mode rw
```

For Claude Code an `AGENTS.md` or skill snippet is enough: "for Confluence use `atlcli wiki sh -c '…'`, space DOCSY, keep result limits small". That is the pattern Atlassian names in the Rovo MCP readme and Arize names in their evaluation as the largest token saver.

Second consumer of the same adapter: the existing `chat` and `research` agent (DeepAgents plus QuickJS) gains a `bash` tool over the same `IFileSystem` instance, either through `bash-tool` from Vercel Labs (MIT) or a LangChain tool of our own.

---

## 6. Frontend B: OS mount through WebDAV

### Assessment of the mount technologies (as of 2026-09-15)

| Approach | macOS | Linux | Windows | Extra install | Assessment |
|----------|-------|-------|---------|---------------|------------|
| **WebDAV server in Bun plus the OS client** | `mount_webdav` and Finder, no sudo | `davfs2` plus root or fstab | `net use X: http://localhost:PORT/`, all editions, 50 MB limit | none on macOS or Windows | **Recommended** |
| NFSv3 server (Rust `nfsserve` sidecar) | built in, no kernel extension, proven by rclone | `nfs-common` plus root | Pro and Enterprise only, described upstream as barely working | Rust binary | Option 2, better kernel caching |
| FUSE through `fuse-napi` (N-API, Aug 2026, 0 stars) | macFUSE 5.3.1 or later, proprietary license, no auto-install | libfuse3 | unsupported | macFUSE | Linux only at best, untested under Bun |
| FUSE-T | free of kernel extensions but **free for non-commercial use only** | not applicable | not applicable | Homebrew cask | unsuitable for a corporate CLI |
| `bun:ffi` against libfuse3 | not applicable | not applicable | not applicable | not applicable | Bun FFI is officially experimental and not for production |
| Apple FSKit or File Provider | needs a signed app extension; the FSKit backends of macFUSE and FUSE-T are experimental with bugs on macOS 26.1 and 26.2 | not applicable | ProjFS or Cloud Files | app bundle | not viable from a CLI, reassess in 2027 |

No open-source project mounts Confluence today; a GitHub search on 2026-09-15 returned nothing relevant. For Jira there is `jirafs` from 2018, abandoned. For Notion, `notionfs` is a sync tool rather than a mount.

### Design of the WebDAV frontend
- Library: `webdav-server` v2 (2.6.3, 2026-08-04, Unlicense) with a pluggable `FileSystem`.
- Bind to `127.0.0.1` only, on a random port, without authentication on loopback, with an optional bearer token in the header for multi-user hosts.
- Mandatory for the macOS Finder: `LOCK` and `UNLOCK`, otherwise the volume mounts read-only; fast 404 responses for AppleDouble files; an ETag derived from page ID and version; `PROPFIND` answers served from the tree index without an API call.
- `atlcli wiki mount ~/confluence --space DOCSY` starts the server and calls `mount_webdav` on macOS or `net use` on Windows; on Linux it prints the `mount -t davfs` instructions.
- Performance: WebDAV clients are chatty, with the Finder adding two to five times the request overhead. Confluence API latency dominates regardless, so the cache in section 8 decides the outcome rather than the protocol. `grep -r` through the mount stays slower than in frontend A because the kernel knows nothing of the CQL shortcut. The documentation therefore points at `atlcli wiki sh -c 'grep …'` for full-text search, which is how `slack-fuse` solves the same problem: 15 to 25 files per second through FUSE against 62,000 per second on its projection cache.

---

## 7. Path layout and metadata

The layout follows the index pattern from `hierarchy.ts`, where a page with children becomes a directory holding `_index.md`, extended by an **ID suffix** in every file and directory name (decision 4).

```
/                                        # root: every visible space
├── DOCSY/                               # space key
│   ├── _space.json                      # id, name, homepageId (read-only)
│   ├── _index.md                        # homepage body
│   ├── getting-started-623869001.md     # leaf page: <slug>-<id>.md
│   ├── architecture-623869955/          # page with children: <slug>-<id>/
│   │   ├── _index.md                    # its own body
│   │   ├── _attachments/                # lazy: metadata from v2, bytes on open
│   │   │   └── diagram.png
│   │   ├── .versions/                   # read-only, at most 50 with bodies
│   │   │   ├── 12.md
│   │   │   └── 11.md
│   │   ├── .comments.md                 # footer and inline comments rendered
│   │   └── deployment-623870112.md
│   ├── runbooks-623871000/              # Confluence folder (type: folder)
│   │   └── _index.md                    # frontmatter only
│   ├── .by-id/                          # virtual: stable address without slug
│   │   └── 623869955.md → ../architecture-623869955/_index.md
│   ├── .labels/                         # virtual: GET /labels/{id}/pages
│   │   └── runbook/                     # symlinks to pages
│   ├── .recent/                         # virtual: CQL lastmodified >= now("-7d")
│   │   ├── 24h/ 7d/ 30d/
│   └── .search/                         # virtual: lazily resolved CQL
│       └── text ~ "kubernetes"/         # listing runs the query, symlinks
└── .me.json                             # current user, profile, deployment
```

Rules:
- A file name is `slugifyTitle(title)` followed by a hyphen and the page ID. The ID is the key and the slug part is ignored when resolving, so `cat architecture-623869955/_index.md` still works after a rename even if the caller uses the old slug form. Resolution goes through the ID and a listing shows the current slug.
- Collisions are therefore impossible and `generateUniqueFilename()` is not needed.
- For agents that only know a page ID: `/DOCSY/.by-id/<id>.md` is a symlink to the canonical file.
- When creating new files in `rw` mode the name may be written without an ID, as in `echo > new-page.md`. After the `POST` the VFS renames the file to `new-page-<id>.md` and reports the canonical path on stderr and in `--json` output.
- Non-page children (whiteboard, database, embed) appear as `name-<id>.<type>.json` carrying a link, read-only.
- Frontmatter as it is today, plus VFS fields:

```markdown
---
atlcli:
  id: "623869955"
  title: "Architecture"
  version: 12
  parentId: "623869000"
  labels: [runbook, k8s]
  lastModified: "2026-09-14T10:22:00Z"
  url: https://site.atlassian.net/wiki/spaces/DOCSY/pages/623869955
---
```

- For `stat`, `mtime` comes from `version.createdAt` and `size` is the length of the rendered Markdown taken from the cache. When it is unknown the size is estimated from the body size so that `ls -l` does not trigger N requests.
- A symlink concept, such as a label directory pointing back at the canonical page, keeps the convenience directories free of duplicates. just-bash supports symlinks directly; WebDAV serves them as regular files carrying the target content, because WebDAV clients have no symlink concept.

---

## 8. Cache, rate limits and `grep`

### API facts (Cloud v2, spec verified 2026-09-15)
- Tree: `GET /spaces/{id}/pages?depth=root`, `GET /pages/{id}/direct-children` (the older `children` is marked deprecated in the spec), and `GET /pages/{id}/descendants?depth=10&limit=250` for `find` and `tree`.
- Bulk: `GET /pages?id=a,b,c&limit=250` with or without `body-format=storage`, up to 250 pages per request. This is the only bulk body fetch, and it serves both as the cache validator without bodies and as the prefetcher with them.
- Search: only v1 `GET /wiki/rest/api/search?cql=…`, which is not deprecated and which the 2026 consensus expects to stay. It returns excerpts.
- Rate limits: the points model in force since 2026-03-02 applies to **OAuth, Connect and Forge apps**, where tier 1 grants 65,000 points per hour **globally per app** and a page GET costs two points. API-token traffic is explicitly excluded and bounded only by unpublished burst limits; in practice 429 responses appear from roughly 20 to 30 parallel calls (atlassian-mcp-server issue #171, 2026-05). Data Center uses an administrator-configured token bucket, also returning 429 with `Retry-After`.

### Cache strategy
1. **TreeIndex** in memory, per profile and space, **partial and demand-driven** per rule 1 of section 1b: listing a directory loads exactly that one level through `direct-children` in a single request. A `descendants` pass over a subtree happens only for explicitly recursive operations and stays confined to the nodes being walked. Branches never entered stay unloaded. The TTL is 60 seconds **per node**, and revalidation uses a body-free bulk GET of 250 IDs per request comparing `version.number`, only for the loaded IDs of the affected directory.
2. **BodyCache** in SQLite keyed by page ID and version: versions are monotonic, entries are immutable, and invalidation happens only through the tree index. Reuses the `SyncDbAdapter` pattern from `packages/confluence/src/sync-db`. An entry is created **only** by a real read or a capped prefetch, never by `ls`, `stat` or `PROPFIND`.
3. **Cache location freely configurable** (decision 5): `--cache-dir <path>`, config `vfs.cacheDir` globally or per profile, default `~/.atlcli/vfs/`. Inside that directory the database always lives at `<profile>/<accountId>/<siteHash>.db`. Switching profiles means a different cache, so nobody can see content through the cache that their own token would not return. Pointing `--cache-dir` at a `docs pull` directory is **not** a goal; the two formats stay separate because the path schemes differ.
4. **Prefetch, capped:** `grep -r` and repeated `cat` use bulk GET with bodies in batches of 250, at most 8 parallel requests, honouring `Retry-After` with jitter through the existing `retry-after.ts` and `in-order-limiter.ts`. The ceiling is `vfs.prefetchMaxPages`, default 300; above it the operation aborts with a message instead of quietly mirroring a space.
5. **Disk cache as a bounded LRU:** `vfs.cacheMaxMb`, default 100, attachment blobs included, enforced while writing. The cache is not a mirror and may be deleted at any time without losing functionality.
6. **Offline mode:** `--offline` reads only from the cache and issues no requests. A `docs pull` directory is **not** a cache seed, because its path scheme lacks the ID suffix.

### Accelerating `grep` and `find`

The shortcut is an optimization, never a change in semantics. It may make a result faster but must never make it smaller.

- **Guard first** (decision 12): only a plain literal at word boundaries, at least three characters long, free of regex metacharacters and free of internal separators, qualifies for CQL. The reason is that the CQL text search matches by word and does not find parts of words. A silently empty `grep` would be a correctness bug, because an agent reads it as "does not occur".
- **Qualifying case:** stage one runs CQL `space = DOCSY AND type = page AND text ~ "word"` in a single request. Stage two fetches the matching bodies through the capped bulk GET. Stage three runs the original just-bash `grep` over those files for exact regex semantics and line numbers.
- **Non-qualifying case:** the capped prefetch of the subtree being walked. If it breaches the budget, `grep` aborts with a message naming the limit. There is no silent space download.
- **Transparency:** the chosen path always appears on stderr, and `--no-cql` disables the shortcut.
- `find -name` runs against the tree index without body requests and loads only the levels actually walked. `find -newer` and `-mtime` go through CQL `lastmodified`.
- There is no `grep -l label:x`; the label directory serves that purpose.
- Implementation: `defineCommand("grep", …, { trusted: true })` with `ctx.origCommand`, available from just-bash 3.4.0. This shortcut is impossible in the WebDAV frontend, where only the cache helps, which is why the documentation points full-text search at `wiki sh`.

---

## 9. Writing, conflicts, security

### Semantics
| Shell operation | Confluence call |
|-----------------|-----------------|
| `cat > new.md`, `touch` | `POST /pages` with the parent ID from the directory, the title from frontmatter or the file name, and the body through `markdownToStorage` |
| `echo` or `sed -i` on an existing file | `PUT /pages/{id}` with `version.number = cached + 1` |
| `mv a.md b.md` in the same directory | `PUT /pages/{id}/title` |
| `mv dir1/a.md dir2/` within one space | `PUT /pages/{id}` with a new parent ID |
| `mv` into another space, or reordering | v1 `PUT /content/{id}/move/{before\|after\|append}/{target}` |
| `mkdir new/` | `POST /pages` with an empty body; `_index.md` appears |
| `rm a.md` | `DELETE /pages/{id}`, which is trash. Purge is never offered |
| `cp` | `copyPage` (existing) |
| Writing into `.versions/`, `.labels/` or `_attachments/` | `EROFS`, except attachment upload through v1 `child/attachment` |

### Conflicts
- Write-back compares the file's frontmatter version against the server version. A mismatch, or a 409 stating that the version must be incremented, triggers a refetch and a three-way merge through the existing `merge.ts`. If the merge fails, a conflict file appears and the write fails with `EBUSY`. This matches the behaviour of `docs push`.
- Editor writes often arrive in several chunks, since WebDAV clients combine `PUT` with `LOCK`. Write coalescing buffers changes for 500 ms and then issues one `PUT`. Frontmatter is stripped before writing back, with the title taken from it.

### Security
- **Mode as a parameter** (decision 6): `--mode ro|rw`, default `ro`, with config `vfs.mode` per profile. `rw` enables create, update, rename and move, and `--allow-delete` additionally enables trash. In `ro` mode every write attempt returns `EROFS`. This mirrors Atlassian's Rovo MCP permission groups, where delete is off by default.
- Confirmation per decision 10: with a terminal, `rm` and cross-space `mv` prompt, and `--confirm` skips the prompts. Without a terminal, `--allow-delete` is the confirmation and no further flag exists.
- Audit log: every write operation is recorded as JSONL under the cache directory, reusing the existing JSONL logging described in `spec/jsonl-logging.md`.
- Tokens never leave the process. The WebDAV server is unauthenticated on loopback only; any other binding requires a bearer token.
- Visibility: Cloud v2 filters spaces, pages and children server-side, stating that only pages the user may view are returned. Rovo MCP and the Teamwork Graph CLI give the same guarantee. The VFS must therefore never share caches across profiles, and must map 401, 403 and 404 consistently to `ENOENT` or `EACCES` rather than guessing.

### Auth situation in 2026
- Cloud API tokens come in scoped form, through the `api.atlassian.com/ex/confluence/{cloudId}` gateway, and in classic form. Tokens created before 2024-12-15 expired between 2026-03-14 and 2026-05-12, which has already happened. There is **no published end date for classic tokens on REST**; the only hard date found concerns Jira Product Discovery GraphQL on 2026-10-31.
- Atlassian policy since 2026-01-01 says distributed integrations should not prompt users to paste API tokens. A personal CLI script sits in a grey area. **Decision 3 keeps v1 on API tokens** (Cloud scoped and classic, Data Center PAT) and does not build OAuth 2.0 (3LO). If it becomes necessary later: a loopback redirect with `offline_access` and the scopes `read:page`, `write:page`, `delete:page`, `read:space`, `read:hierarchical-content`, `read:attachment`, `read:label` and `search:confluence`. OAuth traffic would land in the **global 65,000 points per hour pool per app**, which is why API tokens remain the more capable path anyway.
- Data Center uses a PAT as a bearer token against v1 REST. The VFS therefore needs a Cloud v2 and a Data Center v1 backend adapter, which `ConfluenceClient` already encapsulates through `deploymentType`.

---

## 10. Dependencies (decided)

| Purpose | Package | Version and date | License | Note |
|---------|---------|------------------|---------|------|
| Bash interpreter plus VFS interface | `just-bash` | 3.4.2 (2026-08-22), pinned | Apache-2.0 | Bun needs `defenseInDepth: false` or a patch; restrict the command set |
| Optional AI SDK tool for chat and research | `bash-tool` | 1.3.19 (2026-08-22) | MIT | Peer dependency `just-bash ^3` |
| WebDAV server | `webdav-server` | 2.6.3 (2026-08-04) | Unlicense | v2 API, custom FileSystem |
| Cache | `bun:sqlite` | built in | not applicable | as in `sync-db` |
| **Not** to be adopted | `fuse-napi`, `@cocalc/fuse-native`, `@zenfs/core` | not applicable | MIT and LGPL | FUSE requires a driver; ZenFS is LGPL with mandatory synchronous and asynchronous methods and offers no shell |

Alternatives checked and rejected: `memfs` (in-memory only), `unionfs` (2025, **[dated]**), `bash-emulator` (2016, **[dated]**), WebContainers (commercial license required in production), `@wasmer/sdk` (no lazy backend), `@cloudflare/shell` (an experimental fork of just-bash), and `@anthropic-ai/sandbox-runtime` (sandboxes real bash, provides no virtual filesystem).

---

## 11. Implementation plan

Target for v1: `wiki sh` **and** `wiki mount`, reading and writing through `--mode ro|rw`, ID-suffix paths, a configurable cache, and the demand principle from section 1b. Effort is roughly 6 to 7 weeks for one person. The work packages (WP) are cut so that WP2 to WP5 can run in parallel with WP6 and WP7 once WP1 stands.

Conventions for every work package:
- New logic goes into the package `packages/confluence-vfs` as a functional core with no CLI dependency; adapters and commands go into `apps/cli`.
- Every task has tests run through `bun run test`, and bug fixes get regression tests.
- Commits follow Conventional Commits: `feat(vfs):`, `feat(cli):`, `docs:`.
- End-to-end runs use profile `mayflower` and space `DOCSY`, with test pages prefixed `vfs-e2e-` and deleted afterwards.
- No push without `bun run typecheck`.

### WP0 - Spike and de-risking (2 days)

Results: [`spikes/vfs-just-bash/README.md`](../../spikes/vfs-just-bash/README.md).

- [x] **WP0.1** Add `just-bash@3.4.2` as a dependency of `apps/cli`, pin the exact version, and confirm `bun install` completes without postinstall errors.
- [x] **WP0.2** Spike script `spikes/vfs-just-bash/spike.ts` constructing `new Bash({ defenseInDepth: false, fs: new MountableFs({ mounts: [{ mountPoint: "/DOCSY", filesystem: fakeFs }] }) })` and running `ls -R`, `cat`, `grep -rn`, `find -name`, `sed`, `jq` and `echo > file` against a fake `IFileSystem` under Bun 1.3.14. Expectation: all succeed with no `DefenseInDepthBox` error.
- [ ] **WP0.3** *(blocked: no live tenant in CI; script written, run it with the `mayflower` profile)* Spike against the real `ConfluenceClient` (profile `mayflower`, space `DOCSY`, read-only): `ls /DOCSY`, `cat` of one page, `grep -rl` across 20 pages. Log latency and request counts.
- [ ] **WP0.3b** *(blocked: no live tenant in CI; script written, run it with the `mayflower` profile)* **Measure the semantics of the CQL text search**, the basis for decision 12: create a test page with known character sequences, then probe `text ~` against a whole word, a word prefix, a word interior, underscore and hyphen compounds, an umlaut and a digit sequence. Record the result as a table in `spikes/vfs-just-bash/README.md` and derive the final guard rule from it. Delete the test page afterwards.
- [x] **WP0.4** Bundle measurement: run `bun run build:cli` with and without just-bash, noting the size of `dist/index.js` and of the compiled binary; then apply the `commands: [...]` restriction, excluding python3, js-exec, sqlite3 and curl, and measure again. Record the result in `spikes/vfs-just-bash/README.md`.
- [x] **WP0.5** *(server side verified under Bun; the macOS `mount_webdav`/Finder half stays open against WP7.9)* Smoke-test `webdav-server@2.6.3` under Bun: start it with an in-memory filesystem on `127.0.0.1:0`, exercise it with `curl -X PROPFIND`, and on macOS mount it with `mount_webdav` and list it in the Finder. Record whether it works, and any workarounds, in the spike readme.
- [x] **WP0.6** Document the decision: is the bundle size acceptable? If not, load just-bash through a dynamic import on the `wiki sh` path only, so that other commands carry no cost.

### WP1 - Package scaffold and core API (3 days)

Deviation: `VfsOptions.client` is typed as the narrow `VfsClient` port in
`src/client-port.ts` rather than `ConfluenceClient` itself, so WP1.6's fake is
possible and so the VFS's whole Confluence surface is readable in one file
(WP9.1). `client-port.test.ts` proves the real client still satisfies it.

- [x] **WP1.1** Create `packages/confluence-vfs/` with a `package.json` named `@atlcli/confluence-vfs` whose exports carry the `development` condition as `@atlcli/confluence` does, plus `tsconfig.json`, `src/index.ts`, build and typecheck scripts, and registration in the Turbo pipeline. `bun run typecheck` must pass.
- [x] **WP1.2** Core types in `src/types.ts`: `VfsNode` with `kind: "space" | "page" | "folder" | "attachment" | "virtual-dir" | "virtual-file" | "symlink"`, plus `id`, `title`, `slug`, `version`, `parentId`, `mtime` and optional `size`; `VfsStat`; and `VfsError` with the codes `ENOENT`, `EACCES`, `EROFS`, `EISDIR`, `ENOTDIR`, `EEXIST`, `EBUSY` and `ENOTEMPTY`.
- [x] **WP1.3** Core interface `ConfluenceVfs` in `src/vfs.ts`: `stat(path)`, `readdir(path)`, `readFile(path)`, `readFileBytes(path)`, `writeFile(path, content)`, `mkdir(path)`, `rename(from, to)`, `rm(path, {recursive})`, `copy(from, to)` and `readlink(path)`. All asynchronous, all throwing `VfsError`.
- [x] **WP1.4** Options type `VfsOptions`: `profile`, `client: ConfluenceClient`, optional `spaces?: string[]` restricting visible spaces, `mode: "ro" | "rw"`, `allowDelete: boolean`, `cacheDir: string`, `offline: boolean`, `concurrency: number` defaulting to 8, `treeTtlMs` defaulting to 60,000, and `logger`.
- [x] **WP1.5** Error mapping in `src/errors.ts`: HTTP 401 and 403 become `EACCES`, 404 becomes `ENOENT`, 409 becomes `EBUSY`, and 429 retries through the existing `retry-after.ts` before surfacing a `VfsError` that explains the wait. Unit tests for each case.
- [x] **WP1.6** `FakeConfluenceClient` in `src/testing/fake-client.ts` with in-memory spaces, pages, versions, labels and attachments, permission simulation through a set of visible IDs, and configurable 409 and 429 responses. This is the basis of every unit test.
- [x] **WP1.7** Mode guard: a central `assertWritable(op)` in `src/mode.ts`. In `ro` mode every write operation throws `EROFS`, and `rm` without `allowDelete` throws `EACCES` with an explanatory message. Tests cover all write operations in both modes.

### WP2 - Path mapping and tree index (4 days)

**Deviation D1: every page is a directory.** Section 7 shows a leaf page as
`getting-started-623869001.md` and a page with children as
`architecture-623869955/`. That split is unreachable under the demand
principle: choosing the form of a listed child means knowing whether *that
child* has children, and Confluence answers that only with one
`direct-children` request per child — the N+1 rule 1 forbids. Guessing "leaf"
for anything not yet entered was the other option, and it makes `ls -R`, `find`
and recursive `grep` skip whole subtrees, which is the same class of
correctness bug decision 12 rejects for `grep`. So `readdir` presents every
page and folder as a directory whose body is `_index.md`, and
`<slug>-<id>.md` stays resolvable as an alias for `<slug>-<id>/_index.md` so
the short paths in section 7's examples keep working.

**Deviation D2: no `descendants` call.** WP2.4 planned
`getPageDescendants(id, { depth: 10 })`. The existing client fixes that
endpoint's depth at exactly 1 and throws a `RangeError` for anything else, so
it returns the same data as `direct-children` and buys nothing. `loadSubtree`
walks level by level instead, one request per *visited* directory, and the
method is not part of the VFS client port at all.

**Deviation D3: Data Center revalidates by re-listing.** WP2.5 planned a
body-free bulk `GET /pages?id=…`. That is `getPageVersions`, which is Cloud v2
only and throws a `TypeError` on Data Center. The v1 children listing already
carries `version` and `lastModified`, so Data Center revalidates with one
forced re-listing — one request rather than two. Covered by a regression test
and by `tree-index-dc.contract.test.ts`, which drives the real client against a
local v1 server and fails if any v2 route is touched.

- [x] **WP2.1** `src/path-mapper.ts`: `formatName(title, id, hasChildren)` produces `<slug>-<id>.md` or `<slug>-<id>/`; `parseName(name)` returns the slug and ID using the pattern `^(.*)-(\d+)(\.md)?$`, with a fallback for names without an ID, which new files in `rw` mode use. The slug comes from `slugifyTitle()` in `@atlcli/confluence`. Unit tests include titles ending in digits, where only the page ID known from the tree index may be split off.
- [x] **WP2.2** Resolution `resolvePath(path)` returning a `VfsNode`, segment by segment: a space key resolves to a space; a segment carrying an ID resolves by that ID and the slug is ignored; a segment without an ID yields `ENOENT` except for the reserved names `_index.md`, `_space.json`, `_attachments`, `.versions`, `.comments.md`, `.by-id`, `.labels`, `.recent`, `.search` and `.me.json`.
- [x] **WP2.3** `src/tree-index.ts` as a **demand-driven, partial** index per rule 1 of section 1b: a `Map<id, TreeNode>` whose `children` is either a list of IDs or the marker `unloaded`. `loadChildren(id)` fetches exactly one level through `getPageDirectChildren` in `childPosition` order, and the space root comes from `listSpacesV2` plus its root level. Folders appear as children of the same call, so `getSpaceFolders` is **not** called wholesale. Test: loading the space root and two subdirectories costs three requests regardless of space size.
- [x] **WP2.4** `loadSubtree(id, depth)` for explicitly recursive operations such as `find`, `tree`, `ls -R` and recursive `grep`: `getPageDescendants` scoped to **this** node, batched at 250, marking the visited nodes as loaded. Never triggered automatically by a plain `readdir`. Test: `find` inside one subdirectory does not load a sibling branch.
- [x] **WP2.5** Revalidation: TTL `treeTtlMs` applied **per node** rather than globally. After expiry a body-free bulk GET of `GET /pages?id=…&limit=250` covers the already loaded IDs of the affected directory and compares `version.number`; structural changes come from calling `loadChildren` again on the same node. Tests cover a version bump, a deleted page, a new page, a moved page, and the requirement that a branch never entered triggers no request during revalidation.
- [x] **WP2.5b** `readdir` and `stat` served from the index without a body fetch (rule 2). `stat` takes `mtime` from `version.createdAt` and `size` from the cache, estimating it otherwise. Invariant test: `ls -R` and `stat` across 5,000 pages in the fake write no body rows into the cache.
- [x] **WP2.6** Data Center path: the same tree index over v1, using `getChildren` and `getAllPages` with `deploymentType: "data-center"`, covered in the fake, plus a contract test modelled on `wiki-import-dc.contract.test.ts`.
- [x] **WP2.7** Visibility: a test that pages the fake client marks invisible appear neither in `readdir`, nor through `.by-id/`, nor by direct ID address, returning `ENOENT` rather than `EACCES` so that existence is not revealed, matching the API.

### WP3 - Body cache and conversion (3 days)

**Correction to deviation D4 (withdrawn).** An earlier note here claimed the
repository's frontmatter was flat and that the VFS therefore had to deviate
from section 7's nested `atlcli:` block. That was wrong: `addFrontmatter`
already writes the nested block, and section 7 matches the repository exactly.
The VFS emits the same block with its extra fields appended, and a test pins
that `parseFrontmatter` still reads it.

- [x] **WP3.1** `src/body-cache.ts` on `bun:sqlite` with a `bodies` table keyed by page ID and version holding the Markdown, a storage hash and a fetch timestamp, and an `attachments` table holding ID, page ID, filename, media type, size, version and blob path. Migrations follow the pattern in `sync-db/migrations.ts`.
- [x] **WP3.2** Cache location: `resolveCacheDir(opts)` reads `--cache-dir` first, then config `vfs.cacheDir` with the profile winning over the global value, then defaults to `~/.atlcli/vfs/`; beneath it the path is always `<profile>/<accountId>/<siteHash>.db`. The account ID comes from `getCurrentUser()` at startup, one cached request. Tests cover the precedence of the sources and the isolation of two profiles inside the same `--cache-dir`.
- [x] **WP3.3** `readFile` for `_index.md` and `<slug>-<id>.md`: serve a cache hit when the version matches, otherwise call `getPage` with `body-format=storage`, convert through `storageToMarkdown()`, prepend the frontmatter fields for ID, title, version, parent ID, labels, last modified and URL, and write the result into the cache. Round-trip test from storage to Markdown and back using the existing fixtures.
- [x] **WP3.4** Prefetch `prefetchBodies(ids, { budget })` over `GET /pages?id=…&body-format=storage&limit=250`, which needs the new client method `getPagesBulk` in `@atlcli/confluence` with its own test, using `createInOrderLimiter` for concurrency and honouring `Retry-After`. **Hard ceiling** `vfs.prefetchMaxPages`, default 300, per rule 3: exceeding it aborts the call with a `VfsError` naming the page count, the limit and the flag that raises it, and nothing is downloaded partially. Tests: within the limit, over the limit, and raising it through the option.
- [x] **WP3.5** `--offline` reads only from the cache, and a cache miss returns `ENOENT` with a message saying the content is not cached and suggesting a retry without the flag. The tree index persists as JSON in the cache directory so that listings work offline. Tests included.
- [ ] **WP3.6** *(cache mechanics done in the core — LRU, stats, clear, the shared body/blob budget; the `atlcli wiki vfs cache` command lands with the CLI slice in WP6)* Cache maintenance through `atlcli wiki vfs cache stats|clear [--space]`, reporting size, entries, age and hit rate; the size limit is `vfs.cacheMaxMb`, default **100** per rule 4, with LRU eviction by last access enforced **while** writing rather than afterwards, and attachment blobs counting against the same limit. Tests: eviction in the middle of a prefetch, a blob and a body competing for the same budget, and plausible statistics after eviction.
- [ ] **WP3.7** *(depends on the conflict files from WP5.2; the command lands with the CLI slice in WP6)* `atlcli wiki vfs conflicts list|show|resolve|discard` for the persisted conflict files from WP5.2 (decision 9), so that open conflicts are discoverable outside a shell session. Tests included.

### WP4 - Virtual directories and side objects (3 days)

**Deviation D5: `.labels/` resolves lazily, like `.search/`.** WP4.6 planned a
new client method against "the space labels endpoint". No such endpoint exists:
`GET /space/{key}/label` returns labels *of the space object*, and the only way
to enumerate the labels used by a space's pages is to read every page — rule 1
forbids exactly that. So `.labels/` lists the labels this session has already
seen and resolves `.labels/<anything>/` regardless, which is decision 8's
treatment of `.search/` applied for a harder reason. Its `README` says so.

**Deviation D6: `.by-id/` lists nothing but a `README`.** Populating it means
enumerating every page in the space, which is the whole-space copy section 1b
forbids. Resolution by id works for any visible page, which is what the
directory is for.

**Note on symlink targets.** `.by-id/<id>.md` points at the page's canonical
path, computed from the tree index when the ancestors are loaded and otherwise
with one `getAncestors` call. The view directories (`.labels/`, `.recent/`,
`.search/`) point back through `.by-id/` rather than at canonical paths, so
listing a view never costs an ancestor walk per entry.

- [x] **WP4.1** `_space.json` and `.me.json`, read-only JSON from `getSpace` and `getCurrentUser`.
- [x] **WP4.2** `_attachments/`: `readdir` from `listAttachments`, cached per page version; `readFileBytes` downloads through `downloadAttachment` into a blob file under the cache directory and streams from there; size and modification time come from the metadata so that `ls -l` triggers no download. Blobs count against the cache limit from WP3.6 and are evicted like bodies. Tests against the fake include listing a directory with ten attachments and loading zero bytes.
- [x] **WP4.3** `.versions/<n>.md`: `readdir` from `getPageVersions`, at most 50 entries; `readFile` through `getPageAtVersion` plus conversion, cached immutably. Read-only, returning `EROFS` on write.
- [x] **WP4.4** `.comments.md`: footer and inline comments through `getAllComments`, rendered as a Markdown list with author, date and resolution state. Read-only.
- [x] **WP4.5** `.by-id/<id>.md` as a symlink to the canonical path, supporting `readlink` and transparent `readFile`. Tests include an unknown ID returning `ENOENT`.
- [x] **WP4.6** `.labels/<label>/`: `readdir` of the label names from the space labels endpoint, which needs a new client method, with the contents coming from `getPagesByLabel` as symlinks. TTL as for the tree index.
- [x] **WP4.7** `.recent/{24h,7d,30d}/`: CQL of the form `space = KEY AND type = page AND lastmodified >= now("-7d")` through `searchPages`, returning symlinks, with a 60 second TTL.
- [x] **WP4.8** `.search/<query>/` with **lazy resolution** (decision 8): the directory name is the CQL and `space =` is appended; every path beneath it resolves on access, **without** a prior `mkdir`. Listing the search directory itself shows only `README` and the last twenty queries used, read from a file in the cache directory; that list may be lost without breaking anything. `mkdir` and `rmdir` only maintain the list. `README` explains the syntax and the limitation that a slash cannot appear in a name, so such queries go through the `cql` command. Tests: resolution without `mkdir`, the list being lost while resolution keeps working, and a slash in the query rejected with a clear message.
- [x] **WP4.9** Non-page children (whiteboard, database, embed) as `name-<id>.<type>.json`, read-only. Test included.

### WP5 - Write path (5 days)

- [ ] **WP5.1** `src/write-back.ts`: `writeFile` on an existing page parses the frontmatter, converts through `markdownToStorage()`, checks the version against the tree index, and calls `updatePage` with the cached version plus one; on success it updates the tree index and the body cache. A title change in the frontmatter additionally calls `PUT /pages/{id}/title` through a new client method, or carries the title in the same update.
- [ ] **WP5.2** Conflict: a version mismatch before the update, or a 409 after it, triggers a refetch and a three-way merge through `merge.ts` with the cached version as base, the written content as ours and the server as theirs. A clean merge retries the update. A merge with conflicts returns `EBUSY` plus a **persisted** conflict file (decision 9) under `<cacheDir>/conflicts/<pageId>-<ts>.md` carrying conflict markers and frontmatter for page ID, base version, server version, creation time and origin, visible in the tree as `<slug>-<id>.conflict.md`. Deleting the conflict file is a local operation, allowed in `ro` mode and without `--allow-delete`. Regression tests: stale write, server 409, clean merge, conflicting merge, a conflict surviving a process restart, and deletion permitted in `ro` mode.
- [ ] **WP5.3** New page: `writeFile` on a name that does not exist takes the title from frontmatter, or otherwise from the file name by turning the slug into a title with spaces and initial capitals; the parent ID comes from the directory, using `movePageToFolder` when that directory is a folder; then `createPage` runs. The file afterwards appears as `<slug>-<id>.md`, and the original name stays resolvable as an alias for the session. `EEXIST` applies when a page with that title already exists in the same directory. Tests included.
- [ ] **WP5.4** `mkdir <name>/` **always** creates a page with an empty body (decision 7), and `_index.md` appears and is writable. No `--folders` flag. Test included, plus a test that the `_index.md` of an **existing** Confluence folder returns `EROFS`, because folders have no body.
- [ ] **WP5.5** `rename` inside the same directory changes the title; into another directory of the same space it calls `movePage`; into another space or with a sort position it calls `movePageToPosition` against the existing v1 move endpoint. Renaming a directory moves the subtree in one call, since Confluence carries the children along. Tests per case, plus a test that the ID suffix cannot be altered by a rename, which returns `EINVAL`.
- [ ] **WP5.6** `rm`, only with `allowDelete`: a file calls `deletePage`, which is trash; a directory requires the recursive flag and otherwise returns `ENOTEMPTY`; a recursive directory delete calls `deletePage` on the parent page, since Confluence moves the children along. Purge is never called. Tests included.
- [ ] **WP5.7** `copy` calls the existing `copyPage` with the target directory as parent. Test included.
- [ ] **WP5.8** Attachments in `rw` mode: writing into `_attachments/` calls `uploadAttachment` or `updateAttachment`, and `rm` calls `deleteAttachment`, only with `allowDelete`. Tests included.
- [ ] **WP5.9** Write coalescing: writes to the same file within 500 ms are merged, because WebDAV clients and editors write in chunks; `flush()` runs at the end of a session, and `--sync-writes` disables coalescing. Tests use a fake timer.
- [ ] **WP5.10** Audit log: every successful and failed write operation is appended as JSONL carrying timestamp, profile, account ID, operation, path, page ID, source and target version, result and error, written under the cache directory and rotated at 10 MB. Test included.
- [ ] **WP5.11** Round-trip test in the fake: read a page, apply a `sed`-style change, write it, read it again, and compare the Markdown after normalization through `normalizeMarkdown`. Known losses, such as macros without a Markdown equivalent, are reported as a warning on stderr rather than discarded silently.

### WP6 - just-bash adapter and `atlcli wiki sh` (5 days)

- [ ] **WP6.1** `apps/cli/src/vfs/just-bash-fs.ts`: a class `ConfluenceJustBashFs implements IFileSystem` delegating to `ConfluenceVfs`, with `resolvePath` built on `path.posix`, `getAllPaths()` returning the known paths from the tree index synchronously from memory, `readdirWithFileTypes` implemented so that `ls -l` and `find` avoid stat storms, `readFileBytes` for attachments, and `VfsError` translated into Node-style errors carrying a `code`. Conformance tests come from just-bash where exported, otherwise from our own set covering `ls`, `ls -la`, `cat`, `find`, `grep -rn`, `sed`, `awk`, `jq`, `wc`, `head`, `tail`, `tree`, globs, output redirection, `mkdir`, `mv`, `rm` and `cp`.
- [ ] **WP6.2** Bash factory `createWikiShell(opts)` constructing `new Bash({ … })` with `defenseInDepth: false`, a `MountableFs` holding one mount per space under its key, the working directory set to the primary space, a permitted command list excluding curl, python3, js-exec and sqlite3, execution limits of 120 seconds and an 8 MB output cap, and the custom commands. A code comment links just-bash issue #386 and carries a TODO to re-enable defense-in-depth.
- [ ] **WP6.3** `grep` override through `defineCommand("grep", …, { trusted: true })` with `ctx.origCommand`, parsing the flags `-r`, `-R`, `-l`, `-n`, `-i`, `-E`, `-F` and `--include`. The **conservative guard** from decision 12 takes the CQL shortcut only when the pattern is a plain literal at word boundaries, meaning no regex metacharacters, no internal underscores or hyphens, and at least three characters. It then runs CQL `space = KEY AND type = page AND text ~ "word"`, passes the matching IDs through `prefetchBodies`, and finally runs the original `grep` over those files for exact semantics and line numbers. Every other pattern goes through the capped prefetch of the subtree being walked from WP3.4, and if that breaches the budget, `grep` aborts with a message rather than returning silently. The chosen path is **always** named on stderr as either a CQL path or a full scan, and `--no-cql` together with an environment variable disables the shortcut. Non-recursive `grep` over single files or stdin passes through unchanged. Tests: flag parsing, the guard accepting plain literals, the guard rejecting partial-word, regex and underscore patterns, the budget abort, exact line numbers, and stderr naming the path.
- [ ] **WP6.4** `find` override: `-name`, `-iname`, `-path` and `-type` run against the tree index only; `-newer`, `-mtime` and `-newermt` go through CQL `lastmodified`; every other predicate falls through to the original `find`. Tests included.
- [ ] **WP6.5** Extra commands: `cql "<query>"` runs a query and prints paths, `page-url <path>` prints the Confluence URL, `page-id <path>` prints the ID, and `vfs-status` reports mode, cache state, request count and rate-limit counters. Tests included.
- [ ] **WP6.6** Command `apps/cli/src/commands/wiki-sh.ts` dispatched from `wiki.ts`, with a help text and the flags `--space <KEY[,KEY]>` defaulting from the profile, `-c <script>`, a stdin script when not attached to a terminal, an interactive prompt when attached, `--mode ro|rw`, `--allow-delete`, `--cache-dir`, `--offline`, `--cwd <path>`, `--timeout <ms>`, `--json` emitting stdout, stderr, exit code, request count, cache hits and prefetched pages, plus `--prefetch-max <n>` and `--no-cql`. Confirmation follows decision 10: with a terminal, `rm` and cross-space `mv` prompt and `--confirm` skips them; without a terminal, `--allow-delete` is the confirmation and no further flag exists. The exit code is the bash exit code. Tests follow `docs.test.ts`, covering flag parsing, help output, the JSON shape, and deletion succeeding without a terminal and without an extra flag.
- [ ] **WP6.7** Config extension in `@atlcli/core`: a `vfs` section carrying optional `cacheDir`, `mode`, `spaces`, `cacheMaxMb`, `prefetchMaxPages` and `cqlGrep`, both globally and per profile, with `atlcli config` showing and setting the values. Tests included.
- [ ] **WP6.8** Load just-bash through a dynamic import inside the command, so that the startup time of other commands stays unchanged. Add the measurement to the spike readme.
- [ ] **WP6.9** End-to-end test `apps/cli/src/e2e/wiki-sh-live.e2e.test.ts` behind an environment gate: `ls`, `cat`, `grep -rl` and `find -name` against `DOCSY`; in `rw` mode create a page prefixed `vfs-e2e-`, change it, rename it, move it and delete it, with cleanup even on failure following the pattern in `e2e/cleanup.ts`.

### WP7 - WebDAV adapter and `atlcli wiki mount` (6 days)

- [ ] **WP7.1** `apps/cli/src/vfs/webdav-fs.ts`: a `webdav-server` v2 `FileSystem` implementation covering the serializer, read and write streams, directory listing, type, size, modification and creation dates, create, delete, move, copy, rename, the lock manager and the property manager, all delegating to `ConfluenceVfs`. `VfsError` maps to the appropriate HTTP codes including 404, 403, 409, 423 and 507. Symlinked convenience directories are served as regular files carrying the target content, because WebDAV has no symlink concept.
- [ ] **WP7.2** LOCK and UNLOCK through an in-memory lock manager, which is mandatory or the Finder mounts read-only, with locks expiring after ten minutes. The ETag combines page ID and version, and `If-Match` handling on update feeds the conflict path from WP5.2. Tests use a WebDAV client library against the in-process server.
- [ ] **WP7.3** Client quirks: immediate 404 for AppleDouble files, `.DS_Store`, `.hidden`, `desktop.ini` and `Thumbs.db` without a backend call; `PROPFIND` at depth one served from the tree index without a body fetch; content length for Markdown taken from the cache or estimated for the property response and set exactly on the actual read. Tests assert that a `PROPFIND` on a directory with 250 children triggers no body requests.
- [ ] **WP7.3b** **Indexer defence** per rules 1 and 3 of section 1b, without which a search index would download the whole space: `.metadata_never_index` at the volume root is **served** as an empty file rather than refused with a 404, because its presence stops Spotlight from indexing, together with its `unless_rootfs` variant and an empty `.fseventsd` directory. Verify the behaviour in the spike by creating a mount, checking `mdutil -s` and the request counter, and confirming that Spotlight does not walk the mount. Check the Windows counterpart, covering the WebClient and search indexing, and document the result. Additionally a guard in the server logs more than 50 read requests for distinct files within ten seconds that were not preceded by a directory listing from the same directory, and reports it under a flag as a possible indexer sweep.
- [ ] **WP7.4** Server lifecycle in `apps/cli/src/vfs/webdav-server.ts`: bind to `127.0.0.1`, take the port from a flag or choose it randomly, offer an optional bearer token that becomes mandatory for any non-loopback binding, and shut down cleanly on SIGINT and SIGTERM including a flush of buffered writes and an unmount.
- [ ] **WP7.5** Command `apps/cli/src/commands/wiki-mount.ts` dispatched for mount and unmount: `atlcli wiki mount <mountpoint>` with `--space`, `--mode ro|rw`, `--allow-delete`, `--cache-dir`, `--port` and a foreground or daemon choice. Platform commands:

  ```bash
  # macOS, -S suppresses the authentication dialog
  mount_webdav -S -v atlcli-DOCSY http://127.0.0.1:<port>/ <mountpoint>
  # Windows
  net use <X:> http://127.0.0.1:<port>/
  # Linux, printed as instructions after checking for davfs2
  mount -t davfs http://127.0.0.1:<port>/ <mountpoint>
  ```

  Unmount calls `umount` or `net use /delete` and stops the server. A PID and port file lives under `<cacheDir>/mounts/<mountpoint-hash>.json`.
- [ ] **WP7.6** Daemon mode: run the server as a detached process through `Bun.spawn`, with logs under the cache directory, and let `atlcli wiki mount list|status` show the active mounts.
- [ ] **WP7.7** Performance measurement on macOS in both the Finder and the terminal: `ls -R` across 500 pages, `grep -r` across 100 pages, and opening and saving in an editor. Put the numbers and request counts into the documentation, with the threshold that listing a directory of 100 entries stays under one second after warmup.
- [ ] **WP7.8** Windows smoke test through the WebClient, documenting the 50 MB limit, and a Linux smoke test with `davfs2` in a CI container that exercises only the server through HTTP, since CI cannot perform a kernel mount.
- [ ] **WP7.9** End-to-end test `wiki-mount-live.e2e.test.ts` behind an environment gate and limited to a local macOS runner: mount, list, read, then in `rw` mode create and change a page, unmount and clean up.

### WP8 - Documentation and agent integration (2 days)

- [ ] **WP8.1** `src/content/docs/confluence/virtual-filesystem.md` following the docs template: intro, prerequisites covering profile, token and space, steps for `wiki sh` and `wiki mount` separated by platform, an options reference giving type, default and whether each is required, a minimal example and an advanced agent workflow covering search, in-place editing, moving and the conflict file, troubleshooting covering a read-only Finder mount from a missing lock, 429 responses and concurrency, `EROFS` and the write mode, a reached prefetch budget, a `grep` reporting a full scan, and the Bun and defense-in-depth note, plus related topics linking `sync.md`, `search.md` and `file-format.md`. A dedicated section, **"A cache, not a copy"**, states the difference from `docs pull`: the VFS loads only what is read, the cache is bounded and deletable at any time, and `docs pull` stays the right tool for a full local copy.
- [ ] **WP8.2** Extend `src/content/docs/reference/cli-commands` with `wiki sh`, `wiki mount`, `wiki unmount` and `wiki vfs cache`, and the config reference with the `vfs` section.
- [ ] **WP8.3** A skill and agent snippet at `docs/agents/confluence-vfs.md`, also surfaced in the docs recipes section: a short guide for Claude Code, Codex and Cursor covering the single-command form, the space default, JSON output, the note that recursive search uses CQL with a recommended result limit, and the fact that writing requires the explicit write mode.
- [ ] **WP8.4** A `README.md` section titled "Confluence as a filesystem" with two examples, plus an unreleased entry in `CHANGELOG.md`.
- [ ] **WP8.5** Bring `specs/confluence-virtual-filesystem/PLAN.md`, this document, up to the actual state once the work is done: the status line, deviations, measured values and remaining points; place the measurements from WP0.4, WP7.7 and WP9.3 alongside it as `EVIDENCE.md`.

### WP9 - Quality, security, release (3 days)

- [ ] **WP9.1** Security review of the write path: no purge calls anywhere, `ro` enforcing `EROFS` on every route including just-bash, WebDAV and the extra commands, tokens never appearing in the audit log or in JSON output, and the WebDAV server unauthenticated only on loopback. Checklist in the pull request.
- [ ] **WP9.2** Permission end-to-end test: a second profile with a restricted user, or a page restricted through `setContentRestrictions`, proving that the page is visible to profile A and returns `ENOENT` for profile B, and that A's cache gives B nothing because the databases are separate. With cleanup.
- [ ] **WP9.3** Load test in the fake with 5,000 pages: listing individual directories, `ls -R`, `grep -r` with 50 CQL matches, and one pattern the guard rejects; record request counts, cache bytes written and runtime as a snapshot test with tolerance. Check whether a 300 page prefetch and a 100 MB cache are practical, and otherwise adjust the defaults with a stated reason.
- [ ] **WP9.3b** **Invariant test for the demand principle** from section 1b, as its own test that cannot be skipped: across a space of 5,000 pages, list ten directories, run `ls -R` on one subtree, `stat` a hundred files, and issue a `PROPFIND` through the WebDAV adapter. Expectation: no body rows in the cache, no attachment blobs on disk, request counts growing with the number of **visited** directories rather than with space size, and no branch never entered loaded in the index.
- [ ] **WP9.4** Rate-limit behaviour: the fake returns 429 with `Retry-After`, and a test proves that concurrency is throttled and commands still succeed after the wait, without the user seeing an error, with only a note on stderr when the wait exceeds five seconds.
- [ ] **WP9.5** Run `bun run typecheck`, `bun run test` and `bun run build`, compare bundle size against the previous release, and manually verify the Homebrew formula and the compiled binary on macOS arm64 and Linux x64 with a single listing command.
- [ ] **WP9.6** Draft the release notes and run `bun scripts/release.ts minor --dry-run`. No automatic release.

### WP10 - After v1 (not part of this plan)

- [ ] A `bash` tool in the `chat` and `research` agent over `ConfluenceJustBashFs`, using either the Vercel `bash-tool` or a LangChain tool of our own.
- [ ] Re-enable defense-in-depth once just-bash issue #386 is fixed, then wrap the backend calls in `runTrustedAsync()`.
- [ ] An NFSv3 sidecar based on the Rust `nfsserve` crate as a faster mount for macOS and Linux, should the WebDAV measurements from WP7.7 fall short.
- [ ] A Jira namespace such as `/jira/<PROJECT>/<KEY>.md` over the same core.
- [ ] A watch mode where webhooks through `webhook-server.ts` invalidate the tree index and body cache instead of the TTL.

### Dependencies between the work packages

```
WP0 ──► WP1 ──► WP2 ──► WP3 ──► WP4 ──┐
                 │                     ├──► WP6 (sh) ──┐
                 └──► WP5 (write) ─────┤               ├──► WP8 ──► WP9
                                       └──► WP7 (mount)┘
```

WP6 and WP7 can start in parallel once WP2 and WP3 read correctly; WP5 is pulled into both adapters afterwards.

---

## 12. Self-critique and uncertainties

- **Bun compatibility of just-bash 3.x is the single largest risk.** A subagent reproduced the crash under Bun 1.3.11 and atlcli runs Bun 1.3.14. Setting `defenseInDepth: false` weakens security, but per the upstream threat model it only removes a secondary layer: atlcli runs agent scripts locally with user rights anyway, and the interpreter itself stays sandboxed with no network access and enforced limits. Even so, the spike comes first.
- **The 409 conflict** is not formally listed in the v2 OpenAPI spec, which names only 200, 400, 401 and 404, but it is documented by community reports and by our own `docs push` experience. The robust approach is our own version check before every update.
- **The rate-limit numbers** apply only to OAuth apps; no figures are published for API tokens. The concurrency ceiling near 8 is a conservative assumption drawn from the MCP server issue, not from Atlassian documentation.
- **WebDAV performance was not measured**, only inferred from sources such as Finder chattiness and the `slack-fuse` figures. WP7.7 must measure it.
- **ID-suffix paths** solve collisions and renames but make paths longer and less readable for humans, and they mean `docs pull` directories and VFS paths are not interchangeable. Accepted deliberately as decision 4.
- **Correction against the first draft of this plan:** WP2.3 used to load the complete space tree at depth ten on the first listing. That contradicts the demand principle and is now level-by-level loading. The price is that a `find` over a deep tree issues more individual requests than a single descendants pass would, and the level loader needs a per-node state marker. It is the right trade, because an agent typically enters few directories rather than the whole space.
- **The CQL shortcut stays the riskiest part of the design.** The guard from decision 12 is deliberately too strict, which means more full-text passes and therefore more budget aborts. A visible abort beats a silently empty result, but some users will have to raise the budget for legitimate searches.
- **Indexers are an underestimated risk in the mount.** A search index or an antivirus scanner walking the volume would trigger exactly what the demand principle prevents. Whether the Spotlight exclusions hold on a WebDAV volume is not yet verified (WP7.3b).
- Nothing in the space of "Confluence as a filesystem" exists as open source as of 2026-09-15. That is a market advantage, but it also means there are no proven solutions for the edge cases such as folders, whiteboards and inline comments.

---

## 13. Open questions

All twelve decision questions are settled and recorded in section 1a, with the demand principle in section 1b. What remains needs a measurement rather than a decision:

1. **The actual semantics of the CQL text search** against live content: where exactly does the boundary between match and non-match fall for word parts, underscores, hyphens and umlauts? The result of WP0.3b fixes the guard from decision 12 for good.
2. **Do the Spotlight exclusions hold on a WebDAV volume?** If not, the mount needs a different defence against indexer sweeps, such as a refusal mode for bulk access. The result comes from WP7.3b.
3. **Are the defaults sufficient**, meaning a 300 page prefetch and a 100 MB cache, for realistic agent sessions, or do they frustrate? The result comes from WP9.3.
4. **Do the two measurement gates hold** for startup time and artifact size, or does the embedded shell become an optional package? The result comes from WP0.4.

---

## 14. Sources

All sources retrieved on 2026-09-15. **[dated]** marks anything older than six months.

### just-bash and alternatives
- npm registry `just-bash` 3.4.2: https://registry.npmjs.org/just-bash
- Repository, commits through 2026-09-07: https://github.com/vercel-labs/just-bash/commits/main
- Readme 3.4.2 covering commands, `MountableFs`, limits and networking: https://raw.githubusercontent.com/vercel-labs/just-bash/main/packages/just-bash/README.md
- Changelog covering 3.0.0 on 2026-05-10, 3.2.0 hardening and 3.4.0 `ctx.origCommand`: https://raw.githubusercontent.com/vercel-labs/just-bash/main/packages/just-bash/CHANGELOG.md
- Issue #386, the Bun crash (2026-08-24, open): https://github.com/vercel-labs/just-bash/issues/386
- Issue #181, asynchronous `getAllPaths` (2026-04-06): https://github.com/vercel-labs/just-bash/issues/181
- Issue #185, a `searchFiles` hook for remote grep (2026-04-09): https://github.com/vercel-labs/just-bash/issues/185
- `bash-tool` by Vercel Labs: https://github.com/vercel-labs/bash-tool
- `@ai-sdk/sandbox-just-bash` 1.0.111 (2026-09-15): https://github.com/vercel/ai/releases/tag/%40ai-sdk%2Fsandbox-just-bash%401.0.111
- Vercel blog, "How to build agents with filesystems and bash" (2026-01-09) **[dated]**: https://vercel.com/blog/how-to-build-agents-with-filesystems-and-bash
- Vercel and Braintrust, "Testing if bash is all you need" (2026-01-22) **[dated]**: https://vercel.com/blog/testing-if-bash-is-all-you-need
- The Cloudflare fork controversy (2026-03): https://news.ycombinator.com/item?id=47392479
- just-bash-openfs (2026-02) **[dated]**: https://github.com/jeffchuber/just-bash-openfs
- Turso AgentFS with just-bash (2026-01-02) **[dated]**: https://turso.tech/blog/agentfs-just-bash
- Upstash Redis virtual filesystem (2026-04-20): https://upstash.com/blog/redis-virtual-fs
- Mintlify ChromaFs (2026-03-24): https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant
- Knock, "Files over tools" (2026-07-09): https://news.ycombinator.com/item?id=48845364
- ZenFS interface showing mandatory synchronous and asynchronous methods: https://raw.githubusercontent.com/zen-fs/core/main/src/internal/filesystem.ts
- `@anthropic-ai/sandbox-runtime`: https://github.com/anthropic-experimental/sandbox-runtime

### Mount technologies
- fuse-napi 2.3.1 (2026-08-05): https://github.com/mmdevries/fuse-napi
- Bun Node-API: https://bun.com/docs/runtime/node-api and Bun FFI, experimental: https://bun.com/docs/runtime/ffi
- macFUSE 5.3.3 and the FSKit backend: https://macfuse.github.io/ and https://github.com/macfuse/macfuse/wiki/FUSE-Backends
- The macFUSE license, commercial use only by permission **[dated]**: https://github.com/macfuse/macfuse/issues/616
- FUSE-T 1.2.7 and its non-commercial license: https://github.com/macos-fuse-t/fuse-t and https://raw.githubusercontent.com/macos-fuse-t/fuse-t/main/License.txt
- FSKit bugs on macOS 26.x **[dated, 2025-12]**: https://github.com/andrewgazelka/loaf/issues/1 and the rclone forum, 2026-03-31: https://forum.rclone.org/t/macos-rclone-mount-with-fuse-t-via-fskit/53608
- WinFsp releases and its GPLv3 with FLOSS exception: https://github.com/winfsp/winfsp/releases
- rclone `nfsmount` and `serve nfs`: https://rclone.org/commands/rclone_nfsmount/ and go-nfs: https://github.com/willscott/go-nfs
- Rust `nfsserve` 0.11.0 (2026-04-01): https://crates.io/api/v1/crates/nfsserve and `fuser` 0.18.0: https://crates.io/api/v1/crates/fuser
- `webdav-server` 2.6.3 (2026-08-04): https://registry.npmjs.org/webdav-server
- macOS Finder WebDAV quirks: https://sabre.io/dav/clients/finder/ and the Windows WebClient 50 MB limit: https://www.myworkdrive.com/blog/webdav-file-size-limit
- The mirage NFS backend (2026-08-22): https://github.com/strukto-ai/mirage/issues/888
- slack-fuse (2026): https://github.com/synap5e/slack-fuse and notionfs: https://github.com/can1357/notionfs

### Atlassian
- API token management and scoped tokens: https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/ and https://support.atlassian.com/confluence/kb/scoped-api-tokens-in-confluence-cloud/
- Basic auth for REST: https://developer.atlassian.com/cloud/confluence/basic-auth-for-rest-apis/
- The token migration requirement from 2026-01-01 **[dated, 2025-11]**: https://community.developer.atlassian.com/t/reminder-migrate-from-using-api-tokens-to-officially-supported-authentication-for-atlassian-apps-integrations/97221
- The Jira Product Discovery classic-token cutoff on 2026-10-31 (2026-04-29): https://community.atlassian.com/forums/Jira-Product-Discovery-articles/Deprecation-of-classic-API-token-access-for-Jira-Product/ba-p/3228037
- OAuth 2.0 (3LO): https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/ and its scopes: https://developer.atlassian.com/cloud/confluence/scopes-for-oauth-2-3LO-and-forge-apps/
- Rate limiting, the points model in force since 2026-03-02: https://developer.atlassian.com/cloud/confluence/rate-limiting/
- 429 responses from roughly 20 to 30 parallel calls with an API token (2026-05-29): https://github.com/atlassian/atlassian-mcp-server/issues/171
- v1 deprecation proceeding endpoint by endpoint (2026-04-01): https://community.atlassian.com/forums/Confluence-questions/Confluence-API-v1-Deperecation/qaq-p/3215038
- Changelog, the 50 result version limit since 2026-06-01: https://developer.atlassian.com/cloud/confluence/changelog/
- The space export API, open since 2016: https://jira.atlassian.com/browse/CONFCLOUD-40457
- Data Center personal access tokens: https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html
- Rovo MCP Server, v2 GA on 2026-09-08: https://github.com/atlassian/atlassian-mcp-server with its tools: https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/ and credits effective 2026-08-31: https://support.atlassian.com/rovo/docs/rovo-usage-limits/
- Teamwork Graph CLI GA (2026-06-30): https://community.atlassian.com/forums/Atlassian-AI-Rovo-articles/Teamwork-Graph-CLI-GA-connected-context-at-enterprise-scale/ba-p/3254146 and its FAQ: https://developer.atlassian.com/cloud/twg-cli/faq/

### Agent interface evidence
- Anthropic, "Code execution with MCP" (2025-11-04) **[dated]**: https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic, "Advanced tool use" (2025-11-24) **[dated]**: https://www.anthropic.com/engineering/advanced-tool-use
- The Agent Skills specification: https://agentskills.io/
- Cloudflare Code Mode MCP (2026-02-20) **[dated]**: https://blog.cloudflare.com/code-mode-mcp/
- Arize, "MCP vs CLI skills" (2026-05): https://arize.com/blog/mcp-vs-cli-skills-for-agents-what-our-eval-found-and-which-you-should-use/
- Arize, "Agent interfaces in 2026" (2026-01) **[dated]**: https://arize.com/blog/agent-interfaces-in-2026-filesystem-vs-api-vs-database-what-actually-works/
- OpenViking (2026-01) **[dated]**: https://github.com/volcengine/OpenViking

---

## Related documents
- `spec/mcp-over-code.md`, an MCP server that calls the CLI, the counterpart to the VFS approach
- `spec/local-storage-plan.md`, the frontmatter and `.atlcli/` layout the VFS adopts
- `spec/sqlite-sync-foundation.md`, the SQLite adapter that serves as the model for the body cache
- `spec/large-space-sync.md` and `spec/partial-sync.md`, on loading the tree of a large space
- `packages/confluence/src/hierarchy.ts`, the index pattern and the slug rules
