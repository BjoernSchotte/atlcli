import type { LargeExportCorpusCounts } from "@atlcli/export-fixtures";

export type BrowserBaselineFormat = "docx" | "pdf";
export type BrowserBaselinePages = 50 | 500;

export interface BrowserBaselinePrepareResult {
  pages: BrowserBaselinePages;
  seed: number;
  corpusDigest: string;
  counts: LargeExportCorpusCounts;
  composedBlocks: number;
  logicalInputBytes: number;
  /** Direct PRE-QUEUE engines do not persist a job input. */
  persistedInputBytes: null;
  corpusAndComposeMs: number;
  corpusFingerprintMs: number;
}

export interface BrowserBaselineExportResult {
  format: BrowserBaselineFormat;
  exportMs: number;
  artifactBytes: number;
  artifactSha256: string;
  /** Direct PRE-QUEUE engines do not persist a queue artifact. */
  persistedArtifactBytes: null;
  compilerVersion: string | null;
  noteCodes: string[];
  reportSummary: Record<string, unknown>;
  reportSha256: string;
  hashingMs: number;
}

export interface BrowserExportBaselineApi {
  setup(format: BrowserBaselineFormat): Promise<{ setupMs: number }>;
  prepare(options: { pages: BrowserBaselinePages; seed: number }): Promise<BrowserBaselinePrepareResult>;
  run(format: BrowserBaselineFormat): Promise<BrowserBaselineExportResult>;
  heldArtifactBytes(): number;
  cleanup(): Promise<void>;
}

declare global {
  interface Window {
    atlcliExportBaseline: BrowserExportBaselineApi;
  }
}
