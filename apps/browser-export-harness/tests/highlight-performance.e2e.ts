import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser } from "@playwright/test";
import type { HighlightBenchmarkResult } from "../src/highlight-benchmark.js";

const RESULT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../test-results/highlight-performance",
);
const HARNESS_URL = "http://127.0.0.1:4179/browser-export-harness/";
const INITIALIZATION_CHUNK_RE =
  /^(?:core|engine-javascript|github-light)-[^/]+[.]js$/;

interface HighlightResourceTiming {
  name: string;
  startTime: number;
  responseEnd: number;
}

async function runInFreshContext(
  browser: Browser,
  preload: boolean,
): Promise<{
  benchmark: HighlightBenchmarkResult;
  beforeIntentResources: string[];
  resources: HighlightResourceTiming[];
}> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(HARNESS_URL);
    await page.waitForFunction(
      () => typeof window.__ATLCLI_DOCX_HIGHLIGHT_BENCHMARK === "function",
    );
    return await page.evaluate(async (shouldPreload) => {
      const beforeIntentResources = performance
        .getEntriesByType("resource")
        .map(({ name }) => new URL(name).pathname.split("/").at(-1) ?? name);
      performance.clearResourceTimings();
      const run = window.__ATLCLI_DOCX_HIGHLIGHT_BENCHMARK;
      if (!run) throw new Error("highlight benchmark hook is unavailable");
      const benchmark = await run(shouldPreload);
      const resources = performance
        .getEntriesByType("resource")
        .map((entry) => entry as PerformanceResourceTiming)
        .filter(({ name }) => name.endsWith(".js"))
        .map(({ name, startTime, responseEnd }) => ({
          name: new URL(name).pathname.split("/").at(-1) ?? name,
          startTime,
          responseEnd,
        }));
      return { benchmark, beforeIntentResources, resources };
    }, preload);
  } finally {
    await context.close();
  }
}

test("DOCX highlighting is JavaScript-only and deterministic across fresh cold/preloaded contexts", async ({
  browser,
}) => {
  const {
    benchmark: cold,
    beforeIntentResources,
    resources: coldResources,
  } = await runInFreshContext(browser, false);
  const { benchmark: preloaded } = await runInFreshContext(browser, true);

  const initializationResources = coldResources.filter(({ name }) =>
    INITIALIZATION_CHUNK_RE.test(name),
  );
  const grammarResources = coldResources.filter(
    ({ name }) => !INITIALIZATION_CHUNK_RE.test(name),
  );
  expect(initializationResources.length).toBeGreaterThan(0);
  expect(grammarResources.length).toBeGreaterThanOrEqual(22);
  const beforeIntentNames = new Set(beforeIntentResources);
  expect(
    [...initializationResources, ...grammarResources].some(({ name }) =>
      beforeIntentNames.has(name),
    ),
  ).toBe(false);
  const latestInitializationResponseEnd = Math.max(
    ...initializationResources.map(({ responseEnd }) => responseEnd),
  );
  const earliestGrammarRequestStart = Math.min(
    ...grammarResources.map(({ startTime }) => startTime),
  );
  expect(earliestGrammarRequestStart).toBeLessThan(
    latestInitializationResponseEnd,
  );

  expect(cold.engine).toBe("javascript");
  expect(preloaded.engine).toBe("javascript");
  expect(cold.timings.highlightEngineInitMs).toBeGreaterThan(0);
  expect(cold.timings.highlightGrammarLoadMs).toBeGreaterThan(0);
  expect(cold.timings.highlightTokenizeMs).toBeGreaterThan(0);
  expect(preloaded.preloadMs).toBeGreaterThan(0);
  expect(preloaded.timings.highlightEngineInitMs).toBe(0);
  expect(preloaded.timings.highlightGrammarLoadMs).toBe(0);
  expect(preloaded.timings.highlightTokenizeMs).toBeGreaterThan(0);
  expect(cold.timings.highlightCodeBlocks).toBe(22);
  expect(cold.timings.highlightLanguageCount).toBe(22);
  expect(preloaded.timings.highlightCodeBlocks).toBe(22);
  expect(preloaded.timings.highlightLanguageCount).toBe(22);
  expect(preloaded.digest).toBe(cold.digest);
  expect(preloaded.byteLength).toBe(cold.byteLength);

  mkdirSync(RESULT_DIR, { recursive: true });
  writeFileSync(
    resolve(RESULT_DIR, "cold.docx"),
    Buffer.from(cold.base64, "base64"),
  );
  writeFileSync(
    resolve(RESULT_DIR, "preloaded.docx"),
    Buffer.from(preloaded.base64, "base64"),
  );
  writeFileSync(
    resolve(RESULT_DIR, "timings.json"),
    `${JSON.stringify({
      cold: { ...cold, base64: undefined },
      preloaded: { ...preloaded, base64: undefined },
      resourceTrace: {
        initializationRequests: initializationResources.map(({ name }) => name),
        grammarRequestCount: grammarResources.length,
        earliestGrammarRequestStart,
        latestInitializationResponseEnd,
        overlapMs:
          latestInitializationResponseEnd - earliestGrammarRequestStart,
      },
    }, null, 2)}\n`,
  );
});
