# Plan 003: Add target editability budgets and large-page guidance

Status: **Planned**

Planned at: `18f6f1e`, 2026-07-20

Priority: **P1** · Effort: **M** · Risk: **MEDIUM**

Depends on: completed `specs/import-docx-mvp/PLAN.md`

Unblocks: Plans `009` and `010`

> **Executor instructions:** Treat this as an evidence-calibrated guardrail, not a promise that a numeric score predicts every Confluence editor. Record benchmark inputs, encoded sizes, target responses, browser observations where available, thresholds, overrides, and cleanup in `specs/003-import-docx/EVIDENCE.md`.

---

## 1. Outcome and JTBD

Before publication, AtlCLI estimates whether the resulting ADF/Storage page is likely to be practically editable, distinguishes hard API/resource limits from soft UX risk, and gives an actionable recommendation. The same metrics later choose safe page-tree and batch boundaries.

JTBD: **finish a migration with editable native Confluence content, rather than successfully creating a page that freezes, times out, or requires immediate manual splitting**.

Research basis:

- A 350-page Word import reportedly succeeded but froze during editing: https://community.atlassian.com/forums/Confluence-questions/Importing-large-Word-document-behaviour/qaq-p/2940361
- A 25 MB document reportedly caused 10–20 minute imports and unresponsive pages across several machines: https://community.atlassian.com/forums/Confluence-questions/Confluence-Page-becomes-unresponsive-when-importing-a-large-file/qaq-p/2859190
- Data Center documents a configurable 20 MB uncompressed Word-import limit; this is native-UI evidence, not automatically a REST limit: https://confluence.atlassian.com/doc/import-a-word-document-into-confluence-170493136.html
- Cloud documents separate single/bulk limits: https://support.atlassian.com/confluence-cloud/docs/import-content-into-confluence-cloud/

---

## 2. Scope and non-goals

In scope:

- deterministic metrics over normalized IR and final target body;
- separate hard publication budgets and evidence-based editability warnings;
- target/edition-specific policy snapshots included in capabilities and plan digest;
- terminal/HTML/JSON explanation and mitigation;
- benchmark corpus for large text, deep lists, wide/large/nested tables, many media nodes, comments, and macro intents;
- Plan 009 integration seam for recommending or selecting heading splits;
- Cloud live/API proof and DC deterministic contract proof.

Out of scope:

- machine-learning or telemetry-trained scoring;
- claiming a soft threshold is an Atlassian-supported limit;
- silently truncating content;
- automatically splitting pages before Plan 009 exists;
- stress-testing production tenants beyond safe, approved bounded fixtures.

---

## 3. Architecture

```ts
export interface TargetEditabilityMetricsV1 {
  schema: "atlcli.docx-editability-metrics/1";
  visibleCharacters: number;
  blockCount: number;
  inlineNodeCount: number;
  maximumDepth: number;
  headingCount: number;
  listItemCount: number;
  tableCount: number;
  tableCellCount: number;
  maximumTableCells: number;
  nestedTableCount: number;
  mediaCount: number;
  contentAttachmentBytes: number;
  commentCount: number;
  encodedBodyBytes: number;
}

export interface EditabilityAssessmentV1 {
  schema: "atlcli.docx-editability-assessment/1";
  target: "cloud-adf" | "data-center-storage";
  policyDigest: string;
  classification: "safe" | "warn" | "block";
  reasons: Array<{
    code: string;
    metric: keyof TargetEditabilityMetricsV1;
    actual: number;
    threshold?: number;
    evidence: "hard-target-contract" | "project-benchmark" | "heuristic";
  }>;
  recommendation: "continue" | "review" | "split-by-heading" | "reduce-assets";
}
```

Rules:

1. Metrics are pure, isomorphic, integer-valued, and computed from the exact prepared target projection/body.
2. A hard target/API/package budget is `block` and cannot be bypassed by `--large-page allow`.
3. An editability heuristic is `warn` by default, clearly labeled project guidance. `--strict` blocks it; explicit `allow` accepts and reports it.
4. Thresholds are versioned per target capability snapshot, not hidden constants in CLI rendering.
5. No weighted opaque score is required. Named threshold reasons are preferable and reviewable.
6. Plan 009 may consume `split-by-heading` plus metrics, but this plan never creates multiple pages.
7. Preview/report show which structure drives risk and the expected remediation; they never report merely “document too large”.

Proposed files:

```text
packages/import-docx/src/editability/metrics.ts
packages/import-docx/src/editability/policy.ts
packages/import-docx/src/editability/assessment.ts
packages/import-docx/src/import-plan.ts
packages/import-docx/src/preview-model.ts
packages/confluence/src/capabilities.ts
packages/confluence/src/import-publisher.ts
apps/cli/src/commands/import.ts
apps/cli/src/commands/import-report.ts
packages/import-docx/testdata/large/
```

---

## 4. CLI and UX

```text
--large-page <mode>  warn|fail|allow (default warn)
```

- `warn`: soft risks require normal review/acceptance; hard limits block.
- `fail`: any soft or hard risk blocks before mutation.
- `allow`: accepts soft risks, records them in approval/report, and never overrides hard limits.

Once Plan 009 exists, preview may recommend `--split-heading <level>` using the same metrics; it must not pretend that split support exists beforehand.

---

## 5. Tasks and proof

### Task 0 — Establish an evidence ledger

- [ ] Inventory official Cloud/DC API/body/attachment limits separately from native UI-import limits.
- [ ] Create deterministic synthetic fixtures varying one dimension at a time and combined worst cases.
- [ ] Record source bytes, IR metrics, target body bytes, encode time, publish/readback time, and cleanup.
- [ ] Define initial hard versus soft policy with source/evidence dates; uncertain values remain heuristic warnings.

Acceptance:

- [ ] No native UI limit is labeled a REST API limit without transport evidence.
- [ ] Every threshold has a cited source or benchmark artifact.

### Task 1 — Implement pure metrics and policy

- [ ] Count from canonical IR/target projections without serializing twice.
- [ ] Add overflow-safe counters and maximum depth/cell guards.
- [ ] Version and digest policy inputs through `ConfluenceImportCapabilities`.
- [ ] Add stable reason codes and deterministic ordering.

Acceptance/tests:

- [ ] Unit/property tests cover empty, threshold-1, threshold, threshold+1, extreme integer, deep nesting, and combined cases.
- [ ] Node/Bun/browser outputs match byte-for-byte after canonicalization.
- [ ] Metrics execution stays within the corpus performance budget and performs no network/DOM/filesystem work.

### Task 2 — Bind assessment into planning and approval

- [ ] Add metrics/assessment to `DocxImportPlanV1`, preview, report, and plan digest.
- [ ] Enforce hard blockers before approval and soft policy through normal strict/approval rules.
- [ ] Make saved plans stale when capability policy/metrics change.

Acceptance/tests:

- [ ] `warn`, `fail`, `allow`, `--strict`, `--confirm`, and `--from-plan` combinations have table-driven tests.
- [ ] No mode can silently drop/truncate content to meet a threshold.
- [ ] A hard target-size failure performs zero mutation.

### Task 3 — Calibrate Cloud and DC behavior

- [ ] Publish only approved bounded large fixtures to `mayflower`/`DOCSY`, read back, optionally open/edit through an authenticated browser harness if available, and delete in `finally`.
- [ ] Exercise exact payload/size response variants in the DC contract server; do not claim live editor performance.
- [ ] Record Confluence build/date and distinguish API success from observed editor usability.

Acceptance/tests:

- [ ] Evidence labels are `live-api-proven`, `live-editor-observed`, `contract-tested`, or `heuristic`; they are never conflated.
- [ ] Threshold changes require fixture/benchmark diff and reviewer approval.

### Task 4 — Documentation and integration seam

- [ ] Document metrics, modes, caveats, troubleshooting, and future split handoff.
- [ ] Export a stable internal `EditabilityAssessmentV1` consumer seam for Plans 009/010.
- [ ] Add minimal and realistic CLI examples.

---

## 6. E2E scenarios

- [ ] Small feature-zoo: `safe`, unchanged import semantics.
- [ ] Large text: named soft warning, explicit approval.
- [ ] Huge table: table-specific warning rather than generic size message.
- [ ] Hard encoded body/attachment budget: block with zero writes.
- [ ] Capability/threshold change after saved plan: stale before write.
- [ ] Cloud page IDs and cleanup recorded; DC contract paths/context/error bodies asserted.

---

## 7. Verification gates

```bash
bun install --frozen-lockfile
bun test packages/import-docx packages/confluence apps/cli
bun run typecheck
bun run build
bun run check:browser
bun run docs:check
bun run docs:build
git diff --check
```

---

## 8. Definition of Done

- [ ] Pure metrics and named evidence-backed assessments are deterministic across runtimes.
- [ ] Hard limits and soft editability guidance are visibly distinct.
- [ ] Preview gives actionable reasons and later split handoff.
- [ ] Approval/saved-plan semantics cover policy drift.
- [ ] Cloud evidence and DC contract evidence use accurate support labels.
- [ ] Plans 009/010 can consume the stable assessment without duplicating counters.
- [ ] `specs/003-import-docx/EVIDENCE.md` is complete.

## 9. STOP conditions

STOP if safe calibration would require destructive tenant load, if target behavior cannot be separated from browser/device effects, if an official limit conflicts with live/API evidence, or if the implementation starts silently truncating content. Preserve uncertainty as an explicit heuristic.

## 10. DAG

Plans 002–008 run in parallel after the MVP. Plan 009 depends on 002 and 003. Plan 010 depends on 003, 005, and 009.

