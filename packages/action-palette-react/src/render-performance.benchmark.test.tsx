import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import React from "react";
import {
  ACTION_GROUP_IDS,
  createActionCatalog,
  type ActionDefinitionV1,
  type ActionModuleV1,
  type ActionSurfaceContextV1,
} from "@atlcli/action-registry";
import { ActionPaletteV1 } from "./ActionPalette.js";
import { createPaletteReactHarness } from "./testing/react-harness.js";

const dom = createPaletteReactHarness();
beforeEach(() => dom.setup());
afterEach(() => dom.teardown());
afterAll(() => expect(dom.leakedGlobals()).toEqual([]));

function percentile95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

test("renders a local query over 500 actions inside the MVP p95 budget", async () => {
  const moduleId = "benchmark.palette-render";
  const actions: ActionDefinitionV1[] = Array.from({ length: 500 }, (_, index) => ({
    schemaVersion: 1,
    id: `benchmark.palette.item-${index.toString().padStart(3, "0")}`,
    moduleId,
    title: { key: `benchmark.item-${index}.title`, fallback: `Action ${index.toString().padStart(3, "0")}` },
    subtitle: { key: `benchmark.item-${index}.subtitle`, fallback: `Local benchmark row ${index}` },
    keywords: ["benchmark", `item-${index}`],
    group: ACTION_GROUP_IDS.suggested,
    icon: "extension",
    intent: { kind: "contribution.render-benchmark", payload: { index } },
    effect: "read",
    order: index,
  }));
  const module: ActionModuleV1 = { schemaVersion: 1, id: moduleId, actions };
  const context: ActionSurfaceContextV1 = {
    siteOrigin: "https://benchmark.atlassian.net",
    product: "atlassian",
    locale: "en",
    capabilities: [],
  };
  const catalog = createActionCatalog([module], context, {
    validationPolicy: { allowedContributionIntentKinds: ["contribution.render-benchmark"] },
  });
  await dom.render(
    <ActionPaletteV1
      open
      catalog={catalog}
      executor={{ execute: async () => ({ status: "completed", messageKey: "done" }) }}
    />,
  );
  const samples: number[] = [];
  for (let iteration = 0; iteration < 35; iteration += 1) {
    await dom.setValue("palette-search", "");
    const startedAt = performance.now();
    await dom.setValue("palette-search", `Action ${(iteration * 13 % 500).toString().padStart(3, "0")}`);
    const duration = performance.now() - startedAt;
    expect(dom.find("palette-search").getAttribute("aria-activedescendant")).toBeTruthy();
    if (iteration >= 5) samples.push(duration);
  }
  const p95Ms = percentile95(samples);
  const evidence = {
    samples,
    summary: { actions: 500, sampleCount: samples.length, p95Ms, maxMs: Math.max(...samples) },
  };
  console.info(`PALETTE_RENDER_PERFORMANCE ${JSON.stringify(evidence)}`);
  expect(samples).toHaveLength(30);
  expect(p95Ms).toBeLessThanOrEqual(50);
}, 30_000);
