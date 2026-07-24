# Emoji export parity

Status: active delivery plan

Planned at: `5876348343c5805c3424eea5d516a8c937b4f6f5`
(`feat(confluence): add ADF-primary export pipeline (#86)`).

This folder separates two related but independently reviewable outcomes:

- [P0 — Typed emoji projection](./P0-TYPED-EMOJI-PROJECTION.md) fixes known
  Confluence emoji short names leaking into DOCX/PDF as literal `:name:` text.
- [P1 — Semantic callout icons](./P1-SEMANTIC-CALLOUT-ICONS.md) adds
  target-neutral default icons to ordinary Confluence callouts.

P0 is the active implementation scope. P1 is deliberately a follow-up because
it changes the visual appearance of every standard callout and therefore owns a
separate rendered-golden review.

## Delivery rules

- Each top-level checkbox in either plan is one commit boundary.
- A task is checked only after its listed verification commands pass.
- The checked task and its evidence are committed together with the
  implementation.
- The user explicitly authorized this delivery run to create a draft pull
  request and push every proved, checked-task commit to it. That authorization
  is scoped to `codex/emoji-export-parity`; it is not a standing repository
  policy.
- Before every commit, including the initial plan-only commit, run the
  task-appropriate live `mayflower`/`DOCSY` E2E described in the P0 plan and
  clean up every created resource. A unit-, browser-, or golden-only result is
  not enough to check a task.
- Raw text such as `:warning:` must never be reinterpreted. Resolution is
  allowed only when typed ADF/Storage/custom-panel metadata proves emoji
  semantics.
- Unknown or site-custom emoji remain visible and diagnosed until Atlassian
  exposes a documented, authorized portable asset contract.

## Execution order

```text
P0.1 contract and catalog
  -> P0.2 ADF/Storage projection
    -> P0.3 custom-panel projection
      -> P0.4 browser/render proof
        -> P0.5 docs and aggregate gates

P1 starts only after P0 is complete and reviewed.
```

## Plan verification

Verified on 2026-07-24 before the plan commit:

- independent cold reviews traced the plan against ADF/Storage, PDF, and DOCX;
  the second pass returned P0.1 `GO`, while P1 remains intentionally blocked
  on its P1.1 accessibility proof;
- `bun run typecheck` and `bun run build` passed from the pinned baseline;
- read-only production-path exports of DOCSY fixture page `1126236245`
  completed for TypeScript DOCX and PDF with validated artifacts, zero warnings,
  and zero errors;
- no Confluence resource was created by the plan-only smoke test, so no remote
  cleanup was required.
