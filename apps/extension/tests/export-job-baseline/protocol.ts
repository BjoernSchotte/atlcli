export type BrowserJobBaselineFormat = "docx" | "pdf";
export type BrowserJobBaselinePages = 50 | 500;
export type BrowserJobBaselineCorpus = "text" | "mixed" | "image-heavy";
export type BrowserJobBaselineDocxMode = "adaptive" | "memory";

export interface BrowserJobBaselinePrepareResult {
  pages: BrowserJobBaselinePages;
  seed: number;
  corpusKind: BrowserJobBaselineCorpus;
  docxMode: BrowserJobBaselineDocxMode;
  imageScale: number | null;
  corpusDigest: string;
  counts: Record<string, number>;
  composedBlocks: number;
  logicalInputBytes: number;
  corpusAndComposeMs: number;
  corpusFingerprintMs: number;
}

export interface BrowserJobSpoolBreakdown {
  totalBytes: number;
  sourceBytes: number;
  assetBytes: number;
  preparedBytes: number;
  otherBytes: number;
  objectCount: number;
  namespaces: Record<string, number>;
}

export interface BrowserJobBaselineExportResult {
  format: BrowserJobBaselineFormat;
  jobExecutionMs: number;
  durableRequestBytes: number;
  artifactBytes: number;
  artifactSha256: string;
  persistedArtifactBytes: number;
  indexedDbPayloadBytes: number;
  spool: BrowserJobSpoolBreakdown;
  originUsageBeforeBytes: number | null;
  originUsageAfterBytes: number | null;
  originQuotaBytes: number | null;
  compilerVersion: string | null;
  reportSummary: Record<string, unknown>;
  reportSha256: string;
  state: "succeeded";
}

export interface BrowserExportJobBaselineApi {
  setup(format: BrowserJobBaselineFormat): Promise<{ setupMs: number }>;
  prepare(options: {
    pages: BrowserJobBaselinePages;
    seed: number;
    corpusKind?: BrowserJobBaselineCorpus;
    docxMode?: BrowserJobBaselineDocxMode;
    imageScale?: number;
  }): Promise<BrowserJobBaselinePrepareResult>;
  run(format: BrowserJobBaselineFormat): Promise<BrowserJobBaselineExportResult>;
  cleanup(): Promise<void>;
}

declare global {
  interface Window {
    atlcliExportJobBaseline: BrowserExportJobBaselineApi;
  }
}
