# Browser-Ready Core — Isomorphic `@atlcli/core` + Clients Implementation Plan

Status: **Draft — proposed**

Spec ID: `001-browser-ready-core`
Related specs: `spec/scroll-word-exporter-features.md` (existing `$scroll.*` placeholder catalog — input to Task 8), `spec/confluence-docx-export.md`, `spec/docx-export-typescript-analysis.md` (export background)
Related strategy: `~/code/rovo-skills/FAHRPLAN.md` Phase 0 · `~/code/rovo-skills/research/TYPST-EXPORT-ANGLE.md` §7.1–7.5 · `~/code/rovo-skills/research/AGENT-OVERLAY-ANGLE.md` §1.2
Origin: FAHRPLAN Phase 0 — "atlcli-Basis fit machen (Voraussetzung für jede Extension)"

---

## 1. Overview

Make the isomorphic kernel of atlcli — the markdown↔storage converter, `ConfluenceClient`, `JiraClient`, and the URL helpers — **provably and permanently buildable for the browser target**, as the prerequisite for the Chrome extension (Phase 1 export PoC) and every later stage (agent overlay, studio).

The empirical baseline (validated 2026-07-13 against the real codebase with `bun build --target=browser`):

- `packages/confluence/src/markdown.ts` builds **unchanged** for the browser (88 modules, 1.24 MB bundle, zero `node:`/`bun:` imports in the output).
- `packages/jira/src/analysis.ts` builds as well.
- Both **clients fail** — not because of their own code, but because `packages/core/src/index.ts` re-exports the whole package via `export * from …`, dragging the imperative shell (`config.ts` → `node:fs`/`node:os`, `keychain.ts` → `node:child_process`, `update.ts` → `node:stream`/`node:crypto`) into every bundle even though the clients never call it.

The clients actually import only: `Profile` (type), `getLogger`, `generateRequestId`, `redactSensitive`, `buildAuthHeader`, `buildTlsOptions`, `TlsOptions`, `getConfluenceBaseUrl`.

### What this spec must prove (the four backbones)

1. **Browser-safe core entry** — a bundler targeting the browser resolves `@atlcli/core` to an entry with zero Node dependencies, while the CLI keeps resolving the full barrel. No CLI import changes, no published-package breaking change.
2. **Injectable side effects** — the two places where browser and Node genuinely differ (token resolution, log sink) become injection points with Node defaults, instead of hard-wired Node code.
3. **Session auth mode** — clients can authenticate via the existing Atlassian browser session (`credentials: "include"`, no `Authorization` header), which is what makes the extension zero-config.
4. **CI-enforced isomorphism** — a pipeline gate rebuilds the four browser entrypoints on every push; a stray `node:` import anywhere in their transitive graph turns CI red.

### Goals

- `bun build --target=browser` succeeds for `markdown.ts`, both clients, and the core browser entry — with zero `node:`/`bun:` specifiers in the output, enforced by CI.
- CLI behavior is byte-for-byte unchanged: all existing tests green, no config-format change, no auth behavior change for existing profiles, no import rewrites in `apps/cli`.
- A profile with `auth.type: "session"` produces requests with no `Authorization` header and `credentials: "include"` on every call, including attachment up/downloads (unit-tested; E2E arrives with the extension in Phase 1).
- `extractEntityFromUrl` maps Confluence and Jira URLs (Cloud + Data Center variants) to typed entities via a versioned, data-driven pattern registry, with fixture coverage per pattern.
- A verified Scroll-placeholder → atlcli-data-model mapping table exists (prerequisite for Phase 1 Task 1.3).

### Non-goals (v1 — list is normative, do not scope-creep)

- **No `apps/extension` workspace**, no MV3 skeleton, no side panel, no offscreen document (Phase 1).
- No DOCX/PDF export and no templating-engine decision (`docx-templates` vs. docxtemplater is the Phase 1 spike).
- No DOM-fallback implementation for entity detection — only the URL-based extractor; the DOM hint is an interface slot, not code.
- No JSM/Service-Desk queue patterns in the registry (decided 2026-07-14: Confluence + Jira only; JSM arrives with the agent overlay, Phase 3).
- No OAuth flows for the browser; `session` is the only new auth mode.
- No hard split of the published package (`.` stays the full barrel for Node consumers — see §2.1 decision).
- No Mermaid rendering, no font handling, no `hierarchy.ts` browser work beyond what the clients pull in transitively.

---

## 2. Architecture decision

### 2.1 Exports strategy: conditional exports, not a hard split

**Decision (2026-07-14):** `packages/core/package.json` gains `exports` conditions — the `browser` condition resolves to a browser-safe entry, `default` keeps today's full barrel. Additionally, two explicit subpaths document the boundary and allow deliberate imports:

```jsonc
// packages/core/package.json
{
  "exports": {
    ".": {
      "browser": "./src/index.browser.ts",
      "default": "./src/index.ts"
    },
    "./browser": "./src/index.browser.ts",
    "./node": "./src/index.ts"
  }
}
```

`bun build --target=browser` honors the `browser` condition, so the clients build without changing a single import. The CLI and external consumers of the published `@atlcli/core@0.6.x` are untouched — this ships as a **minor** release.

**Rejected alternative:** hard split (`.` = browser-safe, Node code only via `@atlcli/core/node`). Cleaner, self-documenting boundary, but a breaking change (major bump) and a wide mechanical diff across `apps/cli`. Can still be adopted at a future 1.0; nothing in this design blocks it.

**Known trade-off:** the boundary is invisible at the import site. Importing `loadConfig` from `@atlcli/core` in browser-bound code fails only at bundle time ("export not found"), not in the IDE. The CI gate (§6) is the backstop.

### 2.2 Module assignment (normative)

| Module | Node imports today | Browser entry | Node entry |
|---|---|---|---|
| `types.ts` (new) | — | ✅ `Profile`, `AuthType`, `DeploymentType`, … | re-exported |
| `redact.ts` | — | ✅ | re-exported |
| `confluence-url.ts` | — (type-only import) | ✅ | re-exported |
| `entity-url.ts` (new, §5) | — | ✅ | re-exported |
| `logger.ts` → split | `node:fs`, `node:path`, `node:os`, `node:crypto` | ✅ core (levels, entry types, `generateRequestId`, sink interface, console sink) | + file/JSONL sink |
| `auth.ts` → split | `node:buffer`, keychain import | ✅ core (`buildAuthHeader(profile, resolveToken)`, base64 helper) | + `resolveToken` (env/keychain/config), back-compat wrapper |
| `tls.ts` → split | `node:fs` | ✅ type `TlsOptions` only | + `buildTlsOptions` (reads CA files) |
| `config.ts` | `node:fs`, `node:path`, `node:os` | ❌ (types extracted to `types.ts`) | ✅ |
| `keychain.ts` | `node:child_process` | ❌ | ✅ |
| `update.ts` | `node:fs`, `node:stream`, `node:crypto`, `node:os` | ❌ | ✅ |
| `prompt.ts` | `node:readline` | ❌ | ✅ |
| `flags.ts` | `node:fs`, `node:path`, `node:os` | ❌ | ✅ |
| `utils.ts` | `node:fs/promises`, `node:path` | ❌ | ✅ |
| `templates/` | (handlebars) | ❌ (not needed by clients) | ✅ |

`index.ts` (Node entry) re-exports everything the barrel exports today — **its public surface must not shrink**. `index.browser.ts` exports exactly the ✅ rows.

### 2.3 File layout after the split

```
packages/core/src/
  index.ts             # Node entry — today's full surface (unchanged exports)
  index.browser.ts     # NEW: browser-safe entry (§2.2 ✅ rows)
  types.ts             # NEW: Profile, AuthType, DeploymentType, … (pure types, zero imports)
  auth.ts              # buildAuthHeader(profile, resolveToken) + base64 helper (browser-safe)
  auth.node.ts         # NEW: resolveToken (env → keychain → config), buildAuthHeader(profile) wrapper
  logger.ts            # core: levels, entry types, generateRequestId, LogSink, console sink
  logger.node.ts       # NEW: JSONL file sink (today's behavior), getLogger default wiring
  tls.ts               # type TlsOptions (browser-safe)
  tls.node.ts          # NEW: buildTlsOptions (readFileSync for CA certs)
  entity-url.ts        # NEW: extractEntityFromUrl + pattern registry (§5)
  config.ts            # unchanged (re-exports types from types.ts for back-compat)
  …                    # keychain/update/prompt/flags/utils/templates unchanged
```

Exact file naming (`auth.node.ts` vs. moving code) may vary during implementation; the normative artifact is the **export assignment in §2.2**, not the file names.

### 2.4 Error model

- Browser-safe code never throws "keychain"/"config file" flavored errors; `buildAuthHeader` reports "no token resolved for profile" and names the injected resolver as the source.
- CLI encountering `auth.type: "session"` fails fast with a clear message: `auth type "session" is only supported in browser contexts (Chrome extension)` — deliberate error, not a silent fallback.
- `extractEntityFromUrl` returns `null` for non-matching URLs; it never throws on malformed input (wrap `new URL` in try/catch, mirroring `isConfluencePageUrl`).

---

## 3. Auth decoupling and session mode (normative)

### 3.1 `buildAuthHeader` core (browser-safe)

```ts
export type TokenResolver = (profile: Profile) => string | null;

export function buildAuthHeader(profile: Profile, resolveToken: TokenResolver): string;
```

- Base64 via a small helper on top of `btoa` that survives non-ASCII input (`btoa` alone throws on code points > 0xFF): encode with `TextEncoder`, then `btoa(String.fromCharCode(...bytes))` or chunked equivalent. Unit test with an umlaut e-mail (`björn@example.de`) asserts byte-equality with `Buffer.from(s).toString("base64")`.
- Behavior otherwise identical to today: `bearer` → `Bearer <token>`, `apiToken` → `Basic base64(email:token)`, missing email → same error message as today.

### 3.2 Node wrapper (back-compat)

The Node entry keeps today's one-argument signature — `buildAuthHeader(profile)` — implemented as core + the keychain-backed `resolveToken` (env `ATLCLI_API_TOKEN` → Mac Keychain → config file, priority unchanged). No CLI call site changes.

### 3.3 `session` auth mode

- `AuthType` gains `"session"` (currently `"apiToken" | "bearer" | "oauth"`, `config.ts:6`).
- `ConfluenceClient` + `JiraClient`: when `profile.auth.type === "session"`, set **no** `Authorization` header and pass `credentials: "include"` on every `fetch` — including attachment upload (multipart) and download paths. `buildAuthHeader` is never invoked for session profiles (guard in the client, not an exception path).
- `resolveDeploymentType` (`confluence-url.ts`) must not mis-bucket session profiles: session profiles are expected to carry an explicit `deploymentType`; absent that, the existing Cloud default applies (a DC browser session is conceivable — explicitness over heuristics).
- Every `auth.type` switch in the codebase compiles exhaustively after the union grows (typecheck is the regression net).

---

## 4. Logger split (normative)

- Interface `LogSink { write(entry: LogEntry): void | Promise<void> }`.
- Core (browser entry): level logic, entry types, redaction wiring, `generateRequestId` switched from `node:crypto` to `globalThis.crypto.randomUUID()` (available in Bun, Node ≥ 19, all browsers) — drops the last Node import from the logger core.
- Node entry: today's JSONL file sink (`~/.atlcli/logs/` + project `.atlcli/logs/`), wired as the default so `getLogger()` behaves exactly as before in the CLI.
- Browser default (decided 2026-07-14): **console sink at level ≥ warn** — extension problems stay visible in DevTools without log spam; callers can inject a different sink.

---

## 5. URL→entity extractor (normative)

### 5.1 API

```ts
export type AtlassianEntity =
  | { product: "confluence"; type: "page";     pageId: string; spaceKey?: string }
  | { product: "confluence"; type: "blogpost"; contentId: string; spaceKey?: string }
  | { product: "confluence"; type: "space";    spaceKey: string }
  | { product: "jira";       type: "issue";    issueKey: string; projectKey: string }
  | { product: "jira";       type: "board";    projectKey: string; boardId: string };

export interface PatternRegistry { version: number; patterns: EntityPattern[]; }

export function extractEntityFromUrl(url: string, registry?: PatternRegistry): AtlassianEntity | null;
```

- Registry is **data, not code** (`{ version: 1, patterns: [...] }`) with a default export in core. The extension can later inject an updated registry (remote config) without a code release. First matching pattern wins; patterns are ordered most-specific-first.
- `isConfluencePageUrl` stays public but is reimplemented on top of the extractor (`extract(...) !== null && product === "confluence"` scoped to the profile's base URL).
- The extractor is DOM-free by design. Callers (Phase 1 extension) may supply an `entityHint` from DOM fallbacks (`meta[name=ajs-page-id]` on DC); merging that hint is caller logic, not core.

### 5.2 Registry v1 (normative pattern set)

| Product | URL pattern (Cloud) | Extracted |
|---|---|---|
| Confluence page | `/wiki/spaces/{spaceKey}/pages/{pageId}/{slug?}` | `spaceKey`, `pageId` |
| Confluence page (legacy) | `/wiki/display/{spaceKey}/{title}` · `?pageId={id}` | `spaceKey` resp. `pageId` |
| Confluence page (DC) | `/display/{spaceKey}/{title}` · `/pages/viewpage.action?pageId={id}` (with optional context path) | `spaceKey` resp. `pageId` |
| Confluence blogpost | `/wiki/spaces/{spaceKey}/blog/{yyyy}/{mm}/{dd}/{contentId}/…` | `spaceKey`, `contentId` |
| Confluence space | `/wiki/spaces/{spaceKey}` (overview) | `spaceKey` |
| Jira issue | `/browse/{ISSUE-KEY}` · `…?selectedIssue={KEY}` | `issueKey`, `projectKey` (prefix before `-`) |
| Jira board/backlog | `/jira/software/(c/)?projects/{projectKey}/boards/{boardId}` | `projectKey`, `boardId` |

Data Center variants must respect context paths (the `resolveDeploymentType`/`getConfluenceBaseUrl` logic from #14/#24 stays the source of truth for base-path handling).

---

## 6. Browser-build CI gate (normative)

- Script `scripts/check-browser-build.ts` runs `bun build --target=browser` for four entrypoints:
  1. `packages/confluence/src/markdown.ts`
  2. `packages/confluence/src/client.ts`
  3. `packages/jira/src/client.ts`
  4. `packages/core/src/index.browser.ts`
- Assertions per entrypoint: exit code 0 **and** the bundled output contains no `node:`/`bun:` specifiers (belt and suspenders — Bun sometimes externalizes `node:` imports in browser builds instead of failing).
- Wiring: root `package.json` script `check:browser`, Turbo task, and a step in `.github/workflows/ci.yml` alongside typecheck/tests.
- Failure output names the entrypoint and the offending specifier(s), so the diff author sees *what* leaked, not just a red build.

---

## 7. Scroll placeholder mapping (deliverable, no code)

`spec/scroll-word-exporter-features.md` already catalogs the `$scroll.*` placeholders (page info, metadata, header/footer, TOC) — the raw survey exists but is **not yet verified against the current K15t docs** (research flag, TYPST §7.5 step 0).

Deliverable: `specs/001-browser-ready-core/scroll-placeholder-mapping.md` —

1. Catalog verified against [help.k15t.com/scroll-word-exporter](https://help.k15t.com/scroll-word-exporter): completeness (title/metadata placeholders, content insertion point, header/footer variables, TOC markers), deviations and new placeholders recorded.
2. Compatibility table `Scroll placeholder → atlcli data-model field` (e.g. `$scroll.title` → `ConfluencePageDetails.title`, `$scroll.pageid` → `.id`), each row with a status: `direct` / `derivable` / `unsupported (v1)` / `never`.
3. Data-model gaps called out explicitly (they become Phase 1 inputs).

This is the implementation template for Phase 1 Task 1.3 (DOCX export) and is a hard prerequisite for it.

---

## 8. Task breakdown (ordered; each independently completable and verifiable)

> Every acceptance criterion below is objectively checkable by running a command or a test. "AC" = acceptance criteria. Commit after each task once its AC pass (per CLAUDE.md: commit regularly; never push without explicit request).

### Task 1 — Type extraction + browser entry skeleton

Extract pure types, create `index.browser.ts` with the trivially safe modules, add the `exports` conditions.

- [ ] `src/types.ts` exists with `Profile`, `AuthType`, `DeploymentType` (and their satellite types), zero imports; `config.ts` re-exports them (back-compat)
- [ ] `index.browser.ts` exports `types`, `redact`, `confluence-url`
- [ ] `package.json` `exports` block matches §2.1; `bun run typecheck` and `bun test` green repo-wide
- [ ] `bun build --target=browser packages/core/src/index.browser.ts` succeeds with zero `node:` specifiers in output
- [ ] `bun run --cwd apps/cli src/index.ts --help` works unchanged (manual check)

### Task 2 — Logger split

- [ ] `LogSink` interface exists; Node JSONL sink reproduces today's behavior (existing `logger.test.ts` green without modification, or with import-path-only edits)
- [ ] `generateRequestId` uses `globalThis.crypto.randomUUID()`; uniqueness test stays green
- [ ] Browser entry exports logger core + console sink (level ≥ warn default); sink injection unit-tested (fake sink captures entries)
- [ ] Logger core module has zero `node:` imports (asserted by the Task 1 build check now including it)

### Task 3 — `buildAuthHeader` decoupling

- [ ] Core `buildAuthHeader(profile, resolveToken)` in browser entry; base64 helper handles non-ASCII (umlaut fixture byte-equal to `Buffer` result)
- [ ] Node wrapper keeps the one-arg signature; header-equivalence regression tests old vs. new for `bearer` + `apiToken`, error cases (no token, no email) produce today's messages
- [ ] `resolveToken` priority (env → keychain → config) unchanged and unit-tested in the Node entry
- [ ] No call-site changes in `apps/cli`, `packages/confluence`, `packages/jira` (clients still import `buildAuthHeader` from `@atlcli/core` — Node resolution gives them the wrapper)

### Task 4 — TLS split + client injection seam

- [ ] Type `TlsOptions` in browser entry; `buildTlsOptions` (file I/O) only in Node entry
- [ ] Clients tolerate absent TLS options (no `tls` field on fetch when `undefined`) — existing behavior, now covered by a test
- [ ] Both clients build for the browser target: `bun build --target=browser packages/confluence/src/client.ts packages/jira/src/client.ts` → exit 0, zero `node:` specifiers

### Task 5 — `session` auth mode

- [ ] `AuthType` includes `"session"`; typecheck green (all switches exhaustive)
- [ ] Mock-fetch unit tests per client: session profile → no `Authorization` header, `credentials: "include"` set — on page CRUD, search, and attachment up/download paths
- [ ] Non-session profiles: `credentials` untouched, `Authorization` present (regression)
- [ ] CLI with a session profile exits with the §2.4 error message (test at the command-handler level)
- [ ] Session profiles without explicit `deploymentType` resolve to Cloud (`resolveDeploymentType` test)

### Task 6 — CI gate

- [ ] `scripts/check-browser-build.ts` implements §6 (four entrypoints, exit-code + specifier scan, named failure output)
- [ ] `bun run check:browser` green locally; wired into Turbo + `.github/workflows/ci.yml`
- [ ] Negative proof: temporarily adding `import "node:fs"` to a client makes `check:browser` fail naming the entrypoint and specifier (documented in the script's test or a fixture test)

### Task 7 — URL→entity extractor

- [ ] `entity-url.ts` implements §5.1 API with the §5.2 registry as versioned data; exported from both entries
- [ ] Fixture table: ≥ 1 positive and ≥ 1 negative fixture per registry row, plus Cloud/DC context-path variants, query-param forms (`?pageId=`, `?selectedIssue=`), and non-entity URLs on `atlassian.net` (marketing pages) → `null`
- [ ] Malformed input (`not a url`, empty string) → `null`, never throws
- [ ] `isConfluencePageUrl` reimplemented on the extractor; its existing tests stay green unchanged
- [ ] Registry injection works: a test passes a modified registry and observes different extraction

### Task 8 — Scroll placeholder mapping (parallel, no code)

- [ ] `scroll-placeholder-mapping.md` exists per §7: every placeholder from the verified catalog has a mapping row with status
- [ ] Deviations from `spec/scroll-word-exporter-features.md` (new/renamed/removed placeholders in current K15t docs) explicitly listed
- [ ] atlcli data-model gaps enumerated as Phase 1 inputs

---

## 9. Test plan

**Layer A — unit (pure, no I/O):** base64 helper (ASCII/non-ASCII/empty), `buildAuthHeader` core matrix (bearer/apiToken × token-present/absent × email-present/absent), logger sink injection + level filtering, `extractEntityFromUrl` fixture table, `resolveDeploymentType` with session profiles.

**Layer B — integration (mock fetch, tmp dirs):** client auth-header/credentials behavior per auth type incl. attachment paths; Node logger JSONL sink writes; CLI session-profile error path.

**Layer C — build-level:** `check:browser` as executable proof of isomorphism (positive: four entrypoints; negative: seeded `node:` import fails with named output). Runs in CI on every push.

**Regression guarantees:** existing core/confluence/jira test suites pass without behavioral edits; `bun run typecheck` green; per CLAUDE.md every bug found during implementation gets a pinning test.

E2E against a live instance (profile `mayflower`, space `DOCSY`) is **not** extended in this spec — nothing user-visible changes in the CLI; the session mode's real E2E arrives with the Phase 1 extension.

---

## 10. Definition of done

- Tasks 1–8 acceptance criteria all checked.
- `bun test`, `bun run typecheck`, `bun run build` green at repo root; `bun run check:browser` green and enforced in CI.
- The four browser entrypoints bundle with zero `node:`/`bun:` specifiers.
- CLI surface of `@atlcli/core` unchanged (Node entry exports superset check — no removed exports vs. `main`).
- Ships as a minor release of `@atlcli/core` (no breaking change).
- `scroll-placeholder-mapping.md` committed and complete per §7.

---

## 11. Risks and open questions

1. **Invisible boundary of conditional exports.** Importing Node-only symbols in browser-bound code fails at bundle time, not in the IDE. Accepted for v1 (CI gate is the backstop); a hard split remains available at 1.0 if this bites in practice.
2. **`btoa` non-ASCII pitfall.** Naïve `btoa(email:token)` breaks for umlaut e-mails — the exact case the German user base will hit. Mitigated by the TextEncoder-based helper and a byte-equality test against `Buffer` (Task 3 AC).
3. **Bun externalizing instead of failing.** `bun build --target=browser` may externalize `node:` imports rather than erroring, producing a "successful" but broken bundle. That is why §6 mandates the output-specifier scan, not just the exit code.
4. **Atlassian URL schema drift.** URL formats change (`/wiki` prefix, `/jira/software/c/` variants, legacy `/display/`). Mitigated structurally: the registry is versioned data, injectable at runtime by the extension without a core release; fixtures pin every supported form.
5. **Session mode is unit-proven only in Phase 0.** Real cookie behavior (SameSite, cross-origin from an extension context) can only be validated with `host_permissions` in the actual MV3 extension — explicitly deferred to Phase 1; risk flagged so nobody mistakes the unit tests for an end-to-end proof.
6. **DC session profiles.** A Data Center browser session with context path is conceivable but untested; §3.3 requires explicit `deploymentType` on session profiles, defaulting to Cloud. Revisit when a DC extension user materializes.
7. **Published-package consumers.** Conditional exports change module resolution for bundler users of `@atlcli/core@0.6.x`. Low risk (browser condition only adds a resolution path; `default` is unchanged), but release notes should mention it.

### Decisions log

- **F1 — exports strategy** ✅ (2026-07-14): conditional exports (Option A, non-breaking); hard split deferred as a possible 1.0 tightening.
- **F2 — browser logger default** ✅ (2026-07-14): console sink, level ≥ warn.
- **F3 — registry scope** ✅ (2026-07-14): Confluence + Jira; JSM queues deferred to Phase 3 (agent overlay).
