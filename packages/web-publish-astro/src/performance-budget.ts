export interface PublicationPerformanceBudgetV1 {
  readonly maxCriticalCssBytes: number;
  readonly maxInitialJsBytes: number;
  readonly maxFontBytes: number;
  readonly maxTransformedImageBytes: number;
  readonly maxPageBytes: number;
}

export interface PublicationPerformanceMeasurementV1 {
  readonly pageCount: number;
  readonly criticalCssBytes: number;
  readonly initialJsBytes: number;
  readonly fontBytes: number;
  readonly transformedImageBytes: number;
  readonly largestPageBytes: number;
}

/** Static-output budgets; browser LCP/CLS are measured by the Playwright gate. */
export const PUBLICATION_PERFORMANCE_BUDGET_V1: PublicationPerformanceBudgetV1 = Object.freeze({
  maxCriticalCssBytes: 512 * 1024,
  maxInitialJsBytes: 1024 * 1024,
  maxFontBytes: 1024 * 1024,
  maxTransformedImageBytes: 4 * 1024 * 1024,
  maxPageBytes: 1024 * 1024,
});

export function measureAstroStaticPerformanceV1(
  outputs: readonly { path: string; byteLength: number }[],
  pageCount: number,
): PublicationPerformanceMeasurementV1 {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new TypeError("performance measurement requires at least one page");
  const sum = (predicate: (path: string) => boolean): number => outputs.filter((entry) => predicate(entry.path)).reduce((total, entry) => total + entry.byteLength, 0);
  const pageBytes = outputs.filter((entry) => /(?:^|\/)index\.html$/u.test(entry.path) || entry.path.endsWith(".html")).map((entry) => entry.byteLength);
  return Object.freeze({
    pageCount,
    criticalCssBytes: sum((path) => path.endsWith(".css") && !path.startsWith("pagefind/")),
    initialJsBytes: sum((path) => path.endsWith(".js") && !path.startsWith("pagefind/")),
    fontBytes: sum((path) => /\.(?:woff2?|ttf|otf)$/iu.test(path)),
    transformedImageBytes: sum((path) => /\.(?:avif|webp|png|jpe?g)$/iu.test(path)),
    largestPageBytes: Math.max(...pageBytes, 0),
  });
}

export function assertAstroStaticPerformanceBudgetV1(
  measurement: PublicationPerformanceMeasurementV1,
  budget: PublicationPerformanceBudgetV1 = PUBLICATION_PERFORMANCE_BUDGET_V1,
): void {
  const failures = [
    measurement.criticalCssBytes > budget.maxCriticalCssBytes && `critical CSS ${measurement.criticalCssBytes} > ${budget.maxCriticalCssBytes} bytes`,
    measurement.initialJsBytes > budget.maxInitialJsBytes && `initial JS ${measurement.initialJsBytes} > ${budget.maxInitialJsBytes} bytes`,
    measurement.fontBytes > budget.maxFontBytes && `fonts ${measurement.fontBytes} > ${budget.maxFontBytes} bytes`,
    measurement.transformedImageBytes > budget.maxTransformedImageBytes && `images ${measurement.transformedImageBytes} > ${budget.maxTransformedImageBytes} bytes`,
    measurement.largestPageBytes > budget.maxPageBytes && `largest page ${measurement.largestPageBytes} > ${budget.maxPageBytes} bytes`,
  ].filter((failure): failure is string => typeof failure === "string");
  if (failures.length > 0) throw new Error(`Astro static performance budget exceeded: ${failures.join(", ")}`);
}
