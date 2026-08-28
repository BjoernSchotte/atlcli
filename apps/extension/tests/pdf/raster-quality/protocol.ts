export type RasterQualityExpectation = "normalized" | "kept";

export interface RasterQualityPixelMetrics {
  rgbMae: number;
  rgbRmse: number;
  rgbP95: number;
  rgbMax: number;
  alphaMae: number;
  alphaP95: number;
  alphaMax: number;
  alphaCoverageDelta: number;
  transparentRgbMax: number;
  cornerRgbMae: number;
  referenceLumaStddev: number;
  candidateLumaStddev: number;
}

export interface RasterQualityFixtureResult {
  id: string;
  role: string;
  mediaType: string;
  expectation: RasterQualityExpectation;
  sourceBytes: number;
  sourceSha256: string;
  sourceWidth: number | null;
  sourceHeight: number | null;
  pureKind: "normalized" | "kept";
  candidateKind: "normalized" | "kept";
  pureReason: string | null;
  candidateReason: string | null;
  pureBytes: number;
  candidateBytes: number;
  pureSha256: string | null;
  candidateSha256: string | null;
  outputWidth: number | null;
  outputHeight: number | null;
  metrics: RasterQualityPixelMetrics | null;
}

export interface RasterQualityReceipt {
  backend: "pure-ts" | "image-bitmap";
  revision: string;
  workerStarted: boolean;
  requests: number;
  normalized: number;
  kept: number;
  outcome: string;
}

export interface RasterQualityRun {
  run: 1 | 2;
  fixtures: RasterQualityFixtureResult[];
  pureAssetBytes: number;
  candidateAssetBytes: number;
  pureAssetSha256: string;
  candidateAssetSha256: string;
  pureReceipt: RasterQualityReceipt;
  candidateReceipt: RasterQualityReceipt;
}

export interface RasterQualityReport {
  schema: "atlcli.raster-quality/1";
  runtime: {
    userAgent: string;
    platform: string;
  };
  supportedFixtureCount: number;
  keptFixtureCount: number;
  unsupportedReceipt: RasterQualityReceipt;
  unsupported: RasterQualityFixtureResult[];
  runs: [RasterQualityRun, RasterQualityRun];
}

export interface RasterQualityProbeApi {
  run(): Promise<RasterQualityReport>;
  renderContactSheet(scale: 1 | 4): Promise<{ fixtures: number; scale: number }>;
}

declare global {
  interface Window {
    atlcliRasterQuality: RasterQualityProbeApi;
  }
}
