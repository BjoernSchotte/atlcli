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
const CODE_FONT_RE = /^JetBrainsMono-Regular-[^/]+[.]ttf$/;

interface HighlightResourceTiming {
  url: string;
  name: string;
  startTime: number;
  responseEnd: number;
  transferSize: number;
  decodedBodySize: number;
}

async function runInFreshContext(
  browser: Browser,
  preload: boolean,
): Promise<{
  benchmark: HighlightBenchmarkResult;
  beforeIntentResources: string[];
  resources: HighlightResourceTiming[];
  repeat?: HighlightBenchmarkResult;
  repeatResources: HighlightResourceTiming[];
}> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(HARNESS_URL);
    await page.waitForFunction(
      () => typeof window.__ATLCLI_DOCX_HIGHLIGHT_BENCHMARK === "function",
    );
    return await page.evaluate(async (shouldPreload) => {
      const resources = (): HighlightResourceTiming[] => performance
        .getEntriesByType("resource")
        .map((entry) => entry as PerformanceResourceTiming)
        .filter(({ name }) => /[.](?:js|ttf)$/u.test(new URL(name).pathname))
        .map(({ name: url, startTime, responseEnd, transferSize, decodedBodySize }) => ({
          url,
          name: new URL(url).pathname.split("/").at(-1) ?? url,
          startTime,
          responseEnd,
          transferSize,
          decodedBodySize,
        }));
      const beforeIntentResources = performance
        .getEntriesByType("resource")
        .map(({ name }) => new URL(name).pathname.split("/").at(-1) ?? name);
      performance.clearResourceTimings();
      const run = window.__ATLCLI_DOCX_HIGHLIGHT_BENCHMARK;
      if (!run) throw new Error("highlight benchmark hook is unavailable");
      const benchmark = await run(shouldPreload);
      const firstResources = resources();
      let repeat: HighlightBenchmarkResult | undefined;
      let repeatResources: HighlightResourceTiming[] = [];
      if (shouldPreload) {
        performance.clearResourceTimings();
        repeat = await run(true);
        repeatResources = resources();
      }
      return {
        benchmark,
        beforeIntentResources,
        resources: firstResources,
        ...(repeat ? { repeat } : {}),
        repeatResources,
      };
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
  const {
    benchmark: preloaded,
    resources: preloadedResources,
    repeat,
    repeatResources,
  } = await runInFreshContext(browser, true);

  const initializationResources = preloadedResources.filter(({ name }) =>
    INITIALIZATION_CHUNK_RE.test(name),
  );
  const grammarResources = preloadedResources.filter(
    ({ name }) => name.endsWith(".js") && !INITIALIZATION_CHUNK_RE.test(name),
  );
  const coldFonts = coldResources.filter(({ name }) => CODE_FONT_RE.test(name));
  const preloadedFonts = preloadedResources.filter(({ name }) => CODE_FONT_RE.test(name));
  expect(initializationResources.length).toBeGreaterThan(0);
  expect(grammarResources.length).toBeGreaterThanOrEqual(22);
  expect(coldFonts).toHaveLength(1);
  expect(preloadedFonts).toHaveLength(1);
  const beforeIntentNames = new Set(beforeIntentResources);
  expect(
    [...initializationResources, ...grammarResources, ...preloadedFonts].some(({ name }) =>
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
  const preloadedFont = preloadedFonts[0]!;
  const coldFont = coldFonts[0]!;
  expect(new URL(preloadedFont.url).origin).toBe(new URL(HARNESS_URL).origin);
  expect(preloadedFont.decodedBodySize).toBe(273_900);
  expect(preloadedFont.startTime).toBeLessThan(preloaded.phases.preloadEndedAt);
  expect(preloadedFont.responseEnd).toBeLessThanOrEqual(
    preloaded.phases.exportStartedAt,
  );
  expect(coldFont.startTime).toBeGreaterThanOrEqual(cold.phases.exportStartedAt);
  expect(coldFont.responseEnd).toBeLessThanOrEqual(cold.phases.exportEndedAt);
  const latestPreparationJavaScriptEnd = Math.max(
    ...[...initializationResources, ...grammarResources].map(({ responseEnd }) => responseEnd),
  );
  expect(preloadedFont.startTime).toBeLessThan(latestPreparationJavaScriptEnd);
  expect(
    Math.min(...[...initializationResources, ...grammarResources].map(({ startTime }) => startTime)),
  ).toBeLessThan(preloadedFont.responseEnd);

  expect(cold.engine).toBe("javascript");
  expect(preloaded.engine).toBe("javascript");
  expect(cold.timings.highlightEngineInitMs).toBeGreaterThan(0);
  expect(cold.timings.highlightGrammarLoadMs).toBeGreaterThan(0);
  expect(cold.timings.highlightTokenizeMs).toBeGreaterThan(0);
  expect(preloaded.preloadMs).toBeGreaterThan(0);
  expect(preloaded.preparation?.codeFontBytes).toBe(273_900);
  expect(preloaded.preparation?.highlightingMs).toBeGreaterThan(0);
  expect(preloaded.preparation?.codeFontMs).toBeGreaterThan(0);
  expect(preloaded.phases.runtimeReadyAt).toBeLessThan(
    preloaded.phases.preloadStartedAt,
  );
  expect(preloaded.timings.highlightEngineInitMs).toBe(0);
  expect(preloaded.timings.highlightGrammarLoadMs).toBe(0);
  expect(preloaded.timings.highlightTokenizeMs).toBeGreaterThan(0);
  expect(cold.timings.highlightCodeBlocks).toBe(22);
  expect(cold.timings.highlightLanguageCount).toBe(22);
  expect(preloaded.timings.highlightCodeBlocks).toBe(22);
  expect(preloaded.timings.highlightLanguageCount).toBe(22);
  expect(preloaded.digest).toBe(cold.digest);
  expect(preloaded.byteLength).toBe(cold.byteLength);
  expect(repeat?.digest).toBe(preloaded.digest);
  expect(repeat?.byteLength).toBe(preloaded.byteLength);
  expect(repeat?.preparation?.codeFontBytes).toBe(273_900);
  expect(repeatResources.filter(({ name }) => CODE_FONT_RE.test(name))).toEqual([]);

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
      repeat: repeat ? { ...repeat, base64: undefined } : undefined,
      resourceTrace: {
        initializationRequests: initializationResources.map(({ name }) => name),
        grammarRequestCount: grammarResources.length,
        coldFont: coldFont,
        preloadedFont: preloadedFont,
        repeatRequests: repeatResources.map(({ name }) => name),
        earliestGrammarRequestStart,
        latestInitializationResponseEnd,
        overlapMs:
          latestInitializationResponseEnd - earliestGrammarRequestStart,
      },
    }, null, 2)}\n`,
  );
});

test("a failed DOCX code-font request is retryable in the same browser realm", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    let fontRequests = 0;
    await page.route("**/JetBrainsMono-Regular-*.ttf", async (route) => {
      fontRequests += 1;
      if (fontRequests === 1) {
        await route.abort("failed");
      } else {
        await route.continue();
      }
    });
    await page.goto(HARNESS_URL);
    await page.waitForFunction(
      () => typeof window.__ATLCLI_DOCX_HIGHLIGHT_BENCHMARK === "function",
    );
    await expect(page.evaluate(async () => {
      const run = window.__ATLCLI_DOCX_HIGHLIGHT_BENCHMARK;
      if (!run) throw new Error("highlight benchmark hook is unavailable");
      return run(true);
    })).rejects.toThrow();
    const retry = await page.evaluate(async () => {
      const run = window.__ATLCLI_DOCX_HIGHLIGHT_BENCHMARK;
      if (!run) throw new Error("highlight benchmark hook is unavailable");
      return run(true);
    });
    expect(fontRequests).toBe(2);
    expect(retry.preparation?.codeFontBytes).toBe(273_900);
    expect(retry.byteLength).toBeGreaterThan(100_000);
  } finally {
    await context.close();
  }
});
