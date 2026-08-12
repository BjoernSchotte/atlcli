# AP-07 bounded Quick AI evidence

**Status:** COMPLETE

**Date:** 2026-08-12

**Implementation base:** `ad46da87`

## Delivered boundary

The extension action palette now executes a bounded direct Chat turn through
the existing browser Research host. The background composes the shared
`ChatAgentPortV1` turn adapter around the existing injected `runResearch`
function; provider credentials, Atlassian reads, durable workspace state,
permission checks, and worker control remain behind that trusted host. The
content script and iframe never receive a provider key, page body, workspace,
Research request, capability grant, or raw provider error.

The former side-panel-only browser principal and conversation-ID rules are now
shared utilities. The sidebar and palette use the same ordinary-Chat turn
adapter, including durable conversation identity, quality policy, HITL resume
semantics, presentation stream, and cooperative stop behavior. The background
change is limited to composing this adapter and reusing the existing offscreen
run/cancel functions; the Research runtime was not duplicated or broadly
refactored.

## Presenter and interaction proof

The Quick AI form displays the current Confluence/Jira context, a bounded
question field, and a required per-invocation disclosure checkbox. Search,
opening the form, and filling the question do not invoke the executor. Submit
is blocked until both question and disclosure are valid. The packed production
test proves the full MV3 frame/content/background path reaches the explicit
provider-unavailable result only after Submit.

Provisional answer Markdown is capped at 6,000 characters, ordered by stream
sequence, rendered as text, and exposed with `aria-live="off"`, so every token
is not announced. Escape/Close aborts only the presenter attachment and sends a
typed `detach` control. The separate Cancel button sends `abort`; the shared
Chat turn adapter propagates the abort to the existing offscreen cancel path,
while already persisted history remains durable.

A host-validated answer without citations/gaps is shown in the palette with a
**Continue in Research** affordance. Clarification/tool HITL, plan or scope
approval, a bounded-limit stop, citations, gaps, delegated execution, or long
output produces `open-surface` with an opaque, validated Research conversation
ID. The one-shot navigation mailbox carries that ID only to the Research
screen, acknowledges it, and does not overwrite the user's remembered
workspace.

The executor revalidates the sender/tab/document binding before work and again
before presenting a result. A navigation or replaced document therefore fails
as stale context. An abort signal is also checked around profile, credential,
offscreen-host, and response awaits so cancellation cannot be lost before the
worker starts.

## Automated proof

```bash
bun run test apps/extension/tests/action-palette-ai.test.tsx
bun run test apps/extension/tests/action-palette-background-host.test.ts \
  apps/extension/tests/chat-agent-port.test.ts packages/research/src/chat-agent
bun run test packages/action-registry/src/contracts.test.ts \
  apps/extension/tests/action-palette-protocol.test.ts \
  apps/extension/tests/action-palette-navigation.test.ts \
  packages/action-palette-react/src/ActionPalette.test.tsx \
  packages/action-palette-react/src/state.test.ts
bun run --cwd apps/extension build
bun run --cwd apps/extension test:palette-extension-browser:prebuilt
bun run check:extension-output
bun run check:browser
bun run typecheck
git diff --check
```

Final results:

- AP-07 Quick AI contract/presenter tests: **7 passing, 0 failing**;
- authoritative background host, including detach versus abort: **8 passing, 0 failing**;
- shared Chrome Chat adapter plus complete Chat-agent suite: **405 passing, 0 failing**;
- action contracts, protocol, navigation, presenter, and reducer regression
  matrix: **65 passing, 0 failing**;
- combined final AP-07 regression run: **485 passing, 0 failing**;
- production WXT packed Chromium suite: **7 passing, 0 failing**;
- extension output scan: CSP-safe and complete;
- browser boundary: all 34 checked entrypoints browser-clean;
- root, WXT extension, PDF compiler, and browser-export-harness typechecks:
  passed;
- whitespace/error-marker check: passed.

The first packed-browser attempt was stopped by the managed macOS process
sandbox before any test ran (`Crashpad ... Operation not permitted`). Repeating
the identical prebuilt command with approved browser-process permission passed
all seven cases. The final packed measurement was 141.8555 ms cold p95 and
11.1122 ms warm p95, with zero long tasks and zero search-time network
requests. Eager/lazy gzip totals were 6,758/81,851 bytes.

## Screenshot boundary

This AP-07 proof used controlled local Atlassian fixtures, not a live tenant.
No LIVE screenshot was therefore captured or committed. The AP-09 live-tenant
acceptance run must capture screenshots outside the repository and present
them as directly viewable and downloadable task artifacts.
