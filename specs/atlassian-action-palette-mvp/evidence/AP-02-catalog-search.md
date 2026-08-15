# AP-02 deterministic catalog and search evidence

**Captured:** 2026-08-11

**Task base:** `147e78e16abb7a4b3b857cbe79cd79faef0bd243`

**Package:** `@atlcli/action-registry` `0.1.0`

## Outcome

AP-02 adds an immutable, browser-safe catalog/search/selection core without host APIs, persistence, network access, React, or executable plugin code.

The package now provides:

- `createActionCatalog()`, which revalidates modules and context, excludes every colliding module/action fail closed, emits stable duplicate diagnostics, evaluates action requirements, and resolves deterministic group/order/declaration indexes;
- locale-aware Unicode normalization with case folding, compatibility decomposition, diacritic removal, punctuation/whitespace normalization, and an invalid-locale fallback;
- deterministic exact, prefix, token-prefix, keyword, host-alias, group, subtitle, and subsequence scoring with stable catalog-index/ID tie breaks;
- contextual empty-query suggestions that retain actions disabled only by a missing host capability while omitting actions irrelevant to the current product/entity;
- explicit-query discovery of every matching unavailable action so its reason remains inspectable;
- pure, non-wrapping first/last/next/previous transitions across every visible row, ID-preserving/clamped selection repair, and an execution gate that returns no unavailable entry;
- a deterministic 1,000-action fixture/property lane and a reporting-only latency benchmark whose correctness does not depend on a wall-clock threshold.

## Determinism and failure policy

Known group IDs use the fixed `Suggested`, `Export`, `AI`, `Navigation` rank. Unknown groups use code-point lexical ordering, then numeric action order, global declaration index, and action ID. Search ties use catalog index and action ID. No runtime locale collation participates in these ordering decisions.

Duplicate module IDs exclude all instances of that module ID. Cross-module duplicate action IDs exclude all instances of that action ID. Diagnostics retain the module/source indexes needed to repair the compile-time contribution set. Invalid modules and contexts continue to fail at the AP-01 parsing boundary.

Unavailable rows are data, not execution candidates. Selection functions can point to them for keyboard inspection, but `getExecutableSelectedActionV1()` returns `null` unless the selected row is currently available. AP-04 must still repeat authoritative availability/effect checks immediately before host delegation.

## Proof

### Catalog, search, selection, and benchmark suite

```bash
bun run test packages/action-registry/src
```

Result: **47 passing, 0 failing; 357 assertions** across contract, catalog/search/selection, and benchmark files.

Fixtures cover:

- default and custom group order, numeric order, declaration ties, duplicate labels, and stable indexes;
- duplicate module/action diagnostics and fail-closed exclusion;
- capability, product, entity, and entity-kind availability;
- Unicode, Turkish casing, diacritics, punctuation, invalid locales, and bounded queries;
- title exact/prefix/token-prefix, keyword exact/prefix/token-prefix, aliases, and subsequences;
- relevant default disabled rows versus all explicit disabled matches;
- a catalog with no executable actions;
- all visible-row transitions, unavailable selection, execution gating, stale selection repair, empty results, invalid anchors, and explicit ID selection;
- 100 seeded repeatability passes over a 1,000-action catalog.

The final reporting-only benchmark emitted:

```text
ACTION_SEARCH_BENCHMARK actions=1000 queries=5 samples=20 median_ms=7.551 p95_ms=7.793 max_ms=7.825
```

This run is below the proposed pure-search budget (`p95 <= 16 ms`, `max <= 50 ms`). The test asserts catalog size, deterministic result correctness, and finite samples, but deliberately does not fail solely on noisy machine timing. AP-05 will measure the release distribution over the plan's required 30 runs after five warmups.

### Workspace typecheck

```bash
bun run typecheck
```

Result: passed for the root TypeScript graph, WXT extension, browser PDF compiler, and browser export harness. Turbo printed non-fatal sandbox cache warnings (`IO error: Operation not permitted`); every typecheck task itself completed successfully.

### Browser graph and built distribution

```bash
bun run check:browser
bun run --cwd packages/action-registry build
node --input-type=module -e "/* import and AP-02 export assertions */"
```

Results:

- all **34 browser-isomorphic entrypoints** passed, including `packages/action-registry/src/index.ts`;
- the package emitted its ESM JavaScript and declarations;
- a default-condition import from built `dist/` exposed `createActionCatalog`, `searchActionCatalog`, and `moveActionSelectionV1` (`ACTION_REGISTRY_AP02_DIST_OK`).

## Live/E2E boundary

AP-02 is a pure package task and has no rendered UI, host integration, Atlassian request, or live resource to capture. A screenshot would not demonstrate its behavior, so the authoritative proof is the executable fixtures, browser graph, built-package import, and measured benchmark above. Per the implementation workflow, every later live test will also produce privacy-safe, non-committed screenshots presented directly in the task conversation.
