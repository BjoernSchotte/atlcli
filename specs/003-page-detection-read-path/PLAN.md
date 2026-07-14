# Page Detection + Read Path — Tab URL → Entity → Session-Auth REST → Converter

Status: **Planned**

Spec ID: `003-page-detection-read-path`
Depends on: `001-browser-ready-core` (entity extractor, session auth mode, browser entry — implemented), `002-extension-workspace`
Blocks: `004-docx-export`, `005-pdf-export`
Related strategy: FAHRPLAN Phase 1 Task 1.2 · `TYPST-EXPORT-ANGLE.md` §7.2 (session auth), §7.5 Schritt 2–3 · `AGENT-OVERLAY-ANGLE.md` §1 (URL registry as primary source, DOM only as fallback)
Origin: FAHRPLAN Phase 1 — "Seitenerkennung + Read-Pfad"

---

## 1. Overview

Wire the first real data flow through the extension: the active tab's URL is mapped to a
Confluence entity via `extractEntityFromUrl` (001), the page is loaded through
`ConfluenceClient` with the `session` auth mode (001) riding the user's Atlassian browser
session, and the storage body runs through the existing markdown converter. The side panel
shows what was detected and proves the content arrived intact.

This is where the **central architectural bet of the whole extension gets its end-to-end
proof**: 001's risk log explicitly flagged that session-cookie behavior (SameSite,
cross-origin from extension contexts) can only be validated inside a real MV3 extension
with `host_permissions`. This spec closes that flag — or surfaces the problem while the
codebase is still small.

### Goals

- Active-tab watching: panel updates automatically on tab switch / SPA navigation within
  Confluence (URL changes without full reloads).
- URL → entity via 001's registry; Confluence pages and blogposts are actionable; Jira
  entities and non-Atlassian tabs render an informative "nothing to export here" state.
- Read path: `getPageDetails` + storage body via session auth (`credentials: "include"`,
  no `Authorization` header), base URL derived from the tab's origin — **zero
  configuration**, no profile setup.
- Converter integration: storage → markdown runs in the extension (proves the 001
  browser-build claim on real data); panel shows title, space key, version, word count and
  a converted-content preview (debug view).
- Attachment metadata listing for the detected page (needed by 004 for image embedding) —
  metadata only, no blob downloads yet.
- Clean error taxonomy: not logged in (401/redirect), no permission (403/404), network
  failure — each with a distinct, user-readable panel state.

### Non-goals

- No export of any kind (004/005). No template handling.
- No DOM-based entity fallback implementation (`meta[name=ajs-page-id]`) — Cloud URLs
  cover the PoC; the hook stays an interface slot as designed in 001. Revisit for DC.
- No page-tree traversal, no space browsing (Phase 2).
- No caching/offline behavior beyond in-memory state per panel session.
- No Jira read path — detection recognizes Jira entities but only displays them.

---

## 2. Architecture

### 2.1 Where things run

- **Side panel** owns UI state and initiates loads. REST calls run **in the panel context**
  (extension pages share the extension's host permissions; no reason to proxy through the
  service worker for plain fetches — keeps the data path simple and debuggable).
- **Service worker** owns tab observation (`chrome.tabs.onActivated`,
  `chrome.tabs.onUpdated` for URL changes) and pushes `entity-changed` messages to the
  panel. Rationale: the panel may not receive tab events reliably itself; the SW is the
  canonical observer.
- **Profile synthesis:** session mode needs no stored config. From the tab URL we build an
  in-memory `Profile` (`auth: { type: "session" }`, `baseUrl` = tab origin,
  `deploymentType: "cloud"` explicit per 001 §3.3). A `profileFromTabUrl(url)` helper in
  the extension (not core) owns this.

### 2.2 Data flow

```
chrome.tabs event ──▶ background.ts ──entity-changed──▶ side panel
                                                          │
                              extractEntityFromUrl(url)   │  (also run in panel for
                                                          ▼   initial mount)
                                    entity? ──no──▶ "nothing to export" state
                                       │yes (confluence page/blogpost)
                                       ▼
                        ConfluenceClient(profileFromTabUrl(url))
                          getPageDetails(pageId)  +  storage body
                          listAttachments(pageId)          [metadata]
                                       ▼
                          storageToMarkdown(body)          [existing converter]
                                       ▼
                    panel state: { entity, details, markdown, attachments }
```

### 2.3 Error model (normative)

| Condition | Detection | Panel state |
|---|---|---|
| Not logged in to this Atlassian site | 401, or 3xx to `id.atlassian.com` (fetch `redirect: "manual"` or final-URL check) | "Please log in to <site> in this tab, then retry" + retry button |
| No permission / page gone | 403 / 404 | "You don't have access to this page (or it was deleted)" |
| Non-Confluence entity (Jira, marketing page) | extractor result | Informational, shows what *was* detected |
| Network/CORS failure | fetch rejection | Generic failure + retry; error detail collapsed |

Login detection must be explicit: Atlassian answers unauthenticated API calls on some
routes with a 200 HTML login page — the client must treat non-JSON responses as
auth failures, not parse errors (regression test with an HTML-body mock).

### 2.4 Panel UI states

`idle` (no Atlassian tab) → `detected` (entity known, loading) → `loaded` (metadata +
preview) / `error(kind)`. State machine as pure function (state, event) → state, unit
tested; rendering is the thin shell.

---

## 3. Task breakdown

### Task 1 — Tab observation + entity detection

- [x] `background.ts` observes `tabs.onActivated` + `tabs.onUpdated` (URL changes only) and sends `entity-changed { detection: { url, entity } }` using `extractEntityFromUrl` <!-- background.ts feeds active-tab URLs through the pure `observeTab` core; onUpdated is gated on `changeInfo.url && tab.active`; live SW behavior is Task 5 -->
- [x] Panel requests current tab entity on mount (`get-current-entity` message) — no race with SW push <!-- panel sends get-current-entity on mount (App.tsx, Task 4); SW answers via router `getCurrentEntity` (queries active tab). SW push + pull both feed the same reducer so a late push can't be lost -->
- [x] Unit tests: the observation → message logic as pure function over synthetic tab events (mock `chrome.tabs`); duplicate-URL events are de-duplicated (no message storm on SPA-heavy Confluence) <!-- tab-observer.test.ts: dedup of repeated URLs, re-emit on change, no-op on empty URL -->
- [x] Non-entity URLs and Jira entities produce the correct panel states (state-machine unit tests) <!-- panel-state.test.ts: detected(non-exportable) for Jira, idle for null entity -->


### Task 2 — Session-auth read path

- [x] `profileFromTabUrl` builds a session Profile from the tab origin (unit tests incl. non-atlassian origins → null) <!-- utils/profile.ts; profile.test.ts covers cloud host / origin-only / non-atlassian null / malformed null / look-alike null -->
- [x] Panel loads `getPageDetails` + storage body via `ConfluenceClient` session mode; mock-fetch integration tests assert `credentials: "include"` and absent `Authorization` (regression net on top of 001's client tests, now from extension call sites) <!-- loadConfluencePage (utils/read-path.ts) via the real client; read-path.test.ts asserts credentials:include + no Authorization on BOTH the getPageDetails and listAttachments fetches. Panel wiring in Task 4 -->
- [x] HTML-login-page response is classified as `not-logged-in`, not a JSON parse error (pinning test with HTML mock body) <!-- the client's JSON.parse fallback yields a details object with no id; the wrapper maps that to not-logged-in (kept out of ConfluenceClient to preserve CLI empty-body handling — PLAN pitfall). read-path.test.ts pins the 200-HTML case -->
- [x] 401/403/404/network map to §2.3 states (tests per class) <!-- classifyThrownError pure + integration tests per class -->


### Task 3 — Converter + attachments

- [x] Storage body runs through the existing storage→markdown converter inside the panel bundle; result stored in panel state <!-- read-path.ts imports storageToMarkdown via @atlcli/confluence/browser; LoadedPage.markdown holds the result -->
- [x] `listAttachments(pageId)` fetches attachment metadata (name, mediaType, size, download link) — displayed as a count + expandable list <!-- toAttachmentMeta maps to {name,mediaType,size,link}; panel renders count + collapsible list (Task 4). Listing is best-effort (failure → empty list, page still loads) -->
- [x] Word count computed from the markdown (needed for the 006 `< 10 s / ~2,000 words` benchmark) <!-- countWords over the converted markdown; LoadedPage.wordCount -->
- [x] Unit test: a representative storage fixture (headings, callout macro, table, image ref, code block) converts and the panel state contains non-empty markdown with expected landmarks <!-- converter-fixture.test.ts asserts heading/callout/table/image/code-fence landmarks + wordCount + attachment metadata via the real converter -->


### Task 4 — Panel UI for detection/read

- [x] States per §2.4 rendered: idle / detected / loaded / four error kinds — each visually distinct, narrow-layout friendly <!-- App.tsx renders idle, unsupported (detected-not-exportable), loading, loaded, and error with 4 kinds (not-logged-in/access-denied/network/unknown) each with distinct copy + colour; max-width 400 narrow-first. Live render is Task 5 -->
- [x] `loaded` shows: title, space key, version, last-modified + author, word count, attachment count, collapsible markdown preview (debug) <!-- LoadedView: title, Space, Version, Modified · author, Words, Attachments count + collapsible attachment list, collapsible <details> markdown <pre> preview -->
- [x] Retry button re-runs the load without tab switch <!-- error state Retry + loaded state Reload both dispatch {type:"retry"} → reduce re-enters loading with a bumped token; the load effect refires -->
- [x] State machine pure-function tests cover every transition incl. tab-switch-during-load (stale responses discarded — correlation token) <!-- panel-state.test.ts: 18 cases incl. stale load-succeeded/failed discard on tab switch, retry-token supersession, dedup -->


### Task 5 — Manual E2E **[E2E: user]**

Joint session against the real instance (profile context: Björn's browser logged in to
`mayflower.atlassian.net`, space `DOCSY`):

- [ ] Open a DOCSY page → panel auto-detects and loads: correct title/space/version shown
- [ ] Tab-switch between two Confluence pages → panel follows without manual action
- [ ] Confluence SPA navigation (click a page-tree link, no full reload) → panel follows
- [ ] Jira tab (`ATLCLI` project) → "detected, not exportable" state
- [ ] Non-Atlassian tab → idle state
- [ ] Logged-out check: in a private window profile w/o session (or after logout), panel shows the not-logged-in state — **this is the SameSite/cookie proof, the most important single check of this spec**
- [ ] DevTools network log during a load: requests go only to `*.atlassian.net`
- [ ] A page with restricted permissions → access-denied state (use/create a restricted test page; clean up after per CLAUDE.md)

---

## 4. Test plan

- **Unit:** entity/state machine, `profileFromTabUrl`, tab-event dedup, converter fixture.
- **Integration (mock fetch):** session header/credentials assertions from extension call sites, error taxonomy incl. HTML-login-page pinning test.
- **Manual E2E (Task 5):** the cookie/SameSite proof, SPA-follow, permission and logout paths — jointly with Björn; results recorded as checked ACs (screenshots into the spec dir if deviations found).
- Regression: `bun test`, `typecheck`, `check:browser` stay green (extension entrypoints already gated by 002).

## 5. Definition of done

- Tasks 1–5 checked; E2E session held and the session-auth proof documented (risk #5 of 001 formally closed — note the result in this file's status line).
- Zero-config claim holds: no token, no options page, no profile setup touched during E2E.
- Error states all reachable and human-readable.

## 6. Risks and open questions

1. **Cookie behavior is the make-or-break.** If Atlassian's SameSite/session handling blocks extension-context fetches despite `host_permissions`, the fallback ladder is: (a) run fetches in a content script injected into the tab (page origin), (b) `chrome.cookies` + explicit header — both are architecture changes. Test 5's logged-in check runs **first** in the E2E session; escalate immediately if it fails.
2. **v1 vs v2 REST availability for anonymous-ish session calls.** Some v2 endpoints behave differently under cookie auth; if `getPageDetails` misbehaves, pin which API version the read path uses and test both storage-body routes.
3. **SPA URL observation gaps.** Confluence uses history API navigation; `tabs.onUpdated` fires for URL changes but throttling/ordering quirks exist. The dedup + correlation-token design absorbs this; keep an eye on it in E2E.
4. **Guest/anonymous Confluence sites** answer 200 without login — the panel would show content for an anonymous session. Acceptable (matches what the user sees in the tab).

### Decisions log

- **F1 — fetch locus**: ✅ proposed panel-context fetch (no SW proxy); revisit only if E2E cookie proof fails (risk #1 ladder).
