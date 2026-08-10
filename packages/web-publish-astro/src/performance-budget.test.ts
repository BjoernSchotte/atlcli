import { expect, test } from "bun:test";
import { assertAstroStaticPerformanceBudgetV1, measureAstroStaticPerformanceV1 } from "./performance-budget.js";

test("measures and gates static CSS, JS, font, image, and page budgets", () => {
  const measurement = measureAstroStaticPerformanceV1([
    { path: "publish/guide/index.html", byteLength: 10 },
    { path: "_astro/site.css", byteLength: 20 },
    { path: "_astro/site.js", byteLength: 30 },
    { path: "fonts/inter.woff2", byteLength: 40 },
    { path: "assets/hero.webp", byteLength: 50 },
    { path: "pagefind/pagefind.js", byteLength: 999 },
  ], 1);
  expect(measurement).toEqual({ pageCount: 1, criticalCssBytes: 20, initialJsBytes: 30, fontBytes: 40, transformedImageBytes: 50, largestPageBytes: 10 });
  expect(() => assertAstroStaticPerformanceBudgetV1(measurement, { maxCriticalCssBytes: 1, maxInitialJsBytes: 1, maxFontBytes: 1, maxTransformedImageBytes: 1, maxPageBytes: 1 })).toThrow("performance budget exceeded");
});
