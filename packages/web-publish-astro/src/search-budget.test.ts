import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertPagefindSearchBudgetV1,
  buildPagefindIndexV1,
  PUBLICATION_SEARCH_BUDGETS_V1,
  publicationSearchCorpusClassV1,
} from "./index.js";

test("classifies the deterministic search corpus sizes", () => {
  expect(publicationSearchCorpusClassV1(3)).toBe("small");
  expect(publicationSearchCorpusClassV1(24)).toBe("representative");
  expect(publicationSearchCorpusClassV1(100)).toBe("large");
  expect(() => publicationSearchCorpusClassV1(0)).toThrow("at least one page");
});

test("enforces index, initial-JS, query, and heap budgets on three corpora", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlcli-pagefind-budget-"));
  try {
    for (const pageCount of [3, 24, 100]) {
      const outputDirectory = join(root, String(pageCount));
      await mkdir(outputDirectory, { recursive: true });
      const pageOutputPaths = Array.from({ length: pageCount }, (_, index) => {
        const path = `publish/page-${index + 1}/index.html`;
        return path;
      });
      for (const [index, path] of pageOutputPaths.entries()) {
        const language = index % 2 === 0 ? "en" : "de";
        await mkdir(join(outputDirectory, path, ".."), { recursive: true });
        await writeFile(join(outputDirectory, path), [
          `<html lang="${language}"><body>`,
          `<main data-pagefind-body data-pagefind-filter="language:${language}" data-pagefind-filter="label:guide">`,
          `<h1>Publication ${index + 1}</h1>`,
          `Deterministic publication content with searchable term ${index % 5}.`,
          `</main></body></html>`,
        ].join(""));
      }
      const measurement = await buildPagefindIndexV1({ outputDirectory, pageOutputPaths });
      expect(measurement.pageCount).toBe(pageCount);
      expect(measurement.corpus).toBe(publicationSearchCorpusClassV1(pageCount));
      expect(measurement.indexBytes).toBeGreaterThan(0);
      expect(measurement.initialJsBytes).toBeGreaterThan(0);
      expect(measurement.indexFiles).toContainEqual(expect.objectContaining({ path: "pagefind.js" }));
      expect(measurement.queryLatencyP95Ms).toBeGreaterThanOrEqual(0);
      expect(measurement.heapDeltaBytes).toBeGreaterThanOrEqual(0);
      assertPagefindSearchBudgetV1(measurement, PUBLICATION_SEARCH_BUDGETS_V1[measurement.corpus]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("fails the build when an explicitly stricter search budget is exceeded", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlcli-pagefind-budget-fail-"));
  try {
    const path = "publish/guide/index.html";
    await mkdir(join(root, "publish/guide"), { recursive: true });
    await writeFile(join(root, path), `<html><body><main data-pagefind-body>publication content</main></body></html>`);
    await expect(buildPagefindIndexV1({
      outputDirectory: root,
      pageOutputPaths: [path],
      budget: { ...PUBLICATION_SEARCH_BUDGETS_V1.small, maxIndexBytes: 1 },
    })).rejects.toThrow("exceeded search budget");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
