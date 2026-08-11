import { expect, test } from "bun:test";
import {
  ACTION_GROUP_IDS,
  createActionCatalog,
  searchActionCatalog,
  type ActionDefinitionV1,
  type ActionModuleV1,
} from "./index.js";

test("reports deterministic local query latency for 1,000 actions", () => {
  const moduleId = "benchmark.action-search";
  const actions: ActionDefinitionV1[] = Array.from({ length: 1_000 }, (_, index) => ({
    schemaVersion: 1,
    id: `benchmark.action.item-${index.toString().padStart(4, "0")}`,
    moduleId,
    title: {
      key: `benchmark.action.item-${index}.title`,
      fallback: `Export page ${index} as a searchable document`,
    },
    subtitle: {
      key: `benchmark.action.item-${index}.subtitle`,
      fallback: `Workspace bucket ${index % 17}`,
    },
    keywords: [`document-${index % 23}`, `bucket-${index % 17}`, "export"],
    group: ACTION_GROUP_IDS.export,
    icon: "document-pdf",
    intent: { kind: "export.current-page", format: "pdf" },
    effect: "download",
    order: index % 101,
  }));
  const actionModule: ActionModuleV1 = { schemaVersion: 1, id: moduleId, actions };
  const catalog = createActionCatalog([actionModule], {
    siteOrigin: "https://example.atlassian.net",
    product: "confluence",
    entity: {
      kind: "atlcli.entity.confluence-page",
      id: "benchmark-page",
      url: "https://example.atlassian.net/wiki/spaces/EX/pages/1",
    },
    locale: "en-US",
    capabilities: [],
  });
  const queries = ["export", "page 427", "document 11", "exprt pge", "missing"];

  for (let index = 0; index < 5; index += 1) {
    for (const query of queries) searchActionCatalog(catalog, query, { limit: 20 });
  }

  const samples: number[] = [];
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const startedAt = performance.now();
    for (const query of queries) searchActionCatalog(catalog, query, { limit: 20 });
    samples.push((performance.now() - startedAt) / queries.length);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)]!;
  const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  const maxMs = sorted.at(-1)!;
  const exact = searchActionCatalog(catalog, "page 427", { limit: 20 });

  expect(catalog.actions).toHaveLength(1_000);
  expect(exact.some((result) => result.entry.action.id === "benchmark.action.item-0427")).toBe(true);
  expect(samples.every(Number.isFinite)).toBe(true);
  console.info(
    `ACTION_SEARCH_BENCHMARK actions=1000 queries=${queries.length} samples=${samples.length} median_ms=${medianMs.toFixed(3)} p95_ms=${p95Ms.toFixed(3)} max_ms=${maxMs.toFixed(3)}`,
  );
});
