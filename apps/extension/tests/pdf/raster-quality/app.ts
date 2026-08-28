import {
  decodeImageInfo,
  decodeJpegRaster,
  decodePngRaster,
  normalizeRasterAssetV1,
  sha256Hex,
  type RasterNormalizeRequestV1,
  type RasterNormalizeResultV1,
} from "@atlcli/export-media";
import type { PdfExportJobRequestV1 } from "@atlcli/export-jobs";
import type { PdfRasterNormalizerLeaseV1 } from "@atlcli/export-wiring/jobs";
import {
  createImageBitmapRasterNormalizerLeaseFactoryV1,
  createPureTsRasterNormalizerLeaseFactoryV1,
  type ProductiveRasterNormalizerReceiptV1,
} from "../../../utils/pdf/raster-normalizer-worker-host.js";
import {
  buildRasterQualityFixtures,
  type RasterQualityFixture,
} from "./quality-fixtures.js";
import type {
  RasterQualityFixtureResult,
  RasterQualityPixelMetrics,
  RasterQualityReceipt,
  RasterQualityReport,
  RasterQualityRun,
} from "./protocol.js";

const QUALITY_REQUEST = {
  schema: "atlcli.export-job-request/1",
  id: "raster-quality-neutral",
  idempotencyKey: "raster-quality:neutral",
  format: "pdf",
  renderer: "pdf-typst",
  source: {
    kind: "confluence",
    siteOrigin: "https://quality.invalid",
    locator: { kind: "page-id", id: "neutral-raster-quality", version: 1 },
    scope: { kind: "page" },
  },
  authRef: "session:https://quality.invalid",
  displayName: "Neutral raster quality fixture",
  requestedFilename: "neutral-raster-quality.pdf",
  createdAt: 0,
  priority: "interactive",
  output: { policy: "collect" },
  template: {
    kind: "builtin",
    id: "builtin.editorial-indigo",
    manifestVersion: "1.0.0",
  },
  settings: {},
  options: {
    resolveMacros: false,
    exportedAt: 0,
    imageProfile: "standard",
  },
} satisfies PdfExportJobRequestV1;

interface DisplayOutput {
  fixture: RasterQualityFixture;
  pure: Extract<RasterNormalizeResultV1, { kind: "normalized" }>;
  candidate: Extract<RasterNormalizeResultV1, { kind: "normalized" }>;
  metrics: RasterQualityPixelMetrics;
}

let displayOutputs: DisplayOutput[] = [];
let objectUrls: string[] = [];
let lastReport: RasterQualityReport | undefined;

function state(message: string): void {
  const output = document.querySelector<HTMLOutputElement>('[data-testid="quality-state"]');
  if (output) output.textContent = message;
}

function receipt(value: ProductiveRasterNormalizerReceiptV1 | null): RasterQualityReceipt {
  if (!value) throw new Error("Raster normalizer did not emit a release receipt.");
  return {
    backend: value.backend,
    revision: value.revision,
    workerStarted: value.workerStarted,
    requests: value.requests,
    normalized: value.normalized,
    kept: value.kept,
    outcome: value.outcome,
  };
}

function normalizeRequest(fixture: RasterQualityFixture): RasterNormalizeRequestV1 {
  const info = decodeImageInfo(fixture.bytes);
  const nominalWidth = info?.width ?? 80;
  const targetWidth = Math.max(1, Math.floor(nominalWidth / 2));
  return {
    bytes: fixture.bytes,
    mediaType: fixture.mediaType,
    // At 144 PPI, half of the source width is targetWidth / 2 points.
    renderEnvelopeWidthPt: targetWidth / 2,
    ppi: 144,
  };
}

function decodeNormalized(
  result: Extract<RasterNormalizeResultV1, { kind: "normalized" }>,
): { pixels: Uint8Array; width: number; height: number } {
  const decoded = result.mediaType === "image/png"
    ? decodePngRaster(result.bytes)
    : decodeJpegRaster(result.bytes);
  if (!decoded) throw new Error(`Pinned decoder rejected normalized ${result.mediaType}.`);
  return { pixels: decoded.pixels, width: decoded.width, height: decoded.height };
}

function p95(histogram: Uint32Array, count: number): number {
  const target = Math.max(1, Math.ceil(count * 0.95));
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value]!;
    if (seen >= target) return value;
  }
  return histogram.length - 1;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function lumaStddev(pixels: Uint8Array): number {
  const count = pixels.byteLength / 4;
  let total = 0;
  let squares = 0;
  for (let index = 0; index < pixels.byteLength; index += 4) {
    const luma = pixels[index]! * 0.299 + pixels[index + 1]! * 0.587 + pixels[index + 2]! * 0.114;
    total += luma;
    squares += luma * luma;
  }
  const mean = total / count;
  return Math.sqrt(Math.max(0, squares / count - mean * mean));
}

function pixelMetrics(reference: Uint8Array, candidate: Uint8Array, width: number, height: number): RasterQualityPixelMetrics {
  if (reference.byteLength !== candidate.byteLength || reference.byteLength !== width * height * 4) {
    throw new Error("Raster quality comparison geometry is inconsistent.");
  }
  const rgbHistogram = new Uint32Array(256);
  const alphaHistogram = new Uint32Array(256);
  let rgbAbsolute = 0;
  let rgbSquares = 0;
  let rgbMax = 0;
  let alphaAbsolute = 0;
  let alphaMax = 0;
  let referenceAlphaCoverage = 0;
  let candidateAlphaCoverage = 0;
  let transparentRgbMax = 0;
  let cornerAbsolute = 0;
  let cornerChannels = 0;
  const isCorner = (x: number, y: number): boolean =>
    (x < 4 || x >= width - 4) && (y < 4 || y >= height - 4);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Math.abs(reference[index + channel]! - candidate[index + channel]!);
      rgbHistogram[difference] += 1;
      rgbAbsolute += difference;
      rgbSquares += difference * difference;
      rgbMax = Math.max(rgbMax, difference);
      if (isCorner(x, y)) {
        cornerAbsolute += difference;
        cornerChannels += 1;
      }
    }
    const alphaDifference = Math.abs(reference[index + 3]! - candidate[index + 3]!);
    alphaHistogram[alphaDifference] += 1;
    alphaAbsolute += alphaDifference;
    alphaMax = Math.max(alphaMax, alphaDifference);
    if (reference[index + 3]! < 255) referenceAlphaCoverage += 1;
    if (candidate[index + 3]! < 255) candidateAlphaCoverage += 1;
    if (candidate[index + 3] === 0) {
      transparentRgbMax = Math.max(
        transparentRgbMax,
        candidate[index]!,
        candidate[index + 1]!,
        candidate[index + 2]!,
      );
    }
  }
  const pixels = width * height;
  const rgbChannels = pixels * 3;
  return {
    rgbMae: round(rgbAbsolute / rgbChannels),
    rgbRmse: round(Math.sqrt(rgbSquares / rgbChannels)),
    rgbP95: p95(rgbHistogram, rgbChannels),
    rgbMax,
    alphaMae: round(alphaAbsolute / pixels),
    alphaP95: p95(alphaHistogram, pixels),
    alphaMax,
    alphaCoverageDelta: round(Math.abs(referenceAlphaCoverage - candidateAlphaCoverage) / pixels),
    transparentRgbMax,
    cornerRgbMae: round(cornerChannels === 0 ? 0 : cornerAbsolute / cornerChannels),
    referenceLumaStddev: round(lumaStddev(reference)),
    candidateLumaStddev: round(lumaStddev(candidate)),
  };
}

function commonResult(
  fixture: RasterQualityFixture,
  pure: RasterNormalizeResultV1,
  candidate: RasterNormalizeResultV1,
): Omit<RasterQualityFixtureResult, "metrics"> {
  const info = decodeImageInfo(fixture.bytes);
  const pureNormalized = pure.kind === "normalized" ? pure : null;
  const candidateNormalized = candidate.kind === "normalized" ? candidate : null;
  return {
    id: fixture.id,
    role: fixture.role,
    mediaType: fixture.mediaType,
    expectation: fixture.expectation,
    sourceBytes: fixture.bytes.byteLength,
    sourceSha256: sha256Hex(fixture.bytes),
    sourceWidth: info?.width ?? null,
    sourceHeight: info?.height ?? null,
    pureKind: pure.kind,
    candidateKind: candidate.kind,
    pureReason: pure.kind === "kept" ? pure.reason : null,
    candidateReason: candidate.kind === "kept" ? candidate.reason : null,
    pureBytes: pureNormalized?.bytes.byteLength ?? 0,
    candidateBytes: candidateNormalized?.bytes.byteLength ?? 0,
    pureSha256: pureNormalized ? sha256Hex(pureNormalized.bytes) : null,
    candidateSha256: candidateNormalized ? sha256Hex(candidateNormalized.bytes) : null,
    outputWidth: candidateNormalized?.width ?? pureNormalized?.width ?? null,
    outputHeight: candidateNormalized?.height ?? pureNormalized?.height ?? null,
  };
}

function createWorker(name: string): Worker {
  return new Worker(new URL("../../../workers/raster-normalizer.ts", import.meta.url), {
    type: "module",
    name,
  });
}

async function acquire(
  backend: "pure-ts" | "image-bitmap",
  run: number,
  onReceipt: (value: ProductiveRasterNormalizerReceiptV1) => void,
): Promise<{ lease: PdfRasterNormalizerLeaseV1; abort: AbortController }> {
  const abort = new AbortController();
  const options = {
    createWorker: () => createWorker(`atlcli-raster-quality-${backend}-${run}`),
    onReceipt,
  };
  const factory = backend === "pure-ts"
    ? createPureTsRasterNormalizerLeaseFactoryV1(options)
    : createImageBitmapRasterNormalizerLeaseFactoryV1(options);
  const lease = await factory.acquire({
    jobId: `raster-quality-${backend}-${run}`,
    leaseEpoch: run,
    request: QUALITY_REQUEST,
    signal: abort.signal,
  });
  return { lease, abort };
}

async function runUnsupported(fixtures: readonly RasterQualityFixture[]): Promise<{
  results: RasterQualityFixtureResult[];
  releaseReceipt: RasterQualityReceipt;
}> {
  let emitted: ProductiveRasterNormalizerReceiptV1 | null = null;
  const { lease } = await acquire("image-bitmap", 100, (value) => { emitted = value; });
  const results: RasterQualityFixtureResult[] = [];
  try {
    for (const fixture of fixtures) {
      const before = sha256Hex(fixture.bytes);
      if (fixture.pinnedSourceSha256 && before !== fixture.pinnedSourceSha256) {
        throw new Error(`Pinned source digest mismatch for ${fixture.id}.`);
      }
      const pure = normalizeRasterAssetV1(normalizeRequest(fixture));
      const candidate = await lease.rasterNormalizer.normalize(normalizeRequest(fixture));
      const after = sha256Hex(fixture.bytes);
      if (before !== after || fixture.bytes.byteLength === 0) {
        throw new Error(`Unsupported source ownership changed for ${fixture.id}.`);
      }
      if (candidate.kind !== "kept") {
        throw new Error(`Unsupported fixture ${fixture.id} was not kept by ImageBitmap eligibility.`);
      }
      results.push({ ...commonResult(fixture, pure, candidate), metrics: null });
    }
  } finally {
    await lease.release();
  }
  return { results, releaseReceipt: receipt(emitted) };
}

async function runSupported(
  fixtures: readonly RasterQualityFixture[],
  run: 1 | 2,
): Promise<RasterQualityRun> {
  let pureEmitted: ProductiveRasterNormalizerReceiptV1 | null = null;
  let candidateEmitted: ProductiveRasterNormalizerReceiptV1 | null = null;
  const pure = await acquire("pure-ts", run, (value) => { pureEmitted = value; });
  const candidate = await acquire("image-bitmap", run, (value) => { candidateEmitted = value; });
  const results: RasterQualityFixtureResult[] = [];
  const outputs: DisplayOutput[] = [];
  try {
    for (const fixture of fixtures) {
      const before = sha256Hex(fixture.bytes);
      if (fixture.pinnedSourceSha256 && before !== fixture.pinnedSourceSha256) {
        throw new Error(`Pinned source digest mismatch for ${fixture.id}.`);
      }
      const request = normalizeRequest(fixture);
      const pureResult = await pure.lease.rasterNormalizer.normalize(request);
      const candidateResult = await candidate.lease.rasterNormalizer.normalize(request);
      const after = sha256Hex(fixture.bytes);
      if (before !== after || fixture.bytes.byteLength === 0) {
        throw new Error(`Caller source ownership changed for ${fixture.id}.`);
      }
      if (pureResult.kind !== "normalized" || candidateResult.kind !== "normalized") {
        throw new Error(
          `Supported fixture ${fixture.id} returned ${pureResult.kind}/${candidateResult.kind}.`,
        );
      }
      if (
        pureResult.width !== candidateResult.width
        || pureResult.height !== candidateResult.height
        || pureResult.sourceWidth !== candidateResult.sourceWidth
        || pureResult.sourceHeight !== candidateResult.sourceHeight
        || pureResult.mediaType !== candidateResult.mediaType
      ) {
        throw new Error(`Output geometry or media type diverged for ${fixture.id}.`);
      }
      const pureDecoded = decodeNormalized(pureResult);
      const candidateDecoded = decodeNormalized(candidateResult);
      if (
        pureDecoded.width !== candidateDecoded.width
        || pureDecoded.height !== candidateDecoded.height
        || pureDecoded.width !== pureResult.width
        || pureDecoded.height !== pureResult.height
      ) {
        throw new Error(`Decoded display geometry diverged for ${fixture.id}.`);
      }
      const metrics = pixelMetrics(
        pureDecoded.pixels,
        candidateDecoded.pixels,
        pureDecoded.width,
        pureDecoded.height,
      );
      if (metrics.candidateLumaStddev < 1) {
        throw new Error(`Candidate output is blank or near-uniform for ${fixture.id}.`);
      }
      results.push({ ...commonResult(fixture, pureResult, candidateResult), metrics });
      outputs.push({ fixture, pure: pureResult, candidate: candidateResult, metrics });
    }
  } finally {
    await Promise.all([pure.lease.release(), candidate.lease.release()]);
  }
  if (run === 1) displayOutputs = outputs;
  const pureRecipe = results.map((value) => `${value.id}:${value.pureSha256}`).join("\n");
  const candidateRecipe = results.map((value) => `${value.id}:${value.candidateSha256}`).join("\n");
  return {
    run,
    fixtures: results,
    pureAssetBytes: results.reduce((total, value) => total + value.pureBytes, 0),
    candidateAssetBytes: results.reduce((total, value) => total + value.candidateBytes, 0),
    pureAssetSha256: sha256Hex(new TextEncoder().encode(pureRecipe)),
    candidateAssetSha256: sha256Hex(new TextEncoder().encode(candidateRecipe)),
    pureReceipt: receipt(pureEmitted),
    candidateReceipt: receipt(candidateEmitted),
  };
}

async function run(): Promise<RasterQualityReport> {
  state("running");
  const fixtures = buildRasterQualityFixtures();
  const unsupported = await runUnsupported(fixtures.unsupported);
  if (unsupported.releaseReceipt.workerStarted) {
    throw new Error("Unsupported-only quality controls started the ImageBitmap worker.");
  }
  const first = await runSupported(fixtures.supported, 1);
  const second = await runSupported(fixtures.supported, 2);
  if (
    first.pureAssetSha256 !== second.pureAssetSha256
    || first.candidateAssetSha256 !== second.candidateAssetSha256
  ) {
    throw new Error("Two-run raster output digests are not stable.");
  }
  lastReport = {
    schema: "atlcli.raster-quality/1",
    runtime: { userAgent: navigator.userAgent, platform: navigator.platform },
    supportedFixtureCount: fixtures.supported.length,
    keptFixtureCount: fixtures.unsupported.length,
    unsupportedReceipt: unsupported.releaseReceipt,
    unsupported: unsupported.results,
    runs: [first, second],
  };
  state(`complete:${fixtures.supported.length}:${fixtures.unsupported.length}`);
  return structuredClone(lastReport);
}

function createFigure(label: string, bytes: Uint8Array, mediaType: string, width: number, height: number, scale: number): { figure: HTMLElement; loaded: Promise<void> } {
  const figure = document.createElement("figure");
  const caption = document.createElement("figcaption");
  caption.textContent = label;
  const checker = document.createElement("div");
  checker.className = "checker";
  const image = document.createElement("img");
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
  objectUrls.push(url);
  image.src = url;
  image.width = width * scale;
  image.height = height * scale;
  checker.append(image);
  figure.append(caption, checker);
  return { figure, loaded: image.decode() };
}

async function renderContactSheet(scale: 1 | 4): Promise<{ fixtures: number; scale: number }> {
  if (!lastReport || displayOutputs.length === 0) throw new Error("Run the quality ratchet first.");
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  const sheet = document.querySelector<HTMLElement>('[data-testid="quality-sheet"]');
  if (!sheet) throw new Error("Quality sheet host is missing.");
  sheet.replaceChildren();
  sheet.dataset.scale = String(scale);
  const loads: Promise<void>[] = [];
  for (const output of displayOutputs) {
    const article = document.createElement("article");
    article.className = "fixture";
    const heading = document.createElement("h2");
    heading.textContent = `${output.fixture.id} · RGB MAE ${output.metrics.rgbMae} · alpha MAE ${output.metrics.alphaMae}`;
    const comparison = document.createElement("div");
    comparison.className = "comparison";
    for (const entry of [
      { label: "source scaled to target", bytes: output.fixture.bytes, mediaType: output.fixture.mediaType },
      { label: "pure worker", bytes: output.pure.bytes, mediaType: output.pure.mediaType },
      { label: "ImageBitmap worker", bytes: output.candidate.bytes, mediaType: output.candidate.mediaType },
    ]) {
      const item = createFigure(
        entry.label,
        entry.bytes,
        entry.mediaType,
        output.candidate.width,
        output.candidate.height,
        scale,
      );
      comparison.append(item.figure);
      loads.push(item.loaded);
    }
    article.append(heading, comparison);
    sheet.append(article);
  }
  await Promise.all(loads);
  return { fixtures: displayOutputs.length, scale };
}

window.atlcliRasterQuality = { run, renderContactSheet };
