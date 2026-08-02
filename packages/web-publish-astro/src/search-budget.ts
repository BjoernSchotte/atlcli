import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type PublicationSearchCorpusClassV1 = "small" | "representative" | "large";

/**
 * The V1 budgets are deliberately concrete and apply to the generated static
 * Pagefind artifacts, not to an operator's arbitrary Astro project code.
 * `initialJsBytes` is the runtime loaded by the search island before any
 * result data is requested (`pagefind.js`).
 */
export interface PublicationSearchBudgetV1 {
  readonly maxIndexBytes: number;
  readonly maxInitialJsBytes: number;
  readonly maxQueryLatencyP95Ms: number;
  readonly maxHeapDeltaBytes: number;
}

export interface PublicationSearchBudgetMeasurementV1 {
  readonly corpus: PublicationSearchCorpusClassV1;
  readonly pageCount: number;
  readonly indexBytes: number;
  readonly initialJsBytes: number;
  readonly queryLatencyP95Ms: number;
  readonly heapDeltaBytes: number;
  readonly indexFiles: readonly { path: string; byteLength: number }[];
}

export const PUBLICATION_SEARCH_BUDGETS_V1: Readonly<Record<PublicationSearchCorpusClassV1, PublicationSearchBudgetV1>> = Object.freeze({
  small: Object.freeze({
    maxIndexBytes: 1_048_576,
    maxInitialJsBytes: 262_144,
    maxQueryLatencyP95Ms: 500,
    maxHeapDeltaBytes: 128 * 1024 * 1024,
  }),
  representative: Object.freeze({
    maxIndexBytes: 4_194_304,
    maxInitialJsBytes: 262_144,
    maxQueryLatencyP95Ms: 500,
    maxHeapDeltaBytes: 128 * 1024 * 1024,
  }),
  large: Object.freeze({
    maxIndexBytes: 16_777_216,
    maxInitialJsBytes: 262_144,
    maxQueryLatencyP95Ms: 500,
    maxHeapDeltaBytes: 128 * 1024 * 1024,
  }),
});

export function publicationSearchCorpusClassV1(pageCount: number): PublicationSearchCorpusClassV1 {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new TypeError("Pagefind budget measurement requires at least one page");
  }
  if (pageCount <= 10) return "small";
  if (pageCount <= 50) return "representative";
  return "large";
}

interface PagefindResultV1 {
  data(): Promise<unknown>;
}

interface PagefindInstanceV1 {
  init(): Promise<void>;
  search(query: string): Promise<{ results: PagefindResultV1[] }>;
}

interface PagefindModuleV1 {
  createInstance(options: { basePath: string; noWorker: boolean }): PagefindInstanceV1;
}

async function listIndexFiles(directory: string): Promise<{ path: string; byteLength: number }[]> {
  const files: { path: string; byteLength: number }[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push({
          path: relative(directory, absolute).split("\\").join("/"),
          byteLength: (await stat(absolute)).size,
        });
      } else {
        throw new Error(`Pagefind budget refuses non-regular output: ${absolute}`);
      }
    }
  }
  await visit(directory);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function outputFileForUrl(outputDirectory: string, url: URL): string {
  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const output = resolve(outputDirectory, relativePath);
  const root = resolve(outputDirectory);
  const escaped = relative(root, output);
  if (escaped === ".." || escaped.startsWith(`..${requirePathSeparator()}`) || escaped.startsWith("/")) {
    throw new Error(`Pagefind budget request escaped output: ${url.href}`);
  }
  return output;
}

function requirePathSeparator(): string {
  // A small helper keeps the traversal check platform-independent without
  // exposing path internals in the public measurement result.
  return process.platform === "win32" ? "\\" : "/";
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Pagefind budget measurement has no query samples");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

/**
 * Measure the already-written Pagefind output through the same main-thread
 * fallback used by the publication UI. The fetch shim is intentionally
 * output-root bound so this remains a local, network-independent gate.
 */
export async function measurePagefindSearchBudgetV1(options: {
  outputDirectory: string;
  pageCount: number;
  query?: string;
}): Promise<PublicationSearchBudgetMeasurementV1> {
  const outputDirectory = resolve(options.outputDirectory);
  const pagefindDirectory = join(outputDirectory, "pagefind");
  const indexFiles = await listIndexFiles(pagefindDirectory);
  const initialJsBytes = indexFiles.find((file) => file.path === "pagefind.js")?.byteLength;
  if (initialJsBytes === undefined) throw new Error("Pagefind budget output is missing pagefind.js");

  const staticOrigin = "https://atlcli-pagefind-budget.invalid";
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      if (url.origin !== staticOrigin) throw new Error(`Pagefind budget made an external request: ${url.href}`);
      try {
        return new Response(await readFile(outputFileForUrl(outputDirectory, url)), { status: 200 });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  });

  try {
    const module = await import(`${pathToFileURL(join(pagefindDirectory, "pagefind.js")).href}?budget=${Date.now()}-${Math.random()}`) as unknown as PagefindModuleV1;
    const instance = module.createInstance({ basePath: `${staticOrigin}/pagefind/`, noWorker: true });
    const before = process.memoryUsage().heapUsed;
    await instance.init();
    const query = options.query ?? "publication";
    const warm = await instance.search(query);
    if (warm.results[0] !== undefined) await warm.results[0].data();
    const afterWarmup = process.memoryUsage().heapUsed;
    const latencies: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      const started = performance.now();
      const result = await instance.search(query);
      if (result.results[0] !== undefined) await result.results[0].data();
      latencies.push(performance.now() - started);
    }
    return {
      corpus: publicationSearchCorpusClassV1(options.pageCount),
      pageCount: options.pageCount,
      indexBytes: indexFiles.reduce((total, file) => total + file.byteLength, 0),
      initialJsBytes,
      queryLatencyP95Ms: percentile95(latencies),
      heapDeltaBytes: Math.max(0, afterWarmup - before),
      indexFiles,
    };
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  }
}

export function assertPagefindSearchBudgetV1(
  measurement: PublicationSearchBudgetMeasurementV1,
  budget: PublicationSearchBudgetV1 = PUBLICATION_SEARCH_BUDGETS_V1[measurement.corpus],
): void {
  const failures = [
    measurement.indexBytes > budget.maxIndexBytes && `index ${measurement.indexBytes} > ${budget.maxIndexBytes} bytes`,
    measurement.initialJsBytes > budget.maxInitialJsBytes && `initial JS ${measurement.initialJsBytes} > ${budget.maxInitialJsBytes} bytes`,
    measurement.queryLatencyP95Ms > budget.maxQueryLatencyP95Ms && `query P95 ${measurement.queryLatencyP95Ms.toFixed(2)} > ${budget.maxQueryLatencyP95Ms} ms`,
    measurement.heapDeltaBytes > budget.maxHeapDeltaBytes && `heap delta ${measurement.heapDeltaBytes} > ${budget.maxHeapDeltaBytes} bytes`,
  ].filter((failure): failure is string => typeof failure === "string");
  if (failures.length > 0) {
    throw new Error(`Pagefind ${measurement.corpus} corpus exceeded search budget: ${failures.join(", ")}`);
  }
}
